#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Exercises the deploy scripts' decision-making without Docker or a server.
#
#   usage: selftest.sh        # exit 0 when every check passes
#
# ---------------------------------------------------------------------------
# Why a stub instead of the real thing
# ---------------------------------------------------------------------------
#
# The properties worth protecting here are the *abort* properties: a failed
# migration must not replace the running release, a failed health gate must not
# move traffic, a successful deploy must not stop the slot it may need to fall
# back to, and a rollback must not touch the schema. Those are the properties a
# person only discovers are broken during an incident -- which is the worst
# possible time to find out.
#
# Proving them against a real host needs Docker, a registry, and a deliberate
# outage. Proving them against a stub `docker` needs a temp directory: the scripts
# only ever ask whether a command succeeded, so a stub that answers no is enough
# to drive every branch. The stubbed runs are not evidence that the container
# images work -- batch one's acceptance test covers that -- only that the scripts
# stop where they claim to stop.
#
# `curl` is stubbed for the same reason: it makes the health gate's two outcomes
# deterministic instead of dependent on whether something happens to be listening.
# health-gate.sh is additionally checked against a real HTTP server by hand; see
# the evidence recorded in the plan.
#
# ---------------------------------------------------------------------------
# What the dual-slot cases are really asserting
# ---------------------------------------------------------------------------
#
# The claim "zero downtime" rests on one ordering: traffic moves *only* after the
# target slot has passed its own health gate, and the old slot is *still running*
# when it does. Both are asserted below, because both are invisible in a log that
# only says "deploy succeeded" -- and a deploy that moved traffic early would look
# identical from the outside until the day it mattered.

set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ORIGINAL_PATH=$PATH

pass=0
fail=0
CASE_DIRS=""

cleanup() {
  # shellcheck disable=SC2086 # intentional word splitting over the recorded list
  [ -n "$CASE_DIRS" ] && rm -rf $CASE_DIRS
  return 0
}
trap cleanup EXIT

ok() { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}

assert_has() {
  if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 (no match for [$2] in $3)"; fi
}

assert_lacks() {
  if grep -qF -- "$2" "$3"; then bad "$1 (found [$2] in $3)"; else ok "$1"; fi
}

assert_contains() {
  if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else bad "$1 (no match for [$2] in output)"; fi
}

assert_lacks_in_output() {
  if printf '%s' "$3" | grep -qF -- "$2"; then bad "$1 (found [$2] in output)"; else ok "$1"; fi
}

# Captures a script's exit code and combined output without letting `set -e`
# abort the harness on the failures we are deliberately provoking.
RC=0
OUT=""
run() {
  set +e
  OUT=$("$@" 2>&1)
  RC=$?
  set -e
}

