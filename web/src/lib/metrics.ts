// SPDX-License-Identifier: MIT
import type { HealthResponse } from "./types";

/**
 * Turning the `/api/health` payload into Prometheus exposition text.
 *
 * A pure function in `lib/`, not logic inside the route, for the same reason
 * `health-report.ts` and `ballot-reasons.ts` are pure: `web/test/**` cannot
 * import React components, so anything that lives in a component — or in a
 * route handler, which pulls in `next/server` — is untestable here. See
 * ADR-0027. The route does the impure part (reading the health, reading
 * `process`), and this module does the deciding.
 *
 * ---------------------------------------------------------------------------
 * Why the series has to be absent rather than zero
 * ---------------------------------------------------------------------------
 *
 * `lagBlocks: null` means "this deployment cannot answer how far behind the
 * index is" — the chain was unreadable, no index is configured, or the index
 * exists but its cursor could not be read. Rendering that as `0` would claim a
 * perfectly caught-up indexer, which is the most reassuring possible reading of
 * the worst possible state. So the series is omitted entirely, and a separate
 * `absent()` rule watches for its disappearance. That is ADR-0015, and it is
 * the whole reason this file is more than a `for` loop.
 *
 * The same applies to an unparseable figure: `/api/health` carries block
 * heights and the lag as strings, so a value that is not an integer is dropped
 * rather than coerced. Dropping produces the absent series, which alerts;
 * coercing would produce either a wrong number or a silent `0`.
 *
 * ---------------------------------------------------------------------------
 * Why the sample line is built in one place
 * ---------------------------------------------------------------------------
 *
 * Every sample line is `name` + optional labels + value, and the name is
 * supplied once by the family that emits it. The first version of this file
 * passed bare values to a helper that expected whole sample lines, so every
 * series except the one with labels went out as a lone number — text Prometheus
 * rejects, from an endpoint whose entire job is to be machine-readable. Names
 * are therefore never repeated at a call site.
 *
 * ---------------------------------------------------------------------------
 * Why the help text is English
 * ---------------------------------------------------------------------------
 *
 * Everything else this repository renders is routed through the locale
 * catalogue, because a reader sees it. This text is read by Prometheus and by
 * Grafana tooltips, so it follows the exposition format's own convention rather
 * than the UI's language. It is not user-facing copy and must not be pulled
 * into the translation surface.
 */

/** The exposition format Prometheus scrapes; version 0.0.4 is the classic text format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface MetricsInput {
  health: HealthResponse;
  /**
   * How many times this process has seen the index error go from absent to
   * present. Held by the caller because it is per-process state, not a reading.
   */
  indexErrorsTotal: number;
  process: {
    residentMemoryBytes: number;
    uptimeSeconds: number;
  };
}

type MetricType = "gauge" | "counter";
type SampleValue = string | number;

/**
 * Escapes a label value for the exposition format.
 *
 * Exported and tested directly because it is a correctness property of the
 * format rather than an internal detail: an unescaped quote or newline in a
 * label value produces a payload Prometheus rejects, which turns a working
 * deployment into a blind one.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Reads a block height or a lag out of the payload.
 *
 * `/api/health` types both as strings. Anything that is not a non-negative safe
 * integer is reported as unanswerable, so the caller omits the series instead
 * of exporting a number nobody measured.
 */
function integer(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The label set for a single-sample family, or an empty string when unlabelled. */
function labels(pairs: Record<string, string>): string {
  const rendered = Object.entries(pairs).map(
    ([key, value]) => `${key}="${escapeLabelValue(value)}"`,
  );

  return rendered.length === 0 ? "" : `{${rendered.join(",")}}`;
}

/**
 * Renders one metric family, or nothing at all when it has no samples.
 *
 * Omitting the `# HELP` / `# TYPE` lines alongside the samples keeps the output
 * honest about what was measured: a family with no samples must leave no trace,
 * since `absent()` matches on the series and a comment cannot create one.
 */
function family(
  name: string,
  help: string,
  type: MetricType,
  values: SampleValue[],
  labelSet = "",
): string[] {
  if (values.length === 0) {
    return [];
  }

  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    ...values.map((value) => `${name}${labelSet} ${value}`),
  ];
}

/**
 * Serialises a health reading as one Prometheus scrape payload.
 *
 * Series whose source is unreadable are omitted rather than zeroed; see the
 * note at the top of this file. Nothing here reproduces a configuration value,
 * so the payload stays safe to expose on an internal network: the contract
 * address and the RPC endpoint are deliberately not exported.
 */
export function renderMetrics(input: MetricsInput): string {
  const { health } = input;

  const chainHead = integer(health.chainHead);
  const lastIndexed = integer(health.lastIndexedBlock);
  const lag = integer(health.lagBlocks);

  const lines: string[] = [
    ...family(
      "voting_chain_info",
      "The chain this process reads polls from. Constant 1; the chain id is the information.",
      "gauge",
      [1],
      labels({ chain_id: String(health.chainId) }),
    ),
    ...family(
      "voting_chain_head_block",
      "Latest block the RPC endpoint reported. Absent when the chain could not be read.",
      "gauge",
      chainHead === null ? [] : [chainHead],
    ),
    ...family(
      "voting_index_last_block",
      "Highest block written to the index. Absent when no cursor could be read.",
      "gauge",
      lastIndexed === null ? [] : [lastIndexed],
    ),
    ...family(
      "voting_index_lag_blocks",
      "Safe blocks not yet indexed. Absent when the deployment cannot answer, which is not the same as being caught up.",
      "gauge",
      lag === null ? [] : [lag],
    ),
    ...family(
      "voting_index_configured",
      "1 when an index is expected at all, i.e. DATABASE_URL was set.",
      "gauge",
      [health.indexConfigured ? 1 : 0],
    ),
    ...family(
      "voting_indexer_loop_enabled",
      "1 when a background loop will advance the index on its own. 0 does not mean the index is broken, only that something else must drive it.",
      "gauge",
      [health.indexerLoopEnabled ? 1 : 0],
    ),
    ...family(
      "voting_poll_count",
      "Polls the factory has created. Absent when the chain could not be read.",
      "gauge",
      health.pollCount === null ? [] : [health.pollCount],
    ),
    ...family(
      "voting_index_errors_total",
      "Transitions into an index error observed by this process since it started. A single-process approximation that resets on restart, so it is for rate(), not for a lifetime total.",
      "counter",
      [input.indexErrorsTotal],
    ),
    ...family(
      "voting_process_resident_memory_bytes",
      "Resident memory of this server process.",
      "gauge",
      [input.process.residentMemoryBytes],
    ),
    ...family(
      "voting_process_uptime_seconds",
      "Seconds since this server process started.",
      "gauge",
      [input.process.uptimeSeconds],
    ),
  ];

  return `${lines.join("\n")}\n`;
}

/**
 * Counts transitions into an index error, for `voting_index_errors_total`.
 *
 * A counter cannot be derived from a snapshot, so the comparison with the
 * previous reading has to live somewhere. It is a closure rather than module
 * state so that a test can drive the sequence without reaching into globals.
 *
 * Only the transition counts, not every scrape: an error that stays reported
 * for an hour is one incident, and `increase()` over a counter that kept
 * climbing while nothing changed would be meaningless.
 */
export function createIndexErrorCounter(): (current: string | null) => number {
  let total = 0;
  let previous: string | null = null;

  return function observe(current: string | null): number {
    if (current !== null && current !== previous) {
      total += 1;
    }

    previous = current;

    return total;
  };
}
