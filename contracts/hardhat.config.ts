import { configVariable, defineConfig } from "hardhat/config";

import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";

export default defineConfig({
  plugins: [
    hardhatViem,
    hardhatViemAssertions,
    hardhatNodeTestRunner,
    hardhatNetworkHelpers,
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
      // M-4 evidence: 1000 invariant runs, each exploring up to 100 calls.
      fuzz: { runs: 256 },
      invariant: { runs: 1000, depth: 100 },
    },
  },

  coverage: {
    // Test-only fixtures must not inflate or dilute the production coverage
    // number: VulnerableRefund.sol exists solely as the attack counterpart.
    skipFiles: ["**/test/**", "**/*.t.sol"],
  },
});
