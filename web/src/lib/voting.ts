import { CHAIN_IDS, getDeployment, PollPhase, factoryAbi, pollAbi } from "./contracts";
import { DEFAULT_LOCALE, type Locale } from "./i18n";

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

/**
 * Chain names in English.
 *
 * Only the entries that are actually prose need a second spelling: `Sepolia` is a
 * protocol name and is written the same way in both languages, so it is not
 * repeated here. A chain with no entry falls back to the identifier form below,
 * which every catalogue already renders untranslated because it is data (a chain
 * id) rather than a sentence.
 */
const EN_CHAIN_NAMES: Record<number, string> = {
  [CHAIN_IDS.hardhat]: "Local Hardhat",
};

/**
 * The chain's name, for a sentence that names it.
 *
 * The locale parameter is what keeps this from leaking Chinese into an English
 * page: this string is interpolated into messages like `list.noFactory`, so
 * without it an English reader was shown
 * "The current chain (31337, 本地 Hardhat) has no registered factory address".
 * That is the mixed-language defect the catalogue exists to remove, arriving
 * through an interpolation value instead of through a literal.
 */
export function chainName(chainId: number, locale: Locale = DEFAULT_LOCALE): string {
  const table = locale === "en" ? EN_CHAIN_NAMES : CHAIN_NAMES;

  return table[chainId] ?? chainUnknown(chainId, locale);
}

/** The name to fall back to for a chain this build has never heard of. */
function chainUnknown(chainId: number, locale: Locale): string {
  return locale === "en" ? `Unknown chain ${chainId}` : `未知链 ${chainId}`;
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
  // A commit-reveal poll's second window. Labelled distinctly rather than reusing
  // "投票中" because the tally is frozen and rising at different times in the two
  // windows, and a reader that saw the same label in both could not tell "nobody
  // voted" from "nobody has revealed yet".
  [PollPhase.Reveal]: "揭示中",
  [PollPhase.Ended]: "已结束",
};

/**
 * The same phases in English, keyed by the SAME enum members.
 *
 * Keyed by name rather than by ordinal on purpose: batch 1 inserted `Reveal` into
 * the contract's enum and shifted `Ended` from 2 to 3, which is the defect that
 * has now broken code in this repository three times. Writing `[PollPhase.Ended]`
 * makes that shift impossible to get wrong.
 */
const EN_PHASE_LABELS: Record<number, string> = {
  [PollPhase.Setup]: "Setup",
  [PollPhase.Voting]: "Voting",
  [PollPhase.Reveal]: "Reveal",
  [PollPhase.Ended]: "Ended",
};

export function phaseLabel(phase: number | undefined, locale: Locale = DEFAULT_LOCALE): string {
  const unknown = locale === "en" ? "Unknown" : "未知";

  if (phase === undefined) {
    return unknown;
  }

  const table = locale === "en" ? EN_PHASE_LABELS : PHASE_LABELS;

  return table[phase] ?? `${unknown} (${phase})`;
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
