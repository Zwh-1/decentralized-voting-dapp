// SPDX-License-Identifier: MIT
/**
 * Why each control on the ballot is or is not available.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module rather than five closures inside the component
 * ---------------------------------------------------------------------------
 *
 * These functions decide what the reader is told about their own money. Every
 * branch names a distinct cause (ADR-0012), the order follows the contract's own
 * checks so the sentence matches the revert the reader would otherwise get
 * (ADR-0009), and no branch ever invents a cause for an error it did not
 * recognise (ADR-0020) — those are correctness rules, not presentation.
 *
 * They used to live inside `PollBallot.tsx`, where the only way to test them was
 * a browser drill: the component imports wagmi, React and a query client, so
 * nothing about it can be driven from `node --test`. Extracting them makes each
 * rule a plain function call, and `ballot-reasons.test.ts` now asserts them
 * directly instead of through a headless Chrome.
 *
 * The shape is deliberate: one `BallotInputs` value in, one sentence out. No
 * closures over hook results, no ordering hidden in a component body — the order
 * IS the specification, and it is now visible and testable in one file.
 *
 * ---------------------------------------------------------------------------
 * What the language parameter did and did not change
 * ---------------------------------------------------------------------------
 *
 * Every sentence now comes from `BallotPhrases` (see `i18n/ballot-phrases.ts`),
 * and each function takes an optional `locale`. The ORDER of the checks, the
 * predicates and the set of causes are untouched — that is the part that encodes
 * the contract's behaviour, and a translation must not be able to reorder a
 * reader's rights. Only the wording moved.
 *
 * `locale` defaults to `DEFAULT_LOCALE`, so every pre-existing call site keeps
 * producing exactly the sentence it produced before. That is what makes the
 * extraction additive rather than a rewrite.
 */
import { chainName, PollPhase } from "./voting";
import type { ReadState } from "./ballot-labels";
import {
  ballotPhrasesFor,
  DEFAULT_LOCALE,
  interpolate,
  type BallotPhrases,
  type Locale,
} from "./i18n";

/** Everything the reason functions need. All of it comes from chain reads. */
export interface BallotInputs {
  /** False when the connected chain has no registered factory. */
  contractKnown: boolean;
  /** The chain the page is asking, for the "wrong network" sentence. */
  subjectChainId: number;
  isConnected: boolean;
  /** True while any write for this page is outstanding. */
  txBusy: boolean;

  phaseState: ReadState;
  voterState: ReadState;

  /** 0 Setup, 1 Voting, 2 Ended. Undefined while unread. */
  phase: number | undefined;
  /** True when the poll's own `endsAt` has passed, per the browser clock. */
  deadlinePassed: boolean;

  /** The contract's own admission decision: `openToAll || isWhitelisted`. */
  canVote: boolean;
  /** The raw whitelist answer, used only to explain a refusal precisely. */
  whitelisted: boolean;
  /** True when the address currently backs an option. */
  marked: boolean;
  /** The option the address currently backs; 0 when it backs none. */
  myOptionId: number;
  /** The stake held for the address, in wei. */
  myStake: bigint | undefined;

  /**
   * True when a SEALED commitment is on file and has not been revealed.
   *
   * Distinct from `marked`, which is "has a counted ballot". On a commit-reveal
   * poll `marked` is false while a ballot is sealed, so a UI given only `marked`
   * would tell a committed voter it had not voted — reporting participation as
   * non-participation (ADR-0011).
   */
  committed: boolean;
}

/**
 * The sentence for a write that has to wait; shared by every control.
 *
 * Still exported as a constant because the ballot renders it in more than one
 * place, and a second spelling of it would be the drift this module exists to
 * prevent. It now reads the phrase table rather than holding its own copy.
 */
export const BUSY_REASON: string = ballotPhrasesFor(DEFAULT_LOCALE).busy;

/** `Phase.Ended`, or a `Voting` poll whose deadline has passed. */
function votingClosed(input: BallotInputs): boolean {
  return (
    input.phase === PollPhase.Ended || (input.phase === PollPhase.Voting && input.deadlinePassed)
  );
}

/**
 * A commit-reveal poll whose voting window has closed but whose reveal window is
 * still open.
 *
 * A separate predicate rather than folding `Reveal` into `votingClosed`, because
 * the REMEDY differs: on a closed poll a voter's next move is to take its stake
 * back, whereas during `Reveal` its next move is to reveal — and `refund()`
 * still reverts, so pointing at it would send the reader at a call the contract
 * rejects.
 */
function isReveal(input: BallotInputs): boolean {
  return input.phase === PollPhase.Reveal;
}

function isSetup(input: BallotInputs): boolean {
  return input.phase === PollPhase.Setup;
}

