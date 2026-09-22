// SPDX-License-Identifier: MIT
/**
 * How a poll's state becomes the thing a reader sees.
 *
 * The failures worth catching here are not aesthetic. Every one of these
 * assertions is about a case where the interface would tell a reader something
 * the chain disagrees with — a closed poll that still looks votable, a "not
 * started" poll whose badge is indistinguishable from a live one, a percentage
 * computed from a zero denominator.
 *
 * `PollPhase` values are inlined rather than imported, as in
 * `ballot-reasons.test.ts`: if the enum's numbering ever changes, these cases
 * must fail loudly instead of being silently re-pointed at a different phase.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { accentClass, badgeClass, phaseTone, sharePercent } from "../src/lib/presentation";

const SETUP = 0;
const VOTING = 1;
// Inlined rather than imported so an enum renumbering fails here. It did: when
// `Reveal` was inserted, ENDED moved from 2 to 3 and these cases failed until
// updated — the guard working as intended.
const REVEAL = 2;
const ENDED = 3;

describe("phaseTone", () => {
  it("calls a live poll votable", () => {
    const tone = phaseTone(VOTING, false);

    assert.equal(tone.votable, true);
    assert.equal(tone.tone, "live");
  });

  it("does not call a poll votable before it starts", () => {
    // `Phase.Setup` exists because a creator needs to add options and a
    // whitelist before anyone votes. A badge that offered voting here would send
    // readers at a contract that reverts with InvalidPhase.
    const tone = phaseTone(SETUP, false);

    assert.equal(tone.votable, false);
    assert.equal(tone.tone, "waiting");
  });

  it("distinguishes a past-deadline poll from an ended one", () => {
    // The single most misleading pair in this project. Both refuse votes, but
    // only `Ended` allows `refund()`. If the past-deadline case were rendered
    // like the ended case, readers would hunt for a refund button that the
    // contract rejects, and the actual remedy — anyone may call the
    // permissionless `closeAfterDeadline()` — would stay invisible.
    const pastDue = phaseTone(VOTING, true);
    const ended = phaseTone(ENDED, true);

    assert.equal(pastDue.votable, false);
    assert.equal(ended.votable, false);
    assert.notEqual(pastDue.tone, ended.tone);
    assert.notEqual(pastDue.label, ended.label);
    assert.equal(pastDue.label, "已过截止");
    assert.equal(ended.label, "已结束");
  });

  it("gives a commit-reveal poll's reveal window its own state", () => {
    // The same trap as the pair above, in a new place. During `Reveal` the poll
    // refuses votes and `refund()` still reverts — so it must not read as
    // "已结束" (which would send readers at a rejected refund) and must not read
    // as "投票中" either (which would tell someone who never committed that they
    // still can).
    const reveal = phaseTone(REVEAL, true);

    assert.equal(reveal.votable, false, "votes are refused during the reveal window");
    assert.notEqual(reveal.label, "已结束", "refund() reverts here, so this is not Ended");
    assert.notEqual(reveal.label, "投票中", "and no new commitment is accepted either");
    assert.equal(reveal.label, "揭示中");
    assert.notEqual(reveal.tone, "closed", "the poll is mid-flight, not finished");
  });

  it("never reports a gone deadline as votable", () => {
    for (const phase of [SETUP, VOTING, ENDED]) {
      assert.equal(
        phaseTone(phase, true).votable,
        false,
        `phase ${phase} with a passed deadline must not be votable`,
      );
    }
  });

  it("treats an undefined phase as unknown rather than as setup", () => {
    // The read has not landed. Defaulting to a real phase would make a loading
    // page assert something it does not know.
    const tone = phaseTone(undefined, false);

    assert.equal(tone.votable, false);
    assert.equal(tone.tone, "neutral");
    assert.equal(tone.label, "读取中");
  });

  it("does not offer a vote for a phase this build does not recognise", () => {
    // A newer contract could add a phase. Reporting an unknown number as
    // `Setup` would be a lie; reporting it as votable would be a worse one.
    const tone = phaseTone(99, false);

    assert.equal(tone.votable, false);
    assert.match(tone.label, /99/);
  });

  it("gives every phase a tone that maps to real classes", () => {
    // A tone with no classes would render as an unstyled element that still
    // claims a state — the badge equivalent of a disabled button with no reason.
    for (const phase of [undefined, SETUP, VOTING, ENDED, 99]) {
      for (const passed of [false, true]) {
        const { tone } = phaseTone(phase, passed);

        assert.notEqual(badgeClass(tone), "", `badge classes for ${tone}`);
        assert.notEqual(accentClass(tone), "", `accent classes for ${tone}`);
        assert.match(badgeClass(tone), /^(bg|text|ring)/);
      }
    }
  });

  it("gives live and closed different colours", () => {
    // The one visual property the whole redesign rests on: a reader must be able
    // to tell a poll they can act on from one they cannot without reading text.
    assert.notEqual(badgeClass("live"), badgeClass("closed"));
    assert.notEqual(accentClass("live"), accentClass("closed"));
  });
});

describe("sharePercent", () => {
  it("computes an ordinary share", () => {
    assert.equal(sharePercent(67, 200), 33.5);
  });

  it("returns zero rather than NaN when nothing has been counted", () => {
    // Every poll starts here. `NaN` in a width collapses the bar, which looks
    // exactly like "zero votes" and hides that the poll simply has no votes yet.
    assert.equal(sharePercent(0, 0), 0);
    assert.equal(Number.isNaN(sharePercent(0, 0)), false);
  });

  it("keeps one decimal so close options stay distinguishable", () => {
    // With whole percents, a small electorate shows two genuinely different
    // options as the same number — precisely when a reader is checking the maths.
    assert.equal(sharePercent(1, 3), 33.3);
    assert.equal(sharePercent(2, 3), 66.7);
    assert.notEqual(sharePercent(1, 3), sharePercent(2, 3));
  });

  it("clamps a count that exceeds its total", () => {
    // Reachable from a torn read: the tally and the total can arrive from two
    // different calls. A bar wider than its track is a visible bug, and this is
    // the cheap place to stop it.
    assert.equal(sharePercent(150, 100), 100);
  });

  it("returns zero for a negative or non-finite input", () => {
    assert.equal(sharePercent(-5, 100), 0);
    assert.equal(sharePercent(Number.NaN, 100), 0);
    assert.equal(sharePercent(5, Number.NaN), 0);
    assert.equal(sharePercent(5, -1), 0);
  });

  it("reports a unanimous poll as one hundred", () => {
    assert.equal(sharePercent(7, 7), 100);
  });
});
