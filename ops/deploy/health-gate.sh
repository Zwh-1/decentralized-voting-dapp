#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Polls an endpoint until it answers 200 or the budget runs out.
#
#   usage: health-gate.sh <url> <timeout-seconds> [interval-seconds]
#   exit:  0 = became healthy, 1 = budget exhausted, 2 = wrong arguments
#
# ---------------------------------------------------------------------------
# Why the response body is discarded instead of logged
# ---------------------------------------------------------------------------
#
# A deploy log is kept on disk, pasted into tickets, and read by people long
# after the release. The body today is a health payload, but this script is
# pointed at whatever URL it is handed — and a `/api/health` behind a
# misconfigured proxy, or a later version of the endpoint, can answer with
# something that must not travel. It is also simply not needed: whether the
# service is up is a status code, and how long it took is arithmetic.
#
# So: `-o /dev/null`, and only the code and the timing are ever printed.

set -euo pipefail

url=${1:-}
budget=${2:-}
interval=${3:-2}

if [ -z "$url" ] || [ -z "$budget" ]; then
  printf 'usage: %s <url> <timeout-seconds> [interval-seconds]\n' "$0" >&2
  exit 2
fi

case "$budget" in
  '' | *[!0-9]*) printf 'timeout-seconds must be a whole number of seconds\n' >&2; exit 2 ;;
esac

log() {
  printf '%s health-gate: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

started=$(date +%s)
attempts=0

# The deadline is checked before sleeping rather than after, so a budget of 0
# still makes exactly one attempt: a gate that can pass must not be configurable
# into never trying.
#
# Each attempt's own timeout and each wait between attempts are clamped to what
# is left of the budget, so the budget is a real bound rather than an
# approximate one. Without the clamps the gate can spend a full `--max-time` and
# a full interval after the budget has already expired, which turns
# `HEALTH_TIMEOUT=60` into "somewhere under 65 seconds" — and a caller sizing a
# deploy window from that number deserves the number it asked for.
#
# The floors of 1s exist so the final attempt still gets to connect and the last
# wait still yields the CPU; they are what the stated precision costs.
while :; do
  attempts=$((attempts + 1))
  elapsed=$(($(date +%s) - started))

  per_attempt=$((budget - elapsed))
  [ "$per_attempt" -lt 1 ] && per_attempt=1
  [ "$per_attempt" -gt 5 ] && per_attempt=5

  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$per_attempt" "$url" || true)
  elapsed=$(($(date +%s) - started))

  if [ "$code" = "200" ]; then
    log "passed: HTTP 200 on attempt $attempts after ${elapsed}s"
    exit 0
  fi

  if [ "$elapsed" -ge "$budget" ]; then
    log "failed: last status ${code:-none} after $attempts attempt(s) in ${elapsed}s (budget ${budget}s)"
    exit 1
  fi

  nap=$((budget - elapsed))
  [ "$nap" -gt "$interval" ] && nap=$interval
  [ "$nap" -lt 1 ] && nap=1

  log "attempt $attempts: status ${code:-none}, retrying in ${nap}s"
  sleep "$nap"
done
