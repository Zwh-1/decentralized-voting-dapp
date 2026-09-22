// SPDX-License-Identifier: MIT
/**
 * Tests for demoting an endpoint the indexer keeps failing on.
 *
 * The behaviour worth pinning down is not "it rotates" but the three things that
 * make rotation safe and useful:
 *
 *   1. it does not rotate on a single blip, because that would take the indexer
 *      off a healthy primary;
 *   2. it never swallows the error, because `syncOnce` uses that error to abort
 *      the iteration WITHOUT advancing the cursor — a wrapper that returned an
 *      empty result instead would advance the cursor past blocks never read,
 *      which is strictly worse than failing;
 *   3. it rotates round-robin, so a recovered primary is picked up again rather
 *      than abandoned forever.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRotatingChainReader, type ChainEndpoint } from "../src/lib/indexer/endpoints";
import type { ChainReader } from "../src/lib/indexer/sync";

/** A reader that answers with a fixed head, or fails on demand. */
class FakeReader implements ChainReader {
  constructor(
    readonly name: string,
    private readonly behaviour: { fail: boolean },
  ) {}

  head = 100n;
  logCalls = 0;

  async getBlockNumber(): Promise<bigint> {
    if (this.behaviour.fail) throw new Error(`${this.name} is down`);

    return this.head;
  }

  async getLogs(): Promise<readonly []> {
    this.logCalls += 1;

    if (this.behaviour.fail) throw new Error(`${this.name} is down`);

    return [];
  }
}

/** Three endpoints whose failures are toggled per test. */
function build(threshold: number, names = ["one", "two", "three"]) {
  const behaviour = names.map((): { fail: boolean } => ({ fail: false }));

  /**
   * The behaviour record for one endpoint.
   *
   * `noUncheckedIndexedAccess` types every lookup as possibly undefined, and the
   * tests below index by position constantly. Rather than asserting at each site,
   * this helper does it once and fails loudly if a test asks for an endpoint it
   * did not declare — which would otherwise throw a confusing "cannot read
   * `fail` of undefined" from inside a test helper.
   */
  function at(position: number): { fail: boolean } {
    const record = behaviour[position];
    assert.ok(record, `no behaviour record for endpoint ${position}`);

    return record;
  }

  const readers = names.map((name, index) => new FakeReader(name, at(index)));

  /** The fake reader at one position, with the same loud failure as `at`. */
  function readerAt(position: number): FakeReader {
    const reader = readers[position];
    assert.ok(reader, `no reader for endpoint ${position}`);

    return reader;
  }

  const rotations: { from: string; to: string }[] = [];

  const endpoints: ChainEndpoint[] = names.map((name, index) => ({
    label: `endpoint ${index + 1}`,
    create: () => {
      const reader = readers[index];
      assert.ok(reader, `endpoint ${name} unexpectedly created`);

      return reader;
    },
  }));

  const rotating = createRotatingChainReader({
    endpoints,
    failuresBeforeRotate: threshold,
    onRotate: ({ from, to }) => rotations.push({ from, to }),
  });

  return { rotating, readerAt, at, rotations, names };
}

