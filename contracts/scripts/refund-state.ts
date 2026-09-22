// SPDX-License-Identifier: MIT
/**
 * Leaves one poll on the local chain in the state `ui-drill --refund` needs.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * `ui-drill --refund` asserts from the browser that a reader can reclaim a stake,
 * and it refuses to run unless the chain already offers that: its own precondition
 * is `phase == Ended` with `stake > 0`, and it says so out loud --
 * `--refund requested, but the chain does not allow this account to refund --
 * phase=1 (needs 2) stake=0 wei (needs > 0)`.
 *
 * Neither seeded poll can satisfy that. Both are created with a 30 day deadline
 * and left in the Voting phase, because that is what the rest of the drills and
 * the consistency baseline are measured against. So the refund path had no
 * browser coverage at all, and the reason was a missing *state*, not a missing
 * command -- `refund-drill.ts` reaches the phase but reverts at the end, on
 * purpose, because `endPoll()` is irreversible.
 *
 * This script builds the state and leaves it in place. It is the counterpart to
 * `seed-local.ts`: that one produces the baseline the consistency check is
 * measured against, and this one produces a single poll in a phase that baseline
 * must never contain. Keeping them separate is deliberate -- folding an ended
 * poll into the seed would move the baseline numbers out from under every other
 * drill.
 *
 * Run against an already-seeded chain. It does not deploy a factory or write a
 * deployment record, so it cannot change which factory the app is pointed at.
 */
import { network } from "hardhat";
import type { Address } from "viem";

/** The amount `Poll` requires for a vote to count, in wei. */
const STAKE = 1_000_000_000_000_000n;

/**
 * The phase this script must leave the poll in.
 *
 * The contract's enum is `Setup, Voting, Reveal, Ended`, so `Ended` is 3.
 * Hardcoding `2` here was wrong and the first successful run said so: batch one
 * inserted `Reveal` into the enum, shifting `Ended` from 2 to 3. The web app's own
 * tests carry a comment about being burned by exactly this (hard-coded 1 and 2
 * silently becoming the wrong phase), which is why the value is named and
 * asserted against the contract's own words rather than trusted.
 */
const ENDED_PHASE = 3;

/**
 * The account `ui-drill` connects as, so the browser drill has a stake to reclaim.
 *
 * `ui-drill` injects a provider that holds no private key: it forwards
 * `eth_sendTransaction` to the node, which signs with its own unlocked accounts.
 * So the voter here must be one of Hardhat's default accounts -- the same address
 * `ui-drill` defaults `TEST_ACCOUNT` to -- rather than a locally derived key. A
 * derived key would vote from an address the browser can never sign as, and the
 * drill would find `stake=0` and refuse.
 */
const VOTER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

if (
  process.env.TEST_ACCOUNT !== undefined &&
  process.env.TEST_ACCOUNT.toLowerCase() !== VOTER.toLowerCase()
) {
  throw new Error(
    `TEST_ACCOUNT is ${process.env.TEST_ACCOUNT}, but this script votes from ` +
      `${VOTER} because it is the account ui-drill signs as by default. ` +
      "Unset TEST_ACCOUNT, or change the constant here to match.",
  );
}

const { viem } = await network.create();

const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

/**
 * The factory already on chain, read from an explicit address rather than
 * deployed again.
 *
 * Redeploying here would silently point the app at a different factory from the
 * one the index was built against -- the exact failure that cost several rounds of
 * diagnosis when `seed-local.ts` and `export-abi` were run in the wrong order.
 */
const factoryAddress = process.env.FACTORY_ADDRESS;

if (factoryAddress === undefined) {
  throw new Error(
    "FACTORY_ADDRESS must be set to the already-seeded factory. " +
      "Run `pnpm seed:local && pnpm export-abi` first and copy the address from " +
      "contracts/deployments/<chainId>.json.",
  );
}

const factory = await viem.getContractAt("VotingFactory", factoryAddress as Address);

console.log(`Adding a refundable poll to factory ${factoryAddress} on chain ${chainId}`);

