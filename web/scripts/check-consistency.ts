// SPDX-License-Identifier: MIT
/**
 * Compares the indexed tally with the chain's, per poll, and reports what that
 * means.
 *
 * This is metric M-6 as a standalone command: the same comparison the
 * `/api/polls/[address]/results` route performs — literally the same function, so
 * the two cannot drift — usable in CI or a cron job where an HTTP response code
 * would be awkward to check.
 *
 * It checks EVERY poll the factory has created, not just one. A per-poll check
 * that only ever looked at the first poll would report `consistent` while a
 * second poll silently disagreed, which is the failure mode this whole metric
 * exists to catch. The command therefore exits non-zero if ANY poll is
 * divergent, and says which.
 *
 * Exit codes:
 *   0 — every poll is `consistent` (or there is nothing to conclude).
 *   0 — `unavailable` / `lagging`: nothing to conclude. Printed loudly, because
 *       a verification step that passes quietly without verifying anything is a
 *       trap, and this script is used as a verification step.
 *   1 — at least one poll is `divergent`: even after allowing for the votes the
 *       indexer is not yet allowed to read, the two sides disagree. A real fault.
 *
 * This script sets `process.exitCode` and lets Node shut down on its own rather
 * than calling `process.exit()`. `process.exit()` terminates immediately, so the
 * `finally` that closes the MySQL pool never runs, and Windows libuv then trips
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` while tearing down the
 * still-open handles — which reports a correct run as exit code 0xC0000409. For
 * a script whose entire contract is its exit code, that is fatal.
 */
import { buildChainClient, readOnChainPolls, readOnChainTally } from "../src/lib/chain";
import { loadServerConfig } from "../src/lib/config";
import { createPool } from "../src/lib/db/pool";
import { checkConsistency } from "../src/lib/report";

const config = loadServerConfig();

const client = buildChainClient(config.chainId, config.rpcUrl);

const polls = await readOnChainPolls(client, config.factoryAddress);

if (polls.length === 0) {
  // Reported as unavailable rather than consistent: there is nothing to compare,
  // and claiming agreement about no polls would be a verification step that
  // verified nothing.
  console.log(
    JSON.stringify(
      {
        status: "unavailable",
        note: "The factory has created no polls yet, so there is nothing to compare.",
        chainId: config.chainId,
        factory: config.factoryAddress,
        pollCount: 0,
      },
      null,
      2,
    ),
  );
} else if (config.databaseUrl === null) {
  const perPoll = await Promise.all(
    polls.map(async (address) => {
      const onChain = await readOnChainTally(client, address);

      return { poll: address, onChainTotal: onChain.total };
    }),
  );

  console.log(
    JSON.stringify(
      {
        status: "unavailable",
        note: "DATABASE_URL is not set, so there is no index to compare against.",
        chainId: config.chainId,
        factory: config.factoryAddress,
        pollCount: polls.length,
        polls: perPoll,
      },
      null,
      2,
    ),
  );
} else {
  const pool = createPool(config.databaseUrl);

  try {
    const checks = [];
    for (const address of polls) {
      const check = await checkConsistency({ client, pool, address });

      checks.push({
        poll: address,
        status: check.status,
        lastIndexedBlock: check.lastIndexedBlock?.toString() ?? null,
        unindexedBlocks: check.unindexedBlocks,
        pendingVotesAddedBack: check.pendingVotes,
        optionsCompared: check.onChain.options.length,
        onChainTotal: check.onChain.total,
        indexedTotal: check.indexed.total,
        discrepancies: check.discrepancies,
      });
    }

    const divergent = checks.filter((check) => check.status === "divergent");
    const inconclusive = checks.filter(
      (check) => check.status === "unavailable" || check.status === "lagging",
    );

    // The headline status is the worst verdict across polls, so a single
    // divergent poll cannot be averaged away by consistent ones.
    const status =
      divergent.length > 0 ? "divergent" : inconclusive.length > 0 ? "lagging" : "consistent";

    console.log(
      JSON.stringify(
        {
          status,
          chainId: config.chainId,
          factory: config.factoryAddress,
          confirmations: config.confirmations,
          pollCount: polls.length,
          divergentPolls: divergent.length,
          inconclusivePolls: inconclusive.length,
          polls: checks,
        },
        null,
        2,
      ),
    );

    if (divergent.length > 0) {
      console.error(
        `\nDIVERGENT: ${divergent.length} poll(s) disagree with the index: ` +
          divergent.map((check) => check.poll).join(", "),
      );
    } else if (inconclusive.length > 0) {
      console.error(
        `\nINCONCLUSIVE: ${inconclusive.length} poll(s) could not be compared ` +
          `(the index is behind or unavailable). Let the index catch up and run again.`,
      );
    }

    process.exitCode = divergent.length > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}
