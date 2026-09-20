import { configVariable, defineConfig } from "hardhat/config";

import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";

export default defineConfig({
  plugins: [hardhatViem, hardhatViemAssertions, hardhatNodeTestRunner, hardhatNetworkHelpers],

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
    // local development. No secrets involved.
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },

    // Secrets are never committed: resolved through Configuration Variables
    // (env vars, or `hardhat keystore set`). See .env.example.
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
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
});
