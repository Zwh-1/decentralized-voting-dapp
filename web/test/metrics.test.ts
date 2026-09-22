// SPDX-License-Identifier: MIT
/**
 * The metrics payload's decisions, tested without a server.
 *
 * The interesting cases are not the numbers, they are the absences. Every other
 * surface in this project renders a missing reading as a word a reader can
 * interpret ("不适用", "unavailable"); a metrics payload has no such word, and
 * the tempting substitute is `0` — which for `voting_index_lag_blocks` means
 * "perfectly caught up" and would be the most reassuring possible rendering of
 * an index that cannot be read at all. So these tests pin two things at once:
 * that a real zero is exported, and that an unanswerable reading exports
 * nothing. The second assertion is the one that fails if anybody ever
 * "simplifies" the null branch into a zero.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIndexErrorCounter, escapeLabelValue, renderMetrics } from "../src/lib/metrics";
import type { HealthResponse } from "../src/lib/types";

const FACTORY = "0xc6c080938113b7b069d9ba64a2d9c062399a22b2";

/** A healthy deployment, with each test overriding only the field it is about. */
function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "ok",
    chainId: 11155111,
    contract: FACTORY,
    pollCount: 3,
    confirmations: 5,
    indexConfigured: true,
    indexerLoopEnabled: true,
    lastIndexedBlock: "11754500",
    chainHead: "11754505",
    lagBlocks: "5",
    indexError: null,
    ...overrides,
  };
}

function render(overrides: Partial<HealthResponse> = {}, indexErrorsTotal = 0): string {
  return renderMetrics({
    health: health(overrides),
    indexErrorsTotal,
    process: { residentMemoryBytes: 123456789, uptimeSeconds: 42 },
  });
}

/** Only the sample lines: a comment describes a series but does not create one. */
function samples(body: string): string[] {
  return body.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
}

