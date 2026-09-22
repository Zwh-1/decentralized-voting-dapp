// SPDX-License-Identifier: MIT
/**
 * Regression tests for the browser client's handling of `/api/polls/[address]/results`.
 *
 * The route answers 500 when the chain and the index genuinely disagree. The
 * first version of `fetchResults` went through a generic helper that threw on
 * any non-2xx, which discarded a perfectly valid body and made the UI claim the
 * index API was unreachable — the opposite of what had actually happened.
 * These tests pin the behaviour so that cannot come back.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { fetchResults } from "../src/lib/client-api";
import type { ResultsResponse } from "../src/lib/types";

const divergentBody: ResultsResponse = {
  status: "divergent",
  onChainTotal: 200,
  indexedTotal: 199,
  discrepancies: [{ optionId: 2, onChain: 67, indexed: 66, pending: 0 }],
  pendingVotes: 0,
  unindexedBlocks: 0,
  onChain: { source: "chain", total: 200, options: [] },
  indexed: { source: "index", total: 199, options: [] },
  lastIndexedBlock: "406",
};

const consistentBody: ResultsResponse = {
  status: "consistent",
  onChainTotal: 200,
  indexedTotal: 197,
  discrepancies: [],
  pendingVotes: 3,
  unindexedBlocks: 5,
  onChain: { source: "chain", total: 200, options: [] },
  indexed: { source: "index", total: 197, options: [] },
  lastIndexedBlock: "401",
};

const laggingBody: ResultsResponse = {
  status: "lagging",
  onChainTotal: 200,
  indexedTotal: 197,
  discrepancies: [],
  pendingVotes: 0,
  unindexedBlocks: 9000,
  onChain: { source: "chain", total: 200, options: [] },
  indexed: { source: "index", total: 197, options: [] },
  lastIndexedBlock: "401",
};

const POLL = "0x1111111111111111111111111111111111111111" as const;

const realFetch = globalThis.fetch;

function stubFetch(response: Response): void {
  globalThis.fetch = (() => Promise.resolve(response)) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchResults", () => {
  it("returns the body of a 200", async () => {
    stubFetch(Response.json(consistentBody));

    const results = await fetchResults(POLL);

    assert.equal(results.status, "consistent");
    assert.equal(results.indexedTotal, 197);
  });

  it("treats a 500 carrying a results body as data, not as a transport failure", async () => {
    stubFetch(Response.json(divergentBody, { status: 500 }));

    const results = await fetchResults(POLL);

    // The whole point: the mismatch must survive to the UI, discrepancies and all.
    assert.equal(results.status, "divergent");
    assert.equal(results.onChainTotal, 200);
    assert.equal(results.indexedTotal, 199);
    assert.deepEqual(results.discrepancies, [
      { optionId: 2, onChain: 67, indexed: 66, pending: 0 },
    ]);
  });

  it("carries a lagging verdict through a 200 untouched", async () => {
    stubFetch(Response.json(laggingBody));

    const results = await fetchResults(POLL);

    // Lag is not a failure, and it must not be silently rendered as agreement.
    assert.equal(results.status, "lagging");
    assert.equal(results.unindexedBlocks, 9000);
  });

  it("carries a reconciled lag through as agreement, with the pending count intact", async () => {
    stubFetch(Response.json(consistentBody));

    const results = await fetchResults(POLL);

    assert.equal(results.status, "consistent");
    assert.equal(results.pendingVotes, 3);
  });

  it("still throws on a 500 whose body is not a results payload", async () => {
    stubFetch(new Response("<html>gateway blew up</html>", { status: 500 }));

    await assert.rejects(() => fetchResults(POLL), /responded 500/);
  });

  it("throws on a 500 whose JSON lacks the results shape", async () => {
    stubFetch(Response.json({ error: "boom" }, { status: 500 }));

    await assert.rejects(() => fetchResults(POLL), /responded 500/);
  });

  it("throws on other non-2xx statuses", async () => {
    stubFetch(Response.json({}, { status: 503 }));

    await assert.rejects(() => fetchResults(POLL), /responded 503/);
  });
});
