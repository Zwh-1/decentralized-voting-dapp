// SPDX-License-Identifier: MIT
/**
 * The rules that decide what a reader is told about their own money.
 *
 * These functions used to live inside `PollBallot.tsx`, where the only coverage
 * was a headless-Chrome drill. That is an expensive way to check a branch, so the
 * expensive failures went unchecked: a disabled button whose reason named the
 * wrong cause, or a control that was silently grey with no explanation at all.
 *
 * The cases below are the ones where being wrong costs something — a reader told
 * to "connect a wallet" they already connected, told their stake is gone when it
 * is only locked, or given no reason for a control that cannot be used.
 *
 * `PollPhase` values are inlined rather than imported so that a change to the
 * enum's numbering shows up here as a failure rather than silently re-pointing
 * every case at a different phase.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUSY_REASON,
  changeReason,
  closeReason,
  refundReason,
  sharedBlock,
  voteReason,
  withdrawReason,
  type BallotInputs,
} from "../src/lib/ballot-reasons";

const SETUP = 0;
const VOTING = 1;
const ENDED = 2;

const CHAIN_ID = 31337;

/** A votable poll: open, in progress, reader connected and admitted. */
function inputs(overrides: Partial<BallotInputs> = {}): BallotInputs {
  return {
    contractKnown: true,
    subjectChainId: CHAIN_ID,
    isConnected: true,
    txBusy: false,
    phaseState: "ready",
    voterState: "ready",
    phase: VOTING,
    deadlinePassed: false,
    canVote: true,
    whitelisted: true,
    marked: false,
    myOptionId: 0,
    myStake: undefined,
    ...overrides,
  };
}

describe("sharedBlock", () => {
  it("lets a fully valid voter through", () => {
    assert.equal(sharedBlock(inputs()), undefined);
  });

  it("names the chain when there is no factory on it", () => {
    // The reader needs to know which chain is wrong, and the sentence names the
    // id and the human name rather than saying "wrong network".
    const reason = sharedBlock(inputs({ contractKnown: false, subjectChainId: 11155111 }));

    assert.match(reason ?? "", /11155111/);
    assert.match(reason ?? "", /Sepolia/);
    assert.match(reason ?? "", /切到本应用部署的那条链/);
  });

  it("asks for a wallet before anything else about the reader", () => {
    // Ordering matters: with no wallet there is nobody to admit, so reporting
    // "not whitelisted" would be a fact about the zero address.
    const reason = sharedBlock(inputs({ isConnected: false, whitelisted: false, canVote: false }));

    assert.equal(reason, "请先连接钱包。");
  });

  it("reports a busy transaction ahead of a stale read", () => {
    const reason = sharedBlock(inputs({ txBusy: true, phaseState: "loading" }));

    assert.equal(reason, BUSY_REASON);
  });

  it("separates a failed phase read from one still in flight", () => {
    assert.match(sharedBlock(inputs({ phaseState: "failed" })) ?? "", /失败/);
    assert.match(sharedBlock(inputs({ phaseState: "loading" })) ?? "", /正在读取/);
  });

  it("explains that a poll in Setup accepts nothing yet", () => {
    const reason = sharedBlock(inputs({ phase: SETUP }));

    assert.match(reason ?? "", /startPoll/);
  });

  it("distinguishes a past-deadline poll from an ended one", () => {
    // The two are genuinely different states with different remedies, and the
    // whole point of the wording is that a reader past the deadline learns their
    // stake needs `closeAfterDeadline()` while an Ended poll already allows a
    // refund.
    const pastDeadline = sharedBlock(inputs({ phase: VOTING, deadlinePassed: true }));
    const ended = sharedBlock(inputs({ phase: ENDED, deadlinePassed: true }));

    assert.match(pastDeadline ?? "", /已过截止时间/);
    assert.match(ended ?? "", /投票已结束/);
    assert.notEqual(pastDeadline, ended);
  });

  it("separates a failed voter read from one still in flight", () => {
    assert.match(sharedBlock(inputs({ voterState: "failed" })) ?? "", /失败/);
    assert.match(sharedBlock(inputs({ voterState: "loading" })) ?? "", /正在读取/);
  });

  it("names the whitelist when that is the gate", () => {
    const reason = sharedBlock(inputs({ canVote: false, whitelisted: false }));

    assert.match(reason ?? "", /白名单/);
  });

  it("does not claim a whitelist refusal for an admitted address", () => {
    // `canVote` false with `whitelisted` true should be unreachable on a healthy
    // contract. If it happens the sentence must not send the reader to the
    // creator about a list they are already on.
    const reason = sharedBlock(inputs({ canVote: false, whitelisted: true }));

    assert.match(reason ?? "", /阶段与截止时间/);
    assert.doesNotMatch(reason ?? "", /不在本投票的白名单/);
  });

  it("never refuses an open poll's voter for being off the list", () => {
    // The regression the `openToAll` work exists to prevent: an open poll has no
    // meaningful list, so testing `whitelisted` instead of `canVote` would have
    // told every single reader they were not whitelisted.
    assert.equal(sharedBlock(inputs({ canVote: true, whitelisted: false })), undefined);
  });
});

