// SPDX-License-Identifier: MIT
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { PublicClient } from "viem";

import { readOnChainTally } from "./chain";
import { decodeLogs } from "./indexer/decode";
import { readCursor } from "./indexer/sync";
import type { ConsistencyStatus, Discrepancy, TallyResponse } from "./types";

/**
 * Reading the index's own answer, comparing it with the chain's, and deciding
 * what the difference means.
 *
 * Kept apart from the route handlers so `check-consistency` can run exactly the
 * same logic without HTTP in the way. That matters more than tidiness here: a
 * standalone verifier that computes its verdict differently from the one the UI
 * shows is not verifying the UI.
 */

interface TallyRow extends RowDataPacket {
  option_id: number;
  label_cid: string;
  vote_count: string;
}

/**
 * How many unindexed blocks will be reconciled before giving up.
 *
 * The indexer normally trails by exactly `CONFIRMATIONS` blocks, so this is far
 * above the routine case and only bites when the indexer has genuinely fallen
 * behind — where enumerating the gap would cost more than the answer is worth.
 */
const DEFAULT_MAX_UNINDEXED_BLOCKS = 5_000;

/**
 * The indexed projection's answer to a poll's `results()`.
 *
 * Reads `option_tally`, which is a view over the `votes` event stream — not a
 * stored counter. That is what keeps this comparison meaningful: the index
 * derives the current vote from the same events the chain does, so a
 * disagreement is a real fault rather than a difference of opinion between two
 * tallies.
 *
 * `pollAddress` became a required argument with the multi-tenant rewrite. Two
 * polls share an ABI and an event signature, so an unqualified tally would sum
 * every poll's votes into one meaningless number.
 */
export async function readIndexedTally(
  pool: Pool | PoolConnection,
  pollAddress: string,
): Promise<TallyResponse> {
  const [rows] = await pool.query<TallyRow[]>(
    `SELECT option_id, label_cid, vote_count
     FROM option_tally
     WHERE poll_address = ?
     ORDER BY option_id`,
    [pollAddress.toLowerCase()],
  );

  const options = rows.map((row) => ({
    id: Number(row.option_id),
    labelCid: row.label_cid,
    voteCount: Number(row.vote_count),
  }));

  return {
    source: "index",
    total: options.reduce((sum, option) => sum + option.voteCount, 0),
    options,
  };
}

export interface IndexedPollRow extends RowDataPacket {
  address: string;
  creator: string;
  question: string;
  ends_at: string;
  option_count: number;
}

/** Every poll the index knows about, in creation order. */
export async function readIndexedPolls(
  pool: Pool | PoolConnection,
): Promise<{ address: string; creator: string; question: string; endsAt: string }[]> {
  const [rows] = await pool.query<IndexedPollRow[]>(
    `SELECT address, creator, question, ends_at, option_count
     FROM polls
     ORDER BY block_number ASC, log_index ASC`,
  );

  return rows.map((row) => ({
    address: row.address,
    creator: row.creator,
    question: row.question,
    endsAt: row.ends_at,
  }));
}

export interface ConsistencyReport {
  consistent: boolean;
  discrepancies: Discrepancy[];
}

/**
 * Compares the chain's tally with the indexer's, allowing for votes the index
 * has not been permitted to read yet.
 *
 * Comparing the two directly is comparing different questions. The indexer
 * withholds recent blocks on purpose so a reorg cannot leave permanent bad data,
 * which means the indexed tally is *expected* to trail the chain's — so a direct
 * comparison reports a mismatch on correct behaviour, and the alarm it raises is
 * one nobody would read by the time a real fault arrived.
 *
 * `pendingVotes` is the count, per option, of votes found in the blocks
 * between the index's cursor and the chain head. Adding them back asks the only
 * question worth asking: does the index, plus everything it has not yet been
 * allowed to see, equal what the chain says?
 */
export function compareTally(
  onChain: TallyResponse,
  indexed: TallyResponse,
  pendingVotes: ReadonlyMap<number, number> = new Map(),
): ConsistencyReport {
  const discrepancies: Discrepancy[] = [];

  const indexedById = new Map(indexed.options.map((option) => [option.id, option]));
  const onChainById = new Map(onChain.options.map((option) => [option.id, option]));

  for (const option of onChain.options) {
    const other = indexedById.get(option.id);
    const pending = pendingVotes.get(option.id) ?? 0;
    const expected = other === undefined ? null : other.voteCount + pending;

    if (expected === null || expected !== option.voteCount) {
      discrepancies.push({
        optionId: option.id,
        onChain: option.voteCount,
        indexed: other?.voteCount ?? null,
        pending,
      });
    }
  }

  for (const option of indexed.options) {
    if (!onChainById.has(option.id)) {
      discrepancies.push({
        optionId: option.id,
        onChain: null,
        indexed: option.voteCount,
        pending: pendingVotes.get(option.id) ?? 0,
      });
    }
  }

  const pendingTotal = [...pendingVotes.values()].reduce((sum, n) => sum + n, 0);

  return {
    consistent: discrepancies.length === 0 && onChain.total === indexed.total + pendingTotal,
    discrepancies,
  };
}

