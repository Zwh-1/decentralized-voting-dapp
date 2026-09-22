// SPDX-License-Identifier: MIT
/**
 * Drains the indexing backlog to completion, then reports what happened.
 *
 * Prints a JSON summary because the numbers matter: `duplicatesIgnored` being
 * non-zero while the tally stays correct is the observable proof that the
 * `UNIQUE(tx_hash, log_index)` constraint makes re-indexing safe. Running this
 * twice in a row should show a large `seen` and a zero `inserted` the second
 * time, with the tally unchanged.
 */
import { buildChainClient, asChainReader } from "../src/lib/chain";
import { loadServerConfig } from "../src/lib/config";
import { migrate } from "../src/lib/db/migrate";
import { createPool } from "../src/lib/db/pool";
import { syncOnce } from "../src/lib/indexer/sync";

/** Guard against a pathological loop; a real backlog is far smaller. */
const MAX_ROUNDS = 1000;

const config = loadServerConfig();

if (config.databaseUrl === null) {
  console.error("DATABASE_URL is not set, so there is nothing to drain.");
  process.exit(1);
}

await migrate(config.databaseUrl);

const pool = createPool(config.databaseUrl);
const client = buildChainClient(config.chainId, config.rpcUrl);
const chain = asChainReader(client);

let rounds = 0;
let totalSeen = 0;
let totalInserted = 0;
let rewinds = 0;

try {
  for (; rounds < MAX_ROUNDS; rounds += 1) {
    const outcome = await syncOnce({
      pool,
      chain,
      factoryAddress: config.factoryAddress,
      confirmations: config.confirmations,
      chunkBlocks: config.chunkBlocks,
      ...(config.startBlock !== undefined ? { startBlock: config.startBlock } : {}),
    });

    if (outcome.status === "rewound") {
      rewinds += 1;
      continue;
    }

    if (outcome.status === "idle") {
      break;
    }

    totalSeen += outcome.seen;
    totalInserted += outcome.inserted;
  }
} finally {
  await pool.end();
}

console.log(
  JSON.stringify(
    {
      rounds,
      rewinds,
      totalEventRowsSeen: totalSeen,
      inserted: totalInserted,
      duplicatesIgnored: totalSeen - totalInserted,
      hitRoundLimit: rounds >= MAX_ROUNDS,
    },
    null,
    2,
  ),
);