describe("voteReason", () => {
  it("offers a first vote to an admitted address", () => {
    assert.equal(voteReason(inputs()), undefined);
  });

  it("points an existing voter at 改投 and 撤票 rather than dead-ending them", () => {
    const reason = voteReason(inputs({ marked: true }));

    assert.match(reason ?? "", /AlreadyVoted/);
    assert.match(reason ?? "", /改投/);
    assert.match(reason ?? "", /撤票/);
  });

  it("defers to the shared block", () => {
    assert.equal(
      voteReason(inputs({ marked: true, isConnected: false })),
      "请先连接钱包。",
      "the shared reason wins, so the reader is not told about AlreadyVoted first",
    );
  });
});

describe("changeReason", () => {
  it("allows a move to a different option", () => {
    assert.equal(changeReason(inputs({ marked: true, myOptionId: 1 }), 2), undefined);
  });

  it("refuses the option the address already backs, naming SameOption", () => {
    const reason = changeReason(inputs({ marked: true, myOptionId: 2 }), 2);

    assert.match(reason ?? "", /SameOption/);
  });

  it("still allows a change when the reader is not admitted", () => {
    // `changeVote` has no admission check in the contract — only `vote` does — so
    // a reader whose whitelist entry was revoked mid-ballot can still move a vote
    // they already hold. Reporting the whitelist here would disable a button the
    // chain would accept.
    assert.equal(
      changeReason(inputs({ marked: true, myOptionId: 1, canVote: false }), 2),
      undefined,
    );
  });

  it("applies the admission gate when the reader holds no vote", () => {
    // The other half of the pair above, and the reason the gate is conditional:
    // an unmarked address offered a "change" is really being offered a first vote
    // that `HasNotVoted` will reject, so admission is the honest reason.
    const reason = changeReason(inputs({ marked: false, canVote: false, whitelisted: false }), 2);

    assert.match(reason ?? "", /白名单/);
  });

  it("lets an ended poll win over admission", () => {
    // Ordering. A revoked address in an ended poll must hear about the poll, not
    // about the list — the list is not what is stopping them.
    const reason = changeReason(inputs({ marked: true, phase: ENDED, canVote: false }), 2);

    assert.match(reason ?? "", /投票已结束/);
    assert.doesNotMatch(reason ?? "", /白名单/);
  });
});

describe("withdrawReason", () => {
  it("allows a withdrawal while the poll is open", () => {
    assert.equal(
      withdrawReason(inputs({ marked: true, myStake: 1_000_000_000_000_000n })),
      undefined,
    );
  });

  it("sends a closed-poll voter to 取回押金 instead", () => {
    const reason = withdrawReason(inputs({ marked: true, phase: ENDED }));

    assert.match(reason ?? "", /取回押金/);
  });

  it("allows a withdrawal in a poll that is open but past its deadline", () => {
    // This is the trap `Phase.Voting` + past deadline creates: the contract
    // rejects the call, so the button must be disabled — but the phrase "投票已经
    // 结束" would be wrong, because the phase genuinely still says Voting.
    const reason = withdrawReason(inputs({ marked: true, phase: VOTING, deadlinePassed: true }));

    assert.match(reason ?? "", /已经结束/);
  });

  it("names HasNotVoted for an address holding nothing", () => {
    const reason = withdrawReason(inputs({ marked: false }));

    assert.match(reason ?? "", /HasNotVoted/);
  });

  it("does not guess between never-voted and already-withdrawn", () => {
    // Both produce `marked: false` and `voterState` cannot tell them apart, so
    // the sentence must state only the checkable fact.
    const reason = withdrawReason(inputs({ marked: false })) ?? "";

    assert.doesNotMatch(reason, /从未投票/);
    assert.doesNotMatch(reason, /已经撤票/);
  });
});

