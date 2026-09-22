// SPDX-License-Identifier: MIT
/**
 * Tests for the IPFS gateway fallback.
 *
 * `ipfs.ts` exists because public gateways rate limit, and its whole contract is
 * what happens when one of them does not answer. Nothing exercised that contract:
 * the unit suite had no test file for it, and the seeded ballot stores
 * `bafyseededcandidate0`, which `isPlausibleCid` rejects before any request is
 * made — so the fallback loop, the timeout and the "unreachable" result had never
 * run even once, in a test or against a real gateway.
 *
 * `fetch` is stubbed here rather than mocked through a library: the module calls
 * the global directly, so replacing it is the whole seam.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  fetchCandidateMetadata,
  gatewaysFor,
  isPlausibleCid,
  isRetryableMetadata,
  metadataStaleTime,
  type MetadataResult,
} from "../src/lib/ipfs";

/** A syntactically valid CIDv0: `Qm` plus 44 base58 characters. */
const CID_V0 = `Qm${"a".repeat(44)}`;
/** A valid CIDv1 in base32, dag-pb codec. */
const CID_V1_DAG_PB = `bafy${"a".repeat(55)}`;
/** A valid CIDv1 in base32, raw codec — the form the old check rejected. */
const CID_V1_RAW = `bafk${"a".repeat(55)}`;

const realFetch = globalThis.fetch;
const calls: string[] = [];

/**
 * Installs a fetch that answers per host with the given script.
 *
 * The handler receives the URL and returns either a Response-like object or
 * throws, which is how a network failure or a timeout surfaces to the module.
 */
