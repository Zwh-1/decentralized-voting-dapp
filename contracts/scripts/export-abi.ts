// SPDX-License-Identifier: MIT
/**
 * Publishes the compiled contract interfaces into the web app:
 *
 *   * `voting-abi.ts`   — the `VotingFactory` and `Poll` ABIs, plus the
 *                         `PollPhase` enum mirror
 *   * `deployments.ts`  — chain id -> deployed factory address, read from
 *                         ./deployments
 *   * `index.ts`        — a single entry point that re-exports both
 *
 * They land in `web/src/lib/contracts/`, which keeps the repository at two
 * layers (`contracts/` and `web/`) instead of introducing a third package that
 * exists only to hold generated types.
 *
 * Two ABIs, not one, because there are two contracts now. The factory ABI is
 * what a browser needs to create and list polls; the poll ABI is what it needs
 * to read and write a single one. They are not interchangeable and neither
 * re-exports the other.
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
  factory: string;
  implementation: string;
  deployer: string;
  deployedAt: string;
  /**
   * The block the factory was created in, so the indexer can start there
   * instead of at block 0.
   */
  blockNumber?: number;
}

const BANNER = `// SPDX-License-Identifier: MIT
// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with: pnpm export-abi
`;

async function readArtifact(source: string, name: string): Promise<Artifact> {
  const artifactPath = path.join(contractsDir, "artifacts", "contracts", source, `${name}.json`);

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
 *
 * Read out of the COMPILED ARTIFACT rather than written down here. The literal
 * version of this list went stale the moment `Reveal` was inserted into the
 * contract's enum: `export-abi` kept writing `Ended = 2`, which was then
 * `Reveal`, and every consumer that compared against `PollPhase.Ended` silently
 * compared against the wrong phase. The refund drill caught it — "expected the
 * Ended phase (2), got 3" — but only because the two numbers happened to
 * disagree.
 *
 * The artifact carries the enum in `InvalidPhase`'s `internalType`
 * (`enum Poll.Phase`), which names the type but not its members, so the members
 * come from the contract SOURCE. Both are read here, which means an enum edit
 * cannot leave this mirror behind.
 */
async function buildPhaseEnum(): Promise<string> {
  const source = await readFile(path.join(contractsDir, "contracts", "Poll.sol"), "utf8");

  const match = /enum\s+Phase\s*\{([^}]*)\}/.exec(source);
  if (match === null) {
    throw new Error(
      "Could not find `enum Phase` in contracts/Poll.sol. The generated PollPhase " +
        "mirror is derived from it, so the contract's enum must stay findable.",
    );
  }

  const members = match[1]
    // Strip the doc comments an enum member may carry.
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0);

  if (members.length === 0) {
    throw new Error("`enum Phase` in contracts/Poll.sol parsed to zero members.");
  }

  const lines = members.map((member, index) => `  ${member} = ${index},`).join("\n");

  return `/** Mirrors the on-chain \`Poll.Phase\` enum. Generated from contracts/Poll.sol. */
export enum PollPhase {
${lines}
}
`;
}

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
    let record: Partial<DeploymentRecord> & { voting?: string };
    try {
      record = JSON.parse(await readFile(path.join(dir, file), "utf8")) as typeof record;
    } catch (error) {
      throw new Error(`Malformed deployment file ${file}: ${String(error)}`);
    }

    // A record from before the factory existed carries `voting` and no
    // `factory`. Publishing it would emit the string "undefined" as an address,
    // which typechecks and then fails at runtime as an invalid address — a
    // silent corruption this file is the last place to catch. Naming the file
    // and the fix is the whole point of failing here.
    if (record.factory === undefined || record.implementation === undefined) {
      throw new Error(
        `Deployment record ${file} has no "factory"/"implementation" address` +
          (record.voting === undefined ? "" : ` (it still has the retired "voting" field)`) +
          ".\n" +
          `  This record predates the voting-platform deployment. Re-deploy that chain ` +
          `(pnpm deploy:sepolia or pnpm seed:local) so the record matches the deployed ` +
          `contracts, or delete the file if that chain is no longer in use.`,
      );
    }

    records.push(record as DeploymentRecord);
  }

  return records;
}

await mkdir(generatedDir, { recursive: true });

const factoryArtifact = await readArtifact("VotingFactory.sol", "VotingFactory");
const pollArtifact = await readArtifact("Poll.sol", "Poll");
const phaseEnum = await buildPhaseEnum();

const abiFile = `${BANNER}
/** The deployed \`VotingFactory\` interface, as emitted by solc. */
export const factoryAbi = ${JSON.stringify(factoryArtifact.abi, null, 2)} as const;

/** The \`Poll\` interface, as emitted by solc. Every poll shares it. */
export const pollAbi = ${JSON.stringify(pollArtifact.abi, null, 2)} as const;

${phaseEnum}`;

await writeFile(path.join(generatedDir, "voting-abi.ts"), abiFile, "utf8");

const records = await readDeployments();

const entries = records
  .map(
    // `deployedAt` is deliberately not published here. It is a timestamp, so any
    // local `deploy:local` or `seed:local` changes it, and this file is guarded
    // by a byte-exact diff in CI. Carrying a volatile field into that artifact
    // meant a contributor saw the drift check fail with no semantic change —
    // which teaches people to ignore it. Every field below is reproducible from
    // the chain alone.
    (record) => `  ${record.chainId}: {
    chainId: ${record.chainId},
    factory: "${record.factory}",
    implementation: "${record.implementation}",
    deployer: "${record.deployer}",
    blockNumber: ${record.blockNumber ?? "undefined"},
  },`,
  )
  .join("\n");

const deploymentsFile = `${BANNER}
export interface Deployment {
  chainId: number;
  /** The factory that creates polls. This is what the app talks to. */
  factory: \`0x\${string}\`;
  /** The implementation every poll clone delegates to. Informational. */
  implementation: \`0x\${string}\`;
  deployer: \`0x\${string}\`;
  /**
   * The block the factory was created in. The indexer starts here rather than
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
 * by \`export-abi\`; empty until the factory is deployed somewhere.
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
export { factoryAbi, pollAbi, PollPhase } from "./voting-abi";
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
