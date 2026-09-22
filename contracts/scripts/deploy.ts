// SPDX-License-Identifier: MIT
/**
 * Deploys `VotingFactory` and records the address per chain, so the indexer and
 * the frontend pick it up through `web/src/lib/contracts` with no manual
 * copying.
 *
 *   pnpm --filter @voting/contracts deploy:local     # against `hardhat node`
 *   pnpm --filter @voting/contracts deploy:sepolia   # real testnet
 *
 * There is no `VOTING_OWNER` any more. The factory has no owner: every poll is
 * owned by whoever created it, so a single configured administrator would be a
 * concept that no longer exists. The deployer only pays for the deployment.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";

import { preflight } from "./preflight";

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

const networkName = requestedNetwork();
preflight(networkName);

const { viem } = await network.create();

const [deployer] = await viem.getWalletClients();
const publicClient = await viem.getPublicClient();

console.log(`Network:  ${networkName}`);
console.log(`Deployer: ${deployer.account.address}`);
console.log("");

const { contract: factory, deploymentTransaction } =
  await viem.sendDeploymentTransaction("VotingFactory");

const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
const chainId = await publicClient.getChainId();

const implementation = await factory.read.implementation();

const deployment = {
  chainId,
  // Lower case on purpose. `seed-local.ts` writes the same file, and the
  // generated registry in `web/src/lib/contracts` is guarded by a byte-exact
  // diff in CI — so both writers must agree on one form, and this is the form
  // the committed record already uses.
  factory: factory.address.toLowerCase(),
  implementation: implementation.toLowerCase(),
  deployer: deployer.account.address.toLowerCase(),
  deployedAt: new Date().toISOString(),
  /**
   * The block the factory was created in.
   *
   * The indexer starts here rather than at block 0. That is not an optimisation:
   * public RPCs prune old history — Sepolia's earliest available block is around
   * 1,000,000 — so scanning from 0 does not merely crawl, it fails outright, and
   * a fresh index against Sepolia dies a couple of thousand blocks in with
   * `pruned history unavailable` and never recovers.
   *
   * This is also the block every poll's events are found from: polls are
   * discovered by following `PollCreated`, which the factory can only emit after
   * it exists.
   */
  blockNumber: Number(receipt.blockNumber),
};

const outDir = path.resolve(import.meta.dirname, "..", "deployments");
await mkdir(outDir, { recursive: true });

const outFile = path.join(outDir, `${chainId}.json`);

// Overwriting silently would lose the previous address, which matters because
// that record is what the app and `verify` read.
try {
  const existing = JSON.parse(await readFile(outFile, "utf8")) as { factory?: string };

  // Case-insensitive, because the two sides carry different forms of the same
  // address: this file stores the lower-case form on purpose (see the note on
  // `deployment` below, and `seed-local.ts`), while viem returns an EIP-55
  // checksummed one. Compared raw, re-deploying at the *same* address warned that
  // "any index built against the previous address is now stale" — a false alarm
  // about an index that was still valid, measured on a fresh local chain.
  if (
    existing.factory !== undefined &&
    existing.factory.toLowerCase() !== factory.address.toLowerCase()
  ) {
    console.warn(
      `WARNING: replacing the recorded deployment for chain ${chainId}.\n` +
        `  previous: ${existing.factory}\n` +
        `  new:      ${factory.address}\n` +
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

console.log(`VotingFactory deployed at ${factory.address} (chain ${chainId})`);
console.log(`Poll implementation at ${implementation}`);
console.log(`Recorded deployment in ${outFile}`);

if (explorer !== undefined) {
  console.log(`Explorer: ${explorer}/address/${factory.address}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    "  pnpm export-abi                                             # publish the address",
  );
  console.log("  pnpm --filter @voting/contracts verify:sepolia              # publish the source");
} else {
  console.log("Next step: `pnpm export-abi` to publish the address.");
}
