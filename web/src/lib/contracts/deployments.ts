// SPDX-License-Identifier: MIT
// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with: pnpm export-abi

export interface Deployment {
  chainId: number;
  voting: `0x${string}`;
  owner: `0x${string}`;
  deployer: `0x${string}`;
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
 * Deployed addresses by chain id. Populated from `contracts/deployments/*.json`
 * by `export-abi`; empty until the contract is deployed somewhere.
 */
export const deployments: Record<number, Deployment> = {
  31337: {
    chainId: 31337,
    voting: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    owner: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    deployer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    deployedAt: "2026-09-20T03:13:04.650Z",
    blockNumber: 1,
  },
};

/** Returns the deployment for a chain, or undefined when not deployed there. */
export function getDeployment(chainId: number): Deployment | undefined {
  return deployments[chainId];
}
