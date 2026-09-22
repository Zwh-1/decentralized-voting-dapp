// SPDX-License-Identifier: MIT
/**
 * Verifies the deployed contracts on Etherscan.
 *
 *   pnpm --filter @voting/contracts verify:sepolia
 *
 * Two contracts are verified: the `VotingFactory`, and the `Poll`
 * implementation it deployed. The implementation is verified too because it is
 * real deployed bytecode that a reader may want to inspect — and because
 * Etherscan shows a clone as an empty proxy, so the implementation is the only
 * place the actual logic is visible on the explorer.
 *
 * Neither constructor takes an argument any more. The factory's constructor
 * deploys the implementation, and a poll is created by `initialize` rather than
 * by a constructor, so there is nothing to re-read from the deployment record
 * and nothing to mistype.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { network, tasks } from "hardhat";

interface DeploymentRecord {
  chainId: number;
  factory: `0x${string}`;
  implementation: `0x${string}`;
  deployer: `0x${string}`;
  deployedAt: string;
}

// Checked before any network connection, so a fresh clone gets an actionable
// message instead of an RPC or config error.
const apiKey = process.env.ETHERSCAN_API_KEY;

if (apiKey === undefined || apiKey.length === 0) {
  throw new Error(
    "ETHERSCAN_API_KEY is not set, so there is nothing to verify with.\n" +
      "  1. Get a free key: https://etherscan.io/myapikey\n" +
      "  2. Export it, or store it encrypted:\n" +
      "       npx hardhat keystore set ETHERSCAN_API_KEY\n" +
      "  Note: Etherscan's V2 API serves every supported chain from one key,\n" +
      "  so a single key covers Sepolia.",
  );
}

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

const recordPath = path.resolve(import.meta.dirname, "..", "deployments", `${chainId}.json`);

let record: DeploymentRecord;

try {
  record = JSON.parse(await readFile(recordPath, "utf8")) as DeploymentRecord;
} catch {
  throw new Error(
    `No deployment recorded for chain ${chainId} at ${recordPath}.\n` +
      "Run the matching deploy script first, then retry.",
  );
}

// The verify task resolves its connection from the same CLI flags this script
// was invoked with, so `--network sepoliaReadOnly` applies here as well. That
// entry has no `accounts`, which is why verification does not need the
// deployer's private key.
console.log(`Verifying VotingFactory at ${record.factory} (chain ${chainId})`);
await tasks.getTask("verify").run({ address: record.factory });

console.log(`Verifying Poll (implementation) at ${record.implementation}`);
await tasks.getTask("verify").run({ address: record.implementation });

console.log("");
console.log("Both contracts verified. A poll clone will show as a proxy on the");
console.log("explorer; its logic is the verified Poll implementation above.");
