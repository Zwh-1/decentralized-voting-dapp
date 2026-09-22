// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PollOutcome, PollPhase } from "../src/lib/contracts/voting-abi";
import {
  describeRevertData,
  executionStage,
  formatBps,
  outcomePresentation,
  quorumLabel,
  secondsUntilReady,
  shouldShowExecution,
  turnoutClearsQuorum,
  ZERO_ADDRESS,
} from "../src/lib/governance";

const TARGET = "0x1111111111111111111111111111111111111111" as const;

describe("outcomePresentation", () => {
  it("reports a passed poll as passed", () => {
    const presented = outcomePresentation(PollOutcome.Passed);

    assert.equal(presented.label, "Passed");
    assert.equal(presented.tone, "pass");
  });

  it("keeps the two ways of failing distinguishable", () => {
    // The point of the whole four-value enum. A helper that returned one
    // "Did not pass" for both would satisfy every type in this file and lose
    // the only information a reader can act on: whether to change the question
    // or to get more people to vote.
    const rejected = outcomePresentation(PollOutcome.Rejected);
    const quorum = outcomePresentation(PollOutcome.QuorumNotMet);

    assert.notEqual(rejected.label, quorum.label);
    assert.notEqual(rejected.detail, quorum.detail);

    // And the advice has to point in opposite directions, or the distinction is
    // cosmetic. "question" appears in the rejection text, "voters" in the
    // quorum text — asserted rather than trusted to a reader's eye.
    assert.match(rejected.detail, /question/i);
    assert.match(quorum.detail, /voters/i);
  });

  it("does not call a poll decided while its reveal window is open", () => {
    // `Pending` covers the reveal phase, where ballots can still be counted.
    // A label that read as final there would tell voters to give up while their
    // ballot is still openable.
    const presented = outcomePresentation(PollOutcome.Pending);

    assert.equal(presented.tone, "waiting");
    assert.match(presented.detail, /reveal/i);
  });

  it("treats an unknown outcome as undecided rather than guessing", () => {
    // An unrecognised value means the app is older than the chain. "Not decided
    // yet" is the only honest answer; inventing a label would hide the skew.
    const presented = outcomePresentation(999);

    assert.equal(presented.tone, "waiting");
  });
});

describe("the generated enum mirrors", () => {
  it("numbers the phases in the order the contract declares them", () => {
    // Regression guard for the defect that motivated generating these at all:
    // `PollPhase` was hand-written, a member was inserted mid-enum, and the
    // mirror silently kept the old numbering. Asserted by NAME rather than by
    // number so that inserting a member fails here loudly.
    assert.equal(PollPhase.Setup, 0);
    assert.equal(PollPhase.Voting, 1);
    assert.equal(PollPhase.Reveal, 2);
    assert.equal(PollPhase.Ended, 3);
  });

  it("numbers the outcomes in the order the contract declares them", () => {
    assert.equal(PollOutcome.Pending, 0);
    assert.equal(PollOutcome.Passed, 1);
    assert.equal(PollOutcome.Rejected, 2);
    assert.equal(PollOutcome.QuorumNotMet, 3);
  });
});

describe("executionStage", () => {
  const base = {
    target: TARGET,
    done: false,
    lastError: "",
    readyAt: 1_000n,
    now: 900,
  };

  it("reports nothing queued for the zero address", () => {
    assert.equal(executionStage({ ...base, target: ZERO_ADDRESS }), "none");
  });

  it("reports waiting before the timelock elapses", () => {
    assert.equal(executionStage(base), "waiting");
  });

  it("reports ready exactly at the boundary", () => {
    // The contract allows execution AT `readyAt`. A `>` here would show
    // "waiting" on an action the chain would accept, so the interface would
    // disagree with the chain at precisely one second.
    assert.equal(executionStage({ ...base, now: 1_000 }), "ready");
  });

  it("reports ready after the timelock elapses", () => {
    assert.equal(executionStage({ ...base, now: 5_000 }), "ready");
  });

  it("reports a failure rather than ready", () => {
    // A failed attempt leaves the action queued and past its `readyAt`. Reading
    // only the clock would call it "ready" and hide that the last try failed.
    assert.equal(executionStage({ ...base, lastError: "0xdeadbeef", now: 5_000 }), "failed");
  });

  it("reports done even after a failure was recorded", () => {
    // A retry that succeeded clears `lastError`, but if it did not, `done` is
    // still the stronger fact: the action happened.
    assert.equal(
      executionStage({ ...base, done: true, lastError: "0xdeadbeef", now: 5_000 }),
      "done",
    );
  });
});

