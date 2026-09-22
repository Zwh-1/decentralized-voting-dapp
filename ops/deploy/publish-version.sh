#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Publishes the release that is actually serving, for node-exporter to collect.
#
#   usage: publish-version.sh <tag> <slot>              # record what is running
#          publish-version.sh --expected <tag> <slot>   # record what is intended
#
# The two modes exist so that "we tried to deploy X" and "X is serving" are
# separate observations with separate timestamps. Collapsing them into one write
# would make a failed deploy indistinguishable from no deploy at all, and the
# DeployVersionDrift rule needs exactly that difference.
#
# ---------------------------------------------------------------------------
# Why the deploy has to publish its own outcome
# ---------------------------------------------------------------------------
#
# A health gate proves that *something* answers 200 on that port. It cannot prove
# that the thing answering is the release CI just built — an untouched old
# container answers just as happily. Without a version series, "the deploy
# succeeded but the old version is still serving" is invisible, and it is the
# exact failure a deploy pipeline is supposed to catch.
#
# Writing it through node-exporter's textfile collector puts the version on the
# same timeline as every other graph, so a deploy is a visible event rather than
# a line in a log nobody correlates. Task 2.7 owns the node-exporter side; this
# is the producer.
#
# The write is a temp file plus a rename because node-exporter's collector reads
# the directory whenever it scrapes, and a reader must never see a partial file.
# 0644 because node-exporter runs as a different user than the deploy user and
# only ever reads.

set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

mode=running
if [ "${1:-}" = "--expected" ]; then
  mode=expected
  shift
fi

tag=${1:-}
slot=${2:-}
if [ "$mode" = "expected" ]; then
  [ -n "$tag" ] || usage "$0 --expected <tag> <slot>"
else
  [ -n "$tag" ] || usage "$0 <tag> <slot>"
fi
[ -n "$slot" ] || usage "$0 [--expected] <tag> <slot>"

dir="$(state_dir)/textfile"
mkdir -p "$dir"

# Two files rather than one. node-exporter's collector reads every *.prom in the
# directory, so keeping the expectation and the observation apart means each is a
# single independent rename -- no read-modify-write, and no window in which a
# crash could leave one of the two missing while claiming the other was updated.
if [ "$mode" = "expected" ]; then
  metric=voting_expected_info
  stamp=voting_expected_timestamp_seconds
  help_info="The release the deploy script is attempting. Written before the health gate."
  help_stamp="Unix time of the last attempted release."
  file="$dir/voting_expected.prom"
else
  metric=voting_deploy_info
  stamp=voting_deploy_timestamp_seconds
  help_info="The release the deploy script last confirmed healthy."
  help_stamp="Unix time of the last confirmed release."
  file="$dir/voting_deploy.prom"
fi

tmp="$file.$$"
{
  printf '# HELP %s %s\n' "$metric" "$help_info"
  printf '# TYPE %s gauge\n' "$metric"
  printf '%s{tag="%s",slot="%s"} 1\n' \
    "$metric" "$(escape_label_value "$tag")" "$(escape_label_value "$slot")"
  printf '# HELP %s %s\n' "$stamp" "$help_stamp"
  printf '# TYPE %s gauge\n' "$stamp"
  printf '%s %s\n' "$stamp" "$(date +%s)"
} >"$tmp"

mv "$tmp" "$file"
chmod 0644 "$file"

log "published $metric{tag=\"$tag\",slot=\"$slot\"}"
