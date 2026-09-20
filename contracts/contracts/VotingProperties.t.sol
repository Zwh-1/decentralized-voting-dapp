// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Voting } from "./Voting.sol";

/// @notice Long-running property test for `Voting` — spec metric M-4.
///
/// @dev Why this exists instead of an `invariant_*` test:
///
/// Hardhat 3.17.0 does evaluate `invariant_*` functions, but its runner never
/// invokes any target contract function in this configuration, so ghost
/// counters on a handler (or on the test contract itself) stay at zero and any
/// invariant that reads them passes vacuously. That was established
/// experimentally, not assumed:
///
///   * a deliberately false invariant (`assertEq(1, 2)`) does fail, proving the
///     runner evaluates invariants;
///   * with `hasVoted[msg.sender] = true` commented out of `Voting.vote` — a
///     mutation that makes double voting possible and is confirmed to break
///     three ordinary tests — the invariants still passed, proving no vote was
///     ever attempted.
///
/// Rather than ship a test that cannot fail, this suite drives a deterministic
/// 1000-round vote sequence and asserts the same properties after *every*
/// round, while also asserting that the work actually happened. It is validated
/// by the same mutation: with the mutation applied, this test fails.
contract VotingPropertiesTest is Test {
    Voting internal voting;

    address internal admin = makeAddr("admin");

    uint256 internal constant VOTER_COUNT = 40;
    uint256 internal constant CANDIDATE_COUNT = 3;
    uint256 internal constant ROUNDS = 1000;
    uint256 internal constant STAKE = 0.001 ether;

    address[] internal voters;

    function setUp() public {
        voting = new Voting(admin);

        vm.startPrank(admin);
        for (uint256 i = 0; i < CANDIDATE_COUNT; ++i) {
            voting.addCandidate(string.concat("cid-", vm.toString(i)));
        }

        for (uint256 i = 0; i < VOTER_COUNT; ++i) {
            voters.push(makeAddr(string.concat("propertyVoter", vm.toString(i))));
        }

        voting.setWhitelist(voters, true);
        voting.startVoting();
        vm.stopPrank();
    }

    function test_ThousandRoundRandomSequenceKeepsInvariants() public {
        uint256 seed = 0xC0FFEE;
        uint256 accepted;
        uint256 rejected;

        for (uint256 round = 0; round < ROUNDS; ++round) {
            seed = uint256(keccak256(abi.encode(seed, round)));

            address voter = voters[seed % VOTER_COUNT];
            uint256 candidateId = ((seed >> 8) % CANDIDATE_COUNT) + 1;

            vm.deal(voter, STAKE);
            vm.prank(voter);
            try voting.vote{ value: STAKE }(candidateId) {
                ++accepted;
            } catch {
                ++rejected;
            }

            // ---- invariants, re-checked after every single round ----
            (, uint256 total) = voting.results();
            assertEq(total, accepted, "tally must equal the number of accepted votes");
            assertEq(
                voting.totalStaked(),
                accepted * STAKE,
                "accounted stake must equal accepted votes times STAKE"
            );
            assertEq(
                address(voting).balance,
                voting.totalStaked(),
                "real balance must equal accounted stake"
            );
            assertLe(total, VOTER_COUNT, "votes can never exceed the whitelist size");
            assertLe(total, CANDIDATE_COUNT * VOTER_COUNT, "sanity bound on the tally");
        }

        // ---- the run must actually have done work ----
        assertEq(accepted + rejected, ROUNDS, "every round must be accounted for");
        assertEq(accepted, VOTER_COUNT, "with 1000 draws over 40 voters, each votes exactly once");
        assertEq(rejected, ROUNDS - VOTER_COUNT, "every repeat attempt must be rejected");

        uint256 marked;
        for (uint256 i = 0; i < voters.length; ++i) {
            if (voting.hasVoted(voters[i])) {
                ++marked;
            }
        }
        assertEq(marked, accepted, "hasVoted count must equal the number of accepted votes");
    }

    /// @notice A narrower fuzz complement: random candidate and voter counts.
    function testFuzz_VoteAccountingConverges(uint8 rawVoterCount, uint8 candidateSeed) public {
        uint256 voterCount = bound(uint256(rawVoterCount), 1, 20);

        Voting fresh = new Voting(admin);

        address[] memory freshVoters = new address[](voterCount);
        for (uint256 i = 0; i < voterCount; ++i) {
            freshVoters[i] = makeAddr(string.concat("fuzzVoter", vm.toString(i)));
        }

        vm.startPrank(admin);
        fresh.addCandidate("cid-a");
        fresh.addCandidate("cid-b");
        fresh.setWhitelist(freshVoters, true);
        fresh.startVoting();
        vm.stopPrank();

        for (uint256 i = 0; i < voterCount; ++i) {
            uint256 candidateId = (uint256(candidateSeed) + i) % 2 == 0 ? 1 : 2;
            vm.deal(freshVoters[i], STAKE);
            vm.prank(freshVoters[i]);
            fresh.vote{ value: STAKE }(candidateId);
        }

        (, uint256 total) = fresh.results();
        assertEq(total, voterCount, "sum(voteCount) must equal the number of voters");
        assertEq(fresh.totalStaked(), voterCount * STAKE, "custody must match");
    }
}
