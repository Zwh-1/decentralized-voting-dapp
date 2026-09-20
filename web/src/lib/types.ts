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
  /**
   * Votes for this candidate found in the unindexed range. They were already
   * added to `indexed` before comparing, so a reader can tell why the raw
   * numbers differ.
   */
  pending: number;
}

/**
 * What the two-source comparison concluded.
 *
 * `lagging` is not a polite word for "fine": the unindexed range was too large
 * to reconcile, so the comparison is simply inconclusive. Its own value, rather
 * than a shade of "inconsistent", is the point — an index that trails inside the
 * confirmation window is behaving correctly, and calling that a fault would bury
 * the genuine divergence this check exists for.
 */
export type ConsistencyStatus = "unavailable" | "consistent" | "divergent" | "lagging";

export interface ResultsResponse {
  status: ConsistencyStatus;
  onChainTotal: number;
  indexedTotal: number | null;
  /** Per-candidate differences. Only meaningful when `status` is "divergent". */
  discrepancies: Discrepancy[];
  /**
   * Votes found in the blocks between the index's cursor and the chain head.
   * The indexer is not allowed to read those blocks yet, so they are added to
   * the indexed side before comparing.
   */
  pendingVotes: number;
  /** Blocks the index has not been allowed to read. Null when there is no index. */
  unindexedBlocks: number | null;
  onChain: TallyResponse;
  indexed: TallyResponse | null;
  lastIndexedBlock: string | null;
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
