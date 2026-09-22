// SPDX-License-Identifier: MIT
/**
 * Server configuration.
 *
 * Everything the server needs, validated once so a mistake surfaces as a
 * readable error rather than a confusing failure halfway through a request.
 *
 * Note that `databaseUrl` is the ONLY optional piece. Without it the app still
 * serves every page: reads fall back to the chain directly and the consistency
 * badge reports that the index is disabled. Making the database mandatory would
 * make the whole app unusable for anyone who just wants to look at a local chain.
 */
import { getDeployment } from "./contracts";
import { resolveRpcEndpoints } from "./rpc-endpoints";

export interface ServerConfig {
  /**
   * The endpoint reads are tried FIRST.
   *
   * Kept as a single value rather than replaced by `rpcUrls` because it is the
   * one the failure messages name, the one the indexer logs, and the one an
   * operator sets when they have exactly one node. `rpcUrls[0]` is always equal
   * to it, so anything holding a single URL keeps working unchanged.
   */
  rpcUrl: string;
  /**
   * Every configured endpoint, in the order they should be tried.
   *
   * Never empty: `rpcUrl` is always the first entry, so callers can iterate this
   * without a fallback branch of their own.
   */
  rpcUrls: readonly string[];
  chainId: number;
  factoryAddress: `0x${string}`;
  /** null when no database is configured; the index is then disabled. */
  databaseUrl: string | null;
  confirmations: number;
  chunkBlocks: number;
  pollIntervalMs: number;
  indexerEnabled: boolean;
  startBlock: bigint | undefined;
  /**
   * How long a cached poll-list read stays usable, in milliseconds. 0 disables
   * caching but keeps the concurrent-read collapsing.
   *
   * Defaults to two seconds. The bound is not arbitrary: it must stay far below
   * the confirmation window, which is what "final" means on this app. At 5
   * confirmations and a 12s block time that window is about a minute, so a 2s
   * cache can never show a tally older than a second or two while the app is
   * claiming a block is unconfirmed. It is still long enough to collapse the
   * duplicate reads a single page mount produces.
   *
   * It does NOT apply to the chain-versus-index comparison or to `/api/health`.
   * See `cache.ts`.
   */
  readCacheTtlMs: number;
}

const DEFAULT_CHAIN_ID = 31337;

function required(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;

  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable ${name}. Copy web/.env.example to web/.env and fill it in.`,
    );
  }

  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];

  if (raw === undefined || raw.length === 0) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received "${raw}"`);
  }

  return parsed;
}

/**
 * Every endpoint to try, in order, from `RPC_URLS` and `RPC_URL`.
 *
 * Both variables are read rather than one replacing the other, because they
 * answer different questions. `RPC_URL` is "the node", and every existing
 * deployment and every message in this codebase names it. `RPC_URLS` is "the
 * nodes, in the order I want them tried", and is what makes a single endpoint's
 * outage survivable. An operator who sets only `RPC_URL` gets exactly the old
 * single-endpoint behaviour; one who sets both gets their primary first and the
 * rest behind it, with no need to repeat the primary inside `RPC_URLS`.
 *
 * It defaults to localhost rather than being required, preserving the previous
 * behaviour where an unset `RPC_URL` still produced a usable local configuration.
 *
 * The merging rule itself lives in `rpc-endpoints.ts`, shared with the browser's
 * `wagmi.ts`, so the two sides cannot disagree about endpoint order.
 */
function resolveRpcUrls(env: NodeJS.ProcessEnv): readonly string[] {
  const fallback = required(env, "RPC_URL", "http://127.0.0.1:8545");

  return resolveRpcEndpoints(fallback, env.RPC_URLS);
}

/**
 * Resolves the factory address.
 *
 * `FACTORY_ADDRESS` wins when set; otherwise the address comes from the
 * generated registry, which `pnpm export-abi` fills from
 * `contracts/deployments/*.json`. That means the local development flow needs no
 * manual address copying.
 *
 * The poll addresses are *not* configured anywhere: they are discovered from the
 * factory's `PollCreated` events at runtime, by both the browser and the
 * indexer. A list of polls in a config file would be a second source of truth
 * for "which polls exist", and it would go stale the moment anyone created one.
 */
function resolveAddress(env: NodeJS.ProcessEnv, chainId: number): `0x${string}` {
  const explicit = env.FACTORY_ADDRESS;

  if (explicit !== undefined && explicit.length > 0) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(explicit)) {
      throw new Error(`FACTORY_ADDRESS must be a 20 byte hex address, received "${explicit}"`);
    }

    return explicit as `0x${string}`;
  }

  const deployment = getDeployment(chainId);

  if (deployment === undefined) {
    throw new Error(
      `No VotingFactory deployment recorded for chain ${chainId}. ` +
        "Deploy first, then run `pnpm export-abi`, or set FACTORY_ADDRESS explicitly.",
    );
  }

  return deployment.factory;
}

/**
 * The first block the indexer should read.
 *
 * `START_BLOCK` wins when set. Otherwise this is the block the contract was
 * deployed in, taken from the generated registry.
 *
 * Defaulting to the deployment block rather than 0 is load-bearing, not a
 * shortcut: public RPCs prune old history (Sepolia's earliest available block is
 * around 1,000,000), so a scan from genesis does not merely crawl — it fails
 * with `pruned history unavailable` a couple of thousand blocks in, and because
 * the cursor had already advanced past those blocks the failure repeats forever.
 */
function resolveStartBlock(env: NodeJS.ProcessEnv, chainId: number): bigint | undefined {
  const explicit = env.START_BLOCK;

  if (explicit !== undefined && explicit.length > 0) {
    return BigInt(explicit);
  }

  const recorded = getDeployment(chainId)?.blockNumber;

  return recorded === undefined ? undefined : BigInt(recorded);
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const chainId = integer(env, "CHAIN_ID", DEFAULT_CHAIN_ID);

  const databaseUrlRaw = env.DATABASE_URL;
  const databaseUrl =
    databaseUrlRaw === undefined || databaseUrlRaw.length === 0 ? null : databaseUrlRaw;

  if (databaseUrl !== null && !databaseUrl.startsWith("mysql://")) {
    throw new Error("DATABASE_URL must be a mysql:// connection URI");
  }

  const rpcUrls = resolveRpcUrls(env);

  // `resolveRpcEndpoints` cannot return empty here, because it is given a
  // non-empty primary from `required`. Indexing `[0]` still types as possibly
  // undefined, and this is the one place where the invariant can be stated and
  // checked rather than asserted away — a future edit that let the primary go
  // blank would then fail here with a readable message instead of producing a
  // client pointed at `undefined`.
  const [primaryRpc, ...restRpc] = rpcUrls;

  if (primaryRpc === undefined) {
    throw new Error("No RPC endpoint resolved; RPC_URL must not be empty");
  }

  return {
    rpcUrl: primaryRpc,
    rpcUrls: [primaryRpc, ...restRpc],
    chainId,
    factoryAddress: resolveAddress(env, chainId),
    databaseUrl,
    confirmations: integer(env, "CONFIRMATIONS", 5),
    chunkBlocks: integer(env, "CHUNK_BLOCKS", 2000),
    pollIntervalMs: integer(env, "POLL_INTERVAL_MS", 4000),
    indexerEnabled: (env.INDEXER_ENABLED ?? "true") !== "false",
    startBlock: resolveStartBlock(env, chainId),
    readCacheTtlMs: integer(env, "READ_CACHE_TTL_MS", 2000),
  };
}

/** True when the optional MySQL index is configured. */
export function isIndexEnabled(config: ServerConfig): boolean {
  return config.databaseUrl !== null;
}
