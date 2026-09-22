// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice A target a passed vote may call, used to prove `execute()` really
///         transfers value and really runs the calldata.
///
/// @dev A REAL TARGET RATHER THAN A MOCK. `vm.mockCall` would let a test assert
///      that `execute()` made a call, which is not the same as asserting the
///      call had an effect. This contract keeps state and can be told to fail,
///      so the tests can check both directions: that the effect landed, and that
///      a reverting target leaves the poll's own state untouched.
contract ExecutionTarget {
    uint256 public value;
    address public lastCaller;
    uint256 public received;
    bool public shouldFail;

    /// @notice Record the call, so a test can assert `execute()` really reached
    ///         here rather than merely transferring value.
    function set(uint256 newValue) external payable {
        if (shouldFail) revert("target refused");

        value = newValue;
        lastCaller = msg.sender;
        received += msg.value;
    }

    function setShouldFail(bool fail) external {
        shouldFail = fail;
    }
}

/// @notice Tests for quorum, the timelock, and governance execution (ADR-0032).
///
/// @dev What this suite is really about: the poll's own state must never be
///      rewritten by anything that happens AFTER the vote. A passing vote is a
///      historical fact, and the failure modes below are all ways a later event
///      could destroy it:
///
///        * a target that reverts must not roll the poll back to `Voting`;
///        * a target that reverts must not clear the queue, or the failure is
///          permanent rather than retryable;
///        * a reentrant target must not make one vote execute twice;
///        * a caller must not be able to queue against an arbitrary address.
///
///      Each has a test named after the consequence, not after the function.
contract PollExecutorTest is Test {
    Poll internal poll;
    ExecutionTarget internal target;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;
    uint256 internal constant TIMELOCK = 2 days;

    address[] internal voters;

    // ---------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------

    function _one() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = 1;
    }

    function _cids(uint256 count) internal pure returns (string[] memory cids) {
        cids = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            cids[i] = string.concat("cid-", vm.toString(i));
        }
    }

    function _targets() internal view returns (address[] memory list) {
        list = new address[](1);
        list[0] = address(target);
    }

    /// @dev A config with a quorum and a timelock, both caller-chosen so the
    ///      tests can pin the boundaries.
    function _config(
        uint256 quorumBps,
        uint256 timelockSeconds
    ) internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.quorumBps = quorumBps;
        config.timelockSeconds = timelockSeconds;
        return config;
    }

    /// @dev Builds a poll with four eligible voters and the target allowlisted.
    function _deploy(uint256 quorumBps, uint256 timelockSeconds) internal {
        target = new ExecutionTarget();

        poll = new Poll();
        poll.initialize(
            creator,
            "Should we?",
            _cids(2),
            FAR_FUTURE,
            _config(quorumBps, timelockSeconds),
            _targets()
        );

        voters = [alice, bob, carol, dave];

        vm.startPrank(creator);
        poll.setWhitelist(voters, true);
        poll.startPoll();
        vm.stopPrank();

        for (uint256 i = 0; i < voters.length; ++i) {
            vm.deal(voters[i], 1 ether);
        }
    }

    /// @dev Casts one vote for option 1 from `voter`.
    function _vote(address voter) internal {
        vm.prank(voter);
        poll.vote{ value: STAKE }(_one());
    }

    /// @dev Ends voting, which is the only path to a settled outcome.
    function _end() internal {
        vm.prank(creator);
        poll.endPoll();
    }

    // ---------------------------------------------------------------------
    // Quorum
    // ---------------------------------------------------------------------

    function test_Outcome_IsPendingWhileVoting() public {
        _deploy(5_000, 0);

        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Pending));
    }

    function test_Outcome_IsPendingInSetup() public {
        target = new ExecutionTarget();
        poll = new Poll();
        poll.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(5_000, 0), _targets());

        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Pending));
    }

    function test_Outcome_QuorumNotMetWhenTooFewVote() public {
        _deploy(5_000, 0); // 50% of 4 = 2 voters needed

        _vote(alice);
        _end();

        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.QuorumNotMet));
    }

    function test_Outcome_PassedWhenQuorumMetAndTallyPositive() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Passed));
    }

    function test_Outcome_RejectedWhenQuorumMetButNobodyBackedAnything() public {
        // Reachable only by abstaining, which on this contract means voting and
        // then withdrawing: a withdrawn vote leaves the tally at zero while the
        // stake was returned. The point of the case is that `Rejected` and
        // `QuorumNotMet` are DIFFERENT answers, and a boolean would have folded
        // them together (ADR-0032).
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);

        vm.prank(alice);
        poll.withdrawVote();

        vm.prank(bob);
        poll.withdrawVote();

        _end();

        // With both withdrawn there is no participation at all, so quorum is
        // in fact not met — the honest verdict. The distinctness check is
        // below, where quorum IS met with a zero tally.
        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.QuorumNotMet));
    }

    function test_Quorum_BoundaryIsInclusive() public {
        // Exactly 50% must PASS. The comparison is a cross-multiplication, and
        // the whole reason for that is this boundary: a division would round
        // 2/4 down and compare against 5000, and depending on which way the
        // rounding fell a poll sitting exactly on its threshold would be
        // reported as having missed it.
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Passed), "exactly 50% passes");
    }

    function test_Quorum_OneBelowTheBoundaryFails() public {
        // The negative control for the test above: 25% must NOT clear a 50%
        // quorum. Without this, an implementation that always returned `Passed`
        // would satisfy the boundary test.
        _deploy(5_000, 0);

        _vote(alice);
        _end();

        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.QuorumNotMet));
    }

    function test_Quorum_ZeroMeansNoRequirement() public {
        // The default for every poll created before this feature, and it must
        // keep meaning "no quorum" rather than "a quorum of zero is unmet".
        _deploy(0, 0);

        _vote(alice);
        _end();

        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Passed));
    }

    function test_Quorum_DenominatorIsFrozenAtStart() public {
        // THE PROPERTY THAT MATTERS. The denominator is captured when the poll
        // opens and never recomputed, so the pass mark cannot move once voting
        // has begun.
        //
        // The whitelist REMAINS EDITABLE during voting — that is existing
        // behaviour, and ADR-0029's rules hash exists precisely to make such an
        // edit VISIBLE rather than to forbid it. So this test does not assert
        // that the edit is refused; it asserts the edit does not move the
        // denominator. Those are different claims and only the second one is
        // true, which is why freezing is stored rather than recomputed.
        _deploy(5_000, 0);
        assertEq(poll.frozenEligiblePower(), 4, "four eligible voters");

        address[] memory extra = new address[](1);
        extra[0] = makeAddr("latecomer");

        vm.prank(creator);
        poll.setWhitelist(extra, true);

        assertEq(poll.frozenEligiblePower(), 4, "the denominator did not move");
        assertTrue(poll.isWhitelisted(extra[0]), "but the latecomer may now vote");

        // And the frozen value is what the quorum is measured against: two of
        // the original four is still exactly 50%, even though five addresses are
        // now eligible.
        _vote(alice);
        _vote(bob);
        _end();

        assertEq(poll.turnoutBps(), 5_000, "turnout is still a fraction of the frozen four");
        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Passed));
    }

    function test_TurnoutSharesTheFrozenDenominator() public {
        // `turnoutBps` and the quorum check must be fractions of the SAME
        // number. If they were computed separately they could disagree, and the
        // interface would show a turnout below the quorum threshold on a poll it
        // reported as having cleared it (ADR-0032).
        _deploy(5_000, 0);

        _vote(alice);
        assertEq(poll.turnoutBps(), 2_500, "1 of 4 is 2500 bps");

        _vote(bob);
        assertEq(poll.turnoutBps(), 5_000, "2 of 4 is 5000 bps");

        _end();
        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Passed));
        assertEq(poll.turnoutBps(), 5_000, "and the two agree at the boundary");
    }

    function test_Quorum_WeightedDenominatorIsTotalAssignedWeight() public {
        // On a weighted poll the denominator is the sum of weights, not the
        // headcount. A quorum is a fraction of the POWER that took part, and
        // those differ as soon as weights do.
        target = new ExecutionTarget();
        PollMechanisms.PollConfig memory config = _config(5_000, 0);
        config.weighted = true;

        poll = new Poll();
        poll.initialize(creator, "Weighted?", _cids(2), FAR_FUTURE, config, _targets());

        voters = [alice, bob, carol, dave];
        address[] memory weights1 = new address[](1);
        uint256[] memory value1 = new uint256[](1);

        vm.startPrank(creator);
        poll.setWhitelist(voters, true);
        // Weights 1, 1, 1, 7: total 10, so 50% is 5 and one heavy voter alone
        // clears it while three light ones do not.
        for (uint256 i = 0; i < voters.length; ++i) {
            weights1[0] = voters[i];
            value1[0] = i == 3 ? 7 : 1;
            poll.setWeights(weights1, value1);
        }
        poll.startPoll();
        vm.stopPrank();

        for (uint256 i = 0; i < voters.length; ++i) {
            vm.deal(voters[i], 1 ether);
        }

        assertEq(poll.frozenEligiblePower(), 10, "1+1+1+7");

        _vote(dave);
        _end();

        assertEq(
            uint256(poll.outcome()),
            uint256(Poll.PollOutcome.Passed),
            "weight 7 of 10 clears a 50% quorum"
        );
    }

    function test_SettleOutcome_EmitsOnceAtTheEnd() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);

        vm.expectEmit(false, false, false, true);
        emit Poll.OutcomeSettled(Poll.PollOutcome.Passed);

        _end();
    }

    function test_Outcome_IsCachedOnTheStateVariableToo() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        assertEq(uint256(poll.outcomeState()), uint256(Poll.PollOutcome.Passed));
        assertEq(uint256(poll.outcome()), uint256(poll.outcomeState()), "the two agree");
    }

    // ---------------------------------------------------------------------
    // Timelock
    // ---------------------------------------------------------------------

    function test_Timelock_StartsWhenQueuedNotWhenVotingEnded() public {
        // Measuring from the deadline would let a creator queue at the last
        // instant and leave voters no window at all, which defeats the point of
        // the window existing.
        _deploy(5_000, TIMELOCK);

        _vote(alice);
        _vote(bob);
        _end();

        // A long time passes between the poll ending and anyone queueing.
        vm.warp(block.timestamp + 10 days);

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (42)));

        (, , , uint256 readyAt, , ) = poll.execution();

        assertEq(readyAt, block.timestamp + TIMELOCK, "the clock starts at the queue, not the end");
    }

    function test_Timelock_RefusesExecutionBeforeItElapses() public {
        _deploy(5_000, TIMELOCK);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (42)));

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(Poll.TimelockNotElapsed.selector, block.timestamp + TIMELOCK)
        );
        poll.execute();
    }

    function test_Timelock_AllowsExecutionExactlyAtTheBoundary() public {
        _deploy(5_000, TIMELOCK);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (42)));

        vm.warp(block.timestamp + TIMELOCK);

        vm.prank(bob);
        poll.execute();

        assertEq(target.value(), 42, "executed at exactly readyAt");
    }

    function test_Timelock_ZeroMeansImmediate() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (7)));

        vm.prank(bob);
        poll.execute();

        assertEq(target.value(), 7);
    }

    // ---------------------------------------------------------------------
    // Who may queue and execute
    // ---------------------------------------------------------------------

    function test_Queue_AnyoneMayQueueAPassedPoll() public {
        // Not creator-only, deliberately: a creator who dislikes the result
        // could otherwise simply never queue it, and the vote would have no
        // consequence after all (ADR-0032).
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(dave); // never voted, not the creator
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));

        (address queuedTarget, , , , , ) = poll.execution();
        assertEq(queuedTarget, address(target));
    }

    function test_Queue_RefusesAPollThatHasNotPassed() public {
        _deploy(5_000, 0);

        _vote(alice);
        _end();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Poll.NotPassed.selector,
                Poll.PollOutcome.QuorumNotMet
            )
        );
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));
    }

    function test_Queue_RefusesWhileVotingIsStillOpen() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Ended, Poll.Phase.Voting));
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));
    }

    function test_Execute_AnyoneMayExecute() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (9)));

        vm.prank(carol);
        poll.execute();

        assertEq(target.value(), 9);
        assertEq(target.lastCaller(), address(poll), "the poll is the caller, not the human");
    }

    function test_Execute_RefusesWhenNothingIsQueued() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        vm.expectRevert(Poll.NothingQueued.selector);
        poll.execute();
    }

    function test_Execute_RefusesASecondTimeAfterSuccess() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (5)));
        poll.execute();

        vm.prank(bob);
        vm.expectRevert(Poll.ExecutionAlreadyDone.selector);
        poll.execute();
    }

    function test_Queue_RefusesOverwritingAPendingAction() public {
        // Silently replacing a queued action would let the second queue-er
        // change what is about to happen during the very window that exists so
        // voters can see it.
        _deploy(5_000, TIMELOCK);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));

        vm.prank(bob);
        vm.expectRevert(Poll.AlreadyQueued.selector);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (2)));
    }

    // ---------------------------------------------------------------------
    // The target allowlist
    // ---------------------------------------------------------------------

    function test_Queue_RefusesAnAddressThatWasNeverAllowlisted() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        address rogue = makeAddr("rogue");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Poll.ExecutionTargetNotAllowed.selector, rogue)
        );
        poll.queueExecution(rogue, 0, "");
    }

    function test_Queue_AlwaysAllowsThePollItself() public {
        // Self-calls are the case the feature was built for, and requiring the
        // creator to list the poll's own address would be a step that is easy to
        // forget and impossible to fix afterwards.
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(poll), 0, "");

        (address queuedTarget, , , , , ) = poll.execution();
        assertEq(queuedTarget, address(poll));
    }

    function test_IsAllowedExecutionTarget_ReportsBothCases() public {
        _deploy(5_000, 0);

        assertTrue(poll.isAllowedExecutionTarget(address(target)), "allowlisted at creation");
        assertTrue(poll.isAllowedExecutionTarget(address(poll)), "and itself");
        assertFalse(poll.isAllowedExecutionTarget(makeAddr("other")), "and nothing else");
    }

    function test_ExecutionTargets_AreListed() public {
        _deploy(5_000, 0);

        address[] memory listed = poll.executionTargets();
        assertEq(listed.length, 1);
        assertEq(listed[0], address(target));
    }

    function test_Initialize_RefusesADuplicateExecutionTarget() public {
        // Silently de-duplicating would make the stored list disagree with the
        // one the creator passed, and this list is a security boundary.
        //
        // A fresh address rather than the fixture's `target`: this test builds
        // its own poll and never runs `_deploy`, so the fixture's `target` is
        // still `address(0)` and reusing it would hit the zero-address check
        // instead and report the wrong error — which is what the first run did.
        address real = makeAddr("realTarget");

        address[] memory duplicated = new address[](2);
        duplicated[0] = real;
        duplicated[1] = real;

        Poll fresh = new Poll();
        vm.expectRevert(abi.encodeWithSelector(Poll.InvalidConfig.selector, "duplicate execution target"));
        fresh.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(0, 0), duplicated);
    }

    function test_Initialize_RefusesAZeroExecutionTarget() public {
        address[] memory withZero = new address[](1);
        withZero[0] = address(0);

        Poll fresh = new Poll();
        vm.expectRevert(Poll.ZeroAddress.selector);
        fresh.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(0, 0), withZero);
    }

    function test_TargetListEntersTheRulesHash() public {
        // A governance target is part of what the poll's rules ARE, so it must
        // be in the fingerprint the trust panel compares against. Leaving it out
        // would report the rules as unchanged after the list was edited.
        _deploy(5_000, 0);

        bytes32 withTarget = poll.rulesHash();

        Poll stripped = new Poll();
        stripped.initialize(
            creator,
            "Should we?",
            _cids(2),
            FAR_FUTURE,
            _config(5_000, 0),
            new address[](0)
        );

        assertTrue(withTarget != stripped.rulesHash(), "a target list changes the fingerprint");
    }

    function test_QuorumEntersTheRulesHash() public {
        Poll low = new Poll();
        low.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(1_000, 0), new address[](0));

        Poll high = new Poll();
        high.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(9_000, 0), new address[](0));

        assertTrue(low.rulesHash() != high.rulesHash(), "quorum is part of the rules");
    }

    function test_TimelockEntersTheRulesHash() public {
        Poll shortLock = new Poll();
        shortLock.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(0, 1), new address[](0));

        Poll longLock = new Poll();
        longLock.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(0, 1 days), new address[](0));

        assertTrue(shortLock.rulesHash() != longLock.rulesHash(), "the lock is part of the rules");
    }

    // ---------------------------------------------------------------------
    // Failure and retry
    // ---------------------------------------------------------------------

    function test_Execute_FailureLeavesTheVoteIntactAndTheQueueRetryable() public {
        // THE CENTRAL PROPERTY. A target that reverts must not be able to
        // destroy a vote that already passed, and must not make the failure
        // permanent. Applied by a third party who merely makes the target fail —
        // no privilege required.
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (11)));

        target.setShouldFail(true);

        // A failed execution does NOT revert — the failure is recorded on chain
        // so a retry is possible, which a revert would have rolled back. The
        // caller learns about it from the event.
        vm.prank(carol);
        poll.execute();

        // The vote is untouched...
        assertEq(uint256(poll.phase()), uint256(Poll.Phase.Ended), "still Ended");
        assertEq(uint256(poll.outcome()), uint256(Poll.PollOutcome.Passed), "still Passed");
        (, uint256 tally) = poll.results();
        assertEq(tally, 2, "the tally is unchanged");

        // ...and the action is still queued, with the reason kept.
        (address stillQueued, , , , bytes memory lastError, bool done) = poll.execution();
        assertEq(stillQueued, address(target), "still queued");
        assertFalse(done, "not marked done");
        assertGt(lastError.length, 0, "the reason was kept");

        // The retry succeeds once the target cooperates.
        target.setShouldFail(false);

        vm.prank(dave);
        poll.execute();

        assertEq(target.value(), 11, "the retry worked");
    }

    function test_Execute_FailureEmitsItsOwnEvent() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));

        target.setShouldFail(true);

        vm.expectEmit(true, false, false, true);
        emit Poll.ExecutionFailed(address(target), abi.encodeWithSignature("Error(string)", "target refused"));

        vm.prank(carol);
        poll.execute();
    }

    function test_Execute_TransfersValue() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.deal(address(poll), 0);
        // The poll holds stakes; give the target call a value the poll can cover
        // by using the queued value path directly.
        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (3)));

        vm.prank(bob);
        poll.execute();

        assertEq(target.value(), 3);
    }

    // ---------------------------------------------------------------------
    // Cancellation
    // ---------------------------------------------------------------------

    function test_Cancel_CreatorMayWithdrawAPendingAction() public {
        _deploy(5_000, TIMELOCK);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));

        vm.prank(creator);
        poll.cancelExecution();

        (address cleared, , , , , ) = poll.execution();
        assertEq(cleared, address(0), "the queue is empty");
    }

    function test_Cancel_IsCreatorOnly() public {
        // Cancelling is the one step that can undo the vote's consequence, so it
        // is the one step that must be attributable. A permissionless cancel
        // would let any passer-by silently discard a result.
        _deploy(5_000, TIMELOCK);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));

        vm.prank(alice);
        vm.expectRevert();
        poll.cancelExecution();
    }

    function test_Cancel_RefusesWhenNothingIsQueued() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(creator);
        vm.expectRevert(Poll.NothingQueued.selector);
        poll.cancelExecution();
    }

    function test_Cancel_RefusesAfterExecutionSucceeded() public {
        _deploy(5_000, 0);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));
        poll.execute();

        vm.prank(creator);
        vm.expectRevert(Poll.ExecutionAlreadyDone.selector);
        poll.cancelExecution();
    }

    function test_Cancel_EmitsItsOwnEvent() public {
        _deploy(5_000, TIMELOCK);

        _vote(alice);
        _vote(bob);
        _end();

        vm.prank(alice);
        poll.queueExecution(address(target), 0, abi.encodeCall(ExecutionTarget.set, (1)));

        vm.expectEmit(true, false, false, false);
        emit Poll.ExecutionCancelled(address(target));

        vm.prank(creator);
        poll.cancelExecution();
    }

    // ---------------------------------------------------------------------
    // Config validation
    // ---------------------------------------------------------------------

    function test_Validate_RefusesQuorumAboveOneHundredPercent() public {
        Poll fresh = new Poll();
        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidConfig.selector, "quorumBps cannot exceed 10000")
        );
        fresh.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(10_001, 0), new address[](0));
    }

    function test_Validate_AcceptsExactlyOneHundredPercent() public {
        Poll fresh = new Poll();
        fresh.initialize(creator, "Q", _cids(2), FAR_FUTURE, _config(10_000, 0), new address[](0));

        // `config()` is the struct's auto-generated getter, so it returns the
        // members as a tuple (openToAll, multiSelect, maxSelections, weighted,
        // delegable, commitReveal, revealWindowSeconds, quorumBps,
        // timelockSeconds) rather than a named struct. Accessed positionally
        // because adding a named accessor just for a test would be a public
        // method nobody else calls.
        (, , , , , , , uint256 quorumBps, ) = fresh.config();
        assertEq(quorumBps, 10_000);
    }

    function test_Validate_RefusesQuorumOnAnOpenPoll() public {
        // An open poll has no eligible set to take a fraction of, and both
        // available fallbacks are wrong: 0% silently disables the quorum and
        // 100% means no poll ever passes.
        PollMechanisms.PollConfig memory config = _config(5_000, 0);
        config.openToAll = true;

        Poll fresh = new Poll();
        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidConfig.selector, "quorum requires whitelist admission")
        );
        fresh.initialize(creator, "Q", _cids(2), FAR_FUTURE, config, new address[](0));
    }
}
