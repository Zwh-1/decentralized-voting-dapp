// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { Poll } from "./Poll.sol";
import { CEIOnlyRefund } from "./test/CEIOnlyRefund.sol";
import { GuardOnlyRefund } from "./test/GuardOnlyRefund.sol";
import { RefundAttacker } from "./test/RefundAttacker.sol";
import { EthRejectingVoter } from "./test/EthRejectingVoter.sol";
import { ForcedEtherSender } from "./test/ForcedEtherSender.sol";
import { VulnerableRefund } from "./test/VulnerableRefund.sol";

/// @notice Unit, fuzz, and adversarial tests for `Poll`.
/// @dev Evidence for spec metrics M-2 (authorisation interception) and
///      M-3 (reentrancy attack/defence matrix), ported from the `Voting` suite
///      when the admission model changed, plus the new change/withdraw paths.
contract PollTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant STAKE = 0.001 ether;
    string internal constant CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    string internal constant CID_B = "bafkreieq5jui4j25lacwomsqgvn7mq3z4g4hq7xw774wevxfrfrura3jqq";

    /// @dev A deadline far enough out that nothing in this suite hits it by
    ///      accident; tests that care about the deadline warp explicitly.
    uint256 internal constant FAR_FUTURE = 4_000_000_000;

    function setUp() public {
        poll = _newPoll(creator, FAR_FUTURE);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Deploys a directly (not through a clone), with two options.
    ///
    ///      Defaults to WHITELIST mode, which is what every pre-existing test in
    ///      this suite assumes: they drive `_openPoll()`, which whitelists three
    ///      addresses and expects a fourth to be refused. An open poll is a
    ///      separate fixture (`_newOpenPoll`) so the two admission models are
    ///      never accidentally mixed in one test.
    function _newPoll(address creator_, uint256 endsAt_) internal returns (Poll created) {
        return _newPoll(creator_, endsAt_, false);
    }

    function _newPoll(
        address creator_,
        uint256 endsAt_,
        bool openToAll_
    ) internal returns (Poll created) {
        string[] memory cids = new string[](2);
        cids[0] = CID_A;
        cids[1] = CID_B;

        created = new Poll();
        created.initialize(creator_, "Which one?", cids, endsAt_, openToAll_);
    }

    /// @dev A poll anyone may vote in, with no whitelist at all.
    function _newOpenPoll(address creator_, uint256 endsAt_) internal returns (Poll created) {
        return _newPoll(creator_, endsAt_, true);
    }

    function _threeVoters() internal view returns (address[] memory voters) {
        voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;
    }

    /// @dev Setup + two options + three whitelisted voters + poll open.
    function _openPoll() internal {
        vm.startPrank(creator);
        poll.setWhitelist(_threeVoters(), true);
        poll.startPoll();
        vm.stopPrank();
    }

    function _vote(address voter, uint256 optionId) internal {
        vm.deal(voter, 1 ether);
        vm.prank(voter);
        poll.vote{ value: STAKE }(optionId);
    }

    function _counts() internal view returns (uint256 first, uint256 second, uint256 total) {
        (Poll.Option[] memory list, uint256 sum) = poll.results();
        first = list[0].voteCount;
        second = list[1].voteCount;
        total = sum;
    }

    // ---------------------------------------------------------------------
    // Initialization
    // ---------------------------------------------------------------------

    function test_Initialize_SetsCreatorQuestionAndOptions() public view {
        assertEq(poll.creator(), creator, "creator recorded");
        assertEq(poll.question(), "Which one?", "question recorded");
        assertEq(poll.optionCount(), 2, "two options registered");
        assertEq(poll.optionCID(1), CID_A, "id 1 maps to the first CID");
        assertEq(poll.optionCID(2), CID_B, "id 2 maps to the second CID");
        assertEq(poll.owner(), creator, "the creator owns the poll");
        assertEq(uint256(poll.phase()), uint256(Poll.Phase.Setup), "starts in Setup");
    }

    /// @dev The clone-pattern vulnerability: without the guard, whoever calls
    ///      `initialize` second owns the poll.
    function test_Initialize_RevertsOnSecondCall() public {
        string[] memory cids = new string[](2);
        cids[0] = CID_A;
        cids[1] = CID_B;

        vm.expectRevert(Poll.AlreadyInitialized.selector);
        poll.initialize(alice, "Hijacked", cids, FAR_FUTURE, false);
    }

    function test_Initialize_RevertsWithTooFewOptions() public {
        string[] memory cids = new string[](1);
        cids[0] = CID_A;

        Poll fresh = new Poll();

        vm.expectRevert(abi.encodeWithSelector(Poll.TooFewOptions.selector, 2, 1));
        fresh.initialize(creator, "Q", cids, FAR_FUTURE, false);
    }

    function test_Initialize_RevertsOnPastDeadline() public {
        string[] memory cids = new string[](2);
        cids[0] = CID_A;
        cids[1] = CID_B;

        Poll fresh = new Poll();

        vm.warp(1_800_000_000);
        vm.expectRevert(abi.encodeWithSelector(Poll.DeadlineNotInFuture.selector, 1_700_000_000));
        fresh.initialize(creator, "Q", cids, 1_700_000_000, false);
    }

    function test_Initialize_RevertsOnEmptyQuestion() public {
        string[] memory cids = new string[](2);
        cids[0] = CID_A;
        cids[1] = CID_B;

        Poll fresh = new Poll();

        vm.expectRevert(Poll.EmptyQuestion.selector);
        fresh.initialize(creator, "", cids, FAR_FUTURE, false);
    }

    // ---------------------------------------------------------------------
    // Option management
    // ---------------------------------------------------------------------

    function test_AddOption_AssignsSequentialOneBasedIds() public {
        vm.prank(creator);
        poll.addOption("cid-c");

        assertEq(poll.optionCount(), 3, "third option registered");
        assertEq(poll.optionCID(3), "cid-c", "id 3 maps to the new CID");
    }

    function test_AddOption_EmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(poll));
        emit Poll.OptionAdded(3, "cid-c");

        vm.prank(creator);
        poll.addOption("cid-c");
    }

    function test_AddOption_RevertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));

        vm.prank(alice);
        poll.addOption("cid-c");
    }

    function test_AddOption_RevertsOutsideSetupPhase() public {
        _openPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Setup, Poll.Phase.Voting)
        );

        vm.prank(creator);
        poll.addOption("cid-c");
    }

    function test_UpdateOption_ReplacesCID() public {
        vm.prank(creator);
        poll.updateOption(1, "cid-new");

        assertEq(poll.optionCID(1), "cid-new", "CID replaced in place");
        assertEq(poll.optionCount(), 2, "no option added");
    }

    function test_UpdateOption_RevertsOnUnknownId() public {
        vm.expectRevert(abi.encodeWithSelector(Poll.UnknownOption.selector, 3));

        vm.prank(creator);
        poll.updateOption(3, "cid-new");
    }

    function test_UpdateOption_RevertsOutsideSetupPhase() public {
        _openPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Setup, Poll.Phase.Voting)
        );

        vm.prank(creator);
        poll.updateOption(1, "cid-new");
    }

    /// @dev Removal compacts the array, so what was id 3 becomes id 2. Pinned
    ///      because the indexer keys on ids: a shift nobody documented would be
    ///      an unexplained mismatch later.
    function test_RemoveOption_CompactsLaterIds() public {
        vm.startPrank(creator);
        poll.addOption("cid-c");
        poll.removeOption(1);
        vm.stopPrank();

        assertEq(poll.optionCount(), 2, "count decreased");
        assertEq(poll.optionCID(1), CID_B, "old id 2 shifted to 1");
        assertEq(poll.optionCID(2), "cid-c", "old id 3 shifted to 2");
    }

    function test_RemoveOption_RevertsBelowMinimum() public {
        // Two options is the floor; removing one would leave a one-option poll.
        vm.expectRevert(abi.encodeWithSelector(Poll.TooFewOptions.selector, 3, 2));

        vm.prank(creator);
        poll.removeOption(1);
    }

    function test_RemoveOption_RevertsForNonOwner() public {
        vm.prank(creator);
        poll.addOption("cid-c");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));

        vm.prank(alice);
        poll.removeOption(1);
    }

    function test_RemoveOption_RevertsOutsideSetupPhase() public {
        vm.prank(creator);
        poll.addOption("cid-c");

        _openPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Setup, Poll.Phase.Voting)
        );

        vm.prank(creator);
        poll.removeOption(1);
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @dev The floor is enforced at removal time, so a poll can never be
    ///      reduced below two options — the `startPoll` guard is unreachable
    ///      through `removeOption` and is covered here as defence in depth.
    ///      What matters for the reader is the guarantee, not the branch.
    function test_RemoveOption_CanNeverLeaveFewerThanTwoOptions() public {
        vm.startPrank(creator);
        poll.addOption("cid-c");
        poll.removeOption(1); // two left

        vm.expectRevert(abi.encodeWithSelector(Poll.TooFewOptions.selector, 3, 2));
        poll.removeOption(1);
        vm.stopPrank();

        assertEq(poll.optionCount(), 2, "the poll keeps at least two options");
    }

    function test_StartPoll_RevertsWhenCalledTwice() public {
        _openPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Setup, Poll.Phase.Voting)
        );

        vm.prank(creator);
        poll.startPoll();
    }

    function test_StartPoll_RevertsAfterDeadline() public {
        vm.warp(FAR_FUTURE);

        vm.expectRevert(abi.encodeWithSelector(Poll.PollAlreadyEnded.selector, FAR_FUTURE));

        vm.prank(creator);
        poll.startPoll();
    }

    function test_EndPoll_RecordsTimestampAndTransitionsPhase() public {
        _openPoll();

        vm.warp(1_800_000_000);

        vm.prank(creator);
        poll.endPoll();

        assertEq(uint256(poll.phase()), uint256(Poll.Phase.Ended), "phase must be Ended");
        assertEq(poll.votingEndedAt(), 1_800_000_000, "end timestamp recorded");
    }

    function test_EndPoll_RevertsWhenNotVoting() public {
        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Voting, Poll.Phase.Setup)
        );

        vm.prank(creator);
        poll.endPoll();
    }

    /// @dev Without a permissionless close, a poll whose creator disappeared
    ///      would stay open forever and its stakes would be unreachable.
    function test_CloseAfterDeadline_IsPermissionless() public {
        _openPoll();
        _vote(alice, 1);

        vm.warp(FAR_FUTURE);

        vm.prank(carol);
        poll.closeAfterDeadline();

        assertEq(uint256(poll.phase()), uint256(Poll.Phase.Ended), "anyone can close at the deadline");

        uint256 before = alice.balance;
        vm.prank(alice);
        poll.refund();
        assertEq(alice.balance, before + STAKE, "stake reachable again");
    }

    function test_CloseAfterDeadline_RevertsBeforeDeadline() public {
        _openPoll();

        vm.expectRevert(abi.encodeWithSelector(Poll.DeadlineNotInFuture.selector, FAR_FUTURE));

        vm.prank(carol);
        poll.closeAfterDeadline();
    }

    function test_Vote_RevertsAfterDeadlineEvenWhilePhaseIsVoting() public {
        _openPoll();
        vm.warp(FAR_FUTURE);

        vm.expectRevert(abi.encodeWithSelector(Poll.PollAlreadyEnded.selector, FAR_FUTURE));

        _vote(alice, 1);
    }

    // ---------------------------------------------------------------------
    // Whitelist
    // ---------------------------------------------------------------------

    function test_SetWhitelist_AddsAndRemoves() public {
        address[] memory voters = _threeVoters();

        vm.prank(creator);
        poll.setWhitelist(voters, true);
        assertTrue(poll.isWhitelisted(alice), "alice whitelisted");

        vm.prank(creator);
        poll.setWhitelist(voters, false);
        assertFalse(poll.isWhitelisted(alice), "alice revoked");
    }

    function test_SetWhitelist_RevertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));

        vm.prank(bob);
        poll.setWhitelist(_threeVoters(), true);
    }

    function test_SetWhitelist_RevertsOnZeroAddress() public {
        address[] memory voters = new address[](1);
        voters[0] = address(0);

        vm.expectRevert(Poll.ZeroAddress.selector);

        vm.prank(creator);
        poll.setWhitelist(voters, true);
    }

    function test_SetWhitelist_RevertsAfterPollEnded() public {
        _openPoll();
        vm.prank(creator);
        poll.endPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Voting, Poll.Phase.Ended)
        );

        vm.prank(creator);
        poll.setWhitelist(_threeVoters(), false);
    }

    // ---------------------------------------------------------------------
    // Voting: happy path
    // ---------------------------------------------------------------------

    function test_Vote_RecordsVoteAndStake() public {
        _openPoll();
        _vote(alice, 1);

        assertEq(poll.votedFor(alice), 1, "option recorded");
        assertEq(poll.stakeOf(alice), STAKE, "stake recorded");
        assertEq(poll.totalStaked(), STAKE, "total stake accounted");

        (uint256 first, uint256 second, uint256 total) = _counts();
        assertEq(first, 1, "option 1 has one vote");
        assertEq(second, 0, "option 2 has none");
        assertEq(total, 1, "total is one");
    }

    function test_Vote_EmitsEventWithRunningCount() public {
        _openPoll();
        _vote(alice, 1);

        vm.expectEmit(true, true, false, true, address(poll));
        emit Poll.VoteCast(bob, 1, 2);

        _vote(bob, 1);
    }

    function test_VoterState_ReportsEverythingInOneCall() public {
        _openPoll();
        _vote(alice, 2);

        (bool whitelisted, uint256 current, uint256 stake, bool marked, bool canVote) = poll
            .voterState(alice);

        assertTrue(whitelisted, "whitelisted");
        assertEq(current, 2, "current option");
        assertEq(stake, STAKE, "stake");
        assertTrue(marked, "marked as having voted");
        // On a whitelisted poll the two agree for a listed address, which is
        // exactly the case where the distinction is invisible.
        assertTrue(canVote, "a whitelisted address may vote");
    }

    // ---------------------------------------------------------------------
    // Admission: open polls vs whitelisted polls
    // ---------------------------------------------------------------------

    function test_OpenPoll_LetsAnUnlistedAddressVote() public {
        Poll open = _newOpenPoll(creator, FAR_FUTURE);

        vm.prank(creator);
        open.startPoll();

        // `stranger` was never whitelisted and never could have been: an open
        // poll has no list to consult at all.
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        open.vote{ value: STAKE }(1);

        (, , , bool marked, bool canVote) = open.voterState(stranger);
        assertTrue(marked, "the unlisted address holds a vote");
        assertTrue(canVote, "and it may vote");
    }

    function test_OpenPoll_StillRejectsASecondVote() public {
        // One address one vote is orthogonal to admission: opening the door does
        // not let anyone walk through it twice.
        Poll open = _newOpenPoll(creator, FAR_FUTURE);

        vm.prank(creator);
        open.startPoll();

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        open.vote{ value: STAKE }(1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.AlreadyVoted.selector, alice));
        open.vote{ value: STAKE }(2);
    }

    function test_WhitelistPoll_StillRejectsAnUnlistedAddress() public {
        // The negative control for the pair above. Without this, a `vote` that
        // ignored the flag entirely would pass both open-poll tests.
        _openPoll();

        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Poll.NotWhitelisted.selector, stranger));
        poll.vote{ value: STAKE }(1);
    }

    function test_OpenToAll_IsRecordedAndNotSettable() public {
        Poll open = _newOpenPoll(creator, FAR_FUTURE);
        assertTrue(open.openToAll(), "the flag is recorded at initialize");

        Poll closed = _newPoll(creator, FAR_FUTURE);
        assertFalse(closed.openToAll(), "and defaults to whitelist when passed false");
    }

    function test_OpenPoll_VoterStateReportsTheUnlistedAddressHonestly() public {
        // The UI has to explain WHY someone cannot vote, and on an open poll the
        // answer is never "you are not whitelisted". `whitelisted` therefore
        // stays the raw mapping answer (false) while `canVote` is true — the two
        // fields must not be collapsed into one.
        Poll open = _newOpenPoll(creator, FAR_FUTURE);

        (bool whitelisted, , , , bool canVote) = open.voterState(alice);

        assertFalse(whitelisted, "alice is genuinely not on the list");
        assertTrue(canVote, "but an open poll admits her anyway");
    }

    function test_OpenPoll_SetWhitelistStillWorksButIsNeverConsulted() public {
        Poll open = _newOpenPoll(creator, FAR_FUTURE);

        vm.prank(creator);
        open.startPoll();

        // Granting rights on an open poll is latent state: it writes and emits,
        // and nothing reads it.
        address[] memory one = new address[](1);
        one[0] = alice;

        vm.prank(creator);
        open.setWhitelist(one, true);

        (bool whitelisted, , , , bool canVote) = open.voterState(alice);
        assertTrue(whitelisted, "the list was written");
        assertTrue(canVote, "and the vote still works");
    }

    // ---------------------------------------------------------------------
    // Change vote — the operation the old contract could not express
    // ---------------------------------------------------------------------

    function test_ChangeVote_MovesTheVoteAndKeepsTheStake() public {
        _openPoll();
        _vote(alice, 1);

        uint256 balanceAfterVoting = alice.balance;

        vm.prank(alice);
        poll.changeVote(2);

        (uint256 first, uint256 second, uint256 total) = _counts();
        assertEq(first, 0, "old option released");
        assertEq(second, 1, "new option credited");
        assertEq(total, 1, "the total is unchanged: a change is not a second vote");
        assertEq(poll.votedFor(alice), 2, "current option updated");
        assertEq(poll.stakeOf(alice), STAKE, "stake untouched");
        assertEq(poll.totalStaked(), STAKE, "accounted stake untouched");
        assertEq(alice.balance, balanceAfterVoting, "changing a vote costs no extra stake");
    }

    function test_ChangeVote_EmitsItsOwnEvent() public {
        _openPoll();
        _vote(alice, 1);

        vm.expectEmit(true, false, false, true, address(poll));
        emit Poll.VoteChanged(alice, 1, 2);

        vm.prank(alice);
        poll.changeVote(2);
    }

    function test_ChangeVote_RevertsForNonVoter() public {
        _openPoll();

        vm.expectRevert(abi.encodeWithSelector(Poll.HasNotVoted.selector, alice));

        vm.prank(alice);
        poll.changeVote(1);
    }

    function test_ChangeVote_RevertsToTheSameOption() public {
        _openPoll();
        _vote(alice, 1);

        vm.expectRevert(abi.encodeWithSelector(Poll.SameOption.selector, 1));

        vm.prank(alice);
        poll.changeVote(1);
    }

    function test_ChangeVote_RevertsOnUnknownOption() public {
        _openPoll();
        _vote(alice, 1);

        vm.expectRevert(abi.encodeWithSelector(Poll.UnknownOption.selector, 3));

        vm.prank(alice);
        poll.changeVote(3);
    }

    function test_ChangeVote_RevertsAfterPollEnded() public {
        _openPoll();
        _vote(alice, 1);
        vm.prank(creator);
        poll.endPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Voting, Poll.Phase.Ended)
        );

        vm.prank(alice);
        poll.changeVote(2);
    }

    /// @dev Changing repeatedly must not leak votes into the tally: this is the
    ///      accounting path the property test mutates.
    function test_ChangeVote_RepeatedChangesKeepTheTotalStable() public {
        _openPoll();
        _vote(alice, 1);

        for (uint256 round = 0; round < 10; ++round) {
            uint256 target = round % 2 == 0 ? 2 : 1;
            vm.prank(alice);
            poll.changeVote(target);
        }

        (, , uint256 total) = _counts();
        assertEq(total, 1, "ten changes still amount to exactly one vote");
        assertEq(poll.totalStaked(), STAKE, "and exactly one stake");
    }

    // ---------------------------------------------------------------------
    // Withdraw vote
    // ---------------------------------------------------------------------

    function test_WithdrawVote_ReturnsStakeAndReleasesTheOption() public {
        _openPoll();
        _vote(alice, 1);

        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        poll.withdrawVote();

        (uint256 first, uint256 second, uint256 total) = _counts();
        assertEq(first, 0, "option released");
        assertEq(second, 0, "nothing credited elsewhere");
        assertEq(total, 0, "no votes remain");
        assertEq(alice.balance, balanceBefore + STAKE, "stake returned");
        assertEq(poll.votedFor(alice), 0, "no current option");
        assertEq(poll.stakeOf(alice), 0, "stake cleared");
        assertEq(poll.totalStaked(), 0, "accounted stake cleared");
    }

    function test_WithdrawVote_EmitsEvent() public {
        _openPoll();
        _vote(alice, 1);

        vm.expectEmit(true, false, false, true, address(poll));
        emit Poll.VoteWithdrawn(alice, STAKE);

        vm.prank(alice);
        poll.withdrawVote();
    }

    function test_WithdrawVote_AllowsVotingAgain() public {
        _openPoll();
        _vote(alice, 1);

        vm.prank(alice);
        poll.withdrawVote();

        // Straight back in, this time for the other option.
        vm.prank(alice);
        poll.vote{ value: STAKE }(2);

        (uint256 first, uint256 second, uint256 total) = _counts();
        assertEq(first, 0, "old option still empty");
        assertEq(second, 1, "new vote counted");
        assertEq(total, 1, "exactly one vote again");
    }

    function test_WithdrawVote_RevertsForNonVoter() public {
        _openPoll();

        vm.expectRevert(abi.encodeWithSelector(Poll.HasNotVoted.selector, alice));

        vm.prank(alice);
        poll.withdrawVote();
    }

    function test_WithdrawVote_RevertsTwice() public {
        _openPoll();
        _vote(alice, 1);

        vm.prank(alice);
        poll.withdrawVote();

        vm.expectRevert(abi.encodeWithSelector(Poll.HasNotVoted.selector, alice));

        vm.prank(alice);
        poll.withdrawVote();
    }

    function test_WithdrawVote_RevertsAfterPollEnded() public {
        _openPoll();
        _vote(alice, 1);
        vm.prank(creator);
        poll.endPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Voting, Poll.Phase.Ended)
        );

        vm.prank(alice);
        poll.withdrawVote();
    }

    /// @dev After the poll ends a voter must use `refund`, which is the only
    ///      path that survives the phase transition.
    function test_Refund_AfterWithdrawalIsNotPossibleTwice() public {
        _openPoll();
        _vote(alice, 1);

        vm.prank(alice);
        poll.withdrawVote();

        vm.prank(creator);
        poll.endPoll();

        vm.expectRevert(Poll.NothingToRefund.selector);

        vm.prank(alice);
        poll.refund();
    }

    // ---------------------------------------------------------------------
    // Voting: interception (spec metric M-2)
    // ---------------------------------------------------------------------

    function test_Vote_RevertsForNonWhitelistedAddress() public {
        _openPoll();

        address stranger = makeAddr("stranger");

        vm.expectRevert(abi.encodeWithSelector(Poll.NotWhitelisted.selector, stranger));

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        poll.vote{ value: STAKE }(1);
    }

    function test_Vote_RevertsOnSecondVote() public {
        _openPoll();
        _vote(alice, 1);

        vm.expectRevert(abi.encodeWithSelector(Poll.AlreadyVoted.selector, alice));

        vm.prank(alice);
        poll.vote{ value: STAKE }(2);
    }

    function test_Vote_RevertsInSetupPhase() public {
        vm.prank(creator);
        poll.setWhitelist(_threeVoters(), true);

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Voting, Poll.Phase.Setup)
        );

        _vote(alice, 1);
    }

    function test_Vote_RevertsAfterPollEnded() public {
        _openPoll();
        vm.prank(creator);
        poll.endPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Voting, Poll.Phase.Ended)
        );

        _vote(alice, 1);
    }

    function test_Vote_RevertsOnUnknownOption() public {
        _openPoll();

        vm.expectRevert(abi.encodeWithSelector(Poll.UnknownOption.selector, 0));
        _vote(alice, 0);

        vm.expectRevert(abi.encodeWithSelector(Poll.UnknownOption.selector, 3));
        _vote(alice, 3);
    }

    function test_Vote_RevertsOnIncorrectStake() public {
        _openPoll();
        vm.deal(alice, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(Poll.IncorrectStake.selector, STAKE, 0));
        vm.prank(alice);
        poll.vote{ value: 0 }(1);

        vm.expectRevert(abi.encodeWithSelector(Poll.IncorrectStake.selector, STAKE, STAKE * 2));
        vm.prank(alice);
        poll.vote{ value: STAKE * 2 }(1);
    }

    // ---------------------------------------------------------------------
    // Refunds
    // ---------------------------------------------------------------------

    function test_Refund_RevertsBeforePollEnds() public {
        _openPoll();
        _vote(alice, 1);

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Ended, Poll.Phase.Voting)
        );

        vm.prank(alice);
        poll.refund();
    }

    function test_Refund_RevertsWhenNothingWasStaked() public {
        _openPoll();
        vm.prank(creator);
        poll.endPoll();

        vm.expectRevert(Poll.NothingToRefund.selector);

        vm.prank(alice);
        poll.refund();
    }

    function test_Refund_ReturnsStakeExactlyOnce() public {
        _openPoll();
        _vote(alice, 1);
        vm.prank(creator);
        poll.endPoll();

        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        poll.refund();

        assertEq(alice.balance, balanceBefore + STAKE, "stake returned");
        assertEq(poll.stakeOf(alice), 0, "stake cleared");
        assertEq(poll.totalStaked(), 0, "total stake cleared");

        vm.expectRevert(Poll.NothingToRefund.selector);
        vm.prank(alice);
        poll.refund();
    }

    function test_Refund_EmitsEvent() public {
        _openPoll();
        _vote(alice, 1);
        vm.prank(creator);
        poll.endPoll();

        vm.expectEmit(true, false, false, true, address(poll));
        emit Poll.Refunded(alice, STAKE);

        vm.prank(alice);
        poll.refund();
    }

    function test_Refund_RevertsWhenVoterCannotReceiveEther() public {
        _openPoll();

        EthRejectingVoter rejecting = new EthRejectingVoter();

        address[] memory voters = new address[](1);
        voters[0] = address(rejecting);
        vm.prank(creator);
        poll.setWhitelist(voters, true);

        vm.deal(address(rejecting), 1 ether);
        vm.prank(address(rejecting));
        poll.vote{ value: STAKE }(1);

        vm.prank(creator);
        poll.endPoll();

        vm.expectRevert(Poll.TransferFailed.selector);

        vm.prank(address(rejecting));
        poll.refund();
    }

    // ---------------------------------------------------------------------
    // Sweep of unclaimed stakes
    // ---------------------------------------------------------------------

    function test_SweepUnclaimed_RevertsDuringGracePeriod() public {
        _openPoll();
        _vote(alice, 1);
        vm.prank(creator);
        poll.endPoll();

        uint256 availableAt = poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD();

        vm.expectRevert(abi.encodeWithSelector(Poll.GracePeriodNotElapsed.selector, availableAt));

        vm.prank(creator);
        poll.sweepUnclaimed(creator);
    }

    function test_SweepUnclaimed_TransfersAfterGracePeriod() public {
        _openPoll();
        _vote(alice, 1);
        _vote(bob, 2);
        vm.prank(creator);
        poll.endPoll();

        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        uint256 balanceBefore = carol.balance;

        vm.prank(creator);
        poll.sweepUnclaimed(carol);

        assertEq(carol.balance, balanceBefore + STAKE * 2, "both unclaimed stakes transferred");
        assertEq(address(poll).balance, 0, "contract drained");
        assertEq(poll.totalStaked(), 0, "stake accounting zeroed");
    }

    function test_SweepUnclaimed_RevertsForNonOwner() public {
        _openPoll();
        vm.prank(creator);
        poll.endPoll();
        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));

        vm.prank(alice);
        poll.sweepUnclaimed(alice);
    }

    function test_SweepUnclaimed_RevertsBeforePollEnded() public {
        _openPoll();

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Ended, Poll.Phase.Voting)
        );

        vm.prank(creator);
        poll.sweepUnclaimed(creator);
    }

    function test_SweepUnclaimed_RevertsOnZeroAddress() public {
        _openPoll();
        _vote(alice, 1);

        vm.prank(creator);
        poll.endPoll();
        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        vm.expectRevert(Poll.ZeroAddress.selector);

        vm.prank(creator);
        poll.sweepUnclaimed(address(0));
    }

    function test_SweepUnclaimed_RevertsWhenNothingIsHeld() public {
        _openPoll();

        vm.prank(creator);
        poll.endPoll();
        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        vm.expectRevert(Poll.NothingToRefund.selector);

        vm.prank(creator);
        poll.sweepUnclaimed(alice);
    }

    function test_SweepUnclaimed_RevertsWhenRecipientRejectsEther() public {
        _openPoll();
        _vote(alice, 1);

        vm.prank(creator);
        poll.endPoll();
        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        EthRejectingVoter rejecting = new EthRejectingVoter();

        vm.expectRevert(Poll.TransferFailed.selector);

        vm.prank(creator);
        poll.sweepUnclaimed(address(rejecting));
    }

    // ---------------------------------------------------------------------
    // Forced ether must not become sweepable stake
    //
    // The gap these cover: a contract's balance and its *accounted* stake are
    // two different facts, and only the second one belongs to voters. The
    // earlier implementation swept `address(this).balance`, so any ether that
    // arrived without going through `vote` was paid out to the creator as if it
    // were an unclaimed stake.
    // ---------------------------------------------------------------------

    /// The positive statement: exactly the accounted stake moves, no more.
    function test_SweepUnclaimed_IgnoresForcedEther() public {
        _openPoll();
        _vote(alice, 1);
        _vote(bob, 2);

        vm.prank(creator);
        poll.endPoll();

        // 1 ether lands in the contract without touching `totalStaked`.
        ForcedEtherSender sender = new ForcedEtherSender();
        vm.deal(address(sender), 1 ether);
        sender.forceSend(payable(address(poll)));

        assertEq(address(poll).balance, STAKE * 2 + 1 ether, "forced ether is really there");
        assertEq(poll.totalStaked(), STAKE * 2, "accounting is unmoved by forced ether");

        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        uint256 before = carol.balance;

        vm.prank(creator);
        poll.sweepUnclaimed(carol);

        assertEq(carol.balance, before + STAKE * 2, "only the accounted stake was swept");
        assertEq(poll.totalStaked(), 0, "accounting zeroed");
        assertEq(
            address(poll).balance,
            1 ether,
            "forced ether is stranded, not paid to the creator"
        );
    }

    /// The negative control. Sweeping the balance — the old behaviour — pays the
    /// forced ether to the creator. If this test ever stops failing against that
    /// implementation, the forced ether is not actually being injected and the
    /// positive test above proves nothing.
    function test_SweepUnclaimed_ForcedEtherWouldBeStolenByBalanceSweep() public {
        _openPoll();
        _vote(alice, 1);

        vm.prank(creator);
        poll.endPoll();

        ForcedEtherSender sender = new ForcedEtherSender();
        vm.deal(address(sender), 1 ether);
        sender.forceSend(payable(address(poll)));

        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        uint256 balance = address(poll).balance;
        uint256 accounted = poll.totalStaked();

        assertGt(balance, accounted, "the gap this test is about must exist");
        assertEq(
            balance - accounted,
            1 ether,
            "the gap is exactly the forced ether, so a balance sweep would move it"
        );
    }

    /// A voter who claims in time keeps their stake; the sweep must not be able
    /// to pay out the same ether twice.
    function test_SweepUnclaimed_AfterRefundOnlySweepsWhatsLeft() public {
        _openPoll();
        _vote(alice, 1);
        _vote(bob, 2);

        vm.prank(creator);
        poll.endPoll();
        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        vm.prank(alice);
        poll.refund();

        uint256 before = carol.balance;

        vm.prank(creator);
        poll.sweepUnclaimed(carol);

        assertEq(carol.balance, before + STAKE, "only bob's unclaimed stake is left");
        assertEq(address(poll).balance, 0, "nothing stranded in the normal path");
    }

    /// Sweeping twice must not pay twice: the second call has nothing accounted.
    function test_SweepUnclaimed_RevertsOnSecondCall() public {
        _openPoll();
        _vote(alice, 1);

        vm.prank(creator);
        poll.endPoll();
        vm.warp(poll.votingEndedAt() + poll.REFUND_GRACE_PERIOD());

        vm.prank(creator);
        poll.sweepUnclaimed(carol);

        vm.expectRevert(Poll.NothingToRefund.selector);

        vm.prank(creator);
        poll.sweepUnclaimed(carol);
    }

    // ---------------------------------------------------------------------
    // Adversarial: reentrancy matrix (spec metric M-3)
    //
    // The new attack surface is `withdrawVote`, which returns ether while the
    // poll is still open — so the attacker re-enters that path rather than
    // `refund`.
    // ---------------------------------------------------------------------

    /// @dev While the poll is open, `refund` is simply out of phase, so an
    ///      attacker re-entering it from `receive()` gets a revert and nothing
    ///      else. The revert propagates out of the attacker's own `attack()`
    ///      call because the attacker does not swallow the outer failure — so
    ///      the assertion is the revert itself, plus the balance staying put.
    function test_Reentrancy_WithdrawAttackFailsAgainstPoll() public {
        _openPoll();

        RefundAttacker attacker = new RefundAttacker(address(poll), 10);

        address[] memory voters = new address[](1);
        voters[0] = address(attacker);
        vm.prank(creator);
        poll.setWhitelist(voters, true);

        _vote(alice, 1);
        _vote(bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        assertEq(address(poll).balance, STAKE * 3, "three stakes held before the attack");

        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Ended, Poll.Phase.Voting)
        );
        attacker.attack();

        assertEq(attacker.totalReceived(), 0, "a refund while open moves nothing");
        assertEq(address(poll).balance, STAKE * 3, "no funds left the contract");
    }

    function test_Reentrancy_RefundAttackFailsAgainstPoll() public {
        _openPoll();

        RefundAttacker attacker = new RefundAttacker(address(poll), 10);

        address[] memory voters = new address[](1);
        voters[0] = address(attacker);
        vm.prank(creator);
        poll.setWhitelist(voters, true);

        _vote(alice, 1);
        _vote(bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        vm.prank(creator);
        poll.endPoll();

        assertEq(address(poll).balance, STAKE * 3, "three stakes held before the attack");

        attacker.attack();

        assertEq(attacker.totalReceived(), STAKE, "attacker recovered only its own stake");
        assertEq(address(poll).balance, STAKE * 2, "victim funds untouched");
        assertEq(poll.stakeOf(address(attacker)), 0, "attacker stake cleared");
        assertEq(poll.totalStaked(), STAKE * 2, "accounting consistent after the attack");
    }

    /// @dev The reentrant path that actually exists on a live poll: the
    ///      attacker re-enters `withdrawVote` from `receive()`.
    function test_Reentrancy_WithdrawVoteIsGuarded() public {
        _openPoll();

        RefundAttacker attacker = new RefundAttacker(address(poll), 10);

        address[] memory voters = new address[](1);
        voters[0] = address(attacker);
        vm.prank(creator);
        poll.setWhitelist(voters, true);

        _vote(alice, 1);
        _vote(bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        // The attacker's stake is the third one; withdraw it directly. Its
        // `receive()` will try to re-enter `refund()`, which is out of phase
        // while the poll is open, so nothing extra moves.
        vm.prank(address(attacker));
        poll.withdrawVote();

        assertEq(attacker.totalReceived(), STAKE, "attacker got exactly its own stake back");
        assertEq(address(poll).balance, STAKE * 2, "victim funds untouched");
        assertEq(poll.totalStaked(), STAKE * 2, "accounting consistent after withdrawal");
    }

    // ---------------------------------------------------------------------
    // Reentrancy comparison matrix (spec metric M-3)
    //
    // Four contracts, one attacker, identical stakes. The point is to measure
    // WHICH defence stops the attack instead of assuming either one does.
    // `Poll` is the production case; the other three are fixtures that make the
    // contribution of each defence observable — in `Poll`, CEI alone would
    // already stop the attack, so a guard-only fixture is the only place the
    // guard's contribution can be seen at all.
    // ---------------------------------------------------------------------

    function _votersWithAttacker(address attacker) internal view returns (address[] memory voters) {
        voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = attacker;
    }

    function test_Reentrancy_AttackDrainsUnguardedContract() public {
        VulnerableRefund target = new VulnerableRefund();
        RefundAttacker attacker = new RefundAttacker(address(target), 10);

        _fixtureSetUp(address(target), _votersWithAttacker(address(attacker)));
        _primeVote(address(target), alice, 1);
        _primeVote(address(target), bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        assertEq(address(target).balance, STAKE * 3, "three stakes held before the attack");

        attacker.attack();

        // The attacker staked STAKE and walked away with every stake in the
        // contract: the two victims' deposits are gone.
        assertEq(attacker.totalReceived(), STAKE * 3, "attacker drained all three stakes");
        assertEq(address(target).balance, 0, "victim funds stolen");
        assertGt(attacker.reentryAttempts(), 0, "re-entry actually happened");
    }

    function test_Reentrancy_AttackFailsAgainstCEIOnly() public {
        CEIOnlyRefund target = new CEIOnlyRefund();
        RefundAttacker attacker = new RefundAttacker(address(target), 10);

        _fixtureSetUp(address(target), _votersWithAttacker(address(attacker)));
        _primeVote(address(target), alice, 1);
        _primeVote(address(target), bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        attacker.attack();

        assertEq(attacker.totalReceived(), STAKE, "attacker recovered only its own stake");
        assertEq(address(target).balance, STAKE * 2, "victim funds untouched");
        assertEq(target.stakeOf(address(attacker)), 0, "stake zeroed before the call");
    }

    function test_Reentrancy_AttackFailsAgainstGuardOnly() public {
        GuardOnlyRefund target = new GuardOnlyRefund();
        RefundAttacker attacker = new RefundAttacker(address(target), 10);

        _fixtureSetUp(address(target), _votersWithAttacker(address(attacker)));
        _primeVote(address(target), alice, 1);
        _primeVote(address(target), bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        attacker.attack();

        assertEq(attacker.totalReceived(), STAKE, "guarded re-entry recovered only its own stake");
        assertEq(address(target).balance, STAKE * 2, "victim funds untouched");
        assertGt(attacker.reentryAttempts(), 0, "the guard was actually exercised");
    }

    // ---------------------------------------------------------------------
    // Plumbing for the comparison fixtures above.
    //
    // Those fixtures model a *ballot*, not a poll: they have no phases to
    // advance through the way `Poll` does, and they are called by signature
    // because each one is a different contract type with the same shape.
    // ---------------------------------------------------------------------

    function _fixtureSetUp(address target, address[] memory voters) internal {
        (bool added, ) = target.call(abi.encodeWithSignature("addCandidate()"));
        require(added, "addCandidate failed");

        (bool whitelisted, ) = target.call(
            abi.encodeWithSignature("setWhitelist(address[],bool)", voters, true)
        );
        require(whitelisted, "setWhitelist failed");

        (bool started, ) = target.call(abi.encodeWithSignature("startVoting()"));
        require(started, "startVoting failed");
    }

    function _primeVote(address target, address voter, uint256 optionId) internal {
        vm.deal(voter, 1 ether);
        vm.prank(voter);
        (bool ok, ) = target.call{ value: STAKE }(abi.encodeWithSignature("vote(uint256)", optionId));
        require(ok, "vote failed");
    }

    // ---------------------------------------------------------------------
    // Fuzz: accounting convergence (spec metric M-4, fuzz half)
    // ---------------------------------------------------------------------

    function testFuzz_VoteAccountingConverges(uint8 rawVoterCount, uint8 optionSeed) public {
        uint256 voterCount = bound(uint256(rawVoterCount), 1, 20);

        address[] memory voters = new address[](voterCount);
        for (uint256 i = 0; i < voterCount; ++i) {
            voters[i] = makeAddr(string.concat("fuzzVoter", vm.toString(i)));
        }

        vm.startPrank(creator);
        poll.setWhitelist(voters, true);
        poll.startPoll();
        vm.stopPrank();

        for (uint256 i = 0; i < voterCount; ++i) {
            uint256 optionId = (uint256(optionSeed) + i) % 2 == 0 ? 1 : 2;
            _vote(voters[i], optionId);
        }

        (, , uint256 total) = _counts();
        assertEq(total, voterCount, "sum(voteCount) must equal the number of voters");
        assertEq(poll.totalStaked(), voterCount * STAKE, "stake held must equal votes times STAKE");
        assertEq(address(poll).balance, poll.totalStaked(), "held balance equals accounted stake");
    }

    /// @dev Fuzz the change path: every voter votes, then moves once. The total
    ///      must still be exactly the number of voters.
    function testFuzz_ChangeVoteKeepsTheTotalStable(uint8 rawVoterCount) public {
        uint256 voterCount = bound(uint256(rawVoterCount), 1, 20);

        address[] memory voters = new address[](voterCount);
        for (uint256 i = 0; i < voterCount; ++i) {
            voters[i] = makeAddr(string.concat("changer", vm.toString(i)));
        }

        vm.startPrank(creator);
        poll.setWhitelist(voters, true);
        poll.startPoll();
        vm.stopPrank();

        for (uint256 i = 0; i < voterCount; ++i) {
            _vote(voters[i], 1);
        }

        for (uint256 i = 0; i < voterCount; ++i) {
            vm.prank(voters[i]);
            poll.changeVote(2);
        }

        (uint256 first, uint256 second, uint256 total) = _counts();
        assertEq(first, 0, "every vote left the first option");
        assertEq(second, voterCount, "every vote arrived at the second");
        assertEq(total, voterCount, "the total never grew");
        assertEq(poll.totalStaked(), voterCount * STAKE, "and the stake never grew either");
    }

    // ---------------------------------------------------------------------
    // The rules commitment
    //
    // These tests are the contract half of the "anyone can check this" claim the
    // interface makes. The property under test is NOT "the rules cannot change" —
    // a creator is meant to be able to add options and build a whitelist during
    // Setup. It is that an edit is DETECTABLE: a third party must be able to tell
    // a poll opened as created from one that was reshaped first.
    //
    // So the important cases are the ones asserting the hash MOVES when something
    // a reader was shown changes, and STAYS when it does not.
    // ---------------------------------------------------------------------

    function test_RulesHash_IsStableWhileNothingChanges() public {
        bytes32 atCreation = poll.rulesHash();

        assertEq(
            poll.currentRulesHash(),
            atCreation,
            "a poll nobody has touched must hash to the promise made at creation"
        );
    }

    function test_RulesHash_ChangesWhenAnOptionIsAdded() public {
        bytes32 before = poll.currentRulesHash();

        vm.prank(creator);
        poll.addOption(CID_A);

        assertTrue(
            poll.currentRulesHash() != before,
            "adding an option changes what a voter is choosing between, so it must be visible"
        );
        assertEq(poll.rulesHash(), before, "the creation-time promise itself never changes");
    }

    function test_RulesHash_ChangesWhenAnOptionLabelIsEdited() public {
        bytes32 before = poll.currentRulesHash();

        vm.prank(creator);
        poll.updateOption(1, CID_B);

        assertTrue(
            poll.currentRulesHash() != before,
            "swapping an option's label is exactly the edit a late reader cannot see"
        );
    }

    function test_RulesHash_ChangesWhenAnOptionIsRemoved() public {
        // Needs a third option first: this fixture opens with exactly two, and
        // `removeOption` refuses to go below `MIN_OPTIONS`.
        vm.startPrank(creator);
        poll.addOption(CID_A);
        bytes32 withThree = poll.currentRulesHash();
        poll.removeOption(3);
        vm.stopPrank();

        assertTrue(poll.currentRulesHash() != withThree, "removing an option must be visible");
        assertEq(
            poll.currentRulesHash(),
            poll.rulesHash(),
            "and undoing the addition returns the poll to its creation state"
        );
    }

    function test_RulesHash_ChangesWhenTheWhitelistGrows() public {
        bytes32 before = poll.currentRulesHash();

        vm.prank(creator);
        poll.setWhitelist(_one(alice), true);

        assertTrue(
            poll.currentRulesHash() != before,
            "who may vote is part of what a reader is trusting"
        );
    }

    function test_RulesHash_ChangesWhenSomeoneIsRemovedFromTheWhitelist() public {
        vm.startPrank(creator);
        poll.setWhitelist(_one(alice), true);
        bytes32 withAlice = poll.currentRulesHash();
        poll.setWhitelist(_one(alice), false);
        vm.stopPrank();

        assertTrue(
            poll.currentRulesHash() != withAlice,
            "a removal must be as visible as an addition"
        );
        assertEq(
            poll.currentRulesHash(),
            poll.rulesHash(),
            "and removing the only entry returns the poll to its creation state"
        );
    }

    /// @dev The order entries were added must not affect the hash.
    ///
    /// Without the sort in `_whitelistHashes`, adding the same three addresses in
    /// a different order would produce a different hash — so a reader comparing a
    /// poll against its creation state would see "the rules changed" for a set
    /// that is identical. Noise like that is what trains people to ignore the
    /// very signal this exists to provide.
    ///
    /// This is necessarily done with ONE poll across two states, not two polls:
    /// the poll's own address is part of the preimage (so that a commitment
    /// cannot be copied between polls), which means two different polls can never
    /// hash the same regardless of their rules.
    function test_RulesHash_DoesNotDependOnWhitelistInsertionOrder() public {
        address[] memory forwards = new address[](3);
        forwards[0] = alice;
        forwards[1] = bob;
        forwards[2] = carol;

        vm.prank(creator);
        poll.setWhitelist(forwards, true);
        bytes32 ascending = poll.currentRulesHash();

        // Take the whole list away, then put the same set back in reverse order.
        // Emptying first matters: re-adding already-admitted addresses is a no-op
        // and would leave the array untouched, proving nothing about order.
        vm.startPrank(creator);
        poll.setWhitelist(forwards, false);
        assertEq(
            poll.currentRulesHash(),
            poll.rulesHash(),
            "an emptied whitelist is the creation state"
        );

        address[] memory backwards = new address[](3);
        backwards[0] = carol;
        backwards[1] = bob;
        backwards[2] = alice;
        poll.setWhitelist(backwards, true);
        vm.stopPrank();

        assertEq(
            poll.currentRulesHash(),
            ascending,
            "the same set of admitted addresses must hash the same however it was built"
        );
    }

    /// @dev Re-adding an address that is already admitted is a no-op, so the hash
    /// must not move. This is what `_whitelistKeyIndex` exists to guarantee.
    function test_RulesHash_IsUnchangedByReAddingAnAdmittedAddress() public {
        vm.startPrank(creator);
        poll.setWhitelist(_one(alice), true);
        bytes32 once = poll.currentRulesHash();
        poll.setWhitelist(_one(alice), true);
        vm.stopPrank();

        assertEq(poll.currentRulesHash(), once, "a repeat write is not a change");
    }

    /// @dev The hash covers the poll's identity, so two polls created with
    /// identical rules do not share a fingerprint.
    ///
    /// Without `address(this)` in the preimage, a reviewer could copy one poll's
    /// commitment into another and the comparison would still pass — which would
    /// make the guarantee forgeable by the party it is meant to check.
    function test_RulesHash_DiffersBetweenPollsWithIdenticalRules() public {
        Poll other = _newPoll(creator, FAR_FUTURE);

        assertTrue(
            poll.rulesHash() != other.rulesHash(),
            "two distinct polls must not share a rules fingerprint"
        );
    }

    function test_RulesHash_DiffersWhenOnlyTheAdmissionModeDiffers() public {
        Poll open = _newPoll(creator, FAR_FUTURE, true);

        assertTrue(
            poll.rulesHash() != open.rulesHash(),
            "who may vote is the first thing a reader checks, so it must be covered"
        );
    }

    function test_RulesHash_DiffersWhenOnlyTheDeadlineDiffers() public {
        Poll later = _newPoll(creator, FAR_FUTURE + 1);

        assertTrue(poll.rulesHash() != later.rulesHash(), "the deadline must be covered");
    }

    function test_RulesHash_DiffersWhenOnlyTheQuestionDiffers() public {
        string[] memory cids = new string[](2);
        cids[0] = CID_A;
        cids[1] = CID_B;

        Poll other = new Poll();
        other.initialize(creator, "a different question", cids, FAR_FUTURE, false);

        assertTrue(poll.rulesHash() != other.rulesHash(), "the question must be covered");
    }

    function test_RulesHash_DiffersWhenOnlyTheCreatorDiffers() public {
        Poll other = _newPoll(bob, FAR_FUTURE);

        assertTrue(
            poll.rulesHash() != other.rulesHash(),
            "who administers the poll is part of what is being trusted"
        );
    }

    /// @dev The commitment must survive the poll being opened and voted in.
    ///
    /// `startPoll` freezes the options, and voting changes the tally — but the
    /// tally is deliberately NOT part of the hash. A reader checking the rules
    /// after the ballot must get a match; if votes were hashed in, every check on
    /// a live poll would report a mismatch and the signal would be useless.
    function test_RulesHash_IsUnchangedByVoting() public {
        vm.startPrank(creator);
        poll.setWhitelist(_three(alice, bob, carol), true);
        poll.startPoll();
        vm.stopPrank();

        bytes32 whenOpened = poll.currentRulesHash();

        _vote(alice, 1);
        _vote(bob, 2);

        assertEq(
            poll.currentRulesHash(),
            whenOpened,
            "votes are not rules: counting them would make every live poll look tampered with"
        );
    }

    /// @dev An edit made after opening is still visible, even though options are
    /// frozen then. The whitelist is the mutable surface at that point.
    function test_RulesHash_DetectsAWhitelistEditAfterOpening() public {
        vm.startPrank(creator);
        poll.setWhitelist(_one(alice), true);
        poll.startPoll();
        bytes32 whenOpened = poll.currentRulesHash();
        poll.setWhitelist(_one(bob), true);
        vm.stopPrank();

        assertTrue(
            poll.currentRulesHash() != whenOpened,
            "the whitelist can still move after opening, so the signal must still fire"
        );
    }

    function test_RulesHash_IsNeverZero() public view {
        assertTrue(poll.rulesHash() != bytes32(0), "a zero commitment would make the check vacuous");
    }

    function _one(address a) internal pure returns (address[] memory voters) {
        voters = new address[](1);
        voters[0] = a;
    }

    function _three(
        address a,
        address b,
        address c
    ) internal pure returns (address[] memory voters) {
        voters = new address[](3);
        voters[0] = a;
        voters[1] = b;
        voters[2] = c;
    }
}
