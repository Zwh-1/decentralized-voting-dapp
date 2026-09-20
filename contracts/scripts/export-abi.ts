// SPDX-License-Identifier: MIT
/**
 * Publishes the compiled contract interface into the web app:
 *
 *   * `voting-abi.ts`   — the ABI, plus the `VotingPhase` enum mirror
 *   * `deployments.ts`  — chain id -> deployed address, read from ./deployments
 *   * `index.ts`        — a single entry point that re-exports both
 *
 * They land in `web/src/lib/contracts/`, which keeps the repository at two
 * layers (`contracts/` and `web/`) instead of introducing a third package that
 * exists only to hold generated types.
 *
 * All three files are committed. That is deliberate: it lets the web app
 * typecheck and build without a full Hardhat compile, while CI re-runs this
 * script and fails on any diff so the committed copy cannot go stale.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const contractsDir = path.resolve(import.meta.dirname, "..");
const generatedDir = path.resolve(contractsDir, "..", "web", "src", "lib", "contracts");

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
  /**
   * The block the contract was created in, so the indexer can start there
   * instead of at block 0. Absent in records written before this field existed.
   */
  blockNumber?: number;
}

const BANNER = `// SPDX-License-Identifier: MIT
// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with: pnpm export-abi
`;

async function readArtifact(): Promise<Artifact> {
  const artifactPath = path.join(
    contractsDir,
    "artifacts",
    "contracts",
    "Voting.sol",
    "Voting.json",
  );

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

await mkdir(generatedDir, { recursive: true });

const artifact = await readArtifact();

const abiFile = `${BANNER}
/** The deployed \`Voting\` contract interface, as emitted by solc. */
export const votingAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;

${PHASE_ENUM}`;

await writeFile(path.join(generatedDir, "voting-abi.ts"), abiFile, "utf8");

const records = await readDeployments();

const entries = records
  .map(
    (record) => `  ${record.chainId}: {
    chainId: ${record.chainId},
    voting: "${record.voting}",
    owner: "${record.owner}",
    deployer: "${record.deployer}",
    deployedAt: "${record.deployedAt}",
    blockNumber: ${record.blockNumber ?? "undefined"},
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
  /**
   * The block the contract was created in. The indexer starts here rather than
   * at block 0, because public RPCs prune old history and a scan from genesis
   * fails outright on Sepolia instead of merely being slow.
   */
  blockNumber: number | undefined;
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

await writeFile(path.join(generatedDir, "deployments.ts"), deploymentsFile, "utf8");

const indexPath = `${BANNER}
export { votingAbi, VotingPhase } from "./voting-abi";
export {
  CHAIN_IDS,
  deployments,
  getDeployment,
  type Deployment,
} from "./deployments";
`;

await writeFile(path.join(generatedDir, "index.ts"), indexPath, "utf8");

for (const file of ["voting-abi.ts", "deployments.ts", "index.ts"]) {
  console.log(`Wrote ${path.relative(process.cwd(), path.join(generatedDir, file))}`);
}
console.log(`(${records.length} deployment(s) registered)`);
