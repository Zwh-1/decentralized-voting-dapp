// SPDX-License-Identifier: MIT
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

import {
  countEvents,
  decodeLogs,
  newPollAddresses,
  type DecodedEvents,
  type PollRow,
} from "./decode";
import { planNextRange, planReorgRewind } from "./plan";

/**
 * The only chain capability the indexer needs. Keeping it this narrow means the
 * sync loop can be unit tested against a fake, with no RPC endpoint in play.
 */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<
    readonly {
      address?: string;
      blockNumber: bigint | null;
      transactionHash: string | null;
      logIndex: number | null;
    }[]
  >;
}

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface SyncDeps {
  pool: Pool;
  chain: ChainReader;
  /**
   * The `VotingFactory`. One address, fixed for the life of the index.
   *
   * Was `address` when there was one `Voting` contract. The polls themselves
   * are not configured: they are discovered from `PollCreated` and remembered
   * in the `polls` table, so a restart resumes with what was already found
   * rather than re-deriving it from the factory's whole history.
   */
  factoryAddress: `0x${string}`;
  confirmations: number;
  chunkBlocks: number;
  /** First block to scan when the cursor is empty. */
  startBlock?: bigint;
  logger?: Logger;
}

export type SyncOutcome =
  | { status: "idle"; chainHead: bigint; lastIndexedBlock: bigint | null }
  | {
      status: "rewound";
      chainHead: bigint;
      rewoundTo: bigint;
      discardedFrom: bigint;
    }
  | {
      status: "synced";
      fromBlock: bigint;
      toBlock: bigint;
      seen: number;
      inserted: number;
      /** Polls whose `PollCreated` was in this range. */
      pollsDiscovered: number;
    };

const SILENT: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface CursorRow extends RowDataPacket {
  last_block: string;
}

interface PollAddressRow extends RowDataPacket {
  address: string;
}

/**
 * Reads the persisted cursor, or null when nothing has been indexed yet.
 *
 * Accepts a connection as well as a pool: the consistency check reads the cursor
 * and the tally it belongs to through one connection, so that the two describe
 * the same committed moment rather than two moments a batch apart. `persistBatch`
 * writes the events and the cursor in a single transaction, so any one snapshot
 * holds a pair that agree.
 */
export async function readCursor(pool: Pool | PoolConnection): Promise<bigint | null> {
  const [rows] = await pool.query<CursorRow[]>("SELECT last_block FROM sync_cursor WHERE id = 1");

  const first = rows[0];
  return first === undefined ? null : BigInt(first.last_block);
}

/**
 * Every poll address discovered so far.
 *
 * Read from the table rather than from the factory's `allPolls()`: the table is
 * the index's own record of what it has already scanned, and a restart must
 * resume from exactly that set. Asking the factory would return polls whose
 * `PollCreated` the cursor has not reached yet, and scanning them early is
 * harmless but pointless — while scanning them from the factory's answer rather
 * than from `polls` would lose the association between an address and the block
 * it was created in.
 */
export async function readKnownPolls(
  pool: Pool | PoolConnection,
  factoryAddress?: string,
): Promise<string[]> {
  const [rows] = await pool.query<PollAddressRow[]>(
    "SELECT address FROM polls ORDER BY block_number ASC, log_index ASC",
  );

  const addresses = rows.map((row) => row.address.toLowerCase());

  // The factory itself is always a log source. It is not in `polls`, but an
  // operator who accidentally passed a poll address as the factory would
  // otherwise index nothing at all, so keeping the configured target in the set
  // makes that mistake visible as "no PollCreated ever seen" rather than as
  // silence.
  if (factoryAddress !== undefined && !addresses.includes(factoryAddress.toLowerCase())) {
    addresses.unshift(factoryAddress.toLowerCase());
  }

  return addresses;
}

/**
 * Persists a decoded batch and advances the cursor in a single transaction.
 *
 * Every insert is `INSERT IGNORE` against a `UNIQUE(tx_hash, log_index)` key.
 * That is what makes the indexer idempotent: replaying a range that was already
 * stored inserts nothing and the cursor is simply rewritten to the same value.
 *
 * `seen` versus `inserted` is the observable proof of this. Re-running an
 * already-indexed range must report `seen > 0, inserted === 0`.
 *
 * Two tables need a real upsert rather than `INSERT IGNORE`, because an option
 * is MUTABLE on chain: `updateOption` re-emits `OptionAdded`-shaped data for an
 * id that already exists. Ignoring the second event would leave the first label
 * in place forever, which is a silently wrong projection rather than a
 * duplicate. `ON DUPLICATE KEY UPDATE` handles both keys at once — the
 * `(poll_address, option_id)` primary key and the `UNIQUE(tx_hash, log_index)`
 * idempotency key — so replays and updates are both correct.
 */
