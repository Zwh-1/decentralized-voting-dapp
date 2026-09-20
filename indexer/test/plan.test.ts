// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lagBlocks, planNextRange, planReorgRewind, safeHead } from "../src/indexer/plan.js";

describe("safeHead", () => {
  it("withholds the confirmation window", () => {
    assert.equal(safeHead(100n, 5), 95n);
  });

  it("goes below genesis when the chain is shorter than the window", () => {
    assert.equal(safeHead(3n, 5), -2n);
    assert.equal(safeHead(0n, 5), -5n);
  });
});

describe("planNextRange", () => {
  it("starts at genesis when nothing is indexed", () => {
    const range = planNextRange({
      chainHead: 100n,
      lastIndexedBlock: null,
      confirmations: 5,
      chunkBlocks: 10,
    });

    assert.deepEqual(range, { fromBlock: 0n, toBlock: 9n });
  });

  it("resumes immediately after the last indexed block", () => {
    const range = planNextRange({
      chainHead: 100n,
      lastIndexedBlock: 9n,
      confirmations: 5,
      chunkBlocks: 10,
    });

    assert.deepEqual(range, { fromBlock: 10n, toBlock: 19n });
  });

  it("never reads into the confirmation window", () => {
    const range = planNextRange({
      chainHead: 100n,
      lastIndexedBlock: 89n,
      confirmations: 5,
      chunkBlocks: 10,
    });

    // The safe head is 95, so the chunk is clipped rather than over-read.
    assert.deepEqual(range, { fromBlock: 90n, toBlock: 95n });
  });

  it("reports nothing to do when caught up", () => {
    const range = planNextRange({
      chainHead: 100n,
      lastIndexedBlock: 95n,
      confirmations: 5,
      chunkBlocks: 10,
    });

    assert.equal(range, null);
  });

  it("reports nothing to do when the chain is shorter than the window", () => {
    const range = planNextRange({
      chainHead: 3n,
      lastIndexedBlock: null,
      confirmations: 5,
      chunkBlocks: 10,
    });

    assert.equal(range, null);
  });

  it("treats a cursor of -1 as the start of the chain", () => {
    const range = planNextRange({
      chainHead: 100n,
      lastIndexedBlock: -1n,
      confirmations: 0,
      chunkBlocks: 1,
    });

    assert.deepEqual(range, { fromBlock: 0n, toBlock: 0n });
  });

  it("honours confirmations of zero", () => {
    const range = planNextRange({
      chainHead: 100n,
      lastIndexedBlock: 98n,
      confirmations: 0,
      chunkBlocks: 10,
    });

    assert.deepEqual(range, { fromBlock: 99n, toBlock: 100n });
  });

  it("rejects a nonsensical chunk size", () => {
    assert.throws(
      () =>
        planNextRange({
          chainHead: 10n,
          lastIndexedBlock: null,
          confirmations: 0,
          chunkBlocks: 0,
        }),
      RangeError,
    );
  });
});

describe("planReorgRewind", () => {
  it("does nothing when the head is ahead of the cursor", () => {
    assert.equal(
      planReorgRewind({ chainHead: 100n, lastIndexedBlock: 50n, confirmations: 5 }),
      null,
    );
  });

  it("does nothing when the head equals the cursor", () => {
    assert.equal(
      planReorgRewind({ chainHead: 100n, lastIndexedBlock: 100n, confirmations: 5 }),
      null,
    );
  });

  it("does nothing when nothing has been indexed", () => {
    assert.equal(planReorgRewind({ chainHead: 0n, lastIndexedBlock: null, confirmations: 5 }), null);
  });

  it("rewinds to the safe head when the chain moves behind the cursor", () => {
    const plan = planReorgRewind({ chainHead: 40n, lastIndexedBlock: 60n, confirmations: 5 });

    assert.deepEqual(plan, { rewindTo: 35n, discardedFrom: 36n });
  });

  it("rewinds below genesis safely when the chain is very short", () => {
    const plan = planReorgRewind({ chainHead: 2n, lastIndexedBlock: 10n, confirmations: 5 });

    assert.deepEqual(plan, { rewindTo: -1n, discardedFrom: 0n });
  });
});

describe("lagBlocks", () => {
  it("counts only finalised blocks", () => {
    assert.equal(lagBlocks({ chainHead: 100n, lastIndexedBlock: 50n, confirmations: 5 }), 45n);
  });

  it("never reports a negative lag", () => {
    assert.equal(lagBlocks({ chainHead: 100n, lastIndexedBlock: 95n, confirmations: 5 }), 0n);
    assert.equal(lagBlocks({ chainHead: 10n, lastIndexedBlock: 50n, confirmations: 5 }), 0n);
  });

  it("treats an empty cursor as the start of the chain", () => {
    assert.equal(lagBlocks({ chainHead: 10n, lastIndexedBlock: null, confirmations: 0 }), 11n);
  });
});
