// SPDX-License-Identifier: MIT
/**
 * Server-side data access.
 *
 * One place that decides where each answer comes from:
 *
 *   * the CHAIN is authoritative for the tally, the phase, whether you voted and
 *     your stake. These are never taken from the index when the index is absent,
 *     and always compared against it when it is present.
 *   * the INDEX, when configured, answers the heavier "list and count" questions
 *     and supplies history the chain does not retain cheaply (whitelist changes,
 *     refund transactions).
 *
 * When `DATABASE_URL` is unset every read falls back to the chain and the API
 * reports `chain-only`, so the app is fully usable with no database at all.
 *
 * This module is server-only: it holds a MySQL pool and an RPC client. Client
 * components must never import it.
 */
import type { Pool } from "mysql2/promise";

import {
  asChainReader,
  buildChainClient,
  readOnChainPhase,
  readOnChainTally,
  readOnChainVoter,
  type OnChainVoter,
} from "./chain";
import { isIndexEnabled, loadServerConfig, type ServerConfig } from "./config";
import { migrate } from "./db/migrate";
import { createPool } from "./db/pool";
import { lagBlocks } from "./indexer/plan";
import { readCursor, startSyncLoop, syncOnce, type Logger, type SyncOutcome } from "./indexer/sync";
import { compareTally, readIndexedTally } from "./report";
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

/** Waits until the optional schema has been applied. */
async function ready(state: ServerState): Promise<void> {
  await state.ready;
}

function requirePool(state: ServerState): Pool {
  if (state.pool === null) {
    throw new Error("The index is not configured; this read must fall back to the chain.");
  }

  return state.pool;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The tally. From MySQL when the index exists, otherwise straight from the
 * contract.
 */
export async function getTally(): Promise<TallyResponse> {
  const state = getServerState();
  await ready(state);

  if (state.pool === null) {
    return readOnChainTally(state.client, state.config.votingAddress);
  }

  return readIndexedTally(state.pool);
}

/**
 * Both answers plus the comparison between them.
 *
 * With no database this degrades honestly: `mode` becomes "chain-only",
 * `indexedTotal` is null and `consistent` is true because there is nothing to
 * disagree with. It never claims a comparison it did not perform.
 */
export async function getResults(): Promise<ResultsResponse> {
  const state = getServerState();
  await ready(state);

  const onChain = await readOnChainTally(state.client, state.config.votingAddress);

  if (state.pool === null) {
    return {
      consistent: true,
      mode: "chain-only",
      onChainTotal: onChain.total,
      indexedTotal: null,
      discrepancies: [],
      onChain,
      indexed: null,
    };
  }

  const indexed = await readIndexedTally(state.pool);
  const report = compareTally(onChain, indexed);

  return {
    consistent: report.consistent,
    mode: "dual-source",
    onChainTotal: onChain.total,
    indexedTotal: indexed.total,
    discrepancies: report.discrepancies,
    onChain,
    indexed,
  };
}

export async function getHealth(): Promise<HealthResponse> {
  const state = getServerState();
  await ready(state);

  const indexEnabled = isIndexEnabled(state.config);

  let lastIndexedBlock: bigint | null = null;
  if (state.pool !== null) {
    lastIndexedBlock = await readCursor(state.pool);
  }

  let chainHead: bigint | null = null;
  try {
    chainHead = await state.client.getBlockNumber();
  } catch {
    chainHead = null;
  }

  return {
    status: chainHead === null ? "degraded" : "ok",
    chainId: state.config.chainId,
    contract: state.config.votingAddress,
    confirmations: state.config.confirmations,
    indexEnabled,
    lastIndexedBlock: lastIndexedBlock?.toString() ?? null,
    chainHead: chainHead?.toString() ?? null,
    lagBlocks:
      chainHead === null
        ? null
        : lagBlocks({
            chainHead,
            lastIndexedBlock,
            confirmations: state.config.confirmations,
          }).toString(),
  };
}

/**
 * One voter's status.
 *
 * The chain is authoritative for `hasVoted`, `votedFor` and the stake. The index
 * only adds what the chain does not cheaply expose: the most recent whitelist
 * decision, and the refund transactions.
 */
export async function getVoter(address: `0x${string}`): Promise<VoterResponse> {
  const state = getServerState();
  await ready(state);

  let onChain: OnChainVoter;

  try {
    onChain = await readOnChainVoter(state.client, state.config.votingAddress, address);
  } catch {
    onChain = { hasVoted: false, votedFor: 0, stakeWei: 0n };
  }

  if (state.pool === null) {
    return {
      address,
      source: "chain",
      whitelisted: null,
      hasVoted: onChain.hasVoted,
      votedFor: onChain.votedFor === 0 ? null : onChain.votedFor,
      voteTxHash: null,
      refunds: [],
    };
  }

  const pool = requirePool(state);

  const [whitelistRows] = await pool.query<
    ({ allowed: number } & import("mysql2/promise").RowDataPacket)[]
  >(
    `SELECT allowed FROM whitelist_events
     WHERE voter = ?
     ORDER BY block_number DESC, log_index DESC
     LIMIT 1`,
    [address],
  );

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

  const whitelist = whitelistRows[0];
  const vote = voteRows[0];

  return {
    address,
    source: "index",
    whitelisted: whitelist === undefined ? null : whitelist.allowed === 1,
    hasVoted: onChain.hasVoted,
    votedFor: onChain.votedFor === 0 ? null : onChain.votedFor,
    voteTxHash: vote?.tx_hash ?? null,
    refunds: refundRows.map((row) => ({ amountWei: row.amount_wei, txHash: row.tx_hash })),
  };
}

/** The current phase, read from the chain. */
export async function getPhase(): Promise<number> {
  const state = getServerState();

  return readOnChainPhase(state.client, state.config.votingAddress);
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
