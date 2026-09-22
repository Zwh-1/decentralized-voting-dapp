// SPDX-License-Identifier: MIT
/**
 * The wire format shared by the API routes and the UI.
 *
 * These types live in one place so a route cannot quietly change shape without
 * the components that consume it failing to compile.
 */

export interface ApiOption {
  id: number;
  /** The metadata CID stored on chain for this option. */
  labelCid: string;
  voteCount: number;
}

export interface TallyResponse {
  /** Where these numbers came from. */
  source: "chain" | "index";
  total: number;
  options: ApiOption[];
}

/** One poll's headline facts, as the list page needs them. */
export interface PollSummary {
  address: string;
  creator: string;
  question: string;
  /**
   * The deadline as a string.
   *
   * Carried as a string, not a number: it is a `uint256` on chain, and every
   * other large integer on this wire format (block numbers, wei) is a string for
   * the same reason — JSON numbers lose precision past 2^53, and a silently
   * rounded deadline would be a wrong answer rather than a crashed one.
   */
  endsAt: string;
  optionCount: number;
  /** 0 Setup, 1 Voting, 2 Ended. Mirrors `Poll.Phase`. */
  phase: number;
  /** The contract's own tally total. */
  totalVotes: number;
}

export interface Discrepancy {
  optionId: number;
  onChain: number | null;
  indexed: number | null;
  /**
   * Votes for this option found in the unindexed range. They were already
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
  /** The factory this deployment reads polls from. */
  contract: string;
  /** How many polls the factory has created, or null when the chain was unreadable. */
  pollCount: number | null;
  confirmations: number;
  /**
   * Whether an index exists at all, i.e. whether `DATABASE_URL` is set.
   *
   * Named for what it computes. It was called `indexEnabled`, which invited the
   * reading "the indexer is running" — so a health response read `true` while
   * `INDEXER_ENABLED=false` had deliberately stopped the background loop. The two
   * are now separate fields.
   */
  indexConfigured: boolean;
  /**
   * Whether a background loop will advance that index on its own.
   *
   * True only when an index exists *and* `INDEXER_ENABLED` is not `false`.
   * `false` means the index only moves when something calls `pnpm indexer:drain`
   * or `POST /api/index/sync`. Without this field the state was unreportable: a
   * reader could see the height but not whether it would ever move by itself.
   *
   * Never `true` while `indexConfigured` is `false`: `INDEXER_ENABLED` defaults to
   * true, and reporting that default for a loop with nothing to advance would
   * claim a running indexer that does not exist.
   */
  indexerLoopEnabled: boolean;
  lastIndexedBlock: string | null;
  chainHead: string | null;
  /**
   * How many safe-to-index blocks are not in the index yet, or null when that is
   * not a question this deployment can answer.
   *
   * Null in three cases, which must not be confused with each other: the chain
   * could not be read; no index is configured, so there is no index to be behind;
   * or the index exists but its cursor could not be read. `lastIndexedBlock:
   * null` alongside a number here does **not** mean the same thing — a migrated
   * but never-synced index has no cursor either, and there "everything so far is
   * unindexed" is the true answer, so the figure is reported.
   */
  lagBlocks: string | null;
  /**
   * Why the index could not be read, or null when there is no such problem —
   * including when no index is configured at all.
   *
   * Distinct from `indexConfigured`, which says an index is *expected*. A
   * configured index whose database is down still leaves the app serving from the
   * chain, so this is a degradation to report rather than a failure to raise:
   * without it the outage would be invisible, and with it the reader knows which
   * subsystem to look at.
   */
  indexError: string | null;
}

export interface VoterResponse {
  address: string;
  source: "chain" | "index";
  whitelisted: boolean | null;
  /** True when the address currently backs an option. */
  hasVoted: boolean;
  /**
   * The option the address currently backs, or null.
   *
   * Null is now a real state rather than only "has not voted": an address that
   * withdrew its vote is back to having none, and the two must be told apart by
   * the history (`voteTxHash` / refunds), not by this field alone.
   */
  votedFor: number | null;
  /** The stake currently held for this address, in wei. */
  stakeWei: string;
  /** Everything the address did, oldest first. */
  history: VoteEventResponse[];
  voteTxHash: string | null;
  refunds: { amountWei: string; txHash: string }[];
}

/** One entry in a voter's history: a cast, a change, or a withdrawal. */
export interface VoteEventResponse {
  kind: "cast" | "changed" | "withdrawn";
  /**
   * The first option involved, or null.
   *
   * For "changed" this is the first option of the new set; for "withdrawn" it is
   * null, because a withdrawal names no option. Kept alongside `optionIds` so a
   * reader that only understands a single choice still gets a truthful answer.
   */
  optionId: number | null;
  /**
   * Every option this one action selected, ascending; empty for a withdrawal.
   *
   * Usually one element. It is an array because a multi-select vote is a single
   * on-chain log that carries the whole set, and the history must report it as
   * one action rather than one entry per option — otherwise a reader sees their
   * address voting twice in a block when it voted once for two things.
   */
  optionIds: number[];
  blockNumber: string;
  txHash: string;
}

/**
 * The polls one address currently holds a vote in.
 *
 * This is the question the chain cannot answer cheaply: there is no reverse index
 * from a voter to the polls they joined, and the factory only records who
 * *created* what. Only the index can answer it in one query — see
 * `getVotedPolls` for why that is allowed here and not elsewhere.
 */
export interface VotedPollsResponse {
  address: string;
  source: "index";
  /** Poll addresses, newest first by the block the vote landed in. */
  polls: {
    address: string;
    optionId: number;
    question: string | null;
    blockNumber: string;
    txHash: string;
  }[];
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