new_case() {
  CASE_DIR=$(mktemp -d)
  CASE_DIRS="$CASE_DIRS $CASE_DIR"
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/state" "$CASE_DIR/upstream"

  cat >"$CASE_DIR/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -u
printf 'docker %s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  # A one-shot migration task.
  *" run --rm migrate"*) [ "${FAKE_FAIL_MIGRATE:-0}" = "1" ] && exit 1 || exit 0 ;;
  *" pull"*)             [ "${FAKE_FAIL_PULL:-0}" = "1" ] && exit 1 || exit 0 ;;
  # Starting or stopping a slot.
  *" up -d"*)            [ "${FAKE_FAIL_UP:-0}" = "1" ] && exit 1 || exit 0 ;;
  *" stop "*)            [ "${FAKE_FAIL_STOP:-0}" = "1" ] && exit 1 || exit 0 ;;
  *" stop"*)             [ "${FAKE_FAIL_STOP:-0}" = "1" ] && exit 1 || exit 0 ;;
  # `compose ps --status running --services` asks which services are up. It is how
  # render-upstream.sh decides whether there is a running nginx to reload: on a
  # host's first render there is none, and the render must still succeed.
  # `${VAR+x}` again, so a case can say "nothing is running" rather than "unset".
  *" ps --status running --services"*)
    if [ -n "${FAKE_RUNNING_SERVICES+x}" ]; then
      printf '%s\n' "${FAKE_RUNNING_SERVICES}"
    else
      printf 'nginx\n'
    fi
    exit 0
    ;;
  # `compose ps -q <svc>` asks whether the slot is running at all. Empty output
  # means "not running", which is how rollback.sh decides between its fast path
  # and starting the slot.
  *" ps -q"*)            [ -n "${FAKE_PS_ID:-}" ] && printf '%s\n' "$FAKE_PS_ID"; exit 0 ;;
  # `docker inspect --format {{.Config.Image}} <id>` identifies which release a
  # running container holds. The fast rollback path keys off this exactly.
  *"inspect"*)           [ -n "${FAKE_RUNNING_IMAGE:-}" ] && printf '%s\n' "$FAKE_RUNNING_IMAGE"; exit 0 ;;
  # `nginx -t` inside the nginx container.
  # `nginx -t` inside the nginx container. When it fails it prints a reason, the
  # way nginx does: the render script is expected to show that reason rather than
  # collapse every failure into "nginx rejected the rendered upstream", which
  # cannot be acted on (a log format used before it is declared and an
  # unresolvable upstream need opposite fixes).
  *"nginx -t"*)
    if [ "${FAKE_NGINX_TEST_FAIL:-0}" = "1" ]; then
      printf '[emerg] 1#1: fake failure in /etc/nginx/nginx.conf:35\n' >&2
      printf 'nginx: configuration file /etc/nginx/nginx.conf test failed\n' >&2
      exit 1
    fi
    exit 0
    ;;
  *"nginx -s reload"*)   [ "${FAKE_NGINX_RELOAD_FAIL:-0}" = "1" ] && exit 1 || exit 0 ;;
  # `docker compose exec -T <slot> node -e ...`, the in-network health probe. It
  # prints the HTTP status the way the node one-liner does.
  #
  # FAKE_HEALTH drives this too, so that one knob means "is the service healthy"
  # regardless of which probe path a script takes. Without that, a case that sets
  # FAKE_HEALTH=bad would still pass the target-slot gate, because deploy.sh
  # probes inside the container rather than from the host -- and the case would
  # assert the opposite of what it appears to.
  #
  # FAKE_EXEC_STATUS overrides it when a case needs to test the probe itself.
  # `${VAR+x}` distinguishes "set to empty" from "unset": an explicitly empty
  # value must stay empty, because "the container said nothing" is exactly the
  # case the gate has to refuse.
  *" exec "*)
    if [ -n "${FAKE_EXEC_STATUS+x}" ]; then
      printf '%s\n' "${FAKE_EXEC_STATUS}"
    elif [ "${FAKE_HEALTH:-ok}" = "ok" ]; then
      printf '200\n'
    else
      printf '500\n'
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE_DOCKER

  cat >"$CASE_DIR/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -u
printf 'curl %s\n' "$*" >>"$FAKE_LOG"
if [ "${FAKE_HEALTH:-ok}" = "ok" ]; then printf '200'; else printf '503'; fi
FAKE_CURL

  chmod +x "$CASE_DIR/bin/docker" "$CASE_DIR/bin/curl"
  : >"$CASE_DIR/calls.log"

  export CASE_DIR
  export FAKE_LOG="$CASE_DIR/calls.log"
  export STATE_DIR="$CASE_DIR/state"
  export UPSTREAM_DIR="$CASE_DIR/upstream"
  export WEB_IMAGE="registry.example/voting-web"
  export HEALTH_TIMEOUT=1
  # Zero, so a passing case does not spend its observation window sleeping. The
  # observation gate itself is covered by the probe-loop cases below.
  export OBSERVE_SECONDS=0
  export PATH="$CASE_DIR/bin:$ORIGINAL_PATH"

  unset FAKE_FAIL_PULL FAKE_FAIL_MIGRATE FAKE_FAIL_UP FAKE_FAIL_STOP \
    FAKE_HEALTH FAKE_PS_ID FAKE_RUNNING_IMAGE FAKE_NGINX_TEST_FAIL \
    FAKE_NGINX_RELOAD_FAIL FAKE_RUNNING_SERVICES || true
}

upstream_points_at() {
  # The rendered upstream lives under the case's own UPSTREAM_DIR.
  grep -qF "server web-$1:3000" "$UPSTREAM_DIR/upstream.conf" 2>/dev/null
}

printf 'deploy script selftest (stubbed docker and curl)\n'

