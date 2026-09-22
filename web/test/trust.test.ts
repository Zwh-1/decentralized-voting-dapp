// SPDX-License-Identifier: MIT
/**
 * The rules-verification and stake-risk logic.
 *
 * The failures worth pinning here are all in one direction: a check that reports
 * REASSURANCE it has not earned. A missing read rendered as "unchanged", a hex
 * casing difference rendered as "tampered with", a grace period counted down from
 * a timestamp that does not exist. Each of those is a false statement about
 * someone's money or someone's honesty.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rulesCheck, rulesSummary, sweepDeadline } from "../src/lib/trust";
// Named members rather than literals — see the note in ballot-labels.test.ts.
import { PollPhase } from "../src/lib/contracts";

const A = `0x${"ab".repeat(32)}`;
const B = `0x${"cd".repeat(32)}`;
const ZERO = `0x${"00".repeat(32)}`;

describe("rulesCheck", () => {
  it("reports a match as unchanged", () => {
    assert.equal(rulesCheck({ committed: A, current: A }).verdict, "unchanged");
  });

  it("reports a mismatch as changed", () => {
    assert.equal(rulesCheck({ committed: A, current: B }).verdict, "changed");
  });

  it("ignores hex casing", () => {
    // The two values arrive by different routes. Treating casing as a difference
    // would make the same poll report "changed" on one provider and "unchanged"
    // on another — worse than not checking, because it is confidently wrong.
    const upper = A.toUpperCase().replace("0X", "0x");

    assert.equal(rulesCheck({ committed: A, current: upper }).verdict, "unchanged");
  });

  it("never reports unchanged when a read failed", () => {
    // The central failure this module exists to prevent: claiming a poll's rules
    // are intact because one of the two values could not be read.
    assert.equal(rulesCheck({ committed: A, current: null }).verdict, "unknown");
    assert.equal(rulesCheck({ committed: null, current: A }).verdict, "unknown");
    assert.equal(rulesCheck({ committed: null, current: null }).verdict, "unknown");
    assert.equal(rulesCheck({ committed: undefined, current: undefined }).verdict, "unknown");
  });

  it("treats a zero hash as absent rather than as a match", () => {
    // A poll that was never initialized returns the zero hash for both. Without
    // this, `0x0 === 0x0` reports a confident "unchanged" for a commitment that
    // does not exist.
    assert.equal(rulesCheck({ committed: ZERO, current: ZERO }).verdict, "unknown");
  });

  it("treats an empty string as absent", () => {
    assert.equal(rulesCheck({ committed: "", current: "" }).verdict, "unknown");
    assert.equal(rulesCheck({ committed: "   ", current: A }).verdict, "unknown");
  });

  it("passes the compared values through for display", () => {
    const check = rulesCheck({ committed: A, current: B });

    assert.equal(check.committed, A);
    assert.equal(check.current, B);
  });
});

describe("rulesSummary", () => {
  it("gives every verdict a distinct title and tone", () => {
    const titles = new Set<string>();
    const tones = new Set<string>();

    for (const verdict of ["unchanged", "changed", "unknown"] as const) {
      const summary = rulesSummary({ verdict, committed: A, current: A });

      titles.add(summary.title);
      tones.add(summary.tone);
      assert.notEqual(summary.detail.length, 0, `${verdict} needs an explanation`);
    }

    assert.equal(titles.size, 3);
    assert.equal(tones.size, 3);
  });

  it("does not describe a change as wrongdoing", () => {
    // Editing options and the whitelist during Setup is the intended workflow. A
    // warning that implies cheating would be a false accusation against a creator
    // who did nothing wrong.
    const summary = rulesSummary({ verdict: "changed", committed: A, current: B });

    for (const word of ["篡改", "恶意", "作弊", "欺诈"]) {
      assert.equal(
        summary.detail.includes(word),
        false,
        `a legitimate edit must not be described as ${word}`,
      );
    }
    assert.match(summary.detail, /不一定有问题/);
  });

  it("does not describe an unknown verdict as safe", () => {
    // The other direction, and the more dangerous one: an unperformed check
    // rendered as reassurance.
    const summary = rulesSummary({ verdict: "unknown", committed: null, current: null });

    assert.match(summary.detail, /不代表规则没问题/);
    assert.equal(summary.tone, "neutral");
  });

  it("tells the reader how to check independently", () => {
    // The whole point is that the reader need not trust this page. Every verdict
    // either states the recomputation or names the two functions to call.
    for (const verdict of ["unchanged", "unknown"] as const) {
      const summary = rulesSummary({ verdict, committed: A, current: A });

      assert.match(summary.detail, /重算|区块浏览器|rulesHash/, `${verdict} must be checkable`);
    }
  });
});

describe("sweepDeadline", () => {
  const GRACE = 7n * 24n * 60n * 60n;

  it("returns null while the poll is still open", () => {
    // The grace period is measured from closing, so before then it has not
    // started and there is nothing to count down.
    assert.equal(
      sweepDeadline({ phase: PollPhase.Voting, votingEndedAt: null, gracePeriodSeconds: GRACE }),
      null,
    );
    assert.equal(
      sweepDeadline({ phase: PollPhase.Setup, votingEndedAt: null, gracePeriodSeconds: GRACE }),
      null,
    );
    assert.equal(
      sweepDeadline({ phase: undefined, votingEndedAt: null, gracePeriodSeconds: GRACE }),
      null,
    );
  });

  it("returns the deadline once the poll has ended", () => {
    const closedAt = 1_700_000_000n;
    const deadline = sweepDeadline({
      phase: PollPhase.Ended,
      votingEndedAt: closedAt,
      gracePeriodSeconds: GRACE,
    });

    assert.notEqual(deadline, null);
    assert.equal(deadline?.at, closedAt + GRACE);
  });

  it("returns null rather than a 1970 deadline when the close time is missing", () => {
    // A poll in `Ended` always has a close time, so this is defensive — but a
    // deadline computed from 0 would tell every voter the grace period expired
    // decades ago, which reads as "your stake is already gone".
    for (const missing of [null, undefined, 0n]) {
      assert.equal(
        sweepDeadline({
          phase: PollPhase.Ended,
          votingEndedAt: missing,
          gracePeriodSeconds: GRACE,
        }),
        null,
        `votingEndedAt=${String(missing)} must not produce a deadline`,
      );
    }
  });
});
