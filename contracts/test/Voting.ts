// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

const { viem } = await network.create();

const STAKE = 1_000_000_000_000_000n; // 0.001 ether

const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_B = "bafkreieq5jui4j25lacwomsqgvn7mq3z4g4hq7xw774wevxfrfrura3jqq";

/// @notice Consumer-perspective tests: the same calls the frontend and the
///         indexer will make, in a full blockchain simulation rather than in
///         the EVM in isolation.
describe("Voting (viem + node:test)", function () {
  async function deployFixture() {
    const [admin, alice, bob] = await viem.getWalletClients();

    const voting = await viem.deployContract("Voting", [admin.account.address]);

    await voting.write.addCandidate([CID_A]);
    await voting.write.addCandidate([CID_B]);
    await voting.write.setWhitelist([[alice.account.address, bob.account.address], true]);
    await voting.write.startVoting();

    return { voting, admin, alice, bob };
  }

  it("starts in the Setup phase with the deployer as owner", async function () {
    const [admin] = await viem.getWalletClients();
    const voting = await viem.deployContract("Voting", [admin.account.address]);

    assert.equal(await voting.read.phase(), 0);
    assert.equal(
      (await voting.read.owner()).toLowerCase(),
      admin.account.address.toLowerCase(),
    );
  });

  it("records a vote and reflects it in results()", async function () {
    const { voting, alice } = await deployFixture();

    const publicClient = await viem.getPublicClient();
    const hash = await voting.write.vote([1n], {
      account: alice.account,
      value: STAKE,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(receipt.status, "success");
    assert.equal(await voting.read.hasVoted([alice.account.address]), true);
    assert.equal(await voting.read.votedFor([alice.account.address]), 1n);

    const [candidates, total] = await voting.read.results();
    assert.equal(total, 1n);
    assert.equal(candidates[0].voteCount, 1n);
    assert.equal(candidates[1].voteCount, 0n);
  });

  it("emits VoteCast with the running count", async function () {
    const { voting, alice } = await deployFixture();
    const publicClient = await viem.getPublicClient();

    const hash = await voting.write.vote([2n], {
      account: alice.account,
      value: STAKE,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const logs = await publicClient.getContractEvents({
      address: voting.address,
      abi: voting.abi,
      eventName: "VoteCast",
      fromBlock: 0n,
    });

    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.voter?.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(logs[0].args.candidateId, 2n);
    assert.equal(logs[0].args.newCount, 1n);
  });

  it("rejects a vote from an address that is not whitelisted", async function () {
    const { voting } = await deployFixture();
    const [, , , stranger] = await viem.getWalletClients();

    await assert.rejects(
      voting.write.vote([1n], { account: stranger.account, value: STAKE }),
      "a non-whitelisted address must not be able to vote",
    );
  });

  it("rejects a second vote from the same address", async function () {
    const { voting, alice } = await deployFixture();

    await voting.write.vote([1n], { account: alice.account, value: STAKE });

    await assert.rejects(
      voting.write.vote([2n], { account: alice.account, value: STAKE }),
      "a voter must not be able to vote twice",
    );
  });

  it("rejects a vote with the wrong stake", async function () {
    const { voting, alice } = await deployFixture();

    await assert.rejects(
      voting.write.vote([1n], { account: alice.account, value: STAKE * 2n }),
      "an incorrect stake must be rejected",
    );
  });

  it("returns the stake after the ballot closes", async function () {
    const { voting, admin, alice } = await deployFixture();
    const publicClient = await viem.getPublicClient();

    await voting.write.vote([1n], { account: alice.account, value: STAKE });
    await voting.write.endVoting({ account: admin.account });

    const before = await publicClient.getBalance({ address: alice.account.address });

    const hash = await voting.write.refund({ account: alice.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

    const after = await publicClient.getBalance({ address: alice.account.address });

    assert.equal(after - before + gasCost, STAKE, "the stake must be returned in full");
    assert.equal(await voting.read.stakeOf([alice.account.address]), 0n);
    assert.equal(await voting.read.totalStaked(), 0n);
  });

  it("rejects a refund before the ballot closes", async function () {
    const { voting, alice } = await deployFixture();

    await voting.write.vote([1n], { account: alice.account, value: STAKE });

    await assert.rejects(
      voting.write.refund({ account: alice.account }),
      "a refund must not be possible while voting is open",
    );
  });
});
