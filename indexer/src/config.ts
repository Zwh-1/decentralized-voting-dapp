// SPDX-License-Identifier: MIT
import { getDeployment } from "@voting/shared";
import { z } from "zod";

/**
 * The indexer's configuration. Everything is validated up front so a
 * misconfiguration fails at startup with a readable message instead of midway
 * through a sync against a live chain.
 */
const schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("mysql://"), "must be a mysql:// connection URI"),
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  VOTING_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20 byte hex address")
    .optional(),
  START_BLOCK: z.coerce.bigint().nonnegative().optional(),
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(5),
  CHUNK_BLOCKS: z.coerce.number().int().positive().max(100_000).default(2000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type IndexerConfig = ReturnType<typeof loadConfig>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the address lookup, used by tests. */
  addressOverride?: `0x${string}`;
}

/**
 * Reads and validates configuration.
 *
 * `VOTING_ADDRESS` may be omitted: it is then taken from `@voting/shared`,
 * which `export-abi` populates from `contracts/deployments/*.json`. That keeps
 * the contract address in exactly one place across the monorepo.
 */
export function loadConfig(options: LoadConfigOptions = {}) {
  const env = options.env ?? process.env;
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid indexer configuration:\n${details}`);
  }

  const value = parsed.data;

  let address = options.addressOverride ?? (value.VOTING_ADDRESS as `0x${string}` | undefined);

  if (address === undefined) {
    const deployment = getDeployment(value.CHAIN_ID);
    if (deployment === undefined) {
      throw new Error(
        `No Voting deployment recorded for chain ${value.CHAIN_ID}. ` +
          "Set VOTING_ADDRESS, or deploy and run `pnpm --filter @voting/contracts export-abi`.",
      );
    }
    address = deployment.voting;
  }

  return {
    databaseUrl: value.DATABASE_URL,
    rpcUrl: value.RPC_URL,
    chainId: value.CHAIN_ID,
    votingAddress: address,
    startBlock: value.START_BLOCK,
    confirmations: value.CONFIRMATIONS,
    chunkBlocks: value.CHUNK_BLOCKS,
    pollIntervalMs: value.POLL_INTERVAL_MS,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
  };
}
