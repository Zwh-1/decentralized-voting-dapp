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

/** A `VoteRecorded` for a poll, at the given coordinates. */
function voteRecorded(
  optionIds: bigint[],
  blockNumber: bigint,
  logIndex: number,
  poll: string = POLL_A,
  power = 1n,
): RawLog {
  return encode(
    pollAbi as unknown as Abi,
    "VoteRecorded",
    { voter: VOTER, optionIds, power, newTotal: power },
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
/** A `Committed` for a poll, at the given coordinates. */
function committed(blockNumber: bigint, logIndex: number, poll: string = POLL_A): RawLog {
  return encode(
    pollAbi as unknown as Abi,
    "Committed",
    { voter: VOTER, commitment: `0x${"7a".repeat(32)}` },
    { address: poll, blockNumber, logIndex },
  );
}

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
/**
 * The event types a `votes` query counts, read OUT OF THE SQL ITSELF.
 *
 * This is the whole point of the fake's read side: the rule about what counts as
 * a prior vote lives in exactly one place — `sync.ts`'s query — and the fake
 * derives its answer from that text rather than restating the rule. A fake that
 * carried its own copy kept passing while the real query was wrong, which is how
 * a sealed `committed` row came to be counted as a prior vote (ADR-0011).
 *
 * Throws rather than guessing when the allow-list is absent, so a future query
 * that changes shape fails loudly instead of silently answering "nothing".
 */
function countedTypesIn(sql: string): string[] {
  const allowed = /event_type IN \(([^)]*)\)/.exec(sql)?.[1];

  if (allowed === undefined) {
    throw new Error(
      `FakePool cannot tell which event types this votes query counts: ${sql.replace(/\s+/g, " ")}`,
    );
  }

  return allowed.split(",").map((part) => part.trim().replace(/^'|'$/g, ""));
}

class FakePool {
  cursor: bigint | null = null;
  inserts: { table: string; rows: unknown[][] }[] = [];
  deletedFrom: string[] = [];
  commits = 0;
  /** `polls.address` values, as the sync loop would have persisted them. */
  pollRows: string[] = [];
  /**
   * `(poll_address, voter)` pairs the index holds, mapped to the event type of
   * the row that put them there.
   *
   * The event type is kept, not just the pair, so the `cast`/`changed`
   * derivation can be checked against the ALLOW-LIST THE REAL QUERY USES rather
   * than a rule restated here. The previous version of this fake carried its own
   * copy of the rule and therefore kept passing while `sync.ts` was wrong.
   */
  recordedVoters = new Map<string, string>();
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
    if (sql.includes("FROM votes")) {
      const polls = (params?.[0] as string[] | undefined) ?? [];
      const voters = (params?.[1] as string[] | undefined) ?? [];
      const rows: { poll_address: string; voter: string }[] = [];

      for (const [pair, eventType] of this.recordedVoters) {
        const [poll, voter] = pair.split("|");
        if (
          countedTypesIn(sql).includes(eventType) &&
          polls.includes(poll!) &&
          voters.includes(voter!)
        ) {
          rows.push({ poll_address: poll!, voter: voter! });
        }
      }

      return [rows, []];
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

          // `votes` is read back too, for the `cast`/`changed` derivation.
          // Column order matches the INSERT in `persistBatch`:
          // (poll_address, voter, option_id, event_type, power, ...).
          if (table === "votes") {
            for (const row of rows) {
              const poll = String(row[0]).toLowerCase();
              const voter = String(row[1]).toLowerCase();
              const eventType = String(row[3]);

              // Record what this row says, and let the READ side decide what
              // counts as a prior vote — by parsing the real query's allow-list.
              // The write side deliberately encodes no rule of its own.
              self.recordedVoters.set(`${poll}|${voter}`, eventType);
            }
          }

          return [{ affectedRows: rows.length }, []];
        }

        // `DELETE FROM` is checked BEFORE the votes read: `discardAbove` issues
        // `DELETE FROM votes`, and matching that as a read would both misroute
        // the statement and leave the rewind unmodelled.
        if (sql.includes("DELETE FROM")) {
          const table = /DELETE FROM (\w+)/.exec(sql)?.[1] ?? "unknown";
          self.deletedFrom.push(table);

          // Model the rewind, not just record it: a votes row removed above the
          // rewind point must stop counting as a prior vote, or a post-rewind
          // first vote would be mislabeled a change. The fake tracks one set per
          // (poll, voter) rather than per block, so the honest thing here is to
          // drop only the pairs this batch introduced — which it cannot know.
          // Instead it clears nothing, and the assertion below pins that a
          // rewind still reaches `votes` at all.
          return [{ affectedRows: 0 }, []];
        }

        // Read back what the `cast`/`changed` derivation depends on. Answered
        // inside the transaction, so it sees what earlier batches committed and
        // not what this one is still inserting — which is the real ordering.
        if (sql.includes("FROM votes")) {
          const polls = (params?.[0] as string[] | undefined) ?? [];
          const voters = (params?.[1] as string[] | undefined) ?? [];
          const rows: { poll_address: string; voter: string }[] = [];

          for (const [pair, eventType] of self.recordedVoters) {
            const [poll, voter] = pair.split("|");
            if (
              countedTypesIn(sql).includes(eventType) &&
              polls.includes(poll!) &&
              voters.includes(voter!)
            ) {
              rows.push({ poll_address: poll!, voter: voter! });
            }
          }

          return [rows, []];
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
    chain.logs = [voteRecorded([1n], 1n, 0), voteRecorded([2n], 2n, 1)];

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

  /**
   * The regression the commit-reveal drill caught in the real query.
   *
   * `_votersAlreadyRecorded` used to ask `event_type <> 'withdrawn'`, which
   * counted a SEALED `committed` row as a prior vote. A voter that committed and
   * then revealed therefore had its reveal labelled `changed` — the activity log
   * telling it, and everyone reading, that it had changed a vote it never cast.
   */
  it("does not treat a sealed commitment as a prior vote", async () => {
    const { pool, chain, deps } = setup();
    // `chunkBlocks` is 10, so each pass advances at most ten blocks — two log
    // sites ten blocks apart is exactly two passes.
    chain.head = 20n;
    pool.pollRows = [POLL_A.toLowerCase()];

    // A commitment in the first range...
    chain.logs = [committed(1n, 0)];
    await syncOnce(deps);

    assert.equal(rowsOf(pool, "votes")[0]?.[3], "committed", "the commitment is recorded");

    // ...and the reveal in the NEXT one. The head has to move for there to be a
    // later range at all: the first pass syncs up to the confirmation window, so
    // without this the second call would find nothing new and the assertion
    // below would fail for the wrong reason — the "0 counted rows" the real
    // drill first produced looked exactly like a decode bug.
    chain.head = 40n;
    chain.logs = [committed(1n, 0), voteRecorded([1n], 12n, 0)];
    await syncOnce(deps);

    const counted = rowsOf(pool, "votes").filter(
      (row) => row[3] === "cast" || row[3] === "changed",
    );

    assert.equal(counted.length, 1, "one counted row resulted");
    assert.equal(
      counted[0]?.[3],
      "cast",
      "a revealed first ballot is a cast, not a change of a vote that never existed",
    );
  });

  /**
   * The negative control for the rule above: a genuine second vote IS a change.
   * Without this, an implementation that labelled everything `cast` would pass
   * the test above.
   */
  it("still labels a real second vote as changed", async () => {
    const { pool, chain, deps } = setup();
    chain.head = 20n;
    pool.pollRows = [POLL_A.toLowerCase()];

    chain.logs = [voteRecorded([1n], 1n, 0)];
    await syncOnce(deps);

    chain.head = 40n;
    chain.logs = [voteRecorded([1n], 1n, 0), voteRecorded([2n], 12n, 0)];
    await syncOnce(deps);

    const all = rowsOf(pool, "votes");
    assert.equal(all.length, 2);
    assert.equal(all[0]?.[3], "cast", "the first is a cast");
    assert.equal(all[1]?.[3], "changed", "the second is a change");
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
    chain.logs = [...pollCreation(3n, POLL_A), voteRecorded([2n], 4n, 5)];
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
    chain.logs = [voteRecorded([1n], 10n, 0, POLL_A), voteRecorded([2n], 11n, 1, POLL_B)];

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
    chain.logs = [voteRecorded([1n], 1n, 0)];

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
    chain.logs = [voteRecorded([1n], 12n, 0)];
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
