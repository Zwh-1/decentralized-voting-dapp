// SPDX-License-Identifier: MIT

/**
 * The 合约状态 panel must tell "we could not read it" apart from "the answer is
 * zero". These tests exist because the panel used to answer the second while
 * meaning the first: with the RPC endpoint unreachable the server-rendered page
 * announced `数据来源 链上直读` and `票数合计 0` / `候选人（0）`, none of which had
 * been established.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tallyLabels } from "../src/components/Ballot";
import { readStatus } from "../src/components/Ballot";

describe("tallyLabels", () => {
  it("never claims a source, a total or a count while the read is in flight", () => {
    const labels = tallyLabels({ isPending: true, isError: false, candidateCount: 0 });

    assert.equal(labels.source, "读取中…");
    assert.equal(labels.total, "—");
    assert.equal(labels.candidates, "—");
  });

  it("reports a failed read as a failure, not as a direct chain read", () => {
    // The exact defect: `source === "index" ? "MySQL 索引" : "链上直读"` sent every
    // non-index case, including a thrown request, to "链上直读".
    const labels = tallyLabels({ isPending: false, isError: true, candidateCount: 0 });

    assert.equal(labels.source, "读取失败");
    assert.notEqual(labels.source, "链上直读");
    assert.equal(labels.total, "—", "a failed read must not render as 0 votes");
    assert.equal(labels.candidates, "—", "a failed read must not render as 0 candidates");
  });

  it("names the index when the index answered, including a real zero", () => {
    const labels = tallyLabels({
      isPending: false,
      isError: false,
      source: "index",
      total: 0,
      candidateCount: 0,
    });

    assert.equal(labels.source, "MySQL 索引");
    assert.equal(labels.total, "0", "a real zero is still a number, unlike an unknown");
    assert.equal(labels.candidates, "0");
  });

  it("names the chain when the chain answered", () => {
    const labels = tallyLabels({
      isPending: false,
      isError: false,
      source: "chain",
      total: 200,
      candidateCount: 3,
    });

    assert.deepEqual(labels, { source: "链上直读", total: "200", candidates: "3" });
  });

  it("treats settled-but-dataless as unknown rather than as zero", () => {
    // Not pending, not errored, but no payload: TanStack can settle a query with
    // no data (e.g. an aborted fetch), and `source` is the field that proves a
    // real answer arrived.
    const labels = tallyLabels({ isPending: false, isError: false, candidateCount: 0 });

    assert.equal(labels.source, "读取中…");
    assert.equal(labels.total, "—");
    assert.equal(labels.candidates, "—");
  });

  it("prefers the error label when a query is both errored and refetching", () => {
    // A failed query that retries reports isPending and isError together; the
    // reader needs to know it failed, not that it is merely loading.
    const labels = tallyLabels({ isPending: true, isError: true, candidateCount: 0 });

    assert.equal(labels.source, "读取失败");
  });
});

describe("readStatus", () => {
  it("treats a successful read of zero as a real answer", () => {
    // `stakeOf` returns 0 for an address that never voted. That is a fact, not an
    // absence, and it is the only case where "you have nothing to reclaim" is true.
    assert.equal(readStatus(true, false), "ready");
    assert.equal(readStatus(true, true), "ready", "data wins over a stale error flag");
  });

  it("separates a failed read from one that is still loading", () => {
    assert.equal(readStatus(false, true), "failed");
    assert.equal(readStatus(false, false), "loading");
  });

  it("never reports a failed read as merely loading", () => {
    // The reason string shown to the user is picked from this value, so conflating
    // these two is what let a failed `stakeOf` become "没有可取回的押金。".
    assert.notEqual(readStatus(false, true), readStatus(false, false));
  });
});
