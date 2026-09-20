import { existsSync } from "node:fs";
import path from "node:path";

import { configVariable, defineConfig } from "hardhat/config";

import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";

/**
 * Loads `contracts/.env` before any Configuration Variable is resolved.
 *
 * Hardhat 3 does not read a `.env` file on its own — it resolves
 * Configuration Variables from the real environment or the keystore. Since
 * `.env.example` tells people to copy it to `.env`, that instruction was a
 * dead end: the file was read by nothing, and the next command failed with
 * `HHE7: Configuration Variable not found` while the value sat right there.
 *
 * Node's built-in loader keeps this dependency-free, and it matches `--env-file`
 * semantics: an already-exported variable wins, so a shell override still works.
 */
const envFile = path.resolve(import.meta.dirname, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  plugins: [
    hardhatViem,
    hardhatViemAssertions,
    hardhatNodeTestRunner,
    hardhatNetworkHelpers,
    hardhatVerify,
  ],

  solidity: {
    version: "0.8.37",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  paths: {
    // Solidity tests live next to the sources as *.t.sol, following the
    // official Hardhat 3 tutorial layout. TypeScript tests live in ./test.
    sources: "./contracts",
    tests: { nodejs: "./test" },
    cache: "./cache",
    artifacts: "./artifacts",
  },

  networks: {
    // A `hardhat node` process, used for the end-to-end verification and for
    // local development. No secrets involved, so this stays a plain env var
    // rather than a Configuration Variable.
    //
    // `LOCALHOST_RPC_URL` exists so a second, throwaway chain can run on another
    // port without disturbing one already in use — which is what lets the
    // end-to-end verification (deploy, seed, index, compare) be rehearsed
    // against a fresh chain while a working one keeps its state.
    localhost: {
      type: "http",
      chainType: "l1",
      url: process.env.LOCALHOST_RPC_URL ?? "http://127.0.0.1:8545",
    },

    // Secrets are never committed: resolved through Configuration Variables
    // (env vars, or `hardhat keystore set`). See .env.example.
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },

    // Verification publishes the source of an address that is already deployed,
    // so it never signs anything. This entry deliberately declares no `accounts`:
    // Hardhat resolves the network it is given before the script's own guards
    // run, so pointing verification at `sepolia` made it demand the deployer's
    // private key merely to read a public contract — a needless coupling, and
    // one that would put the key into CI and into any machine that verifies.
    sepoliaReadOnly: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
    },
  },

  test: {
    solidity: {
      // M-4 evidence: fuzz tests run 256 cases each.
      //
      // There is deliberately no `invariant` block here. Hardhat 3.17.0
      // evaluates `invariant_*` functions but never invokes a target contract,
      // so any invariant reading a ghost counter passes vacuously. The 1000
      // round evidence for M-4 comes from
      // contracts/contracts/VotingProperties.t.sol instead, which is validated
      // by a mutation-based negative control. See the design spec's correction
      // log for the full experiment.
      fuzz: { runs: 256 },
    },
  },

  coverage: {
    // Test-only fixtures must not inflate or dilute the production coverage
    // number: VulnerableRefund.sol exists solely as the attack counterpart.
    skipFiles: ["**/test/**", "**/*.t.sol"],
  },

  verify: {
    // Etherscan only: one deterministic provider is easier to reason about than
    // three that can disagree about the same bytecode. Sourcify is off for that
    // reason, not because it is unusable.
    //
    // The key is resolved lazily, so `hardhat test` and `hardhat build` keep
    // working without it; only verification requires it.
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
    sourcify: {
      enabled: false,
    },
  },
});
