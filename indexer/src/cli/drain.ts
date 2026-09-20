// SPDX-License-Identifier: MIT
/**
 * Drains the indexing backlog and exits.
 *
 * Used by the end-to-end verification: index everything, then compare the
 * result against the chain. Prints a JSON summary so the evidence is
 * machine-checkable rather than eyeballed.
 *
 *   pnpm --filter @voting/indexer drain
 */
import { asChainReader, buildChainClient } from "../chain.js";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { syncOnce } from "../indexer/sync.js";

const config = loadConfig();

await migrate(config.databaseUrl);

const pool = createPool(config.databaseUrl);
const client = buildChainClient(config.chainId, config.rpcUrl);

const deps = {
  pool,
  chain: asChainReader(client),
  address: config.votingAddress,
  confirmations: config.confirmations,
  chunkBlocks: config.chunkBlocks,
  startBlock: config.startBlock,
};

let iterations = 0;
let totalSeen = 0;
let totalInserted = 0;
let lastIndexedBlock: string | null = null;

// A generous ceiling: each iteration advances the cursor by at least one block,
// so this only trips if the chain keeps producing while we drain.
const MAX_ITERATIONS = 10_000;

for (; iterations < MAX_ITERATIONS; iterations += 1) {
  const outcome = await syncOnce(deps);

  if (outcome.status === "idle") {
    lastIndexedBlock = outcome.lastIndexedBlock?.toString() ?? null;
    break;
  }

  if (outcome.status === "rewound") {
    console.log(
      JSON.stringify({
        event: "rewound",
        rewoundTo: outcome.rewoundTo.toString(),
        discardedFrom: outcome.discardedFrom.toString(),
      }),
    );
    continue;
  }

  totalSeen += outcome.seen;
  totalInserted += outcome.inserted;
  lastIndexedBlock = outcome.toBlock.toString();
}

console.log(
  JSON.stringify(
    {
      chainId: config.chainId,
      contract: config.votingAddress,
      confirmations: config.confirmations,
      iterations,
      lastIndexedBlock,
      totalEventRowsSeen: totalSeen,
      totalEventRowsInserted: totalInserted,
      duplicatesIgnored: totalSeen - totalInserted,
    },
    null,
    2,
  ),
);

await pool.end();
