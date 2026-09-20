// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev TEST FIXTURE ONLY — this contract must never be deployed.
///
/// The fourth case of the reentrancy comparison matrix: a reentrancy guard is
/// present, but the refund ordering is deliberately wrong (the external call
/// happens before the stake is zeroed).
///
/// Its purpose is to show that the guard in `Voting` is a functioning control
/// and not decoration. Without this fixture there is no case where the guard is
/// the only thing standing between an attacker and the funds — in `Voting`, CEI
/// already stops the attack first, so the guard's contribution would be
/// unobservable.
contract GuardOnlyRefund is ReentrancyGuard {
    uint256 public constant STAKE = 0.001 ether;

    enum Phase {
        Setup,
        Voting,
        Ended
    }

    Phase public phase;
    uint256 public candidateCount;
    uint256 public totalStaked;

    mapping(address voter => bool) public isWhitelisted;
    mapping(address voter => bool) public hasVoted;
    mapping(address voter => uint256) public stakeOf;

    event VoteCast(address indexed voter, uint256 indexed candidateId, uint256 newCount);
    event Refunded(address indexed voter, uint256 amount);

    function addCandidate() external {
        ++candidateCount;
    }

    function setWhitelist(address[] calldata voters, bool allowed) external {
        for (uint256 i = 0; i < voters.length; ++i) {
            isWhitelisted[voters[i]] = allowed;
        }
    }

    function startVoting() external {
        phase = Phase.Voting;
    }

    function endVoting() external {
        phase = Phase.Ended;
    }

    function vote(uint256 candidateId) external payable {
        require(phase == Phase.Voting, "phase");
        require(isWhitelisted[msg.sender], "whitelist");
        require(!hasVoted[msg.sender], "already voted");
        require(candidateId > 0 && candidateId <= candidateCount, "candidate");
        require(msg.value == STAKE, "stake");

        hasVoted[msg.sender] = true;
        stakeOf[msg.sender] = msg.value;
        totalStaked += msg.value;

        emit VoteCast(msg.sender, candidateId, 0);
    }

    /// @dev GUARD ONLY: ordering is still wrong, the guard is the sole defence.
    function refund() external nonReentrant {
        uint256 amount = stakeOf[msg.sender];
        require(amount > 0, "nothing to refund");

        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        require(ok, "transfer failed");

        stakeOf[msg.sender] = 0;
        totalStaked -= amount;

        emit Refunded(msg.sender, amount);
    }
}