describe("createRotatingChainReader", () => {
  it("needs at least one endpoint", () => {
    assert.throws(() => createRotatingChainReader({ endpoints: [] }), /at least one endpoint/);
  });

  it("rejects a threshold below one, which would rotate on every call", () => {
    const endpoints = [{ label: "e1", create: () => new FakeReader("e1", { fail: false }) }];

    assert.throws(
      () => createRotatingChainReader({ endpoints, failuresBeforeRotate: 0 }),
      /positive integer/,
    );
  });

  it("reads from the first endpoint while it works", async () => {
    const { rotating, readerAt } = build(3);

    assert.equal(await rotating.reader.getBlockNumber(), 100n);
    assert.equal(readerAt(0).logCalls, 0, "the first read was getBlockNumber, not getLogs");

    await rotating.reader.getLogs({ address: "0x01", fromBlock: 0n, toBlock: 1n });

    assert.equal(readerAt(0).logCalls, 1);
    assert.equal(rotating.activeLabel(), "endpoint 1");
    assert.equal(rotating.rotations(), 0);
  });

  it("does not rotate before the threshold is reached", async () => {
    // The whole point of a threshold. Rotating on one failure would move the
    // indexer off a healthy primary because of a single dropped request.
    const { rotating, at } = build(3);

    at(0).fail = true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(() => rotating.reader.getBlockNumber());
    }

    assert.equal(rotating.activeLabel(), "endpoint 1", "still on the primary");
    assert.equal(rotating.consecutiveFailures(), 2);
    assert.equal(rotating.rotations(), 0);
  });

  it("rotates once the threshold is reached, and reports which endpoints moved", async () => {
    const { rotating, at, rotations } = build(3);

    at(0).fail = true;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(() => rotating.reader.getBlockNumber());
    }

    assert.equal(rotating.activeLabel(), "endpoint 2");
    assert.equal(rotating.rotations(), 1);
    assert.deepEqual(rotations, [{ from: "endpoint 1", to: "endpoint 2" }]);
  });

  it("rethrows the endpoint's own error rather than swallowing it", async () => {
    // `syncOnce` aborts the iteration on a throw and advances the cursor
    // otherwise. A swallowed error would look like "this range had no events" and
    // the cursor would move past blocks that were never read.
    const { rotating, at } = build(3);

    at(0).fail = true;

    await assert.rejects(() => rotating.reader.getBlockNumber(), /one is down/);
  });

  it("clears the failure count on a success", async () => {
    const { rotating, at } = build(3);

    at(0).fail = true;
    await assert.rejects(() => rotating.reader.getBlockNumber());
    await assert.rejects(() => rotating.reader.getBlockNumber());

    assert.equal(rotating.consecutiveFailures(), 2);

    at(0).fail = false;
    await rotating.reader.getBlockNumber();

    assert.equal(rotating.consecutiveFailures(), 0, "a success clears the evidence");
    assert.equal(rotating.activeLabel(), "endpoint 1", "and the endpoint keeps its turn");
  });

  it("counts failures across both read methods together", async () => {
    // The counter is per ENDPOINT, not per method. Counted separately, an endpoint
    // alternating between a failing `getBlockNumber` and a failing `getLogs` would
    // never reach the threshold while failing every single call.
    const { rotating, at } = build(2);

    at(0).fail = true;

    await assert.rejects(() => rotating.reader.getBlockNumber());
    await assert.rejects(() =>
      rotating.reader.getLogs({ address: "0x01", fromBlock: 0n, toBlock: 1n }),
    );

    assert.equal(rotating.activeLabel(), "endpoint 2");
  });

  it("wraps around so a recovered primary is used again", async () => {
    // Stopping at the last endpoint would turn a transient outage into a
    // permanent one: the primary would never be retried.
    const { rotating, at } = build(1);

    at(0).fail = true;
    await assert.rejects(() => rotating.reader.getBlockNumber());
    assert.equal(rotating.activeLabel(), "endpoint 2");

    at(1).fail = true;
    await assert.rejects(() => rotating.reader.getBlockNumber());
    assert.equal(rotating.activeLabel(), "endpoint 3");

    at(2).fail = true;
    await assert.rejects(() => rotating.reader.getBlockNumber());
    assert.equal(rotating.activeLabel(), "endpoint 1", "wrapped back to the first");
    assert.equal(rotating.rotations(), 3);
  });

  it("builds each endpoint's reader lazily, only once it is used", async () => {
    // A process that never rotates must not construct clients for endpoints it
    // never contacted, and `create` throwing for an untouched endpoint is how
    // that is asserted.
    let created = 0;

    const rotating = createRotatingChainReader({
      endpoints: [
        { label: "only", create: () => ((created += 1), new FakeReader("only", { fail: false })) },
      ],
    });

    assert.equal(created, 0, "nothing built before the first read");

    await rotating.reader.getBlockNumber();
    assert.equal(created, 1);

    await rotating.reader.getBlockNumber();
    assert.equal(created, 1, "and not rebuilt on the second read");
  });

  it("works with a single endpoint, where rotation is a no-op", async () => {
    const { rotating, at } = build(1, ["solo"]);

    assert.equal(await rotating.reader.getBlockNumber(), 100n);

    at(0).fail = true;

    await assert.rejects(() => rotating.reader.getBlockNumber());

    // Rotating to itself is harmless and keeps the code path uniform.
    assert.equal(rotating.activeLabel(), "endpoint 1");
  });
});