# ---------------------------------------------------------------------------
printf '\ncase 1: a failed migration leaves the running release alone\n'
new_case
printf 'oldtag\n' >"$STATE_DIR/active-tag"
printf 'blue\n' >"$STATE_DIR/active-slot"
export FAKE_FAIL_MIGRATE=1
run "$here/deploy.sh" newtag
unset FAKE_FAIL_MIGRATE
[ "$RC" -ne 0 ] && ok "deploy exits non-zero" || bad "deploy should have failed"
assert_has "it pulled before touching anything" " pull" "$FAKE_LOG"
assert_lacks "it never started the target slot" " up -d" "$FAKE_LOG"
assert_lacks "it never stopped the active slot" " stop" "$FAKE_LOG"
assert_eq "active-tag is unchanged" "oldtag" "$(cat "$STATE_DIR/active-tag")"
assert_eq "active-slot is unchanged" "blue" "$(cat "$STATE_DIR/active-slot")"
assert_lacks "no success line was appended" "ok tag=newtag" "$STATE_DIR/deploy.log"
assert_eq "no version was published" "" "$(cat "$STATE_DIR/textfile/voting_deploy.prom" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
printf '\ncase 2: a failed health gate stops the target and never moves traffic\n'
new_case
printf 'oldtag\n' >"$STATE_DIR/active-tag"
printf 'blue\n' >"$STATE_DIR/active-slot"
export FAKE_HEALTH=bad
run "$here/deploy.sh" newtag
unset FAKE_HEALTH
[ "$RC" -ne 0 ] && ok "deploy exits non-zero" || bad "deploy should have failed"
assert_has "it did start the target slot" "up -d --no-deps web-green" "$FAKE_LOG"
assert_has "it stopped the release that never became healthy" "stop web-green" "$FAKE_LOG"
assert_lacks "it never reloaded nginx" "nginx -s reload" "$FAKE_LOG"
assert_eq "the upstream file was never written" "" "$(cat "$UPSTREAM_DIR/upstream.conf" 2>/dev/null || true)"
assert_eq "active-tag is still the old release" "oldtag" "$(cat "$STATE_DIR/active-tag")"
assert_eq "active-slot is still blue" "blue" "$(cat "$STATE_DIR/active-slot")"
assert_lacks "no success line was appended" "ok tag=newtag" "$STATE_DIR/deploy.log"
# The attempt itself must survive, or a failed deploy is indistinguishable from no
# deploy at all -- which is exactly what the DeployVersionDrift rule compares.
assert_has "the attempt was recorded even though it failed" \
  'voting_expected_info{tag="newtag",slot="green"} 1' "$STATE_DIR/textfile/voting_expected.prom"

# ---------------------------------------------------------------------------
printf '\ncase 3: a healthy release flips the slot and keeps the old one alive\n'
new_case
printf 'oldtag\n' >"$STATE_DIR/active-tag"
printf 'blue\n' >"$STATE_DIR/active-slot"
run "$here/deploy.sh" newtag
assert_eq "deploy exits 0" "0" "$RC"
assert_eq "active-tag is the new release" "newtag" "$(cat "$STATE_DIR/active-tag")"
assert_eq "previous-tag is the release it replaced" "oldtag" "$(cat "$STATE_DIR/previous-tag")"
assert_eq "the slot flipped from blue to green" "green" "$(cat "$STATE_DIR/active-slot")"
assert_has "the running release is published with the new slot" \
  'voting_deploy_info{tag="newtag",slot="green"} 1' "$STATE_DIR/textfile/voting_deploy.prom"
assert_has "the deploy log records success" "ok tag=newtag" "$STATE_DIR/deploy.log"
if upstream_points_at green; then ok "the upstream was rendered to web-green"; else bad "the upstream does not point at web-green"; fi
assert_has "nginx was reloaded, not restarted" "nginx -s reload" "$FAKE_LOG"
assert_lacks "nginx was never restarted" "nginx -s stop" "$FAKE_LOG"
# The assertion that makes rollback cheap. If this ever fails, rollback becomes a
# cold start and the central claim of the design is gone.
assert_lacks "the old slot was NOT stopped -- it is the rollback target" "stop web-blue" "$FAKE_LOG"
assert_has "migrations did run, exactly once, before the slot started" "run --rm migrate" "$FAKE_LOG"

