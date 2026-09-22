// SPDX-License-Identifier: MIT
/**
 * Verifies the deployed contracts on Sourcify.
 *
 *   pnpm --filter @voting/contracts verify:sourcify
 *
 * Why this exists next to `verify.ts`.
 *
 * `verify.ts` submits to Etherscan, and on the machine this project was built
 * on that route is dead: the local DNS resolver answers `api.etherscan.io` and
 * `eth-sepolia.blockscout.com` with Meta-owned addresses (`2a03:2880:...:face:b00c::`)
 * that refuse TCP 443. That is a fact about one machine, not about the
 * contracts, but it left "is the source readable by a stranger?" unanswered.
 *
 * Sourcify is reachable from the same machine, and it is a stronger claim than
 * a block explorer anyway: it recompiles the sources and compares the result
 * byte for byte against the deployed runtime code. Verification therefore does
 * not depend on Etherscan being reachable, nor on any API key.
 *
 * This script does NOT replace `verify.ts`. It is the second, independent
 * route, and it is the one that can run on a machine whose DNS is poisoned.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

interface DeploymentRecord {
  chainId: number;
  factory: `0x${string}`;
  implementation: `0x${string}`;
  deployer: `0x${string}`;
  deployedAt: string;
  blockNumber?: number;
}

const SOURCIFY = "https://sourcify.dev/server";

const recordPath = path.resolve(
  import.meta.dirname,
  "..",
  "deployments",
  `${process.env.CHAIN_ID ?? 11155111}.json`,
);

let record: DeploymentRecord;

try {
  record = JSON.parse(await readFile(recordPath, "utf8")) as DeploymentRecord;
} catch {
  throw new Error(`No deployment recorded at ${recordPath}. Run the matching deploy script first.`);
}

// The build info carries the exact compiler settings Hardhat used, which is
// what makes the comparison meaningful: a recompile with different optimizer
// settings produces different bytecode and would not match.
const buildInfoPath = path.resolve(import.meta.dirname, "..", "artifacts", "build-info");

const { readdir } = await import("node:fs/promises");
const buildInfoFiles = (await readdir(buildInfoPath)).filter(
  (f) => f.endsWith(".json") && !f.includes("output"),
);

if (buildInfoFiles.length === 0) {
  throw new Error(`No build info under ${buildInfoPath}. Run \`pnpm build:contracts\` first.`);
}

interface BuildInfo {
  solcLongVersion: string;
  input: {
    language: string;
    sources: Record<string, { content: string }>;
    settings: Record<string, unknown>;
  };
}

const results: { label: string; address: string; outcome: string }[] = [];

for (const file of buildInfoFiles) {
  const build = JSON.parse(await readFile(path.join(buildInfoPath, file), "utf8")) as BuildInfo;

  // Hardhat 3 names every source with a `project/` prefix inside the build
  // info, so the fully qualified identifier Sourcify must be given is
  // `project/contracts/Poll.sol:Poll`. Guessing `contracts/Poll.sol:Poll`
  // instead makes Sourcify recompile and answer
  // `contract_not_found_in_compiler_output` — the submission is accepted, the
  // job completes, and nothing is verified. The prefix is read from the build
  // info rather than hard-coded so a Hardhat change surfaces as a clear error.
  const sourcePrefix = Object.keys(build.input.sources).some((key) => key.startsWith("project/"))
    ? "project/"
    : "";

  const targets = [
    {
      label: "VotingFactory",
      address: record.factory,
      identifier: `${sourcePrefix}contracts/VotingFactory.sol:VotingFactory`,
    },
    {
      label: "Poll (implementation)",
      address: record.implementation,
      identifier: `${sourcePrefix}contracts/Poll.sol:Poll`,
    },
  ];

  for (const target of targets) {
    // Only the fields Sourcify stores are accepted; `outputSelection` and the
    // rest of Hardhat's input are dropped deliberately.
    const stdJsonInput = {
      language: build.input.language,
      sources: build.input.sources,
      settings: build.input.settings,
    };

    const body = {
      stdJsonInput,
      compilerVersion: build.solcLongVersion,
      contractIdentifier: target.identifier,
    };

    // Ask first, submit second. A contract that is already verified comes back
    // from a submission as HTTP 409 with `runtimeMatch: exact_match` in the
    // message, so treating any non-OK response as failure made a second run of
    // an already-passing command fail — and made this script unusable as a
    // re-runnable check.
    //
    // No `fields` selector: `match` is not a valid one and asking for it makes
    // the lookup fail with `invalid_parameter`, which is indistinguishable from
    // "not verified" unless the response is actually checked.
    const existingResponse = await fetch(
      `${SOURCIFY}/v2/contract/${record.chainId}/${target.address}`,
    );

    if (existingResponse.ok) {
      const existing = (await existingResponse.json()) as { runtimeMatch?: string | null };

      if (existing.runtimeMatch === "exact_match") {
        results.push({
          label: target.label,
          address: target.address,
          outcome: "exact_match (already verified)",
        });
        continue;
      }
    }

    const response = await fetch(`${SOURCIFY}/v2/verify/${record.chainId}/${target.address}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as {
      verificationId?: string;
      message?: string;
      customCode?: string;
    };

    // A 409 says the contract is already verified; the earlier lookup above
    // already handled the passing case, so reaching here means it is verified
    // with a *different* match level, which is not something this script calls
    // success.
    if (!response.ok || payload.verificationId === undefined) {
      results.push({
        label: target.label,
        address: target.address,
        outcome: `submission failed (HTTP ${response.status}): ${payload.message ?? payload.customCode ?? "no message"}`,
      });
      continue;
    }

    // The submission is asynchronous: poll until the server reports a verdict.
    let verdict = "pending (timed out before the job completed)";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const statusResponse = await fetch(`${SOURCIFY}/v2/verify/${payload.verificationId}`);
      const status = (await statusResponse.json()) as {
        isJobCompleted?: boolean;
        contract?: { match?: string | null };
        error?: { customCode?: string; message?: string };
      };

      if (status.isJobCompleted === true) {
        // A completed job can still have failed. Reporting the server's own
        // error code is the difference between "not verified" and knowing that
        // the identifier was wrong; the earlier version printed "no match
        // field" and hid the actual cause.
        if (status.error !== undefined && status.error !== null) {
          verdict = `${status.error.customCode ?? "error"}: ${status.error.message ?? ""}`.trim();
        } else {
          verdict = status.contract?.match ?? "completed without a match field";
        }
        break;
      }
    }

    results.push({ label: target.label, address: target.address, outcome: String(verdict) });
  }
}

console.log("");
console.log(`Sourcify verification for chain ${record.chainId}`);
console.log("");

let failed = false;

for (const result of results) {
  console.log(`  ${result.label.padEnd(22)} ${result.address}  ->  ${result.outcome}`);
  // A contract verified on an earlier run is exactly as verified as one this
  // run submitted, so both forms count as success.
  if (!result.outcome.startsWith("exact_match")) failed = true;
}

console.log("");

if (failed) {
  throw new Error("At least one contract did not reach `exact_match` on Sourcify.");
}

console.log("Both contracts match exactly. A cloned poll shows as a proxy on an");
console.log("explorer; the verified logic is the Poll implementation above.");
console.log("");
console.log("Browse: https://repo.sourcify.dev/" + record.chainId + "/" + record.factory);
