#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Deploys a tag to whichever slot is idle, gates it, then moves traffic to it.
#
#   usage: deploy.sh <tag>
#
#   env: WEB_IMAGE      required, the registry image (e.g. user/voting-web)
#        NGINX_SERVICE   default nginx
#        COMPOSE_FILES   default -f docker-compose.yml -f docker-compose.prod.yml
#        HEALTH_TIMEOUT  default 60, seconds allowed for the target slot
#        OBSERVE_SECONDS default 30, how long to watch after the switch
#        OBSERVE_INTERVAL default 2
#        STATE_DIR       default /srv/voting/state
#
# ---------------------------------------------------------------------------
# The order, and why it cannot be rearranged
# ---------------------------------------------------------------------------
#
#   1. migrate      runs first, while the old version is still serving. If it
#                   fails, nothing has moved and the failure costs nothing.
#   2. start target starts the idle slot on the new tag. Traffic still points at
#                   the old slot, so this step cannot break anything either.
#   3. health gate  probes the *target slot directly*, not through nginx. A gate
#                   that went through nginx would be testing the old slot and
#                   would pass no matter how broken the new one is.
#   4. switch       rewrites the upstream and reloads nginx. This is the only
#                   step that can affect a user, and it is the only one that
#                   happens once everything else has already succeeded.
#   5. observe      watches the new version under real traffic. If anything
#                   fails, it switches back -- and the old slot is still running
#                   and still warm, which is why that switch is instant.
#
# The old slot is deliberately left running afterwards. It is the rollback
# target; taking it down would trade a one-second recovery for a cold start.

set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=ops/deploy/lib.sh
# shellcheck source=ops/deploy/lib.sh
. "$here/lib.sh"

tag=${1:-}
[ -n "$tag" ] || usage "$0 <tag>"

require_env WEB_IMAGE

compose_files=${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}
health_timeout=${HEALTH_TIMEOUT:-60}
observe_seconds=${OBSERVE_SECONDS:-30}
observe_interval=${OBSERVE_INTERVAL:-2}
public_health_url=${PUBLIC_HEALTH_URL:-https://localhost/api/health}

# shellcheck disable=SC2086 # deliberately split into separate -f arguments
compose() { docker compose $compose_files "$@"; }

# Read by the compose files to pick the image. Exported rather than set per
# command: `VAR=x func` leaves the assignment's lifetime up to the shell when the
# command is a function, and "which image did migrate actually run" is not a
# question worth leaving to that.
export WEB_IMAGE_TAG="$tag"


# --- which slot are we on, and which one is the target ----------------------
#
# `active-slot` is the single source of truth. Everything else -- the upstream
# file, the answer to "which release is serving" -- is derived from it.
active_slot=$(read_state active-slot)
if [ -z "$active_slot" ]; then
  # First deploy on this host. `blue` is chosen rather than discovered so that the
  # initial state is a decision recorded in the state file, not an accident of
  # which container happened to start first.
  active_slot=blue
  active_tag=$(read_state active-tag)
  log "no active slot recorded; initialising to blue (previous tag: ${active_tag:-none})"
  write_state active-slot "$active_slot"
fi

case "$active_slot" in
  blue) target_slot=green ;;
  green) target_slot=blue ;;
  *) die "active-slot contains '$active_slot', which is not blue or green" ;;
esac

target_service="web-$target_slot"
previous_tag=$(read_state active-tag)

log "deploying tag=$tag to $target_service (active: web-$active_slot${previous_tag:+, tag=$previous_tag})"
append_deploy_log "start tag=$tag target=$target_service active=$active_slot"

# --- 1. pull ----------------------------------------------------------------
log "pulling $WEB_IMAGE:$tag"
if ! compose pull "$target_service"; then
  append_deploy_log "abort tag=$tag stage=pull"
  die "pull failed; nothing on this host was changed"
fi

# --- 2. migrate, before anything moves -------------------------------------
#
# Runs while the currently active version keeps serving. Migrations must be
# backward compatible for exactly this reason: the old version is still running
# against the schema this step produces. See ops/runbook/migrations.md.
log "applying migrations (the active version keeps serving; migrations must be backward compatible)"
if ! compose run --rm migrate; then
  append_deploy_log "abort tag=$tag stage=migrate"
  die "migration failed; web-$active_slot was left serving and nothing else changed"
