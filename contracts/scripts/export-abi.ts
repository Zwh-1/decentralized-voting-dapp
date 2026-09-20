// SPDX-License-Identifier: MIT
/**
 * Publishes the compiled contract interface into `@voting/shared`:
 *
 *   * `voting-abi.ts`   — the ABI, plus the `VotingPhase` enum mirror
 *   * `deployments.ts`  — chain id -> deployed address, read from ./deployments
 *
 * Both files are committed. That is deliberate: it lets the indexer and the
 * frontend typecheck and build without a full Hardhat compile, while CI re-runs
 * this script and fails on any diff so the committed copy cannot go stale.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const contractsDir = path.resolve(import.meta.dirname, "..");
const sharedSrc = path.resolve(contractsDir, "..", "packages", "shared", "src");

interface Artifact {
  abi: unknown[];
  contractName: string;
  sourceName: string;
}

interface DeploymentRecord {
  chainId: number;
  voting: string;
  owner: string;
  deployer: string;
  deployedAt: string;
}

const BANNER = `// SPDX-License-Identifier: MIT
// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with: pnpm --filter @voting/contracts export-abi
`;

async function readArtifact(): Promise<Artifact> {
  const artifactPath = path.join(contractsDir, "artifacts", "contracts", "Voting.sol", "Voting.json");

  try {
    return JSON.parse(await readFile(artifactPath, "utf8")) as Artifact;
  } catch {
    throw new Error(
      `Could not read ${artifactPath}.\n` +
        "Run `pnpm --filter @voting/contracts build` before exporting the ABI.",
    );
  }
}

/**
 * The phase enum is mirrored as a TS enum so consumers can compare against
 * named members instead of magic numbers.
 */
const PHASE_ENUM = `/** Mirrors the on-chain \`Voting.Phase\` enum. */
export enum VotingPhase {
  Setup = 0,
  Voting = 1,
  Ended = 2,
}
`;

async function readDeployments(): Promise<DeploymentRecord[]> {
  const dir = path.join(contractsDir, "deployments");

  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const records: DeploymentRecord[] = [];
  for (const file of files.sort()) {
    try {
      records.push(JSON.parse(await readFile(path.join(dir, file), "utf8")) as DeploymentRecord);
    } catch (error) {
      throw new Error(`Malformed deployment file ${file}: ${String(error)}`);
    }
  }

  return records;
}

const artifact = await readArtifact();

const abiFile = `${BANNER}
/** The deployed \`Voting\` contract interface, as emitted by solc. */
export const votingAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;

${PHASE_ENUM}`;

await writeFile(path.join(sharedSrc, "voting-abi.ts"), abiFile, "utf8");

const records = await readDeployments();

const entries = records
  .map(
    (record) => `  ${record.chainId}: {
    chainId: ${record.chainId},
    voting: "${record.voting}",
    owner: "${record.owner}",
    deployer: "${record.deployer}",
    deployedAt: "${record.deployedAt}",
  },`,
  )
  .join("\n");

const deploymentsFile = `${BANNER}
export interface Deployment {
  chainId: number;
  voting: \`0x\${string}\`;
  owner: \`0x\${string}\`;
  deployer: \`0x\${string}\`;
  deployedAt: string;
}

/** Well-known chain ids used by this project. */
export const CHAIN_IDS = {
  hardhat: 31337,
  sepolia: 11155111,
} as const;

/**
 * Deployed addresses by chain id. Populated from \`contracts/deployments/*.json\`
 * by \`export-abi\`; empty until the contract is deployed somewhere.
 */
export const deployments: Record<number, Deployment> = {
${entries}
};

/** Returns the deployment for a chain, or undefined when not deployed there. */
export function getDeployment(chainId: number): Deployment | undefined {
  return deployments[chainId];
}
`;

await writeFile(path.join(sharedSrc, "deployments.ts"), deploymentsFile, "utf8");

console.log(`Wrote ${path.relative(process.cwd(), path.join(sharedSrc, "voting-abi.ts"))}`);
console.log(
  `Wrote ${path.relative(process.cwd(), path.join(sharedSrc, "deployments.ts"))} (${records.length} deployment(s))`,
);
