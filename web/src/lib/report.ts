// SPDX-License-Identifier: MIT
import type { Pool, RowDataPacket } from "mysql2/promise";
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
  candidate_id: number;
  metadata_cid: string;
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

/** The indexed projection's answer to `results()`. */
export async function readIndexedTally(pool: Pool): Promise<TallyResponse> {
  const [rows] = await pool.query<TallyRow[]>(
    "SELECT candidate_id, metadata_cid, vote_count FROM candidate_tally ORDER BY candidate_id",
  );

  const candidates = rows.map((row) => ({
    id: Number(row.candidate_id),
    metadataCid: row.metadata_cid,
    voteCount: Number(row.vote_count),
  }));

  return {
    source: "index",
    total: candidates.reduce((sum, candidate) => sum + candidate.voteCount, 0),
    candidates,
  };
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
 * `pendingVotes` is the count, per candidate, of votes found in the blocks
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

  const indexedById = new Map(indexed.candidates.map((candidate) => [candidate.id, candidate]));
  const onChainById = new Map(onChain.candidates.map((candidate) => [candidate.id, candidate]));

  for (const candidate of onChain.candidates) {
    const other = indexedById.get(candidate.id);
    const pending = pendingVotes.get(candidate.id) ?? 0;
    const expected = other === undefined ? null : other.voteCount + pending;

    if (expected === null || expected !== candidate.voteCount) {
      discrepancies.push({
        candidateId: candidate.id,
        onChain: candidate.voteCount,
        indexed: other?.voteCount ?? null,
        pending,
      });
    }
  }

  for (const candidate of indexed.candidates) {
    if (!onChainById.has(candidate.id)) {
      discrepancies.push({
        candidateId: candidate.id,
        onChain: null,
        indexed: candidate.voteCount,
        pending: pendingVotes.get(candidate.id) ?? 0,
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
 * The whole M-6 check: read both sides, account for the unindexed range, and
 * classify the result.
 *
 * Lives here rather than in the route so the UI and `check-consistency` cannot
 * drift into computing different verdicts from the same data.
 */
export async function checkConsistency(input: {
  client: PublicClient;
  pool: Pool;
  address: `0x${string}`;
  maxUnindexedBlocks?: number;
}): Promise<ConsistencyCheck> {
  const onChain = await readOnChainTally(input.client, input.address);
  const indexed = await readIndexedTally(input.pool);
  const cursor = await readCursor(input.pool);
  const head = await input.client.getBlockNumber();

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
      pendingVotes.set(vote.candidateId, (pendingVotes.get(vote.candidateId) ?? 0) + 1);
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