fi

# --- 3. start the target slot ----------------------------------------------
#
# Record the intent before the gate, so that a gate which never passes leaves a
# trace saying a release was attempted. Without this, a failed deploy and no
# deploy at all look identical to Prometheus, and DeployVersionDrift has nothing
# to compare against.
"$here/publish-version.sh" --expected "$tag" "$target_slot"

log "starting $target_service on tag=$tag (no traffic yet)"
if ! compose up -d --no-deps "$target_service"; then
  append_deploy_log "abort tag=$tag stage=start"
  die "could not start $target_service; web-$active_slot is still serving"
fi

# --- 4. gate the target slot, directly -------------------------------------
#
# PROBE_VIA runs the request inside the target container. The name
# `web-<slot>` resolves only on the compose network, so a host-side curl could
# not reach it even if the slot were perfectly healthy -- and testing through
# nginx would test the *old* slot, which would pass regardless.
log "gating $target_service on /api/health (budget ${health_timeout}s)"
if ! PROBE_VIA="$target_service" COMPOSE_FILES="$compose_files" \
  "$here/health-gate.sh" "http://localhost:3000/api/health" "$health_timeout"; then
  compose stop "$target_service" || true
  append_deploy_log "abort tag=$tag stage=health"
  die "web-$target_slot never became healthy, so it was stopped. Traffic was never moved; web-$active_slot is still serving tag=${previous_tag:-unknown}."
fi

# --- 5. switch traffic ------------------------------------------------------
log "moving traffic to web-$target_slot"
if ! "$here/../nginx/render-upstream.sh" "$target_slot"; then
  compose stop "$target_service" || true
  append_deploy_log "abort tag=$tag stage=switch"
  die "the upstream switch failed, so the target slot was stopped. web-$active_slot is still serving."
fi

# --- 6. watch the new version under real traffic ---------------------------
#
# The health gate proved the new version answers. It did not prove it answers
# correctly through nginx, with real requests, over time. This window is where a
# version that is broken only under load gets caught -- while the old slot is
# still running and switching back still takes a second.
if [ "$observe_seconds" -gt 0 ]; then
  log "observing $public_health_url for ${observe_seconds}s (${observe_interval}s interval)"
  if ! "$here/probe-loop.sh" "$public_health_url" "$observe_seconds" "$observe_interval"; then
    log "requests failed during observation; switching back to web-$active_slot"
    if "$here/../nginx/render-upstream.sh" "$active_slot"; then
      compose stop "$target_service" || true
      append_deploy_log "abort tag=$tag stage=observe"
      die "the new version failed while serving traffic; traffic was returned to web-$active_slot (tag=${previous_tag:-unknown})"
    fi
    append_deploy_log "abort tag=$tag stage=observe-switchback-failed"
    die "the new version failed AND switching back failed. web-$target_slot is still receiving traffic. Recover with: $here/rollback.sh"
  fi
fi

# --- 7. record ---------------------------------------------------------------
#
# Written last, and only after the new version has survived real traffic.
# `active-tag` becomes the rollback target, so it must name the release that was
# actually serving -- not the one that merely started.
write_state previous-tag "$previous_tag"
write_state active-tag "$tag"
write_state active-slot "$target_slot"
"$here/publish-version.sh" "$tag" "$target_slot"

append_deploy_log "ok tag=$tag slot=$target_slot"
log "deployed tag=$tag on web-$target_slot (rollback target: ${previous_tag:-none})"

# ---------------------------------------------------------------------------
# The old slot keeps running on purpose.
#
#   rollback.sh -> render upstream to web-$active_slot -> reload
#
# That is a config change against a container that is already warm, so recovery
# is measured in seconds and does not depend on a registry, a pipeline, or a
# successful pull. Stopping the old slot here would turn every rollback into a
# cold start -- and would mean the rollback path is only ever exercised on the
# day it is needed.
# ---------------------------------------------------------------------------
log "web-$active_slot is still running as the rollback target"
