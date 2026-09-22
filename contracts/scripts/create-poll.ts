// SPDX-License-Identifier: MIT
/**
 * Creates a poll on an already-deployed `VotingFactory`, for a real testnet.
 *
 * Why this exists next to `seed-local.ts`: that script deploys its own factory
 * and signs with the accounts a local `hardhat node` funds for free. Neither
 * holds on a testnet, where the poll is created by whichever key signs and each
 * call costs real (test) gas. So this reads the factory address back from
 * `deployments/<chainId>.json`, connects with the deployer key, and creates one
 * poll — optionally whitelisting voters in the same run.
 *
 * With the factory, "seeding a ballot" is just "creating a poll": there is no
 * owner to satisfy, no Setup phase to advance through by hand, and no candidate
 * list that becomes unchangeable. The creator of the poll is the signer.
 *
 *   SEED_VOTERS=0xabc…,0xdef… pnpm create-poll:sepolia
 *
 * The voter list arrives through the environment rather than a file in the repo,
 * so a real address does not have to be committed to whitelist it. An empty
 * variable counts as "not set" — a blank value that a caller thinks is "unset"
 * must not silently turn into a different instruction.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";

import { cidProblem } from "./cid";
import { seedableCids } from "./metadata";
import { preflight } from "./preflight";

/**
 * The default mechanism set: single-select, equal weight, no delegation, public
 * ballot, whitelist admission.
 *
 * `createPoll` takes a `PollConfig` struct, so a caller has to state the
 * mechanisms rather than omit them. This constant is that statement for the
 * common case — and it is deliberately named for what it is, so a script that
 * wants a different mechanism is forced to write a different value instead of
 * quietly inheriting this one.
 */
const DEFAULT_CONFIG = {
  openToAll: false,
  multiSelect: false,
  maxSelections: 0n,
  weighted: false,
  delegable: false,
  commitReveal: false,
  revealWindowSeconds: 0n,
} as const;

