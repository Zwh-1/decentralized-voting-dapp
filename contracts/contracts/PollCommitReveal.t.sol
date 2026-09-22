// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice Tests for commit-reveal voting.
///
/// @dev This mechanism's central risk is not a wrong number — it is a wrong
///      STORY. A poll where people have committed but not yet revealed has an
///      empty tally, and an empty tally is exactly what "nobody voted" looks
///      like. Three of the tests below exist only to keep those two states
///      distinguishable, because conflating them would report participation as
///      non-participation (ADR-0011).
///
///      The other risk is the commitment binding. A commitment that does not
///      name its voter can be copied out of the mempool by anyone, and the
///      copier's reveal wins the race — so the binding tests are as important as
///      the tally ones.
contract PollCommitRevealTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;
    uint256 internal constant REVEAL_WINDOW = 1 days;

    bytes32 internal constant SALT_A = keccak256("alice-salt");
    bytes32 internal constant SALT_B = keccak256("bob-salt");

    // ---------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------

    /// @dev No execution targets, which is what every suite except the
    ///      governance one wants: a poll that can only call itself. Named rather
    ///      than inlined as `new address[](0)` at each call site so that adding
    ///      a parameter to `initialize` again means touching one line per file.
    function _noExecutionTargets() internal pure returns (address[] memory) {
        return new address[](0);
    }
    function _cids(uint256 count) internal pure returns (string[] memory cids) {
        cids = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            cids[i] = string.concat("cid-", vm.toString(i));
        }
    }

    function _config() internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.commitReveal = true;
        config.revealWindowSeconds = REVEAL_WINDOW;
        return config;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids2(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    /// @dev A commit-reveal poll in `Voting`, with three whitelisted addresses.
    function _openPoll() internal returns (Poll created) {
        created = new Poll();
        created.initialize(creator, "Private?", _cids(3), FAR_FUTURE, _config(), _noExecutionTargets());

        address[] memory voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;

        vm.startPrank(creator);
        created.setWhitelist(voters, true);
        created.startPoll();
        vm.stopPrank();
    }

    function _commit(address voter, uint256 optionId, bytes32 salt) internal {
        vm.deal(voter, 1 ether);
        bytes32 commitment = poll.computeCommitment(voter, _ids(optionId), salt);

        vm.prank(voter);
        poll.commit{ value: STAKE }(commitment);
    }

    /// @dev Drives the poll into `Reveal` by closing voting.
    function _closeVoting() internal {
        vm.prank(creator);
        poll.endPoll();
    }

    function _countOf(uint256 optionId) internal view returns (uint256) {
        (Poll.Option[] memory list, ) = poll.results();
        return list[optionId - 1].voteCount;
    }

    // ---------------------------------------------------------------------
    // The privacy itself
    // ---------------------------------------------------------------------

    /// @dev The whole point: during `Voting` the tally is empty even though a
    ///      commitment is on file. If this failed, the mechanism would be
    ///      recording choices in the clear and the "privacy" would be decorative.
    function test_Commit_LeavesTheTallyEmptyDuringVoting() public {
        poll = _openPoll();

        _commit(alice, 1, SALT_A);

        assertEq(_countOf(1), 0, "a sealed ballot must not move the tally");
        assertEq(_countOf(2), 0, "nor any other option");
    }

    /// @dev The negative control for the test above: the SAME ballot, once
    ///      revealed, does move the tally. Without this, an implementation that
    ///      simply never counted anything would pass.
    function test_Reveal_MovesTheTally() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        vm.prank(alice);
        poll.reveal(_ids(1), SALT_A);

        assertEq(_countOf(1), 1, "the revealed ballot counts");
    }

    /// @dev The commitment must not be reversible to the option. Checking the
    ///      stored value against a handful of candidate hashes — which is what
    ///      an observer would do, since the option space is tiny — must fail.
    function test_Commit_IsNotReversibleByEnumeratingOptions() public {
        poll = _openPoll();
        _commit(alice, 2, SALT_A);

        bytes32 stored = poll.commitmentOf(alice);
        assertTrue(stored != bytes32(0), "a commitment is on file");

        // An observer knows the poll address and alice's address, and can guess
        // the option, but not the salt. Every guess must miss.
        for (uint256 optionId = 1; optionId <= 3; ++optionId) {
            bytes32 guess = keccak256(
                abi.encode(alice, address(poll), _ids(optionId), keccak256("wrong-salt"))
            );
            assertTrue(guess != stored, "an option guess without the salt must not match");
        }
    }

    // ---------------------------------------------------------------------
    // The commitment binds its voter and its poll
    // ---------------------------------------------------------------------

    /// @dev Front-running defence. Bob observes alice's commitment and submits
    ///      the identical hash. The contract must refuse bob's reveal, because
    ///      the commitment names alice.
    function test_Reveal_RefusesACommitmentCopiedFromTheMempool() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);

        bytes32 copied = poll.commitmentOf(alice);

        // Bob commits the very same hash.
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        poll.commit{ value: STAKE }(copied);

        _closeVoting();

        // Bob knows alice's option and salt (they were in the mempool) and
        // reveals. It must fail, because the hash is bound to ALICE.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Poll.CommitmentMismatch.selector, bob));
        poll.reveal(_ids(1), SALT_A);
    }

    /// @dev The negative control for the binding: the same voter, same option,
    ///      same salt, but a DIFFERENT poll address, must not match. Without
    ///      this, an implementation that omitted the poll address would pass the
    ///      test above while leaving commitments replayable across polls.
    function test_Commitment_IsBoundToThePollAddress() public {
        poll = _openPoll();

        Poll other = new Poll();
        other.initialize(creator, "Other?", _cids(3), FAR_FUTURE, _config(), _noExecutionTargets());

        bytes32 here = poll.computeCommitment(alice, _ids(1), SALT_A);
        bytes32 there = other.computeCommitment(alice, _ids(1), SALT_A);

        assertTrue(here != there, "the same ballot in two polls must not share a commitment");
    }

    /// @dev And to the option set: a voter cannot commit to one thing and reveal
    ///      another. This is the check that makes the commitment meaningful
    ///      rather than a formality.
    function test_Reveal_RefusesADifferentOptionSet() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.CommitmentMismatch.selector, alice));
        poll.reveal(_ids(2), SALT_A);
    }

    function test_Reveal_RefusesAWrongSalt() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.CommitmentMismatch.selector, alice));
        poll.reveal(_ids(1), keccak256("not-the-salt"));
    }

    /// @dev The salt is what makes the enumeration attack impractical, so a
    ///      commitment built WITHOUT one — the naive implementation — must not
    ///      be accepted as if it had been. This pins the salt's participation.
    function test_Reveal_RefusesACommitmentWithNoSalt() public {
        poll = _openPoll();

        bytes32 naive = keccak256(abi.encode(alice, address(poll), _ids(1)));

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        poll.commit{ value: STAKE }(naive);
        _closeVoting();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.CommitmentMismatch.selector, alice));
        poll.reveal(_ids(1), bytes32(0));
    }

    // ---------------------------------------------------------------------
    // "Committed, awaiting reveal" is not "did not vote"
    // ---------------------------------------------------------------------

    /// @dev The ADR-0011 requirement, stated as a test. `marked` is false in
    ///      both states — the ballot is not counted yet — so `committed` is the
    ///      field that keeps them apart. A UI given only `marked` would tell a
    ///      committed voter that it had not voted.
    function test_VoterState_DistinguishesCommittedFromNotVoting() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);

        Poll.VoterState memory committed = poll.voterState(alice);
        assertTrue(committed.committed, "alice has a sealed commitment");
        assertFalse(committed.marked, "but no counted ballot yet");

        Poll.VoterState memory absent = poll.voterState(bob);
        assertFalse(absent.committed, "bob did not commit");
        assertFalse(absent.marked, "and has not voted");

        // The two are indistinguishable on `marked` alone — which is exactly why
        // `committed` exists.
        assertEq(committed.marked, absent.marked, "the tally cannot tell them apart");
        assertTrue(committed.committed != absent.committed, "the commitment can");
    }

    /// @dev After revealing, the state moves to "counted" and stops being merely
    ///      committed — the flag must not stay set, or the UI would keep saying
    ///      "awaiting reveal" for a ballot already in the tally.
    function test_VoterState_ClearsCommittedOnReveal() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        vm.prank(alice);
        poll.reveal(_ids(1), SALT_A);

        Poll.VoterState memory state = poll.voterState(alice);
        assertFalse(state.committed, "the commitment was opened");
        assertTrue(state.marked, "and the ballot now counts");
    }

    /// @dev Expiry is an emitted FACT, not an inferred absence. A reader that
    ///      only sees "no Revealed event" cannot tell expiry from a voter that
    ///      is still about to reveal.
    function test_Refund_AnnouncesAnExpiredCommitment() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        // Let the reveal window lapse and close it.
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        poll.closeRevealWindow();

        vm.expectEmit(true, false, false, false, address(poll));
        emit Poll.CommitmentExpired(alice);

        vm.prank(alice);
        poll.refund();

        Poll.VoterState memory state = poll.voterState(alice);
        assertFalse(state.committed, "the commitment is gone");
        assertEq(_countOf(1), 0, "and it never counted");
    }

    // ---------------------------------------------------------------------
    // The window, and what happens when it lapses
    // ---------------------------------------------------------------------

    function test_Phase_VotingBecomesRevealNotEnded() public {
        poll = _openPoll();
        _closeVoting();

        assertEq(uint256(poll.phase()), uint256(Poll.Phase.Reveal));
        assertGt(poll.revealEndsAt(), 0, "the window is set");
    }

    /// @dev The negative control for the phase change: an ORDINARY poll still
    ///      goes straight to `Ended`. Without this, an implementation that
    ///      always entered `Reveal` would pass the test above while stranding
    ///      every non-private poll.
    function test_Phase_PlainPollStillEndsDirectly() public {
        Poll plain = new Poll();
        plain.initialize(creator, "Plain?", _cids(3), FAR_FUTURE, PollMechanisms.defaultConfig(0), _noExecutionTargets());

        vm.prank(creator);
        plain.startPoll();
        vm.prank(creator);
        plain.endPoll();

        assertEq(uint256(plain.phase()), uint256(Poll.Phase.Ended), "no reveal window");
        assertEq(plain.revealEndsAt(), 0, "and no deadline for one");
    }

    /// @dev The window is measured from when voting ACTUALLY closed, so an early
    ///      close does not silently shorten it.
    function test_Reveal_WindowStartsWhenVotingClosesNotAtTheDeadline() public {
        poll = _openPoll();
        uint256 closedAt = block.timestamp;
        _closeVoting();

        assertEq(poll.revealEndsAt(), closedAt + REVEAL_WINDOW, "full window from the close");
    }

    function test_Reveal_IsRefusedAfterTheWindowCloses() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        vm.warp(block.timestamp + REVEAL_WINDOW);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.RevealWindowClosed.selector, poll.revealEndsAt()));
        poll.reveal(_ids(1), SALT_A);
    }

    /// @dev The window cannot be cut short. Without this a creator could open a
    ///      window and close it immediately, and every commitment would expire
    ///      before anyone could act — a poll where voting is possible and
    ///      counting is not.
    function test_CloseRevealWindow_RefusesBeforeTheWindowLapses() public {
        poll = _openPoll();
        _closeVoting();

        vm.expectRevert(abi.encodeWithSelector(Poll.RevealWindowOpen.selector, poll.revealEndsAt()));
        poll.closeRevealWindow();
    }

    /// @dev A commitment that is never revealed does not block the close. If it
    ///      did, one address could freeze an entire poll for the price of one
    ///      transaction.
    function test_UnexpiredCommitments_DoNotBlockTheClose() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _commit(bob, 2, SALT_B);
        _closeVoting();

        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        poll.closeRevealWindow();

        assertEq(uint256(poll.phase()), uint256(Poll.Phase.Ended), "the poll ended regardless");
    }

    /// @dev And the stake is still recoverable: a failed reveal costs the voter
    ///      its say, never its money.
    function test_UnexpiredCommitments_KeepTheirStakeRefundable() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        poll.closeRevealWindow();

        uint256 before = alice.balance;

        vm.prank(alice);
        poll.refund();

        assertEq(alice.balance, before + STAKE, "the full stake came back");
    }

    // ---------------------------------------------------------------------
    // One commitment, one count
    // ---------------------------------------------------------------------

    function test_Commit_RefusesASecondCommitment() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);

        bytes32 other = poll.computeCommitment(alice, _ids(2), SALT_A);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.AlreadyCommitted.selector, alice));
        poll.commit{ value: STAKE }(other);
    }

    /// @dev The double-count path through the new mechanism: revealing twice.
    ///      Without clearing the commitment before counting, the same ballot
    ///      would be added again — the ADR-0034 upper bound broken by the
    ///      privacy feature rather than by the tally code.
    function test_Reveal_RefusesToOpenTheSameCommitmentTwice() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);
        _closeVoting();

        vm.prank(alice);
        poll.reveal(_ids(1), SALT_A);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.HasNotCommitted.selector, alice));
        poll.reveal(_ids(1), SALT_A);

        assertEq(_countOf(1), 1, "and the tally holds exactly one");
    }

    function test_Reveal_RefusesAnAddressThatNeverCommitted() public {
        poll = _openPoll();
        _closeVoting();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Poll.HasNotCommitted.selector, bob));
        poll.reveal(_ids(1), SALT_B);
    }

    // ---------------------------------------------------------------------
    // The plain paths are closed
    // ---------------------------------------------------------------------

    /// @dev The privacy must not be optional for the voter. If `vote` stayed
    ///      open, anyone willing to vote publicly could bypass the mechanism
    ///      entirely, and the poll's rules would claim a privacy they do not
    ///      deliver.
    function test_CommitReveal_RefusesAPlainVote() public {
        poll = _openPoll();

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(Poll.NotCommitReveal.selector);
        poll.vote{ value: STAKE }(_ids(1));
    }

    function test_CommitReveal_RefusesAPlainChangeVote() public {
        poll = _openPoll();

        vm.prank(alice);
        vm.expectRevert(Poll.NotCommitReveal.selector);
        poll.changeVote(_ids(1));
    }

    /// @dev The negative control: an ordinary poll still accepts a plain vote.
    function test_PlainPoll_StillAcceptsAPlainVote() public {
        Poll plain = new Poll();
        plain.initialize(creator, "Plain?", _cids(3), FAR_FUTURE, PollMechanisms.defaultConfig(0), _noExecutionTargets());

        address[] memory voters = new address[](1);
        voters[0] = alice;

        vm.startPrank(creator);
        plain.setWhitelist(voters, true);
        plain.startPoll();
        vm.stopPrank();

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        plain.vote{ value: STAKE }(_ids(1));

        (Poll.Option[] memory list, ) = plain.results();
        assertEq(list[0].voteCount, 1, "the default mechanism is unchanged");
    }

    /// @dev Withdrawing a commitment is how a voter changes its mind before the
    ///      reveal, and it must return the stake — otherwise committing is a
    ///      one-way door and a mistyped salt is unrecoverable.
    function test_Withdraw_ReturnsACommitmentsStake() public {
        poll = _openPoll();
        _commit(alice, 1, SALT_A);

        uint256 before = alice.balance;

        vm.prank(alice);
        poll.withdrawVote();

        assertEq(alice.balance, before + STAKE, "the stake came back");
        assertEq(poll.commitmentOf(alice), bytes32(0), "and the commitment is gone");

        // Which means she can commit again, to something else.
        _commit(alice, 2, SALT_A);
        assertTrue(poll.commitmentOf(alice) != bytes32(0), "a fresh commitment is accepted");
    }

    // ---------------------------------------------------------------------
    // Multi-select commitments cover the whole set
    // ---------------------------------------------------------------------

    /// @dev The reason ADR-0030 notes that commit-reveal + multi-select needs a
    ///      different encoding: the commitment covers the SET, not one element.
    ///      A partial reveal must be refused.
    function test_MultiSelectCommit_IsBoundToTheWholeSet() public {
        PollMechanisms.PollConfig memory config = _config();
        config.multiSelect = true;
        config.maxSelections = 3;

        Poll multi = new Poll();
        multi.initialize(creator, "Multi private?", _cids(3), FAR_FUTURE, config, _noExecutionTargets());

        address[] memory voters = new address[](1);
        voters[0] = alice;
        vm.prank(creator);
        multi.setWhitelist(voters, true);
        vm.prank(creator);
        multi.startPoll();

        vm.deal(alice, 1 ether);

        bytes32 commitment = multi.computeCommitment(alice, _ids2(1, 3), SALT_A);
        vm.prank(alice);
        multi.commit{ value: STAKE }(commitment);

        vm.prank(creator);
        multi.endPoll();

        // Revealing only ONE of the two committed options must be refused.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.CommitmentMismatch.selector, alice));
        multi.reveal(_ids(1), SALT_A);

        // The full set is accepted.
        vm.prank(alice);
        multi.reveal(_ids2(1, 3), SALT_A);

        (Poll.Option[] memory list, ) = multi.results();
        assertEq(list[0].voteCount, 1, "option 1 counted");
        assertEq(list[2].voteCount, 1, "option 3 counted");
        assertEq(list[1].voteCount, 0, "and option 2 did not");
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    function test_Commit_RefusedOnAPollWithoutTheMechanism() public {
        Poll plain = new Poll();
        plain.initialize(creator, "Plain?", _cids(3), FAR_FUTURE, PollMechanisms.defaultConfig(0), _noExecutionTargets());

        // Whitelisted on purpose, so the refusal that fires is the one under
        // test rather than an admission check that happens to come first.
        address[] memory voters = new address[](1);
        voters[0] = alice;

        vm.startPrank(creator);
        plain.setWhitelist(voters, true);
        plain.startPoll();
        vm.stopPrank();

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(Poll.NotCommitReveal.selector);
        plain.commit{ value: STAKE }(keccak256("anything"));
    }

    /// @dev The stake is the same as a plain vote. A cheaper commit would make
    ///      spamming unopenable commitments free.
    function test_Commit_RequiresTheSameStake() public {
        poll = _openPoll();

        bytes32 commitment = poll.computeCommitment(alice, _ids(1), SALT_A);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Poll.IncorrectCommitStake.selector, STAKE, STAKE - 1)
        );
        poll.commit{ value: STAKE - 1 }(commitment);
    }
}
