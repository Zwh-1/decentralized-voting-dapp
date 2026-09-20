// SPDX-License-Identifier: MIT
/**
 * Deploys `Voting` and records the address per chain, so the indexer and the
 * frontend pick it up through `web/src/lib/contracts` with no manual copying.
 *
 *   pnpm --filter @voting/contracts deploy:local     # against `hardhat node`
 *   pnpm --filter @voting/contracts deploy:sepolia   # real testnet
 *
 * The owner defaults to the deployer. Override with `VOTING_OWNER` when the
 * administrator should be a different account.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";

/**
 * The network named by `--network`, resolved before any connection is opened.
 *
 * Only used to decide whether credentials are required. A local network needs
 * none, and demanding them there would be wrong.
 */
function requestedNetwork(): string {
  const index = process.argv.indexOf("--network");

  return index === -1 ? "hardhat" : (process.argv[index + 1] ?? "hardhat");
}

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

/**
 * Fails with the project's own instructions rather than Hardhat's generic
 * "Configuration Variable not found", and names every missing variable at once
 * instead of one per attempt.
 */
function preflight(networkName: string): void {
  if (LOCAL_NETWORKS.has(networkName)) {
    return;
  }

  const required = [
    [
      "SEPOLIA_RPC_URL",
      "a Sepolia JSON-RPC endpoint, e.g. https://ethereum-sepolia-rpc.publicnode.com",
    ],
    ["SEPOLIA_PRIVATE_KEY", "a DEDICATED throwaway deployer key funded with test ETH"],
  ] as const;

  const missing = required.filter(([name]) => {
    const value = process.env[name];

    return value === undefined || value.length === 0;
  });

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `Deploying to "${networkName}" needs ${missing.length} more configuration ${
      missing.length === 1 ? "variable" : "variables"
    }:\n` +
      missing.map(([name, what]) => `  ${name} — ${what}`).join("\n") +
      "\n\nEither export them, or store them encrypted:\n" +
      missing.map(([name]) => `  npx hardhat keystore set ${name}`).join("\n") +
      "\n\nSee contracts/.env.example for the full list.",
  );
}

const networkName = requestedNetwork();
preflight(networkName);

const { viem } = await network.create();

const [deployer] = await viem.getWalletClients();
const publicClient = await viem.getPublicClient();

const owner = (process.env.VOTING_OWNER ?? deployer.account.address) as `0x${string}`;

console.log(`Network:  ${networkName}`);
console.log(`Deployer: ${deployer.account.address}`);
console.log(
  `Owner:    ${owner}${process.env.VOTING_OWNER === undefined ? " (defaults to the deployer)" : ""}`,
);
console.log("");

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

// Overwriting silently would lose the previous address, which matters because
// that record is what the app and `verify` read.
try {
  const existing = JSON.parse(await readFile(outFile, "utf8")) as { voting?: string };

  if (existing.voting !== undefined && existing.voting !== voting.address) {
    console.warn(
      `WARNING: replacing the recorded deployment for chain ${chainId}.\n` +
        `  previous: ${existing.voting}\n` +
        `  new:      ${voting.address}\n` +
        "  Any index built against the previous address is now stale and must be rebuilt.",
    );
  }
} catch {
  // No previous record: the normal case on a first deploy.
}

await writeFile(outFile, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

const explorers: Record<number, string> = {
  11155111: "https://sepolia.etherscan.io",
};

const explorer = explorers[chainId];

console.log(`Voting deployed at ${voting.address} (chain ${chainId})`);
console.log(`Recorded deployment in ${outFile}`);

if (explorer !== undefined) {
  console.log(`Explorer: ${explorer}/address/${voting.address}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    "  pnpm export-abi                                             # publish the address",
  );
  console.log("  pnpm --filter @voting/contracts verify:sepolia              # publish the source");
} else {
  console.log("Next step: `pnpm export-abi` to publish the address.");
}
