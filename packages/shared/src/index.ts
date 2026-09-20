// SPDX-License-Identifier: MIT
/**
 * Single source of truth shared by the indexer and the frontend.
 *
 * `voting-abi.ts` and `deployments.ts` are GENERATED — do not edit them by
 * hand. Regenerate with:
 *
 *   pnpm --filter @voting/contracts build
 *   pnpm --filter @voting/contracts export-abi
 *
 * CI re-runs that and fails if the committed output differs, so the ABI can
 * never silently drift from the compiled contract.
 */
export { votingAbi } from "./voting-abi.js";
export { deployments, getDeployment, type Deployment } from "./deployments.js";
export { VotingPhase } from "./voting-abi.js";
