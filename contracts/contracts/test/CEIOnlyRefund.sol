// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @dev TEST FIXTURE ONLY — this contract must never be deployed.
///
/// The middle case of the three-way reentrancy comparison: it applies
/// Checks-Effects-Interactions correctly (the stake is zeroed before the
/// external call) but deliberately omits any reentrancy guard.
///
/// Its purpose is to substantiate a specific claim in the design spec: that
/// CEI alone is sufficient to stop this attack, and that `nonReentrant` in
/// `Voting` is defence in depth rather than the load-bearing control. Without
/// this fixture that claim would be an assertion instead of a measurement.
contract CEIOnlyRefund {
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

    function vote(uint256[] calldata optionIds) external payable {
        uint256 candidateId = optionIds[0];
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

    /// @dev SAFE ORDER, NO GUARD: a reentrant call observes `amount == 0`.
    function refund() external {
        uint256 amount = stakeOf[msg.sender];
        require(amount > 0, "nothing to refund");

        // Effect before interaction — this is the whole defence.
        stakeOf[msg.sender] = 0;
        totalStaked -= amount;

        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        require(ok, "transfer failed");

        emit Refunded(msg.sender, amount);
    }
}
