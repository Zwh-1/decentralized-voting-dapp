// SPDX-License-Identifier: MIT
/**
 * Compares the chain's tally with the indexer's and reports the result.
 *
 * This is the evidence for spec metric M-6. The comparison is an exact
 * per-candidate equality, not an estimate, so the report is either "0
 * discrepancies" or a list of exactly which candidates disagree.
 *
 * Exits non-zero when the two disagree, so it can gate CI.
 *
 *   pnpm --filter @voting/indexer check-consistency
 */
import { buildChainClient, makeOnChainResultsReader } from "../chain.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { compareResults, readIndexedResults } from "../api/server.js";

const config = loadConfig();

const pool = createPool(config.databaseUrl);
const client = buildChainClient(config.chainId, config.rpcUrl);
const readOnChainResults = makeOnChainResultsReader(client, config.votingAddress);

const onChain = await readOnChainResults();
const indexed = await readIndexedResults(pool);

const report = compareResults(onChain, indexed);

console.log(
  JSON.stringify(
    {
      chainId: config.chainId,
      contract: config.votingAddress,
      candidatesCompared: onChain.candidates.length,
      onChainTotal: report.onChainTotal,
      indexedTotal: report.indexedTotal,
      consistent: report.consistent,
      discrepancyCount: report.discrepancies.length,
      discrepancies: report.discrepancies,
    },
    null,
    2,
  ),
);

await pool.end();

if (!report.consistent) {
  console.error("Indexed projection disagrees with the chain.");
  process.exit(1);
}