# ---------------------------------------------------------------------------
printf '\ncase 4: a rollback moves traffic back without a restart\n'
new_case
printf 'newtag\n' >"$STATE_DIR/active-tag"
printf 'oldtag\n' >"$STATE_DIR/previous-tag"
printf 'green\n' >"$STATE_DIR/active-slot"
# The old slot is still running on the tag we are rolling back to: the fast path.
export FAKE_PS_ID="container-abc"
export FAKE_RUNNING_IMAGE="registry.example/voting-web:oldtag"
run "$here/rollback.sh"
assert_eq "rollback exits 0" "0" "$RC"
assert_eq "active-tag is the previous release" "oldtag" "$(cat "$STATE_DIR/active-tag")"
assert_eq "previous-tag is the release rolled back from" "newtag" "$(cat "$STATE_DIR/previous-tag")"
assert_eq "the slot flipped back to blue" "blue" "$(cat "$STATE_DIR/active-slot")"
if upstream_points_at blue; then ok "the upstream was rendered back to web-blue"; else bad "the upstream does not point at web-blue"; fi
# The warning is printed to the script's output, not only to the deploy log: the
# person reading a failed rollback is reading the terminal.
assert_contains "it said the schema was not rolled back" "NOT rolled back" "$OUT"
assert_has "and logged it too" "NOT rolled back" "$STATE_DIR/deploy.log"
# The fast path must not restart anything. Asserted explicitly because starting
# the slot would still "work" -- it would just silently cost the seconds that are
# the entire reason for having two slots.
assert_lacks "it did NOT run migrations" "run --rm migrate" "$FAKE_LOG"
assert_lacks "it did NOT restart the target slot (fast path)" "up -d" "$FAKE_LOG"
assert_lacks "the running release is published with the new slot" \
  'voting_deploy_info{tag="newtag"' "$STATE_DIR/textfile/voting_deploy.prom"

# ---------------------------------------------------------------------------
printf '\ncase 5: a rollback to a cold slot starts and gates it first\n'
new_case
printf 'newtag\n' >"$STATE_DIR/active-tag"
printf 'oldtag\n' >"$STATE_DIR/previous-tag"
printf 'green\n' >"$STATE_DIR/active-slot"
# No running container (host rebooted), so the slow path applies.
run "$here/rollback.sh"
assert_eq "rollback exits 0" "0" "$RC"
assert_has "it started the target slot" "up -d --no-deps web-blue" "$FAKE_LOG"
assert_eq "the slot flipped back to blue" "blue" "$(cat "$STATE_DIR/active-slot")"
assert_lacks "it did NOT run migrations" "run --rm migrate" "$FAKE_LOG"

# ---------------------------------------------------------------------------
printf '\ncase 6: a rollback refuses to target the running release\n'
new_case
printf 'sametag\n' >"$STATE_DIR/active-tag"
printf 'sametag\n' >"$STATE_DIR/previous-tag"
printf 'blue\n' >"$STATE_DIR/active-slot"
run "$here/rollback.sh"
[ "$RC" -ne 0 ] && ok "it exits non-zero" || bad "a no-op rollback should fail"
assert_contains "it explains why" "already active" "$OUT"
assert_lacks "it never reloaded nginx" "nginx -s reload" "$FAKE_LOG"

# ---------------------------------------------------------------------------
printf '\ncase 7: a rejected upstream leaves the previous one in place\n'
new_case
printf 'oldtag\n' >"$STATE_DIR/active-tag"
printf 'blue\n' >"$STATE_DIR/active-slot"
printf 'server web-blue:3000;\n' >"$UPSTREAM_DIR/upstream.conf"
export FAKE_NGINX_TEST_FAIL=1
run "$here/../nginx/render-upstream.sh" green
unset FAKE_NGINX_TEST_FAIL
[ "$RC" -ne 0 ] && ok "render-upstream exits non-zero" || bad "a rejected config should fail"
if upstream_points_at blue; then ok "the previous upstream was restored"; else bad "the previous upstream was not restored"; fi
assert_lacks "nginx was not reloaded with a config it rejected" "nginx -s reload" "$FAKE_LOG"
# The rejected config's reason has to reach the operator. Redirecting nginx's
# output to /dev/null (as this script did at first) leaves only "nginx rejected
# the rendered upstream", which is true, urgent, and tells you nothing.
assert_contains "nginx's own reason is shown" "fake failure in /etc/nginx/nginx.conf" "$OUT"

# ---------------------------------------------------------------------------
printf '\ncase 8: render-upstream refuses an unknown slot\n'
new_case
run "$here/../nginx/render-upstream.sh" purple
assert_eq "exit 2 for a slot that is not blue or green" "2" "$RC"
assert_lacks "nginx was never touched" "nginx -t" "$FAKE_LOG"

