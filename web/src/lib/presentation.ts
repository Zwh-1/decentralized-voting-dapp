// SPDX-License-Identifier: MIT
/**
 * The one place that decides how a poll's state looks.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module instead of Tailwind classes in the components
 * ---------------------------------------------------------------------------
 *
 * Before this file, every component picked its own colours: the card wrote
 * `bg-emerald-50 text-emerald-700` for an open poll, the ballot wrote
 * `text-rose-600` for a refusal, the consistency badge wrote a third set. Three
 * components therefore held three independent opinions about what "open" looks
 * like, and they could disagree — which is exactly the kind of drift that makes
 * an interface feel arbitrary rather than designed. A reader scanning a list
 * cannot learn "green means open" if green appears on a card, amber on another
 * and grey on a third.
 *
 * The token is the single owner of that decision.
 *
 * ---------------------------------------------------------------------------
 * Why it is a pure function returning strings
 * ---------------------------------------------------------------------------
 *
 * `web/test/**` runs on `node --test --import tsx` and cannot import anything
 * that pulls in React or wagmi (`ERR_MODULE_NOT_FOUND`). A "theme" that lived in
 * a component or a hook would therefore be untestable, and the specific failure
 * worth catching is not visual — it is that a state gets mapped to the WRONG
 * tone, so a closed poll renders in the same green as a live one and a reader
 * believes they can still vote. That is a correctness bug wearing a colour, and
 * it is testable here.
 *
 * The classes are returned as complete literals rather than assembled from
 * fragments (`"bg-" + tone + "-50"`) on purpose: Tailwind scans source text for
 * class names, so a class it cannot see literally is a class it does not emit,
 * and the element renders unstyled in production while looking fine in dev.
 */

import { phaseLabel, PollPhase } from "./voting";

/**
 * How urgent a state is, not what colour it is.
 *
 * Named by meaning so a caller never has to decide whether "not started" is
 * closer to "warning" or "neutral" — that mapping is the whole content of this
 * module and belongs in one place.
 */
export type Tone = "live" | "waiting" | "closed" | "danger" | "info" | "neutral";

/** The badge that names the phase, plus the bookkeeping the UI needs. */
export interface PhaseTone {
  /** The Chinese label, from `phaseLabel`'s vocabulary. */
  label: string;
  tone: Tone;
  /**
   * True only when a reader can actually cast a vote right now.
   *
   * Deliberately separate from `tone`: a poll whose deadline has passed is
   * `closed` in tone but is still `Phase.Voting` on chain, and the two facts are
   * shown in different places for different reasons. Collapsing them would make
   * the badge claim a phase the contract has not entered.
   */
  votable: boolean;
}

/**
 * The phase a poll is in, as the reader should see it.
 *
 * `deadlinePassed` is passed in rather than read from a clock inside the
 * function, so the result is a function of its arguments and the test can pin
 * both sides of the boundary without mocking time.
 *
 * The four cases are genuinely distinct and the interface was previously showing
 * three of them with the same grey badge:
 *
 *   * `Setup`            — created but never started; nobody can vote yet.
 *   * `Voting`, in time  — the only state where a vote will be accepted.
 *   * `Voting`, past due — the contract refuses votes, but it has NOT entered
 *                          `Ended`, so stakes cannot be refunded until someone
 *                          calls the permissionless `closeAfterDeadline()`.
 *   * `Ended`            — closed; refunds are available.
 *
 * The third is the one that matters most: it looks open, votes are refused, and
 * the remedy is not obvious. It gets its own tone rather than being folded into
 * "closed", because telling a reader "this ended" when the contract still says
 * `Voting` would send them looking for a refund button that `refund()` rejects.
 *
 * The label for a plain `Voting` poll comes from `phaseLabel` rather than being
 * written again here. Two independent spellings of the same state is how the
 * list page and the detail page end up disagreeing about what to call it.
 */
export function phaseTone(phase: number | undefined, deadlinePassed: boolean): PhaseTone {
  if (phase === undefined) {
    return { label: "读取中", tone: "neutral", votable: false };
  }

  if (phase === PollPhase.Setup) {
    return { label: "未开始", tone: "waiting", votable: false };
  }

  if (phase === PollPhase.Ended) {
    return { label: "已结束", tone: "closed", votable: false };
  }

  if (phase === PollPhase.Voting) {
    return deadlinePassed
      ? { label: "已过截止", tone: "danger", votable: false }
      : { label: phaseLabel(phase), tone: "live", votable: true };
  }

  // An unknown phase is a read that returned something this build does not know
  // about — a newer contract, most likely. It is NOT reported as votable: an
  // interface that offers a vote it cannot justify is worse than one that says
  // it does not understand.
  return { label: phaseLabel(phase), tone: "neutral", votable: false };
}

/** The classes for a badge in the given tone. */
export function badgeClass(tone: Tone): string {
  switch (tone) {
    case "live":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
    case "waiting":
      return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
    case "closed":
      return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
    case "danger":
      return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
    case "info":
      return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
    case "neutral":
      return "bg-slate-100 text-slate-500 ring-1 ring-slate-200";
  }
}

/**
 * The left edge of a card, so a list can be scanned by state without reading.
 *
 * A colour bar rather than a coloured card: filling the whole surface would make
 * four different states compete with the question text, and the question is what
 * the reader is actually scanning for.
 */
export function accentClass(tone: Tone): string {
  switch (tone) {
    case "live":
      return "border-l-4 border-l-emerald-400";
    case "waiting":
      return "border-l-4 border-l-sky-400";
    case "closed":
      return "border-l-4 border-l-slate-200";
    case "danger":
      return "border-l-4 border-l-amber-400";
    case "info":
      return "border-l-4 border-l-indigo-400";
    case "neutral":
      return "border-l-4 border-l-slate-200";
  }
}

/**
 * A share of the vote as a percentage, for a bar width.
 *
 * Returns `0` when the denominator is zero rather than `NaN`. A poll with no
 * votes is the normal first state of every poll, and `NaN` in a `width` style
 * silently collapses the bar — which looks identical to "this option has no
 * votes", hiding the real situation that nothing has been counted yet.
 *
 * Rounded to one decimal because the bars are compared side by side: whole
 * percents make two genuinely different options look identical whenever the
 * electorate is small, which is precisely when a reader is most likely to be
 * checking the arithmetic.
 */
export function sharePercent(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }

  const share = (count / total) * 100;

  // Clamped: a caller that passes a stale `total` smaller than `count` would
  // otherwise produce a bar wider than its track.
  return Math.min(100, Math.max(0, Math.round(share * 10) / 10));
}
