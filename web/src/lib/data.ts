// SPDX-License-Identifier: MIT
/**
 * Server-side data access.
 *
 * One place that decides where each answer comes from:
 *
 *   * the CHAIN is authoritative for the tally, the phase, the whitelist decision,
 *     whether you voted, what you voted for and your stake. These are never taken
 *     from the index, and the chain's answer is always compared against the index
 *     when one is available.
 *   * the INDEX supplies what the chain does not cheaply expose: the vote
 *     transaction hash and the refund history.
 *
 * There are two ways for the index to be missing, and they must be handled the
 * same way, because the chain is the source of truth in both:
 *
 *   * `DATABASE_URL` is unset — the index was never configured;
 *   * `DATABASE_URL` is set but the database cannot be read — the index is down.
 *
 * In both cases every read falls back to the chain, `source` says so, and the API
 * reports the comparison as `unavailable` rather than claiming a verdict it could
 * not compute. Treating only the first case as "no index" meant a database outage
 * replaced answers the chain could still give with a 503, and the ballot page then
 * told the reader the *chain* was unreadable when it was the database that was
 * down. The outage is still visible: `/api/health` reports it in `indexError`.
 *
 * This module is server-only: it holds a MySQL pool and an RPC client. Client
 * components must never import it.
 */
import type { Pool } from "mysql2/promise";

import {
  asChainReader,
  buildChainClient,
  readOnChainTally,
  readOnChainVoter,
  type OnChainVoter,
} from "./chain";
import { isIndexEnabled, loadServerConfig, type ServerConfig } from "./config";
import { migrate } from "./db/migrate";
import { createPool } from "./db/pool";
import { lagBlocks } from "./indexer/plan";
import { readCursor, startSyncLoop, syncOnce, type Logger, type SyncOutcome } from "./indexer/sync";
import { checkConsistency, readIndexedTally } from "./report";
import type {
  HealthResponse,
  ResultsResponse,
  SyncResponse,
  TallyResponse,
  VoterResponse,
} from "./types";

/**
 * Lazily built singletons.
 *
 * Cached on `globalThis` because Next.js re-evaluates modules on hot reload in
 * development; without this every edit would leak another connection pool.
 */
interface ServerState {
  config: ServerConfig;
  client: ReturnType<typeof buildChainClient>;
  pool: Pool | null;
  ready: Promise<void>;
  syncLoopStarted: boolean;
  /**
   * The most recent reason the index could not be read, or null.
   *
   * Cleared by any successful index read, so a recovered database stops being
   * reported without a restart. Reported through `/api/health`.
   */
  indexError: string | null;
}

/** A plain key rather than a symbol: symbols are not valid interface keys. */
interface GlobalWithState {
  __votingServerState?: ServerState;
}

function initialise(): ServerState {
  const config = loadServerConfig();
  const client = buildChainClient(config.chainId, config.rpcUrl);

  const state: ServerState = {
    config,
    client,
    pool: null,
    ready: Promise.resolve(),
    syncLoopStarted: false,
    indexError: null,
  };

  if (config.databaseUrl !== null) {
    const pool = createPool(config.databaseUrl);
    state.pool = pool;
    // Applying the schema on first use keeps `next dev` a one-command start.
    state.ready = migrate(config.databaseUrl);
  }

  return state;
}

export function getServerState(): ServerState {
  const globalStore = globalThis as unknown as GlobalWithState;

  globalStore.__votingServerState ??= initialise();

  return globalStore.__votingServerState;
}

/**
 * Waits until the optional schema has been applied.
 *
 * A failure here is recorded rather than thrown. Applying the schema happens once
 * per process, and when it fails it means the index is unreachable — not that the
 * process is broken. Throwing would take down reads the chain can still answer,
 * and the caller would be told the chain was unreadable when it was not.
 */
async function ready(state: ServerState): Promise<void> {
  try {
    await state.ready;
  } catch (error) {
    recordIndexFailure(state, error);
  }
}

