// SPDX-License-Identifier: MIT
/**
 * How a poll's verdict and its queued action are described.
 *
 * ---------------------------------------------------------------------------
 * Why the outcome is not a boolean here either
 * ---------------------------------------------------------------------------
 *
 * The contract reports four values rather than "passed / not passed", and the
 * reason survives the trip to the interface: `Rejected` and `QuorumNotMet` call
 * for opposite responses. A poll that lost on the count can only be re-run with
 * a different question; a poll that missed its quorum might pass unchanged with
 * a better reminder. Collapsing them into "not passed" here would throw away the
 * distinction at exactly the layer where a human has to act on it.
 *
 * So the labels below say what to DO, not just what happened, and a test asserts
 * that the two failure labels are different strings. A helper that returned
 * "Did not pass" for both would satisfy every type and lose the point.
 *
 * ---------------------------------------------------------------------------
 * Why this is not in the component
 * ---------------------------------------------------------------------------
 *
 * Same reason as `presentation.ts`: `web/test/**` cannot import React or wagmi,
 * and the failures worth catching are not visual. The one that matters most is
 * the timelock clock — a queue that is ready `readyAt` seconds from now, or was
 * ready an hour ago, are the same two numbers in a different order, and getting
 * it backwards means showing "Executable now" on an action that cannot run.
 */

import { PollOutcome } from "./contracts/voting-abi";

/** What a poll decided, in words a reader can act on. */
export interface OutcomePresentation {
  label: string;
  detail: string;
  tone: "pass" | "fail" | "waiting";
}

/**
 * Describes an outcome.
 *
 * The `Pending` case is the one worth reading twice: it covers `Reveal` as well
 * as the live phases, and during a reveal window the tally is still rising. A
 * label that said "counting" there would be accurate; one that said anything
 * final would tell voters to give up while their ballot can still be opened.
 *
 * An unrecognised value falls back to `Pending` rather than guessing. The enum
 * mirror is generated from the contract, so an unknown value means the app is
 * older than the chain it is reading — in which case "not decided yet" is the
 * only honest answer, and inventing a fourth label would hide the version skew.
 */
export function outcomePresentation(outcome: number): OutcomePresentation {
  switch (outcome) {
    case PollOutcome.Passed:
      return {
        label: "Passed",
        detail: "The vote met its quorum and the count. It can now be queued for execution.",
        tone: "pass",
      };
    case PollOutcome.Rejected:
      return {
        label: "Rejected",
        detail:
          "Enough power took part, but no option won. Re-running this question unchanged would produce the same result.",
        tone: "fail",
      };
    case PollOutcome.QuorumNotMet:
      return {
        label: "Quorum not met",
        detail:
          "Too little eligible power took part for the count to decide anything. More voters, not a different question, is what this needs.",
        tone: "fail",
      };
    case PollOutcome.Pending:
    default:
      return {
        label: "Not decided yet",
        detail:
          "The poll is still running, or its reveal window is open and ballots can still be counted.",
        tone: "waiting",
      };
  }
}

/** How far a queued action has got. */
export type ExecutionStage =
  /** Nothing is queued: either the poll has not passed, or it was cancelled. */
  | "none"
  /** Queued and waiting out the timelock. */
  | "waiting"
  /** Runnable right now. */
  | "ready"
  /** An attempt reverted. Still queued, and can be tried again. */
  | "failed"
  /** It ran. */
  | "done";

/** One place that decides which stage a queue entry is in. */
export function executionStage(input: {
  target: string;
  done: boolean;
  lastError: string;
  readyAt: bigint;
  now: number;
}): ExecutionStage {
  if (input.target === ZERO_ADDRESS) return "none";
  if (input.done) return "done";
  if (input.lastError !== "0x" && input.lastError !== "") return "failed";

  // `>=` rather than `>`: the contract allows execution AT `readyAt`, and an
  // off-by-one here would show "waiting" on an action the chain would accept.
  return BigInt(Math.floor(input.now)) >= input.readyAt ? "ready" : "waiting";
}

/** Seconds until a queued action can run, floored at zero. */
export function secondsUntilReady(readyAt: bigint, now: number): number {
  const remaining = readyAt - BigInt(Math.floor(now));

  return remaining > 0n ? Number(remaining) : 0;
}

