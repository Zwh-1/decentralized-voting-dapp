// SPDX-License-Identifier: MIT
/**
 * Regression tests for the browser client's handling of `/api/results`.
 *
 * The route answers 500 when the chain and the index disagree. The first
 * version of `fetchResults` went through a generic helper that threw on any
 * non-2xx, which discarded a perfectly valid body and made the UI claim the
 * index API was unreachable — the opposite of what had actually happened.
 * These tests pin the behaviour so that cannot come back.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { fetchResults } from "../src/lib/client-api";
import type { ResultsResponse } from "../src/lib/types";

const inconsistentBody: ResultsResponse = {
  consistent: false,
  mode: "dual-source",
  onChainTotal: 200,
  indexedTotal: 199,
  discrepancies: [{ candidateId: 2, onChain: 67, indexed: 66 }],
  onChain: { source: "chain", total: 200, candidates: [] },
  indexed: { source: "index", total: 199, candidates: [] },
};

const consistentBody: ResultsResponse = {
  consistent: true,
  mode: "dual-source",
  onChainTotal: 200,
  indexedTotal: 200,
  discrepancies: [],
  onChain: { source: "chain", total: 200, candidates: [] },
  indexed: { source: "index", total: 200, candidates: [] },
};

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

    const results = await fetchResults();

    assert.equal(results.consistent, true);
    assert.equal(results.indexedTotal, 200);
  });

  it("treats a 500 carrying a results body as data, not as a transport failure", async () => {
    stubFetch(Response.json(inconsistentBody, { status: 500 }));

    const results = await fetchResults();

    // The whole point: the mismatch must survive to the UI, discrepancies and all.
    assert.equal(results.consistent, false);
    assert.equal(results.onChainTotal, 200);
    assert.equal(results.indexedTotal, 199);
    assert.deepEqual(results.discrepancies, [{ candidateId: 2, onChain: 67, indexed: 66 }]);
  });

  it("still throws on a 500 whose body is not a results payload", async () => {
    stubFetch(new Response("<html>gateway blew up</html>", { status: 500 }));

    await assert.rejects(fetchResults, /responded 500/);
  });

  it("throws on a 500 whose JSON lacks the results shape", async () => {
    stubFetch(Response.json({ error: "boom" }, { status: 500 }));

    await assert.rejects(fetchResults, /responded 500/);
  });

  it("throws on other non-2xx statuses", async () => {
    stubFetch(Response.json({}, { status: 503 }));

    await assert.rejects(fetchResults, /responded 503/);
  });
});
