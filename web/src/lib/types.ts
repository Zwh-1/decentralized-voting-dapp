// SPDX-License-Identifier: MIT
/**
 * The wire format shared by the API routes and the UI.
 *
 * These types live in one place so a route cannot quietly change shape without
 * the components that consume it failing to compile.
 */

export interface ApiCandidate {
  id: number;
  metadataCid: string;
  voteCount: number;
}

export interface TallyResponse {
  /** Where these numbers came from. */
  source: "chain" | "index";
  total: number;
  candidates: ApiCandidate[];
}

export interface Discrepancy {
  candidateId: number;
  onChain: number | null;
  indexed: number | null;
}

export interface ResultsResponse {
  /** False when the two sources disagree; the route then answers 500. */
  consistent: boolean;
  /** "chain-only" when no database is configured, so only one source exists. */
  mode: "dual-source" | "chain-only";
  onChainTotal: number;
  indexedTotal: number | null;
  discrepancies: Discrepancy[];
  onChain: TallyResponse;
  indexed: TallyResponse | null;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  chainId: number;
  contract: string;
  confirmations: number;
  indexEnabled: boolean;
  lastIndexedBlock: string | null;
  chainHead: string | null;
  lagBlocks: string | null;
}

export interface VoterResponse {
  address: string;
  source: "chain" | "index";
  whitelisted: boolean | null;
  hasVoted: boolean;
  votedFor: number | null;
  voteTxHash: string | null;
  refunds: { amountWei: string; txHash: string }[];
}

/** The outcome of one indexing pass, as returned by POST /api/index/sync. */
export interface SyncResponse {
  enabled: boolean;
  reason?: string;
  status?: "idle" | "synced" | "rewound";
  fromBlock?: string;
  toBlock?: string;
  seen?: number;
  inserted?: number;
  lastIndexedBlock?: string | null;
}
