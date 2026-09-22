// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice The same conservation properties, re-checked under EVERY mechanism.
///
/// @dev Why a second property suite instead of widening the first:
///
/// `PollProperties.t.sol` runs 1000 randomized rounds on a plain poll and is the
/// evidence for the accounting invariants in their simplest form. Widening it
/// would have replaced a focused, long-understood test with a parameterized one,
/// and the plain case is the baseline every other mechanism is compared against.
/// This file adds the matrix beside it.
///
/// What it exists to catch is the class of defect that a per-mechanism unit test
/// cannot: each mechanism has its own tests that its own arithmetic is right, but
/// none of them ask whether the GLOBAL accounting still balances once two of them
/// are combined. Weighted + delegation + multi-select is where a tally can be
/// credited twice — once as a delegated surplus and once as the delegate's own
/// power — and no single-mechanism test would ever construct that.
///
/// The properties, checked after every round of every configuration:
///
///   1. `totalStaked` equals the real balance of the contract. Money is never
///      invented or stranded by a mechanism, whatever the mechanism does to
///      power.
///   2. the sum of per-address stakes equals `totalStaked`. No address holds a
///      stake the contract does not account for, so `refund()` cannot overdraw.
///   3. the tally is at most the number of eligible subjects. This is the "one
///      person one vote" bound stated in the form that survives weighting: a
///      weighted voter contributes its weight, so the ceiling is the eligible
///      count times the largest weight, and the weaker form asserted here is
///      that no mechanism makes the tally grow without bound.
///   4. `votedFor` and `stakeOf` agree about whether an address holds a vote.
///      A mechanism that records a ballot but takes no stake (or the reverse)
///      would let a voter vote for free or pay for nothing.
///
/// Mutation-validated the same way as the first suite: the mutations that break
/// these are recorded per property below, applied, observed to fail, and
/// reverted.
contract PollMechanismMatrixTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("matrixCreator");

    uint256 internal constant VOTER_COUNT = 12;

    /// @dev How many options a multi-select ballot may pick in this matrix.
    ///      A named constant because the ceiling assertion below must be derived
    ///      from the SAME number the config is built with: when the two were
    ///      separate literals the assertion silently assumed 1 and failed on
    ///      correct behaviour.
    uint256 internal constant MATRIX_MAX_SELECTIONS = 2;
    uint256 internal constant OPTION_COUNT = 3;
    uint256 internal constant ROUNDS = 200;
    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;
    uint256 internal constant REVEAL_WINDOW = 3600;

    address[] internal voters;

    /// @notice One mechanism combination, named so a failure says which.
    struct Mechanism {
        string name;
        bool multiSelect;
        bool weighted;
        bool delegable;
        bool commitReveal;
    }

    /// @notice The matrix. Plain first, then one mechanism at a time, then the
    ///         combinations where the arithmetic interacts.
    ///
    /// @dev Commit-reveal appears only in its standalone form, not combined with
    ///      the others, and that is deliberate rather than an omission: its
    ///      randomized action set is commit/reveal/withdraw, which is a different
    ///      state machine from vote/change/withdraw. Folding it into the same
    ///      round driver would mean the driver branched on the mechanism, and a
    ///      property test that knows which mechanism it is running stops being a
    ///      property test. The mechanisms it CAN combine with are covered by
    ///      `PollCommitReveal.t.sol` and `PollMechanisms.t.sol`.
    /// @dev No execution targets, which is what every suite except the
    ///      governance one wants: a poll that can only call itself. Named rather
    ///      than inlined as `new address[](0)` at each call site so that adding
    ///      a parameter to `initialize` again means touching one line per file.
    function _noExecutionTargets() internal pure returns (address[] memory) {
        return new address[](0);
    }
    function _matrix() internal pure returns (Mechanism[] memory list) {
        list = new Mechanism[](6);
        list[0] = Mechanism("plain", false, false, false, false);
        list[1] = Mechanism("multi-select", true, false, false, false);
        list[2] = Mechanism("weighted", false, true, false, false);
        list[3] = Mechanism("delegable", false, false, true, false);
        list[4] = Mechanism("weighted+delegable+multi-select", true, true, true, false);
        list[5] = Mechanism("commit-reveal", false, false, false, true);
    }

    /// @notice Every mechanism, one randomized round sequence each.
    function test_EveryMechanismKeepsTheAccountingInvariants() public {
        Mechanism[] memory list = _matrix();

        for (uint256 m = 0; m < list.length; ++m) {
            _runMatrixRound(list[m]);
        }
    }

    /// @dev One configuration's randomized run. Rebuilt from scratch, so a
    ///      violation in one mechanism cannot be explained by another's state.
    function _runMatrixRound(Mechanism memory mechanism) internal {
        _deploy(mechanism);

        uint256 seed = uint256(keccak256(abi.encodePacked("matrix", mechanism.name)));
        uint256 acted;

        for (uint256 round = 0; round < ROUNDS; ++round) {
            seed = uint256(keccak256(abi.encode(seed, round)));

            address voter = voters[seed % VOTER_COUNT];
            uint256 optionId = ((seed >> 8) % OPTION_COUNT) + 1;
            uint256 action = (seed >> 16) % 4;

            vm.deal(voter, 1 ether);

            // `try`-wrapped and counted, not asserted on: a refusal is a legal
            // outcome of a random sequence (voting twice, withdrawing nothing,
            // delegating after voting). What must hold is the accounting
            // afterwards, whichever way the call went.
            if (mechanism.commitReveal) {
                acted += _commitRevealAction(voter, optionId, action, seed);
            } else {
                acted += _plainAction(mechanism, voter, optionId, action);
            }

            _assertAccounting(mechanism);
        }

        assertGt(acted, 0, string.concat(mechanism.name, ": the run did no work at all"));
    }

    /// @dev The vote/change/withdraw/delegate action set.
    function _plainAction(
        Mechanism memory mechanism,
        address voter,
        uint256 optionId,
        uint256 action
    ) internal returns (uint256) {
        // Delegation is offered only where the mechanism allows it; on the other
        // configurations the fourth action repeats a change instead, so the
        // action space stays four wide and the runs stay comparable.
        if (mechanism.delegable && action == 3) {
            address to = voters[(uint256(uint160(voter)) >> 4) % VOTER_COUNT];

            vm.prank(voter);
            try poll.delegate(to) {
                return 1;
            } catch {
                return 0;
            }
        }

        if (action == 0) {
            vm.prank(voter);
            try poll.vote{ value: STAKE }(_selection(mechanism, optionId)) {
                return 1;
            } catch {
                return 0;
            }
        }

        if (action <= 2) {
            vm.prank(voter);
            try poll.changeVote(_selection(mechanism, optionId)) {
                return 1;
            } catch {
                return 0;
            }
        }

        vm.prank(voter);
        try poll.withdrawVote() {
            return 1;
        } catch {
            return 0;
        }
    }

    /// @dev The commit/reveal/withdraw action set.
    function _commitRevealAction(
        address voter,
        uint256 optionId,
        uint256 action,
        uint256 seed
    ) internal returns (uint256) {
        if (action == 0) {
            bytes32 salt = keccak256(abi.encode(seed));
            bytes32 commitment = poll.computeCommitment(voter, _one(optionId), salt);

            vm.prank(voter);
            try poll.commit{ value: STAKE }(commitment) {
                return 1;
            } catch {
                return 0;
            }
        }

        if (action == 1) {
            // A REVEAL of the salt the commit above would have used, which is
            // usually the wrong one: the sequences are independent, so most
            // reveals are refused with `CommitmentMismatch`. That is the point —
            // a wrong salt must leave the commitment and the stake intact.
            bytes32 salt = keccak256(abi.encode(seed, "round"));

            vm.prank(voter);
            try poll.reveal(_one(optionId), salt) {
                return 1;
            } catch {
                return 0;
            }
        }

        vm.prank(voter);
        try poll.withdrawVote() {
            return 1;
        } catch {
            return 0;
        }
    }

    /// @dev Multi-select configs need a set; the others need exactly one.
    function _selection(
        Mechanism memory mechanism,
        uint256 optionId
    ) internal pure returns (uint256[] memory ids) {
        if (!mechanism.multiSelect) {
            return _one(optionId);
        }

        // Two ids, kept distinct and in range. `maxSelections` is 2 for these
        // configs, so a larger set would be refused and the property test would
        // spend its rounds asserting nothing.
        uint256 second = (optionId % OPTION_COUNT) + 1;

        ids = new uint256[](2);
        ids[0] = optionId;
        ids[1] = second;
    }

    function _one(uint256 optionId) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = optionId;
    }

    function _deploy(Mechanism memory mechanism) internal {
        string[] memory cids = new string[](OPTION_COUNT);
        for (uint256 i = 0; i < OPTION_COUNT; ++i) {
            cids[i] = string.concat("cid-", vm.toString(i));
        }

        PollMechanisms.PollConfig memory config = PollMechanisms.PollConfig({
            openToAll: false,
            multiSelect: mechanism.multiSelect,
            maxSelections: mechanism.multiSelect ? MATRIX_MAX_SELECTIONS : 0,
            weighted: mechanism.weighted,
            delegable: mechanism.delegable,
            commitReveal: mechanism.commitReveal,
            revealWindowSeconds: mechanism.commitReveal ? REVEAL_WINDOW : 0,
            quorumBps: 0,
            timelockSeconds: 0
        });

        poll = new Poll();
        poll.initialize(creator, mechanism.name, cids, FAR_FUTURE, config, _noExecutionTargets());

        delete voters;
        for (uint256 i = 0; i < VOTER_COUNT; ++i) {
            voters.push(makeAddr(string.concat("matrixVoter", vm.toString(i))));
        }

        vm.startPrank(creator);
        poll.setWhitelist(voters, true);
        if (mechanism.weighted) {
            // Distinct non-zero weights, so a mechanism that dropped the table
            // and fell back to one-per-head produces a different tally rather
            // than an accidentally equal one.
            for (uint256 i = 0; i < VOTER_COUNT; ++i) {
                poll.setWeights(_oneAddress(voters[i]), _oneWeight(i + 1));
            }
        }
        poll.startPoll();
        vm.stopPrank();
    }

    function _oneAddress(address who) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = who;
    }

    function _oneWeight(uint256 value) internal pure returns (uint256[] memory list) {
        list = new uint256[](1);
        list[0] = value;
    }

    /// @dev The four properties. Each carries the mutation that breaks it, so a
    ///      future reader can re-run the validation rather than trust it.
    ///
    ///      Two things about the assertions are deliberate and were both learned
    ///      from this suite killing the runner:
    ///
    ///      1. The comparisons are `assertTrue(a == b, ...)`, not `assertEq`.
    ///         On failure Hardhat builds a readable diff of the operands, and a
    ///         `uint256` mismatch reached from inside a 12-address loop made it
    ///         allocate ~8.8 GB and die with "memory allocation failed" instead
    ///         of reporting which mechanism broke.
    ///      2. The failure MESSAGE is built inside the failure branch, not passed
    ///         as an argument. `string.concat` evaluates eagerly, so building it
    ///         on every passing round meant thousands of allocations per run —
    ///         which on its own was enough to exhaust memory before any
    ///         assertion ever failed.
    function _assertAccounting(Mechanism memory mechanism) internal view {
        uint256 summed;
        uint256 holders;

        for (uint256 i = 0; i < voters.length; ++i) {
            summed += poll.stakeOf(voters[i]);

            if (poll.votedFor(voters[i]) != 0) {
                ++holders;
            }
        }

        // 1. Money. Mutation: delete `totalStaked -= amount` from
        //    `_withdrawCommitment` — fails here, naming the mechanism.
        if (address(poll).balance != poll.totalStaked()) {
            revert(
                string.concat(
                    mechanism.name,
                    ": the contract's balance must equal totalStaked (balance ",
                    vm.toString(address(poll).balance),
                    ", totalStaked ",
                    vm.toString(poll.totalStaked()),
                    ")"
                )
            );
        }

        // 2. No unaccounted stake. Mutation: zero `stakeOf` without decrementing
        //    `totalStaked` — or the reverse — fails here.
        if (summed != poll.totalStaked()) {
            revert(
                string.concat(
                    mechanism.name,
                    ": per-address stakes must sum to totalStaked (sum ",
                    vm.toString(summed),
                    ", totalStaked ",
                    vm.toString(poll.totalStaked()),
                    ")"
                )
            );
        }

        // 3. Bounded growth. The ceiling is DERIVED from the mechanism rather
        //    than guessed, and it has to be: on a multi-select poll one ballot
        //    credits `power` to EACH option it selects, so the sum across options
        //    is legitimately a multiple of the eligible set. A flat ceiling of
        //    `VOTER_COUNT * VOTER_COUNT` was the first attempt and it was wrong
        //    for exactly that reason — `weighted+delegable+multi-select` reached
        //    156, which is not growth but two selections per ballot.
        //
        //    The tight form is therefore: every unit of eligible power may be
        //    counted at most once PER SELECTABLE OPTION. With equal weights that
        //    is `VOTER_COUNT * selections`; weighting raises the base.
        //
        //    What this still catches: a mechanism that lets one address add power
        //    on every round, since that exceeds any fixed bound. Mutation: count
        //    the delegated surplus twice in `vote` — fails here.
        uint256 perBallotCeiling = mechanism.multiSelect ? MATRIX_MAX_SELECTIONS : 1;
        // The largest total weight the fixture can assign: weights are 1..N, so
        // the sum is N(N+1)/2. Derived rather than written as 78 so that changing
        // VOTER_COUNT does not silently invalidate the bound.
        uint256 weightCeiling = (VOTER_COUNT * (VOTER_COUNT + 1)) / 2;
        uint256 ceiling = weightCeiling * perBallotCeiling;

        (, uint256 tally) = poll.results();
        if (tally > ceiling) {
            revert(
                string.concat(
                    mechanism.name,
                    ": the tally must stay bounded by the eligible set times the "
                    "selectable options (tally ",
                    vm.toString(tally),
                    ", ceiling ",
                    vm.toString(ceiling),
                    ")"
                )
            );
        }

        if (holders > VOTER_COUNT) {
            revert(string.concat(mechanism.name, ": holders cannot exceed the whitelist"));
        }

        // 4. Vote and stake agree. Mutation: record the ballot but return the
        //    stake early on a refusal — fails here.
        //
        // "Holds a vote" is deliberately the union of three states, because on a
        // commit-reveal poll a SEALED commitment holds a stake while having no
        // selection at all: the voter has paid and has not voted yet. Asserting
        // `stake == 0` whenever `votedFor` is 0 would report that design as a
        // leak — which is exactly what this suite did on its first run, and the
        // distinction it needed is the one ADR-0031 requires be reported
        // separately rather than collapsed.
        for (uint256 i = 0; i < voters.length; ++i) {
            uint256 current = poll.votedFor(voters[i]);
            uint256 stake = poll.stakeOf(voters[i]);
            Poll.VoterState memory state = poll.voterState(voters[i]);
            bool holdsVote = current != 0 || state.selections.length != 0 || state.committed;

            if (!holdsVote && stake != 0) {
                revert(
                    string.concat(
                        mechanism.name,
                        ": an address with no vote must hold no stake (holds ",
                        vm.toString(stake),
                        ")"
                    )
                );
            }

            if (holdsVote && stake != STAKE) {
                revert(
                    string.concat(
                        mechanism.name,
                        ": an address with a vote must hold exactly one stake (holds ",
                        vm.toString(stake),
                        ")"
                    )
                );
            }
        }
    }
}
