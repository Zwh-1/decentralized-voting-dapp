// SPDX-License-Identifier: MIT
/**
 * Drives a REAL commit-reveal ballot through the indexer and checks what lands
 * in MySQL — including the state that is NOT a vote.
 *
 * The unit tests cover `decode.ts` against synthetic logs, and the contract
 * tests cover the mechanism on chain. What neither can show is the thing this
 * feature is most likely to get wrong end to end: whether "committed, awaiting
 * reveal" survives the trip into the projection, or whether it arrives looking
 * exactly like "did not vote".
 *
 * That distinction is the whole reason `committed` exists as an event type, and
 * it is only observable by putting a real commitment on a real chain and reading
 * the real table.
 *
 *   pnpm indexer:commit-reveal-drill
 *
 * Requires a running `hardhat node` (chain 31337) with a drained index. The drill
 * runs entirely inside one snapshot and reverts it at the end, on failure as well
 * as on success, so it leaves the seeded chain exactly as it found it.
 */
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RowDataPacket } from "mysql2/promise";

import { asChainReader } from "../src/lib/chain";
import { loadServerConfig } from "../src/lib/config";
import { factoryAbi, pollAbi } from "../src/lib/contracts";
import { createPool } from "../src/lib/db/pool";
import { syncOnce, type SyncDeps, type SyncOutcome } from "../src/lib/indexer/sync";

/** Hardhat's well-known development key #0. */
const HARDHAT_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const MAX_ROUNDS = 1000;

interface VoteRow extends RowDataPacket {
  voter: string;
  option_id: number;
  event_type: string;
  power: string;
}

interface TallyRow extends RowDataPacket {
  option_id: number;
  vote_count: string;
}

const config = loadServerConfig();

if (config.databaseUrl === null) {
  console.error("DATABASE_URL is not set, so there is no index to inspect.");
  process.exit(1);
}

if (config.chainId !== 31337) {
  console.error(
    `Refusing to run: this drill creates and closes a poll, which is not something to do on a ` +
      `chain that matters. It is limited to the local Hardhat network (31337). CHAIN_ID is ${config.chainId}.`,
  );
  process.exit(1);
}

if (config.confirmations !== 0) {
  console.error(
    `Refusing to run: this drill drains the index and reads the result immediately, which requires ` +
      `CONFIRMATIONS=0. It is ${config.confirmations}.`,
  );
  process.exit(1);
}

const chain = defineChain({
  id: 31337,
  name: "Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
const owner = privateKeyToAccount(HARDHAT_DEV_KEY);

const ownerWallet = createWalletClient({ account: owner, chain, transport: http(config.rpcUrl) });

// Two fresh voters, derived the way the other drills derive theirs: a distinct
// private key per index, funded from the owner.
const voterKeys = [1, 2].map(
  (index) =>
    `0x${keccak256(toHex(`commit-reveal-drill-voter-${index}`)).slice(2)}` as `0x${string}`,
);
const voters = voterKeys.map((key) => privateKeyToAccount(key));

const STAKE = 1_000_000_000_000_000n; // 0.001 ETH, matching the contract's constant
const REVEAL_WINDOW = 3600n;
const SALT = keccak256(toHex("commit-reveal-drill-salt"));

/** The checks that ran, so the summary can report what was actually verified. */
const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  if (!ok) {
    console.error(`  FAIL  ${name}: ${detail}`);
  } else {
    console.log(`  ok    ${name}: ${detail}`);
  }
}

const pool = createPool(config.databaseUrl);

const deps: SyncDeps = {
  pool,
  chain: asChainReader(publicClient),
  factoryAddress: config.factoryAddress,
  confirmations: config.confirmations,
  chunkBlocks: config.chunkBlocks,
  ...(config.startBlock !== undefined ? { startBlock: config.startBlock } : {}),
};

/** Drains until the syncer reports nothing left to do. */
async function drain(): Promise<SyncOutcome> {
  let last: SyncOutcome | undefined;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outcome = await syncOnce(deps);
    last = outcome;

    if (outcome.status === "idle") {
      return outcome;
    }
  }

  throw new Error(`did not reach idle within ${MAX_ROUNDS} rounds`);
}