/** Remembers why the index could not be read, for `/api/health` to report. */
function recordIndexFailure(state: ServerState, error: unknown): void {
  state.indexError = error instanceof Error ? error.message : String(error);
}

/** Clears a previously recorded failure: the index answered this time. */
function recordIndexSuccess(state: ServerState): void {
  state.indexError = null;
}

/**
 * Reads from the index, falling back to the chain when the index cannot be read.
 *
 * `DATABASE_URL` being set makes the index *expected*, not *guaranteed*. The two
 * ways it can be missing — never configured, and configured but down — must lead
 * to the same place for any question the chain can answer, because the chain is
 * the source of truth either way (ADR-0001). Letting only the first fall back
 * meant a MySQL outage replaced answers the chain could still give with a 503,
 * and the page then reported that the *chain* was unreadable.
 *
 * The failure is not swallowed: it is recorded so `/api/health` shows the outage,
 * and the returned `source` tells the client which path answered.
 */
async function withIndex<T>(
  state: ServerState,
  readFromIndex: (pool: Pool) => Promise<T>,
  readFromChain: () => Promise<T>,
): Promise<T> {
  if (state.pool === null) {
    return readFromChain();
  }

  try {
    const value = await readFromIndex(state.pool);
    recordIndexSuccess(state);

    return value;
  } catch (error) {
    recordIndexFailure(state, error);

    return readFromChain();
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The tally. From MySQL when the index answers, otherwise straight from the
 * contract.
 */
export async function getTally(): Promise<TallyResponse> {
  const state = getServerState();
  await ready(state);

  return withIndex(
    state,
    (pool) => readIndexedTally(pool),
    () => readOnChainTally(state.client, state.config.votingAddress),
  );
}

/** The shape reported when the two sources cannot be compared at all. */
function withoutComparison(onChain: TallyResponse): ResultsResponse {
  return {
    status: "unavailable",
    onChainTotal: onChain.total,
    indexedTotal: null,
    discrepancies: [],
    pendingVotes: 0,
    unindexedBlocks: null,
    onChain,
    indexed: null,
    lastIndexedBlock: null,
  };
}

/**
 * Both answers plus the comparison between them.
 *
 * With no usable index this degrades honestly: `status` becomes "unavailable",
 * `indexedTotal` is null, and no comparison is claimed. That applies whether the
 * index was never configured or is configured and unreachable — in both cases
 * nothing was compared, so nothing may be asserted.
 *
 * The comparison itself lives in `checkConsistency` so that this route and the
 * `check-consistency` script cannot drift into different verdicts.
 */
export async function getResults(): Promise<ResultsResponse> {
  const state = getServerState();
  await ready(state);

  // Read the chain first and let a failure propagate: this endpoint's whole
  // purpose is the comparison, and it cannot report a chain-side number it does
  // not have. An index-side failure below is a different matter — the comparison
  // is simply not available.
  const onChain = await readOnChainTally(state.client, state.config.votingAddress);

  if (state.pool === null) {
    return withoutComparison(onChain);
  }

  let check;
  try {
    check = await checkConsistency({
      client: state.client,
      pool: state.pool,
      address: state.config.votingAddress,
    });
    recordIndexSuccess(state);
  } catch (error) {
    recordIndexFailure(state, error);

    return withoutComparison(onChain);
  }

  return {
    status: check.status,
    onChainTotal: check.onChain.total,
    indexedTotal: check.indexed.total,
    discrepancies: check.discrepancies,
    pendingVotes: check.pendingVotes,
    unindexedBlocks: check.unindexedBlocks,
    onChain: check.onChain,
    indexed: check.indexed,
    lastIndexedBlock: check.lastIndexedBlock?.toString() ?? null,
  };
}

export async function getHealth(): Promise<HealthResponse> {
  const state = getServerState();
  await ready(state);

  const indexConfigured = isIndexEnabled(state.config);

  let lastIndexedBlock: bigint | null = null;
  // `lastIndexedBlock === null` does not mean "the lag is unknown". A configured
  // index that has been migrated but never synced also has no cursor row, and
  // there "every safe block so far is unindexed" is the real answer. Telling the
  // two apart is what keeps the `lagBlocks` figure below honest, so track the
  // read itself rather than inferring it from the value.
  let cursorKnown = false;
  if (state.pool !== null) {
    try {
      lastIndexedBlock = await readCursor(state.pool);
      cursorKnown = true;
      recordIndexSuccess(state);
    } catch (error) {
      // Reported, not raised: the chain half of this response is still true, and
      // an index that is down is a degradation rather than a failure to answer.
      recordIndexFailure(state, error);
    }
  }

  let chainHead: bigint | null = null;
  try {
    chainHead = await state.client.getBlockNumber();
  } catch {
    chainHead = null;
  }

  return {
    status: chainHead === null || state.indexError !== null ? "degraded" : "ok",
    chainId: state.config.chainId,
    contract: state.config.votingAddress,
    confirmations: state.config.confirmations,
    indexConfigured,
    // The flag alone is not the answer. `INDEXER_ENABLED` defaults to true, so
    // with no database configured it would report `true` for a loop that has
    // nothing to advance and never runs — the same "the name claims more than the
    // code does" trap this pair of fields exists to close.
    indexerLoopEnabled: indexConfigured && state.config.indexerEnabled,
    lastIndexedBlock: lastIndexedBlock?.toString() ?? null,
    chainHead: chainHead?.toString() ?? null,
    // Null whenever a lag figure would be a claim this response cannot support:
    // no index exists, or the cursor could not be read. Both cases used to report
    // `safeHead + 1` — the same number an empty cursor legitimately reports — so a
    // deployment with no index at all, and one whose database was unreachable,
    // each published a concrete "lag" that described neither. An empty cursor on
    // a live index still reports the real figure, because there the answer really
    // is "every safe block so far is unindexed".
    lagBlocks:
      chainHead === null || !cursorKnown
        ? null
        : lagBlocks({
            chainHead,
            lastIndexedBlock,
            confirmations: state.config.confirmations,
          }).toString(),
    indexError: state.indexError,
  };
}

/**
 * One voter's status.
 *
 * The chain is authoritative for the whitelist decision, whether they voted, what
 * they voted for and the stake. The index only adds what the chain does not
 * cheaply expose: the vote transaction hash and the refund transactions.
 *
 * A failure to read the chain is deliberately *not* caught. Substituting
 * `hasVoted: false` used to make a chain outage report that nobody had voted —
 * a confident false answer to the one question this endpoint exists for. The
 * route turns the throw into a 503, which is the honest reply.
 */
export async function getVoter(address: `0x${string}`): Promise<VoterResponse> {
  const state = getServerState();
  await ready(state);

  const onChain = await readOnChainVoter(state.client, state.config.votingAddress, address);

  const fromChain: VoterResponse = {
    address,
    source: "chain",
    whitelisted: onChain.isWhitelisted,
    hasVoted: onChain.hasVoted,
    votedFor: onChain.votedFor === 0 ? null : onChain.votedFor,
    voteTxHash: null,
    refunds: [],
  };

  if (state.pool === null) {
    return fromChain;
  }

  const pool = state.pool;

  try {
    const [voteRows] = await pool.query<
      ({ tx_hash: string } & import("mysql2/promise").RowDataPacket)[]
    >(
      `SELECT tx_hash FROM votes
       WHERE voter = ?
       ORDER BY block_number ASC, log_index ASC
       LIMIT 1`,
      [address],
    );

    const [refundRows] = await pool.query<
      ({ amount_wei: string; tx_hash: string } & import("mysql2/promise").RowDataPacket)[]
    >(
      `SELECT amount_wei, tx_hash FROM refunds
       WHERE voter = ?
       ORDER BY block_number ASC, log_index ASC`,
      [address],
    );

    const vote = voteRows[0];

    recordIndexSuccess(state);

    return {
      address,
      source: "index",
      // From the chain, not from `whitelist_events`. The mapping getter is the
      // current decision by construction, so a lagging index cannot make this
      // wrong — the same reasoning ADR-0009 applies to the ballot's buttons.
      whitelisted: onChain.isWhitelisted,
      hasVoted: onChain.hasVoted,
      votedFor: onChain.votedFor === 0 ? null : onChain.votedFor,
      voteTxHash: vote?.tx_hash ?? null,
      refunds: refundRows.map((row) => ({ amountWei: row.amount_wei, txHash: row.tx_hash })),
    };
  } catch (error) {
    // The index supplied only the transaction hash and the refund history. Losing
    // those is a loss of detail, not of the answer, so fall back to the chain-only
    // shape and say which source answered.
    recordIndexFailure(state, error);

    return fromChain;
  }
}

// ---------------------------------------------------------------------------
// Writing to the index
// ---------------------------------------------------------------------------

/**
 * Runs one indexing pass.
 *
 * Exposed as an API route so the index can be advanced on demand (and by cron),
 * independently of the background loop. Returns `enabled: false` rather than
 * throwing when no database is configured, so a caller can treat "there is no
 * index" as a normal condition.
 */
export async function runSyncOnce(): Promise<SyncResponse> {
  const state = getServerState();
  await ready(state);

  if (state.pool === null) {
    return { enabled: false, reason: "DATABASE_URL is not set; the index is disabled." };
  }

  const outcome: SyncOutcome = await syncOnce({
    pool: state.pool,
    chain: asChainReader(state.client),
    address: state.config.votingAddress,
    confirmations: state.config.confirmations,
    chunkBlocks: state.config.chunkBlocks,
    ...(state.config.startBlock !== undefined ? { startBlock: state.config.startBlock } : {}),
  });

  if (outcome.status === "synced") {
    return {
      enabled: true,
      status: "synced",
      fromBlock: outcome.fromBlock.toString(),
      toBlock: outcome.toBlock.toString(),
      seen: outcome.seen,
      inserted: outcome.inserted,
    };
  }

  if (outcome.status === "rewound") {
    return { enabled: true, status: "rewound", toBlock: outcome.rewoundTo.toString() };
  }

  return {
    enabled: true,
    status: "idle",
    lastIndexedBlock: outcome.lastIndexedBlock?.toString() ?? null,
  };
}

/**
 * Starts a background polling loop, once per process.
 *
 * Driven from `instrumentation.ts` so `next dev` and `next start` index
 * continuously without anyone remembering to run a second command. The on-demand
 * route above remains the reliable path, because a long-running loop is exactly
 * the kind of thing that quietly does not start in a serverless deployment.
 */
export async function ensureSyncLoop(): Promise<void> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null || !state.config.indexerEnabled || state.syncLoopStarted) {
    return;
  }

  state.syncLoopStarted = true;

  // The loop itself lives in the indexer as `startSyncLoop`, which is also what
  // the `drain` script drives. Reusing it keeps one owner of the backoff policy
  // so the two entry points cannot drift apart.
  const handle = startSyncLoop({
    pool,
    chain: asChainReader(state.client),
    address: state.config.votingAddress,
    confirmations: state.config.confirmations,
    chunkBlocks: state.config.chunkBlocks,
    pollIntervalMs: state.config.pollIntervalMs,
    logger: consoleLogger(),
    ...(state.config.startBlock !== undefined ? { startBlock: state.config.startBlock } : {}),
  });

  // Deliberately not awaited: the loop runs for the lifetime of the process.
  void handle.done;
}

/** Routes the loop's structured logging into the server console. */
function consoleLogger(): Logger {
  return {
    info: (obj, msg) => console.log(msg ?? "indexer", obj),
    warn: (obj, msg) => console.warn(msg ?? "indexer", obj),
    error: (obj, msg) => console.error(msg ?? "indexer", obj),
  };
}
