// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { Voting } from "./Voting.sol";
import { CEIOnlyRefund } from "./test/CEIOnlyRefund.sol";
import { EthRejectingVoter } from "./test/EthRejectingVoter.sol";
import { GuardOnlyRefund } from "./test/GuardOnlyRefund.sol";
import { RefundAttacker } from "./test/RefundAttacker.sol";
import { VulnerableRefund } from "./test/VulnerableRefund.sol";

/// @notice Unit, fuzz, and adversarial tests for `Voting`.
/// @dev Evidence for spec metrics M-2 (authorisation interception) and
///      M-3 (reentrancy attack/defence matrix).
contract VotingTest is Test {
    Voting internal voting;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant STAKE = 0.001 ether;
    string internal constant CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    string internal constant CID_B = "bafkreieq5jui4j25lacwomsqgvn7mq3z4g4hq7xw774wevxfrfrura3jqq";

    function setUp() public {
        voting = new Voting(admin);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _threeVoters() internal view returns (address[] memory voters) {
        voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;
    }

    /// @dev Setup + two candidates + three whitelisted voters + ballot open.
    function _openBallot() internal {
        vm.startPrank(admin);
        voting.addCandidate(CID_A);
        voting.addCandidate(CID_B);
        voting.setWhitelist(_threeVoters(), true);
        voting.startVoting();
        vm.stopPrank();
    }

    function _vote(address voter, uint256 candidateId) internal {
        vm.deal(voter, 1 ether);
        vm.prank(voter);
        voting.vote{ value: STAKE }(candidateId);
    }

    // ---------------------------------------------------------------------
    // Deployment and admin surface
    // ---------------------------------------------------------------------

    function test_Constructor_SetsOwnerAndSetupPhase() public view {
        assertEq(voting.owner(), admin, "deployer must be the owner");
        assertEq(uint256(voting.phase()), uint256(Voting.Phase.Setup), "must start in Setup");
        assertEq(voting.candidateCount(), 0, "no candidates initially");
    }

    function test_AddCandidate_AssignsSequentialOneBasedIds() public {
        vm.startPrank(admin);
        voting.addCandidate(CID_A);
        voting.addCandidate(CID_B);
        vm.stopPrank();

        assertEq(voting.candidateCount(), 2, "two candidates registered");
        assertEq(voting.candidateCID(1), CID_A, "id 1 maps to the first CID");
        assertEq(voting.candidateCID(2), CID_B, "id 2 maps to the second CID");
    }

    function test_AddCandidate_EmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(voting));
        emit Voting.CandidateAdded(1, CID_A);

        vm.prank(admin);
        voting.addCandidate(CID_A);
    }

    function test_AddCandidate_RevertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));

        vm.prank(alice);
        voting.addCandidate(CID_A);
    }

    function test_AddCandidate_RevertsOutsideSetupPhase() public {
        _openBallot();

        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Setup, Voting.Phase.Voting)
        );

        vm.prank(admin);
        voting.addCandidate(CID_A);
    }

    function test_StartVoting_RevertsWithoutCandidates() public {
        vm.expectRevert(Voting.NoCandidates.selector);

        vm.prank(admin);
        voting.startVoting();
    }

    function test_EndVoting_RecordsTimestampAndTransitionsPhase() public {
        _openBallot();

        vm.warp(1_800_000_000);

        vm.prank(admin);
        voting.endVoting();

        assertEq(uint256(voting.phase()), uint256(Voting.Phase.Ended), "phase must be Ended");
        assertEq(voting.votingEndedAt(), 1_800_000_000, "end timestamp recorded");
    }

    function test_EndVoting_RevertsWhenNotVoting() public {
        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Voting, Voting.Phase.Setup)
        );

        vm.prank(admin);
        voting.endVoting();
    }

    // ---------------------------------------------------------------------
    // Whitelist
    // ---------------------------------------------------------------------

    function test_SetWhitelist_AddsAndRemoves() public {
        address[] memory voters = _threeVoters();

        vm.prank(admin);
        voting.setWhitelist(voters, true);
        assertTrue(voting.isWhitelisted(alice), "alice whitelisted");

        vm.prank(admin);
        voting.setWhitelist(voters, false);
        assertFalse(voting.isWhitelisted(alice), "alice revoked");
    }

    function test_SetWhitelist_RevertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));

        vm.prank(bob);
        voting.setWhitelist(_threeVoters(), true);
    }

    function test_SetWhitelist_RevertsOnZeroAddress() public {
        address[] memory voters = new address[](1);
        voters[0] = address(0);

        vm.expectRevert(Voting.ZeroAddress.selector);

        vm.prank(admin);
        voting.setWhitelist(voters, true);
    }

    function test_SetWhitelist_RevertsAfterVotingEnded() public {
        _openBallot();
        vm.prank(admin);
        voting.endVoting();

        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Voting, Voting.Phase.Ended)
        );

        vm.prank(admin);
        voting.setWhitelist(_threeVoters(), false);
    }

    // ---------------------------------------------------------------------
    // Voting: happy path
    // ---------------------------------------------------------------------

    function test_Vote_RecordsVoteAndStake() public {
        _openBallot();
        _vote(alice, 1);

        assertTrue(voting.hasVoted(alice), "hasVoted flag set");
        assertEq(voting.votedFor(alice), 1, "candidate recorded");
        assertEq(voting.stakeOf(alice), STAKE, "stake recorded");
        assertEq(voting.totalStaked(), STAKE, "total stake accounted");

        (Voting.Candidate[] memory list, uint256 total) = voting.results();
        assertEq(list[0].voteCount, 1, "candidate 1 has one vote");
        assertEq(list[1].voteCount, 0, "candidate 2 has none");
        assertEq(total, 1, "total is one");
    }

    function test_Vote_EmitsEventWithRunningCount() public {
        _openBallot();
        _vote(alice, 1);

        vm.expectEmit(true, true, false, true, address(voting));
        emit Voting.VoteCast(bob, 1, 2);

        _vote(bob, 1);
    }

    // ---------------------------------------------------------------------
    // Voting: interception (spec metric M-2)
    // ---------------------------------------------------------------------

    function test_Vote_RevertsForNonWhitelistedAddress() public {
        _openBallot();

        address stranger = makeAddr("stranger");

        vm.expectRevert(abi.encodeWithSelector(Voting.NotWhitelisted.selector, stranger));

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        voting.vote{ value: STAKE }(1);
    }

    function test_Vote_RevertsOnDoubleVote() public {
        _openBallot();
        _vote(alice, 1);

        vm.expectRevert(abi.encodeWithSelector(Voting.AlreadyVoted.selector, alice));

        vm.prank(alice);
        voting.vote{ value: STAKE }(2);
    }

    function test_Vote_RevertsInSetupPhase() public {
        vm.startPrank(admin);
        voting.addCandidate(CID_A);
        voting.setWhitelist(_threeVoters(), true);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Voting, Voting.Phase.Setup)
        );

        _vote(alice, 1);
    }

    function test_Vote_RevertsAfterVotingEnded() public {
        _openBallot();
        vm.prank(admin);
        voting.endVoting();

        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Voting, Voting.Phase.Ended)
        );

        _vote(alice, 1);
    }

    function test_Vote_RevertsOnUnknownCandidate() public {
        _openBallot();

        vm.expectRevert(abi.encodeWithSelector(Voting.UnknownCandidate.selector, 0));
        _vote(alice, 0);

        vm.expectRevert(abi.encodeWithSelector(Voting.UnknownCandidate.selector, 3));
        _vote(alice, 3);
    }

    function test_Vote_RevertsOnIncorrectStake() public {
        _openBallot();
        vm.deal(alice, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(Voting.IncorrectStake.selector, STAKE, 0));
        vm.prank(alice);
        voting.vote{ value: 0 }(1);

        vm.expectRevert(abi.encodeWithSelector(Voting.IncorrectStake.selector, STAKE, STAKE * 2));
        vm.prank(alice);
        voting.vote{ value: STAKE * 2 }(1);
    }

    // ---------------------------------------------------------------------
    // Refunds
    // ---------------------------------------------------------------------

    function test_Refund_RevertsBeforeVotingEnds() public {
        _openBallot();
        _vote(alice, 1);

        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Ended, Voting.Phase.Voting)
        );

        vm.prank(alice);
        voting.refund();
    }

    function test_Refund_RevertsWhenNothingWasStaked() public {
        _openBallot();
        vm.prank(admin);
        voting.endVoting();

        vm.expectRevert(Voting.NothingToRefund.selector);

        vm.prank(alice);
        voting.refund();
    }

    function test_Refund_ReturnsStakeExactlyOnce() public {
        _openBallot();
        _vote(alice, 1);
        vm.prank(admin);
        voting.endVoting();

        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        voting.refund();

        assertEq(alice.balance, balanceBefore + STAKE, "stake returned");
        assertEq(voting.stakeOf(alice), 0, "stake cleared");
        assertEq(voting.totalStaked(), 0, "total stake cleared");

        vm.expectRevert(Voting.NothingToRefund.selector);
        vm.prank(alice);
        voting.refund();
    }

    function test_Refund_EmitsEvent() public {
        _openBallot();
        _vote(alice, 1);
        vm.prank(admin);
        voting.endVoting();

        vm.expectEmit(true, false, false, true, address(voting));
        emit Voting.Refunded(alice, STAKE);

        vm.prank(alice);
        voting.refund();
    }

    // ---------------------------------------------------------------------
    // Sweep of unclaimed stakes
    // ---------------------------------------------------------------------

    function test_SweepUnclaimed_RevertsDuringGracePeriod() public {
        _openBallot();
        _vote(alice, 1);
        vm.prank(admin);
        voting.endVoting();

        uint256 availableAt = voting.votingEndedAt() + voting.REFUND_GRACE_PERIOD();

        vm.expectRevert(abi.encodeWithSelector(Voting.GracePeriodNotElapsed.selector, availableAt));

        vm.prank(admin);
        voting.sweepUnclaimed(admin);
    }

    function test_SweepUnclaimed_TransfersAfterGracePeriod() public {
        _openBallot();
        _vote(alice, 1);
        _vote(bob, 2);
        vm.prank(admin);
        voting.endVoting();

        vm.warp(voting.votingEndedAt() + voting.REFUND_GRACE_PERIOD());

        uint256 balanceBefore = carol.balance;

        vm.prank(admin);
        voting.sweepUnclaimed(carol);

        assertEq(carol.balance, balanceBefore + STAKE * 2, "both unclaimed stakes transferred");
        assertEq(address(voting).balance, 0, "contract drained");
        assertEq(voting.totalStaked(), 0, "stake accounting zeroed");
    }

    function test_SweepUnclaimed_RevertsForNonOwner() public {
        _openBallot();
        vm.prank(admin);
        voting.endVoting();
        vm.warp(voting.votingEndedAt() + voting.REFUND_GRACE_PERIOD());

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));

        vm.prank(alice);
        voting.sweepUnclaimed(alice);
    }

    // ---------------------------------------------------------------------
    // Adversarial: reentrancy matrix (spec metric M-3)
    //
    // Four contracts, one attacker, identical stake amounts. The point is to
    // measure which defence actually stops the attack instead of assuming it.
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

        _adminAddCandidate(address(target));
        _adminSetWhitelist(address(target), _votersWithAttacker(address(attacker)));
        _adminStartVoting(address(target));

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

        _adminAddCandidate(address(target));
        _adminSetWhitelist(address(target), _votersWithAttacker(address(attacker)));
        _adminStartVoting(address(target));

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

        _adminAddCandidate(address(target));
        _adminSetWhitelist(address(target), _votersWithAttacker(address(attacker)));
        _adminStartVoting(address(target));

        _primeVote(address(target), alice, 1);
        _primeVote(address(target), bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        attacker.attack();

        assertEq(attacker.totalReceived(), STAKE, "guarded re-entry recovered only its own stake");
        assertEq(address(target).balance, STAKE * 2, "victim funds untouched");
        assertGt(attacker.reentryAttempts(), 0, "the guard was actually exercised");
    }

    function test_Reentrancy_AttackFailsAgainstVoting() public {
        _openBallot();

        RefundAttacker attacker = new RefundAttacker(address(voting), 10);

        address[] memory voters = new address[](1);
        voters[0] = address(attacker);
        vm.prank(admin);
        voting.setWhitelist(voters, true);

        _vote(alice, 1);
        _vote(bob, 1);

        vm.deal(address(attacker), 1 ether);
        attacker.castVote{ value: STAKE }(1);

        vm.prank(admin);
        voting.endVoting();

        assertEq(address(voting).balance, STAKE * 3, "three stakes held before the attack");

        attacker.attack();

        assertEq(attacker.totalReceived(), STAKE, "attacker recovered only its own stake");
        assertEq(address(voting).balance, STAKE * 2, "victim funds untouched");
        assertEq(voting.stakeOf(address(attacker)), 0, "attacker stake cleared");
        assertEq(voting.totalStaked(), STAKE * 2, "accounting consistent after the attack");
    }

    // ---------------------------------------------------------------------
    // Internal plumbing for the generic targets above
    // ---------------------------------------------------------------------

    function _adminAddCandidate(address target) internal {
        (bool ok, ) = target.call(abi.encodeWithSignature("addCandidate()"));
        require(ok, "addCandidate failed");
    }

    function _adminSetWhitelist(address target, address[] memory voters) internal {
        (bool ok, ) = target.call(
            abi.encodeWithSignature("setWhitelist(address[],bool)", voters, true)
        );
        require(ok, "setWhitelist failed");
    }

    function _adminStartVoting(address target) internal {
        (bool ok, ) = target.call(abi.encodeWithSignature("startVoting()"));
        require(ok, "startVoting failed");
    }

    function _primeVote(address target, address voter, uint256 candidateId) internal {
        vm.deal(voter, 1 ether);
        vm.prank(voter);
        (bool ok, ) = target.call{ value: STAKE }(abi.encodeWithSignature("vote(uint256)", candidateId));
        require(ok, "vote failed");
    }

    // ---------------------------------------------------------------------
    // Remaining guard branches
    // ---------------------------------------------------------------------

    function test_StartVoting_RevertsWhenCalledTwice() public {
        _openBallot();

        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Setup, Voting.Phase.Voting)
        );

        vm.prank(admin);
        voting.startVoting();
    }

    function test_CandidateCID_RevertsOnUnknownId() public {
        _openBallot();

        vm.expectRevert(abi.encodeWithSelector(Voting.UnknownCandidate.selector, 3));

        voting.candidateCID(3);
    }

    function test_Refund_RevertsWhenVoterCannotReceiveEther() public {
        _openBallot();

        EthRejectingVoter rejecting = new EthRejectingVoter();

        address[] memory voters = new address[](1);
        voters[0] = address(rejecting);
        vm.prank(admin);
        voting.setWhitelist(voters, true);

        vm.deal(address(rejecting), 1 ether);
        vm.prank(address(rejecting));
        voting.vote{ value: STAKE }(1);

        vm.prank(admin);
        voting.endVoting();

        vm.expectRevert(Voting.TransferFailed.selector);

        vm.prank(address(rejecting));
        voting.refund();
    }

    function test_SweepUnclaimed_RevertsBeforeVotingEnded() public {
        _openBallot();

        vm.expectRevert(
            abi.encodeWithSelector(Voting.InvalidPhase.selector, Voting.Phase.Ended, Voting.Phase.Voting)
        );

        vm.prank(admin);
        voting.sweepUnclaimed(admin);
    }

    function test_SweepUnclaimed_RevertsOnZeroAddress() public {
        _openBallot();
        _vote(alice, 1);

        vm.prank(admin);
        voting.endVoting();
        vm.warp(voting.votingEndedAt() + voting.REFUND_GRACE_PERIOD());

        vm.expectRevert(Voting.ZeroAddress.selector);

        vm.prank(admin);
        voting.sweepUnclaimed(address(0));
    }

    function test_SweepUnclaimed_RevertsWhenNothingIsHeld() public {
        _openBallot();

        vm.prank(admin);
        voting.endVoting();
        vm.warp(voting.votingEndedAt() + voting.REFUND_GRACE_PERIOD());

        vm.expectRevert(Voting.NothingToRefund.selector);

        vm.prank(admin);
        voting.sweepUnclaimed(alice);
    }

    function test_SweepUnclaimed_RevertsWhenRecipientRejectsEther() public {
        _openBallot();
        _vote(alice, 1);

        vm.prank(admin);
        voting.endVoting();
        vm.warp(voting.votingEndedAt() + voting.REFUND_GRACE_PERIOD());

        EthRejectingVoter rejecting = new EthRejectingVoter();

        vm.expectRevert(Voting.TransferFailed.selector);

        vm.prank(admin);
        voting.sweepUnclaimed(address(rejecting));
    }

    // ---------------------------------------------------------------------
    // Fuzz: accounting convergence (spec metric M-4, fuzz half)
    // ---------------------------------------------------------------------

    function testFuzz_VoteAccountingConverges(uint8 rawVoterCount, uint8 candidateSeed) public {
        uint256 voterCount = bound(uint256(rawVoterCount), 1, 20);

        address[] memory voters = new address[](voterCount);
        for (uint256 i = 0; i < voterCount; ++i) {
            voters[i] = makeAddr(string.concat("fuzzVoter", vm.toString(i)));
        }

        vm.startPrank(admin);
        voting.addCandidate(CID_A);
        voting.addCandidate(CID_B);
        voting.setWhitelist(voters, true);
        voting.startVoting();
        vm.stopPrank();

        for (uint256 i = 0; i < voterCount; ++i) {
            uint256 candidateId = (uint256(candidateSeed) + i) % 2 == 0 ? 1 : 2;
            _vote(voters[i], candidateId);
        }

        (, uint256 total) = voting.results();
        assertEq(total, voterCount, "sum(voteCount) must equal the number of voters");
        assertEq(voting.totalStaked(), voterCount * STAKE, "stake held must equal votes times STAKE");

        uint256 markedVoted;
        for (uint256 i = 0; i < voterCount; ++i) {
            if (voting.hasVoted(voters[i])) ++markedVoted;
        }
        assertEq(markedVoted, voterCount, "every voter must be marked exactly once");
    }
}