/**
 * The "wrong chain / no factory" sentence. Named once so it cannot drift.
 *
 * The placeholders go through the shared `interpolate`, not through a local
 * `replace` chain: a second interpolation implementation is how a placeholder
 * ends up filled in one sentence and left literal in another.
 *
 * The three call sites below pass different suffixes, because the REMEDY differs
 * even though the diagnosis does not.
 */
function unknownContract(
  input: BallotInputs,
  phrases: BallotPhrases,
  suffix: string,
  locale: Locale,
): string {
  return interpolate(phrases.wrongNetwork, {
    chainId: input.subjectChainId,
    // The chain's name is interpolated INTO a translated sentence, so it has to
    // be translated too -- otherwise an English sentence carries the Chinese name
    // and the reader sees the mixed-language text this module exists to remove.
    chainName: chainName(input.subjectChainId, locale),
    suffix,
  });
}

/** Reads a status as a sentence, for the two states neither ready nor failed. */
function statusSentence(state: ReadState, failedText: string, loadingText: string): string {
  return state === "failed" ? failedText : loadingText;
}

/**
 * Everything that blocks BOTH 投票 and 改投, in the contract's own check order.
 *
 * Split out from `voteReason` because the two entry points differ in exactly one
 * condition — whether a vote already exists. The earlier version decided that by
 * comparing `voteReason`'s sentence against a literal, which worked right up
 * until the sentence was edited, at which point 改投 would have silently started
 * reporting "you have already voted" as its reason for being disabled. A shared
 * function returning a sentence cannot drift that way, and the shared part is now
 * literally shared.
 *
 * The order is the contract's: `vote` and `changeVote` both check the phase, then
 * the deadline, then admission. Reporting a different order would tell a reader
 * the wrong reason about a poll that is, say, both closed and not admitted.
 */
export function sharedBlock(
  input: BallotInputs,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  const phrases = ballotPhrasesFor(locale);

  return checkUntilAdmission(input, phrases, locale) ?? admissionBlock(input, phrases);
}

/**
 * The checks every write path makes, up to but not including admission.
 *
 * `withdrawReason` and `refundReason` deliberately do not use this: their
 * sentences differ per control, so they repeat the same ordered checks with their
 * own wording. What they must not do is reorder them, and they do not.
 */
function checkUntilAdmission(
  input: BallotInputs,
  phrases: BallotPhrases,
  locale: Locale,
): string | undefined {
  if (!input.contractKnown) {
    return unknownContract(input, phrases, phrases.contractUnknownCannotDetermine, locale);
  }

  if (!input.isConnected) {
    return phrases.connectWallet;
  }

  if (input.txBusy) {
    return phrases.busy;
  }

  if (input.phaseState !== "ready") {
    return statusSentence(input.phaseState, phrases.votePhaseReadFailed, phrases.readingContract);
  }

  if (isSetup(input)) {
    return phrases.setup;
  }

  if (isReveal(input)) {
    // Gets its own sentence rather than falling into the `votingClosed` branch.
    // The reader's next action here is to REVEAL, and `refund()` still reverts
    // until the poll reaches `Ended` — so pointing at the refund button would
    // send them at a call the contract rejects.
    return phrases.reveal;
  }

  if (votingClosed(input)) {
    // Distinguishes the two ways a poll can be closed, because the remedy
    // differs: an Ended poll already lets the stake out, a past-deadline one
    // needs `closeAfterDeadline()` first.
    return input.deadlinePassed && input.phase === PollPhase.Voting
      ? phrases.deadlinePassed
      : phrases.ended;
  }

  if (input.voterState !== "ready") {
    return statusSentence(input.voterState, phrases.voteVoterReadFailed, phrases.readingVoterState);
  }

  return undefined;
}

/**
 * The admission gate, which only `vote` has.
 *
 * `changeVote` and `withdrawVote` carry NO whitelist check in the contract — a
 * reader whose entry was revoked mid-ballot can still move or release a vote they
 * already hold, and they must not be told otherwise. `canVote` is therefore
 * applied by `voteReason`/`changeReason` only when the call actually checks it:
 * see `changeReason`, which skips this gate exactly when the reader already
 * holds a vote.
 */
function admissionBlock(input: BallotInputs, phrases: BallotPhrases): string | undefined {
  if (!input.canVote) {
    // `canVote` is `openToAll || whitelisted`, so on an open poll this branch is
    // unreachable for every address. A reader who reaches it is genuinely on a
    // whitelisted poll, and the sentence says which of the two sub-cases applies.
    return input.whitelisted ? phrases.whitelistedButRefused : phrases.notWhitelisted;
  }

  return undefined;
}

/** Why 投票 is unavailable. */
export function voteReason(
  input: BallotInputs,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  const phrases = ballotPhrasesFor(locale);
  const blocked = sharedBlock(input, locale);

  if (blocked !== undefined) {
    return blocked;
  }

  if (input.marked) {
    // Not a dead end: the same address can move its vote, which is the operation
    // the old single-tenant contract could not express at all.
    return phrases.alreadyVoted;
  }

  return undefined;
}

