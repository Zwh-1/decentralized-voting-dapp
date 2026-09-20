// SPDX-License-Identifier: MIT
import type { Pool, RowDataPacket } from "mysql2/promise";

import { decodeLogs, type DecodedEvents } from "./decode";
import { planNextRange, planReorgRewind } from "./plan";

/**
 * The only chain capability the indexer needs. Keeping it this narrow means the
 * sync loop can be unit tested against a fake, with no RPC endpoint in play.
 */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<
    readonly {
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
  address: `0x${string}`;
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
    };

const SILENT: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface CursorRow extends RowDataPacket {
  last_block: string;
}

/** Reads the persisted cursor, or null when nothing has been indexed yet. */
export async function readCursor(pool: Pool): Promise<bigint | null> {
  const [rows] = await pool.query<CursorRow[]>("SELECT last_block FROM sync_cursor WHERE id = 1");

  const first = rows[0];
  return first === undefined ? null : BigInt(first.last_block);
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
        sql: "INSERT IGNORE INTO candidates (id, metadata_cid, block_number, tx_hash, log_index) VALUES ?",
        rows: events.candidates.map((row) => [
          row.id,
          row.metadataCid,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: "INSERT IGNORE INTO votes (voter, candidate_id, block_number, tx_hash, log_index) VALUES ?",
        rows: events.votes.map((row) => [
          row.voter,
          row.candidateId,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: "INSERT IGNORE INTO refunds (voter, amount_wei, block_number, tx_hash, log_index) VALUES ?",
        rows: events.refunds.map((row) => [
          row.voter,
          row.amountWei,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: "INSERT IGNORE INTO whitelist_events (voter, allowed, block_number, tx_hash, log_index) VALUES ?",
        rows: events.whitelist.map((row) => [
          row.voter,
          row.allowed ? 1 : 0,
          row.blockNumber.toString(),
          row.txHash,
          row.logIndex,
        ]),
      },
      {
        sql: "INSERT IGNORE INTO phase_events (from_phase, to_phase, block_number, tx_hash, log_index) VALUES ?",
        rows: events.phases.map((row) => [
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

    const seen =
      events.candidates.length +
      events.votes.length +
      events.refunds.length +
      events.whitelist.length +
      events.phases.length;

    return { seen, inserted };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Drops every row above `rewindTo` after a reorg. */
async function discardAbove(pool: Pool, rewindTo: bigint): Promise<void> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const table of ["candidates", "votes", "refunds", "whitelist_events", "phase_events"]) {
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
 * Runs one unit of work: repair a reorg if one happened, otherwise index the
 * next range of finalised blocks. Exactly one of those per call, so the loop
 * makes bounded progress and is easy to reason about.
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

  const logs = await deps.chain.getLogs({
    address: deps.address,
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
  });

  const events = decodeLogs(logs);
  const { seen, inserted } = await persistBatch(deps.pool, range.toBlock, events);

  logger.info(
    {
      fromBlock: range.fromBlock.toString(),
      toBlock: range.toBlock.toString(),
      seen,
      inserted,
    },
    "indexed block range",
  );

  return {
    status: "synced",
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
    seen,
    inserted,
  };
}

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