export async function persistBatch(
  pool: Pool,
  toBlock: bigint,
  events: DecodedEvents,
): Promise<{ seen: number; inserted: number }> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    let inserted = 0;

    const batches: { sql: string; rows: unknown[][] }[] = [
      {
        sql: `INSERT IGNORE INTO polls
                (address, creator, question, ends_at, option_count, block_number, tx_hash, log_index)
              VALUES ?`,
        rows: events.polls.map((row) => [
          row.address,
          row.creator,
          row.question,
          row.endsAt,
          row.optionCount,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: `INSERT INTO options
                (poll_address, option_id, label_cid, block_number, tx_hash, log_index)
              VALUES ? AS new
              ON DUPLICATE KEY UPDATE
                label_cid    = new.label_cid,
                block_number = new.block_number,
                tx_hash      = new.tx_hash,
                log_index    = new.log_index`,
        rows: events.options.map((row) => [
          row.pollAddress,
          row.optionId,
          row.labelCid,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: `INSERT IGNORE INTO votes
                (poll_address, voter, option_id, event_type, block_number, tx_hash, log_index)
              VALUES ?`,
        rows: events.votes.map((row) => [
          row.pollAddress,
          row.voter,
          row.optionId,
          row.eventType,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: `INSERT IGNORE INTO refunds
                (poll_address, voter, amount_wei, block_number, tx_hash, log_index)
              VALUES ?`,
        rows: events.refunds.map((row) => [
          row.pollAddress,
          row.voter,
          row.amountWei,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: `INSERT IGNORE INTO whitelist_events
                (poll_address, voter, allowed, block_number, tx_hash, log_index)
              VALUES ?`,
        rows: events.whitelist.map((row) => [
          row.pollAddress,
          row.voter,
          row.allowed ? 1 : 0,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: `INSERT IGNORE INTO phase_events
                (poll_address, from_phase, to_phase, block_number, tx_hash, log_index)
              VALUES ?`,
        rows: events.phases.map((row) => [
          row.pollAddress,
          row.fromPhase,
          row.toPhase,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
    ];

    for (const batch of batches) {
      if (batch.rows.length === 0) {
        continue;
      }

      const [result] = await connection.query(batch.sql, [batch.rows]);
      inserted += (result as { affectedRows: number }).affectedRows;
    }

    await connection.query(
      `INSERT INTO sync_cursor (id, last_block) VALUES (1, ?) AS new
       ON DUPLICATE KEY UPDATE last_block = new.last_block`,
      [toBlock.toString()],
    );

    await connection.commit();

    return { seen: countEvents(events), inserted };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Drops every row above `rewindTo` after a reorg.
 *
 * `polls` IS included, and deliberately. A `PollCreated` that a reorg removed
 * describes a contract that never existed at a stable address, so the poll row
 * is as invalid as the option and vote rows beneath it. Leaving it would keep a
 * phantom poll in the list forever and — worse — keep its address in the log
 * query for every future pass, where it would return nothing and hide the fact
 * that the poll is gone. Deleting it is safe rather than lossy: the surviving
 * factory log is re-fetched on the next pass and the row is rebuilt from it.
 *
 * The order matters: children before `polls`, so a partial failure cannot leave
 * rows pointing at a poll row that is already gone.
 */
async function discardAbove(pool: Pool, rewindTo: bigint): Promise<void> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const table of [
      "options",
      "votes",
      "refunds",
      "whitelist_events",
      "phase_events",
      "polls",
    ]) {
      await connection.query(`DELETE FROM ${table} WHERE block_number > ?`, [rewindTo.toString()]);
    }

    await connection.query(
      `INSERT INTO sync_cursor (id, last_block) VALUES (1, ?) AS new
       ON DUPLICATE KEY UPDATE last_block = new.last_block`,
      [rewindTo.toString()],
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Fetches every log the factory and the known polls emitted in one range.
 *
 * One `getLogs` call per address rather than one call with an address array:
 * an RPC that caps `eth_getLogs` by result count or by address count then fails
 * on one poll instead of on all of them, and the failure names the address it
 * belongs to. A poll that is not a poll (or a bad address) fails alone.
 */
async function fetchRange(
  chain: ChainReader,
  addresses: readonly string[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Awaited<ReturnType<ChainReader["getLogs"]>>> {
  const collected: Awaited<ReturnType<ChainReader["getLogs"]>>[number][] = [];

  for (const address of addresses) {
    const logs = await chain.getLogs({
      address: address as `0x${string}`,
      fromBlock,
      toBlock,
    });

    collected.push(...logs);
  }

  return collected;
}

/**
 * Runs one unit of work: repair a reorg if one happened, otherwise index the
 * next range of finalised blocks. Exactly one of those per call, so the loop
 * makes bounded progress and is easy to reason about.
 *
 * ---------------------------------------------------------------------------
 * The same-pass poll discovery, which is the whole correctness argument here
 * ---------------------------------------------------------------------------
 *
 * A poll is created by `VotingFactory.createPoll`, which deploys the clone and
 * then calls `initialize` on it *in the same transaction*. So the poll's own
 * `OptionAdded` logs and its `PollCreated` log are always in one block — and in
 * the seed script they land in ranges that a single `chunkBlocks` pass covers.
 *
 * If the pass queried only the addresses known at its start, the new poll's
 * events would be in a range the cursor is about to step over, and they would be
 * missed *permanently*: the next pass starts after them. That is the same class
 * of bug as a cursor advancing past an unindexed event, and it is silent.
 *
 * So the pass is: query the factory for the range, decode, collect the poll
 * addresses it announced, and query those — in the SAME range — before
 * committing the cursor. The second query is guarded by the set of addresses
 * already queried, so a replayed range does not re-fetch a poll that the
 * `polls` table already knows about.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  const logger = deps.logger ?? SILENT;

  const chainHead = await deps.chain.getBlockNumber();
  const stored = await readCursor(deps.pool);

  // When the cursor is empty, an explicit start block wins; otherwise genesis.
  const lastIndexedBlock = stored ?? (deps.startBlock === undefined ? null : deps.startBlock - 1n);

  const rewind = planReorgRewind({
    chainHead,
    lastIndexedBlock,
    confirmations: deps.confirmations,
  });

  if (rewind !== null) {
    logger.warn(
      { rewindTo: rewind.rewindTo.toString(), discardedFrom: rewind.discardedFrom.toString() },
      "chain head moved behind the indexed cursor; discarding blocks and re-fetching",
    );

    await discardAbove(deps.pool, rewind.rewindTo);

    return {
      status: "rewound",
      chainHead,
      rewoundTo: rewind.rewindTo,
      discardedFrom: rewind.discardedFrom,
    };
  }

  const range = planNextRange({
    chainHead,
    lastIndexedBlock,
    confirmations: deps.confirmations,
    chunkBlocks: deps.chunkBlocks,
  });

  if (range === null) {
    return { status: "idle", chainHead, lastIndexedBlock };
  }

  // 1. The factory, and every poll this index already knows about.
  const known = await readKnownPolls(deps.pool, deps.factoryAddress);

  const queried = new Set(known.map((address) => address.toLowerCase()));
  const logs = [...(await fetchRange(deps.chain, known, range.fromBlock, range.toBlock))];

  // 2. Decode, then ask the same range for the polls it just announced. The
  //    clone is deployed inside `createPoll`, so its events are in this range.
  const events = decodeLogs(logs);

  const discovered = newPollAddresses(events).filter((address) => !queried.has(address));

  if (discovered.length > 0) {
    logger.info(
      { count: discovered.length, fromBlock: range.fromBlock.toString() },
      "polls created inside this range; fetching their events in the same pass",
    );

    logs.push(...(await fetchRange(deps.chain, discovered, range.fromBlock, range.toBlock)));

    // Re-decode the WHOLE batch rather than merging a second `DecodedEvents`:
    // the factory pass has already produced rows, and merging two `DecodedEvents`
    // by hand is a second implementation of the sorting this function already
    // does — the exact kind of duplicated owner that drifts.
    const combined = decodeLogs(logs);

    return await commit(deps, range, combined, discovered.length, logger);
  }

  return await commit(deps, range, events, 0, logger);
}

async function commit(
  deps: SyncDeps,
  range: { fromBlock: bigint; toBlock: bigint },
  events: DecodedEvents,
  pollsDiscovered: number,
  logger: Logger,
): Promise<SyncOutcome> {
  const { seen, inserted } = await persistBatch(deps.pool, range.toBlock, events);

  logger.info(
    {
      fromBlock: range.fromBlock.toString(),
      toBlock: range.toBlock.toString(),
      seen,
      inserted,
      pollsDiscovered,
    },
    "indexed block range",
  );

  return {
    status: "synced",
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
    seen,
    inserted,
    pollsDiscovered,
  };
}

/** The poll rows a decoded batch contains. Re-exported for callers that need it. */
export type { PollRow };

/** Reasons the sync loop stopped, for logging on shutdown. */
export interface LoopHandle {
  stop: () => void;
  done: Promise<void>;
}

/**
 * Runs `syncOnce` until stopped.
 *
 * A failing iteration never kills the loop: transient RPC and MySQL errors are
 * normal, and the cursor makes every iteration safely retryable. Backoff is
 * capped so recovery after a short outage is still prompt.
 */
export function startSyncLoop(deps: SyncDeps & { pollIntervalMs: number }): LoopHandle {
  const logger = deps.logger ?? SILENT;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const done = (async () => {
    let consecutiveFailures = 0;

    while (!stopped) {
      try {
        const outcome = await syncOnce(deps);

        consecutiveFailures = 0;

        if (outcome.status === "idle") {
          await delay(deps.pollIntervalMs);
          continue;
        }

        // Keep draining while there is a backlog; only rest once caught up.
        continue;
      } catch (error) {
        consecutiveFailures += 1;

        const backoff = Math.min(deps.pollIntervalMs * 2 ** (consecutiveFailures - 1), 60_000);

        logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            backoff,
            consecutiveFailures,
          },
          "sync iteration failed; retrying",
        );

        await delay(backoff);
      }
    }
  })();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
    done,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
