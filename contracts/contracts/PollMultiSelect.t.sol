// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice Tests for the multi-select and weighted mechanisms.
///
/// @dev Kept in its own file rather than appended to `Poll.t.sol` because the
///      subject is different: that suite pins the behaviour every poll has had
///      since the multi-tenant rewrite, and this one pins what the new
///      mechanisms add. Mixing them would make it hard to see which assertions
///      a mechanism change is allowed to move.
///
///      EVERY MECHANISM TEST HERE HAS A NEGATIVE COUNTERPART. A test that a
///      weight of 5 counts as 5 proves nothing on its own — it passes just as
///      happily against an implementation that ignores weights and counts 1.
///      The pairs below therefore always include the equal-weight case that must
///      NOT produce the weighted answer, so a mutation to either path fails.
contract PollMechanismsTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;

    // ---------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------

    function _cids(uint256 count) internal pure returns (string[] memory cids) {
        cids = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            cids[i] = string.concat("cid-", vm.toString(i));
        }
    }

    /// @dev A poll with `count` options under `config`, opened and with all three
    ///      voters whitelisted.
    function _openPoll(
        PollMechanisms.PollConfig memory config,
        uint256 count
    ) internal returns (Poll created) {
        created = new Poll();
        created.initialize(creator, "Which ones?", _cids(count), FAR_FUTURE, config);

        address[] memory voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;

        vm.startPrank(creator);
        created.setWhitelist(voters, true);
        created.startPoll();
        vm.stopPrank();
    }

    function _multiSelectConfig(uint256 maxSelections) internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.multiSelect = true;
        config.maxSelections = maxSelections;
        return config;
    }

    function _weightedConfig() internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.weighted = true;
        return config;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function _ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
    }

    function _vote(address voter, uint256[] memory ids) internal {
        vm.deal(voter, 1 ether);
        vm.prank(voter);
        poll.vote{ value: STAKE }(ids);
    }

    function _counts() internal view returns (uint256 first, uint256 second, uint256 third, uint256 total) {
        (Poll.Option[] memory list, uint256 sum) = poll.results();
        first = list[0].voteCount;
        if (list.length > 1) second = list[1].voteCount;
        if (list.length > 2) third = list[2].voteCount;
        total = sum;
    }

    // ---------------------------------------------------------------------
    // Multi-select: counting
    // ---------------------------------------------------------------------

    function test_MultiSelect_CountsEverySelectedOption() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(1, 3));

        (uint256 first, uint256 second, uint256 third, uint256 total) = _counts();

        assertEq(first, 1, "the first selection counted");
        assertEq(second, 0, "an unselected option must stay at zero, not be skipped");
        assertEq(third, 1, "the second selection counted");
        assertEq(total, 2, "two selections is a total of two, not one vote");
    }

    /// @dev The distinction the invariant now has to make: one vote, several
    ///      options. "One vote" constrains the number of voting ACTS, not the
    ///      number of options marked — which is exactly what ADR-0034 restated.
    function test_MultiSelect_OneAddressCanOnlyVoteOnce() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(1, 2));

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.AlreadyVoted.selector, alice));
        poll.vote{ value: STAKE }(_ids(3));
    }

    function test_MultiSelect_RejectsMoreThanTheCap() public {
        poll = _openPoll(_multiSelectConfig(2), 3);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.TooManySelections.selector, 2, 3));
        poll.vote{ value: STAKE }(_ids(1, 2, 3));
    }

    function test_MultiSelect_AcceptsExactlyTheCap() public {
        poll = _openPoll(_multiSelectConfig(2), 3);

        _vote(alice, _ids(1, 2));

        (, , , uint256 total) = _counts();
        assertEq(total, 2, "a set of exactly the cap is legal");
    }

    function test_MultiSelect_RejectsAnEmptySet() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(Poll.NoSelections.selector);
        poll.vote{ value: STAKE }(new uint256[](0));
    }

    /// @dev Without this check, `[1,1]` would add 2 to option 1 and the tally
    ///      would no longer equal the number of people who voted for it.
    function test_MultiSelect_RejectsADuplicateSelection() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.DuplicateSelection.selector, 1));
        poll.vote{ value: STAKE }(_ids(1, 1));
    }

    /// @dev A duplicate must be rejected even when it is not adjacent, which is
    ///      what makes the check a set check rather than a neighbour check.
    function test_MultiSelect_RejectsANonAdjacentDuplicate() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.DuplicateSelection.selector, 1));
        poll.vote{ value: STAKE }(_ids(1, 2, 1));
    }

    function test_MultiSelect_RejectsAnUnknownOptionInsideTheSet() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.UnknownOption.selector, 4));
        poll.vote{ value: STAKE }(_ids(1, 4));
    }

    // ---------------------------------------------------------------------
    // Multi-select: order independence and canonical storage
    // ---------------------------------------------------------------------

    /// @dev The stored set is ascending regardless of submission order, so that
    ///      "the same set" is a direct comparison for every later reader.
    function test_MultiSelect_StoresTheSetAscending() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(3, 1));

        uint256[] memory stored = poll.votedOptions(alice);

        assertEq(stored.length, 2, "both selections stored");
        assertEq(stored[0], 1, "smallest first");
        assertEq(stored[1], 3, "largest last");
    }

    /// @dev `votedFor` is a view over the set's first element, so a reader that
    ///      predates multi-select still gets a truthful answer.
    function test_MultiSelect_VotedForReportsTheFirstElement() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(3, 1));

        assertEq(poll.votedFor(alice), 1, "the first element of the ascending set");
    }

    // ---------------------------------------------------------------------
    // Multi-select: changing and withdrawing
    // ---------------------------------------------------------------------

    /// @dev A change REPLACES the set. Merging would let two changes accumulate
    ///      into a vote worth two, which is the double-count ADR-0034 forbids.
    function test_MultiSelect_ChangeReplacesRatherThanMerges() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(1, 2));

        vm.prank(alice);
        poll.changeVote(_ids(3));

        (uint256 first, uint256 second, uint256 third, uint256 total) = _counts();

        assertEq(first, 0, "option 1 was released");
        assertEq(second, 0, "option 2 was released");
        assertEq(third, 1, "only option 3 remains");
        assertEq(total, 1, "the total followed the set down, not up");
    }

    function test_MultiSelect_WithdrawClearsEverySelection() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(1, 2, 3));

        vm.prank(alice);
        poll.withdrawVote();

        (, , , uint256 total) = _counts();
        assertEq(total, 0, "every selection was released");
        assertEq(poll.votedOptions(alice).length, 0, "and the set is empty");
        assertEq(poll.votingPowerOf(alice), 0, "and the power is released");
    }

    /// @dev Re-submitting the identical set is refused, and the comparison must
    ///      be order-independent: {1,2} submitted as {2,1} is the same vote.
    function test_MultiSelect_ChangeRefusesTheSameSetInADifferentOrder() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(1, 2));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.SameOption.selector, 2));
        poll.changeVote(_ids(2, 1));
    }

    /// @dev But a genuinely different set of the same size must be accepted, or
    ///      the check above would be refusing legitimate edits.
    function test_MultiSelect_ChangeAcceptsADifferentSetOfTheSameSize() public {
        poll = _openPoll(_multiSelectConfig(3), 3);

        _vote(alice, _ids(1, 2));

        vm.prank(alice);
        poll.changeVote(_ids(1, 3));

        (uint256 first, uint256 second, uint256 third, uint256 total) = _counts();

        assertEq(first, 1, "option 1 was kept");
        assertEq(second, 0, "option 2 was released");
        assertEq(third, 1, "option 3 was added");
        assertEq(total, 2, "still one vote's worth of selections");
    }

    // ---------------------------------------------------------------------
    // Single-select must be unaffected by the multi-select code
    // ---------------------------------------------------------------------

    /// @dev The negative counterpart to the multi-select tests: under the
    ///      DEFAULT configuration a two-option set must be refused. Without
    ///      this, an implementation that ignored `multiSelect` entirely would
    ///      pass every test above.
    function test_SingleSelect_RefusesTwoOptions() public {
        poll = _openPoll(PollMechanisms.defaultConfig(0), 3);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.TooManySelections.selector, 1, 2));
        poll.vote{ value: STAKE }(_ids(1, 2));
    }

    function test_SingleSelect_RefusesAnEmptySet() public {
        poll = _openPoll(PollMechanisms.defaultConfig(0), 3);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(Poll.NoSelections.selector);
        poll.vote{ value: STAKE }(new uint256[](0));
    }

    function test_SingleSelect_StillCountsOneVoteForOneSelection() public {
        poll = _openPoll(PollMechanisms.defaultConfig(0), 3);

        _vote(alice, _ids(2));

        (uint256 first, uint256 second, , uint256 total) = _counts();

        assertEq(first, 0, "the unselected option is untouched");
        assertEq(second, 1, "the selected option counted once");
        assertEq(total, 1, "one vote is one, as it always was");
    }

    // ---------------------------------------------------------------------
    // Weighted: the weights themselves
    // ---------------------------------------------------------------------

    /// @dev An address the creator whitelisted but never weighted cannot vote.
    ///      Treating a missing weight as zero would let the transaction succeed
    ///      and change nothing, which is worse than a revert that names it.
    function test_Weighted_RequiresAnAssignedWeightToVote() public {
        Poll weighted = new Poll();
        weighted.initialize(creator, "Weighted?", _cids(3), FAR_FUTURE, _weightedConfig());

        address[] memory voters = new address[](2);
        voters[0] = alice;
        voters[1] = bob;

        // Only bob gets a weight; alice is whitelisted but unweighted.
        address[] memory weightedOnly = new address[](1);
        weightedOnly[0] = bob;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 5;

        vm.startPrank(creator);
        weighted.setWhitelist(voters, true);
        weighted.setWeights(weightedOnly, weights);
        weighted.startPoll();
        vm.stopPrank();

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Poll.NoWeightAssigned.selector, alice));
        weighted.vote{ value: STAKE }(_ids(1));
    }

    function test_Weighted_CountsTheAssignedWeight() public {
        poll = _newWeightedPoll();

        _vote(alice, _ids(1));

        (uint256 first, , , uint256 total) = _counts();

        assertEq(first, 5, "alice's weight of 5 counted as 5");
        assertEq(total, 5, "and the total is weighted, not a headcount");
    }

    /// @dev The negative counterpart: a weighted poll still counts a weight of 1
    ///      as 1, so an implementation that hard-coded 1 everywhere would fail
    ///      the test above while an implementation that hard-coded 5 would fail
    ///      this one.
    function test_Weighted_StillCountsAWeightOfOneOnce() public {
        poll = _newWeightedPoll();

        _vote(carol, _ids(1));

        (uint256 first, , , uint256 total) = _counts();

        assertEq(first, 1, "carol's weight is 1");
        assertEq(total, 1, "and the total says so");
    }

    function test_Weighted_DoesNotChangeTheStake() public {
        poll = _newWeightedPoll();

        _vote(alice, _ids(1));

        // Weight is a counting concept, not a payment one: a voter with 5x the
        // power does not post 5x the stake. Conflating the two would make the
        // refund path's arithmetic depend on the mechanism.
        assertEq(poll.stakeOf(alice), STAKE, "the stake is the fixed STAKE regardless of weight");
        assertEq(poll.totalStaked(), STAKE, "and the custody accounting agrees");
        assertEq(address(poll).balance, STAKE, "and the balance matches the accounting");
    }

    function test_Weighted_RejectsAZeroWeightAtAssignment() public {
        Poll weighted = _setupWeightedPoll();

        address[] memory voters = new address[](1);
        voters[0] = alice;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 0;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Poll.ZeroWeight.selector, alice));
        weighted.setWeights(voters, weights);
    }

    /// @dev The pool is a sum over assignments, so a reassignment must subtract
    ///      the old value first. Forgetting that is the weighting analogue of
    ///      forgetting to release the old option in `changeVote`.
    function test_Weighted_ReassignmentDoesNotInflateThePool() public {
        Poll weighted = _setupWeightedPoll();

        address[] memory voters = new address[](1);
        voters[0] = alice;

        uint256[] memory first = new uint256[](1);
        first[0] = 5;
        vm.prank(creator);
        weighted.setWeights(voters, first);

        uint256[] memory second = new uint256[](1);
        second[0] = 3;
        vm.prank(creator);
        weighted.setWeights(voters, second);

        assertEq(weighted.weightOf(alice), 3, "the new weight replaced the old");
        assertEq(weighted.totalWeightAssigned(), 3, "and the pool followed it down");
    }

    function test_Weighted_AssignmentIsRefusedOnAnUnweightedPoll() public {
        Poll plain = _openPoll(PollMechanisms.defaultConfig(0), 3);

        address[] memory voters = new address[](1);
        voters[0] = alice;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 5;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Poll.InvalidConfig.selector, "this poll is not weighted"));
        plain.setWeights(voters, weights);
    }

    /// @dev Assigning after voting began would let the creator re-value votes
    ///      that were already cast, which is the "rule changed after seeing the
    ///      tally" failure the mechanism freeze exists to prevent.
    function test_Weighted_AssignmentIsRefusedAfterVotingOpens() public {
        Poll weighted = _openPoll(_weightedConfig(), 3);

        address[] memory voters = new address[](1);
        voters[0] = alice;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 5;

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(Poll.InvalidPhase.selector, Poll.Phase.Setup, Poll.Phase.Voting)
        );
        weighted.setWeights(voters, weights);
    }

    // ---------------------------------------------------------------------
    // Weighted: change and withdraw must move the weighted amount, not 1
    // ---------------------------------------------------------------------

    /// @dev The mutation this catches: a `changeVote` that decrements by 1
    ///      instead of by the voter's power. Under equal weight the two are
    ///      identical, so only a weighted poll can expose it.
    function test_Weighted_ChangeReleasesTheWholeWeight() public {
        poll = _newWeightedPoll();

        _vote(alice, _ids(1));

        vm.prank(alice);
        poll.changeVote(_ids(2));

        (uint256 first, uint256 second, , uint256 total) = _counts();

        assertEq(first, 0, "the old option lost the full weight of 5, not 1");
        assertEq(second, 5, "and the new one gained all of it");
        assertEq(total, 5, "the total is unchanged by a change of mind");
    }

    function test_Weighted_WithdrawReleasesTheWholeWeight() public {
        poll = _newWeightedPoll();

        _vote(alice, _ids(1));

        vm.prank(alice);
        poll.withdrawVote();

        (, , , uint256 total) = _counts();
        assertEq(total, 0, "the full weight came out of the tally");
        assertEq(poll.votingPowerOf(alice), 0, "and the power slot was cleared");
    }

    /// @dev Weighted votes from several addresses add up, and the negative
    ///      counterpart is that an unweighted poll's three voters add up to 3.
    function test_Weighted_SumsDifferentWeights() public {
        poll = _newWeightedPoll();

        _vote(alice, _ids(1));
        _vote(bob, _ids(1));
        _vote(carol, _ids(1));

        (uint256 first, , , uint256 total) = _counts();

        assertEq(first, 1 + 5 + 1, "1 + 2... the assigned weights summed");
        assertEq(total, 7, "three voters, seven units of power");
    }

    // ---------------------------------------------------------------------
    // Weighted interaction with admission
    // ---------------------------------------------------------------------

    /// @dev `PollMechanisms.validate` refuses weighted + open admission, so this
    ///      is about the poll honouring that refusal rather than about the
    ///      predicate. A poll that accepted the combination would have no weight
    ///      for an unknown address.
    function test_Weighted_OpenAdmissionIsRefusedAtInitialization() public {
        PollMechanisms.PollConfig memory config = _weightedConfig();
        config.openToAll = true;

        Poll fresh = new Poll();

        vm.expectRevert(
            abi.encodeWithSelector(
                Poll.InvalidConfig.selector,
                "weighted voting requires whitelist admission"
            )
        );
        fresh.initialize(creator, "Q", _cids(3), FAR_FUTURE, config);
    }

    // ---------------------------------------------------------------------
    // The rules commitment covers the mechanisms
    // ---------------------------------------------------------------------

    /// @dev Two polls that differ only in a mechanism are different polls, so
    ///      they must not share a commitment. Without this, a reader comparing
    ///      `rulesHash` against `currentRulesHash` would learn nothing about
    ///      which counting rules they are looking at.
    function test_RulesHash_CoversTheMechanismSet() public {
        Poll plain = new Poll();
        plain.initialize(creator, "Q", _cids(3), FAR_FUTURE, PollMechanisms.defaultConfig(0));

        Poll weighted = new Poll();
        weighted.initialize(creator, "Q", _cids(3), FAR_FUTURE, _weightedConfig());

        Poll multi = new Poll();
        multi.initialize(creator, "Q", _cids(3), FAR_FUTURE, _multiSelectConfig(2));

        assertTrue(
            plain.rulesHash() != weighted.rulesHash(),
            "an equal-weight and a weighted poll are not the same rules"
        );
        assertTrue(
            plain.rulesHash() != multi.rulesHash(),
            "a single-select and a multi-select poll are not the same rules"
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev A weighted poll still in Setup, with the whitelist set but no
    ///      weights yet, so a test can drive `setWeights` itself. Separate from
    ///      `_newWeightedPoll` because weights are Setup-only: a fixture that
    ///      opens the poll cannot also be the one a weight test assigns on.
    function _setupWeightedPoll() internal returns (Poll created) {
        created = new Poll();
        created.initialize(creator, "Weighted?", _cids(3), FAR_FUTURE, _weightedConfig());

        address[] memory voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;

        vm.prank(creator);
        created.setWhitelist(voters, true);
    }

    /// @dev A weighted poll with alice=5, bob=1, carol=1, already open. Weights
    ///      are assigned here because `setWeights` is Setup-only, so a test that
    ///      needs different weights must build its own poll rather than reopen
    ///      this one.
    function _newWeightedPoll() internal returns (Poll created) {
        created = new Poll();
        created.initialize(creator, "Weighted?", _cids(3), FAR_FUTURE, _weightedConfig());

        address[] memory voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;

        address[] memory everyone = new address[](3);
        everyone[0] = alice;
        everyone[1] = bob;
        everyone[2] = carol;

        uint256[] memory weights = new uint256[](3);
        weights[0] = 5;
        weights[1] = 1;
        weights[2] = 1;

        vm.startPrank(creator);
        created.setWhitelist(voters, true);
        created.setWeights(everyone, weights);
        created.startPoll();
        vm.stopPrank();
    }
}
