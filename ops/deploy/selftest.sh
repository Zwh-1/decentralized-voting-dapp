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
# record success, and a rollback must not touch the schema. Those are the
# properties a person only discovers are broken during an incident — which is the
# worst possible time to find out.
#
# Proving them against a real host needs Docker, a registry, and a deliberate
# outage. Proving them against a stub `docker` needs a temp directory: the scripts
# only ever ask whether a command succeeded, so a stub that answers no is enough
# to drive every branch. The stubbed runs are not evidence that the container
# images work — batch one's acceptance test covers that — only that the scripts
# stop where they claim to stop.
#
# `curl` is stubbed for the same reason: it makes the health gate's two outcomes
# deterministic instead of dependent on whether something happens to be listening.
# health-gate.sh is additionally checked against a real HTTP server by hand; see
# the evidence recorded in the plan.

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
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/state"

  cat >"$CASE_DIR/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -u
printf 'docker %s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  *" run --rm migrate"*) [ "${FAKE_FAIL_MIGRATE:-0}" = "1" ] && exit 1 || exit 0 ;;
  *" pull"*)             [ "${FAKE_FAIL_PULL:-0}" = "1" ] && exit 1 || exit 0 ;;
  *" up -d"*)            [ "${FAKE_FAIL_UP:-0}" = "1" ] && exit 1 || exit 0 ;;
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
  export WEB_IMAGE="registry.example/voting-web"
  export WEB_SERVICE="web"
  export HEALTH_URL="http://stub.invalid/api/health"
  export HEALTH_TIMEOUT=1
  export PATH="$CASE_DIR/bin:$ORIGINAL_PATH"

  unset FAKE_FAIL_PULL FAKE_FAIL_MIGRATE FAKE_FAIL_UP FAKE_HEALTH || true
}

printf 'deploy script selftest (stubbed docker and curl)\n'

# ---------------------------------------------------------------------------
printf '\ncase 1: a failed migration leaves the running release alone\n'
new_case
printf 'oldtag\n' >"$STATE_DIR/active-tag"
export FAKE_FAIL_MIGRATE=1
run "$here/deploy.sh" newtag
unset FAKE_FAIL_MIGRATE
[ "$RC" -ne 0 ] && ok "deploy exits non-zero" || bad "deploy should have failed"
assert_has "it pulled before touching anything" " pull" "$FAKE_LOG"
assert_lacks "it never started the new release" " up -d" "$FAKE_LOG"
assert_lacks "it never stopped the running release" " stop" "$FAKE_LOG"
assert_eq "active-tag is unchanged" "oldtag" "$(cat "$STATE_DIR/active-tag")"
assert_lacks "no success line was appended" "ok tag=newtag" "$STATE_DIR/deploy.log"
assert_eq "no version was published" "" "$(cat "$STATE_DIR/textfile/voting_deploy.prom" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
printf '\ncase 2: a failed health gate stops the new release and records nothing\n'
new_case
printf 'oldtag\n' >"$STATE_DIR/active-tag"
export FAKE_HEALTH=bad
run "$here/deploy.sh" newtag
unset FAKE_HEALTH
[ "$RC" -ne 0 ] && ok "deploy exits non-zero" || bad "deploy should have failed"
assert_has "it did start the new release" " up -d" "$FAKE_LOG"
assert_has "it stopped the release that never became healthy" " stop" "$FAKE_LOG"
assert_eq "active-tag is still the old release" "oldtag" "$(cat "$STATE_DIR/active-tag")"
assert_lacks "no success line was appended" "ok tag=newtag" "$STATE_DIR/deploy.log"
assert_eq "no version was published" "" "$(cat "$STATE_DIR/textfile/voting_deploy.prom" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
printf '\ncase 3: a healthy release is recorded and published\n'
new_case
printf 'oldtag\n' >"$STATE_DIR/active-tag"
run "$here/deploy.sh" newtag
assert_eq "deploy exits 0" "0" "$RC"
assert_eq "active-tag is the new release" "newtag" "$(cat "$STATE_DIR/active-tag")"
assert_eq "previous-tag is the release it replaced" "oldtag" "$(cat "$STATE_DIR/previous-tag")"
assert_eq "active-slot is recorded" "web" "$(cat "$STATE_DIR/active-slot")"
assert_has "the running release is published as a metric" \
  'voting_deploy_info{tag="newtag",slot="web"} 1' "$STATE_DIR/textfile/voting_deploy.prom"
assert_has "the deploy log records success" "ok tag=newtag" "$STATE_DIR/deploy.log"

# ---------------------------------------------------------------------------
printf '\ncase 4: a rollback returns to the previous tag and never migrates\n'
new_case
printf 'newtag\n' >"$STATE_DIR/active-tag"
printf 'oldtag\n' >"$STATE_DIR/previous-tag"
run "$here/rollback.sh"
assert_eq "rollback exits 0" "0" "$RC"
assert_eq "active-tag is the previous release" "oldtag" "$(cat "$STATE_DIR/active-tag")"
assert_eq "previous-tag is the release rolled back from" "newtag" "$(cat "$STATE_DIR/previous-tag")"
assert_lacks "it did NOT run migrations" "run --rm migrate" "$FAKE_LOG"
case "$OUT" in
  *"NOT rolled back"*) ok "it says out loud that the schema was not rolled back" ;;
  *) bad "the schema warning is missing from the output" ;;
esac

# ---------------------------------------------------------------------------
printf '\ncase 5: the health gate on its own\n'
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
printf '\ncase 6: publish-version escapes a hostile label value\n'
new_case
run "$here/publish-version.sh" 'ab"c' 'we"b'
assert_eq "exits 0" "0" "$RC"
assert_has "the quote is escaped, keeping the payload parseable" \
  'voting_deploy_info{tag="ab\"c",slot="we\"b"} 1' "$STATE_DIR/textfile/voting_deploy.prom"

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
