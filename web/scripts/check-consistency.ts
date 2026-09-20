// SPDX-License-Identifier: MIT
/**
 * Compares the indexed tally with the chain's, and exits non-zero on any
 * disagreement.
 *
 * This is metric M-6 as a standalone command: the same comparison the
 * `/api/results` route performs, usable in CI or a cron job where an HTTP
 * response code would be awkward to check.
 */
import { buildChainClient, readOnChainTally } from "../src/lib/chain";
import { loadServerConfig } from "../src/lib/config";
import { createPool } from "../src/lib/db/pool";
import { compareTally, readIndexedTally } from "../src/lib/report";

const config = loadServerConfig();

const client = buildChainClient(config.chainId, config.rpcUrl);
const onChain = await readOnChainTally(client, config.votingAddress);

if (config.databaseUrl === null) {
  console.log(
    JSON.stringify(
      {
        mode: "chain-only",
        consistent: true,
        note: "DATABASE_URL is not set, so there is no index to compare against.",
        chainId: config.chainId,
        contract: config.votingAddress,
        onChainTotal: onChain.total,
      },
      null,
      2,
    ),
  );

  process.exit(0);
}

const pool = createPool(config.databaseUrl);

try {
  const indexed = await readIndexedTally(pool);
  const report = compareTally(onChain, indexed);

  console.log(
    JSON.stringify(
      {
        mode: "dual-source",
        consistent: report.consistent,
        chainId: config.chainId,
        contract: config.votingAddress,
        candidatesCompared: onChain.candidates.length,
        onChainTotal: onChain.total,
        indexedTotal: indexed.total,
        discrepancies: report.discrepancies,
      },
      null,
      2,
    ),
  );

  process.exit(report.consistent ? 0 : 1);
} finally {
  await pool.end();
}