describe("secondsUntilReady", () => {
  it("counts down", () => {
    assert.equal(secondsUntilReady(1_000n, 940), 60);
  });

  it("floors at zero rather than going negative", () => {
    // A negative countdown renders as "-3600s ago" or, worse, as a countdown
    // that grows. Sat elapsed is zero remaining, not negative.
    assert.equal(secondsUntilReady(1_000n, 4_600), 0);
  });
});

describe("shouldShowExecution", () => {
  it("shows the queue for a passed poll", () => {
    assert.equal(shouldShowExecution({ outcome: PollOutcome.Passed, target: ZERO_ADDRESS }), true);
  });

  it("hides the queue for a poll that did not pass", () => {
    assert.equal(
      shouldShowExecution({ outcome: PollOutcome.QuorumNotMet, target: ZERO_ADDRESS }),
      false,
    );
  });

  it("still shows a queue that exists on a failed poll", () => {
    // Reachable when a poll passed, was queued, and then... nothing changes the
    // outcome. But the queue is the fact that matters, and hiding it because the
    // outcome reads differently would strand it.
    assert.equal(shouldShowExecution({ outcome: PollOutcome.Rejected, target: TARGET }), true);
  });
});

describe("describeRevertData", () => {
  it("returns nothing for empty data", () => {
    assert.equal(describeRevertData(""), "");
    assert.equal(describeRevertData("0x"), "");
  });

  it("decodes an Error(string) payload", () => {
    // 0x08c379a0 + offset(32) + length(13) + "target refused" padded
    const message = "target refused";
    const encoded =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      message.length.toString(16).padStart(64, "0") +
      Buffer.from(message, "utf8").toString("hex").padEnd(64, "0");

    assert.equal(describeRevertData(encoded), message);
  });

  it("names a bare selector instead of showing raw hex", () => {
    // Four bytes and no message: `UnknownOption(3)` and similar. Showing the
    // hex alone is the same as showing nothing to a reader.
    const described = describeRevertData("0x12345678");

    assert.match(described, /0x12345678/);
    assert.match(described, /rejected/i);
  });

  it("keeps undecodable data as evidence rather than replacing it", () => {
    // Longer than a selector, but not an Error(string). Discarding the hex would
    // leave a reader with nothing to look up.
    const odd = "0x" + "ab".repeat(40);

    assert.equal(describeRevertData(odd), odd);
  });
});

describe("formatBps", () => {
  it("formats whole percentages without a decimal point", () => {
    assert.equal(formatBps(5_000n), "50%");
    assert.equal(formatBps(10_000n), "100%");
    assert.equal(formatBps(0n), "0%");
  });

  it("formats fractional percentages with two places", () => {
    assert.equal(formatBps(5_050n), "50.5%");
    assert.equal(formatBps(5_005n), "50.05%");
  });
});

describe("turnoutClearsQuorum", () => {
  it("passes trivially when no quorum is required", () => {
    // 0 means "no requirement", which is the default for every poll created
    // before the feature existed. Treating it as an unmet zero would mark them
    // all as failed.
    assert.equal(turnoutClearsQuorum(0n, 0n), true);
  });

  it("clears at exactly the threshold", () => {
    assert.equal(turnoutClearsQuorum(5_000n, 5_000n), true);
  });

  it("does not clear one basis point below", () => {
    assert.equal(turnoutClearsQuorum(4_999n, 5_000n), false);
  });
});

describe("quorumLabel", () => {
  it("says so when there is no quorum", () => {
    assert.equal(quorumLabel(0n), "No quorum required");
  });

  it("states the requirement as a share of eligible power", () => {
    assert.equal(quorumLabel(5_000n), "50% of eligible power");
  });
});
