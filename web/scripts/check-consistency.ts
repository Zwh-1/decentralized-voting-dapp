// SPDX-License-Identifier: MIT
/**
 * Compares the indexed tally with the chain's and reports what that means.
 *
 * This is metric M-6 as a standalone command: the same comparison the
 * `/api/results` route performs — literally the same function, so the two cannot
 * drift — usable in CI or a cron job where an HTTP response code would be
 * awkward to check.
 *
 * Exit codes:
 *   0 — `consistent`: the comparison was made and the two sources agree.
 *   0 — `unavailable` / `lagging`: nothing to conclude. Printed loudly, because
 *       a verification step that passes quietly without verifying anything is a
 *       trap, and this script is used as a verification step.
 *   1 — `divergent`: even after allowing for the votes the indexer is not yet
 *       allowed to read, the two sides disagree. A real fault.
 *
 * This script sets `process.exitCode` and lets Node shut down on its own rather
 * than calling `process.exit()`. `process.exit()` terminates immediately, so the
 * `finally` that closes the MySQL pool never runs, and Windows libuv then trips
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` while tearing down the
 * still-open handles — which reports a correct run as exit code 0xC0000409. For
 * a script whose entire contract is its exit code, that is fatal.
 */
import { buildChainClient, readOnChainTally } from "../src/lib/chain";
import { loadServerConfig } from "../src/lib/config";
import { createPool } from "../src/lib/db/pool";
import { checkConsistency } from "../src/lib/report";

const config = loadServerConfig();

const client = buildChainClient(config.chainId, config.rpcUrl);

if (config.databaseUrl === null) {
  const onChain = await readOnChainTally(client, config.votingAddress);

  console.log(
    JSON.stringify(
      {
        status: "unavailable",
        note: "DATABASE_URL is not set, so there is no index to compare against.",
        chainId: config.chainId,
        contract: config.votingAddress,
        onChainTotal: onChain.total,
      },
      null,
      2,
    ),
  );
} else {
  const pool = createPool(config.databaseUrl);

  try {
    const check = await checkConsistency({
      client,
      pool,
      address: config.votingAddress,
    });

    console.log(
      JSON.stringify(
        {
          status: check.status,
          chainId: config.chainId,
          contract: config.votingAddress,
          confirmations: config.confirmations,
          lastIndexedBlock: check.lastIndexedBlock?.toString() ?? null,
          unindexedBlocks: check.unindexedBlocks,
          pendingVotesAddedBack: check.pendingVotes,
          candidatesCompared: check.onChain.candidates.length,
          onChainTotal: check.onChain.total,
          indexedTotal: check.indexed.total,
          discrepancies: check.discrepancies,
        },
        null,
        2,
      ),
    );

    if (check.status === "lagging") {
      console.error(
        `\nINCONCLUSIVE: the index is ${check.unindexedBlocks} block(s) behind the chain head — ` +
          `more than this script will enumerate — so a disagreement cannot be attributed either ` +
          `way. Let the index catch up and run again.`,
      );
    }

    process.exitCode = check.status === "divergent" ? 1 : 0;
  } finally {
    await pool.end();
  }
}
