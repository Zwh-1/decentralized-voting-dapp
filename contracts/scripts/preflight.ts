// SPDX-License-Identifier: MIT
/**
 * Validates a deployment's inputs before anything connects to a network.
 *
 * Two reasons this is its own module rather than a few lines inside `deploy.ts`:
 *
 * 1. **It must name the variable a human has to edit.** `VOTING_OWNER` reached
 *    viem as a bare `as \`0x${string}\`` cast, so a mistyped owner surfaced as an
 *    `InvalidAddressError` that never mentioned the variable — measured on a real
 *    value of the wrong shape. The same class of message as ADR-0012 asks for:
 *    a failure has to say which party is at fault.
 * 2. **It must not echo a secret.** That same `InvalidAddressError` prints the
 *    offending value, so a misplaced deployer key would land in the terminal and
 *    in CI logs. These reports carry the *shape* of a value — how long it is and
 *    what was expected — never the value.
 *
 * Presence alone is not enough: both failures above come from a variable that was
 * set and unusable, which is the state a hand-edited `.env` actually reaches.
 */

/** One thing a human must fix, named so they can find it. */
export interface Problem {
  /** The environment variable to edit. */
  name: string;
  /** What is wrong with it, and what a usable value looks like. Never the value. */
  detail: string;
}

export type Env = Record<string, string | undefined>;

/** Networks that take their credentials from the local node, not from a human. */
const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** Required to sign a deployment, with what to tell someone who has not set one. */
const REQUIRED = [
  [
    "SEPOLIA_RPC_URL",
    "a Sepolia JSON-RPC endpoint, e.g. https://ethereum-sepolia-rpc.publicnode.com",
  ],
  ["SEPOLIA_PRIVATE_KEY", "a DEDICATED throwaway deployer key funded with test ETH"],
] as const;

/** The names that are secrets, and so may also be stored encrypted. */
const CREDENTIALS: readonly string[] = REQUIRED.map(([name]) => name);

function describedLength(value: string): string {
  return `${value.length} character${value.length === 1 ? "" : "s"}`;
}

/**
 * Every problem with a deployment's configuration, in the order a reader should
 * fix them. Empty means "nothing to report", not "the deployment will succeed".
 *
 * The two concerns are gated differently on purpose. Credentials are only needed
 * where the node does not supply its own accounts, so they are skipped for local
 * networks. `VOTING_OWNER` is a deployment *input* that applies to every network:
 * gating it on the network name too let a mistyped owner through on
 * `deploy:local`, where it reached viem — and viem echoes the value, so a
 * measured `contracts/.env` printed a 32-byte secret into the terminal.
 */
export function configurationProblems(networkName: string, env: Env): Problem[] {
  const problems: Problem[] = [];
  const local = LOCAL_NETWORKS.has(networkName);

  if (!local) {
    for (const [name, what] of REQUIRED) {
      const value = env[name];

      if (value === undefined || value.length === 0) {
        problems.push({ name, detail: `is not set — needs ${what}` });
      }
    }

    const rpcUrl = env.SEPOLIA_RPC_URL;
    if (rpcUrl !== undefined && rpcUrl.length > 0) {
      let usable = false;
      try {
        const parsed = new URL(rpcUrl);
        usable = parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        usable = false;
      }

      if (!usable) {
        problems.push({
          name: "SEPOLIA_RPC_URL",
          detail:
            "is not an http(s) URL — needs a Sepolia JSON-RPC endpoint, e.g. " +
            "https://ethereum-sepolia-rpc.publicnode.com",
        });
      }
    }

    const key = env.SEPOLIA_PRIVATE_KEY;
    if (key !== undefined && key.length > 0 && !PRIVATE_KEY.test(key)) {
      problems.push({
        name: "SEPOLIA_PRIVATE_KEY",
        detail:
          `is not a 32-byte hex private key (expected "0x" followed by 64 hex characters); ` +
          `this value is ${describedLength(key)}`,
      });
    }
  }

  // Optional everywhere, but present-and-wrong is the case that produced an
  // unattributed viem error: a 32-byte secret pasted into the address field.
  const owner = env.VOTING_OWNER;
  if (owner !== undefined && owner.length > 0 && !ADDRESS.test(owner)) {
    problems.push({
      name: "VOTING_OWNER",
      detail:
        `is not an Ethereum address (expected "0x" followed by 40 hex characters); ` +
        `this value is ${describedLength(owner)}. Leave it unset to make the deployer ` +
        `the owner. If this looks like a private key, do not keep it here — a private ` +
        `key belongs in SEPOLIA_PRIVATE_KEY at most, and should be rotated if it was ` +
        `pasted somewhere it does not belong.`,
    });
  }

  return problems;
}

/**
 * Throws with the project's own instructions rather than Hardhat's generic
 * "Configuration Variable not found", naming every problem at once instead of one
 * per attempt.
 */
export function preflight(networkName: string, env: Env = process.env): void {
  const problems = configurationProblems(networkName, env);

  if (problems.length === 0) {
    return;
  }

  const secrets = problems.filter((problem) => CREDENTIALS.includes(problem.name));

  throw new Error(
    `Deploying to "${networkName}" needs ${problems.length} configuration ` +
      `${problems.length === 1 ? "fix" : "fixes"}:\n` +
      problems.map((problem) => `  ${problem.name} — ${problem.detail}`).join("\n") +
      "\n\nEither export them, put them in contracts/.env" +
      (secrets.length === 0
        ? ""
        : ", or store the credentials encrypted:\n" +
          secrets.map((problem) => `  npx hardhat keystore set ${problem.name}`).join("\n")) +
      "\n\nSee contracts/.env.example for the full list.",
  );
}