/** Split a comma-separated variable, treating blank exactly as absent. */
function listFrom(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Option metadata CIDs.
 *
 * The default is `metadata/manifest.json`: the CIDs this repository pinned, each
 * proved to name the document beside it. That is deliberate — a CID typed into
 * this file is a claim nothing can check, which is how a live ballot ended up
 * with `bafyseededcandidate0` in its storage, permanently, because the old
 * contract's `addCandidate` was Setup-only.
 *
 * `SEED_CANDIDATES` still overrides it, for aiming a poll at metadata pinned
 * somewhere else. An override is required to *be* a CID (parsed, not pattern
 * matched) and to be one the browser will resolve; it is not evidence that the
 * content exists, so the run says which source it used rather than implying the
 * two are equally checked.
 */
const overridden = listFrom("SEED_CANDIDATES");

for (const [index, cid] of overridden.entries()) {
  const problem = cidProblem(cid);
  if (problem !== null) {
    throw new Error(
      `SEED_CANDIDATES entry ${index + 1} cannot name an option document: ${problem}\n` +
        `The entry is not printed — reports here carry the shape of a value, never the value ` +
        `(see scripts/preflight.ts). Fix or drop the entry, or unset SEED_CANDIDATES to use ` +
        `the pinned documents in metadata/.`,
    );
  }
}

const CIDS = overridden.length > 0 ? overridden : await seedableCids();
const CID_SOURCE =
  overridden.length > 0
    ? "SEED_CANDIDATES (not checked against a pinned document)"
    : "metadata/manifest.json (each CID verified against its document)";

/** Voters to whitelist, comma-separated addresses. Absent means "none". */
const VOTERS = listFrom("SEED_VOTERS") as `0x${string}`[];

/** The question to ask. */
const QUESTION = process.env.POLL_QUESTION ?? "Which proposal should the community fund first?";

/** How long the poll stays open, in days. */
const DAYS = Number(process.env.POLL_DAYS ?? 30);

/** The network named by `--network`, read the same way `deploy.ts` reads it. */
function requestedNetwork(): string {
  const index = process.argv.indexOf("--network");

  return index === -1 ? "hardhat" : (process.argv[index + 1] ?? "hardhat");
}

const networkName = requestedNetwork();
preflight(networkName);

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [signer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

const recordPath = path.resolve(import.meta.dirname, "..", "deployments", `${chainId}.json`);

let record: { factory?: string };
try {
  record = JSON.parse(await readFile(recordPath, "utf8")) as { factory?: string };
} catch {
  throw new Error(
    `no deployment record at contracts/deployments/${chainId}.json — deploy this chain first ` +
      `(pnpm deploy:sepolia), then publish the address with pnpm export-abi.`,
  );
}

if (record.factory === undefined) {
  throw new Error(
    `contracts/deployments/${chainId}.json has no "factory" address; nothing to create a poll ` +
      `with. Deploy the factory first (pnpm deploy:sepolia).`,
  );
}

if (CIDS.length < 2) {
  throw new Error(
    `a poll needs at least 2 options, but only ${CIDS.length} CID(s) are available from ` +
      `${CID_SOURCE}. Pin more documents (pnpm pin:metadata) or set SEED_CANDIDATES.`,
  );
}

const factory = await viem.getContractAt("VotingFactory", record.factory as `0x${string}`);

const latest = await publicClient.getBlock();
const endsAt = latest.timestamp + BigInt(Math.round(DAYS * 24 * 60 * 60));

console.log(`Network:  ${networkName} (chain ${chainId})`);
console.log(`Factory:  ${record.factory}`);
console.log(`Signer:   ${signer.account.address}`);
console.log(`Question: ${QUESTION}`);
console.log(`Options:  ${CIDS.length}, from ${CID_SOURCE}`);
console.log(`Closes:   ${new Date(Number(endsAt) * 1000).toISOString()}`);
console.log("");

/** Wait for a transaction and report it, so a partial run is still legible. */
async function confirm(what: string, hash: `0x${string}`): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${what}`);
  console.log(`  tx ${hash} (block ${receipt.blockNumber}, ${receipt.status})`);
}

const before = Number(await factory.read.pollCount());

const hash = await factory.write.createPoll([QUESTION, CIDS, endsAt, DEFAULT_CONFIG]);
await confirm(`createPoll(${CIDS.length} option(s))`, hash);

const after = Number(await factory.read.pollCount());

if (after !== before + 1) {
  throw new Error(
    `the factory reported ${before} poll(s) before and ${after} after, which is not one more. ` +
      `Something is wrong with the deployment record or the factory address.`,
  );
}

// Read the address back from the factory rather than decoding the event: the
// factory is the authority on which polls exist, so a decode mistake cannot make
// this script and the chain disagree.
const pollAddress = await factory.read.pollAt([BigInt(after - 1)]);

console.log("");
console.log(`Poll created at ${pollAddress}`);

const poll = await viem.getContractAt("Poll", pollAddress);

if (VOTERS.length > 0) {
  await confirm(
    `setWhitelist(${VOTERS.length} address(es))`,
    await poll.write.setWhitelist([VOTERS, true]),
  );
} else {
  console.log("setWhitelist: skipped — SEED_VOTERS is empty, so nobody can vote yet.");
}

await confirm("startPoll()", await poll.write.startPoll());

const phase = Number(await poll.read.phase());

console.log("");
console.log(`Poll is open (phase ${phase}).`);

if (VOTERS.length > 0) {
  console.log("Whitelist check:");
  for (const voter of VOTERS) {
    const allowed = await poll.read.isWhitelisted([voter]);
    console.log(`  ${voter} -> ${allowed ? "can vote" : "NOT whitelisted"}`);
  }
} else {
  console.log(
    "No voters were whitelisted. Re-run with SEED_VOTERS=<address>, which still works while " +
      "the poll is open.",
  );
}