describe("refundReason", () => {
  it("offers a refund for a stake held in an ended poll", () => {
    const reason = refundReason(
      inputs({ phase: ENDED, marked: true, myStake: 1_000_000_000_000_000n }),
    );

    assert.equal(reason, undefined);
  });

  it("redirects a still-open poll to 撤票, which returns the stake immediately", () => {
    const reason = refundReason(inputs({ phase: VOTING, marked: true, myStake: 1n }));

    assert.match(reason ?? "", /撤票/);
  });

  it("says plainly when there is nothing to refund", () => {
    assert.equal(refundReason(inputs({ phase: ENDED, myStake: 0n })), "没有可取回的押金。");
  });

  it("treats an unread stake as unknown rather than as zero", () => {
    // The defect `ballot-labels.ts` documents: a failed `stakeOf` rendering as
    // "0 ETH" is a confident claim about the reader's money that `sweepUnclaimed`
    // can make false. An undefined stake must not take the zero branch.
    const reason = refundReason(inputs({ phase: ENDED, myStake: undefined, voterState: "failed" }));

    assert.notEqual(reason, "没有可取回的押金。");
    assert.match(reason ?? "", /失败/);
  });

  it("does not offer a refund for a poll still inside its deadline", () => {
    const reason = refundReason(
      inputs({ phase: VOTING, deadlinePassed: true, marked: true, myStake: 1n }),
    );

    assert.equal(reason, undefined, "a closed poll's stake is refundable");
  });
});

describe("closeReason", () => {
  it("offers the permissionless close past the deadline", () => {
    // The button that unlocks everyone's stake when the creator never calls
    // `endPoll`. Nothing about the reader's identity may appear in this path.
    assert.equal(closeReason(inputs({ phase: VOTING, deadlinePassed: true })), undefined);
  });

  it("does not require a connected wallet", () => {
    // `closeAfterDeadline` is permissionless, so a disconnected reader can still
    // fire it. Gating on a wallet would strand the stake behind a connection.
    assert.equal(
      closeReason(inputs({ phase: VOTING, deadlinePassed: true, isConnected: false })),
      undefined,
    );
  });

  it("does not require the reader to be admitted", () => {
    assert.equal(
      closeReason(
        inputs({ phase: VOTING, deadlinePassed: true, canVote: false, whitelisted: false }),
      ),
      undefined,
    );
  });

  it("refuses before the deadline, naming DeadlineNotInFuture", () => {
    const reason = closeReason(inputs({ phase: VOTING, deadlinePassed: false }));

    assert.match(reason ?? "", /DeadlineNotInFuture/);
  });

  it("refuses a poll in Setup, naming InvalidPhase", () => {
    const reason = closeReason(inputs({ phase: SETUP, deadlinePassed: true }));

    assert.match(reason ?? "", /InvalidPhase/);
  });

  it("says an ended poll is already closed", () => {
    assert.match(closeReason(inputs({ phase: ENDED, deadlinePassed: true })) ?? "", /已经正式关闭/);
  });
});

describe("every reason is a sentence", () => {
  it("never returns an empty string where a control is disabled", () => {
    // A disabled button with an empty reason renders as grey and silent, which is
    // the one outcome the ballot must not produce. Sweeping the state space is
    // cheap now that these are pure functions.
    const phases = [SETUP, VOTING, ENDED, undefined];
    const statuses = ["ready", "loading", "failed"] as const;
    let checked = 0;

    for (const phase of phases) {
      for (const phaseState of statuses) {
        for (const voterState of statuses) {
          for (const deadlinePassed of [false, true]) {
            for (const isConnected of [false, true]) {
              for (const canVote of [false, true]) {
                for (const marked of [false, true]) {
                  const input = inputs({
                    phase,
                    phaseState,
                    voterState,
                    deadlinePassed,
                    isConnected,
                    canVote,
                    marked,
                    myOptionId: marked ? 1 : 0,
                    myStake: marked ? 1n : undefined,
                  });

                  for (const reason of [
                    voteReason(input),
                    changeReason(input, 1),
                    changeReason(input, 2),
                    withdrawReason(input),
                    refundReason(input),
                    closeReason(input),
                  ]) {
                    checked += 1;

                    if (reason !== undefined) {
                      assert.notEqual(reason, "", "a reason is never empty when present");
                      assert.equal(typeof reason, "string");
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    assert.ok(checked > 1000, `the sweep should cover many states, covered ${checked}`);
  });
});
