#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Publishes the release that is actually serving, for node-exporter to collect.
#
#   usage: publish-version.sh <tag> <slot>
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

tag=${1:-}
slot=${2:-}
[ -n "$tag" ] || die "usage: $0 <tag> <slot>"
[ -n "$slot" ] || die "usage: $0 <tag> <slot>"

dir="$(state_dir)/textfile"
mkdir -p "$dir"

tmp="$dir/.voting_deploy.prom.$$"
{
  printf '# HELP voting_deploy_info The release the deploy script last confirmed healthy.\n'
  printf '# TYPE voting_deploy_info gauge\n'
  printf 'voting_deploy_info{tag="%s",slot="%s"} 1\n' \
    "$(escape_label_value "$tag")" "$(escape_label_value "$slot")"
  printf '# HELP voting_deploy_timestamp_seconds Unix time of the last confirmed release.\n'
  printf '# TYPE voting_deploy_timestamp_seconds gauge\n'
  printf 'voting_deploy_timestamp_seconds %s\n' "$(date +%s)"
} >"$tmp"

mv "$tmp" "$dir/voting_deploy.prom"
chmod 0644 "$dir/voting_deploy.prom"

log "published voting_deploy_info{tag=\"$tag\",slot=\"$slot\"}"