// The deadline is computed from the CHAIN's clock, never this machine's. The
// `refund-drill` script advances the chain's time, which leaves it weeks ahead of
// wall-clock time, and `createPoll` reverts with `DeadlineNotInFuture` when the
// deadline is not strictly in the future by the chain's own clock.
const latest = await publicClient.getBlock({ blockTag: "latest" });
// A strictly future deadline, with a generous margin rather than a token one.
//
// It cannot simply be in the past: `createPoll` rejects that outright with
// `DeadlineNotInFuture`, which is the contract refusing to create a poll that is
// already over. And the margin cannot be a few seconds either -- the first
// attempt used `+60` and was still rejected, because this node tracks wall-clock
// time and mints a block (with a *later* timestamp) between this read and the
// `createPoll` transaction landing. The chain's clock is then advanced past this
// deadline explicitly, below, which is how `refund-drill.ts` reaches the phase.
const endsAt = latest.timestamp + 3600n;

const createHash = await factory.write.createPoll([
  "Refund drill: should the stake be reclaimable?",
  // Two options, the contract's minimum: `createPoll` reverts with
  // `TooFewOptions(2, provided)` below that. The first run of this script passed
  // one option and was rejected with exactly that, which is the contract doing
  // its job.
  [
    "bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a",
    "bafkreiezmqiiomytpzj5bhprhqepa5ijenxdwtapomhubszecnc2jlx57y",
  ],
  endsAt,
  {
    // Open, so no allowlist write is needed before the vote below.
    openToAll: true,
    multiSelect: false,
    maxSelections: 0n,
    weighted: false,
    delegable: false,
    commitReveal: false,
    revealWindowSeconds: 0n,
    quorumBps: 0n,
    timelockSeconds: 0n,
  },
  // No execution targets: an empty list keeps a passed vote from reaching
  // anything but the poll itself, which is the safe default.
  [],
]);
await publicClient.waitForTransactionReceipt({ hash: createHash });

const pollCount = await factory.read.pollCount();
const pollAddress = await factory.read.pollAt([pollCount - 1n]);
console.log(`Poll created at ${pollAddress}`);

const poll = await viem.getContractAt("Poll", pollAddress);

/**
 * The poll is started and voted in before it is closed.
 *
 * `vote` requires the Voting phase, so `startPoll()` and the vote must both land
 * before `closeAfterDeadline()`. The deadline has already passed, but a poll that
 * has not been closed is still in the Voting phase as far as `vote` is concerned
 * -- the contract only refuses votes once the phase actually changes.
 */
await poll.write.startPoll();

const voterWalletClient = await viem.getWalletClient(VOTER);
const voteHash = await voterWalletClient.writeContract({
  address: pollAddress,
  abi: poll.abi,
  functionName: "vote",
  args: [[1n]],
  value: STAKE,
});
await publicClient.waitForTransactionReceipt({ hash: voteHash });

const stake = (await poll.read.stakeOf([VOTER])) as bigint;

if (stake !== STAKE) {
  throw new Error(
    `the drill voter's stake is ${stake} wei, expected ${STAKE}. ` +
      "ui-drill --refund requires stake > 0.",
  );
}

// `closeAfterDeadline()` rather than `endPoll()`: `endPoll()` is the owner's
// override, while the drill's refund path is written against the ordinary
// deadline flow. This reaches the same phase through the path a real poll takes.
//
// The deadline must actually have passed, and the chain's clock only moves when a
// block is mined, so the clock is advanced explicitly. `evm_increaseTime` then
// `evm_mine` is the same pair `refund-drill.ts` uses; doing it here rather than
// setting a past deadline is required, because `createPoll` refuses a deadline
// that is not in the future.
await publicClient.request({ method: "evm_increaseTime", params: [7200] } as never);
await publicClient.request({ method: "evm_mine", params: [] } as never);

const closeHash = await poll.write.closeAfterDeadline();
await publicClient.waitForTransactionReceipt({ hash: closeHash });

const phase = (await poll.read.phase()) as number;

console.log(
  JSON.stringify(
    {
      pollAddress,
      voter: VOTER,
      stakeWei: stake.toString(),
      phase,
      // Read back from the contract rather than assumed, so a phase that failed
      // to change cannot be reported as ready.
      ready: phase === ENDED_PHASE && stake > 0n,
    },
    null,
    2,
  ),
);

if (phase !== ENDED_PHASE) {
  throw new Error(`expected the Ended phase (${ENDED_PHASE}), the contract reports ${phase}`);
}

console.log("\nNow run:\n" + `  cd web && POLL_ADDRESS=${pollAddress} pnpm ui-drill --refund`);
