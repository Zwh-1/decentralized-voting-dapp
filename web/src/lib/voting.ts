import { CHAIN_IDS, getDeployment, PollPhase, factoryAbi, pollAbi } from "./contracts";

export { factoryAbi, pollAbi, PollPhase };

/** Must equal `Poll.STAKE`. A vote with any other value reverts. */
export const STAKE = 1_000_000_000_000_000n;

/**
 * `Poll.REFUND_GRACE_PERIOD`, in seconds — seven days.
 *
 * This used to say thirty days, which was simply wrong: the contract's grace
 * period has always been seven. Nothing compared the two, so the page could
 * claim a voter had more time than the chain would give them. The value is
 * asserted against the chain in `voting.test.ts` so it cannot drift again.
 */
export const REFUND_GRACE_PERIOD_SECONDS = 7n * 24n * 60n * 60n;

/**
 * Human-readable names for the chains this project can be deployed to.
 *
 * Keyed by the same ids `contracts/` records deployments under, so a chain that
 * gets a deployment record gets a name here by construction rather than by
 * another edit.
 */
export const CHAIN_NAMES: Record<number, string> = {
  [CHAIN_IDS.hardhat]: "本地 Hardhat",
  [CHAIN_IDS.sepolia]: "Sepolia",
};

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `未知链 ${chainId}`;
}

/** A chain and the `VotingFactory` address deployed on it. */
export interface ChainTarget {
  chainId: number;
  factoryAddress: `0x${string}`;
}

/**
 * Which chain, and which factory on it, the browser must read and write.
 *
 * A connected wallet is authoritative whenever there is one: the transaction is
 * signed by that wallet on that wallet's chain, so the address has to be the one
 * deployed there. With no wallet there is nothing to sign with, and the page must
 * still describe the chain the *server* is reading.
 *
 * That second case was wrong and it was the visible one. `useChainId()` returns
 * the first chain registered in `lib/wagmi.ts` — the local Hardhat node — when no
 * wallet is connected, whatever `CHAIN_ID` says. Against a Sepolia-configured
 * deployment the page therefore rendered the *local* contract's address while the
 * server read Sepolia, and every `eth_call` behind it went to
 * `http://127.0.0.1:8545`, which was not running: the phase row read 未知 forever,
 * and the vote button could never be enabled. Two chains in one page, and the
 * page named the wrong one. See ADR-0019.
 */
export function resolveChainTarget(input: {
  walletConnected: boolean;
  walletChainId: number;
  configured: ChainTarget | null;
}): ChainTarget | null {
  if (!input.walletConnected && input.configured !== null) {
    return input.configured;
  }

  const deployment = getDeployment(input.walletChainId);

  return deployment === undefined
    ? null
    : { chainId: input.walletChainId, factoryAddress: deployment.factory };
}

export const PHASE_LABELS: Record<number, string> = {
  [PollPhase.Setup]: "设置中",
  [PollPhase.Voting]: "投票中",
  [PollPhase.Ended]: "已结束",
};

export function phaseLabel(phase: number | undefined): string {
  if (phase === undefined) {
    return "未知";
  }

  return PHASE_LABELS[phase] ?? `未知 (${phase})`;
}

export function formatEth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");

  return fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`;
}

export function shortenAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Whether a poll has passed its deadline but has not yet been closed.
 *
 * The contract enforces this too (`vote` and `changeVote` both revert once
 * `block.timestamp >= endsAt`), but the page has to know it as well: otherwise
 * it offers a button that can only fail, and the failure arrives as a wallet
 * prompt the reader has no reason to expect. See ADR-0009 — eligibility is read
 * from the chain, not guessed.
 */
export function isPastDeadline(input: { endsAt: bigint; nowSeconds: bigint }): boolean {
  return input.nowSeconds >= input.endsAt;
}
