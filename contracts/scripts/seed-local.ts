// SPDX-License-Identifier: MIT
/**
 * Seeds a local chain for the end-to-end verification.
 *
 * Deploys `VotingFactory`, creates one poll through it, whitelists 200 freshly
 * derived accounts, opens the poll and has every one of them vote once. 200
 * distinct voters is the point: every vote must be accepted, so the on-chain
 * tally is exactly 200 and the indexer has something with real volume to
 * disagree with.
 *
 * A second, smaller poll is created too. It costs almost nothing and it is the
 * only way the local verification can prove that two polls keep separate
 * tallies — a shared-tally bug would pass a single-poll seed and fail this one.
 *
 * Option CIDs are not written here. They come from `metadata/manifest.json`,
 * each one proved to name the document beside it (`seedableCids`), because a
 * hand-written CID is a claim the repository cannot check — which is how a live
 * ballot came to store `bafyseededcandidate0`, a string that is not a CID.
 *
 *   pnpm --filter @voting/contracts seed:local
 *
 * Writes the deployment to `deployments/<chainId>.json`, the same record
 * `deploy.ts` writes, so `export-abi` publishes it to web/src/lib/contracts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";
import { createWalletClient, defineChain, http, parseEther, toHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { seedableCids } from "./metadata";

// `LOCALHOST_RPC_URL` first, so one variable retargets both the Hardhat network
// this script borrows its funded accounts from and the transport it sends on.
const RPC_URL = process.env.LOCALHOST_RPC_URL ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
const VOTER_COUNT = Number(process.env.VOTER_COUNT ?? 200);
const STAKE = 1_000_000_000_000_000n; // 0.001 ether, must equal Poll.STAKE

const DAY = 24n * 60n * 60n;

/**
 * The default mechanism set with admission chosen.
 *
 * `createPoll` takes a `PollConfig` struct, so each poll below states its
 * mechanisms rather than omitting them. Written as a function so that the seed
 * script's two polls differ in exactly one visible place — the admission mode —
 * instead of in two blocks of six literals a reader has to diff by eye.
 */
function DEFAULT_CONFIG(openToAll: boolean) {
  return {
    openToAll,
    multiSelect: false,
    maxSelections: 0n,
    weighted: false,
    delegable: false,
    commitReveal: false,
    revealWindowSeconds: 0n,
    // The two governance fields were added to `PollConfig` in batch 2 and were
    // missing here, which made every `createPoll` call fail to encode. Both are
    // deliberately zero: "no quorum" and "no execution delay" are the mechanism
    // set the consistency check's baseline numbers were measured against, so
    // seeding anything else here would move the baseline out from under it.
    quorumBps: 0n,
    timelockSeconds: 0n,
  };
}

/** The pinned documents, in option order. Ids are 1-based, as in the contract. */
const CIDS = await seedableCids();

const { viem } = await network.create();

const [deployer] = await viem.getWalletClients();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const transport = http(RPC_URL);

console.log(`Seeding chain ${chainId} at ${RPC_URL}`);

// `sendDeploymentTransaction` rather than `deployContract`: the deployment
// transaction's receipt is the only way to learn the creation block, and the
// record written below has to carry it. `deploy.ts` writes the same file, and a
// record without `blockNumber` makes the index start at block 0 — which strands
// it permanently on any RPC that prunes history (see the design spec, 校正 10).
const { contract: factory, deploymentTransaction } =
  await viem.sendDeploymentTransaction("VotingFactory");
const deploymentReceipt = await publicClient.waitForTransactionReceipt({
  hash: deploymentTransaction.hash,
});
const implementation = await factory.read.implementation();
console.log(
  `VotingFactory deployed at ${factory.address} in block ${deploymentReceipt.blockNumber}`,
);
console.log(`Poll implementation at ${implementation}`);

// ---------------------------------------------------------------------
// Poll 1: the main one, 200 voters, all option CIDs.
// ---------------------------------------------------------------------

// The deadline is computed from the CHAIN's clock, never from this machine's.
//
// These are not the same thing, and the difference is not academic: the
// `refund-drill` script advances the local chain's clock (via `evm_increaseTime`)
// by the refund grace period so it can reach the Ended phase, which leaves the
// chain timestamp weeks ahead of wall-clock time. `createPoll` reverts with
// `DeadlineNotInFuture` when the deadline is not strictly in the future *by the
// chain's own clock*, so a wall-clock deadline can be rejected as already
// expired even though it looks 30 days away to the machine that computed it —
// which is exactly what happened: the chain sat ~30 days ahead, `Date.now() + 30
// days` landed 25 minutes in the past, and this script failed with an
// unreadable custom-error revert.
//
// Reading `latest.timestamp` makes the script correct on any chain, at any
// clock offset, and matches what `create-poll.ts` already does.
const latest = await publicClient.getBlock({ blockTag: "latest" });
const now = latest.timestamp;
const endsAt = now + 30n * DAY;

const createHash = await factory.write.createPoll([
  "Which proposal should the community fund first?",
  CIDS,
  endsAt,
  // Whitelisted, so the local chain has a poll that exercises the list path.
  // Every mechanism is off: this is the default configuration, which is what
  // the consistency check's baseline numbers are measured against.
  DEFAULT_CONFIG(false),
  // The fifth argument is the execution target list. Empty means the poll may
  // only call itself, which is the safe default and the same choice the create
  // form makes. This argument was MISSING here until it was caught by running
  // `ui-drill` against a fresh deployment: `createPoll` gained the parameter in
  // batch 2 and this script was not updated with it, so `pnpm seed:local` failed
  // with "ABI encoding params/values length mismatch" while every test kept
  // passing — the seed script is a dev convenience outside `pnpm test`, so
  // nothing in the suite could notice.
  [],
]);
const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

