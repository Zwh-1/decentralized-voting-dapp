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
    factory: "0xcf01c9d51911f189b40d9287bcf21a638c36bf92",
    implementation: "0xb853ce67cdfa7e7d67c2ce0c2ef4f62a3d0add6b",
    deployer: "0x409da00516d14a11b180df8460e3ffd68a239589",
    blockNumber: 11754569,
  },
  31337: {
    chainId: 31337,
    factory: "0x773330693cb7d5d233348e25809770a32483a940",
    implementation: "0xfe0fbbd1a28b25d9a4719902490fac432e910cab",
    deployer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    blockNumber: 824,
  },
};

/** Returns the deployment for a chain, or undefined when not deployed there. */
export function getDeployment(chainId: number): Deployment | undefined {
  return deployments[chainId];
}
