#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Returns traffic to the previously deployed slot.
#
#   usage: rollback.sh [tag]      # defaults to the recorded previous-tag
#
#   env: same as deploy.sh
#
# ---------------------------------------------------------------------------
# Why this is fast, and why that is the point
# ---------------------------------------------------------------------------
#
# The old slot was left running when the current release was deployed. So the
# usual rollback is: rewrite the upstream file to name it, reload nginx, done.
# No image to pull, no container to start, no warm-up. That is a config change,
# and it is the single strongest argument for two slots over updating in place.
#
# There is a slower path below for the case where the old slot is not running --
# after a host reboot, for instance. It still works; it just is not instant.
#
# ---------------------------------------------------------------------------
# Why this does not run migrations
# ---------------------------------------------------------------------------
#
# The schema is deliberately not rolled back, and this is the single most
# important property of the whole deploy design.
#
# A migration that a rollback would have to undo is, by definition, not backward
# compatible — and every migration here has to be. Rolling the schema backwards
# would also destroy whatever the version being abandoned had already written,
# turning a bad release into data loss. So a rollback means: run the old image
# against the current schema.
#
# The distinction matters operationally. If a migration is ever written that is
# not backward compatible, that release is NOT rollbackable and must be fixed
# forward. The script cannot detect that condition for you, which is why it says
# so out loud on every run rather than only when something looks wrong.

set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

nginx_service=${NGINX_SERVICE:-nginx}
compose_files=${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}
health_timeout=${HEALTH_TIMEOUT:-60}
observe_seconds=${OBSERVE_SECONDS:-30}
observe_interval=${OBSERVE_INTERVAL:-2}
public_health_url=${PUBLIC_HEALTH_URL:-https://localhost/api/health}

# shellcheck disable=SC2086 # deliberately split into separate -f arguments
compose() { docker compose $compose_files "$@"; }

target_tag=${1:-}
if [ -z "$target_tag" ]; then
  target_tag=$(read_state previous-tag)
  [ -n "$target_tag" ] || die "no tag given and no previous-tag recorded; there is nothing to roll back to"
fi

active_slot=$(read_state active-slot)
active_tag=$(read_state active-tag)

[ -n "$active_slot" ] || die "no active slot recorded; this host has not been deployed to by deploy.sh"
case "$active_slot" in
  blue) target_slot=green ;;
  green) target_slot=blue ;;
  *) die "active-slot contains '$active_slot', which is not blue or green" ;;
esac

target_service="web-$target_slot"

if [ "$target_tag" = "$active_tag" ]; then
  die "tag $target_tag is already active; a rollback to the running version would change nothing"
fi

log "rolling back from tag=${active_tag:-unknown} (web-$active_slot) to tag=$target_tag (web-$target_slot)"
append_deploy_log "rollback start to=$target_tag slot=$target_slot from=${active_tag:-none}"

# --- is the target slot already up on the right tag? ------------------------
#
# This is the fast path. The check is on the *running container's image*, not
# merely on "is the container running": a running container on the wrong tag
# would be switched to and would serve the wrong release, which is a worse
# outcome than a slow rollback.
running_id=$(compose ps -q "$target_service" 2>/dev/null | head -1 || true)
needs_start=true
if [ -n "$running_id" ]; then
  slot_image=$(docker inspect --format '{{.Config.Image}}' "$running_id" 2>/dev/null || true)
  case "$slot_image" in
    *":$target_tag")
      needs_start=false
      log "web-$target_slot is already running tag=$target_tag; switching without a restart"
      ;;
    *)
      log "web-$target_slot is running ${slot_image:-unknown}, not tag=$target_tag; it must be started"
      ;;
  esac
fi

if [ "$needs_start" = true ]; then
  log "starting web-$target_slot on tag=$target_tag"
  WEB_IMAGE_TAG="$target_tag" compose up -d --no-deps "$target_service" ||
    die "could not start $target_service on tag=$target_tag"

  log "gating $target_service before moving traffic (budget ${health_timeout}s)"
  if ! PROBE_VIA="$target_service" COMPOSE_FILES="$compose_files" \
    "$here/health-gate.sh" "http://localhost:3000/api/health" "$health_timeout"; then
    compose stop "$target_service" || true
    append_deploy_log "rollback abort stage=health to=$target_tag"
    die "web-$target_slot did not become healthy, so it was stopped. web-$active_slot is still serving tag=${active_tag:-unknown}."
  fi
fi

# --- move traffic -----------------------------------------------------------
log "moving traffic to web-$target_slot"
if ! "$here/../nginx/render-upstream.sh" "$target_slot"; then
  append_deploy_log "rollback abort stage=switch to=$target_tag"
  die "the upstream switch failed; web-$active_slot is still serving"
fi

# --- observe, and go back again if the rollback target is also broken ------
if [ "$observe_seconds" -gt 0 ]; then
  log "observing $public_health_url for ${observe_seconds}s (${observe_interval}s interval)"
  if ! "$here/probe-loop.sh" "$public_health_url" "$observe_seconds" "$observe_interval"; then
    log "the rollback target is also failing; returning traffic to web-$active_slot"
    "$here/../nginx/render-upstream.sh" "$active_slot" || true
    append_deploy_log "rollback abort stage=observe to=$target_tag"
    die "the rollback target failed too. Traffic was returned to web-$active_slot (tag=${active_tag:-unknown}) and both releases need attention."
  fi
fi

# --- record -----------------------------------------------------------------
#
# `previous-tag` becomes the release that was active before this rollback, so a
# second rollback undoes the first rather than repeating it.
write_state previous-tag "$active_tag"
write_state active-tag "$target_tag"
write_state active-slot "$target_slot"
"$here/publish-version.sh" "$target_tag" "$target_slot"

append_deploy_log "rollback ok to=$target_tag slot=$target_slot"
append_deploy_log "rollback note: schema NOT rolled back (expand-contract; see ops/runbook/migrations.md)"

log "rolled back to tag=$target_tag on web-$target_slot"
# Printed on every run. The next person to read this log is often debugging "the
# rollback completed but the app behaves like the new version", and the answer is
# that the schema was never reversed.
log "NOTE: the database schema was NOT rolled back, by design. Migrations are backward compatible so the previous release runs against the current schema. See ops/runbook/migrations.md."
