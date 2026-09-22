#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Brings one release onto the host.
#
#   usage: deploy.sh <tag>
#
#   env: WEB_IMAGE       image repository, without the tag (required)
#        WEB_SERVICE     compose service to deploy          (default: web)
#        COMPOSE_FILES   -f flags for the compose project   (default: base + prod)
#        HEALTH_URL      gate target                        (default: service:3000)
#        HEALTH_TIMEOUT  gate budget in seconds             (default: 60)
#        STATE_DIR       where the recorded state lives     (default: /srv/voting/state)
#
# ---------------------------------------------------------------------------
# Why the steps are in this order
# ---------------------------------------------------------------------------
#
#   pull     first, so a registry problem aborts before anything on the host has
#            been touched.
#   migrate  before the new version starts, while the old one is still serving.
#            Every migration must be backward compatible, because during the
#            overlap two versions run against one schema 鈥?and on a rollback the
#            old version runs against the *new* schema. ops/runbook/migrations.md.
#   start    the new version, then gate it on its own health before any traffic
#            is pointed at it.
#   record   only after the gate passes, so a failed release cannot leave state
#            claiming it succeeded. A rollback reads that state.
#
# ---------------------------------------------------------------------------
# What a failed gate can and cannot do here
# ---------------------------------------------------------------------------
#
# This deploys one service. Starting the new version *replaced* the old one, so a
# failed gate cannot leave the previous release serving 鈥?the plan originally
# said it could, and that is only true once there are two slots. So a failed gate
# stops the service and fails, and recovery is rollback.sh.
#
# Batch four splits web into two slots and flips nginx between them, at which
# point the previous version genuinely does survive the whole release. The
# sequence below is already written in terms of a named service so that change is
# confined to the compose files and the upstream flip.

set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

tag=${1:-}
[ -n "$tag" ] || usage "$0 <tag>"

require_env WEB_IMAGE

service=${WEB_SERVICE:-web}
compose_files=${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}
health_url=${HEALTH_URL:-http://$service:3000/api/health}
health_timeout=${HEALTH_TIMEOUT:-60}

# shellcheck disable=SC2086 # deliberately split into separate -f arguments
compose() { docker compose $compose_files "$@"; }

# Read by the compose files to pick the image. Exported rather than set per
# command: `VAR=x func` leaves the assignment's lifetime up to the shell when the
# command is a function, and "which image did migrate actually run" is not a
# question worth leaving to that.
export WEB_IMAGE_TAG="$tag"

active_tag=$(read_state active-tag)
log "deploying tag=$tag (currently active: ${active_tag:-none})"
append_deploy_log "start tag=$tag service=$service"

log "pulling $WEB_IMAGE:$tag"
if ! compose pull; then
  append_deploy_log "abort tag=$tag stage=pull"
  die "pull failed; nothing on this host was changed"
fi

log "applying migrations (the running version keeps serving; migrations must be backward compatible)"
if ! compose run --rm migrate; then
  append_deploy_log "abort tag=$tag stage=migrate"
  die "migration failed; the previously deployed version was left untouched"
fi

log "starting $service on tag=$tag"
if ! compose up -d --no-deps "$service"; then
  append_deploy_log "abort tag=$tag stage=start"
  die "could not start $service"
fi

# Record the intent before the gate, so that a gate which never passes leaves a
# trace saying a release was attempted. Without this, a failed deploy and no
# deploy at all look identical to Prometheus, and DeployVersionDrift has nothing
# to compare against.
"$here/publish-version.sh" --expected "$tag" "$service"

log "gating on health at $health_url (budget ${health_timeout}s)"
if ! "$here/health-gate.sh" "$health_url" "$health_timeout"; then
  compose stop "$service" || true
  append_deploy_log "abort tag=$tag stage=health"
  die "the new version never became healthy, so $service was stopped. Recovery is rollback.sh to ${active_tag:-the previous tag}."
fi

# Two writes with no way to make them one; both orders are safe, since either
# interruption leaves a rollback pointing at the release that was confirmed
# healthy. Written in this order only so the pairing in the state directory reads
# as (previous, active) when inspected by hand.
write_state previous-tag "$active_tag"
write_state active-tag "$tag"
write_state active-slot "$service"
"$here/publish-version.sh" "$tag" "$service"

append_deploy_log "ok tag=$tag service=$service"
log "deployed tag=$tag"
