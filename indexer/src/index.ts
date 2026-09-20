// SPDX-License-Identifier: MIT
/**
 * Indexer + API entry point.
 *
 * Two independent concerns run here: a background loop that projects chain
 * events into MySQL, and an HTTP server that serves that projection read-only.
 * They share the pool but never a transaction.
 */
import { pino } from "pino";

import { createApp } from "./api/server.js";
import { asChainReader, buildChainClient, makeOnChainResultsReader } from "./chain.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { startSyncLoop } from "./indexer/sync.js";

const config = loadConfig();

const logger = pino({
  level: config.logLevel,
  ...(process.env.NODE_ENV === "production"
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});

logger.info(
  {
    chainId: config.chainId,
    contract: config.votingAddress,
    confirmations: config.confirmations,
    chunkBlocks: config.chunkBlocks,
    rpcUrl: config.rpcUrl,
  },
  "starting indexer",
);

await migrate(config.databaseUrl);
logger.info("schema applied");

const pool = createPool(config.databaseUrl);
const client = buildChainClient(config.chainId, config.rpcUrl);

const loop = startSyncLoop({
  pool,
  chain: asChainReader(client),
  address: config.votingAddress,
  confirmations: config.confirmations,
  chunkBlocks: config.chunkBlocks,
  startBlock: config.startBlock,
  pollIntervalMs: config.pollIntervalMs,
  logger,
});

const app = createApp({
  pool,
  chainId: config.chainId,
  votingAddress: config.votingAddress,
  confirmations: config.confirmations,
  readOnChainResults: makeOnChainResultsReader(client, config.votingAddress),
  readChainHead: () => client.getBlockNumber(),
  logger,
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "read-only API listening");
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ signal }, "shutting down");

  loop.stop();
  server.close();
  await loop.done.catch(() => undefined);
  await pool.end();

  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
