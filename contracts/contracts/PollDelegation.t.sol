// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice Tests for delegation.
///
/// @dev The property that matters is the one ADR-0034 restated: a delegated
///      ballot must carry each subject's weight EXACTLY once. Two ways to break
///      that, and both have a test here:
///
///        * counting it zero times — a subject's weight is dropped when its
///          delegate acts, so the poll silently loses a vote; and
///        * counting it twice — the subject's weight is credited both to its own
///          ballot and to the delegate's, inflating the tally.
///
///      A test that only checks "the delegate's ballot counted 3" cannot tell
///      those apart from correct behaviour, so the group assertions below always
///      include the un-delegated control case as well.
contract PollDelegationTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;

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

    function _delegableConfig() internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.delegable = true;
        return config;
    }

    function _weightedDelegableConfig() internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.delegable = true;
        config.weighted = true;
        return config;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    /// @dev A delegable poll with all four addresses whitelisted and open.
    function _openPoll() internal returns (Poll created) {
        created = new Poll();
        created.initialize(creator, "Delegable?", _cids(3), FAR_FUTURE, _delegableConfig(), _noExecutionTargets());

        address[] memory voters = new address[](4);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;
        voters[3] = dave;

        vm.startPrank(creator);
        created.setWhitelist(voters, true);
        created.startPoll();
        vm.stopPrank();
    }

    function _vote(address voter, uint256 optionId) internal {
        vm.deal(voter, 1 ether);
        vm.prank(voter);
        poll.vote{ value: STAKE }(_ids(optionId));
    }

    function _countOf(uint256 optionId) internal view returns (uint256) {
        (Poll.Option[] memory list, ) = poll.results();
        return list[optionId - 1].voteCount;
    }

    // ---------------------------------------------------------------------
    // The basic transfer of authority
    // ---------------------------------------------------------------------

    function test_Delegate_CarriesItsOwnVoteOnlyWhenNobodyDelegated() public {
        poll = _openPoll();

        _vote(alice, 1);

        assertEq(_countOf(1), 1, "the control: no delegation, so one ballot is one unit");
    }

    function test_Delegate_CarriesEachSubjectExactlyOnce() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);
        vm.prank(carol);
        poll.delegate(alice);

        _vote(alice, 1);

        // Alice's own vote plus two subjects: three units of power, one ballot.
        assertEq(_countOf(1), 3, "one ballot carried all three subjects' weight");
        assertEq(poll.delegateCountOf(alice), 2, "and the poll knows it represents two");
    }

    /// @dev The "counted twice" mutation. If a delegating subject could also
    ///      vote for itself, its weight would land twice — once directly and
    ///      once through the delegate — and the tally would exceed the number of
    ///      eligible voters.
    function test_Delegate_DelegatingSubjectCannotAlsoVote() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);

        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Poll.NotADelegate.selector, bob));
        poll.vote{ value: STAKE }(_ids(2));
    }

    /// @dev The "counted zero times" mutation, from the other direction: a
    ///      subject that delegated must not be counted by its own absence. Once
    ///      the delegate votes, the subject's weight IS in the tally — so the
    ///      total must match the number of people represented, not the number of
    ///      ballots.
    function test_Delegate_RepresentsEveryoneInTheTally() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);
        vm.prank(carol);
        poll.delegate(alice);
        vm.prank(dave);
        poll.delegate(alice);

        _vote(alice, 2);

        assertEq(_countOf(2), 4, "one ballot, four people's weight");
    }

    // ---------------------------------------------------------------------
    // Single-level: the chain is refused, not merely unwalked
    // ---------------------------------------------------------------------

    /// @dev A delegate may not itself be a delegate. Without this, authority
    ///      could travel a chain the contract cannot bound, and the cost of a
    ///      vote would depend on its depth.
    ///
    ///      The refusal is on the RIGHT side of the relationship: what is
    ///      rejected is naming as delegate someone who has ALREADY handed its
    ///      own authority away. Two subjects naming the SAME delegate is the
    ///      ordinary case and must keep working — that negative control is just
    ///      below, so an implementation that refused every delegate would fail
    ///      it rather than passing this test.
    function test_Delegate_CannotChainThroughADelegate() public {
        poll = _openPoll();

        // Carol hands her vote to alice.
        vm.prank(carol);
        poll.delegate(alice);

        // Dave now tries to name carol. Carol has already delegated herself, so
        // carol is the one that cannot hold authority: dave -> carol -> alice is
        // the chain being refused.
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(Poll.CannotDelegateToADelegate.selector, carol));
        poll.delegate(carol);
    }

    /// @dev The negative control for the chain refusal: several subjects naming
    ///      one delegate is exactly what delegation is FOR, and must not be
    ///      mistaken for chaining.
    function test_Delegate_ManySubjectsMayNameTheSameDelegate() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);
        vm.prank(carol);
        poll.delegate(alice);
        vm.prank(dave);
        poll.delegate(alice);

        assertEq(poll.delegateCountOf(alice), 3, "three subjects, one delegate, no chain");
    }

    function test_Delegate_RefusesSelfDelegation() public {
        poll = _openPoll();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.SelfDelegation.selector, alice));
        poll.delegate(alice);
    }

    function test_Delegate_RefusesAnAddressThatIsNotWhitelisted() public {
        poll = _openPoll();
        address stranger = makeAddr("stranger");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.DelegateNotEligible.selector, stranger));
        poll.delegate(stranger);
    }

    function test_Delegate_RefusesADelegatorThatAlreadyVoted() public {
        poll = _openPoll();

        _vote(bob, 1);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Poll.DelegatorHasVoted.selector, bob));
        poll.delegate(alice);
    }

    /// @dev The negative control for the single-level rule: a delegate with no
    ///      subjects of its own MAY delegate onward, because it is not a
    ///      delegate. Without this, an implementation that refused every
    ///      delegation would pass the chaining test above.
    function test_Delegate_AnAddressWithNoSubjectsMayDelegateOnward() public {
        poll = _openPoll();

        vm.prank(carol);
        poll.delegate(bob);

        assertEq(poll.delegatedTo(carol), bob, "a plain voter can hand its vote to anyone");
    }

    // ---------------------------------------------------------------------
    // Revocation
    // ---------------------------------------------------------------------

    function test_Delegate_RevocationReturnsTheVoteToTheSubject() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);
        vm.prank(bob);
        poll.delegate(address(0));

        assertEq(poll.delegateCountOf(alice), 0, "alice no longer represents anyone");

        // Bob can vote for himself again, and it counts once.
        _vote(bob, 2);

        assertEq(_countOf(2), 1, "the revocation restored exactly one vote");
    }

    function test_Delegate_RevokingTwiceIsRefused() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);

        vm.prank(bob);
        poll.delegate(address(0));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Poll.AlreadyDelegated.selector, bob, address(0)));
        poll.delegate(address(0));
    }

    /// @dev Changing one's mind about WHO to delegate to must move the weight,
    ///      not copy it. This is the delegation analogue of `changeVote`.
    function test_Delegate_ChangingTheDelegateMovesRatherThanCopies() public {
        poll = _openPoll();

        vm.prank(carol);
        poll.delegate(alice);

        vm.prank(carol);
        poll.delegate(bob);

        assertEq(poll.delegateCountOf(alice), 0, "alice gave it up");
        assertEq(poll.delegateCountOf(bob), 1, "bob took it on");

        _vote(bob, 3);
        assertEq(_countOf(3), 2, "bob's ballot carries its own vote and carol's");
    }

    // ---------------------------------------------------------------------
    // Withdrawal interacts with delegation
    // ---------------------------------------------------------------------

    /// @dev A delegate that withdraws must get its delegated weight back, or the
    ///      subjects that named it lose their voice entirely: they cannot vote
    ///      for themselves and the one address that could act for them just gave
    ///      the power up.
    function test_Delegate_WithdrawKeepsTheDelegatedWeight() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);
        vm.prank(carol);
        poll.delegate(alice);

        _vote(alice, 1);
        assertEq(_countOf(1), 3, "three units credited");

        vm.prank(alice);
        poll.withdrawVote();

        assertEq(_countOf(1), 0, "withdrawing released all three units");
        assertEq(
            poll.controlledPowerOf(alice),
            3,
            "and alice controls them again, so a re-vote can carry them"
        );

        _vote(alice, 2);
        assertEq(_countOf(2), 3, "the re-vote carried all three again");
    }

    // ---------------------------------------------------------------------
    // Weighted delegation
    // ---------------------------------------------------------------------

    /// @dev The weighted case is where "counted once" is hardest: three subjects
    ///      with different weights must sum, not be treated as three heads.
    function test_WeightedDelegate_SumsTheAssignedWeights() public {
        Poll weighted = new Poll();
        weighted.initialize(creator, "Weighted?", _cids(3), FAR_FUTURE, _weightedDelegableConfig(), _noExecutionTargets());

        address[] memory voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;

        address[] memory weightedVoters = new address[](3);
        weightedVoters[0] = alice;
        weightedVoters[1] = bob;
        weightedVoters[2] = carol;

        uint256[] memory weights = new uint256[](3);
        weights[0] = 1;
        weights[1] = 5;
        weights[2] = 3;

        vm.startPrank(creator);
        weighted.setWhitelist(voters, true);
        weighted.setWeights(weightedVoters, weights);
        weighted.startPoll();
        vm.stopPrank();

        vm.prank(bob);
        weighted.delegate(alice);
        vm.prank(carol);
        weighted.delegate(alice);

        assertEq(weighted.controlledPowerOf(alice), 9, "1 + 5 + 3, not a headcount of three");

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        weighted.vote{ value: STAKE }(_ids(1));

        (Poll.Option[] memory list, ) = weighted.results();
        assertEq(list[0].voteCount, 9, "the tally carries the summed weight");
    }

    /// @dev The negative control: an unweighted delegable poll sums to a
    ///      HEADCOUNT. Without this, an implementation that hard-coded the sum
    ///      of weights would pass the test above while breaking equal-weight
    ///      polls.
    function test_Delegate_UnweightedSumsToAHeadcount() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);
        vm.prank(carol);
        poll.delegate(alice);
        vm.prank(dave);
        poll.delegate(alice);

        assertEq(poll.controlledPowerOf(alice), 4, "alice's own 1 plus three subjects' 1s");
    }

    // ---------------------------------------------------------------------
    // Configuration gates
    // ---------------------------------------------------------------------

    function test_Delegate_RefusedWhenTheMechanismIsOff() public {
        Poll plain = new Poll();
        plain.initialize(creator, "Q", _cids(3), FAR_FUTURE, PollMechanisms.defaultConfig(0), _noExecutionTargets());

        address[] memory voters = new address[](2);
        voters[0] = alice;
        voters[1] = bob;

        vm.startPrank(creator);
        plain.setWhitelist(voters, true);
        plain.startPoll();
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(Poll.NotDelegable.selector);
        plain.delegate(bob);
    }

    /// @dev Delegation is a Setup-time decision in the sense that it must be
    ///      frozen with the rest of the rules — but it happens during Voting,
    ///      because that is when voters exist. In Setup it is refused so a
    ///      delegation cannot precede the roster it depends on.
    function test_Delegate_RefusedBeforeVotingOpens() public {
        Poll fresh = new Poll();
        fresh.initialize(creator, "Q", _cids(3), FAR_FUTURE, _delegableConfig(), _noExecutionTargets());

        address[] memory voters = new address[](2);
        voters[0] = alice;
        voters[1] = bob;

        vm.prank(creator);
        fresh.setWhitelist(voters, true);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Voting, Poll.Phase.Setup)
        );
        fresh.delegate(bob);
    }

    /// @dev `PollMechanisms.validate` refuses commit-reveal + delegation, so a
    ///      poll that somehow had both would be a contract bug rather than a user
    ///      error. This pins the refusal at the initialization boundary.
    function test_Delegate_CommitRevealCombinationIsRefusedAtInitialization() public {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.delegable = true;
        config.commitReveal = true;
        config.revealWindowSeconds = 3600;

        Poll fresh = new Poll();

        vm.expectRevert(
            abi.encodeWithSelector(
                Poll.InvalidConfig.selector,
                "commit-reveal cannot be combined with delegation yet"
            )
        );
        fresh.initialize(creator, "Q", _cids(3), FAR_FUTURE, config, _noExecutionTargets());
    }

    // ---------------------------------------------------------------------
    // voterState reports the delegation honestly
    // ---------------------------------------------------------------------

    function test_VoterState_ReportsDelegation() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);

        Poll.VoterState memory from = poll.voterState(bob);
        assertTrue(from.delegating, "bob is delegating, so the ballot is closed to him");
        assertEq(from.delegatedTo, alice, "and it says to whom");
        assertEq(from.controlledPower, 0, "bob controls nothing while delegating");

        Poll.VoterState memory to = poll.voterState(alice);
        assertFalse(to.delegating, "alice is not delegating");
        assertEq(to.delegatorCount, 1, "but she represents one");
        assertEq(to.controlledPower, 2, "and controls two units before voting");
    }

    /// @dev Before voting, `power` is zero and `controlledPower` is the useful
    ///      number. After voting they agree, because the same power is now
    ///      credited rather than merely held. Pinning both stops a reader from
    ///      showing "your vote counts for 0" to a delegate who has not voted
    ///      yet.
    ///
    ///      `controlledPower` deliberately does NOT drop to zero after voting:
    ///      the power is still this address's, and a withdrawal would return it
    ///      to the controlled state. Reporting zero here would tell a delegate
    ///      that withdrawing costs it nothing, which is false.
    function test_VoterState_MovesPowerFromControlledToCredited() public {
        poll = _openPoll();

        vm.prank(bob);
        poll.delegate(alice);

        Poll.VoterState memory before = poll.voterState(alice);
        assertEq(before.power, 0, "nothing credited yet");
        assertEq(before.controlledPower, 2, "but two units are controlled");

        _vote(alice, 1);

        Poll.VoterState memory afterState = poll.voterState(alice);
        assertEq(afterState.power, 2, "now credited");
        assertEq(afterState.controlledPower, 2, "and still controlled, so a withdrawal keeps it");
    }
}
