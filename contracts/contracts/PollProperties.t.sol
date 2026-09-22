// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";

/// @notice Long-running property test for `Poll` �?spec metric M-4.
///
/// @dev Why this exists instead of an `invariant_*` test:
///
/// Hardhat 3.17.0 does evaluate `invariant_*` functions, but its runner never
/// invokes any target contract function in this configuration, so ghost
/// counters on a handler (or on the test contract itself) stay at zero and any
/// invariant that reads them passes vacuously. That was established
/// experimentally, not assumed �?the full experiment is recorded in the design
/// spec's correction log and this suite keeps the same shape as the one it
/// replaced.
///
/// What changed with `Poll`: a vote is no longer a one-way door, so the old
/// "accepted votes == tally" invariant is not enough. The sequence below
/// interleaves `vote`, `changeVote` and `withdrawVote`, and re-checks four
/// properties after *every* round:
///
///   1. the tally equals the number of addresses currently holding a vote;
///   2. accounted stake equals that count times STAKE;
///   3. the contract's real balance equals the accounted stake;
///   4. no address ever holds two stakes' worth, and `votedFor` and `stakeOf`
///      agree about whether it holds a vote at all.
///
/// It is validated by mutation, not by assertion: decrementing the wrong option
/// in `changeVote` (or skipping the decrement entirely) makes property 1 fail
/// within a few rounds. The mutation was applied, observed to fail, and
/// reverted; the failing output is recorded in the spec's correction log.
contract PollPropertiesTest is Test {
    Poll internal poll;

    address internal creator = makeAddr("creator");

    uint256 internal constant VOTER_COUNT = 40;
    uint256 internal constant OPTION_COUNT = 3;
    uint256 internal constant ROUNDS = 1000;
    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;

    address[] internal voters;

    function setUp() public {
        string[] memory cids = new string[](OPTION_COUNT);
        for (uint256 i = 0; i < OPTION_COUNT; ++i) {
            cids[i] = string.concat("cid-", vm.toString(i));
        }

        poll = new Poll();
        poll.initialize(creator, "Property poll", cids, FAR_FUTURE, false);

        for (uint256 i = 0; i < VOTER_COUNT; ++i) {
            voters.push(makeAddr(string.concat("propertyVoter", vm.toString(i))));
        }

        vm.startPrank(creator);
        poll.setWhitelist(voters, true);
        poll.startPoll();
        vm.stopPrank();
    }

    /// @notice The number of addresses that currently hold a vote, read back
    ///         from the per-address state rather than from a ghost counter.
    function _holdersFromState() internal view returns (uint256 holders, uint256 accountedStake) {
        for (uint256 i = 0; i < voters.length; ++i) {
            uint256 current = poll.votedFor(voters[i]);
            uint256 stake = poll.stakeOf(voters[i]);

            if (current != 0) {
                ++holders;
            }

            accountedStake += stake;
        }
    }

    /// @dev Property 4, checked separately so a violation reports its own
    ///      message instead of aborting the round bookkeeping.
    function _assertSlotsAgree() internal view {
        for (uint256 i = 0; i < voters.length; ++i) {
            uint256 current = poll.votedFor(voters[i]);
            uint256 stake = poll.stakeOf(voters[i]);

            if (current == 0) {
                assertEq(stake, 0, "an address with no vote must hold no stake");
            } else {
                assertEq(stake, STAKE, "an address with a vote must hold exactly one stake");
            }
        }
    }

    function test_ThousandRoundRandomSequenceKeepsInvariants() public {
        uint256 seed = 0xC0FFEE;
        uint256 accepted;
        uint256 changed;
        uint256 withdrawn;
        uint256 refused;

        for (uint256 round = 0; round < ROUNDS; ++round) {
            seed = uint256(keccak256(abi.encode(seed, round)));

            address voter = voters[seed % VOTER_COUNT];
            uint256 optionId = ((seed >> 8) % OPTION_COUNT) + 1;
            uint256 action = (seed >> 16) % 3;

            vm.deal(voter, 1 ether);

            if (action == 0) {
                vm.prank(voter);
                try poll.vote{ value: STAKE }(optionId) {
                    ++accepted;
                } catch {
                    ++refused;
                }
            } else if (action == 1) {
                vm.prank(voter);
                try poll.changeVote(optionId) {
                    ++changed;
                } catch {
                    ++refused;
                }
            } else {
                vm.prank(voter);
                try poll.withdrawVote() {
                    ++withdrawn;
                } catch {
                    ++refused;
                }
            }

            // ---- invariants, re-checked after every single round ----
            (uint256 holders, uint256 accountedStake) = _holdersFromState();

            (, uint256 tally) = poll.results();

            assertEq(tally, holders, "the tally must equal the number of current voters");
            assertEq(
                poll.totalStaked(),
                holders * STAKE,
                "accounted stake must equal current voters times STAKE"
            );
            assertEq(
                address(poll).balance,
                poll.totalStaked(),
                "real balance must equal accounted stake"
            );
            assertEq(accountedStake, poll.totalStaked(), "per-address stakes must sum to the total");
            assertLe(tally, VOTER_COUNT, "the tally can never exceed the whitelist size");

            _assertSlotsAgree();
        }

        // ---- the run must actually have done all three kinds of work ----
        assertEq(
            accepted + changed + withdrawn + refused,
            ROUNDS,
            "every round must be accounted for"
        );
        assertGt(accepted, 0, "some votes were cast");
        assertGt(changed, 0, "some votes were changed, or this proves nothing about change");
        assertGt(withdrawn, 0, "some votes were withdrawn");
        assertGt(refused, 0, "some attempts were refused, and none of them corrupted the tally");
    }

    /// @notice A narrower fuzz complement: random voter counts.
    function testFuzz_VoteAccountingConverges(uint8 rawVoterCount) public {
        uint256 voterCount = bound(uint256(rawVoterCount), 1, 20);

        string[] memory cids = new string[](2);
        cids[0] = "cid-a";
        cids[1] = "cid-b";

        Poll fresh = new Poll();
        fresh.initialize(creator, "Fuzz poll", cids, FAR_FUTURE, false);

        address[] memory freshVoters = new address[](voterCount);
        for (uint256 i = 0; i < voterCount; ++i) {
            freshVoters[i] = makeAddr(string.concat("fuzzVoter", vm.toString(i)));
        }

        vm.startPrank(creator);
        fresh.setWhitelist(freshVoters, true);
        fresh.startPoll();
        vm.stopPrank();

        // Everyone votes, then everyone changes once.
        for (uint256 i = 0; i < voterCount; ++i) {
            vm.deal(freshVoters[i], 1 ether);
            vm.prank(freshVoters[i]);
            fresh.vote{ value: STAKE }(1);
        }

        for (uint256 i = 0; i < voterCount; ++i) {
            vm.prank(freshVoters[i]);
            fresh.changeVote(2);
        }

        (, uint256 total) = fresh.results();
        assertEq(total, voterCount, "sum(voteCount) must equal the number of voters");
        assertEq(fresh.totalStaked(), voterCount * STAKE, "custody must match");
        assertEq(address(fresh).balance, fresh.totalStaked(), "balance must match accounting");
    }

    /// @notice Every voter withdraws; the poll must end up holding nothing.
    function test_AllWithdrawalsDrainTheTallyAndTheCustody() public {
        for (uint256 i = 0; i < VOTER_COUNT; ++i) {
            vm.deal(voters[i], 1 ether);
            vm.prank(voters[i]);
            poll.vote{ value: STAKE }(1);
        }

        assertEq(poll.totalStaked(), VOTER_COUNT * STAKE, "everyone staked");

        for (uint256 i = 0; i < VOTER_COUNT; ++i) {
            vm.prank(voters[i]);
            poll.withdrawVote();
        }

        (, uint256 total) = poll.results();
        assertEq(total, 0, "no votes remain");
        assertEq(poll.totalStaked(), 0, "no stake remains");
        assertEq(address(poll).balance, 0, "no ether remains");
    }
}