function stubFetch(handler: (url: string) => { ok: boolean; json?: () => Promise<unknown> }): void {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    return handler(url) as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("isPlausibleCid", () => {
  it("accepts both CIDv0 and CIDv1 in base32", () => {
    assert.equal(isPlausibleCid(CID_V0), true);
    assert.equal(isPlausibleCid(CID_V1_DAG_PB), true);
  });

  it("accepts a raw-codec CIDv1, which does not start with bafy", () => {
    assert.equal(
      isPlausibleCid(CID_V1_RAW),
      true,
      "a valid CID must not be reported to the reader as a malformed one",
    );
  });

  it("rejects what cannot resolve, so no gateway is asked", () => {
    for (const bad of [
      "",
      "bafyseededcandidate0",
      "Qm",
      `Qm${"a".repeat(43)}`,
      `bafy${"a".repeat(54)}`,
      `bafy${"A".repeat(55)}`,
      `bafy${"a".repeat(54)}0`,
      "ipfs://bafy",
    ]) {
      assert.equal(isPlausibleCid(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

/**
 * Which gateways get asked, and in what order.
 *
 * `NEXT_PUBLIC_IPFS_GATEWAY` is the documented way to name a dedicated gateway,
 * and the natural value is one that is already in the defaults: this project
 * pins its metadata to Pinata, so the dedicated gateway *is* the third default.
 * Appending the defaults after it would ask that host first and again last.
 */
describe("gatewaysFor", () => {
  it("uses the public defaults when nothing is configured", () => {
    assert.deepEqual(gatewaysFor(undefined), [
      "https://dweb.link/ipfs/",
      "https://ipfs.io/ipfs/",
      "https://gateway.pinata.cloud/ipfs/",
    ]);
  });

  it("reads a blank value as not configured", () => {
    // `NEXT_PUBLIC_IPFS_GATEWAY=` in a `.env` file is a line someone believes is
    // inert. Reading it as an instruction would fetch `/ipfs/<cid>` against the
    // app's own origin and report the 404 as a gateway failure.
    for (const blank of ["", "   "]) {
      assert.equal(gatewaysFor(blank).length, 3);
      assert.equal(gatewaysFor(blank)[0], "https://dweb.link/ipfs/");
    }
  });

  it("asks the configured gateway first", () => {
    const gateways = gatewaysFor("https://my-gateway.example/ipfs/");

    assert.equal(gateways[0], "https://my-gateway.example/ipfs/");
    assert.equal(gateways.length, 4, "the three defaults still get their turn");
  });

  it("does not ask the same host twice when it is also a default", () => {
    const gateways = gatewaysFor("https://gateway.pinata.cloud/ipfs/");

    assert.equal(gateways[0], "https://gateway.pinata.cloud/ipfs/");
    assert.equal(gateways.length, 3, "the defaults must not repeat the configured one");
    assert.equal(new Set(gateways).size, gateways.length);
  });
});

describe("fetchCandidateMetadata", () => {
  it("does not touch a gateway when the CID cannot be valid", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ name: "unused" }) }));

    const result = await fetchCandidateMetadata("bafyseededcandidate0");

    assert.deepEqual(result, { status: "invalid-cid" });
    assert.deepEqual(calls, [], "three guaranteed 4xx requests must not be spent on this");
  });

  it("falls back to the next gateway when one fails", async () => {
    stubFetch((url) =>
      url.startsWith("https://dweb.link/")
        ? { ok: false }
        : { ok: true, json: async () => ({ name: "Alice", slogan: "for change" }) },
    );

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, { status: "ok", metadata: { name: "Alice", slogan: "for change" } });
    assert.equal(calls.length, 2, "the first gateway failed, so exactly one fallback was needed");
    assert.match(calls[0]!, /^https:\/\/dweb\.link\/ipfs\//);
    assert.match(calls[1]!, /^https:\/\/ipfs\.io\/ipfs\//);
  });

  it("reaches the last gateway when the first two are rate limited", async () => {
    stubFetch((url) =>
      url.startsWith("https://gateway.pinata.cloud/")
        ? { ok: true, json: async () => ({ name: "Bob" }) }
        : { ok: false, json: async () => ({ error: "rate limited" }) },
    );

    const result = await fetchCandidateMetadata(CID_V0);

    assert.deepEqual(result, { status: "ok", metadata: { name: "Bob" } });
    assert.equal(calls.length, 3);
    assert.match(calls[2]!, /^https:\/\/gateway\.pinata\.cloud\/ipfs\//);
  });

  it("treats a network error like a missing gateway", async () => {
    stubFetch((url) => {
      if (url.startsWith("https://dweb.link/")) {
        throw new Error("getaddrinfo ENOTFOUND");
      }

      return { ok: true, json: async () => ({ name: "Carol" }) };
    });

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, { status: "ok", metadata: { name: "Carol" } });
  });

  it("skips a gateway that answers 200 with something that is not metadata", async () => {
    stubFetch((url) => {
      if (url.startsWith("https://dweb.link/")) {
        return { ok: true, json: async () => ({ notAName: true }) };
      }

      if (url.startsWith("https://ipfs.io/")) {
        return { ok: true, json: async () => ({ name: "" }) };
      }

      return { ok: true, json: async () => ({ name: "Dave" }) };
    });

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, { status: "ok", metadata: { name: "Dave" } });
    assert.equal(calls.length, 3);
  });

  it("returns the shape the UI renders when no gateway answers at all", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, { status: "unreachable", attempts: 3 });
    assert.equal(calls.length, 3, "every gateway gets one attempt");
  });

  it("does not call a reachable gateway unreachable", async () => {
    // The case a live run exposed: two gateways were dead, the third answered
    // 200 with plain text. Reporting that as "3 gateways unreachable" was false
    // about a gateway that had just replied.
    stubFetch((url) =>
      url.startsWith("https://gateway.pinata.cloud/")
        ? { ok: true, json: async () => Promise.reject(new Error("not json")) }
        : { ok: false },
    );

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, { status: "no-metadata", attempts: 3, answered: 3 });
  });

  it("counts only the gateways that actually answered", async () => {
    stubFetch((url) => {
      if (url.startsWith("https://dweb.link/")) {
        throw new Error("ETIMEDOUT");
      }

      return { ok: false, json: async () => ({}) };
    });

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, { status: "no-metadata", attempts: 3, answered: 2 });
  });

  it("reports a 200 that is not metadata as reached-but-unusable, not unreachable", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ notAName: true }) }));

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.equal(result.status, "no-metadata");
  });

  it("keeps only the documented fields", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({ name: "Eve", slogan: "s", description: "d", extra: "dropped", id: 7 }),
    }));

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, {
      status: "ok",
      metadata: { name: "Eve", slogan: "s", description: "d" },
    });
  });

  it("drops optional fields that are present but not strings", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ name: "Frank", slogan: 42 }) }));

    const result = await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.deepEqual(result, { status: "ok", metadata: { name: "Frank" } });
  });

  it("passes an abort signal so a hung gateway cannot hang the ballot", async () => {
    let sawSignal = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;

      return { ok: true, json: async () => ({ name: "Gina" }) } as unknown as Response;
    }) as typeof fetch;

    await fetchCandidateMetadata(CID_V1_DAG_PB);

    assert.equal(sawSignal, true, "without a signal a stalled gateway would block forever");
  });
});

