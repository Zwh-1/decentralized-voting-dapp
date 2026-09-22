// SPDX-License-Identifier: MIT
/**
 * The consistency check reads three things that only mean something together: the
 * index's tally, the cursor that tally was committed with, and a single height on
 * the chain. Each pair was previously read at a different moment, and each
 * mismatch has the same symptom — a healthy index accused of diverging, which is
 * the one verdict the whole M-6 check exists to make trustworthy.
 *
 * Measured before the fix, driving a real vote while polling `/api/results`:
 *
 *     {"status":500,"verdict":"divergent",
 *      "discrepancies":[{"optionId":1,"onChain":68,"indexed":67,"pending":0}],
 *      "onChainTotal":201,"indexedTotal":200,"unindexedBlocks":0,"pendingVotes":0,
 *      "lastIndexedBlock":"407"}
 *
 * `unindexedBlocks: 0` is the tell: the check believed the index was caught up, so
 * the vote it was missing could not be reconciled, and it reported a fault that
 * did not exist. See ADR-0017.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, encodeEventTopics, getAbiItem, type AbiEvent } from "viem";
import type { PublicClient } from "viem";

import { pollAbi } from "../src/lib/contracts";
import { checkConsistency, readIndexSnapshot, readIndexedTally } from "../src/lib/report";
import { readCursor } from "../src/lib/indexer/sync";

const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";

/** One committed state of the index: a tally plus the cursor it was written with. */
interface Committed {
  counts: number[];
  cursor: number;
}

const SYNCED: Committed = { counts: [67, 67, 66], cursor: 406 };
/** The same index one batch later: the vote at block 407 has landed. */
const AFTER_VOTE: Committed = { counts: [68, 67, 66], cursor: 407 };

function tallyRow(state: Committed) {
  return state.counts.map((voteCount, offset) => ({
    option_id: offset + 1,
    label_cid: `bafy${offset}`,
    vote_count: String(voteCount),
  }));
}

/**
 * A pool that models the only thing under test: the indexer may commit between
 * two reads taken *through the pool*, and it may never do so inside a transaction.
 *
 * The first direct read is the moment the batch lands, which is precisely the
 * window that made the tally and the cursor disagree.
 */
function racingPool() {
  let committed = SYNCED;
  let directReads = 0;

  // mysql2 resolves to `[rows, fields]`, so both branches wrap their rows once.
  const answer = (state: Committed, sql: string) =>
    sql.includes("option_tally") ? [tallyRow(state)] : [[{ last_block: String(state.cursor) }]];

  return {
    /** Set once the batch has landed, so a test can assert the race happened. */
    get landed() {
      return directReads > 0;
    },
    async query(sql: string) {
      directReads += 1;
      const from = committed;
      committed = AFTER_VOTE;

      return answer(from, sql);
    },
    async getConnection() {
      const snapshot = committed;
      const connection = {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql: string) {
          return answer(snapshot, sql);
        },
      };

      return connection;
    },
  };
}

describe("readIndexSnapshot", () => {
  it("returns a tally and a cursor that belong to the same committed state", async () => {
    const pool = racingPool();
    const { indexed, cursor } = await readIndexSnapshot(pool as never, CONTRACT);

    assert.equal(indexed.total, 200);
    assert.equal(cursor, 406n, "the cursor must be the one the tally was written with");
  });

  it("would disagree if the two were read one after the other", async () => {
    // Not a description of the current code: this pins *why* the snapshot exists,
    // so a future refactor that reads them separately fails here rather than in
    // production. The pool commits the batch after the first read, exactly as a
    // two-second indexer loop can.
    const pool = racingPool();
    const indexed = await readIndexedTally(pool as never, CONTRACT);
    const cursor = await readCursor(pool as never);

    assert.equal(pool.landed, true);
    assert.equal(indexed.total, 200, "the tally predates the batch");
    assert.equal(cursor, 407n, "the cursor includes it");
  });
});

