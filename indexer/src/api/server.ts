// SPDX-License-Identifier: MIT
import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { Pool, RowDataPacket } from "mysql2/promise";

import type { Logger } from "../indexer/sync.js";
import { lagBlocks } from "../indexer/plan.js";

/**
 * The read-only HTTP API over the indexed projection.
 *
 * This service holds no private key and exposes no write path — by design, not
 * by omission. Anyone can verify that claim by reading this file: every route
 * is a GET and every query is a SELECT.
 */

export interface OnChainResults {
  candidates: { id: number; metadataCid: string; voteCount: number }[];
  total: number;
}

export interface AppDeps {
  pool: Pool;
  chainId: number;
  votingAddress: `0x${string}`;
  confirmations: number;
  /** Reads `results()` straight from the chain, for the consistency check. */
  readOnChainResults: () => Promise<OnChainResults>;
  /** Highest block the chain reports, or null when the RPC is unreachable. */
  readChainHead: () => Promise<bigint | null>;
  logger?: Logger;
}

interface TallyRow extends RowDataPacket {
  candidate_id: number;
  metadata_cid: string;
  vote_count: string;
}

interface CursorRow extends RowDataPacket {
  last_block: string;
}

interface WhitelistRow extends RowDataPacket {
  allowed: number;
}

interface VoteLookupRow extends RowDataPacket {
  candidate_id: number;
  tx_hash: string;
}

interface RefundLookupRow extends RowDataPacket {
  amount_wei: string;
  tx_hash: string;
}

/** The indexed projection's own answer to `results()`. */
export async function readIndexedResults(pool: Pool): Promise<OnChainResults> {
  const [rows] = await pool.query<TallyRow[]>(
    "SELECT candidate_id, metadata_cid, vote_count FROM candidate_tally ORDER BY candidate_id",
  );

  const candidates = rows.map((row) => ({
    id: Number(row.candidate_id),
    metadataCid: row.metadata_cid,
    voteCount: Number(row.vote_count),
  }));

  return {
    candidates,
    total: candidates.reduce((sum, candidate) => sum + candidate.voteCount, 0),
  };
}

export interface ConsistencyReport {
  consistent: boolean;
  onChainTotal: number;
  indexedTotal: number;
  discrepancies: {
    candidateId: number;
    onChain: number | null;
    indexed: number | null;
  }[];
}

/**
 * Compares the chain's tally with the indexer's.
 *
 * This is the only "accuracy" figure this project claims, and it is a
 * deterministic equality rather than an estimate: for each candidate the two
 * vote counts must match exactly, and so must the totals. Any difference is
 * reported per candidate so a failure is diagnosable rather than just red.
 */
export function compareResults(
  onChain: OnChainResults,
  indexed: OnChainResults,
): ConsistencyReport {
  const discrepancies: ConsistencyReport["discrepancies"] = [];

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
    onChainTotal: onChain.total,
    indexedTotal: indexed.total,
    discrepancies,
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");

  // The API is read-only, but it fronts an RPC-backed comparison, so keep a
  // ceiling on how often a single client can make us call the chain.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  app.get("/api/health", async (_req: Request, res: Response) => {
    const [rows] = await deps.pool.query<CursorRow[]>(
      "SELECT last_block FROM sync_cursor WHERE id = 1",
    );

    const lastIndexedBlock = rows[0] === undefined ? null : BigInt(rows[0].last_block);

    let chainHead: bigint | null = null;
    try {
      chainHead = await deps.readChainHead();
    } catch (error) {
      deps.logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "could not read chain head for /api/health",
      );
    }

    res.json({
      status: chainHead === null ? "degraded" : "ok",
      chainId: deps.chainId,
      contract: deps.votingAddress,
      confirmations: deps.confirmations,
      lastIndexedBlock: lastIndexedBlock?.toString() ?? null,
      chainHead: chainHead?.toString() ?? null,
      lagBlocks:
        chainHead === null
          ? null
          : lagBlocks({
              chainHead,
              lastIndexedBlock,
              confirmations: deps.confirmations,
            }).toString(),
    });
  });

  app.get("/api/candidates", async (_req: Request, res: Response) => {
    const indexed = await readIndexedResults(deps.pool);

    res.json({
      total: indexed.total,
      candidates: indexed.candidates.map((candidate) => ({
        id: candidate.id,
        metadataCid: candidate.metadataCid,
        voteCount: candidate.voteCount,
      })),
    });
  });

  app.get("/api/results", async (_req: Request, res: Response) => {
    const indexed = await readIndexedResults(deps.pool);

    let onChain: OnChainResults;
    try {
      onChain = await deps.readOnChainResults();
    } catch (error) {
      deps.logger?.error(
        { err: error instanceof Error ? error.message : String(error) },
        "could not read on-chain results",
      );

      res.status(503).json({
        error: "chain_unavailable",
        message: "Could not read results from the chain; the indexed copy is shown alone.",
        indexed,
      });
      return;
    }

    const report = compareResults(onChain, indexed);

    res.status(report.consistent ? 200 : 500).json({
      consistent: report.consistent,
      onChainTotal: report.onChainTotal,
      indexedTotal: report.indexedTotal,
      discrepancies: report.discrepancies,
      onChain,
      indexed,
    });
  });

  app.get("/api/voters/:address", async (req: Request, res: Response) => {
    const address = String(req.params.address);

    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res
        .status(400)
        .json({ error: "invalid_address", message: "Expected a 20 byte hex address." });
      return;
    }

    const [whitelistRows] = await deps.pool.query<WhitelistRow[]>(
      `SELECT allowed FROM whitelist_events
       WHERE voter = ?
       ORDER BY block_number DESC, log_index DESC
       LIMIT 1`,
      [address],
    );

    const [voteRows] = await deps.pool.query<VoteLookupRow[]>(
      `SELECT candidate_id, tx_hash FROM votes
       WHERE voter = ?
       ORDER BY block_number ASC, log_index ASC
       LIMIT 1`,
      [address],
    );

    const [refundRows] = await deps.pool.query<RefundLookupRow[]>(
      `SELECT amount_wei, tx_hash FROM refunds
       WHERE voter = ?
       ORDER BY block_number ASC, log_index ASC`,
      [address],
    );

    const vote = voteRows[0];

    res.json({
      address,
      whitelisted: whitelistRows[0] === undefined ? null : whitelistRows[0].allowed === 1,
      hasVoted: vote !== undefined,
      votedFor: vote?.candidate_id ?? null,
      voteTxHash: vote?.tx_hash ?? null,
      refunds: refundRows.map((row) => ({ amountWei: row.amount_wei, txHash: row.tx_hash })),
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