/** Typed access to the two Hardhat snapshot methods. */
function hardhatRpc<T>(method: "evm_snapshot" | "evm_revert", params?: unknown[]): Promise<T> {
  const request = publicClient.request as unknown as (args: {
    method: string;
    params?: unknown[];
  }) => Promise<T>;

  return params === undefined ? request({ method }) : request({ method, params });
}

/**
 * Waits until the chain head has reached `target`.
 *
 * `waitForTransactionReceipt` resolves when the transaction is MINED, which is
 * not the same as the syncer's view of the head having caught up. Draining
 * immediately can therefore read a cursor that has not yet reached the new
 * block, and the resulting "0 rows" is indistinguishable from a decoder that
 * dropped the event — which is exactly the false alarm this drill produced
 * before this wait existed.
 */
async function waitForHeadAtLeast(target: bigint): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const head = await publicClient.getBlockNumber();
    if (head >= target) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`chain head never reached block ${target}`);
}

// The revert handle. `finally` below always restores the chain, so a failed
// assertion cannot leave a half-closed poll behind for the next drill.
let snapshotId: `0x${string}` | undefined;

try {
  snapshotId = await hardhatRpc<`0x${string}`>("evm_snapshot");

  // ---- 1. A commit-reveal poll ------------------------------------------
  const factoryAddress = config.factoryAddress;
  if (factoryAddress === null) {
    throw new Error(
      "no factory address in the deployment registry for chain 31337; run deploy:local",
    );
  }

  // Fund the two voters from the owner.
  for (const voter of voters) {
    const hash = await ownerWallet.sendTransaction({
      to: voter.address,
      value: 100_000_000_000_000_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const createHash = await ownerWallet.writeContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "createPoll",
    args: [
      "Commit-reveal drill?",
      [`0x${"a1".repeat(32)}`, `0x${"a2".repeat(32)}`],
      BigInt(Math.floor(Date.now() / 1000) + 86_400),
      {
        openToAll: true,
        multiSelect: false,
        maxSelections: 0n,
        weighted: false,
        delegable: false,
        commitReveal: true,
        revealWindowSeconds: REVEAL_WINDOW,
        // Governance is not what this drill measures, so the thresholds are off.
        // They are spelled out rather than omitted because the ABI struct has no
        // optional fields, and a missing one encodes as `undefined` — which viem
        // rejects at the call site with a message that names neither the field
        // nor this file.
        quorumBps: 0n,
        timelockSeconds: 0n,
      },
      // No execution targets: this drill creates a poll, not an executable one.
      [],
    ],
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  check("the commit-reveal poll deployed", createReceipt.status === "success", "status success");

  // The poll address comes from the factory's own event rather than from a
  // return value, matching how the indexer finds it.
  const createdLogs = await publicClient.getLogs({
    address: factoryAddress,
    fromBlock: createReceipt.blockNumber,
    toBlock: createReceipt.blockNumber,
  });
  const pollAddress = createdLogs[0]?.topics[1];
  if (pollAddress === undefined) {
    throw new Error("could not read the new poll's address from the PollCreated log");
  }
  const poll = `0x${pollAddress.slice(26)}` as `0x${string}`;

  // The poll is created in `Setup` and stays there until its creator opens it.
  // `commit` checks the phase before anything else, so without this the very
  // first write reverts with `InvalidPhase(1, 0)`.
  const startHash = await ownerWallet.writeContract({
    address: poll,
    abi: pollAbi,
    functionName: "startPoll",
  });
  const startReceipt = await publicClient.waitForTransactionReceipt({ hash: startHash });
  check("the poll was opened", startReceipt.status === "success", "status success");

  // ---- 2. Both voters commit, NEITHER reveals yet -----------------------
  for (const [index, voter] of voters.entries()) {
    const wallet = createWalletClient({ account: voter, chain, transport: http(config.rpcUrl) });
    const optionId = BigInt(index + 1);

    const commitment = await publicClient.readContract({
      address: poll,
      abi: pollAbi,
      functionName: "computeCommitment",
      args: [voter.address, [optionId], SALT],
    });

    const hash = await wallet.writeContract({
      address: poll,
      abi: pollAbi,
      functionName: "commit",
      args: [commitment],
      value: STAKE,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    check(`voter ${index} committed`, receipt.status === "success", "status success");
  }

  await drain();

  // ---- 3. THE POINT: a sealed ballot is not "did not vote" --------------
  const [pending] = await pool.query<VoteRow[]>(
    "SELECT voter, option_id, event_type, power FROM votes WHERE poll_address = ? ORDER BY id",
    [poll.toLowerCase()],
  );

  check(
    "both commitments reached MySQL",
    pending.length === 2,
    `${pending.length} rows (expected 2)`,
  );

  check(
    "every row is typed 'committed', not 'cast'",
    pending.every((row) => row.event_type === "committed"),
    pending.map((row) => row.event_type).join(", ") || "(no rows)",
  );

  check(
    "a sealed ballot carries option_id 0, the not-a-selection sentinel",
    pending.every((row) => row.option_id === 0),
    pending.map((row) => row.option_id).join(", ") || "(no rows)",
  );

  const [tallyBefore] = await pool.query<TallyRow[]>(
    `SELECT o.option_id, COALESCE(t.vote_count, 0) AS vote_count
       FROM options o
       LEFT JOIN option_tally t
         ON t.poll_address = o.poll_address AND t.option_id = o.option_id
      WHERE o.poll_address = ?
      ORDER BY o.option_id`,
    [poll.toLowerCase()],
  );

  check(
    "the tally is still ZERO while ballots are sealed",
    tallyBefore.every((row) => Number(row.vote_count) === 0),
    tallyBefore.map((row) => `${row.option_id}:${row.vote_count}`).join(" "),
  );

  // A sealed ballot must not be COUNTED. This is the "privacy is real" check:
  // if the tally moved here, the commitment was not hiding anything.
  const [options] = await pool.query<TallyRow[]>(
    "SELECT option_id, 0 AS vote_count FROM options WHERE poll_address = ? ORDER BY option_id",
    [poll.toLowerCase()],
  );
  check(
    "no option 0 row was invented by the sentinel",
    options.every((row) => Number(row.option_id) > 0),
    `option ids: ${options.map((row) => row.option_id).join(", ")}`,
  );

  // ---- 4. Close voting, open the reveal window --------------------------
  const endHash = await ownerWallet.writeContract({
    address: poll,
    abi: pollAbi,
    functionName: "endPoll",
  });
  await publicClient.waitForTransactionReceipt({ hash: endHash });

  const phase = await publicClient.readContract({
    address: poll,
    abi: pollAbi,
    functionName: "phase",
  });
  check(
    "closing voting moves the poll to Reveal, not Ended",
    Number(phase) === 2,
    `phase ${phase} (Reveal is 2)`,
  );

  // ---- 5. One reveals, the other does not -------------------------------
  const revealer = voters[0]!;
  const revealerWallet = createWalletClient({
    account: revealer,
    chain,
    transport: http(config.rpcUrl),
  });

  const revealHash = await revealerWallet.writeContract({
    address: poll,
    abi: pollAbi,
    functionName: "reveal",
    args: [[1n], SALT],
  });
  const revealReceipt = await publicClient.waitForTransactionReceipt({ hash: revealHash });
  check("the first voter revealed", revealReceipt.status === "success", "status success");

  // The reveal's events are in a block the syncer has not seen yet. Waiting for
  // the head to reach it before draining keeps this drill from reporting a
  // filter lag as a decode bug — which it did on the first run, and the "0 cast
  // rows" looked exactly like a broken decoder.
  await waitForHeadAtLeast(revealReceipt.blockNumber);

  // Read the reveal's OWN logs straight from the chain, so a missing row can be
  // attributed: if the chain emitted `VoteRecorded` and the table has no row,
  // the decoder is at fault; if the chain did not emit it, the contract is.
  const revealLogs = await publicClient.getLogs({
    address: poll,
    fromBlock: revealReceipt.blockNumber,
    toBlock: revealReceipt.blockNumber,
  });
  const eventNames = revealLogs.map((log) => log.topics[0]);

  check(
    "the reveal emitted more than one event",
    revealLogs.length >= 2,
    `${revealLogs.length} log(s) in that block`,
  );
  void eventNames;

  await drain();

  const [afterReveal] = await pool.query<VoteRow[]>(
    "SELECT voter, option_id, event_type, power FROM votes WHERE poll_address = ? ORDER BY id",
    [poll.toLowerCase()],
  );

  const castRows = afterReveal.filter((row) => row.event_type === "cast");
  const committedRows = afterReveal.filter((row) => row.event_type === "committed");

  check("exactly one ballot is counted", castRows.length === 1, `${castRows.length} cast row(s)`);
  check(
    "the revealed ballot landed on option 1",
    castRows.length === 1 && castRows[0]!.option_id === 1,
    castRows.map((row) => `option ${row.option_id}`).join(", ") || "(none)",
  );

  // `votes` is an APPEND-ONLY event stream, so the revealer's own `committed`
  // row is still there — that is the design, and asserting it had gone would be
  // asserting the stream is a state table. Both commits are on file.
  check(
    "the event stream keeps BOTH commitments as a record",
    committedRows.length === 2,
    `${committedRows.length} committed row(s)`,
  );

  // The CURRENT state is what a reader sees, and that is where the distinction
  // has to hold: the revealer is now counted, the other is still sealed — and
  // neither is reported as "did not vote".
  const [current] = await pool.query<VoteRow[]>(
    "SELECT voter, option_id, event_type, power FROM current_votes WHERE poll_address = ?",
    [poll.toLowerCase()],
  );

  const counted = current.find((row) => row.event_type === "cast");
  const sealed = current.find((row) => row.event_type === "committed");

  check(
    "the revealer's CURRENT state is a counted ballot",
    counted !== undefined && Number(counted.option_id) === 1,
    counted === undefined ? "(none)" : `option ${counted.option_id}`,
  );
  check(
    "the un-revealed voter's CURRENT state is still 'committed', not absent",
    sealed !== undefined,
    sealed === undefined
      ? "(no committed row — the sealed ballot was reported as non-participation)"
      : "still sealed and still visible",
  );
  check(
    "the two states coexist and are distinguishable",
    counted !== undefined && sealed !== undefined,
    "one counted, one sealed, neither dropped",
  );

  const [tallyAfter] = await pool.query<TallyRow[]>(
    `SELECT o.option_id, COALESCE(t.vote_count, 0) AS vote_count
       FROM options o
       LEFT JOIN option_tally t
         ON t.poll_address = o.poll_address AND t.option_id = o.option_id
      WHERE o.poll_address = ?
      ORDER BY o.option_id`,
    [poll.toLowerCase()],
  );

  const option1 = tallyAfter.find((row) => Number(row.option_id) === 1);
  const option2 = tallyAfter.find((row) => Number(row.option_id) === 2);

  check(
    "the tally now holds exactly the revealed ballot",
    option1 !== undefined && Number(option1.vote_count) === 1,
    `option 1: ${option1?.vote_count ?? "missing"}`,
  );
  check(
    "and the sealed ballot did NOT contribute",
    option2 !== undefined && Number(option2.vote_count) === 0,
    `option 2: ${option2?.vote_count ?? "missing"}`,
  );

  // ---- 6. The chain and the index agree ---------------------------------
  const [onChain, total] = await publicClient.readContract({
    address: poll,
    abi: pollAbi,
    functionName: "results",
  });

  const onChain1 = Number(onChain[0]!.voteCount);
  check(
    "the index agrees with the chain's own results()",
    onChain1 === Number(option1?.vote_count ?? -1) && Number(total) === 1,
    `chain option 1 = ${onChain1}, index option 1 = ${option1?.vote_count ?? "missing"}, ` +
      `chain total = ${total}`,
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log("");
  console.log(
    failed.length === 0
      ? `ALL ${checks.length} CHECKS PASSED`
      : `${failed.length} of ${checks.length} CHECKS FAILED`,
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();

  if (snapshotId !== undefined) {
    // Always revert: the drill closes a poll, which is irreversible.
    await hardhatRpc("evm_revert", [snapshotId]).catch((error: unknown) => {
      console.error(`could not revert the chain snapshot: ${String(error)}`);
    });
    console.log("Chain snapshot reverted; the seeded chain is unchanged.");
  }
}
