#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Shared helpers for the deploy scripts.
#
# Sourced, never executed: `deploy.sh` and `rollback.sh` both need the same state
# handling, and two copies of "record the active tag atomically" would drift the
# first time one of them was fixed.
#
# Everything here writes to stderr except the two readers and the two accessors,
# which print to stdout so a caller can capture them.

# ---------------------------------------------------------------------------
# Why state lives in files rather than in the compose project
# ---------------------------------------------------------------------------
#
# What is running has to survive a reboot, a `docker compose down`, and a human
# typing the wrong command at 2am. Three small files are readable with `cat`,
# writable over SSH without a client, and diffable in an incident review — and
# nginx's upstream file plus the metrics textfile are both *derived* from them,
# so there is exactly one place that knows which release is live.

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

# Reports only the NAME of a variable that is missing.
#
# The deploy log is kept on disk and read by people after an incident; echoing a
# value would put whatever it holds into that file. ADR-0016 — a failure report
# names the variable, never its content.
require_env() {
  local name
  for name in "$@"; do
    if [ -z "$(printenv "$name" 2>/dev/null || true)" ]; then
      die "required environment variable $name is empty or unset"
    fi
  done
}

state_dir() {
  printf '%s' "${STATE_DIR:-/srv/voting/state}"
}

# Prints the recorded value, or nothing when it has never been written. A missing
# file is the normal first-deploy case rather than an error, so callers compare
# against the empty string instead of checking for the file.
read_state() {
  local file
  file="$(state_dir)/$1"
  [ -f "$file" ] && cat "$file" || true
}

# Written atomically, because the readers run at arbitrary moments: nginx reads
# the rendered upstream and node-exporter reads the textfile while a deploy is in
# flight, and a reader must never observe a half-written file.
write_state() {
  local dir tmp
  dir="$(state_dir)"
  mkdir -p "$dir"
  tmp="$dir/.$1.$$"
  printf '%s\n' "$2" >"$tmp"
  mv "$tmp" "$dir/$1"
}

append_deploy_log() {
  local dir
  dir="$(state_dir)"
  mkdir -p "$dir"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$dir/deploy.log"
}

# Escapes a label value for the Prometheus text format, mirroring
# `escapeLabelValue` in web/src/lib/metrics.ts.
#
# Backslash and quote only. A tag is a git SHA and a slot is one of two fixed
# words, so neither can contain a newline; the escaping exists so that a future
# caller passing something else cannot emit a payload node-exporter rejects.
escape_label_value() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# The directory this file lives in, so a caller can find its siblings without
# caring where the repository was checked out.
deploy_script_dir() {
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
}
