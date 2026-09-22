// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

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
contract VotingFactory is Ownable {
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

    /// @notice Whether `createPoll` is restricted to an allowlist.
    ///
    /// @dev DEFAULTS TO FALSE, and that default is load-bearing rather than
    ///      conservative: every existing test, deployment and drill in this
    ///      repository assumes anyone may create a poll, and flipping the default
    ///      would break them all as a side effect of adding a feature. Leaving it
    ///      off also makes the change falsifiable — "the old behaviour is
    ///      unchanged" is only a claim if something checks it (ADR-0033).
    bool public creatorAllowlistEnabled;

    /// @notice Addresses permitted to create polls while the switch is on.
    /// @dev Additive, like `Poll.setWhitelist`: one call grants or revokes, and
    ///      each change emits. A setter that replaced the whole list would let a
    ///      single call silently drop everyone.
    mapping(address => bool) public isCreatorAllowed;

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

    /// @notice The creation switch changed.
    event CreatorAllowlistToggled(bool enabled);

    /// @notice One address's permission to create changed.
    /// @dev The address is indexed so a client can ask "was this address ever
    ///      authorised" without scanning the whole log.
    event CreatorAllowedUpdated(address indexed creator, bool allowed);
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error TooFewOptions(uint256 minimum, uint256 provided);
    error DeadlineNotInFuture(uint256 endsAt);
    error EmptyQuestion();
    error InvalidConfig(string reason);
    /// @dev Names the caller, so the front end can show "your address is not on
    ///      the list" with the address in it rather than a bare selector.
    error CreatorNotAllowed(address caller);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor() Ownable(msg.sender) {
        implementation = address(new Poll());
    }

    /// @notice Turn the creation allowlist on or off.
    /// @dev Owner-only. Recorded as its own event rather than inferred from
    ///      `setCreatorAllowlist` calls, because "the switch moved" and "the
    ///      list changed" are separate facts and a reader auditing why a
    ///      creation was refused needs to see both.
    function setCreatorAllowlistEnabled(bool enabled) external onlyOwner {
        creatorAllowlistEnabled = enabled;

        emit CreatorAllowlistToggled(enabled);
    }

    /// @notice Grant or revoke one address's permission to create polls.
    /// @dev Callable whether or not the switch is on, so a list can be built
    ///      BEFORE being enforced. A list that could only be edited while live
    ///      would mean enabling enforcement with an empty list, locking out
    ///      everyone including the addresses about to be added.
    function setCreatorAllowlist(address[] calldata creators, bool allowed) external onlyOwner {
        uint256 length = creators.length;

        for (uint256 i = 0; i < length; ++i) {
            address creator = creators[i];
            if (creator == address(0)) revert InvalidConfig("zero address in creator allowlist");

            isCreatorAllowed[creator] = allowed;

            emit CreatorAllowedUpdated(creator, allowed);
        }
    }

    // ---------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------

    /// @notice Create a new poll owned by the caller.
    /// @param question The question being asked. Must be non-empty.
    /// @param optionCIDs Metadata CIDs for the options, in display order.
    /// @param endsAt Unix timestamp after which voting closes.
    /// @param config The counting mechanisms, including admission mode.
    /// @param executionTargets Addresses a passed vote may call, besides the
    ///        poll itself. Empty means "the poll only".
    /// @return poll The address of the new poll.
    function createPoll(
        string calldata question,
        string[] calldata optionCIDs,
        uint256 endsAt,
        PollMechanisms.PollConfig calldata config,
        address[] calldata executionTargets
    ) external returns (address poll) {
        // The creation allowlist, checked FIRST so that an unauthorised caller
        // learns that before anything else — the reason is about them, not about
        // their inputs. Skipped entirely while the switch is off, which is what
        // makes the default behaviour byte-for-byte the old one (ADR-0033).
        if (creatorAllowlistEnabled && !isCreatorAllowed[msg.sender]) {
            revert CreatorNotAllowed(msg.sender);
        }

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

        Poll(poll).initialize(msg.sender, question, optionCIDs, endsAt, config, executionTargets);

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