// The poll address is read back from the factory rather than decoded from the
// receipt: the factory is the authority on which polls exist, so a decode
// mistake cannot make this script and the chain disagree.
const pollAddress = await factory.read.pollAt([0n]);
console.log(`Poll 1 created at ${pollAddress} (block ${createReceipt.blockNumber})`);
for (const cid of CIDS) {
  console.log(`  option cid: ${cid}`);
}

const poll = await viem.getContractAt("Poll", pollAddress);

// Deterministic accounts, so a re-run reproduces exactly the same voters.
const voters = Array.from({ length: VOTER_COUNT }, (_, i) => {
  const privateKey = keccak256(toHex(`voting-seed-voter-${i}`));
  return { account: privateKeyToAccount(privateKey), index: i };
});

await poll.write.setWhitelist([voters.map((voter) => voter.account.address), true]);
console.log(`Whitelisted ${VOTER_COUNT} voters on poll 1`);

await poll.write.startPoll();
console.log("Poll 1 opened");

// Fund and vote, one account at a time. Sequential on purpose: a local node
// automines, so this keeps nonce handling trivial and the log readable.
let accepted = 0;
const tally = new Array<number>(CIDS.length).fill(0);

for (const voter of voters) {
  const wallet = createWalletClient({ account: voter.account, chain, transport });

  const fundingHash = await deployer.sendTransaction({
    account: deployer.account,
    chain,
    to: voter.account.address,
    value: parseEther("0.01"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundingHash });

  const optionId = (voter.index % CIDS.length) + 1;

  const hash = await wallet.writeContract({
    address: pollAddress,
    abi: poll.abi,
    functionName: "vote",
    // A set of one: `vote` takes the whole selection under every mechanism, so
    // the single-choice case is a one-element array rather than a bare id.
    args: [[optionId]],
    value: STAKE,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  accepted += 1;
  tally[optionId - 1] = (tally[optionId - 1] ?? 0) + 1;
}

// ---------------------------------------------------------------------
// Poll 2: a second poll with a smaller electorate, so the local chain has two
// polls to keep apart. Deliberately different options and different voters.
// ---------------------------------------------------------------------

const secondHash = await factory.write.createPoll([
  "Which two options should be merged?",
  [CIDS[0]!, CIDS[1]!],
  endsAt,
  // Open, with NO `setWhitelist` below — the point of this second poll is that a
  // reader can vote in it without the creator having added them first. Seeding
  // one of each mode keeps both admission paths present on a fresh local chain,
  // so a UI regression in either one is reachable without hand-built state.
  DEFAULT_CONFIG(true),
  // No execution targets, for the same reason as the first poll: an empty list
  // keeps a passed vote from reaching anything but the poll itself.
  [],
]);
await publicClient.waitForTransactionReceipt({ hash: secondHash });

const secondAddress = await factory.read.pollAt([1n]);
const secondPoll = await viem.getContractAt("Poll", secondAddress);

const secondVoters = voters.slice(0, 5);
await secondPoll.write.startPoll();

for (const [index, voter] of secondVoters.entries()) {
  const wallet = createWalletClient({ account: voter.account, chain, transport });
  const optionId = (index % 2) + 1;

  const hash = await wallet.writeContract({
    address: secondAddress,
    abi: secondPoll.abi,
    functionName: "vote",
    args: [[optionId]],
    value: STAKE,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

const [, secondTotal] = await secondPoll.read.results();
console.log(`Poll 2 created at ${secondAddress} with ${secondTotal} votes`);

// ---------------------------------------------------------------------
// Record and report
// ---------------------------------------------------------------------

const [options, total] = await poll.read.results();

// The chain head after seeding — deliberately not the same thing as the
// deployment block recorded below.
const headBlock = await publicClient.getBlockNumber();

const outDir = path.resolve(import.meta.dirname, "..", "deployments");
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, `${chainId}.json`),
  `${JSON.stringify(
    {
      chainId,
      // Must match `deploy.ts` byte for byte, including case: this is the same
      // record, and the generated registry derived from it is what CI diffs.
      factory: factory.address.toLowerCase(),
      implementation: implementation.toLowerCase(),
      deployer: deployer.account.address.toLowerCase(),
      deployedAt: new Date().toISOString(),
      // Must match `deploy.ts`. This field is what tells the indexer where to
      // begin; omitting it here silently sent the index back to block 0.
      blockNumber: Number(deploymentReceipt.blockNumber),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  JSON.stringify(
    {
      chainId,
      factory: factory.address,
      pollCount: Number(await factory.read.pollCount()),
      polls: [
        { index: 0, address: pollAddress, votes: Number(total) },
        { index: 1, address: secondAddress, votes: Number(secondTotal) },
      ],
      voters: VOTER_COUNT,
      acceptedVotes: accepted,
      onChainTotal: Number(total),
      perOption: options.map((option) => ({
        id: Number(option.id),
        cid: option.labelCID,
        voteCount: Number(option.voteCount),
      })),
      expectedTally: tally,
      headBlock: Number(headBlock),
    },
    null,
    2,
  ),
);
