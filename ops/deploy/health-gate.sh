#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Polls an endpoint until it answers 200 or the budget runs out.
#
#   usage: health-gate.sh <url> <timeout-seconds> [interval-seconds]
#   exit:  0 = became healthy, 1 = budget exhausted, 2 = wrong arguments
#
# Two probe modes, because the endpoint is not always reachable from the host:
#
#   default            curl from this shell
#   PROBE_VIA=<svc>    run the request inside the named compose service
#
# The second mode exists for the dual-slot deploy. The slots are named
# `web-blue` and `web-green`, and those names resolve only on the compose
# network -- from the host they do not exist. Probing the target slot has to
# happen inside the network, and it has to happen before traffic moves, which is
# the entire point of the gate.
#
# Only the probe is pluggable; the budget, the retry cadence, and the timing are
# shared. A second copy of the retry loop would be a second answer to "how long
# do we wait for", and the two would drift.
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

probe_via=${PROBE_VIA:-}
compose_files=${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}

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

# The in-network probe uses node's global fetch rather than curl or wget. The
# runtime image is node:24-bookworm-slim, which ships node and not much else, so
# node is the one HTTP client guaranteed to be present. A probe that depends on a
# tool the image lacks fails in a way that looks exactly like an unhealthy
# service -- the worst possible failure mode for a health check.
#
# The script prints the status and always exits 0; the caller reads the printed
# code. Exit code 9 is emitted when the request outlives its own timeout, and it
# is mapped to a non-200 so a timeout can never be read as success.
probe_in_container() {
  # shellcheck disable=SC2086 # deliberately split into separate -f arguments
  docker compose $compose_files exec -T \
    -e PROBE_URL="$url" \
    -e PROBE_TIMEOUT="$1" \
    "$probe_via" \
    node -e '
      const timer = setTimeout(() => {
        console.log(9);
        process.exit(0);
      }, Number(process.env.PROBE_TIMEOUT) * 1000);
      fetch(process.env.PROBE_URL)
        .then((response) => {
          clearTimeout(timer);
          console.log(response.status);
          process.exit(0);
        })
        .catch(() => {
          clearTimeout(timer);
          console.log(0);
          process.exit(0);
        });
    ' 2>/dev/null || true
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

  if [ -n "$probe_via" ]; then
    code=$(probe_in_container "$per_attempt")
    # The container may print nothing at all (a dead container, a compose error),
    # and may print surrounding whitespace. Normalise before comparing, so that
    # "no output" is a non-200 rather than an accidental match.
    code=$(printf '%s' "$code" | tr -d '[:space:]')
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$per_attempt" "$url" || true)
  fi
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