# ---------------------------------------------------------------------------
printf '\ncase 9: the first render on a host where nginx has never started\n'
new_case
# The deadlock this covers: nginx.conf includes upstream.conf by an exact path, so
# nginx cannot start before that file exists -- and this script is the only thing
# that writes it. Validating through `exec` into a running nginx therefore made
# the first deploy on a fresh host impossible, and every retry failed the same
# way. The render has to succeed with nothing running, and must not claim to have
# reloaded anything.
export FAKE_RUNNING_SERVICES=""
run "$here/../nginx/render-upstream.sh" blue
unset FAKE_RUNNING_SERVICES
assert_eq "it exits 0 with no nginx running" "0" "$RC"
if upstream_points_at blue; then ok "the upstream was written for web-blue"; else bad "the upstream was not written"; fi
assert_has "the config was still validated, in a throwaway container" "nginx -t" "$FAKE_LOG"
assert_has "it validated via run, not by exec into a live server" "run --rm --no-deps" "$FAKE_LOG"
# `nginx -t` resolves the upstream names while parsing, and on a host that has
# never started there is no container for Docker's DNS to answer with -- so the
# validation container is handed the two slot names in its own /etc/hosts. Without
# this the first render fails with "host not found in upstream", which is about
# DNS and not about the file that was just rendered.
assert_has "the validation container is told where the slots are" \
  "127.0.0.1 web-blue web-green" "$FAKE_LOG"
assert_lacks "it did not reload a server that is not running" "nginx -s reload" "$FAKE_LOG"
assert_contains "it says so instead of pretending" "not running yet" "$OUT"

# ---------------------------------------------------------------------------
printf '\ncase 10: the health gate on its own\n'
new_case
export FAKE_HEALTH=ok
run "$here/health-gate.sh" "http://stub.invalid/api/health" 1
assert_eq "exit 0 when the endpoint answers 200" "0" "$RC"
export FAKE_HEALTH=bad
run "$here/health-gate.sh" "http://stub.invalid/api/health" 1
assert_eq "exit 1 when it never becomes healthy" "1" "$RC"
case "$OUT" in
  *"status 503"*) ok "the failure names the status it saw" ;;
  *) bad "the failure does not report the last status" ;;
esac
run "$here/health-gate.sh"
assert_eq "exit 2 when called without arguments" "2" "$RC"
run "$here/health-gate.sh" "http://stub.invalid/api/health" "abc"
assert_eq "exit 2 when the budget is not a number" "2" "$RC"
assert_has "the gate discards the response body" "-o /dev/null" "$FAKE_LOG"

# ---------------------------------------------------------------------------
printf '\ncase 11: the in-network probe path\n'
new_case
# PROBE_VIA makes the gate run the request inside the target container, because
# `web-blue`/`web-green` do not resolve from the host. The default stub already
# answers `exec` from FAKE_EXEC_STATUS; these cases drive that value.
export FAKE_EXEC_STATUS=200
run env PROBE_VIA=web-green COMPOSE_FILES="-f docker-compose.yml" \
  "$here/health-gate.sh" "http://localhost:3000/api/health" 1
assert_eq "exit 0 when the container reports 200" "0" "$RC"
export FAKE_EXEC_STATUS=500
run env PROBE_VIA=web-green COMPOSE_FILES="-f docker-compose.yml" \
  "$here/health-gate.sh" "http://localhost:3000/api/health" 1
assert_eq "exit 1 when the container reports 500" "1" "$RC"
# A container that produces no output at all must not be read as healthy. This is
# the case a naive `${VAR:-200}` default would silently turn into a pass.
export FAKE_EXEC_STATUS=""
run env PROBE_VIA=web-green COMPOSE_FILES="-f docker-compose.yml" \
  "$here/health-gate.sh" "http://localhost:3000/api/health" 1
assert_eq "exit 1 when the container says nothing" "1" "$RC"
assert_has "it probed inside the target container" "exec -T" "$FAKE_LOG"
unset FAKE_EXEC_STATUS