/** A VoteRecorded for option 1 at the given block, encoded against the real ABI. */
function voteRecorded(blockNumber: bigint) {
  const item = getAbiItem({ abi: pollAbi, name: "VoteRecorded" }) as unknown as AbiEvent;
  const args: Record<string, unknown> = {
    voter: `0x${"11".repeat(20)}`,
    optionIds: [1n],
    power: 1n,
    newTotal: 68n,
  };
  const indexedArgs = Object.fromEntries(
    item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name as string]]),
  );
  const nonIndexed = item.inputs.filter((i) => !i.indexed);

  return {
    address: CONTRACT,
    blockNumber,
    transactionHash: `0x${"cd".repeat(32)}`,
    logIndex: 0,
    topics: encodeEventTopics({
      abi: pollAbi,
      eventName: "VoteRecorded",
      args: indexedArgs as never,
    }),
    data: encodeAbiParameters(
      nonIndexed.map((i) => ({ name: i.name, type: i.type })) as never,
      nonIndexed.map((i) => args[i.name as string]) as never,
    ),
  };
}

describe("checkConsistency", () => {
  it("does not call a healthy index divergent when a batch lands mid-check", async () => {
    const pool = racingPool();
    const client = {
      getBlockNumber: async () => 407n,
      readContract: async () => [
        [
          { id: 1n, labelCID: "bafy0", voteCount: 68n },
          { id: 2n, labelCID: "bafy1", voteCount: 67n },
          { id: 3n, labelCID: "bafy2", voteCount: 66n },
        ],
        201n,
      ],
      getLogs: async () => [voteRecorded(407n)],
    } as unknown as PublicClient;

    const check = await checkConsistency({
      client,
      pool: pool as never,
      address: CONTRACT,
    });

    assert.equal(check.status, "consistent");
    assert.deepEqual(check.discrepancies, []);
    assert.equal(check.pendingVotes, 1, "the vote in the unindexed range was added back");
    assert.equal(check.unindexedBlocks, 1, "block 407 is the one behind the cursor of 406");
    assert.equal(check.lastIndexedBlock, 406n);
  });

  it("still reports a genuine divergence", async () => {
    // The fix must not turn the check into a rubber stamp: a vote that the index
    // has had every opportunity to consume is still a fault.
    const pool = {
      async getConnection() {
        return {
          async beginTransaction() {},
          async commit() {},
          async rollback() {},
          release() {},
          async query(sql: string) {
            return sql.includes("option_tally")
              ? [tallyRow({ counts: [66, 67, 66], cursor: 410 })]
              : [{ last_block: "410" }];
          },
        };
      },
    };
    const client = {
      getBlockNumber: async () => 410n,
      readContract: async () => [
        [
          { id: 1n, labelCID: "bafy0", voteCount: 68n },
          { id: 2n, labelCID: "bafy1", voteCount: 67n },
          { id: 3n, labelCID: "bafy2", voteCount: 66n },
        ],
        201n,
      ],
      getLogs: async () => [],
    } as unknown as PublicClient;

    const check = await checkConsistency({ client, pool: pool as never, address: CONTRACT });

    assert.equal(check.status, "divergent");
    assert.deepEqual(check.discrepancies, [{ optionId: 1, onChain: 68, indexed: 66, pending: 0 }]);
  });

  it("pins the chain tally to the same height as the logs it enumerates", async () => {
    // A tally read at "latest" while the logs stop at an earlier height, or the
    // reverse, counts a vote twice or not at all. Both must name one height.
    const seen: { blockNumber?: bigint } = {};
    const pool = {
      async getConnection() {
        return {
          async beginTransaction() {},
          async commit() {},
          async rollback() {},
          release() {},
          async query(sql: string) {
            return sql.includes("option_tally") ? [tallyRow(SYNCED)] : [{ last_block: "406" }];
          },
        };
      },
    };
    const client = {
      getBlockNumber: async () => 406n,
      readContract: async (args: { blockNumber?: bigint }) => {
        seen.blockNumber = args.blockNumber;

        return [
          [
            { id: 1n, labelCID: "bafy0", voteCount: 67n },
            { id: 2n, labelCID: "bafy1", voteCount: 67n },
            { id: 3n, labelCID: "bafy2", voteCount: 66n },
          ],
          200n,
        ];
      },
      getLogs: async () => [],
    } as unknown as PublicClient;

    const check = await checkConsistency({ client, pool: pool as never, address: CONTRACT });

    assert.equal(seen.blockNumber, 406n, "the tally must be read at the enumerated height");
    assert.equal(check.status, "consistent");
  });
});
