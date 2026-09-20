// SPDX-License-Identifier: MIT
// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with: pnpm --filter @voting/contracts export-abi

export interface Deployment {
  chainId: number;
  voting: `0x${string}`;
  owner: `0x${string}`;
  deployer: `0x${string}`;
  deployedAt: string;
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

};

/** Returns the deployment for a chain, or undefined when not deployed there. */
export function getDeployment(chainId: number): Deployment | undefined {
  return deployments[chainId];
}
