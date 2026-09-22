// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Abi, type AbiEvent } from "viem";
import type { Pool } from "mysql2/promise";

import { factoryAbi, pollAbi } from "../src/lib/contracts";

import { syncOnce, type ChainReader } from "../src/lib/indexer/sync";

const FACTORY = "0x2222222222222222222222222222222222222222" as const;
const POLL_A = "0xaaaa000000000000000000000000000000000000" as const;
const POLL_B = "0xbbbb000000000000000000000000000000000000" as const;
const VOTER = "0x019b020913b752e0b922b1c305fde9256546c04b" as const;

/** A log as it comes off `getLogs`, with only the fields the indexer reads. */
interface RawLog {
  address: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  topics: readonly string[];
  data: string;
}

function encode(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  base: { address: string; blockNumber: bigint; logIndex: number; txHash?: string },
): RawLog {
  const item = getAbiItem({ abi, name: eventName }) as unknown as AbiEvent;
  const inputs = item.inputs;

  const indexedArgs: Record<string, unknown> = Object.fromEntries(
    inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name as string]]),
  );
  const nonIndexed = inputs.filter((i) => !i.indexed);

  return {
    address: base.address,
    blockNumber: base.blockNumber,
    transactionHash:
      base.txHash ?? `0x${base.blockNumber.toString(16).padStart(64, "0")}${base.logIndex}`,
    logIndex: base.logIndex,
    topics: encodeEventTopics({ abi, eventName, args: indexedArgs as never }) as readonly string[],
    data: encodeAbiParameters(
      nonIndexed.map((i) => ({ name: i.name, type: i.type })) as never,
      nonIndexed.map((i) => args[i.name as string]) as never,
    ),
  };
}

/** A `VoteCast` for a poll, at the given coordinates. */
function voteCast(
  optionId: bigint,
  blockNumber: bigint,
  logIndex: number,
  poll: string = POLL_A,
): RawLog {
  return encode(
    pollAbi as unknown as Abi,
    "VoteCast",
    { voter: VOTER, optionId, newCount: 1n },
    { address: poll, blockNumber, logIndex },
  );
}

/**
 * `PollCreated` and the new clone's `initialize` logs, in one block.
 *
 * The contract really does produce these together: `createPoll` deploys the
 * clone and calls `initialize` on it inside the same transaction, so the
 * factory's log and the poll's own `OptionAdded` logs share a block number and
 * differ only by log index.
 */
function pollCreation(blockNumber: bigint, poll = POLL_A, firstLogIndex = 0): RawLog[] {
  return [
    encode(
      factoryAbi as unknown as Abi,
      "PollCreated",
      {
        poll,
        creator: VOTER,
        question: "Which?",
        endsAt: 1_800_000_000n,
        optionCount: 2n,
        openToAll: false,
      },
      { address: FACTORY, blockNumber, logIndex: firstLogIndex },
    ),
    encode(
      pollAbi as unknown as Abi,
      "OptionAdded",
      { id: 1n, labelCID: "cid-a" },
      { address: poll, blockNumber, logIndex: firstLogIndex + 1 },
    ),
    encode(
      pollAbi as unknown as Abi,
      "OptionAdded",
      { id: 2n, labelCID: "cid-b" },
      { address: poll, blockNumber, logIndex: firstLogIndex + 2 },
    ),
  ];
}

/** A `getLogs` result filtered to one address, mirroring what an RPC returns. */
function logsFor(logs: readonly RawLog[], address: string, fromBlock: bigint, toBlock: bigint) {
  return logs.filter(
    (log) =>
      log.address.toLowerCase() === address.toLowerCase() &&
      log.blockNumber >= fromBlock &&
      log.blockNumber <= toBlock,
  );
}

/**
 * An in-memory stand-in for the MySQL pool. It recognises only the statements
 * `sync.ts` actually issues, so an unexpected query fails loudly rather than
 * being silently absorbed — that is what keeps this fake honest.
 *
 * `polls` is modelled for real (not just recorded) because the sync loop READS
 * it: the known-poll set is what the second `getLogs` round is built from, and a
 * fake that always answered "no polls" would hide the bug the multi-address
 * tests exist to catch.
 */