/** Whether the queue panel is worth showing at all. */
export function shouldShowExecution(input: { outcome: number; target: string }): boolean {
  // Only for a poll that passed. Showing an empty queue on every poll would be
  // noise, and showing one on a poll that did not pass would suggest that
  // execution is still available for it.
  return input.outcome === PollOutcome.Passed || input.target !== ZERO_ADDRESS;
}

/**
 * A human-readable rendering of a revert payload.
 *
 * Revert data comes back as hex, and the two shapes that matter are
 * `Error(string)` — what `require` and a plain `revert("...")` produce — and a
 * bare 4-byte selector with no message. Showing raw hex to a reader is the same
 * as showing nothing, so the first is decoded and the second is named for what
 * it is.
 *
 * A message that cannot be decoded is returned as-is rather than replaced with
 * "unknown error": the hex is at least evidence, and discarding it would leave
 * a reader with no way to look it up.
 */
export function describeRevertData(data: string): string {
  if (data === "" || data === "0x") return "";

  // The offsets below count from the START of the string, so the `0x` prefix is
  // part of the arithmetic. Getting this off by two produces a message whose
  // first byte is the length field rather than the text — which is exactly how
  // the first version of this function failed, and why the test asserts the
  // decoded string rather than merely that something was returned.
  const ERROR_STRING_SELECTOR = "0x08c379a0";
  const PREFIX = 2; // "0x"
  const SELECTOR = 8;
  const WORD = 64;

  if (data.startsWith(ERROR_STRING_SELECTOR) && data.length >= PREFIX + SELECTOR + WORD * 2) {
    const lengthStart = PREFIX + SELECTOR + WORD;
    const byteLength = Number.parseInt(data.slice(lengthStart, lengthStart + WORD), 16);

    if (Number.isFinite(byteLength) && byteLength > 0) {
      const payloadStart = lengthStart + WORD;
      const payload = data.slice(payloadStart, payloadStart + byteLength * 2);

      const pairs = payload.match(/.{1,2}/g) ?? [];
      const bytes = new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));

      return new TextDecoder().decode(bytes);
    }
  }

  if (data.length === 10) {
    return `The target rejected the call with error ${data}.`;
  }

  return data;
}

/**
 * The zero address, written once.
 *
 * `0x${"0".repeat(40)}` is spelled as a literal here because a computed string
 * cannot be used where viem expects a template-literal address type without a
 * cast, and a cast at every comparison site is what the constant exists to
 * avoid.
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** `10000` basis points, named so the arithmetic below reads as intended. */
const MAX_BPS = 10_000n;

/** Formats basis points as a percentage with at most two decimals. */
export function formatBps(bps: bigint): string {
  const whole = bps / 100n;
  const fraction = bps % 100n;

  if (fraction === 0n) return `${whole}%`;

  // Pad so 505 -> "5.05%" rather than "5.5%".
  const padded = fraction.toString().padStart(2, "0").replace(/0$/, "");

  return `${whole}.${padded}%`;
}

/**
 * Whether the turnout figure clears the quorum.
 *
 * Computed from the SAME basis points the contract returns, by the same
 * comparison — a cross-multiplication, not a division. Dividing first is the
 * error the contract's own comment warns about, and reproducing it here would
 * mean the interface and the chain disagree at the boundary: the panel would
 * show a turnout below the threshold on a poll the chain reports as having
 * cleared it.
 */
export function turnoutClearsQuorum(turnoutBps: bigint, quorumBps: bigint): boolean {
  if (quorumBps === 0n) return true;

  // Both sides are already in basis points, so the comparison is direct. The
  // `MAX_BPS` factor is absent because neither quantity is a raw tally.
  return turnoutBps >= quorumBps;
}

/** The quorum requirement in words, including the "none" case. */
export function quorumLabel(quorumBps: bigint): string {
  return quorumBps === 0n ? "No quorum required" : `${formatBps(quorumBps)} of eligible power`;
}

/** Exported for tests that assert the arithmetic above against the contract. */
export { MAX_BPS };