/**
 * Caching and retry are decided per result, not per query.
 *
 * The query function resolves its failures instead of rejecting them, so TanStack
 * Query sees every outcome as successful data. With a single `staleTime` the
 * argument "metadata is content addressed, so a successful result can never
 * change" was therefore applied to failures too, and one throttled gateway pinned
 * its answer for the session. These tests pin the split.
 */
describe("metadataStaleTime", () => {
  it("keeps a resolved answer indefinitely", () => {
    assert.equal(
      metadataStaleTime({ status: "ok", metadata: { name: "Ada" } }),
      Number.POSITIVE_INFINITY,
    );
  });

  it("keeps a verdict this code reached locally, because asking again cannot change it", () => {
    assert.equal(metadataStaleTime({ status: "invalid-cid" }), Number.POSITIVE_INFINITY);
  });

  it("expires a failure the network caused", () => {
    const unreachable = metadataStaleTime({ status: "unreachable", attempts: 3 });
    const noMetadata = metadataStaleTime({ status: "no-metadata", attempts: 3, answered: 1 });

    assert.equal(unreachable, noMetadata);
    assert.equal(Number.isFinite(unreachable), true, "a transient failure must not be permanent");
    assert.equal(unreachable > 0, true, "and must not be refetched on every render");
  });

  it("has nothing to reuse before the first result", () => {
    assert.equal(metadataStaleTime(undefined), 0);
  });
});

describe("isRetryableMetadata", () => {
  it("offers a retry only where another attempt could differ", () => {
    assert.equal(isRetryableMetadata({ status: "ok", metadata: { name: "Ada" } }), false);
    assert.equal(isRetryableMetadata({ status: "invalid-cid" }), false);
    assert.equal(isRetryableMetadata({ status: "unreachable", attempts: 1 }), true);
    assert.equal(isRetryableMetadata({ status: "no-metadata", attempts: 1, answered: 1 }), true);
    assert.equal(isRetryableMetadata(undefined), false);
  });

  it("agrees with metadataStaleTime about which failures are transient", () => {
    // The two are read in different places — one by the query cache, one by the
    // card that renders the button — so a drift between them would show as a
    // retry button on a card whose answer is cached forever.
    const results: MetadataResult[] = [
      { status: "ok", metadata: { name: "Ada" } },
      { status: "invalid-cid" },
      { status: "unreachable", attempts: 2 },
      { status: "no-metadata", attempts: 2, answered: 2 },
    ];

    for (const result of results) {
      const cachedForever = metadataStaleTime(result) === Number.POSITIVE_INFINITY;

      assert.equal(
        isRetryableMetadata(result),
        !cachedForever && !(metadataStaleTime(result) === 0),
        `disagreement for ${result.status}`,
      );
    }
  });
});
