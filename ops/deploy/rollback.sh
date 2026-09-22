#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Returns the host to a previously deployed release.
#
#   usage: rollback.sh [tag]      # defaults to the recorded previous-tag
#
#   env: same as deploy.sh
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
# against the current schema. That is only safe because migrations are
# expand-contract: a column or table is added and backfilled in one release, and
# only removed in a later one, so both versions can run against one schema.
#
# The consequence to state plainly: rolling back a *release* does not roll back
# the *database*, and a half-migrated schema is not something this script can
# repair. See ops/runbook/migrations.md.
#
# Batch four upgrades the re-deploy step below to an nginx upstream flip, which
# drops recovery from a container restart to a few seconds. The property above
# does not change: rolling back an image is still not rolling back a schema.

set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

service=${WEB_SERVICE:-web}
compose_files=${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}
health_url=${HEALTH_URL:-http://$service:3000/api/health}
health_timeout=${HEALTH_TIMEOUT:-60}

# shellcheck disable=SC2086 # deliberately split into separate -f arguments
compose() { docker compose $compose_files "$@"; }

tag=${1:-$(read_state previous-tag)}
[ -n "$tag" ] || die "no tag given and no previous-tag recorded; there is nothing to roll back to"

require_env WEB_IMAGE

active_tag=$(read_state active-tag)

if [ -n "$active_tag" ] && [ "$active_tag" = "$tag" ]; then
  die "tag=$tag is already the active release; refusing to redeploy it as a rollback"
fi

log "rolling back from ${active_tag:-none} to tag=$tag on $service"
append_deploy_log "rollback start from=${active_tag:-none} to=$tag"

log "pulling $WEB_IMAGE:$tag"
if ! compose pull; then
  append_deploy_log "rollback abort to=$tag stage=pull"
  die "pull failed; the current release was left running"
fi

export WEB_IMAGE_TAG="$tag"
log "re-deploying $service on tag=$tag (no migrations: the schema is not rolled back)"
if ! compose up -d --no-deps "$service"; then
  append_deploy_log "rollback abort to=$tag stage=start"
  die "could not start $service on tag=$tag"
fi

log "gating on health at $health_url (budget ${health_timeout}s)"
if ! "$here/health-gate.sh" "$health_url" "$health_timeout"; then
  append_deploy_log "rollback abort to=$tag stage=health"
  die "tag=$tag never became healthy either. The host is in an unknown state and needs a human: the schema may already have been migrated forward by the release being rolled back."
fi

write_state previous-tag "$active_tag"
write_state active-tag "$tag"
write_state active-slot "$service"
"$here/publish-version.sh" "$tag" "$service"

append_deploy_log "rollback ok to=$tag"
log "rolled back to tag=$tag"
log "the database schema was NOT rolled back; this is the design, not an oversight"