/**
 * Decides what a comparison means, given whether the unindexed range could be
 * enumerated at all.
 *
 * A disagreement after reconciliation is a real fault. A disagreement that could
 * not be reconciled is `lagging` — inconclusive, not fine — because the gap is
 * too large to attribute the difference either way.
 */
export function classifyConsistency(
  report: ConsistencyReport,
  reconciled: boolean,
): ConsistencyStatus {
  if (report.consistent) {
    return "consistent";
  }

  return reconciled ? "divergent" : "lagging";
}

export interface ConsistencyCheck {
  status: ConsistencyStatus;
  onChain: TallyResponse;
  indexed: TallyResponse;
  discrepancies: Discrepancy[];
  /** Votes in the unindexed range that were added back before comparing. */
  pendingVotes: number;
  /** Blocks between the index's cursor and the chain head. */
  unindexedBlocks: number;
  lastIndexedBlock: bigint | null;
}

/**
 * The index's tally and the cursor it was committed with, read as one snapshot.
 *
 * These two values are meaningless apart. `option_tally` is a view over
 * `votes`, and the cursor says how far the index has consumed the chain; the
 * unindexed range is derived from the cursor and subtracted from the *difference*
 * between the two tallies. If the indexer commits a batch between reading one and
 * the other, the tally is the older of the two: a vote that arrived in that batch
 * is absent from the tally *and* excluded from the range, so it is counted on
 * neither side and the check calls a healthy index divergent. Measured on a real
 * vote: `onChainTotal 201, indexedTotal 200, lastIndexedBlock 407,
 * unindexedBlocks 0, pendingVotes 0, verdict divergent, HTTP 500`.
 *
 * A transaction is enough to close it because `persistBatch` advances the cursor
 * in the same transaction that inserts the events. Under MySQL's default
 * REPEATABLE READ the first read fixes the snapshot, so both reads here see one
 * committed state. See ADR-0017.
 */
export async function readIndexSnapshot(
  pool: Pool,
  pollAddress: string,
): Promise<{ indexed: TallyResponse; cursor: bigint | null }> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const indexed = await readIndexedTally(connection, pollAddress);
    const cursor = await readCursor(connection);

    await connection.commit();

    return { indexed, cursor };
  } finally {
    connection.release();
  }
}

/**
 * The whole M-6 check: read both sides, account for the unindexed range, and
 * classify the result.
 *
 * Lives here rather than in the route so the UI and `check-consistency` cannot
 * drift into computing different verdicts from the same data.
 *
 * The order of the reads is part of the answer, not an implementation detail:
 *
 * 1. the index snapshot, so the tally and the cursor agree;
 * 2. the chain *after* it, so the height is at least the cursor the index just
 *    reported — the indexer can only have consumed blocks that exist;
 * 3. the tally and the logs both pinned to that one height, so the chain side is a
 *    single description of one instant rather than two a block apart.
 *
 * Each of those three was a separate way to accuse a healthy index. See ADR-0017.
 */
export async function checkConsistency(input: {
  client: PublicClient;
  pool: Pool;
  address: `0x${string}`;
  maxUnindexedBlocks?: number;
}): Promise<ConsistencyCheck> {
  const { indexed, cursor } = await readIndexSnapshot(input.pool, input.address);

  const head = await input.client.getBlockNumber();
  const onChain = await readOnChainTally(input.client, input.address, head);

  const fromBlock = cursor === null ? 0n : cursor + 1n;
  const unindexedBlocks = head >= fromBlock ? Number(head - fromBlock + 1n) : 0;
  const limit = input.maxUnindexedBlocks ?? DEFAULT_MAX_UNINDEXED_BLOCKS;
  const reconciled = unindexedBlocks <= limit;

  const pendingVotes = new Map<number, number>();

  if (unindexedBlocks > 0 && reconciled) {
    const logs = await input.client.getLogs({
      address: input.address,
      fromBlock,
      toBlock: head,
    });

    for (const vote of decodeLogs(logs).votes) {
      // A `withdrawn` row carries option_id 0 and is not a vote for anything, so
      // it must not be added back as a pending vote for option 0. Only events
      // that currently back an option reconcile a shortfall.
      if (vote.eventType === "withdrawn") {
        continue;
      }

      pendingVotes.set(vote.optionId, (pendingVotes.get(vote.optionId) ?? 0) + 1);
    }
  }

  const report = compareTally(onChain, indexed, pendingVotes);

  return {
    status: classifyConsistency(report, reconciled),
    onChain,
    indexed,
    discrepancies: report.discrepancies,
    pendingVotes: [...pendingVotes.values()].reduce((sum, n) => sum + n, 0),
    unindexedBlocks,
    lastIndexedBlock: cursor,
  };
}
