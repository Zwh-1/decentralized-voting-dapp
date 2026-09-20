// SPDX-License-Identifier: MIT
/**
 * Deploys `Voting` and records the address per chain so the indexer and the
 * frontend can pick it up through `@voting/shared`.
 *
 *   pnpm --filter @voting/contracts deploy:local     # against `hardhat node`
 *   pnpm --filter @voting/contracts deploy:sepolia   # real testnet
 *
 * The owner defaults to the deployer. Override with `VOTING_OWNER` if the
 * administrator should be a different account.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";

const { viem } = await network.create();

const [deployer] = await viem.getWalletClients();
const publicClient = await viem.getPublicClient();

const owner = (process.env.VOTING_OWNER ?? deployer.account.address) as `0x${string}`;

console.log(`Deploying Voting with owner ${owner} ...`);

const voting = await viem.deployContract("Voting", [owner]);
const chainId = await publicClient.getChainId();

const deployment = {
  chainId,
  voting: voting.address,
  owner,
  deployer: deployer.account.address,
  deployedAt: new Date().toISOString(),
};

const outDir = path.resolve(import.meta.dirname, "..", "deployments");
await mkdir(outDir, { recursive: true });

const outFile = path.join(outDir, `${chainId}.json`);
await writeFile(outFile, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

console.log(`Voting deployed at ${voting.address} (chain ${chainId})`);
console.log(`Recorded deployment in ${outFile}`);
console.log("Run `pnpm --filter @voting/contracts export-abi` to publish it to @voting/shared.");
