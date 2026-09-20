// SPDX-License-Identifier: MIT
/**
 * Seeds a local chain for the end-to-end verification.
 *
 * Deploys `Voting`, whitelists 200 freshly derived accounts, opens the ballot
 * and has every one of them vote once. 200 distinct voters is the point: every
 * vote must be accepted, so the on-chain tally is exactly 200 and the indexer
 * has something with real volume to disagree with.
 *
 *   pnpm --filter @voting/contracts exec hardhat run scripts/seed-local.ts --network localhost
 *
 * Writes the deployment to `deployments/<chainId>.json`, the same record
 * `deploy.ts` writes, so `export-abi` publishes it to web/src/lib/contracts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";
import { createWalletClient, defineChain, http, parseEther, toHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// `LOCALHOST_RPC_URL` first, so one variable retargets both the Hardhat network
// this script borrows its funded accounts from and the transport it sends on.
const RPC_URL = process.env.LOCALHOST_RPC_URL ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
const VOTER_COUNT = Number(process.env.VOTER_COUNT ?? 200);
const CANDIDATE_COUNT = 3;
const STAKE = 1_000_000_000_000_000n; // 0.001 ether, must equal Voting.STAKE

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
const { contract: voting, deploymentTransaction } = await viem.sendDeploymentTransaction("Voting", [
  deployer.account.address,
]);
const deploymentReceipt = await publicClient.waitForTransactionReceipt({
  hash: deploymentTransaction.hash,
});
console.log(`Voting deployed at ${voting.address} in block ${deploymentReceipt.blockNumber}`);

for (let i = 0; i < CANDIDATE_COUNT; i += 1) {
  await voting.write.addCandidate([`bafyseededcandidate${i}`]);
}
console.log(`Added ${CANDIDATE_COUNT} candidates`);

// Deterministic accounts, so a re-run reproduces exactly the same voters.
const voters = Array.from({ length: VOTER_COUNT }, (_, i) => {
  const privateKey = keccak256(toHex(`voting-seed-voter-${i}`));
  return { account: privateKeyToAccount(privateKey), index: i };
});

await voting.write.setWhitelist([voters.map((voter) => voter.account.address), true]);
console.log(`Whitelisted ${VOTER_COUNT} voters`);

await voting.write.startVoting();
console.log("Voting opened");

// Fund and vote, one account at a time. Sequential on purpose: a local node
// automines, so this keeps nonce handling trivial and the log readable.
let accepted = 0;
const tally = new Array<number>(CANDIDATE_COUNT).fill(0);

for (const voter of voters) {
  const wallet = createWalletClient({ account: voter.account, chain, transport });

  const fundingHash = await deployer.sendTransaction({
    account: deployer.account,
    chain,
    to: voter.account.address,
    value: parseEther("0.01"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundingHash });

  const candidateId = (voter.index % CANDIDATE_COUNT) + 1;

  const hash = await wallet.writeContract({
    address: voting.address,
    abi: voting.abi,
    functionName: "vote",
    args: [candidateId],
    value: STAKE,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  accepted += 1;
  tally[candidateId - 1] = (tally[candidateId - 1] ?? 0) + 1;
}

const [candidates, total] = await voting.read.results();
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
      voting: voting.address.toLowerCase(),
      owner: deployer.account.address.toLowerCase(),
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
      voting: voting.address,
      voters: VOTER_COUNT,
      acceptedVotes: accepted,
      onChainTotal: Number(total),
      perCandidate: candidates.map((candidate) => ({
        id: Number(candidate.id),
        cid: candidate.metadataCID,
        voteCount: Number(candidate.voteCount),
      })),
      expectedTally: tally,
      headBlock: Number(headBlock),
    },
    null,
    2,
  ),
);