/**
 * Why 改投 is unavailable on this particular option.
 *
 * The admission gate is applied only when the reader does NOT already hold a
 * vote. That is not a shortcut: `changeVote` has no whitelist check at all, so
 * an address that voted and was then removed from the list can still change its
 * vote, and blocking the button would refuse a call the chain would accept. In
 * the other direction, an unmarked address reaching this function is being
 * offered a change it cannot make (`HasNotVoted`), so the admission sentence is
 * the right one to show.
 */
export function changeReason(
  input: BallotInputs,
  optionId: number,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  const phrases = ballotPhrasesFor(locale);
  const blocked =
    checkUntilAdmission(input, phrases, locale) ??
    (input.marked ? undefined : admissionBlock(input, phrases));

  if (blocked !== undefined) {
    return blocked;
  }

  if (optionId === input.myOptionId) {
    // The contract reverts with `SameOption` here, so offering the button would
    // offer a transaction guaranteed to fail — and that failure would arrive as a
    // wallet prompt the reader has no reason to expect.
    return phrases.sameOption;
  }

  return undefined;
}

/** Why 撤票 is unavailable. */
export function withdrawReason(
  input: BallotInputs,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  const phrases = ballotPhrasesFor(locale);

  if (!input.contractKnown) {
    return unknownContract(input, phrases, phrases.contractUnknownGeneric, locale);
  }

  if (!input.isConnected) {
    return phrases.connectWallet;
  }

  if (input.txBusy) {
    return phrases.busy;
  }

  if (input.phaseState !== "ready" || input.voterState !== "ready") {
    return input.phaseState === "failed" || input.voterState === "failed"
      ? phrases.withdrawStatusReadFailed
      : phrases.readingContract;
  }

  if (isReveal(input)) {
    return phrases.withdrawInReveal;
  }

  if (votingClosed(input)) {
    return phrases.withdrawEnded;
  }

  if (isSetup(input)) {
    return phrases.withdrawInSetup;
  }

  if (input.committed) {
    // On a commit-reveal poll the sealed commitment IS the held vote, so this is
    // reachable and useful: withdrawing is how a voter changes its mind before
    // the reveal, and `_withdrawCommitment` returns the stake. Reporting
    // "HasNotVoted" here — which is what the `marked` check below would do, since
    // a sealed ballot is not counted yet — would refuse an available action.
    return undefined;
  }

  if (!input.marked) {
    // The contract reverts with `HasNotVoted`. Saying which of "never voted" and
    // "already withdrawn" applies is not possible from `voterState` alone, and
    // guessing would be worse than saying the fact that is checkable.
    return phrases.hasNotVoted;
  }

  return undefined;
}

/** Why 取回押金 is unavailable. */
export function refundReason(
  input: BallotInputs,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  const phrases = ballotPhrasesFor(locale);

  if (!input.contractKnown) {
    return unknownContract(input, phrases, phrases.contractUnknownCannotRefund, locale);
  }

  if (!input.isConnected) {
    return phrases.connectWallet;
  }

  if (input.txBusy) {
    return phrases.busy;
  }

  if (!votingClosed(input)) {
    return input.phaseState !== "ready"
      ? statusSentence(input.phaseState, phrases.refundPhaseReadFailed, phrases.readingContract)
      : phrases.refundBeforeEnd;
  }

  if (input.voterState !== "ready") {
    return statusSentence(input.voterState, phrases.refundStakeReadFailed, phrases.readingStake);
  }

  if (input.myStake === undefined || input.myStake === 0n) {
    return phrases.refundNothing;
  }

  return undefined;
}

/**
 * Why `closeAfterDeadline` is unavailable.
 *
 * This call is PERMISSIONLESS, so nothing here asks who the reader is, whether a
 * wallet is connected, or whether a transaction is already in flight on their
 * behalf. Those are the checks every other reason function makes, and omitting
 * them is the point: this button exists precisely so that a poll whose creator
 * walked away can still be closed by whoever notices.
 *
 * The only conditions are the contract's own: the phase must be Voting and the
 * deadline must have passed. Without this button the stake of every voter in such
 * a poll is unreachable — `refund()` requires `Phase.Ended`, and nothing else can
 * move the poll out of `Voting`.
 */
export function closeReason(
  input: BallotInputs,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  const phrases = ballotPhrasesFor(locale);

  if (!input.contractKnown) {
    return unknownContract(input, phrases, phrases.contractUnknownGeneric, locale);
  }

  if (input.phaseState !== "ready") {
    return statusSentence(input.phaseState, phrases.closeReadFailed, phrases.readingContract);
  }

  if (input.phase === PollPhase.Ended) {
    return phrases.closeEnded;
  }

  if (isSetup(input)) {
    return phrases.closeInSetup;
  }

  if (!input.deadlinePassed) {
    return phrases.closeBeforeDeadline;
  }

  return undefined;
}
