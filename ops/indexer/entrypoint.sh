#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Keeps the index moving, one bounded drain at a time.
#
#   docker compose up -d indexer
#
# ---------------------------------------------------------------------------
# Why this wrapper exists at all
# ---------------------------------------------------------------------------
#
# `web/scripts/drain.ts` is a one-shot: it indexes until it reaches `idle` and
# then exits. Run that directly as a container command with `restart: always` and
# the deployment becomes an exit-restart busy loop -- thousands of lines of log
# per hour, a restart counter that only goes up, and the real failure buried
# somewhere in the noise.
#
# So this loop owns the repetition and decides what a failure means. A single bad
# round is expected: the RPC endpoint rate-limits, the database has a hiccup, a
# block arrives mid-read. Exiting on the first one would turn a blip into a
# restart storm, which is worse than the blip. But a process that never gives up
# hides a persistent fault behind a running container, so consecutive failures
# are counted and the loop deliberately exits to let the orchestrator restart it
# with a clean slate.
#
# ---------------------------------------------------------------------------
# What the logs are for
# ---------------------------------------------------------------------------
#
# One JSON object per round, including the fields drain.ts already reports
# (rounds / inserted / duplicatesIgnored / hitRoundLimit). A log stack can index
# these; a human reading `docker compose logs` can see at a glance whether the
# loop is advancing or stuck, which a stream of unstructured text would not show.

set -eu

POLL_INTERVAL_MS=${POLL_INTERVAL_MS:-4000}
MAX_CONSECUTIVE_FAILURES=${MAX_CONSECUTIVE_FAILURES:-10}

interval_s=$((POLL_INTERVAL_MS / 1000))
[ "$interval_s" -lt 1 ] && interval_s=1

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

log "{\"event\":\"start\",\"pollIntervalMs\":$POLL_INTERVAL_MS,\"maxConsecutiveFailures\":$MAX_CONSECUTIVE_FAILURES}"

round=0
failures=0

while :; do
  round=$((round + 1))
  started=$(date +%s)

  # The scripts run TypeScript directly, so they are executed through tsx rather
  # than from the built output: drain.ts starts from the schema owner, which the
  # Next build never traces. See the Dockerfile's runtime-deps note.
  # `if` rather than `node ...; code=$?`: under `set -e` a bare failing command
  # terminates the script, which would make everything below unreachable and turn
  # this wrapper into exactly the exit-on-first-error behaviour it exists to
  # prevent. The `if` form is what keeps the failure handling live.
  if node --import tsx web/scripts/drain.ts; then
    code=0
  else
    code=$?
  fi

  elapsed_ms=$(( ($(date +%s) - started) * 1000 ))

  if [ "$code" -eq 0 ]; then
    failures=0
    log "{\"event\":\"round\",\"round\":$round,\"exit\":0,\"durationMs\":$elapsed_ms,\"consecutiveFailures\":0}"
  else
    failures=$((failures + 1))
    log "{\"event\":\"round\",\"round\":$round,\"exit\":$code,\"durationMs\":$elapsed_ms,\"consecutiveFailures\":$failures}"

    if [ "$failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
      # Exiting is the point: the orchestrator restarts the container, and a
      # restart is visible in `docker inspect`'s RestartCount and in the alert on
      # the index's own error metric. Retrying forever would be invisible.
      log "{\"event\":\"give_up\",\"consecutiveFailures\":$failures,\"exit\":$code}"
      exit 1
    fi
  fi

  sleep "$interval_s"
done
