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

export interface ServerConfig {
  rpcUrl: string;
  chainId: number;
  votingAddress: `0x${string}`;
  /** null when no database is configured; the index is then disabled. */
  databaseUrl: string | null;
  confirmations: number;
  chunkBlocks: number;
  pollIntervalMs: number;
  indexerEnabled: boolean;
  startBlock: bigint | undefined;
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
 * Resolves the contract address.
 *
 * `VOTING_ADDRESS` wins when set; otherwise the address comes from the generated
 * registry, which `pnpm export-abi` fills from `contracts/deployments/*.json`.
 * That means the local development flow needs no manual address copying.
 */
function resolveAddress(env: NodeJS.ProcessEnv, chainId: number): `0x${string}` {
  const explicit = env.VOTING_ADDRESS;

  if (explicit !== undefined && explicit.length > 0) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(explicit)) {
      throw new Error(`VOTING_ADDRESS must be a 20 byte hex address, received "${explicit}"`);
    }

    return explicit as `0x${string}`;
  }

  const deployment = getDeployment(chainId);

  if (deployment === undefined) {
    throw new Error(
      `No Voting deployment recorded for chain ${chainId}. ` +
        "Deploy first, then run `pnpm export-abi`, or set VOTING_ADDRESS explicitly.",
    );
  }

  return deployment.voting;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const chainId = integer(env, "CHAIN_ID", DEFAULT_CHAIN_ID);

  const databaseUrlRaw = env.DATABASE_URL;
  const databaseUrl =
    databaseUrlRaw === undefined || databaseUrlRaw.length === 0 ? null : databaseUrlRaw;

  if (databaseUrl !== null && !databaseUrl.startsWith("mysql://")) {
    throw new Error("DATABASE_URL must be a mysql:// connection URI");
  }

  const startBlockRaw = env.START_BLOCK;
  const startBlock =
    startBlockRaw === undefined || startBlockRaw.length === 0 ? undefined : BigInt(startBlockRaw);

  return {
    rpcUrl: required(env, "RPC_URL", "http://127.0.0.1:8545"),
    chainId,
    votingAddress: resolveAddress(env, chainId),
    databaseUrl,
    confirmations: integer(env, "CONFIRMATIONS", 5),
    chunkBlocks: integer(env, "CHUNK_BLOCKS", 2000),
    pollIntervalMs: integer(env, "POLL_INTERVAL_MS", 4000),
    indexerEnabled: (env.INDEXER_ENABLED ?? "true") !== "false",
    startBlock,
  };
}

/** True when the optional MySQL index is configured. */
export function isIndexEnabled(config: ServerConfig): boolean {
  return config.databaseUrl !== null;
}
