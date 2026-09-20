import { getDeployment, votingAbi, VotingPhase } from "@voting/shared";

export { votingAbi, VotingPhase };

/** Must equal `Voting.STAKE`. A vote with any other value reverts. */
export const STAKE = 1_000_000_000_000_000n;

/** `Voting.REFUND_GRACE_PERIOD`, in seconds. */
export const REFUND_GRACE_PERIOD_SECONDS = 30n * 24n * 60n * 60n;

/**
 * The deployed address for the chain the wallet is on, or undefined.
 *
 * Reading this from the generated registry rather than hardcoding it is what
 * lets one build serve both a local node and Sepolia.
 */
export function votingAddressFor(chainId: number | undefined): `0x${string}` | undefined {
  if (chainId === undefined) {
    return undefined;
  }

  return getDeployment(chainId)?.voting;
}

export const PHASE_LABELS: Record<number, string> = {
  [VotingPhase.Setup]: "设置中",
  [VotingPhase.Voting]: "投票中",
  [VotingPhase.Ended]: "已结束",
};

export function phaseLabel(phase: number | undefined): string {
  if (phase === undefined) {
    return "未知";
  }

  return PHASE_LABELS[phase] ?? `未知 (${phase})`;
}

export function formatEth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, "0").replace(/0+$/, "");

  return fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`;
}

export function shortenAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
