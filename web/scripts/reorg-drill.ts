// SPDX-License-Identifier: MIT
/**
 * Drives a REAL chain reorg against the indexer and checks that it repairs.
 *
 * The rewind path has unit tests, but those run against fakes, and a fake
 * cannot show that the real RPC, the real cursor row and the real DELETE agree
 * about where the fork happened. This drill moves a live node's head backwards
 * with Hardhat's `evm_snapshot` / `evm_revert` and then asserts the index
 * notices, discards the orphaned rows, and agrees with the chain again.
 *
 *   pnpm indexer:reorg-drill
 *
 * Requires a running `hardhat node` (chain 31337) and a drained index. It
 * refuses to run on any other chain. If it fails *before* the rewind it puts
 * the chain back; a failure after that point has already consumed the snapshot.
 * Either way the report is printed, because a drill that fails silently is
 * worth nothing.
 *
 * **Stop the app first, or set `INDEXER_ENABLED=false`.** A running server's
 * background loop repairs the reorg on its own within a poll interval, and this
 * drill would then see nothing to repair. That case is detected and reported as
 * such rather than as a broken rewind path.
 */
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RowDataPacket } from "mysql2/promise";

import { asChainReader, readOnChainTally } from "../src/lib/chain";
import { loadServerConfig } from "../src/lib/config";
import { votingAbi } from "../src/lib/contracts";
import { migrate } from "../src/lib/db/migrate";
import { createPool } from "../src/lib/db/pool";
import { syncOnce, type SyncDeps, type SyncOutcome } from "../src/lib/indexer/sync";

/**
 * Hardhat's well-known development key #0, which is also this project's
 * deployer and owner. Local-only and never funded with anything real.
 */
const HARDHAT_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Someone who has never been whitelisted, so the drill's event is unambiguous. */
const PROBE = "0x00000000000000000000000000000000deadbeef" as const;

const MAX_ROUNDS = 1000;
const PHASE_ENDED = 2;

interface CountRow extends RowDataPacket {
  n: string | number;
}

const config = loadServerConfig();

// These guards run before any client or pool exists, so `process.exit()` has no
// handle to race with here and is safe. Every exit *after* a resource is open
// must go through `process.exitCode` instead.
if (config.databaseUrl === null) {
  console.error("DATABASE_URL is not set, so there is no index to repair.");
  process.exit(1);
}

if (config.chainId !== 31337) {
  console.error(
    `Refusing to run: this drill moves a chain's head backwards, so it is limited to the ` +
      `local Hardhat network (31337). CHAIN_ID is ${config.chainId}.`,
  );
  process.exit(1);
}

if (config.confirmations !== 0) {
  console.error(
    `Refusing to run: this drill grows the chain by one block and then expects to see that ` +
      `block indexed, which only happens once it clears the confirmation window. With ` +
      `CONFIRMATIONS=${config.confirmations} the new block is correctly withheld, and the drill ` +
      `would report as a fault something that is really the setting. Use CONFIRMATIONS=0 against ` +
      `a local node.`,
  );
  process.exit(1);
}

