// SPDX-License-Identifier: MIT
/**
 * Tests for the comparison itself and for what its result means.
 *
 * The distinction under test is the one the first version of this project got
 * wrong. An index that trails the chain inside the confirmation window is
 * *supposed* to hold fewer votes than the chain's current tally, so a direct
 * comparison reports a mismatch on correct behaviour. These tests pin the fix:
 * the votes in the unindexed range are added back before comparing, and only a
 * disagreement that survives that is a fault.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyConsistency, compareTally } from "../src/lib/report";
import type { ApiOption, TallyResponse } from "../src/lib/types";

function tally(source: "chain" | "index", counts: number[]): TallyResponse {
  const options: ApiOption[] = counts.map((voteCount, offset) => ({
    id: offset + 1,
    labelCid: `bafy${offset}`,
    voteCount,
  }));

  return { source, total: counts.reduce((sum, n) => sum + n, 0), options };
}

describe("compareTally", () => {
  it("reports agreement when every option and the total match", () => {
    const report = compareTally(tally("chain", [67, 67, 66]), tally("index", [67, 67, 66]));

    assert.equal(report.consistent, true);
    assert.deepEqual(report.discrepancies, []);
  });

  it("names the option that differs, with both numbers", () => {
    const report = compareTally(tally("chain", [67, 67, 66]), tally("index", [67, 66, 66]));

    assert.equal(report.consistent, false);
    assert.deepEqual(report.discrepancies, [{ optionId: 2, onChain: 67, indexed: 66, pending: 0 }]);
  });

  it("accepts a shortfall that the unindexed range fully explains", () => {
    // The index is 3 votes behind because 3 votes sit inside the confirmation
    // window. That is the indexer working as designed, not a fault.
    const pending = new Map([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);

    const report = compareTally(
      tally("chain", [67, 67, 66]),
      tally("index", [66, 66, 65]),
      pending,
    );

    assert.equal(report.consistent, true);
    assert.deepEqual(report.discrepancies, []);
  });

  it("still fails when the unindexed range does not explain the whole shortfall", () => {
    // Two votes are pending, but the index is three behind: one vote is missing
    // for reasons the confirmation window cannot account for.
    const pending = new Map([
      [1, 1],
      [2, 1],
    ]);

    const report = compareTally(
      tally("chain", [67, 67, 66]),
      tally("index", [66, 66, 65]),
      pending,
    );

    assert.equal(report.consistent, false);
    assert.deepEqual(report.discrepancies, [{ optionId: 3, onChain: 66, indexed: 65, pending: 0 }]);
  });

  it("reports an option the index is missing entirely", () => {
    const report = compareTally(tally("chain", [67, 67]), tally("index", [67]));

    assert.equal(report.consistent, false);
    assert.deepEqual(report.discrepancies, [
      { optionId: 2, onChain: 67, indexed: null, pending: 0 },
    ]);
  });

  it("reports an option the index invented", () => {
    const report = compareTally(tally("chain", [67]), tally("index", [67, 5]));

    assert.equal(report.consistent, false);
    assert.deepEqual(report.discrepancies, [
      { optionId: 2, onChain: null, indexed: 5, pending: 0 },
    ]);
  });

  it("does not accept matching per-option counts with a mismatched total", () => {
    const onChain = tally("chain", [67, 67]);
    const indexed = { ...tally("index", [67, 67]), total: 999 };

    assert.equal(compareTally(onChain, indexed).consistent, false);
  });
});

describe("classifyConsistency", () => {
  const agree = compareTally(tally("chain", [67, 67, 66]), tally("index", [67, 67, 66]));
  const differ = compareTally(tally("chain", [67, 67, 66]), tally("index", [67, 66, 66]));

  it("is consistent when the numbers match", () => {
    assert.equal(classifyConsistency(agree, true), "consistent");
    assert.equal(classifyConsistency(agree, false), "consistent");
  });

  it("is divergent when a disagreement survives reconciliation", () => {
    assert.equal(classifyConsistency(differ, true), "divergent");
  });

  it("is lagging — not divergent — when the gap was too large to reconcile", () => {
    // Nothing may be called a fault that could equally be ordinary lag.
    assert.equal(classifyConsistency(differ, false), "lagging");
  });
});
