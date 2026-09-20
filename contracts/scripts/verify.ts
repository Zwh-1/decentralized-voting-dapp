// SPDX-License-Identifier: MIT
/**
 * Verifies the deployed `Voting` contract on Etherscan.
 *
 *   pnpm --filter @voting/contracts verify:sepolia
 *
 * The constructor argument is read from the deployment record that `deploy.ts`
 * wrote, rather than being retyped. `Voting`'s constructor takes the initial
 * owner, so a mismatched argument produces a verification failure that looks
 * like a compiler problem but is really a typo — reading it back from the record
 * removes that whole failure mode.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { network, tasks } from "hardhat";

interface DeploymentRecord {
  chainId: number;
  voting: `0x${string}`;
  owner: `0x${string}`;
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

console.log(`Verifying Voting at ${record.voting} (chain ${chainId})`);
console.log(`Constructor argument read from the deployment record: owner=${record.owner}`);

// The verify task resolves its connection from the same CLI flags this script
// was invoked with, so `--network sepolia` applies here as well.
await tasks.getTask("verify").run({
  address: record.voting,
  constructorArgs: [record.owner],
});