class FakePool {
  cursor: bigint | null = null;
  inserts: { table: string; rows: unknown[][] }[] = [];
  deletedFrom: string[] = [];
  commits = 0;
  /** `polls.address` values, as the sync loop would have persisted them. */
  pollRows: string[] = [];
  /** How many `INSERT IGNORE` batches per table, so double-writes are visible. */
  counts = new Map<string, number>();

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    if (sql.includes("SELECT last_block")) {
      return [this.cursor === null ? [] : [{ last_block: this.cursor.toString() }], []];
    }
    if (sql.includes("FROM polls")) {
      void params;
      return [this.pollRows.map((address) => ({ address })), []];
    }
    throw new Error(`FakePool received an unexpected query: ${sql}`);
  }

  async getConnection() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      async query(sql: string, params?: unknown[]): Promise<unknown> {
        // The cursor upsert is checked FIRST: it is itself an `INSERT INTO`, so
        // a table-name match would swallow it as a sixth event table and the
        // fake would silently stop persisting the cursor.
        if (sql.includes("sync_cursor")) {
          self.cursor = BigInt(String(params?.[0]));
          return [{ affectedRows: 1 }, []];
        }

        const table = /INSERT (?:IGNORE )?INTO (\w+)/.exec(sql)?.[1];

        if (table !== undefined) {
          const rows = ((params?.[0] as unknown[][]) ?? []) as unknown[][];

          self.inserts.push({ table, rows });
          self.counts.set(table, (self.counts.get(table) ?? 0) + 1);

          // The `polls` table is upserted, so model its content rather than only
          // recording the write: the next pass reads it back.
          if (table === "polls") {
            for (const row of rows) {
              const address = String(row[0]);

              if (!self.pollRows.includes(address)) {
                self.pollRows.push(address);
              }
            }
          }

          return [{ affectedRows: rows.length }, []];
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
  logs: RawLog[] = [];
  /** Every `getLogs` call, in order, with the address it was for. */
  requested: { address: string; fromBlock: bigint; toBlock: bigint }[] = [];

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<
    readonly {
      address?: string;
      blockNumber: bigint | null;
      transactionHash: string | null;
      logIndex: number | null;
    }[]
  > {
    this.requested.push({
      address: args.address.toLowerCase(),
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
    });

    return logsFor(this.logs, args.address, args.fromBlock, args.toBlock);
  }
}

function setup() {
  const pool = new FakePool();
  const chain = new FakeChain();

  const deps = {
    pool: pool as unknown as Pool,
    chain,
    factoryAddress: FACTORY,
    confirmations: 5,
    chunkBlocks: 10,
  };

  return { pool, chain, deps };
}

/** Rows the loop wrote to a table, flattened across batches. */
function rowsOf(pool: FakePool, table: string): unknown[][] {
  return pool.inserts.filter((insert) => insert.table === table).flatMap((insert) => insert.rows);
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
    assert.deepEqual(chain.requested, [
      { address: FACTORY.toLowerCase(), fromBlock: 0n, toBlock: 9n },
    ]);
    assert.equal(pool.cursor, 9n);
    assert.equal(pool.commits, 1);
  });

  it("clips the last chunk at the safe head", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 100n;
    pool.cursor = 93n;

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.deepEqual(chain.requested, [
      { address: FACTORY.toLowerCase(), fromBlock: 94n, toBlock: 95n },
    ]);
  });

  it("starts from startBlock when the cursor is empty", async () => {
    const { chain, deps } = setup();
    chain.head = 30n;

    const outcome = await syncOnce({ ...deps, confirmations: 0, chunkBlocks: 5, startBlock: 20n });

    assert.equal(outcome.status, "synced");
    assert.deepEqual(chain.requested, [
      { address: FACTORY.toLowerCase(), fromBlock: 20n, toBlock: 24n },
    ]);
  });

  it("starts from genesis when the cursor is empty and no startBlock is given", async () => {
    const { chain, deps } = setup();
    chain.head = 30n;

    await syncOnce({ ...deps, confirmations: 0, chunkBlocks: 5 });

    assert.deepEqual(chain.requested, [
      { address: FACTORY.toLowerCase(), fromBlock: 0n, toBlock: 4n },
    ]);
  });

  it("persists decoded votes and reports how many were seen", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 20n;
    pool.pollRows = [POLL_A.toLowerCase()];
    chain.logs = [voteCast(1n, 1n, 0), voteCast(2n, 2n, 1)];

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.equal(outcome.seen, 2);
    assert.equal(outcome.inserted, 2);

    const votes = rowsOf(pool, "votes");
    assert.equal(votes.length, 2);
    assert.equal(votes[0]?.[0], POLL_A.toLowerCase(), "the vote is keyed by its poll");
    assert.equal(votes[0]?.[1], VOTER);
    assert.equal(votes[0]?.[2], 1);
    assert.equal(votes[0]?.[3], "cast");
    assert.equal(votes[0]?.[4], "1", "block numbers are stored as strings, not floats");
  });

  it("reports an empty range without inserting anything", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 20n;

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.equal(outcome.seen, 0);
    assert.equal(outcome.inserted, 0);
    // The known-poll set is read from the `polls` table, which is one query per
    // pass — but nothing is INSERTED, because there is nothing to insert.
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
    assert.deepEqual(
      seeded.deletedFrom.slice().sort(),
      ["options", "phase_events", "polls", "refunds", "votes", "whitelist_events"],
      "a reorged-out PollCreated must take its polls row with it",
    );
    assert.deepEqual(seeded.deletedFrom.slice(0, 5), [
      "options",
      "votes",
      "refunds",
      "whitelist_events",
      "phase_events",
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

describe("syncOnce across polls", () => {
  it("indexes a poll created inside the scanned range in that SAME pass", async () => {
    // The whole point. The factory and the clone are mined in one transaction,
    // so the poll's own `OptionAdded` logs sit in the range the cursor is about
    // to step over. A pass that only queried the addresses it knew at its start
    // would drop them permanently, because the next pass begins after them.
    const { pool, chain, deps } = setup();
    chain.head = 20n;
    chain.logs = pollCreation(3n, POLL_A);

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    if (outcome.status !== "synced") {
      return;
    }

    assert.equal(outcome.pollsDiscovered, 1);

    // The new poll was queried, and in the SAME range as the factory.
    assert.deepEqual(chain.requested, [
      { address: FACTORY.toLowerCase(), fromBlock: 0n, toBlock: 9n },
      { address: POLL_A.toLowerCase(), fromBlock: 0n, toBlock: 9n },
    ]);

    // Its events were persisted before the cursor moved past them.
    assert.equal(rowsOf(pool, "polls").length, 1);
    assert.equal(rowsOf(pool, "polls")[0]?.[0], POLL_A.toLowerCase());
    assert.equal(rowsOf(pool, "options").length, 2, "both OptionAdded logs are in this pass");
    assert.equal(
      rowsOf(pool, "options").every((row) => row[0] === POLL_A.toLowerCase()),
      true,
    );
    assert.equal(pool.cursor, 9n, "the cursor may only move once the events are stored");
  });

  it("queries the new poll within the SAME range as the factory", async () => {
    // The negative control for the test above: if the implementation fetched the
    // new poll starting from the NEXT block — or only on the following pass —
    // its events would be in a range the cursor has already stepped over, and
    // the assertion below is what fails.
    const { chain, deps } = setup();
    chain.head = 20n;
    chain.logs = pollCreation(3n, POLL_A);

    await syncOnce(deps);

    const factoryRange = chain.requested[0];
    const pollRange = chain.requested.find((r) => r.address === POLL_A.toLowerCase());

    assert.deepEqual(
      { fromBlock: pollRange?.fromBlock, toBlock: pollRange?.toBlock },
      { fromBlock: factoryRange?.fromBlock, toBlock: factoryRange?.toBlock },
      "the poll must be scanned for the range the PollCreated was found in",
    );
    assert.equal(pollRange?.fromBlock, 0n, "which is the range that contains block 3");
  });

  it("also indexes a vote cast in the same range as the poll's creation", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 20n;
    chain.logs = [...pollCreation(3n, POLL_A), voteCast(2n, 4n, 5)];
    chain.logs.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : Number(a.blockNumber - b.blockNumber),
    );

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.equal(rowsOf(pool, "votes").length, 1);
    assert.equal(rowsOf(pool, "votes")[0]?.[0], POLL_A.toLowerCase());
    assert.equal(rowsOf(pool, "votes")[0]?.[3], "cast");
  });

  it("queries every poll already known from the polls table", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 20n;
    pool.cursor = 9n;
    pool.pollRows = [POLL_A.toLowerCase(), POLL_B.toLowerCase()];
    chain.logs = [voteCast(1n, 10n, 0, POLL_A), voteCast(2n, 11n, 1, POLL_B)];

    const outcome = await syncOnce(deps);

    assert.equal(outcome.status, "synced");
    assert.equal(outcome.seen, 2, "both polls' votes are seen in one pass");

    assert.deepEqual(
      chain.requested.map((request) => request.address).sort(),
      [FACTORY.toLowerCase(), POLL_A.toLowerCase(), POLL_B.toLowerCase()].sort(),
    );
    assert.deepEqual(
      rowsOf(pool, "votes").map((row) => row[0]),
      [POLL_A.toLowerCase(), POLL_B.toLowerCase()],
      "each vote keeps the address of the poll that emitted it",
    );
  });

  it("does not re-query a poll the polls table already knows", async () => {
    // The second `getLogs` round exists for polls discovered in THIS range. A
    // poll already in the table was queried in the first round, and fetching it
    // twice would double the cost of every pass for no extra rows.
    const { pool, chain, deps } = setup();
    chain.head = 20n;
    chain.logs = pollCreation(3n, POLL_A);

    await syncOnce(deps);

    const pollRequests = chain.requested.filter(
      (request) => request.address === POLL_A.toLowerCase(),
    );
    assert.equal(pollRequests.length, 1);
  });

  it("fetches nothing extra when the range announces no poll", async () => {
    const { chain, deps } = setup();
    chain.head = 20n;
    chain.logs = [voteCast(1n, 1n, 0)];

    await syncOnce(deps);

    assert.deepEqual(
      chain.requested.map((request) => request.address),
      [FACTORY.toLowerCase()],
    );
  });

  it("resumes with the polls it discovered on an earlier pass", async () => {
    // Restart behaviour: the addresses come from the table, not from a second
    // scan of the factory's history.
    const { chain, deps } = setup();
    const pooled = new FakePool();

    chain.head = 30n;
    chain.logs = pollCreation(3n, POLL_A);

    // First pass, from genesis: block 3 announces the poll.
    await syncOnce({ ...deps, pool: pooled as unknown as Pool });

    assert.deepEqual(pooled.pollRows, [POLL_A.toLowerCase()]);
    assert.equal(pooled.cursor, 9n);

    // Second pass, second chunk: the poll is known from the table alone, so it
    // is queried alongside the factory with no re-discovery and no extra scan of
    // the range that created it.
    chain.requested.length = 0;
    chain.logs = [voteCast(1n, 12n, 0)];
    pooled.pollRows = [POLL_A.toLowerCase()];

    const outcome = await syncOnce({ ...deps, pool: pooled as unknown as Pool });

    assert.equal(outcome.status, "synced");
    assert.equal(outcome.seen, 1);
    assert.equal(outcome.pollsDiscovered, 0, "nothing was re-discovered");
    assert.deepEqual(
      chain.requested.map((request) => request.address).sort(),
      [FACTORY.toLowerCase(), POLL_A.toLowerCase()].sort(),
    );
  });
});
