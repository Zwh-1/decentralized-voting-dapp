// SPDX-License-Identifier: MIT
/**
 * Whether a poll's rules still match the promise made when it was created.
 *
 * ---------------------------------------------------------------------------
 * What question this answers
 * ---------------------------------------------------------------------------
 *
 * A reader looking at a poll is being asked to trust several things they cannot
 * see: that the question is the one it was created with, that the options are the
 * ones it was created with, that whoever may vote is who was always meant to, and
 * that the deadline has not moved. Several of those are immutable on chain, but
 * the OPTIONS and the WHITELIST can legitimately be edited by the creator while
 * the poll is in `Phase.Setup` — so "the rules you are reading are the rules this
 * poll started with" is not something the contract enforces.
 *
 * What the contract does provide is a fingerprint of the rules as created
 * (`rulesHash`, written once in `initialize`) and a recomputation of that
 * fingerprint from live state (`currentRulesHash()`). Comparing them answers the
 * question exactly.
 *
 * ---------------------------------------------------------------------------
 * The three states, and why "unknown" is one of them
 * ---------------------------------------------------------------------------
 *
 * `unchanged` and `changed` are the answers. `unknown` is not a failure to be
 * hidden — it is the honest state when the recomputation could not be performed,
 * and it must never be rendered as `unchanged`. Claiming a poll's rules are
 * intact because a read failed is precisely the false assurance this whole
 * feature exists to remove.
 *
 * A `changed` result is NOT an accusation. Editing options and the whitelist
 * before opening is the intended workflow, and a poll that was reshaped during
 * Setup is completely legitimate. What the reader is owed is the ability to TELL,
 * not a verdict — so the wording states the fact and explains what it means,
 * rather than implying wrongdoing.
 */

import { PollPhase } from "./contracts";
import { DEFAULT_LOCALE, translatorFor, type Locale } from "./i18n";

/** How a poll's current rules compare to its creation-time commitment. */
export type RulesVerdict = "unchanged" | "changed" | "unknown";

export interface RulesCheck {
  verdict: RulesVerdict;
  /** The commitment written at creation, or null when unread. */
  committed: string | null;
  /** The fingerprint recomputed from live state, or null when unread. */
  current: string | null;
}

/**
 * Compare the two fingerprints.
 *
 * Comparison is case-insensitive because the two values arrive through different
 * paths — one from a contract read, one from a hash — and a difference in hex
 * casing is not a difference in rules. Treating `0xAB` and `0xab` as a mismatch
 * would make every poll report `changed` on some providers and `unchanged` on
 * others, which is worse than not checking at all.
 *
 * A `null` on either side yields `unknown`, never `unchanged`.
 */
export function rulesCheck(input: {
  committed: string | null | undefined;
  current: string | null | undefined;
}): RulesCheck {
  const committed = normalise(input.committed);
  const current = normalise(input.current);

  if (committed === null || current === null) {
    return { verdict: "unknown", committed, current };
  }

  return { verdict: committed === current ? "unchanged" : "changed", committed, current };
}

/** A hex value as a comparable form, or null when it is not present. */
function normalise(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  // A zero hash means the poll was never initialized through `initialize`, or the
  // read returned an empty value. Either way it is not a fingerprint to compare
  // against — and `0x000…0 === 0x000…0` would otherwise report a confident
  // "unchanged" for a poll whose commitment does not exist.
  if (trimmed === "" || /^0x0*$/.test(trimmed)) {
    return null;
  }

  return trimmed.toLowerCase();
}

/**
 * What the reader is told, given a verdict.
 *
 * Kept here rather than in the component for the same reason as the rest of this
 * module: the wording is the feature. A `changed` verdict rendered as a warning
 * about foul play would be wrong — the edit may be entirely legitimate — and an
 * `unknown` rendered as reassurance would be the exact false assurance the check
 * exists to prevent. Both are text, and text is testable.
 *
 * ---------------------------------------------------------------------------
 * Why the sentences take a language
 * ---------------------------------------------------------------------------
 *
 * They are RESULTS of a pure function, not JSX: `TrustPanel` receives the
 * finished `{title, detail}` and renders it, so by the time a component holds
 * the string the language decision has already been made and no translator can
 * reach it. Until this parameter existed, an English page showed 规则与创建时一致
 * and a full paragraph of Chinese directly beneath it inside an otherwise
 * English panel.
 *
 * The trailing `locale` defaults to `DEFAULT_LOCALE`, which is the same
 * additive shape `voting.ts` uses for `chainName` and `phaseLabel`: every
 * existing call site and assertion keeps producing byte-identical Chinese, and
 * the English path runs only where a reader asked for it.
 *
 * `title` and `detail` move together on purpose — a translated title above an
 * untranslated paragraph is worse than either alone, because it reads as a
 * broken page rather than as a missing translation. `trust.test.ts` pins the
 * properties of each verdict's detail (it must not accuse, must not reassure,
 * and must name how to check) in BOTH languages.
 */
export function rulesSummary(
  check: RulesCheck,
  locale: Locale = DEFAULT_LOCALE,
): {
  title: string;
  detail: string;
  tone: "ok" | "warn" | "neutral";
} {
  const t = translatorFor(locale);

  switch (check.verdict) {
    case "unchanged":
      return {
        title: t.t("trust.rulesUnchangedTitle"),
        detail: t.t("trust.rulesUnchangedDetail"),
        tone: "ok",
      };

    case "changed":
      return {
        title: t.t("trust.rulesChangedTitle"),
        detail: t.t("trust.rulesChangedDetail"),
        tone: "warn",
      };

    case "unknown":
      return {
        title: t.t("trust.rulesUnknownTitle"),
        detail: t.t("trust.rulesUnknownDetail"),
        tone: "neutral",
      };
  }
}

/**
 * The time a voter has left before the creator may take their stake.
 *
 * `refund()` opens when the poll reaches `Phase.Ended`; `sweepUnclaimed()` opens
 * `REFUND_GRACE_PERIOD` later. Between those two moments a voter can still get
 * their stake back, and after the second they cannot — which is the single most
 * consequential deadline in this project and was, before this, nowhere on screen.
 *
 * `null` when the poll is not yet in `Ended`: the grace period is measured from
 * the moment of closing, so it has not started and cannot be counted down.
 */
export function sweepDeadline(input: {
  phase: number | undefined;
  votingEndedAt: bigint | null | undefined;
  gracePeriodSeconds: bigint;
}): { at: bigint; remaining: bigint } | null {
  // `PollPhase.Ended` rather than the literal this used to hold. The literal was
  // 2, and inserting `Reveal` into the contract's enum made 2 mean `Reveal` — so
  // this function would have reported a sweep deadline for a poll whose grace
  // period had not started, telling voters their stake was about to be swept
  // while `refund()` was in fact still open. `PollPhase` is generated from the
  // contract's source, so it cannot lag the enum.
  if (input.phase !== PollPhase.Ended) {
    return null;
  }

  const closedAt = input.votingEndedAt;

  // A poll in `Ended` always has a close time on chain, so this is defensive
  // rather than expected — but returning a deadline computed from 0 would show
  // every voter that the grace period expired in 1970.
  if (closedAt === null || closedAt === undefined || closedAt === 0n) {
    return null;
  }

  return { at: closedAt + input.gracePeriodSeconds, remaining: input.gracePeriodSeconds };
}
