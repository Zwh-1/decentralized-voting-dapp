// SPDX-License-Identifier: MIT
import type { Pool, RowDataPacket } from "mysql2/promise";

import type { Discrepancy, TallyResponse } from "./types";

/**
 * Reading the index's own answer, and comparing it with the chain's.
 *
 * Kept apart from the route handlers so it can be exercised directly by the
 * `check-consistency` script and reasoned about without HTTP in the way.
 */

interface TallyRow extends RowDataPacket {
  candidate_id: number;
  metadata_cid: string;
  vote_count: string;
}

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
 * Compares the chain's tally with the indexer's.
 *
 * This is the only "accuracy" figure this project claims, and it is a
 * deterministic equality rather than an estimate: every candidate's vote count
 * must match exactly, and so must the totals. Differences are reported per
 * candidate so a failure is diagnosable rather than merely red.
 */
export function compareTally(onChain: TallyResponse, indexed: TallyResponse): ConsistencyReport {
  const discrepancies: Discrepancy[] = [];

  const indexedById = new Map(indexed.candidates.map((candidate) => [candidate.id, candidate]));
  const onChainById = new Map(onChain.candidates.map((candidate) => [candidate.id, candidate]));

  for (const candidate of onChain.candidates) {
    const other = indexedById.get(candidate.id);

    if (other === undefined || other.voteCount !== candidate.voteCount) {
      discrepancies.push({
        candidateId: candidate.id,
        onChain: candidate.voteCount,
        indexed: other?.voteCount ?? null,
      });
    }
  }

  for (const candidate of indexed.candidates) {
    if (!onChainById.has(candidate.id)) {
      discrepancies.push({
        candidateId: candidate.id,
        onChain: null,
        indexed: candidate.voteCount,
      });
    }
  }

  return {
    consistent: discrepancies.length === 0 && onChain.total === indexed.total,
    discrepancies,
  };
}
