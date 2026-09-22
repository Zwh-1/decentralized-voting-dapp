#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Checks the alert rules and dashboards against the inventory of series that exist.

    python3 ops/prometheus/check-rules.py

What this catches that promtool cannot: a rule or panel naming a series that no
part of this repository exports. `promtool check rules` validates syntax and will
happily pass a rule built on a metric that does not exist -- that rule then never
fires, which looks exactly like "nothing is wrong". A panel on a missing series
renders as an empty graph, which looks like "no traffic". Both are silent, and
both are the failure mode this whole file exists to prevent.

What it deliberately does NOT do: parse PromQL. This is a structural check and an
inventory comparison, not a PromQL parser, so it cannot tell a well-formed
expression from a malformed one. promtool remains the gate for that; this is the
gate for provenance.

Exit status is non-zero when anything is unnamed, so it can run in CI.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

OPS = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# The inventory. This is the authoritative list: every series used in a rule or a
# dashboard must appear here with the thing that produces it. Adding a series to
# a rule without adding it here is the error this file reports.
# ---------------------------------------------------------------------------
OWNERS: dict[str, str] = {
    # GET /api/metrics -- web/src/lib/metrics.ts
    "voting_chain_info": "/api/metrics",
    "voting_chain_head_block": "/api/metrics",
    "voting_index_last_block": "/api/metrics",
    "voting_index_lag_blocks": "/api/metrics",
    "voting_index_configured": "/api/metrics",
    "voting_indexer_loop_enabled": "/api/metrics",
    "voting_poll_count": "/api/metrics",
    "voting_index_errors_total": "/api/metrics",
    "voting_process_resident_memory_bytes": "/api/metrics",
    "voting_process_uptime_seconds": "/api/metrics",
    # ops/deploy/publish-version.sh, called by deploy.sh and rollback.sh
    "voting_deploy_info": "ops/deploy/publish-version.sh",
    "voting_deploy_timestamp_seconds": "ops/deploy/publish-version.sh",
    "voting_expected_info": "ops/deploy/publish-version.sh",
    "voting_expected_timestamp_seconds": "ops/deploy/publish-version.sh",
    # blackbox-exporter
    "probe_success": "blackbox-exporter",
    "probe_duration_seconds": "blackbox-exporter",
    # Prometheus itself
    "up": "prometheus",
    # mysqld-exporter
    "mysql_up": "mysqld-exporter",
    # node-exporter
    "node_cpu_seconds_total": "node-exporter",
    "node_memory_MemAvailable_bytes": "node-exporter",
    "node_filesystem_avail_bytes": "node-exporter",
    # cadvisor
    "container_start_time_seconds": "cadvisor",
    "container_memory_working_set_bytes": "cadvisor",
}

# PromQL functions and keywords, which are identifiers to a regex but are not
# series. Spellings only -- this is not a parser and does not pretend to be.
NOT_SERIES = {
    # aggregations
    "sum", "min", "max", "avg", "group", "stddev", "stdvar", "count", "count_values",
    "bottomk", "topk", "quantile",
    # functions used here
    "abs", "absent", "absent_over_time", "ceil", "changes", "clamp", "clamp_max",
    "clamp_min", "day_of_month", "day_of_week", "days_in_month", "delta", "deriv",
    "exp", "floor", "histogram_quantile", "holt_winters", "hour", "idelta",
    "increase", "irate", "label_join", "label_replace", "ln", "log2", "log10",
    "minute", "month", "predict_linear", "rate", "resets", "round", "scalar",
    "sort", "sort_desc", "sqrt", "time", "timestamp", "vector", "year",
    "avg_over_time", "max_over_time", "min_over_time", "sum_over_time",
    "count_over_time", "last_over_time", "present_over_time", "quantile_over_time",
    "stddev_over_time", "stdvar_over_time",
    # keywords and modifiers
    "and", "or", "unless", "bool", "offset", "by", "without", "on", "ignoring",
    "group_left", "group_right", "inf", "nan", "true", "false",
}

IDENT = re.compile(r"[a-zA-Z_:][a-zA-Z0-9_:]*")
STRING = re.compile(r'"(?:[^"\\]|\\.)*"')
# Selector label sets and grouping clauses contain label names, not series.
LABEL_SET = re.compile(r"\{[^}]*\}")
GROUPING = re.compile(r"\b(?:by|without|on|ignoring)\s*\([^)]*\)")
# Range selectors and subqueries: `[10m]` and `[5m:1m]` are durations, and their
# unit letters (`m`, `h`, `s`) would otherwise be read as metric names.
RANGE = re.compile(r"\[[^\]]*\]")


