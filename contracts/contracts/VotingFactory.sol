// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";

/// @title VotingFactory
/// @notice Creates polls. Anyone may create one; the creator administers it.
///
/// @dev Why a factory plus one contract per poll, rather than a single contract
///      holding `mapping(uint256 pollId => ...)`:
///
///      The repository's hardest rule is that the chain is the single source of
///      truth (ADR-0001), and one of the invariants that rule protects is "one
///      address, one vote" (baseline §5.2). Inside a dedicated `Poll` contract,
///      that invariant is a `mapping` the contract itself enforces. Folded into
///      a shared contract it would become a per-`(pollId, voter)` count that
///      only the off-chain indexer could collapse to "the current vote" — which
///      would silently promote the index from a projection to an authority.
///
///      The factory itself deliberately holds no tally and no ether: it only
///      deploys and records. Every question about a poll's state is answered by
///      that poll.
///
///      Clones (EIP-1167) keep creation cheap: the implementation bytecode is
///      deployed once, and each poll is a minimal proxy that delegates to it.
///      `Poll` therefore uses `initialize` rather than a constructor, and the
///      one-time guard in `initialize` is what stops a second caller from
///      claiming an existing poll.
contract VotingFactory {
    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice The implementation every clone delegates to.
    /// @dev Never initialized, so it can never be used as a poll directly:
    ///      its `creator` stays zero and `initialize` is disabled on it.
    address public immutable implementation;

    /// @notice Every poll ever created, in creation order.
    address[] private _polls;

    /// @notice Creator of each poll, for "polls I started" queries.
    mapping(address => address[]) private _pollsByCreator;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PollCreated(
        address indexed poll,
        address indexed creator,
        string question,
        uint256 endsAt,
        uint256 optionCount,
        bool openToAll
    );
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error TooFewOptions(uint256 minimum, uint256 provided);
    error DeadlineNotInFuture(uint256 endsAt);
    error EmptyQuestion();
    error InvalidConfig(string reason);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor() {
        implementation = address(new Poll());
    }

    // ---------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------

    /// @notice Create a new poll owned by the caller.
    /// @param question The question being asked. Must be non-empty.
    /// @param optionCIDs Metadata CIDs for the options, in display order.
    /// @param endsAt Unix timestamp after which voting closes.
    /// @param config The counting mechanisms, including admission mode.
    /// @return poll The address of the new poll.
    function createPoll(
        string calldata question,
        string[] calldata optionCIDs,
        uint256 endsAt,
        PollMechanisms.PollConfig calldata config
    ) external returns (address poll) {
        // Validated here as well as in `initialize`, so a caller pays for the
        // cheap check before a clone is deployed. The check in `initialize` is
        // the one that actually protects the poll; this one only saves gas.
        if (bytes(question).length == 0) revert EmptyQuestion();
        if (optionCIDs.length < 2) revert TooFewOptions(2, optionCIDs.length);
        if (endsAt <= block.timestamp) revert DeadlineNotInFuture(endsAt);

        // The mechanism combination is checked here too, for the same reason:
        // a caller whose configuration is impossible should not pay for a clone
        // deployment to find out. `initialize` re-checks because it is the
        // entry point that actually protects the poll.
        (bool ok, string memory reason) = PollMechanisms.validate(config);
        if (!ok) revert InvalidConfig(reason);

        poll = Clones.clone(implementation);

        Poll(poll).initialize(msg.sender, question, optionCIDs, endsAt, config);

        _polls.push(poll);
        _pollsByCreator[msg.sender].push(poll);

        emit PollCreated(poll, msg.sender, question, endsAt, optionCIDs.length, config.openToAll);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice How many polls exist.
    function pollCount() external view returns (uint256) {
        return _polls.length;
    }

    /// @notice The poll at `index` in creation order.
    function pollAt(uint256 index) external view returns (address) {
        return _polls[index];
    }

    /// @notice Every poll, in creation order.
    /// @dev A plain array getter rather than a paginated one: the demo's poll
    ///      count is small, and a paginated API here would be a second thing to
    ///      keep consistent with the indexer for no benefit. If this ever grows
    ///      past a few hundred polls, the indexer is the right place to page.
    function allPolls() external view returns (address[] memory) {
        return _polls;
    }

    /// @notice Polls created by `creator_`, in creation order.
    function pollsByCreator(address creator_) external view returns (address[] memory) {
        return _pollsByCreator[creator_];
    }
}
