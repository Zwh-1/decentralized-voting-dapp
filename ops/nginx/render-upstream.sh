#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Renders the nginx upstream from the active slot, then reloads nginx gracefully.
#
#   usage: render-upstream.sh [slot]
#
# With no argument the slot is read from ${STATE_DIR}/active-slot. The state file
# is the single source of truth; this script is the only thing that should write
# the generated upstream, and it is the only path that reloads nginx.
#
# ---------------------------------------------------------------------------
# Why the render is validated before it is installed
# ---------------------------------------------------------------------------
#
# A reload with a broken configuration is not a small mistake. nginx keeps
# running the old configuration and logs an error, so the deploy looks like it
# succeeded while traffic keeps going to the previous slot -- and the next
# person debugs "the deploy said OK but the old version is still serving" from
# scratch. So the rendered file is tested with `nginx -t` inside the container
# before it replaces the live one, and if the test fails the live file is left
# exactly as it was.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../deploy/lib.sh"

# --- where things live ------------------------------------------------------
# Overridable so the self-test can drive this without a container.
NGINX_SERVICE="${NGINX_SERVICE:-nginx}"
UPSTREAM_DIR="${UPSTREAM_DIR:-/srv/voting/nginx/upstream}"
TEMPLATE="${UPSTREAM_TEMPLATE:-$here/templates/upstream.conf.tmpl}"
UPSTREAM_FILE="$UPSTREAM_DIR/upstream.conf"
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}"

slot="${1:-}"
if [ -z "$slot" ]; then
  slot="$(read_state active-slot)"
fi

# Only the two known slots. A typo here would render an upstream pointing at a
# hostname that does not resolve -- which nginx accepts at config-test time and
# which then fails at request time, so the mistake would surface as 502s in
# production rather than as a rejected deploy.
case "$slot" in
  blue | green) ;;
  *)
    usage "$0 [blue|green]   (got: '${slot:-<empty>}', from the active-slot state file by default)"
    ;;
esac

if [ ! -f "$TEMPLATE" ]; then
  die "upstream template not found: $TEMPLATE"
fi

# This runs on the host, not in a container, so `envsubst` has to be present
# there. It comes from gettext-base, which minimal cloud images do not include --
# and without this check the failure would be "envsubst: command not found" in
# the middle of a deploy, with traffic already moved to a slot the upstream file
# does not yet name. ops/server/README.md installs it during host preparation.
if ! command -v envsubst >/dev/null 2>&1; then
  die "envsubst is not installed. On Debian/Ubuntu: apt-get install -y gettext-base"
fi

# --- render -----------------------------------------------------------------
mkdir -p "$UPSTREAM_DIR"
tmp="$UPSTREAM_FILE.$$"

# The template contains exactly one substitution. envsubst without a variable
# list would also replace any `$` that appears in the file's own comments, so the
# variable is named explicitly.
ACTIVE_SLOT="web-$slot" envsubst '${ACTIVE_SLOT}' <"$TEMPLATE" >"$tmp"

# A generated file that failed to substitute would contain the literal
# `${ACTIVE_SLOT}`, and nginx would treat it as a hostname. Checking for it turns
# a substitution bug into a clear failure instead of a 502 much later.
if grep -q '\${ACTIVE_SLOT}' "$tmp"; then
  rm -f "$tmp"
  die "the template still contains an unsubstituted \${ACTIVE_SLOT}"
fi

# --- validate, then install -------------------------------------------------
# The test runs against the *rendered* file at its final path, because that is
# the path nginx's configuration includes. So the file is moved into place first
# and restored on failure -- there is no way to test a file at a path nginx is
# not reading.
#
# The test runs in a throwaway container rather than by `exec` into the running
# one. `exec` cannot work on the first deploy of a host: nginx is not running
# then, and it cannot be running, because `nginx.conf` includes the very file
# this script is about to write -- with an exact path, not a glob, so a missing
# file makes nginx refuse to start. With `exec`, the first `deploy.sh` on a fresh
# host died at the switch step with "nginx -t failed after rendering", and so did
# every retry: a deadlock with no way out that did not involve hand-writing the
# generated file.
#
# A throwaway container gets the same image and the same mounts, so it reads the
# same rendered configuration: the check is exactly as strong, and it works
# whether or not the stack has been started yet.
#
# `nginx -t` resolves the names in the upstream block while parsing it, and on a
# host whose stack has never started there is no container called web-blue for
# Docker's DNS to answer with. The check then failed with
#   [emerg] host not found in upstream "web-blue:3000"
# which says nothing about the file being wrong -- the file is fine, nobody is
# running yet. So the validation container gets the two slot names in its own
# /etc/hosts. Exactly the names, and only inside the throwaway container: what is
# being tested is still the real rendered file read from the real mount path, and
# whether the slot actually answers is what the health gate and the observation
# window are for.
backup=""
if [ -f "$UPSTREAM_FILE" ]; then
  backup="$(mktemp)"
  cp "$UPSTREAM_FILE" "$backup"
fi

mv "$tmp" "$UPSTREAM_FILE"
chmod 0644 "$UPSTREAM_FILE"

log "rendered upstream -> web-$slot"

validation_log=$(mktemp)
if ! docker compose $COMPOSE_FILES run --rm --no-deps -T "$NGINX_SERVICE" \
  sh -c "printf '127.0.0.1 web-blue web-green\n' >>/etc/hosts && nginx -t" \
  >"$validation_log" 2>&1; then
  if [ -n "$backup" ]; then
    cp "$backup" "$UPSTREAM_FILE"
    log "nginx rejected the rendered upstream; restored the previous one"
  else
    rm -f "$UPSTREAM_FILE"
    log "nginx rejected the rendered upstream; removed it (there was no previous one)"
  fi
  [ -n "$backup" ] && rm -f "$backup"
  # The reason, on stderr, before the summary. Discarding it (the first version of
  # this script redirected to /dev/null) turns every failure into the same
  # unactionable sentence, and the two failures seen so far -- a log format used
  # before it was declared, and an unresolvable upstream -- need opposite fixes.
  printf '  nginx said:\n' >&2
  tail -5 "$validation_log" | sed 's/^/    /' >&2
  rm -f "$validation_log"
  die "nginx -t failed after rendering the upstream for web-$slot; traffic was not moved"
fi
rm -f "$validation_log"
[ -n "$backup" ] && rm -f "$backup"

# --- reload -----------------------------------------------------------------
# `reload` and not `restart`. Reload starts new workers and lets old ones finish
# the requests they have already accepted; restart drops every connection in
# flight. This single word is what "zero downtime" rests on.
#
# Reloading is the one step that needs nginx to be *running*, so it is the one
# step that has to ask. On a host's first render there is no nginx process yet:
# the file written above is what lets it start. Failing there would put the
# deadlock back, one step later.
if docker compose $COMPOSE_FILES ps --status running --services 2>/dev/null |
  grep -qx "$NGINX_SERVICE"; then
  if ! docker compose $COMPOSE_FILES exec -T "$NGINX_SERVICE" nginx -s reload; then
    die "nginx reload failed; the previous workers are still serving web-$(read_state active-slot)"
  fi
  log "nginx reloaded, traffic now goes to web-$slot"
else
  log "nginx is not running yet; it will read this upstream when it starts"
fi
