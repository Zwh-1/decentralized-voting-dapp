// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice Tests for the two different "how many may vote" figures.
///
/// @dev This suite exists because the two are easy to mistake for each other and
///      only one of them is the right denominator for turnout:
///
///        * `whitelistedCount()` is a LIVE count of admitted addresses. It is what
///          a creator checks after uploading a list, and it MOVES when the list is
///          edited.
///        * `frozenEligiblePower` is the denominator the quorum and turnout are
///          measured against, fixed at `startPoll` so the pass mark cannot move
///          while votes accumulate.
///
///      The tests that matter most are the ones where the two DISAGREE, because
///      that is where a caller could pick the wrong one and get a turnout figure
///      that changes retroactively — a poll that reported 50% on one day and 40%
///      the next with no vote cast in between.
contract PollEligibilityTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant FAR_FUTURE = 4_000_000_000;

    function _cids(uint256 count) internal pure returns (string[] memory cids) {
        cids = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            cids[i] = string.concat("cid-", vm.toString(i));
        }
    }

    function _emptyTargets() internal pure returns (address[] memory list) {
        list = new address[](0);
    }

    /// @dev A whitelisted, equal-weight poll with nobody admitted yet.
    function _deploy() internal returns (PollMechanisms.PollConfig memory config) {
        config = PollMechanisms.defaultConfig(FAR_FUTURE);

        poll = new Poll();
        poll.initialize(
            creator,
            "How many?",
            _cids(2),
            FAR_FUTURE,
            config,
            _emptyTargets()
        );
    }

    function _admit(address[] memory voters) internal {
        vm.prank(creator);
        poll.setWhitelist(voters, true);
    }

    function _revoke(address[] memory voters) internal {
        vm.prank(creator);
        poll.setWhitelist(voters, false);
    }

    function _pair(address a, address b) internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = a;
        list[1] = b;
    }

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    /// @dev The option ids for one vote. Separate from `_one` because a vote is a
    ///      list of option ids and an admission is a list of addresses, and
    ///      conflating the two types is exactly the transposition a named helper
    ///      prevents.
    function _optionIds(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    // ---------------------------------------------------------------------
    // The count itself
    // ---------------------------------------------------------------------

    function test_WhitelistedCount_StartsAtZero() public {
        _deploy();

        assertEq(poll.whitelistedCount(), 0, "nobody admitted yet");
    }

    function test_WhitelistedCount_CountsAdmittedAddresses() public {
        _deploy();
        _admit(_pair(alice, bob));

        assertEq(poll.whitelistedCount(), 2);
    }

    function test_WhitelistedCount_DropsRevokedAddresses() public {
        _deploy();
        _admit(_pair(alice, bob));
        _revoke(_one(alice));

        assertEq(poll.whitelistedCount(), 1, "revoking must remove from the count");
    }

    function test_WhitelistedCount_DoesNotDoubleCountARepeatedGrant() public {
        // Admission is idempotent, so re-adding an address must not inflate the
        // figure. This is the failure that would make a turnout denominator drift
        // upward on every redundant call.
        _deploy();
        _admit(_one(alice));
        _admit(_one(alice));

        assertEq(poll.whitelistedCount(), 1, "a repeated grant is still one voter");
    }

    function test_WhitelistedCount_CountsAGrantAfterARevoke() public {
        // The address stays in the enumeration array after a revoke, so a
        // re-grant must count again rather than being treated as already seen.
        _deploy();
        _admit(_one(alice));
        _revoke(_one(alice));
        _admit(_one(alice));

        assertEq(poll.whitelistedCount(), 1);
    }

    function test_WhitelistedCount_CountsAddressesNotPowerOnAWeightedPoll() public {
        // The distinction in KIND: this returns people, `frozenEligiblePower`
        // returns weight. A caller that used one for the other would report a
        // turnout above 100% on any poll where a weight exceeds one.
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(FAR_FUTURE);
        config.weighted = true;

        poll = new Poll();
        poll.initialize(creator, "Weighted?", _cids(2), FAR_FUTURE, config, _emptyTargets());

        _admit(_pair(alice, bob));

        vm.prank(creator);
        poll.setWeights(_pair(alice, bob), _weights(3, 7));

        assertEq(poll.whitelistedCount(), 2, "two addresses");

        vm.prank(creator);
        poll.startPoll();

        assertEq(poll.frozenEligiblePower(), 10, "but ten units of power");
    }

    function _weights(uint256 a, uint256 b) internal pure returns (uint256[] memory list) {
        list = new uint256[](2);
        list[0] = a;
        list[1] = b;
    }

    // ---------------------------------------------------------------------
    // The two figures disagree, and that is the point
    // ---------------------------------------------------------------------

    function test_CountAndFrozenPowerAgreeWhenTheListIsNotEditedAfterStart() public {
        _deploy();
        _admit(_pair(alice, bob));

        vm.prank(creator);
        poll.startPoll();

        assertEq(poll.whitelistedCount(), 2);
        assertEq(poll.frozenEligiblePower(), 2, "equal weight: power equals people");
    }

    function test_ListEditsDuringVotingMoveTheCountButNotTheDenominator() public {
        // THE TEST THIS SUITE EXISTS FOR. `setWhitelist` is permitted during
        // voting, so an admitted address can arrive after the pass mark was fixed.
        // Turnout computed from the live count would then fall while no vote was
        // withdrawn — the poll would appear to become less legitimate over time.
        _deploy();
        _admit(_pair(alice, bob));

        vm.prank(creator);
        poll.startPoll();

        uint256 frozen = poll.frozenEligiblePower();

        _admit(_one(carol));

        assertEq(poll.whitelistedCount(), 3, "the live count moved");
        assertEq(poll.frozenEligiblePower(), frozen, "the denominator did not");
        assertEq(poll.frozenEligiblePower(), 2, "and it is still the value fixed at startPoll");
    }

    function test_RevokingDuringVotingAlsoLeavesTheDenominatorAlone() public {
        _deploy();
        _admit(_pair(alice, bob));

        vm.prank(creator);
        poll.startPoll();

        _revoke(_one(alice));

        assertEq(poll.whitelistedCount(), 1);
        assertEq(poll.frozenEligiblePower(), 2, "revoking after the start cannot lower the pass mark");
    }

    function test_TurnoutUsesTheFrozenDenominatorRatherThanTheLiveCount() public {
        // The end-to-end consequence. One of two frozen voters votes: turnout is
        // 50%. Admitting a third address afterwards must not turn that into 33%
        // in the contract's own answer.
        _deploy();
        _admit(_pair(alice, bob));

        vm.prank(creator);
        poll.startPoll();

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        poll.vote{ value: 0.001 ether }(_optionIds(1));

        assertEq(poll.turnoutBps(), 5000, "one of two = 50%");

        _admit(_one(carol));

        assertEq(poll.turnoutBps(), 5000, "and it stays 50% after the list grows");
    }

    function test_WhitelistedCountStillReportsALatentListOnAnOpenPoll() public {
        // On an open poll the list is not what admits anyone, but it is still
        // recorded state and `setWhitelist` still writes it. Reporting it as zero
        // would hide a list the creator did upload; the caller decides what it
        // means, which is why this is a raw count rather than a verdict.
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(FAR_FUTURE);
        config.openToAll = true;

        poll = new Poll();
        poll.initialize(creator, "Open?", _cids(2), FAR_FUTURE, config, _emptyTargets());

        _admit(_pair(alice, bob));

        assertEq(poll.whitelistedCount(), 2);
        assertEq(poll.frozenEligiblePower(), 0, "an open poll has no enumerable denominator");
    }
}
