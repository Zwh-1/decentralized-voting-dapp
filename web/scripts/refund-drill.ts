// SPDX-License-Identifier: MIT
/**
 * Drives a REAL refund through the indexer and checks what lands in MySQL.
 *
 * `refunds` is the one table in the projection that the seed never fills: the
 * seeded ballot is still in its Voting phase, so no refund is possible and the
 * table sits at zero rows. The `Refunded` decoder has unit tests and the insert
 * appears in the sync tests, but both use synthetic logs — nothing had ever
 * carried a real wei amount from the contract into `DECIMAL(38,0)`.
 *
 * That gap is worth closing, because a lossy decimal column fails *quietly*:
 * the row still appears, the API still answers, and the only symptom is a
 * number that is wrong.
 *
 *   pnpm indexer:refund-drill
 *
 * Requires a running `hardhat node` (chain 31337) with a freshly seeded,
 * drained poll, and the app stopped. `endPoll()` is irreversible, so the
 * whole scenario runs inside one snapshot and is reverted at the end — on
 * failure as well as on success.
 */
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RowDataPacket } from "mysql2/promise";

import { asChainReader, readOnChainTally } from "../src/lib/chain";
import { loadServerConfig } from "../src/lib/config";
import { factoryAbi, pollAbi } from "../src/lib/contracts";
import { migrate } from "../src/lib/db/migrate";
import { createPool } from "../src/lib/db/pool";
import { syncOnce, type SyncDeps, type SyncOutcome } from "../src/lib/indexer/sync";

/** Hardhat's well-known development key #0: this project's deployer and owner. */
const HARDHAT_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Voter 0 of the seed, derived exactly as `seed-local.ts` derives it. */
const VOTER_INDEX = 0;

const MAX_ROUNDS = 1000;

interface CountRow extends RowDataPacket {
  n: string | number;
}

interface RefundRow extends RowDataPacket {
  voter: string;
  amount_wei: string;
}

const config = loadServerConfig();

// These guards run before any client or pool exists, so `process.exit()` has no
// handle to race with here and is safe. Every exit *after* a resource is open
// must go through `process.exitCode` instead.
if (config.databaseUrl === null) {
  console.error("DATABASE_URL is not set, so there is no index to inspect.");
  process.exit(1);
}

if (config.chainId !== 31337) {
  console.error(
    `Refusing to run: this drill ends the ballot, which cannot be undone on a chain that ` +
      `matters. It is limited to the local Hardhat network (31337). CHAIN_ID is ${config.chainId}.`,
  );
  process.exit(1);
}

if (config.confirmations !== 0) {
  console.error(
    `Refusing to run: this drill ends the ballot and refunds in consecutive blocks and then ` +
      `expects both to be indexed, which only happens once they clear the confirmation window. ` +
      `With CONFIRMATIONS=${config.confirmations} they are correctly withheld, and the drill ` +
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
const owner = createWalletClient({
  account: privateKeyToAccount(HARDHAT_DEV_KEY),
  chain,
  transport: http(config.rpcUrl),
});

const voter = privateKeyToAccount(keccak256(toHex(`voting-seed-voter-${VOTER_INDEX}`)));
const voterWallet = createWalletClient({ account: voter, chain, transport: http(config.rpcUrl) });

const databaseUrl = config.databaseUrl;
await migrate(databaseUrl);
const pool = createPool(databaseUrl);

/**
 * The poll this drill operates on.
 *
 * Discovered from the factory rather than configured, for the same reason the
 * app does it: a hardcoded poll address would silently keep working against a
 * poll that no longer exists after any redeploy, and the drill would report a
 * chain-versus-index mismatch that is really just a stale constant.
 *
 * `POLL_ADDRESS` overrides it, which is what the CI job uses to pin the drill to
 * the poll the seed script created.
 */
const pollAddress: `0x${string}` = await (async (): Promise<`0x${string}`> => {
  const explicit = process.env.POLL_ADDRESS;

  if (explicit !== undefined && explicit.length > 0) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(explicit)) {
      console.error("POLL_ADDRESS must be a 20 byte hex address.");
      process.exit(1);
    }

    return explicit as `0x${string}`;
  }

  const all = await publicClient.readContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: "allPolls",
  });

  const first = all[0];

  if (first === undefined) {
    console.error(
      "The factory has created no polls, so there is nothing to drill. Run `pnpm seed:local`.",
    );
    process.exit(1);
  }

  return first;
})();