def series_in(expr: str) -> set[str]:
    """Every identifier in an expression that is not a function, keyword or label."""
    cleaned = STRING.sub('""', expr)
    cleaned = LABEL_SET.sub("{}", cleaned)
    cleaned = GROUPING.sub("()", cleaned)
    cleaned = RANGE.sub("[]", cleaned)

    found = set()
    for name in IDENT.findall(cleaned):
        if name in NOT_SERIES or name in OWNERS:
            if name in OWNERS:
                found.add(name)
            continue
        found.add(name)
    return found


def check_rules(failures: list[str]) -> int:
    import yaml  # imported here so the error message is about the file, not the import

    path = OPS / "rules" / "voting.yml"
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    groups = document.get("groups") or []

    count = 0
    for group in groups:
        for rule in group.get("rules") or []:
            count += 1
            alert = rule.get("alert", "<unnamed>")

            # A rule with no `for` fires on a single sample, which for anything
            # measured over a network is a blip rather than a condition. The
            # absence is reported rather than assumed.
            if "for" not in rule:
                failures.append(f"{path.name}: {alert} has no `for`")
            if "severity" not in (rule.get("labels") or {}):
                failures.append(f"{path.name}: {alert} has no labels.severity")

            annotations = rule.get("annotations") or {}
            for field in ("summary", "description"):
                if not annotations.get(field):
                    failures.append(f"{path.name}: {alert} has no annotations.{field}")

            unknown = series_in(rule.get("expr", "")) - set(OWNERS)
            for name in sorted(unknown):
                failures.append(f"{path.name}: {alert} uses series with no owner: {name}")

    return count


def check_dashboards(failures: list[str]) -> tuple[int, int]:
    dashboards = 0
    panels = 0
    exprs = 0

    for path in sorted((OPS / ".." / "grafana" / "dashboards").resolve().glob("*.json")):
        dashboards += 1
        document = json.loads(path.read_text(encoding="utf-8"))

        if not document.get("uid"):
            failures.append(f"{path.name}: no uid, so it cannot be provisioned stably")

        for panel in document.get("panels") or []:
            panels += 1
            for target in panel.get("targets") or []:
                expr = target.get("expr")
                if not expr:
                    continue
                exprs += 1
                unknown = series_in(expr) - set(OWNERS)
                for name in sorted(unknown):
                    failures.append(
                        f"{path.name}: panel {panel.get('id')} uses series with no owner: {name}"
                    )

    return dashboards, panels


def check_prometheus_targets(failures: list[str]) -> list[str]:
    """Every static scrape target must name a service that compose defines."""
    import yaml

    prometheus = yaml.safe_load((OPS / "prometheus.yml").read_text(encoding="utf-8"))
    compose_text = (OPS / ".." / ".." / "docker-compose.yml").resolve().read_text(encoding="utf-8")
    compose = yaml.safe_load(compose_text)

    defined = set((compose.get("services") or {}).keys())
    # Prometheus scrapes itself by this name; it is not a compose service.
    exempt = {"localhost"}

    targets: list[str] = []
    for job in prometheus.get("scrape_configs") or []:
        for config in job.get("static_configs") or []:
            for target in config.get("targets") or []:
                host = str(target).split("://")[-1].split(":")[0]
                if host in exempt:
                    continue
                targets.append(host)
                if host not in defined:
                    failures.append(
                        f"prometheus.yml: job {job.get('job_name')} scrapes "
                        f"{host!r}, which is not a service in docker-compose.yml"
                    )
    return sorted(set(targets))


def main() -> int:
    failures: list[str] = []

    rules = check_rules(failures)
    dashboards, panels = check_dashboards(failures)
    targets = check_prometheus_targets(failures)

    print(f"series in the inventory : {len(OWNERS)}")
    print(f"alert rules checked     : {rules}")
    print(f"dashboards checked      : {dashboards} ({panels} panels)")
    print(f"static scrape targets   : {', '.join(targets)}")

    if failures:
        print(f"\n{len(failures)} problem(s):")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nok: every series used has an owner")
    return 0


if __name__ == "__main__":
    sys.exit(main())
