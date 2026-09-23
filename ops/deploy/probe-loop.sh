#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Requests a URL repeatedly and reports how many of them failed.
#
#   usage: probe-loop.sh <url> <duration-seconds> [interval-seconds]
#   exit:  0 = every request succeeded, 1 = at least one failed, 2 = bad arguments
#
# ---------------------------------------------------------------------------
# What this is for
# ---------------------------------------------------------------------------
#
# Zero downtime is a claim about requests, so it has to be measured in requests.
# "The deploy finished and the site was up afterwards" is not evidence: it is
# consistent with a two-second outage in the middle that nobody happened to
# observe. This loop makes the outage visible by issuing requests continuously
# across the change.
#
# The exit code matters as much as the summary. deploy.sh runs this after moving
# traffic and treats a non-zero exit as a failed release, so the observation
# window is a gate rather than a report.
#
# ---------------------------------------------------------------------------
# Why it keeps going after the target is gone
# ---------------------------------------------------------------------------
#
# A probe that stops at the first failure measures "did anything fail", not "how
# long was it broken". The consecutive-failure count is what distinguishes a
# single dropped connection from a real window of unavailability, and that
# distinction is the entire comparison between the two deploy strategies -- so
# the loop runs its full duration and counts throughout.
#
# A failure is any response that is not the expected status, plus no response at
# all. A redirect or a 500 both fail: the probe follows the same contract the
# load balancer's health check does.

set -euo pipefail

url=${1:-}
duration=${2:-}
interval=${3:-2}

if [ -z "$url" ] || [ -z "$duration" ]; then
  printf 'usage: %s <url> <duration-seconds> [interval-seconds]\n' "$0" >&2
  exit 2
fi

for value in "$duration" "$interval"; do
  case "$value" in
    '' | *[!0-9]*) printf 'duration and interval must be whole numbers of seconds\n' >&2; exit 2 ;;
  esac
done

if [ "$interval" -lt 1 ]; then
  printf 'interval must be at least 1 second\n' >&2
  exit 2
fi

expected=${EXPECTED_STATUS:-200}
timeout_per_request=${REQUEST_TIMEOUT:-5}

# Whether curl verifies the certificate. It does, by default: a probe that
# accepts any certificate is not evidence of anything.
#
# The exception is real and predictable, though. A deployment reachable only at a
# bare IP address -- or at a domain whose certificate has not been issued yet --
# has no trusted chain to verify against, so EVERY request fails verification and
# the observation window reports an outage that is not happening. That failure is
# worse than the one the check guards against: it fires after traffic has already
# moved, and deploy.sh treats it as a failed release and rolls back. The result is
# a deployment that can never succeed for a reason that has nothing to do with
# the release.
#
# Set INSECURE_TLS=1 for those deployments. The probe then proves reachability
# and nothing about identity -- the same trade `http_2xx_insecure` in
# ops/blackbox/blackbox.yml documents for the external scrape. Unset it once a
# trusted certificate is in place; the summary says when it was set.
#
# An array rather than a string so the flag cannot be split or dropped by
# word-splitting, and so `set -u` has nothing to complain about: it always holds
# at least the -s below.
curl_args=(-s)
if [ "${INSECURE_TLS:-}" = "1" ]; then
  curl_args+=(-k)
fi
started=$(date +%s)
deadline=$((started + duration))

total=0
succeeded=0
failed=0
consecutive=0
max_consecutive=0
first_failure_at=""

while :; do
  now=$(date +%s)
  [ "$now" -ge "$deadline" ] && break

  total=$((total + 1))
  code=$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code}' --max-time "$timeout_per_request" "$url" || true)

  if [ "$code" = "$expected" ]; then
    succeeded=$((succeeded + 1))
    consecutive=0
  else
    failed=$((failed + 1))
    consecutive=$((consecutive + 1))
    [ "$consecutive" -gt "$max_consecutive" ] && max_consecutive=$consecutive
    if [ -z "$first_failure_at" ]; then
      first_failure_at=$(($(date +%s) - started))
      printf 'probe-loop: first failure at +%ss (status %s)\n' "$first_failure_at" "${code:-none}" >&2
    fi
  fi

  # Sleep only the remainder of this interval, and never past the deadline, so a
  # slow request shortens the wait instead of extending the run. Without this the
  # loop overruns its stated duration by up to one interval per slow request --
  # and the duration is what the drill reports.
  elapsed_this=$(( $(date +%s) - now ))
  nap=$((interval - elapsed_this))
  [ "$nap" -lt 1 ] && nap=1
  [ $(( $(date +%s) + nap )) -gt "$deadline" ] && break
  sleep "$nap"
done

elapsed=$(($(date +%s) - started))

# One line of JSON, matching the shape drain.ts emits, so that both can be read
# by the same tooling and pasted into the runbook side by side.
printf '{"event":"probe","url":"%s","total":%d,"succeeded":%d,"failed":%d,"maxConsecutiveFailures":%d,"durationSeconds":%d' \
  "$url" "$total" "$succeeded" "$failed" "$max_consecutive" "$elapsed"
if [ -n "$first_failure_at" ]; then
  printf ',"firstFailureAtSeconds":%d' "$first_failure_at"
fi
# Recorded in the artifact, not just in the caller's shell: a measurement made
# with certificate verification off is a weaker claim, and the summary is what
# gets pasted into the runbook and read months later by someone who did not run
# it. Absent means verification was on.
if [ "${INSECURE_TLS:-}" = "1" ]; then
  printf ',"insecureTls":true'
fi
printf '}\n'

if [ "$total" -eq 0 ]; then
  # No requests at all is not success. It means the duration or the clock was
  # wrong, and reporting it as a pass would let a broken drill certify the very
  # property it was supposed to test.
  printf 'probe-loop: no requests were made; the measurement is invalid\n' >&2
  exit 1
fi

if [ "$failed" -gt 0 ]; then
  exit 1
fi

exit 0