const deps: SyncDeps = {
  pool,
  chain: asChainReader(publicClient),
  factoryAddress: config.factoryAddress,
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

async function countOf(sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(sql, params);

  return Number(rows[0]?.n ?? 0);
}

function hardhatRpc<T>(method: "evm_snapshot" | "evm_revert", params?: unknown[]): Promise<T> {
  const request = publicClient.request as unknown as (args: {
    method: string;
    params?: unknown[];
  }) => Promise<T>;

  return params === undefined ? request({ method }) : request({ method, params });
}

/** A mined receipt does not guarantee the very next `eth_blockNumber` sees it. */
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

/** Nor does `evm_revert` answering `true` mean the head has moved back yet. */
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

interface Observation {
  head: bigint;
  cursor: bigint | null;
  refundRows: number;
  phaseRows: number;
  tallyTotal: number;
  phase: number;
}

async function observe(): Promise<Observation> {
  const [cursorRows] = await pool.query<(RowDataPacket & { last_block: string })[]>(
    "SELECT last_block FROM sync_cursor WHERE id = 1",
  );

  return {
    head: await publicClient.getBlockNumber(),
    cursor: cursorRows[0] === undefined ? null : BigInt(cursorRows[0].last_block),
    refundRows: await countOf("SELECT COUNT(*) AS n FROM refunds"),
    phaseRows: await countOf("SELECT COUNT(*) AS n FROM phase_events"),
    // Scoped to THIS poll, because that is what `readOnChainTally` measures. An
    // unscoped `SUM(vote_count)` silently adds up every poll in the database, so
    // the comparison below was really "one poll's chain tally" against "every
    // poll's indexed tally" — which agrees only while a single poll exists. The
    // seed creates two, so the check failed by exactly the second poll's total
    // and blamed the indexer for a measurement that was never comparable.
    tallyTotal: await countOf(
      "SELECT COALESCE(SUM(vote_count), 0) AS n FROM option_tally WHERE poll_address = ?",
      [pollAddress.toLowerCase()],
    ),
    phase: Number(
      await publicClient.readContract({
        address: pollAddress,
        abi: pollAbi,
        functionName: "phase",
      }),
    ),
  };
}

function describe(o: Observation): Record<string, unknown> {
  return {
    head: o.head.toString(),
    cursor: o.cursor?.toString() ?? null,
    phase: o.phase,
    refundRows: o.refundRows,
    phaseRows: o.phaseRows,
    tallyTotal: o.tallyTotal,
  };
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const report: Record<string, unknown> = {};
let snapshotId: string | null = null;
let snapshotConsumed = false;
let failure: string | null = null;

try {
  await drainToIdle();
  const before = await observe();
  report.before = describe(before);
  report.voter = voter.address;

  check(
    before.phase === 1,
    `expected the ballot to be in its Voting phase (1) with a fresh seed, got ${before.phase}`,
  );
  check(
    before.refundRows === 0,
    `expected an empty refunds table before the drill, found ${before.refundRows} rows`,
  );

  // What the contract itself says it owes this voter. The indexed amount is
  // checked against this rather than a hard-coded constant, so the two cannot
  // drift apart without the drill noticing.
  const owed = (await publicClient.readContract({
    address: pollAddress,
    abi: pollAbi,
    functionName: "stakeOf",
    args: [voter.address],
  })) as bigint;
  report.owedWei = owed.toString();
  check(owed > 0n, "the drill voter has no stake to refund; re-seed before running");

  // `endPoll()` is irreversible short of a revert, so everything from here
  // happens inside a snapshot.
  snapshotId = await hardhatRpc<string>("evm_snapshot");
  report.snapshot = { id: snapshotId };

  // ---- 1. Close the poll -----------------------------------------------
  const endHash = await owner.writeContract({
    address: pollAddress,
    abi: pollAbi,
    functionName: "endPoll",
  });
  const endReceipt = await publicClient.waitForTransactionReceipt({ hash: endHash });
  check(endReceipt.status === "success", `endPoll reverted (status ${endReceipt.status})`);

  await waitForHeadAbove(before.head);
  await drainToIdle();

  const ended = await observe();
  report.afterEndPoll = describe(ended);
  check(ended.phase === 2, `expected the chain to report the Ended phase (2), got ${ended.phase}`);
  check(
    ended.phaseRows === before.phaseRows + 1,
    `the PhaseChanged event was not indexed (${before.phaseRows} -> ${ended.phaseRows})`,
  );

  // ---- 2. Refund the stake ---------------------------------------------
  const refundHash = await voterWallet.writeContract({
    address: pollAddress,
    abi: pollAbi,
    functionName: "refund",
  });
  const refundReceipt = await publicClient.waitForTransactionReceipt({ hash: refundHash });
  check(refundReceipt.status === "success", `refund reverted (status ${refundReceipt.status})`);

  await waitForHeadAbove(ended.head);
  await drainToIdle();

  const refunded = await observe();
  report.afterRefund = describe(refunded);

  check(
    refunded.refundRows === before.refundRows + 1,
    `expected one refund row (${before.refundRows} -> ${before.refundRows + 1}), ` +
      `found ${refunded.refundRows}`,
  );

  // ---- 3. The amount must survive the column exactly --------------------
  const [refundRows] = await pool.query<RefundRow[]>(
    "SELECT voter, amount_wei FROM refunds ORDER BY id DESC LIMIT 1",
  );
  const row = refundRows[0];

  if (row === undefined) {
    throw new Error("the refund row is missing after the count said it was there");
  }

  report.indexedRow = { voter: row.voter, amountWei: row.amount_wei };
  check(
    row.voter.toLowerCase() === voter.address.toLowerCase(),
    `the refund row credits ${row.voter}, expected ${voter.address}`,
  );
  check(
    row.amount_wei === owed.toString(),
    `the indexed amount ${row.amount_wei} does not equal the on-chain stake ${owed}. ` +
      "A lossy DECIMAL would show up exactly here.",
  );

  // ---- 4. A refund must not disturb the tally --------------------------
  check(
    refunded.tallyTotal === before.tallyTotal,
    `refunding changed the tally: ${before.tallyTotal} -> ${refunded.tallyTotal}. ` +
      "The contract does not decrement voteCount on refund, so the index must not either.",
  );

  const onChain = await readOnChainTally(publicClient, pollAddress);
  report.consistency = { onChainTotal: onChain.total, indexedTotal: refunded.tallyTotal };
  check(
    onChain.total === refunded.tallyTotal,
    `the two sources disagree after a refund: chain ${onChain.total}, index ${refunded.tallyTotal}`,
  );

  // ---- 5. Put the chain back and watch the index undo itself -----------
  await hardhatRpc<boolean>("evm_revert", [snapshotId]);
  snapshotConsumed = true;
  await waitForHeadBelow(refunded.cursor ?? 0n);
  await drainToIdle();

  const restored = await observe();
  report.afterRevert = describe(restored);

  check(restored.phase === before.phase, `the phase did not return to ${before.phase}`);
  check(
    restored.refundRows === before.refundRows,
    `the refund row outlived the revert: ${restored.refundRows} rows, expected ${before.refundRows}`,
  );
  check(
    restored.phaseRows === before.phaseRows,
    `the endPoll phase row outlived the revert: ${restored.phaseRows}, expected ${before.phaseRows}`,
  );
  check(
    restored.tallyTotal === before.tallyTotal,
    `the tally did not return to ${before.tallyTotal}`,
  );

  report.ok = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  report.error = failure;
} finally {
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
  // `process.exitCode` rather than `process.exit()`, so the pool that `finally`
  // already closed is the only thing Node has to tear down. See the note in
  // `check-consistency.ts` for what `process.exit()` does to the exit code here.
  process.exitCode = 1;
}

console.log(
  "\nOK: a real refund reached MySQL with its exact wei amount intact, the tally was " +
    "undisturbed, and reverting the chain made the index undo both the refund and the " +
    "phase change.",
);