# ---------------------------------------------------------------------------
printf '\ncase 12: probe-loop counts failures and gates on them\n'
new_case
# No failures: the whole window succeeds. Run directly rather than in a subshell,
# so the harness captures the exit code and output it is about to assert on.
export FAKE_HEALTH=ok
run "$here/probe-loop.sh" "http://stub.invalid/api/health" 2 1
assert_eq "exit 0 when every request succeeds" "0" "$RC"
assert_contains "the summary reports zero failures" '"failed":0' "$OUT"
assert_contains "and a total" '"total":' "$OUT"
assert_contains "and the consecutive-failure count" '"maxConsecutiveFailures":0' "$OUT"
unset FAKE_HEALTH
# Every request fails.
run env FAKE_HEALTH=bad "$here/probe-loop.sh" "http://stub.invalid/api/health" 2 1
assert_eq "exit 1 when requests fail" "1" "$RC"
assert_contains "the summary reports failures" '"failed":' "$OUT"
assert_contains "and the first failure's timing" '"firstFailureAtSeconds":' "$OUT"
# The failure that matters most: a probe that made no requests at all must not
# report success, or a broken drill would certify the property it never tested.
run "$here/probe-loop.sh" "http://stub.invalid/api/health" 0 1
assert_eq "exit 1 when no requests were made (an invalid measurement)" "1" "$RC"
run "$here/probe-loop.sh" "http://stub.invalid/api/health" "abc" 1
assert_eq "exit 2 when the duration is not a number" "2" "$RC"
run "$here/probe-loop.sh"
assert_eq "exit 2 when called without arguments" "2" "$RC"

# The certificate exception. A deployment reachable only at a bare IP has no
# trusted chain to verify against, so verification fails on every request and the
# window reports an outage that is not happening -- after traffic has moved, which
# makes deploy.sh roll back a release that was working. INSECURE_TLS=1 is the way
# out, and it must be visible in the artifact rather than only in the caller's
# shell, so the summary says so.
assert_lacks "curl verifies the certificate by default" "curl -s -k " "$FAKE_LOG"
export FAKE_HEALTH=ok
run env INSECURE_TLS=1 "$here/probe-loop.sh" "http://stub.invalid/api/health" 2 1
assert_eq "exit 0 with verification disabled" "0" "$RC"
assert_has "curl is told to accept the certificate" "curl -s -k " "$FAKE_LOG"
assert_contains "the summary records that the measurement was weakened" \
  '"insecureTls":true' "$OUT"
# And a normal run must not carry that field, or "weakened" stops meaning
# anything: the point of recording it is that its absence is informative too.
run "$here/probe-loop.sh" "http://stub.invalid/api/health" 2 1
assert_lacks_in_output "a verified run carries no insecureTls field" '"insecureTls"' "$OUT"
unset FAKE_HEALTH

# ---------------------------------------------------------------------------
printf '\ncase 13: publish-version escapes a hostile label value\n'
new_case
run "$here/publish-version.sh" 'ab"c' 'we"b'
assert_eq "exits 0" "0" "$RC"
assert_has "the quote is escaped, keeping the payload parseable" \
  'voting_deploy_info{tag="ab\"c",slot="we\"b"} 1' "$STATE_DIR/textfile/voting_deploy.prom"

# ---------------------------------------------------------------------------
printf '\ncase 14: the two publish modes write different files\n'
new_case
run "$here/publish-version.sh" --expected attempted tried
assert_eq "the expected mode exits 0" "0" "$RC"
assert_has "it records what was intended" \
  'voting_expected_info{tag="attempted",slot="tried"} 1' "$STATE_DIR/textfile/voting_expected.prom"
assert_eq "and does not touch the running record" "" \
  "$(cat "$STATE_DIR/textfile/voting_deploy.prom" 2>/dev/null || true)"

run "$here/publish-version.sh" confirmed tried
assert_eq "the running mode exits 0" "0" "$RC"
assert_has "it records what is serving" \
  'voting_deploy_info{tag="confirmed",slot="tried"} 1' "$STATE_DIR/textfile/voting_deploy.prom"
assert_has "the earlier expectation is left alone" \
  'voting_expected_info{tag="attempted",slot="tried"} 1' "$STATE_DIR/textfile/voting_expected.prom"
assert_has "the timestamp is published too" \
  "voting_deploy_timestamp_seconds " "$STATE_DIR/textfile/voting_deploy.prom"

run "$here/publish-version.sh" --expected onlyonetag
assert_eq "exit 2 when the slot is missing" "2" "$RC"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
