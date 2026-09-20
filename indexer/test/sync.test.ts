// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, encodeEventTopics, getAbiItem, type AbiEvent } from "viem";
import type { Pool } from "mysql2/promise";

import { votingAbi } from "@voting/shared";

import { syncOnce, type ChainReader } from "../src/indexer/sync.js";

const CONTRACT = "0x2222222222222222222222222222222222222222" as const;

const VOTE_ITEM = getAbiItem({ abi: votingAbi, name: "VoteCast" }) as unknown as AbiEvent;

function makeVoteLog(voter: string, candidateId: bigint, blockNumber: bigint, logIndex: number) {
  const nonIndexed = VOTE_ITEM.inputs.filter((input) => !input.indexed);
  const args = { voter, candidateId, newCount: 1n };

  const dataParams = nonIndexed.map((input) => ({ name: input.name, type: input.type }));

  return {
    address: CONTRACT,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    topics: encodeEventTopics({ abi: votingAbi, eventName: "VoteCast", args: args as never }),
    data: encodeAbiParameters(
      dataParams as never,
      nonIndexed.map((input) => (args as Record<string, unknown>)[input.name as string]) as never,
    ),
  };
}

/**
 * An in-memory stand-in for the MySQL pool. It recognises only the statements
 * `sync.ts` actually issues, so an unexpected query fails loudly rather than
 * being silently absorbed — that is what keeps this fake honest.
 */
class FakePool {
  cursor: bigint | null = null;
  inserts: { table: string; rows: unknown[][] }[] = [];
  deletedFrom: string[] = [];
  commits = 0;

  async query(sql: string): Promise<unknown> {
    if (sql.includes("SELECT last_block")) {
      return [this.cursor === null ? [] : [{ last_block: this.cursor.toString() }], []];
    }
    throw new Error(`FakePool received an unexpected query: ${sql}`);
  }

  async getConnection() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      async query(sql: string, params?: unknown[]): Promise<unknown> {
        const table = /INSERT IGNORE INTO (\w+)/.exec(sql)?.[1];

        if (table !== undefined) {
          const rows = ((params?.[0] as unknown[][]) ?? []) as unknown[][];
          self.inserts.push({ table, rows });
          return [{ affectedRows: rows.length }, []];
        }

        if (sql.includes("sync_cursor")) {
          self.cursor = BigInt(String(params?.[0]));
          return [{ affectedRows: 1 }, []];
        }

        if (sql.includes("DELETE FROM")) {
          self.deletedFrom.push(/DELETE FROM (\w+)/.exec(sql)?.[1] ?? "unknown");
          return [{ affectedRows: 0 }, []];
        }

        throw new Error(`FakePool connection received an unexpected query: ${sql}`);
      },
      async beginTransaction(): Promise<void> {},
      async commit(): Promise<void> {
        self.commits += 1;
      },
      async rollback(): Promise<void> {},
      release(): void {},
    };
  }
}

class FakeChain implements ChainReader {
  head = 0n;
  logs: ReturnType<typeof makeVoteLog>[] = [];
  requested: { fromBlock: bigint; toBlock: bigint }[] = [];

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<
    readonly {
      blockNumber: bigint | null;
      transactionHash: string | null;
      logIndex: number | null;
    }[]
  > {
    this.requested.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });

    return this.logs.filter(
      (log) => log.blockNumber >= args.fromBlock && log.blockNumber <= args.toBlock,
    );
  }
}

function setup() {
  const pool = new FakePool();
  const chain = new FakeChain();

  const deps = {
    pool: pool as unknown as Pool,
    chain,
    address: CONTRACT,
    confirmations: 5,
    chunkBlocks: 10,
  };

  return { pool, chain, deps };
}

describe("syncOnce", () => {
  it("does nothing while the chain is inside the confirmation window", async () => {
    const { chain, deps } = setup();
    chain.head = 3n;

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "idle");
    assert.equal(chain.requested.length, 0, "must not query logs it cannot trust");
  });

  it("indexes one chunk and advances the cursor to its end", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 100n;

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.deepEqual(chain.requested, [{ fromBlock: 0n, toBlock: 9n }]);
    assert.equal(pool.cursor, 9n);
    assert.equal(pool.commits, 1);
  });

  it("clips the last chunk at the safe head", async () => {
    const { chain, deps } = setup();
    chain.head = 100n;
    const pool = new FakePool();
    pool.cursor = 93n;

    const outcome = await syncOnce({ ...deps, pool: pool as unknown as Pool });

    assert.equal(outcome.status, "synced");
    assert.deepEqual(chain.requested, [{ fromBlock: 94n, toBlock: 95n }]);
  });

  it("starts from startBlock when the cursor is empty", async () => {
    const { chain, deps } = setup();
    chain.head = 30n;

    const outcome = await syncOnce({ ...deps, confirmations: 0, chunkBlocks: 5, startBlock: 20n });

    assert.equal(outcome.status, "synced");
    assert.deepEqual(chain.requested, [{ fromBlock: 20n, toBlock: 24n }]);
  });

  it("starts from genesis when the cursor is empty and no startBlock is given", async () => {
    const { chain, deps } = setup();
    chain.head = 30n;

    await syncOnce({ ...deps, confirmations: 0, chunkBlocks: 5 });

    assert.deepEqual(chain.requested, [{ fromBlock: 0n, toBlock: 4n }]);
  });

  it("persists decoded votes and reports how many were seen", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 20n;
    chain.logs = [makeVoteLog(CONTRACT, 1n, 1n, 0), makeVoteLog(CONTRACT, 2n, 2n, 1)];

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.equal(outcome.seen, 2);
    assert.equal(outcome.inserted, 2);

    const votes = pool.inserts.find((insert) => insert.table === "votes");
    assert.equal(votes?.rows.length, 2);
    assert.equal(votes?.rows[0]?.[0], CONTRACT);
    assert.equal(votes?.rows[0]?.[1], 1);
    assert.equal(votes?.rows[0]?.[2], "1", "block numbers are stored as strings, not floats");
  });

  it("reports an empty range without inserting anything", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 20n;

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.equal(outcome.seen, 0);
    assert.equal(outcome.inserted, 0);
    assert.equal(pool.inserts.length, 0);
    assert.equal(pool.cursor, 9n, "the cursor still advances past empty ranges");
  });

  it("rewinds when the chain head falls behind the cursor", async () => {
    const { pool, chain, deps } = setup();
    const seeded = new FakePool();
    seeded.cursor = 60n;
    chain.head = 40n;

    const outcome = await syncOnce({ ...deps, pool: seeded as unknown as Pool });

    assert.equal(outcome.status, "rewound");
    assert.deepEqual(outcome, {
      status: "rewound",
      chainHead: 40n,
      rewoundTo: 35n,
      discardedFrom: 36n,
    });
    assert.equal(seeded.cursor, 35n);
    assert.deepEqual(seeded.deletedFrom.sort(), [
      "candidates",
      "phase_events",
      "refunds",
      "votes",
      "whitelist_events",
    ]);
    assert.equal(pool.cursor, null, "the untouched pool must not be written to");
  });

  it("does not rewind when the head is merely equal to the cursor", async () => {
    const { chain, deps } = setup();
    const seeded = new FakePool();
    seeded.cursor = 40n;
    chain.head = 40n;

    const outcome = await syncOnce({ ...deps, pool: seeded as unknown as Pool });

    assert.equal(outcome.status, "idle");
    assert.equal(seeded.deletedFrom.length, 0);
  });
});
