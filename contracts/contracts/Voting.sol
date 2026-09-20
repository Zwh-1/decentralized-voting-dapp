// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Voting
/// @notice A whitelist-gated, on-chain ballot with a refundable anti-spam stake.
///
/// Design notes that matter for review:
///
/// 1. Phases are modelled as an explicit state machine instead of two
///    timestamps. Every state-changing entry point therefore has exactly one
///    legality predicate (`phase == ...`), which is cheaper to reason about and
///    impossible to satisfy by manipulating block timestamps.
/// 2. Ballots are PUBLIC. `votedFor` is readable by anyone, so this contract
///    provides no vote privacy. See the README for why that trade-off was made.
/// 3. The stake exists so that `refund()` performs a real external call. That is
///    what makes the reentrancy guard load-bearing rather than decorative.
///    `vote()` itself has no external call and no reentrancy surface.
/// 4. The stake is NOT sybil resistance. It is returned in full, so it costs an
///    attacker nothing; the whitelist is the actual sybil defence.
contract Voting is Ownable, ReentrancyGuard {
    /// @notice Exact stake required to cast a vote, in wei.
    uint256 public constant STAKE = 0.001 ether;

    /// @notice How long after the ballot closes voters may still claim refunds.
    uint256 public constant REFUND_GRACE_PERIOD = 30 days;

    enum Phase {
        Setup,
        Voting,
        Ended
    }

    struct Candidate {
        uint256 id;
        string metadataCID;
        uint256 voteCount;
    }

    /// @notice Current stage of the ballot lifecycle.
    Phase public phase;

    /// @notice Number of candidates added so far. Ids are 1-based.
    uint256 public candidateCount;

    /// @notice Total stake currently held by this contract.
    uint256 public totalStaked;

    /// @notice Timestamp at which voting ended; 0 until `endVoting` is called.
    uint256 public votingEndedAt;

    mapping(uint256 id => Candidate) private _candidates;
    mapping(address voter => bool) public isWhitelisted;
    mapping(address voter => bool) public hasVoted;
    mapping(address voter => uint256) public stakeOf;
    mapping(address voter => uint256) public votedFor;

    error InvalidPhase(Phase expected, Phase actual);
    error NotWhitelisted(address voter);
    error AlreadyVoted(address voter);
    error UnknownCandidate(uint256 candidateId);
    error IncorrectStake(uint256 expected, uint256 received);
    error NoCandidates();
    error NothingToRefund();
    error GracePeriodNotElapsed(uint256 availableAt);
    error TransferFailed();
    error ZeroAddress();

    event CandidateAdded(uint256 indexed id, string metadataCID);
    event WhitelistUpdated(address indexed voter, bool allowed);
    event PhaseChanged(Phase indexed from, Phase indexed to);
    event VoteCast(address indexed voter, uint256 indexed candidateId, uint256 newCount);
    event Refunded(address indexed voter, uint256 amount);
    event UnclaimedSwept(address indexed to, uint256 amount);

    constructor(address initialOwner) Ownable(initialOwner) {
        phase = Phase.Setup;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Append a candidate whose metadata is stored off-chain on IPFS.
    function addCandidate(string calldata metadataCID) external onlyOwner {
        if (phase != Phase.Setup) revert InvalidPhase(Phase.Setup, phase);

        uint256 id = ++candidateCount;
        _candidates[id] = Candidate({ id: id, metadataCID: metadataCID, voteCount: 0 });

        emit CandidateAdded(id, metadataCID);
    }

    /// @notice Grant or revoke voting rights for a batch of addresses.
    function setWhitelist(address[] calldata voters, bool allowed) external onlyOwner {
        if (phase == Phase.Ended) revert InvalidPhase(Phase.Voting, phase);

        uint256 length = voters.length;
        for (uint256 i = 0; i < length; ++i) {
            address voter = voters[i];
            if (voter == address(0)) revert ZeroAddress();

            isWhitelisted[voter] = allowed;
            emit WhitelistUpdated(voter, allowed);
        }
    }

    /// @notice Open the ballot.
    function startVoting() external onlyOwner {
        if (phase != Phase.Setup) revert InvalidPhase(Phase.Setup, phase);
        if (candidateCount == 0) revert NoCandidates();

        _setPhase(Phase.Voting);
    }

    /// @notice Close the ballot and start the refund grace period.
    function endVoting() external onlyOwner {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);

        votingEndedAt = block.timestamp;
        _setPhase(Phase.Ended);
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    /// @notice Cast a vote for `candidateId`, staking exactly `STAKE` wei.
    /// @dev No external call happens in this function, so there is no
    ///      reentrancy surface here. `nonReentrant` is applied for uniformity
    ///      with `refund()` rather than necessity.
    function vote(uint256 candidateId) external payable nonReentrant {
        // Checks
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (!isWhitelisted[msg.sender]) revert NotWhitelisted(msg.sender);
        if (hasVoted[msg.sender]) revert AlreadyVoted(msg.sender);
        if (candidateId == 0 || candidateId > candidateCount) {
            revert UnknownCandidate(candidateId);
        }
        if (msg.value != STAKE) revert IncorrectStake(STAKE, msg.value);

        // Effects
        hasVoted[msg.sender] = true;
        votedFor[msg.sender] = candidateId;
        stakeOf[msg.sender] = msg.value;
        totalStaked += msg.value;

        uint256 newCount = ++_candidates[candidateId].voteCount;

        // Interactions: none.
        emit VoteCast(msg.sender, candidateId, newCount);
    }

    // ---------------------------------------------------------------------
    // Refunds
    // ---------------------------------------------------------------------

    /// @notice Reclaim the stake deposited when voting.
    /// @dev This is the only function in the contract that makes an external
    ///      call, and therefore the only place a reentrancy guard is genuinely
    ///      required. Protection is layered:
    ///        1. Checks-Effects-Interactions: `stakeOf` is zeroed BEFORE the
    ///           call, so a reentrant call sees nothing to refund.
    ///        2. `nonReentrant`: defence in depth if the ordering above is ever
    ///           refactored away.
    ///      The test suite proves both layers with an attacking contract; see
    ///      `Voting.t.sol::test_Reentrancy_*`.
    function refund() external nonReentrant {
        if (phase != Phase.Ended) revert InvalidPhase(Phase.Ended, phase);

        uint256 amount = stakeOf[msg.sender];
        if (amount == 0) revert NothingToRefund();

        // Effect before interaction.
        stakeOf[msg.sender] = 0;
        totalStaked -= amount;

        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        if (!ok) revert TransferFailed();

        emit Refunded(msg.sender, amount);
    }

    /// @notice Transfer stakes never claimed during the grace period.
    /// @dev Centralisation risk, documented in the README: an owner can move
    ///      funds that a slow voter still intended to claim.
    function sweepUnclaimed(address to) external onlyOwner {
        if (phase != Phase.Ended) revert InvalidPhase(Phase.Ended, phase);
        if (to == address(0)) revert ZeroAddress();

        uint256 availableAt = votingEndedAt + REFUND_GRACE_PERIOD;
        if (block.timestamp < availableAt) revert GracePeriodNotElapsed(availableAt);

        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToRefund();

        totalStaked = 0;

        (bool ok, ) = payable(to).call{ value: balance }("");
        if (!ok) revert TransferFailed();

        emit UnclaimedSwept(to, balance);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Full ballot snapshot plus the running total of valid votes.
    /// @dev The off-chain indexer compares this against its own aggregate, so
    ///      the two can be asserted equal in a single round trip.
    function results() external view returns (Candidate[] memory list, uint256 total) {
        uint256 count = candidateCount;
        list = new Candidate[](count);

        for (uint256 i = 1; i <= count; ++i) {
            Candidate storage candidate = _candidates[i];
            list[i - 1] = candidate;
            total += candidate.voteCount;
        }
    }

    /// @notice Metadata CID of a single candidate.
    function candidateCID(uint256 candidateId) external view returns (string memory) {
        if (candidateId == 0 || candidateId > candidateCount) {
            revert UnknownCandidate(candidateId);
        }
        return _candidates[candidateId].metadataCID;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _setPhase(Phase next) private {
        Phase previous = phase;
        phase = next;
        emit PhaseChanged(previous, next);
    }
}