const chain = defineChain({
  id: config.chainId,
  name: `chain-${config.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
const wallet = createWalletClient({
  account: privateKeyToAccount(HARDHAT_DEV_KEY),
  chain,
  transport: http(config.rpcUrl),
});

const databaseUrl = config.databaseUrl;
await migrate(databaseUrl);
const pool = createPool(databaseUrl);

const deps: SyncDeps = {
  pool,
  chain: asChainReader(publicClient),
  address: config.votingAddress,
  confirmations: config.confirmations,
  chunkBlocks: config.chunkBlocks,
  ...(config.startBlock !== undefined ? { startBlock: config.startBlock } : {}),
};

async function drainToIdle(): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outcome = await syncOnce(deps);

    outcomes.push(outcome);

    if (outcome.status === "idle") {
      return outcomes;
    }
  }

  throw new Error(`did not reach idle within ${MAX_ROUNDS} rounds`);
}

async function countOf(sql: string): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(sql);

  return Number(rows[0]?.n ?? 0);
}

/**
 * `evm_snapshot` and `evm_revert` are Hardhat-specific and outside viem's typed
 * JSON-RPC surface, so they go through one explicitly-cast helper instead of a
 * cast at every call site.
 */
function hardhatRpc<T>(method: "evm_snapshot" | "evm_revert", params?: unknown[]): Promise<T> {
  const request = publicClient.request as unknown as (args: {
    method: string;
    params?: unknown[];
  }) => Promise<T>;

  return params === undefined ? request({ method }) : request({ method, params });
}

interface Snapshot {
  head: bigint;
  cursor: bigint | null;
  whitelistRows: number;
  tallyTotal: number;
}

async function observe(): Promise<Snapshot> {
  const [rows] = await pool.query<(RowDataPacket & { last_block: string })[]>(
    "SELECT last_block FROM sync_cursor WHERE id = 1",
  );

  return {
    head: await publicClient.getBlockNumber(),
    cursor: rows[0] === undefined ? null : BigInt(rows[0].last_block),
    whitelistRows: await countOf("SELECT COUNT(*) AS n FROM whitelist_events"),
    tallyTotal: await countOf("SELECT COALESCE(SUM(vote_count), 0) AS n FROM candidate_tally"),
  };
}

function describe(snapshot: Snapshot): Record<string, unknown> {
  return {
    head: snapshot.head.toString(),
    cursor: snapshot.cursor?.toString() ?? null,
    whitelistRows: snapshot.whitelistRows,
    tallyTotal: snapshot.tallyTotal,
  };
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Waits for the node to report a head above `target`.
 *
 * The receipt for a mined transaction does not guarantee that the very next
 * `eth_blockNumber` on a fresh connection already reflects it, and the indexer
 * would then legitimately see nothing to do.
 */
async function waitForHeadAbove(target: bigint): Promise<bigint> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const head = await publicClient.getBlockNumber();

    if (head > target) {
      return head;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return publicClient.getBlockNumber();
}

/**
 * The mirror of `waitForHeadAbove`, and not a theoretical concern: `evm_revert`
 * answers `true` before the node's reported head has moved back, so reading the
 * head once straight afterwards sees the pre-revert number and concludes the
 * rewind never happened.
 */
async function waitForHeadBelow(target: bigint): Promise<bigint> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const head = await publicClient.getBlockNumber();

    if (head < target) {
      return head;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return publicClient.getBlockNumber();
}

const report: Record<string, unknown> = {};
let snapshotId: string | null = null;
let snapshotConsumed = false;
let failure: string | null = null;

try {
  const phase = Number(
    await publicClient.readContract({
      address: config.votingAddress,
      abi: votingAbi,
      functionName: "phase",
    }),
  );

  check(
    phase !== PHASE_ENDED,
    "the ballot is in the Ended phase, where setWhitelist reverts; re-seed and retry",
  );

  // Settle first so the "before" numbers are a real baseline.
  await drainToIdle();
  const before = await observe();
  report.before = describe(before);

  // ---- 1. Grow the chain with a real, indexable event -------------------
  snapshotId = await hardhatRpc<string>("evm_snapshot");
  report.snapshot = { id: snapshotId, headAtSnapshot: before.head.toString() };

  const txHash = await wallet.writeContract({
    address: config.votingAddress,
    abi: votingAbi,
    functionName: "setWhitelist",
    args: [[PROBE], true],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  report.transaction = {
    hash: txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
  };

  check(
    receipt.status === "success",
    `the setWhitelist transaction reverted (status ${receipt.status}), so no event was emitted`,
  );

  const awaitedHead = await waitForHeadAbove(before.head);
  check(
    awaitedHead > before.head,
    `the head never advanced past ${before.head} even though block ${receipt.blockNumber} was mined`,
  );

  await drainToIdle();
  const grown = await observe();
  report.afterGrowth = describe(grown);

  check(
    grown.whitelistRows === before.whitelistRows + 1,
    `expected the new WhitelistUpdated event to be indexed ` +
      `(${before.whitelistRows} -> ${before.whitelistRows + 1}), got ${grown.whitelistRows}`,
  );

  if (grown.cursor === null || before.cursor === null || grown.cursor <= before.cursor) {
    throw new Error(
      `the cursor did not advance past the block that carried the new event ` +
        `(${before.cursor} -> ${grown.cursor})`,
    );
  }

  const cursorAfterGrowth = grown.cursor;

  // ---- 2. Orphan those blocks: the head moves backwards -----------------
  await hardhatRpc<boolean>("evm_revert", [snapshotId]);
  snapshotConsumed = true;

  const revertedHead = await waitForHeadBelow(cursorAfterGrowth);
  report.afterRevert = {
    head: revertedHead.toString(),
    cursorBeforeRepair: cursorAfterGrowth.toString(),
  };

  check(
    revertedHead < cursorAfterGrowth,
    `evm_revert did not push the head behind the cursor ` +
      `(head ${revertedHead}, cursor ${cursorAfterGrowth}), so the rewind path was never triggered`,
  );

  // ---- 3. The indexer must notice and repair ---------------------------
  //
  // Only this process may repair it. An app left running with the background
  // loop on polls every couple of seconds, so it can rewind between the read
  // above and the `drainToIdle()` below; this drill then observes `rewound:
  // false` and, before this check existed, reported "the indexer never reported
  // a rewind" — blaming the indexer for a rewind it had already performed.
  // Naming the real cause matters more than the diagnosis being rare: a reader
  // who believes the rewind path is broken will go looking in `planReorgRewind`.
  const cursorBeforeRepair = await observe();
  if (cursorBeforeRepair.cursor !== null && cursorBeforeRepair.cursor <= revertedHead) {
    throw new Error(
      `another indexer already repaired this reorg: the cursor is back at ` +
        `${cursorBeforeRepair.cursor} while this drill expected to observe it at ${cursorAfterGrowth}. ` +
        `Something else is advancing the index — most likely a running \`next start\` with ` +
        `INDEXER_ENABLED unset or true. Stop it (or set INDEXER_ENABLED=false) and re-run.`,
    );
  }

  const repairOutcomes = await drainToIdle();
  const rewound = repairOutcomes.find((outcome) => outcome.status === "rewound");
  report.repair = {
    rewound: rewound !== undefined,
    rewoundTo: rewound?.status === "rewound" ? rewound.rewoundTo.toString() : null,
    discardedFrom: rewound?.status === "rewound" ? rewound.discardedFrom.toString() : null,
  };

  if (rewound === undefined) {
    // The other half of the race the pre-check above covers: a concurrent
    // indexer can also repair between that read and this call. In both cases the
    // rewind *did* happen, so reporting a broken rewind path would send the
    // reader to `planReorgRewind` for a bug that is not there.
    const settled = await observe();
    const repairedByAnotherIndexer =
      settled.cursor !== null && settled.cursor <= revertedHead && settled.head <= revertedHead;

    throw new Error(
      repairedByAnotherIndexer
        ? `another indexer repaired this reorg while this drill was running: the cursor is ` +
            `${settled.cursor}, already back to the reverted head ${revertedHead}, so this drill ` +
            `never got to observe the rewind. Something else is advancing the index — most likely ` +
            `a running \`next start\` with INDEXER_ENABLED unset or true. Stop it (or set ` +
            `INDEXER_ENABLED=false) and re-run. The rewind path itself was not shown to be broken.`
        : "the indexer never reported a rewind after the head moved backwards",
    );
  }

  const repaired = await observe();
  report.afterRepair = describe(repaired);

  check(
    repaired.whitelistRows === before.whitelistRows,
    `the orphaned event row survived the rewind: whitelist_events is ` +
      `${repaired.whitelistRows}, expected ${before.whitelistRows}`,
  );

  check(
    repaired.tallyTotal === before.tallyTotal,
    `the rewind changed the tally: ${before.tallyTotal} -> ${repaired.tallyTotal}. ` +
      "A rewind must discard orphaned events, never votes that are still on chain.",
  );

  // ---- 4. And the two sources must agree again --------------------------
  await drainToIdle();
  const settled = await observe();

  // Reuse the app's own reader rather than re-deriving the tuple shape here;
  // `results()` returns (Candidate[], uint256) and it is easy to bind the wrong half.
  const onChain = await readOnChainTally(publicClient, config.votingAddress);

  report.final = {
    ...describe(settled),
    onChainTotal: onChain.total,
  };

  check(
    onChain.total === settled.tallyTotal,
    `still inconsistent after the repair: chain ${onChain.total}, index ${settled.tallyTotal}`,
  );

  report.ok = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  report.error = failure;
} finally {
  // Put the chain back if we never got as far as the rewind. A drill that
  // orphans blocks and then walks away has damaged the thing it measured.
  if (snapshotId !== null && !snapshotConsumed) {
    try {
      await hardhatRpc<boolean>("evm_revert", [snapshotId]);
      report.chainRestored = true;
    } catch (error) {
      report.chainRestored = false;
      report.restoreError = error instanceof Error ? error.message : String(error);
    }
  }

  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

if (failure !== null) {
  console.error(`\nDRILL FAILED: ${failure}`);
  process.exit(1);
}

console.log(
  "\nOK: a real head rewind was detected, the orphaned event was discarded, " +
    "the tally survived, and both sources agree again.",
);
