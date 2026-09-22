// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

import { seedableCids } from "../scripts/metadata";

const { viem } = await network.create();

const STAKE = 1_000_000_000_000_000n; // 0.001 ether

const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_B = "bafkreieq5jui4j25lacwomsqgvn7mq3z4g4hq7xw774wevxfrfrura3jqq";

const DAY = 24n * 60n * 60n;

/// @notice Consumer-perspective tests: the same calls the frontend and the
///         indexer will make, in a full blockchain simulation rather than in
///         the EVM in isolation.
///
/// @dev The factory is the entry point now, so every fixture starts there — a
///      poll is always reached the way the browser reaches it, by asking the
///      factory and then talking to the poll it names. That is deliberate: a
///      test that deployed `Poll` directly would not exercise the clone, and the
///      clone is where "two polls keep separate state" can actually break.
describe("VotingFactory + Poll (viem + node:test)", function () {
  async function deployFixture() {
    const [creator, alice, bob] = await viem.getWalletClients();

    const factory = await viem.deployContract("VotingFactory");
    const latest = await (await viem.getPublicClient()).getBlock();
    const endsAt = latest.timestamp + 30n * DAY;

    await factory.write.createPoll(["Which one?", [CID_A, CID_B], endsAt, false], {
      account: creator.account,
    });

    const pollAddress = await factory.read.pollAt([0n]);
    const poll = await viem.getContractAt("Poll", pollAddress);

    await poll.write.setWhitelist([[alice.account.address, bob.account.address], true], {
      account: creator.account,
    });
    await poll.write.startPoll({ account: creator.account });

    return { factory, poll, creator, alice, bob };
  }

  // -------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------

  it("creates a poll owned by its creator, leaving the factory without a tally", async function () {
    const [creator] = await viem.getWalletClients();

    const factory = await viem.deployContract("VotingFactory");
    const latest = await (await viem.getPublicClient()).getBlock();
    const endsAt = latest.timestamp + 30n * DAY;

    const hash = await factory.write.createPoll(["Which one?", [CID_A, CID_B], endsAt, false], {
      account: creator.account,
    });
    await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });

    assert.equal(await factory.read.pollCount(), 1n, "one poll registered");

    const pollAddress = await factory.read.pollAt([0n]);
    const poll = await viem.getContractAt("Poll", pollAddress);

    assert.equal(await poll.read.phase(), 0, "a new poll starts in Setup");
    assert.equal(await poll.read.question(), "Which one?");
    assert.equal(await poll.read.optionCount(), 2n);
    assert.equal(
      (await poll.read.owner()).toLowerCase(),
      creator.account.address.toLowerCase(),
      "the creator administers the poll",
    );

    // The factory holds no votes of its own: it has no such state to hold.
    const [, total] = await poll.read.results();
    assert.equal(total, 0n, "nothing has been voted yet");
  });

  /// @dev The property the factory exists to provide. Two polls that shared any
  ///      state would make "one address, one vote" unenforceable.
  it("keeps two polls' tallies and stakes entirely separate", async function () {
    const { factory, poll, creator, alice } = await deployFixture();

    const latest = await (await viem.getPublicClient()).getBlock();
    const endsAt = latest.timestamp + 30n * DAY;

    await factory.write.createPoll(["Second?", [CID_A, CID_B], endsAt, false], {
      account: creator.account,
    });

    const secondAddress = await factory.read.pollAt([1n]);
    const second = await viem.getContractAt("Poll", secondAddress);

    await second.write.setWhitelist([[alice.account.address], true], { account: creator.account });
    await second.write.startPoll({ account: creator.account });

    // Alice votes in the first poll only.
    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    const [, firstTotal] = await poll.read.results();
    const [, secondTotal] = await second.read.results();

    assert.equal(firstTotal, 1n, "the first poll counted it");
    assert.equal(secondTotal, 0n, "the second poll saw nothing");
    assert.equal(await second.read.stakeOf([alice.account.address]), 0n, "and holds no stake");
    assert.equal(
      await poll.read.stakeOf([alice.account.address]),
      STAKE,
      "the stake is in the first",
    );
  });

  /// @dev A poll clone must not be re-initializable: that is the clone-pattern
  ///      hazard, and it is the difference between a poll and a stolen poll.
  it("refuses to let anyone re-initialize an existing poll", async function () {
    const { factory, bob } = await deployFixture();
    const pollAddress = await factory.read.pollAt([0n]);
    const poll = await viem.getContractAt("Poll", pollAddress);

    const latest = await (await viem.getPublicClient()).getBlock();

    await assert.rejects(
      poll.write.initialize(
        [bob.account.address, "Hijacked", [CID_A, CID_B], latest.timestamp + DAY],
        {
          account: bob.account,
        },
      ),
      "a second initialize must revert",
    );

    assert.equal(await poll.read.question(), "Which one?", "the question is untouched");
  });

  // -------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------

  it("records a vote and reflects it in results()", async function () {
    const { poll, alice } = await deployFixture();

    const publicClient = await viem.getPublicClient();
    const hash = await poll.write.vote([1n], {
      account: alice.account,
      value: STAKE,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(receipt.status, "success");
    assert.equal(await poll.read.votedFor([alice.account.address]), 1n);
    assert.equal(await poll.read.stakeOf([alice.account.address]), STAKE);

    const [options, total] = await poll.read.results();
    assert.equal(total, 1n);
    assert.equal(options[0].voteCount, 1n);
    assert.equal(options[1].voteCount, 0n);
  });

  it("emits VoteCast with the running count", async function () {
    const { poll, alice } = await deployFixture();
    const publicClient = await viem.getPublicClient();

    const hash = await poll.write.vote([2n], {
      account: alice.account,
      value: STAKE,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const logs = await publicClient.getContractEvents({
      address: poll.address,
      abi: poll.abi,
      eventName: "VoteCast",
      fromBlock: 0n,
    });

    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.voter?.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(logs[0].args.optionId, 2n);
    assert.equal(logs[0].args.newCount, 1n);
  });

  it("rejects a vote from an address that is not whitelisted", async function () {
    const { poll } = await deployFixture();
    const [, , , stranger] = await viem.getWalletClients();

    await assert.rejects(
      poll.write.vote([1n], { account: stranger.account, value: STAKE }),
      "a non-whitelisted address must not be able to vote",
    );
  });

  it("rejects a second vote from the same address", async function () {
    const { poll, alice } = await deployFixture();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    await assert.rejects(
      poll.write.vote([2n], { account: alice.account, value: STAKE }),
      "voting twice must be refused; changing a vote is a different call",
    );
  });

  it("rejects a vote with the wrong stake", async function () {
    const { poll, alice } = await deployFixture();

    await assert.rejects(
      poll.write.vote([1n], { account: alice.account, value: STAKE * 2n }),
      "an incorrect stake must be rejected",
    );
  });

  // -------------------------------------------------------------------
  // Change and withdraw — the reason this contract replaced the old one
  // -------------------------------------------------------------------

  it("moves a vote to another option without touching the stake", async function () {
    const { poll, alice } = await deployFixture();
    const publicClient = await viem.getPublicClient();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    const before = await publicClient.getBalance({ address: alice.account.address });

    const hash = await poll.write.changeVote([2n], { account: alice.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

    const after = await publicClient.getBalance({ address: alice.account.address });

    assert.equal(before - after, gasCost, "changing a vote costs gas and nothing else");
    assert.equal(await poll.read.votedFor([alice.account.address]), 2n);
    assert.equal(await poll.read.stakeOf([alice.account.address]), STAKE, "the stake stayed put");

    const [options, total] = await poll.read.results();
    assert.equal(total, 1n, "a change is not a second vote");
    assert.equal(options[0].voteCount, 0n, "the old option was released");
    assert.equal(options[1].voteCount, 1n, "the new option was credited");
  });

  it("emits VoteChanged rather than a second VoteCast", async function () {
    const { poll, alice } = await deployFixture();
    const publicClient = await viem.getPublicClient();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    const hash = await poll.write.changeVote([2n], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });

    const logs = await publicClient.getContractEvents({
      address: poll.address,
      abi: poll.abi,
      eventName: "VoteChanged",
      fromBlock: 0n,
    });

    assert.equal(logs.length, 1, "the change has its own event");
    assert.equal(logs[0].args.voter?.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(logs[0].args.fromOptionId, 1n);
    assert.equal(logs[0].args.toOptionId, 2n);
  });

  it("refuses a change to the option already chosen", async function () {
    const { poll, alice } = await deployFixture();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    await assert.rejects(
      poll.write.changeVote([1n], { account: alice.account }),
      "changing to the same option is a no-op that should be refused, not silently accepted",
    );
  });

  it("withdraws a vote and returns the stake while the poll is open", async function () {
    const { poll, alice } = await deployFixture();
    const publicClient = await viem.getPublicClient();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    const before = await publicClient.getBalance({ address: alice.account.address });

    const hash = await poll.write.withdrawVote({ account: alice.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

    const after = await publicClient.getBalance({ address: alice.account.address });

    assert.equal(after - before + gasCost, STAKE, "the stake came back in full");
    assert.equal(await poll.read.votedFor([alice.account.address]), 0n);
    assert.equal(await poll.read.stakeOf([alice.account.address]), 0n);
    assert.equal(await poll.read.totalStaked(), 0n);

    const [, total] = await poll.read.results();
    assert.equal(total, 0n, "the vote was released");

    // And the address may vote again, which the old contract could not allow.
    await poll.write.vote([2n], { account: alice.account, value: STAKE });
    assert.equal(await poll.read.votedFor([alice.account.address]), 2n);
  });

  // -------------------------------------------------------------------
  // Admission: open polls
  // -------------------------------------------------------------------

  /// @dev The path the browser takes when the creator picked 所有人可投: create,
  ///      start, vote, with no `setWhitelist` call anywhere. Before `openToAll`
  ///      existed this sequence was impossible without one, which is why every
  ///      poll was effectively invitation-only.
  async function deployOpenFixture() {
    const [creator, alice] = await viem.getWalletClients();

    const factory = await viem.deployContract("VotingFactory");
    const latest = await (await viem.getPublicClient()).getBlock();
    const endsAt = latest.timestamp + 30n * DAY;

    await factory.write.createPoll(["Anyone?", [CID_A, CID_B], endsAt, true], {
      account: creator.account,
    });

    const pollAddress = await factory.read.pollAt([0n]);
    const poll = await viem.getContractAt("Poll", pollAddress);

    // Deliberately NO setWhitelist. `startPoll` only needs two options.
    await poll.write.startPoll({ account: creator.account });

    return { factory, poll, creator, alice };
  }

  it("lets an address that was never whitelisted vote in an open poll", async function () {
    const { poll, alice } = await deployOpenFixture();

    assert.equal(
      await poll.read.isWhitelisted([alice.account.address]),
      false,
      "alice is genuinely not on any list",
    );

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    assert.equal(await poll.read.votedFor([alice.account.address]), 1n);
    assert.equal(await poll.read.totalStaked(), STAKE);
  });

  it("reports the admission decision separately from the whitelist answer", async function () {
    // The UI has to explain WHY a button is disabled. On an open poll the answer
    // can never be "you are not whitelisted", so `whitelisted` and `canVote`
    // must stay two different facts.
    const { poll, alice } = await deployOpenFixture();

    const state = await poll.read.voterState([alice.account.address]);

    assert.equal(state[0], false, "whitelisted is the raw mapping answer");
    assert.equal(state[4], true, "canVote is the derived decision");
  });

  it("still enforces one address one vote in an open poll", async function () {
    const { poll, alice } = await deployOpenFixture();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    await assert.rejects(
      poll.write.vote([2n], { account: alice.account, value: STAKE }),
      /AlreadyVoted/,
      "opening admission is orthogonal to one-address-one-vote",
    );
  });

  it("records the admission mode on the poll the factory created", async function () {
    const { poll } = await deployOpenFixture();

    assert.equal(await poll.read.openToAll(), true);
  });

  // -------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------
  it("returns the stake after the poll closes", async function () {
    const { poll, creator, alice } = await deployFixture();
    const publicClient = await viem.getPublicClient();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });
    await poll.write.endPoll({ account: creator.account });

    const before = await publicClient.getBalance({ address: alice.account.address });

    const hash = await poll.write.refund({ account: alice.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

    const after = await publicClient.getBalance({ address: alice.account.address });

    assert.equal(after - before + gasCost, STAKE, "the stake must be returned in full");
    assert.equal(await poll.read.stakeOf([alice.account.address]), 0n);
    assert.equal(await poll.read.totalStaked(), 0n);
  });

  it("rejects a refund before the poll closes", async function () {
    const { poll, alice } = await deployFixture();

    await poll.write.vote([1n], { account: alice.account, value: STAKE });

    await assert.rejects(
      poll.write.refund({ account: alice.account }),
      "a refund must not be possible while voting is open",
    );
  });

  // -------------------------------------------------------------------
  // The repository's own metadata, through the real contract
  // -------------------------------------------------------------------

  /// @dev Ties the contract to the committed documents: the CIDs this repository
  ///      pinned are the ones a poll is seeded with, and they must be accepted as
  ///      options. A manifest that drifts from what the contract accepts would
  ///      otherwise surface only during a live demo.
  it("accepts this repository's pinned option CIDs", async function () {
    const cids = await seedableCids();
    assert.ok(cids.length >= 2, "the manifest must offer at least two options");

    const [creator] = await viem.getWalletClients();
    const factory = await viem.deployContract("VotingFactory");
    const latest = await (await viem.getPublicClient()).getBlock();

    const hash = await factory.write.createPoll(
      ["Pinned options?", cids, latest.timestamp + 30n * DAY, false],
      { account: creator.account },
    );
    await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });

    const pollAddress = await factory.read.pollAt([0n]);
    const poll = await viem.getContractAt("Poll", pollAddress);

    assert.equal(await poll.read.optionCount(), BigInt(cids.length));
    for (const [index, cid] of cids.entries()) {
      assert.equal(await poll.read.optionCID([BigInt(index + 1)]), cid);
    }
  });
});