function sampleFor(body: string, name: string): string | undefined {
  return samples(body).find((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`));
}

describe("renderMetrics", () => {
  it("emits a sample line for every series it claims to emit", () => {
    const body = render();

    for (const name of [
      "voting_chain_info",
      "voting_chain_head_block",
      "voting_index_last_block",
      "voting_index_lag_blocks",
      "voting_index_configured",
      "voting_indexer_loop_enabled",
      "voting_poll_count",
      "voting_index_errors_total",
      "voting_process_resident_memory_bytes",
      "voting_process_uptime_seconds",
    ]) {
      assert.ok(sampleFor(body, name) !== undefined, `expected a sample for ${name}`);
    }
  });

  it("describes each family before its samples", () => {
    const lines = render().split("\n");

    for (const [name, type] of [
      ["voting_index_lag_blocks", "gauge"],
      ["voting_index_errors_total", "counter"],
    ]) {
      const help = lines.findIndex((line) => line.startsWith(`# HELP ${name} `));

      assert.ok(help >= 0, `expected help for ${name}`);
      assert.equal(
        lines[help + 1],
        `# TYPE ${name} ${type}`,
        `expected a type line after the help for ${name}`,
      );
    }
  });

  it("ends with exactly one newline", () => {
    // Prometheus tolerates a trailing newline; omitting it makes the last sample
    // easy to lose to tooling that reads line by line.
    const body = render();

    assert.ok(body.endsWith("\n"));
    assert.ok(!body.endsWith("\n\n"));
  });

  it("emits only lines the exposition format accepts", () => {
    const line =
      /^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]*( \S+)*$|^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?([eE][+-]?\d+)?$/;

    for (const raw of render().split("\n")) {
      if (raw === "") {
        continue;
      }

      assert.match(raw, line, `not exposition-format text: ${raw}`);
    }
  });

  it("reports the lag it was given", () => {
    assert.equal(
      sampleFor(render({ lagBlocks: "37" }), "voting_index_lag_blocks"),
      "voting_index_lag_blocks 37",
    );
  });

  it("exports a caught-up index as zero", () => {
    // The distinction that matters: this IS a number a deployment measured.
    assert.equal(
      sampleFor(render({ lagBlocks: "0" }), "voting_index_lag_blocks"),
      "voting_index_lag_blocks 0",
    );
  });

  it("omits the lag series entirely when the deployment cannot answer", () => {
    // ADR-0015. Zero here would claim a perfectly caught-up indexer; the absent
    // series is what the separately-configured `absent()` rule watches for.
    const body = render({ lagBlocks: null });

    assert.ok(
      !body.includes("voting_index_lag_blocks"),
      "the series, its help and its type must all be gone",
    );
    assert.ok(body.includes("voting_index_configured"), "the rest of the payload still renders");
  });

  it("omits the lag series when the figure is not an integer", () => {
    for (const lagBlocks of ["", "  ", "n/a", "5 blocks", "-1", "1e3", "1.5"]) {
      const body = render({ lagBlocks });

      assert.ok(
        !body.includes("voting_index_lag_blocks"),
        `expected no lag series for ${JSON.stringify(lagBlocks)}`,
      );
    }
  });

  it("accepts a height with surrounding whitespace", () => {
    assert.equal(
      sampleFor(render({ lagBlocks: " 12 " }), "voting_index_lag_blocks"),
      "voting_index_lag_blocks 12",
    );
  });

  it("omits the chain head and the last indexed block when they are unreadable", () => {
    const body = render({ chainHead: null, lastIndexedBlock: null });

    assert.ok(!body.includes("voting_chain_head_block"));
    assert.ok(!body.includes("voting_index_last_block"));
  });

  it("omits the poll count when the chain was unreadable", () => {
    const body = render({ pollCount: null });

    assert.ok(!body.includes("voting_poll_count"));
    assert.equal(sampleFor(render({ pollCount: 0 }), "voting_poll_count"), "voting_poll_count 0");
  });

  it("reports the two flags as one and zero", () => {
    const off = render({ indexConfigured: false, indexerLoopEnabled: false });
    const on = render({ indexConfigured: true, indexerLoopEnabled: true });

    assert.equal(sampleFor(off, "voting_index_configured"), "voting_index_configured 0");
    assert.equal(sampleFor(off, "voting_indexer_loop_enabled"), "voting_indexer_loop_enabled 0");
    assert.equal(sampleFor(on, "voting_index_configured"), "voting_index_configured 1");
    assert.equal(sampleFor(on, "voting_indexer_loop_enabled"), "voting_indexer_loop_enabled 1");
  });

  it("never exports the contract address", () => {
    // A configuration value, and the payload is served on a network the scrape
    // shares with the app. Nothing here may reproduce the deployment's config.
    assert.ok(!render().includes(FACTORY));
  });

  it("reports the chain id as a label rather than as a bare number", () => {
    assert.equal(
      sampleFor(render({ chainId: 31337 }), "voting_chain_info"),
      'voting_chain_info{chain_id="31337"} 1',
    );
  });

  it("reports the error counter it was handed", () => {
    // The payload reports; it does not count. Counting is a process concern, so
    // the route owns it and this function stays reproducible from its input.
    assert.equal(
      sampleFor(render({}, 7), "voting_index_errors_total"),
      "voting_index_errors_total 7",
    );
    assert.equal(sampleFor(render(), "voting_index_errors_total"), "voting_index_errors_total 0");
  });

  it("exports process memory and uptime", () => {
    const body = render();

    assert.equal(
      sampleFor(body, "voting_process_resident_memory_bytes"),
      "voting_process_resident_memory_bytes 123456789",
    );
    assert.equal(
      sampleFor(body, "voting_process_uptime_seconds"),
      "voting_process_uptime_seconds 42",
    );
  });
});

describe("escapeLabelValue", () => {
  it("leaves an ordinary value alone", () => {
    assert.equal(escapeLabelValue("11155111"), "11155111");
  });

  it("escapes the backslash first, so it does not double-escape", () => {
    assert.equal(escapeLabelValue("a\\b"), "a\\\\b");
  });

  it("escapes a quote", () => {
    assert.equal(escapeLabelValue('a"b'), 'a\\"b');
  });

  it("escapes a newline, which would otherwise split the sample in two", () => {
    assert.equal(escapeLabelValue("a\nb"), "a\\nb");
  });
});

describe("createIndexErrorCounter", () => {
  it("stays at zero while there is no error", () => {
    const observe = createIndexErrorCounter();

    assert.equal(observe(null), 0);
    assert.equal(observe(null), 0);
  });

  it("counts the transition into an error, not every scrape", () => {
    const observe = createIndexErrorCounter();

    assert.equal(observe("database unreachable"), 1);
    assert.equal(observe("database unreachable"), 1);
    assert.equal(observe("database unreachable"), 1);
  });

  it("counts a second, different error", () => {
    const observe = createIndexErrorCounter();

    observe("database unreachable");
    assert.equal(observe("cursor unreadable"), 2);
  });

  it("counts a recurrence after recovery", () => {
    const observe = createIndexErrorCounter();

    observe("database unreachable");
    observe(null);
    assert.equal(observe("database unreachable"), 2);
  });
});
