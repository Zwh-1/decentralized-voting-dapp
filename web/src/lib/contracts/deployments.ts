// SPDX-License-Identifier: MIT
// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with: pnpm export-abi

export interface Deployment {
  chainId: number;
  /** The factory that creates polls. This is what the app talks to. */
  factory: `0x${string}`;
  /** The implementation every poll clone delegates to. Informational. */
  implementation: `0x${string}`;
  deployer: `0x${string}`;
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
 * Deployed addresses by chain id. Populated from `contracts/deployments/*.json`
 * by `export-abi`; empty until the factory is deployed somewhere.
 */
export const deployments: Record<number, Deployment> = {
  11155111: {
    chainId: 11155111,
    factory: "0xc6c080938113b7b069d9ba64a2d9c062399a22b2",
    implementation: "0x07d1f6bc75ad4117172cd6994f9934a5d0bf1a45",
    deployer: "0x409da00516d14a11b180df8460e3ffd68a239589",
    blockNumber: 11754540,
  },
  31337: {
    chainId: 31337,
    factory: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    implementation: "0xa16e02e87b7454126e5e10d957a927a7f5b5d2be",
    deployer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    blockNumber: 1,
  },
};

/** Returns the deployment for a chain, or undefined when not deployed there. */
export function getDeployment(chainId: number): Deployment | undefined {
  return deployments[chainId];
}
