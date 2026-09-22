// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice The conservation law for delegation, checked under randomised
///         sequences rather than fixed ones.
///
/// @dev THE PROPERTY: at every moment, the sum of `controlledPowerOf` over all
///      eligible addresses equals the sum of `powerOf` over the same addresses.
///      Delegation MOVES authority between addresses; it must never create or
///      destroy it.
///
///      Why this needs randomised coverage rather than the fixed scenarios in
///      `PollDelegation.t.sol`: the ways to break conservation are all
///      bookkeeping errors in `_delegatedSurplus`, and `_delegatedSurplus` is a
///      DELTA, not a total. A delta is correct only if every path that changes
///      the underlying assignment changes the delta in step. The paths are
///      delegate, undelegate, re-delegate (delegate directly to someone else
///      without undelegating first), and a delegate acting — and the LAST of
///      those is where a delta is easiest to get wrong, because the subject's
///      power is being spent through someone else's call. Fixed scenarios tend
///      to cover the first two and stop.
///
///      This is the property that a quorum's denominator rides on: if
///      `controlledPowerOf` inflated under delegation, a passing poll could
///      report a turnout above 100% — a number that is obviously wrong only if
///      something asserts it cannot happen.
contract PollPowerConservationTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("creator");

    uint256 internal constant SUBJECTS = 6;
    uint256 internal constant WEIGHTS = 12;
    uint256 internal constant ROUNDS = 300;
    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;

    address[] internal subjects;
    uint256[] internal assignedWeight;

    function _noExecutionTargets() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _one(uint256 optionId) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = optionId;
    }

    function _cids(uint256 count) internal pure returns (string[] memory cids) {
        cids = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            cids[i] = string.concat("cid-", vm.toString(i));
        }
    }

    function setUp() public {
        poll = new Poll();
        poll.initialize(
            creator,
            "Conservation",
            _cids(2),
            FAR_FUTURE,
            _config(),
            _noExecutionTargets()
        );

        for (uint256 i = 0; i < SUBJECTS; ++i) {
            subjects.push(makeAddr(string.concat("subject", vm.toString(i))));
            vm.deal(subjects[i], 10 ether);
        }
    }

    function _config() internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.delegable = true;
        config.weighted = true;
        config.openToAll = false;
        return config;
    }

    /// @dev Opens the poll with a weight for every subject. Weights are assigned
    ///      once and never changed afterwards, so any drift in the sums below is
    ///      attributable to delegation and not to the weight table.
    function _openPoll() internal {
        address[] memory all = subjects;
        uint256[] memory weights = new uint256[](SUBJECTS);

        for (uint256 i = 0; i < SUBJECTS; ++i) {
            weights[i] = (i % 5) + 1; // 1..5, deliberately not uniform
        }

        vm.startPrank(creator);
        poll.setWhitelist(all, true);
        poll.setWeights(all, weights);
        poll.startPoll();
        vm.stopPrank();

        assignedWeight = weights;
    }

    /// @notice The sum of everybody's own power, read from the weight table.
    function _ownPowerTotal() internal view returns (uint256 total) {
        for (uint256 i = 0; i < SUBJECTS; ++i) {
            total += assignedWeight[i];
        }
    }

    /// @notice The sum of everybody's controlled power.
    function _controlledPowerTotal() internal view returns (uint256 total) {
        for (uint256 i = 0; i < SUBJECTS; ++i) {
            total += poll.controlledPowerOf(subjects[i]);
        }
    }

    function _assertConserved(string memory context) internal view {
        uint256 own = _ownPowerTotal();
        uint256 controlled = _controlledPowerTotal();

        if (own != controlled) {
            revert(
                string.concat(
                    context,
                    ": power is not conserved (own ",
                    vm.toString(own),
                    ", controlled ",
                    vm.toString(controlled),
                    ")"
                )
            );
        }
    }

    // ---------------------------------------------------------------------
    // The property
    // ---------------------------------------------------------------------

    function test_Conservation_HoldsBeforeAnyDelegation() public {
        _openPoll();

        _assertConserved("no delegation yet");
    }

    function test_Conservation_HoldsUnderRandomisedSequences() public {
        _openPoll();

        for (uint256 round = 0; round < ROUNDS; ++round) {
            uint256 subject = uint256(keccak256(abi.encode("subject", round))) % SUBJECTS;
            uint256 other = uint256(keccak256(abi.encode("other", round))) % SUBJECTS;
            uint256 action = uint256(keccak256(abi.encode("action", round))) % 4;

            if (subject == other) continue;

            if (action == 0) {
                vm.prank(subjects[subject]);
                try poll.delegate(subjects[other]) {} catch {}
            } else if (action == 1) {
                vm.prank(subjects[subject]);
                try poll.delegate(address(0)) {} catch {}
            } else if (action == 2) {
                // Re-delegate without undelegating first: the delta must be
                // adjusted twice, once to remove from the old delegate and once
                // to add to the new.
                vm.prank(subjects[subject]);
                try poll.delegate(subjects[other]) {} catch {}
            } else {
                // The delegate acts, spending the subject's power through its
                // own ballot. This is the path where a delta is easiest to get
                // wrong, because the subject is not the caller.
                if (poll.phase() == Poll.Phase.Voting) {
                    vm.prank(subjects[subject]);
                    try poll.vote{ value: STAKE }(_one(1)) {} catch {}
                }
            }

            _assertConserved(string.concat("round ", vm.toString(round)));
        }
    }

    function test_Conservation_HoldsWhenADelegateSpendsTheDelegatedPower() public {
        // The single most important case, run deliberately rather than hoping
        // the randomised loop reaches it: A delegates to B, B votes, and A's
        // power must still be A's to account for while B is the one who spent
        // it.
        _openPoll();

        vm.prank(subjects[0]);
        poll.delegate(subjects[1]);

        uint256 alicePower = assignedWeight[0];
        uint256 bobOwn = assignedWeight[1];

        assertEq(
            poll.controlledPowerOf(subjects[1]),
            bobOwn + alicePower,
            "the delegate controls both"
        );
        assertEq(
            poll.controlledPowerOf(subjects[0]),
            0,
            "and the subject controls none of it while the delegation stands"
        );

        _assertConserved("after delegating");

        vm.prank(subjects[1]);
        poll.vote{ value: STAKE }(_one(1));

        _assertConserved("after the delegate voted");

        // The authority CANNOT be taken back now: the delegate's ballot carries
        // this subject's weight, so revoking would leave that weight counted
        // both in the cast ballot and on the subject's own account. Refusing is
        // the mirror of `DelegatorHasVoted` — authority moves exactly once per
        // poll, enforced from both ends. This refusal is what the conservation
        // property demanded; before it existed, the sum came out one subject's
        // weight too high.
        vm.prank(subjects[0]);
        vm.expectRevert(abi.encodeWithSelector(Poll.DelegateHasVoted.selector, subjects[1]));
        poll.delegate(address(0));

        _assertConserved("after the refused revocation");
    }

    function test_Conservation_RevocationIsAllowedWhileTheDelegateHasNotVoted() public {
        // The other half: before the delegate acts, the authority comes back
        // cleanly. Without this, refusing every revocation would also satisfy
        // the conservation property — by making the feature useless.
        _openPoll();

        vm.prank(subjects[0]);
        poll.delegate(subjects[1]);

        uint256 alicePower = assignedWeight[0];

        vm.prank(subjects[0]);
        poll.delegate(address(0));

        assertEq(poll.controlledPowerOf(subjects[0]), alicePower, "A has its own power again");
        assertEq(poll.controlledPowerOf(subjects[1]), assignedWeight[1], "and B is back to its own");

        _assertConserved("after a revocation that was allowed");
    }

    function test_Conservation_RevokingWithNothingDelegatedIsANoOp() public {
        // `delegate(address(0))` is also how a caller says "make sure I hold my
        // own authority", and that is already true. Reverting would make the
        // idempotent form fail while the state it asks for is the state it is
        // already in.
        _openPoll();

        vm.prank(subjects[0]);
        poll.delegate(address(0));

        assertEq(poll.controlledPowerOf(subjects[0]), assignedWeight[0]);

        _assertConserved("after a no-op revocation");
    }

    function test_Conservation_TurnoutNeverExceedsOneHundredPercent() public {
        // The consequence of conservation that a user can actually SEE. If
        // delegated power were double-counted, the tally could exceed the
        // frozen denominator and the turnout figure would read above 10000 bps
        // while the quorum check still passed — two numbers that cannot both be
        // right.
        _openPoll();

        // Everybody delegates to one address, which then votes once.
        for (uint256 i = 1; i < SUBJECTS; ++i) {
            vm.prank(subjects[i]);
            poll.delegate(subjects[0]);
        }

        vm.prank(subjects[0]);
        poll.vote{ value: STAKE }(_one(1));

        (, uint256 tally) = poll.results();

        assertEq(tally, _ownPowerTotal(), "one ballot carries every weight exactly once");
        assertLe(poll.turnoutBps(), 10_000, "turnout cannot exceed 100%");
        assertEq(poll.turnoutBps(), 10_000, "and here it is exactly 100%");
    }

    function test_Conservation_UndelgatingRestoresTheOriginalSplit() public {
        // The round trip: whatever the intermediate states were, delegating and
        // then revoking must return every address to its own power. A delta
        // applied twice, or applied with the wrong sign on one of the two paths,
        // shows up here even when no single step looked wrong.
        _openPoll();

        // Everybody to subject 0.
        for (uint256 i = 1; i < SUBJECTS; ++i) {
            vm.prank(subjects[i]);
            poll.delegate(subjects[0]);
        }

        // Half of them take it back. Subject 0 delegated to nobody, so its call
        // is a no-op — included deliberately, since that path must not revert.
        for (uint256 i = 0; i < SUBJECTS / 2; ++i) {
            vm.prank(subjects[i]);
            poll.delegate(address(0));
        }

        _assertConserved("after a partial revocation");

        // The rest move to a different delegate. The target must be an address
        // that currently holds NO delegation of its own — naming one that still
        // delegates would be refused by `CannotDelegateToADelegate`, which is
        // the single-level rule working. `subjects[1]` revoked above, so it is
        // eligible.
        for (uint256 i = SUBJECTS / 2; i < SUBJECTS; ++i) {
            vm.prank(subjects[i]);
            poll.delegate(subjects[1]);
        }

        _assertConserved("after re-delegating");

        // And everybody back to their own authority.
        for (uint256 i = 0; i < SUBJECTS; ++i) {
            vm.prank(subjects[i]);
            poll.delegate(address(0));
        }

        for (uint256 i = 0; i < SUBJECTS; ++i) {
            assertEq(
                poll.controlledPowerOf(subjects[i]),
                assignedWeight[i],
                "every address is back to exactly its own power"
            );
        }

        _assertConserved("after the full round trip");
    }

    function test_Conservation_FrozenDenominatorEqualsThePowerSum() public {
        // The denominator and the power table must agree: a quorum measured
        // against a number that is not the total assigned power would be a
        // fraction of nothing in particular.
        _openPoll();

        assertEq(
            poll.frozenEligiblePower(),
            _ownPowerTotal(),
            "the denominator is the sum of the assigned weights"
        );
        assertEq(
            poll.frozenEligiblePower(),
            _controlledPowerTotal(),
            "and delegation does not change it"
        );
    }

    function test_Conservation_DelegationDoesNotChangeTheDenominator() public {
        _openPoll();

        uint256 frozen = poll.frozenEligiblePower();

        for (uint256 i = 1; i < SUBJECTS; ++i) {
            vm.prank(subjects[i]);
            poll.delegate(subjects[0]);
        }

        assertEq(poll.frozenEligiblePower(), frozen, "the denominator is frozen, delegation or not");
    }
}
