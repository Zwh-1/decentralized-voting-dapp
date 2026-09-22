// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { PollMechanisms } from "./PollMechanisms.sol";

/// @title Poll
/// @notice A single ballot: a question, a set of options, a deadline, and one
///         stake-backed vote per address that may be changed or withdrawn.
///
/// @dev This contract replaces the earlier single-tenant `Voting.sol`. The
///      admission model changed, and that change is the whole point of the
///      rewrite:
///
///        * `Voting` recorded a **boolean** `hasVoted`, so a vote was final the
///          moment it was cast. There was no way to change one's mind, and no
///          way to get the stake back before the ballot ended.
///        * `Poll` records **which option** an address currently backs
///          (`votedFor`), so the same address can move between options
///          (`changeVote`) or step out entirely (`withdrawVote`).
///
///      The stake is deliberately kept (ADR-0005): `withdrawVote` and `refund`
///      both make a real external call, which is the only genuine reentrancy
///      surface in this contract, and the test suite proves both layers of its
///      defence with an attacking contract.
///
///      Deployment shape: this contract is deployed behind an EIP-1167 clone by
///      `VotingFactory`, so it uses the initializer pattern rather than a
///      constructor. The implementation contract itself is left uninitialized
///      and must never be used directly.
contract Poll is Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Phase {
        Setup,
        Voting,
        Ended
    }

    struct Option {
        uint256 id;
        string labelCID;
        uint256 voteCount;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Fixed stake required to cast a vote.
    /// @dev A constant, not a per-poll parameter: a settable stake would be a
    ///      second place where "what does a vote cost" is decided, and the
    ///      refund path's accounting assumes a single value.
    uint256 public constant STAKE = 0.001 ether;

    /// @notice Window after the ballot closes during which voters can still
    ///         reclaim their stake before the creator may sweep it.
    uint256 public constant REFUND_GRACE_PERIOD = 7 days;

    /// @notice The fewest options a poll may be opened with.
    uint256 public constant MIN_OPTIONS = 2;

    // ---------------------------------------------------------------------
    // The rules commitment
    // ---------------------------------------------------------------------

    /// @notice A hash of the rules this poll was created with.
    ///
    /// @dev WHAT THIS IS FOR. Everything a reader needs in order to judge a poll
    ///      — the question, the options, the deadline, who may vote, and who
    ///      administers it — is decided once, in `initialize`, and several of
    ///      those things are then immutable by construction while others (the
    ///      OPTIONS and the WHITELIST) can still be changed by the creator while
    ///      the poll is in Setup. A reader arriving later has no way to tell
    ///      whether the rules they are looking at are the rules the poll was
    ///      created with, or whether the creator quietly swapped an option before
    ///      opening it.
    ///
    ///      This value is written once and never changes. Anyone can recompute the
    ///      hash from the current on-chain state and compare it against the
    ///      ORIGINAL — which is recoverable from this poll's own creation event —
    ///      and thereby distinguish two situations that otherwise look identical:
    ///
    ///        * the rules were edited after creation, so the hash still in the
    ///          event no longer matches the current state; or
    ///        * the rules are exactly as created, so the hash matches.
    ///
    ///      The point is NOT that editing is forbidden. A creator is *supposed*
    ///      to be able to add options and build a whitelist before opening — that
    ///      is what `Phase.Setup` is for. The point is that the edit is VISIBLE:
    ///      a reader can tell a poll that was opened as created from one that was
    ///      reshaped first, instead of having to take the page's word for it.
    ///
    ///      It is a hash rather than the values themselves because the values are
    ///      already readable on chain; duplicating them would be redundant storage
    ///      that could itself drift. The hash only has to be a fingerprint.
    bytes32 public rulesHash;

    /// @notice The rules commitment, recomputed from CURRENT state.
    ///
    /// @dev Deliberately a view rather than a stored value. If this were written
    ///      at creation and never refreshed, comparing it to itself would prove
    ///      nothing. Computing it live is what makes the comparison meaningful:
    ///      `rulesHash` is the promise, this is the reality, and a third party
    ///      checks the two agree.
    ///
    ///      Everything hashed here is either immutable or part of what a reader
    ///      is being asked to trust, so the comparison answers exactly the
    ///      question "has anything I was shown changed since creation".
    ///
    ///      The option labels and the whitelist ARE included, and that is the
    ///      substance of the guarantee: those are the two things a creator can
    ///      still change in Setup, so they are precisely what a reader needs a way
    ///      to detect edits to.
    ///
    ///      The MECHANISMS are included too. They are fixed at `initialize` and
    ///      could not have been changed, so including them does not detect an
    ///      edit that was possible; it makes the fingerprint commit to *which
    ///      poll this is*. Two polls differing only in, say, `weighted` are
    ///      different rules and must not share a commitment, for the same reason
    ///      two polls with different questions do not.
    function currentRulesHash() external view returns (bytes32) {
        return _rulesHash();
    }

    /// @dev `abi.encode` of the rule-bearing state, hashed.
    ///
    ///      `abi.encode` rather than `abi.encodePacked`: packed encoding makes
    ///      adjacent dynamic values ambiguous — ("ab", "c") and ("a", "bc")
    ///      produce identical bytes — so two genuinely different rule sets could
    ///      share a hash and the guarantee would be worthless.
    ///
    ///      Split into two hashes and then combined, rather than one
    ///      `abi.encode` with every field. Fourteen arguments in a single call
    ///      (six identity fields, two dynamic ones, the option list and six
    ///      mechanism fields) does not compile: `abi.encode` needs a stack slot
    ///      per argument and the EVM allows 16. The split is also the more
    ///      readable grouping — WHAT the poll asks versus HOW it counts — and
    ///      nested hashing is as collision-resistant as a flat encoding of the
    ///      same fields.
    function _rulesHash() private view returns (bytes32) {
        return keccak256(abi.encode(_subjectHash(), _mechanismHash()));
    }

    /// @dev What the poll asks: identity, deadline, and the editable lists.
    function _subjectHash() private view returns (bytes32) {
        bytes32[] memory optionHashes = new bytes32[](optionCount);
        for (uint256 i = 0; i < optionCount; ++i) {
            uint256 id = i + 1;
            optionHashes[i] = keccak256(abi.encode(id, _options[id].labelCID));
        }

        return
            keccak256(
                abi.encode(
                    creator,
                    question,
                    endsAt,
                    openToAll,
                    block.chainid,
                    address(this),
                    optionHashes,
                    _whitelistHashes()
                )
            );
    }

    /// @dev How the poll counts: the mechanism set, which cannot change after
    ///      `initialize` but is part of what makes this poll *this* poll.
    function _mechanismHash() private view returns (bytes32) {
        PollMechanisms.PollConfig memory c = config;

        return
            keccak256(
                abi.encode(
                    c.multiSelect,
                    c.maxSelections,
                    c.weighted,
                    c.delegable,
                    c.commitReveal,
                    c.revealWindowSeconds
                )
            );
    }

    /// @dev The whitelist as a sorted array of `(address, allowed)` hashes.
    ///
    ///      Sorted because the hash must not depend on the ORDER entries were
    ///      added. A creator who removes an address and adds it back would
    ///      otherwise change the hash without changing who may vote, and a reader
    ///      would see a "the rules changed" warning for a no-op — noise that
    ///      trains people to ignore the very signal this exists to provide.
    function _whitelistHashes() private view returns (bytes32[] memory) {
        uint256 allowedCount;
        for (uint256 i = 0; i < _whitelistKeys.length; ++i) {
            if (isWhitelisted[_whitelistKeys[i]]) {
                ++allowedCount;
            }
        }

        bytes32[] memory hashes = new bytes32[](allowedCount);
        uint256 next;
        for (uint256 i = 0; i < _whitelistKeys.length; ++i) {
            address voter = _whitelistKeys[i];
            if (!isWhitelisted[voter]) {
                continue;
            }
            hashes[next] = keccak256(abi.encode(voter));
            ++next;
        }

        _sort(hashes);
        return hashes;
    }

    /// @dev Insertion sort. The whitelist is bounded by what a creator can add in
    ///      Setup, and this runs in a view function rather than in a transaction,
    ///      so the quadratic worst case is not a gas concern — clarity wins.
    function _sort(bytes32[] memory values) private pure {
        for (uint256 i = 1; i < values.length; ++i) {
            bytes32 key = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > key) {
                values[j] = values[j - 1];
                --j;
            }
            values[j] = key;
        }
    }

    // ---------------------------------------------------------------------
    // Immutable-ish state (set once, by `initialize`)
    // ---------------------------------------------------------------------

    /// @notice The address that created this poll and administers its options.
    address public creator;

    /// @notice The question this poll asks.
    string public question;

    /// @notice When voting closes. `startPoll` may not run at or after this.
    uint256 public endsAt;

    /// @notice When the creator closed the poll early; 0 while it is open.
    uint256 public votingEndedAt;

    Phase public phase;

    /// @notice Every option, 1-indexed. Index 0 is never a valid option.
    mapping(uint256 => Option) private _options;
    uint256 public optionCount;

    /// @notice Addresses allowed to vote. The creator manages this list.
    /// @dev Consulted only when `openToAll` is false. Kept as a real list rather
    ///      than being cleared in the open case: flipping the flag back would
    ///      otherwise silently discard rights the creator had already granted.
    mapping(address => bool) public isWhitelisted;

    /// @dev Every address this mapping has ever been given, in insertion order.
    ///
    ///      A `mapping` cannot be enumerated, and `currentRulesHash` has to hash
    ///      the whitelist to make edits to it detectable. This array is what makes
    ///      that possible.
    ///
    ///      It grows on first write and is NEVER pruned — removing an address from
    ///      the whitelist sets `isWhitelisted[voter] = false` and leaves the key
    ///      here. Removing it would mean a swap-and-pop, which reorders the array,
    ///      and `_whitelistHashes` sorts its output precisely so that order cannot
    ///      affect the hash. Keeping every key ever written also means the array is
    ///      a truthful log of who was ever considered, at the cost of storage that
    ///      only grows by one slot per distinct address.
    address[] private _whitelistKeys;

    /// @dev Position of each key in `_whitelistKeys`, 1-based; 0 means absent.
    ///      Exists so `setWhitelist` can tell a first write from a repeat without
    ///      scanning the array, which would make adding N addresses O(N^2).
    mapping(address => uint256) private _whitelistKeyIndex;

    /// @notice When true, anyone may vote and `isWhitelisted` is not consulted.
    /// @dev Fixed at `initialize` and deliberately not settable afterwards. A
    ///      creator who could flip this mid-ballot would be able to admit a
    ///      crowd (or lock one out) after seeing the tally — the same reasoning
    ///      that freezes options once `startPoll` runs. A poll that wants a
    ///      different admission rule needs a different poll, which the factory
    ///      makes cheap.
    bool public openToAll;

    /// @notice The mechanisms this poll counts votes under.
    /// @dev Fixed at `initialize`, exactly like `openToAll` and for the same
    ///      reason (ADR-0030): a creator who could switch a poll from
    ///      single-select to weighted after seeing the tally would be changing
    ///      what a vote *means* in response to the result. Note this is the
    ///      whole `PollConfig` minus `openToAll`, which is kept as its own
    ///      variable because it predates this struct and has its own getter.
    PollMechanisms.PollConfig public config;

    /// @notice Options the address currently backs, sorted ascending.
    ///
    /// @dev THIS REPLACES A SCALAR. The old `mapping(address => uint256)`
    ///      recorded one option per address, which is why multi-select was not
    ///      expressible: the storage itself had nowhere to put a second choice.
    ///      An array holds the set, and `votedFor()` below still answers the
    ///      single-select question so no existing reader breaks.
    ///
    ///      Sorted ascending and kept free of duplicates, which is what makes
    ///      "is this the same set?" a direct comparison rather than a
    ///      set-operation, and what stops `[1,1]` from being counted as two
    ///      votes for option 1.
    mapping(address => uint256[]) private _votedOptions;

    /// @notice How much voting power the address currently has counted.
    /// @dev Zero when the address holds no vote. Under equal-weight mechanisms
    ///      this is 1 per held vote; under `weighted` it is the weight the
    ///      creator assigned. Exposed so a reader never has to infer "did my
    ///      vote count, and for how much" from the mechanism flags.
    mapping(address => uint256) public votingPowerOf;

    /// @notice Stake currently held for the address; 0 when it holds no vote.
    mapping(address => uint256) public stakeOf;

    /// @notice Sum of every outstanding stake. Invariant: it equals
    ///         `address(this).balance` minus anything already swept.
    uint256 public totalStaked;

    /// @notice Per-address voting weight, consulted only when `config.weighted`.
    /// @dev A stored table rather than a token balance. A live ERC20 balance
    ///      would make a vote's weight change after it was cast, so the tally
    ///      would depend on when it is read; a snapshot table fixes the weight
    ///      at the moment the creator states it. `weightOf` reports 0 for an
    ///      address the creator never listed, and `vote` refuses such an
    ///      address rather than silently counting it as 0 — see the note there.
    mapping(address => uint256) public weightOf;

    /// @notice Sum of every assigned weight, i.e. the poll's voting-power pool.
    /// @dev The denominator a quorum is measured against. Maintained on the
    ///      write path so a reader does not have to sum an unbounded mapping.
    uint256 public totalWeightAssigned;

    /// @notice The address a subject handed its vote to; zero when it holds its
    ///         own. Consulted only when `config.delegable`.
    ///
    /// @dev SINGLE-LEVEL, and that is the whole design. A delegate may not
    ///      itself be a delegate (`CannotDelegateToADelegate`), so authority
    ///      moves exactly one hop and stops. Chained delegation would need cycle
    ///      detection on a graph the contract cannot bound, and would make the
    ///      gas cost of a vote depend on how deep the chain happened to be —
    ///      which turns "cast a ballot" into a call whose cost the voter cannot
    ///      predict. Refusing the chain outright is what buys both properties.
    mapping(address => address) public delegatedTo;

    /// @notice How many subjects handed their vote to this address.
    ///
    /// @dev Maintained rather than counted, so that "may this address delegate
    ///      onward?" is a single read. Keeping the count here is also what makes
    ///      the single-level rule enforceable at delegation time instead of
    ///      merely detectable at vote time.
    mapping(address => uint256) public delegateCountOf;

    /// @dev Extra power the address controls ON TOP OF its own weight, from
    ///      subjects that named it.
    ///
    ///      Deliberately NOT the total. The total depends on an address's own
    ///      weight, which on a weighted poll is assigned by the creator in Setup
    ///      and can be reassigned; caching the total here would leave this
    ///      mapping stale the moment a weight changed, and the staleness would
    ///      show up as a tally that disagrees with `weightOf`. Keeping only the
    ///      delegated surplus means there is exactly one owner of "what is this
    ///      address's own weight" — the weight table — and this field cannot
    ///      contradict it.
    ///
    ///      Read through `controlledPowerOf`, never directly, so callers get the
    ///      total without having to remember to add the weight themselves.
    mapping(address => uint256) private _delegatedSurplus;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PhaseChanged(Phase indexed from, Phase indexed to);
    event OptionAdded(uint256 indexed id, string labelCID);
    event OptionRemoved(uint256 indexed id);
    event OptionUpdated(uint256 indexed id, string labelCID);
    event WhitelistUpdated(address indexed voter, bool allowed);
    event VoteCast(address indexed voter, uint256 indexed optionId, uint256 newCount);

    /// @dev A change of mind is its own event, NOT two `VoteCast`s. An indexer
    ///      cannot tell "changed to B" from "voted A then B" if the second is
    ///      indistinguishable from a first vote, and the whole read model
    ///      depends on being able to take the *last* thing an address did.
    event VoteChanged(address indexed voter, uint256 fromOptionId, uint256 toOptionId);
    event VoteWithdrawn(address indexed voter, uint256 amount);
    event Refunded(address indexed voter, uint256 amount);
    event UnclaimedSwept(address indexed to, uint256 amount);

    /// @dev The set-based counterpart of `VoteCast`/`VoteChanged`, emitted when
    ///      multi-select is on. One event carrying the whole set rather than N
    ///      per-option events, because "the last thing this address did" has to
    ///      be recoverable as a unit: N separate events with no ordering
    ///      guarantee across them would let an indexer assemble a set that was
    ///      never actually cast.
    event VoteRecorded(address indexed voter, uint256[] optionIds, uint256 power, uint256 newTotal);

    /// @dev Emitted when an address's voting power counted toward the tally.
    ///      Separate from the vote itself so that "this address's power moved"
    ///      is observable without decoding the mechanism flags.
    event PowerCounted(address indexed voter, uint256 power, uint256 newTotalPower);

    /// @dev A weight was assigned or changed for an address. Only meaningful on
    ///      a weighted poll, and only legal in Setup.
    event WeightAssigned(address indexed voter, uint256 weight);

    /// @dev An address handed its vote to another, or took it back.
    ///
    ///      `to == address(0)` is a revocation. Emitted rather than only stored
    ///      because delegation changes who can act for a subject, and a reader
    ///      watching a poll needs to see the transfer of authority itself, not
    ///      merely infer it from a later vote by someone else.
    event Delegated(address indexed from, address indexed to);

    /// @dev A delegate cast a ballot on behalf of a subject.
    ///
    ///      Both addresses are indexed because both are the answer to a real
    ///      question: the delegate for "who acted", the subject for "whose vote
    ///      moved". One event with both fields beats two events that a reader
    ///      would have to correlate.
    event VoteDelegated(address indexed delegate, address indexed onBehalfOf, uint256 power);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error AlreadyInitialized();
    error InvalidPhase(Phase expected, Phase actual);
    error NotWhitelisted(address voter);
    error AlreadyVoted(address voter);
    error HasNotVoted(address voter);
    error SameOption(uint256 optionId);
    error UnknownOption(uint256 optionId);
    error ZeroAddress();
    error IncorrectStake(uint256 expected, uint256 received);
    error TooFewOptions(uint256 minimum, uint256 provided);
    error OptionInUse(uint256 optionId);
    error DeadlineNotInFuture(uint256 endsAt);
    error PollAlreadyEnded(uint256 endsAt);
    error TransferFailed();
    error NothingToRefund();
    error GracePeriodNotElapsed(uint256 availableAt);
    error EmptyQuestion();
    error InvalidConfig(string reason);
    error TooManySelections(uint256 maximum, uint256 provided);
    error NoSelections();
    error DuplicateSelection(uint256 optionId);
    error UnweightedVoter(address voter);
    error ZeroWeight(address voter);
    error NoWeightAssigned(address voter);
    error NotDelegable();
    error SelfDelegation(address voter);
    error CannotDelegateToADelegate(address delegate);
    error AlreadyDelegated(address from, address to);
    error HasNotDelegated(address voter);
    error DelegatorHasVoted(address delegator);
    error DelegateNotEligible(address delegate);
    error NotADelegate(address caller);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @dev The implementation contract is deployed once by the factory and is
    ///      never initialized, so its `creator` stays zero and every write path
    ///      reverts. Clones call `initialize` instead. The `_initialized` guard
    ///      is what stops a clone from being re-initialized by anyone who
    ///      notices its address — without it, an attacker could claim a poll.
    bool private _initialized;

    constructor() Ownable(msg.sender) {}

    /// @notice One-time setup of a clone.
    /// @param creator_ The address that will administer this poll.
    /// @param question_ The question being asked.
    /// @param optionCIDs Metadata CIDs, in display order; at least two.
    /// @param endsAt_ Unix timestamp after which voting is closed.
    /// @param config_ The counting mechanisms, including admission mode.
    ///
    /// @dev `config_` carries `openToAll` rather than taking it as a sixth
    ///      positional argument. Two booleans in a row at a call site is a
    ///      transposition the compiler cannot catch, and there are now six such
    ///      fields; named struct members make a swap visible.
    function initialize(
        address creator_,
        string calldata question_,
        string[] calldata optionCIDs,
        uint256 endsAt_,
        PollMechanisms.PollConfig calldata config_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (creator_ == address(0)) revert ZeroAddress();
        if (bytes(question_).length == 0) revert EmptyQuestion();
        if (optionCIDs.length < MIN_OPTIONS) {
            revert TooFewOptions(MIN_OPTIONS, optionCIDs.length);
        }
        if (endsAt_ <= block.timestamp) revert DeadlineNotInFuture(endsAt_);

        // The mechanism combination is checked once, here, rather than on every
        // vote. `PollMechanisms` owns the rules (ADR-0030); this call is the
        // only place the poll consults them, because the configuration cannot
        // change afterwards.
        (bool ok, string memory reason) = PollMechanisms.validate(config_);
        if (!ok) revert InvalidConfig(reason);

        // A multi-select cap can never exceed the number of options, and the
        // check belongs here rather than in `PollMechanisms.validate` because
        // that predicate deliberately knows nothing about the option list.
        if (config_.multiSelect && config_.maxSelections > optionCIDs.length) {
            revert TooManySelections(optionCIDs.length, config_.maxSelections);
        }

        _initialized = true;
        creator = creator_;
        question = question_;
        endsAt = endsAt_;
        openToAll = config_.openToAll;
        config = config_;

        // The clone's owner is the creator, so option management and whitelist
        // management are theirs and no one else's.
        _transferOwnership(creator_);

        for (uint256 i = 0; i < optionCIDs.length; ++i) {
            uint256 id = ++optionCount;
            _options[id] = Option({ id: id, labelCID: optionCIDs[i], voteCount: 0 });
            emit OptionAdded(id, optionCIDs[i]);
        }

        // The creation-time rules fingerprint. Written ONCE, here, and never
        // again: the whitelist is necessarily empty at this point (no creator can
        // have touched it yet), so this is the hash of the rules AS CREATED.
        // `currentRulesHash()` recomputes from live state, and comparing the two
        // is what tells a reader whether the options or the whitelist were edited
        // after creation.
        rulesHash = _rulesHash();

        emit PhaseChanged(Phase.Setup, Phase.Setup);
    }

    /// @notice Assign voting weights to a batch of addresses.
    /// @dev Only meaningful on a weighted poll, and only in Setup: assigning a
    ///      weight after voting began would let the creator re-value votes that
    ///      were already cast, which is the same "rule changed after seeing the
    ///      tally" problem the mechanism freeze exists to prevent.
    ///
    ///      A weight of zero is refused rather than treated as "no vote". The two
    ///      are different states and collapsing them would make "this address's
    ///      vote counts for nothing" indistinguishable from "this address was
    ///      never considered" — the confusion ADR-0011 keeps out of the read
    ///      layer, kept out of the write layer here. To remove an address's
    ///      voting power, remove it from the whitelist.
    function setWeights(address[] calldata voters, uint256[] calldata weights) external onlyOwner {
        if (!config.weighted) revert InvalidConfig("this poll is not weighted");
        if (phase != Phase.Setup) revert InvalidPhase(Phase.Setup, phase);
        if (voters.length != weights.length) {
            revert InvalidConfig("voters and weights must be the same length");
        }

        for (uint256 i = 0; i < voters.length; ++i) {
            address voter = voters[i];
            if (voter == address(0)) revert ZeroAddress();
            if (weights[i] == 0) revert ZeroWeight(voter);

            // The pool is a sum over assigned weights, so a reassignment has to
            // subtract the old value first. Forgetting this is the weighting
            // analogue of forgetting to decrement the old option in
            // `changeVote` — the tally would drift upward on every edit — and
            // the property test covers it.
            totalWeightAssigned -= weightOf[voter];
            weightOf[voter] = weights[i];
            totalWeightAssigned += weights[i];

            emit WeightAssigned(voter, weights[i]);
        }
    }

    // ---------------------------------------------------------------------
    // Delegation
    // ---------------------------------------------------------------------

    /// @notice Hand this caller's vote to `delegate`, or take it back with
    ///         `address(0)`.
    ///
    /// @dev WHAT A DELEGATE GETS. Authority, not ownership: the delegate casts
    ///      ONE ballot that counts for itself plus every subject that named it.
    ///      It cannot split those votes across different options, because the
    ///      tally credits a single set once — which is what keeps "one subject,
    ///      one count" true even though the acting address differs (ADR-0034).
    ///
    ///      WHY THE SUBJECT MUST NOT HAVE VOTED YET. If it had, its vote is
    ///      already in the tally, and handing authority away afterwards would
    ///      either double-count it or silently erase it. Refusing the delegation
    ///      makes the voter withdraw its own vote first, which is a visible
    ///      action with a visible effect rather than a hidden one.
    ///
    ///      WHY A DELEGATE MAY NOT ITSELF BE A DELEGATE. See `delegatedTo`: the
    ///      single-level rule is what keeps vote cost independent of a chain
    ///      depth the contract cannot bound. This is the check that enforces it
    ///      at the moment authority moves, so a chain can never come to exist.
    function delegate(address to) external {
        if (!config.delegable) revert NotDelegable();
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (to == msg.sender) revert SelfDelegation(msg.sender);
        if (!whitelistedFor(msg.sender)) revert NotWhitelisted(msg.sender);
        if (_votedOptions[msg.sender].length != 0) revert DelegatorHasVoted(msg.sender);

        address current = delegatedTo[msg.sender];
        if (current == to) revert AlreadyDelegated(msg.sender, to);

        if (to != address(0)) {
            // An unlisted address cannot hold authority: it has no vote of its
            // own and no weight, so a delegation to it would create power out of
            // nothing.
            if (!whitelistedFor(to)) revert DelegateNotEligible(to);

            // THE SINGLE-LEVEL RULE, and the check is on the RIGHT side of the
            // relationship: what is refused is a delegate handing its AUTHORITY
            // onward, i.e. `to` having already delegated ITSELF. Checking
            // whether `to` merely HAS delegators would be wrong — that would
            // stop two subjects from naming the same delegate, which is the
            // ordinary case the mechanism exists for.
            //
            // Refusing the chain is what keeps the cost of a vote independent of
            // a depth the contract cannot bound (see `delegatedTo`).
            if (delegatedTo[to] != address(0)) revert CannotDelegateToADelegate(to);
        }

        // The subject's weight moves OFF its own account and ONTO the
        // delegate's. Expressed as a surplus rather than an absolute total, so
        // the weight table stays the single owner of "what is this address's own
        // weight" — see `_delegatedSurplus`.
        //
        // Revocation (`to == address(0)`) runs the same two moves with the
        // second half skipped, so the counters cannot disagree about how they
        // are maintained.
        if (current != address(0)) {
            _delegatedSurplus[current] -= _ownPowerOf(msg.sender);
            delegateCountOf[current] -= 1;
        }

        delegatedTo[msg.sender] = to;

        if (to != address(0)) {
            _delegatedSurplus[to] += _ownPowerOf(msg.sender);
            delegateCountOf[to] += 1;
        }

        emit Delegated(msg.sender, to);
    }

    /// @notice The voting power an address currently controls: its own, plus
    ///         that of every subject that delegated to it.
    ///
    /// @dev The number a voter should be shown before acting — "your ballot
    ///      counts for 4" — rather than making the UI add up `weightOf` and the
    ///      delegator count itself. A subject that delegated away returns zero,
    ///      because its weight now belongs to its delegate.
    ///
    ///      A view, computed from the same two sources `vote` will use, so it
    ///      cannot drift from what the ballot actually carries.
    function controlledPowerOf(address account) external view returns (uint256) {
        if (delegatedTo[account] != address(0)) {
            return 0;
        }

        // A live ballot owns the power; the surplus was moved into it at vote
        // time. Reading the credited value here rather than recomputing keeps
        // "how much does this address count for" a question with one answer: it
        // is never both "controlled" and "credited".
        uint256 credited = votingPowerOf[account];
        if (credited != 0) {
            return credited;
        }

        return _ownPowerOf(account) + _delegatedSurplus[account];
    }

    /// @dev An address's own contribution, independent of delegation.
    ///
    ///      Reads the weight table on a weighted poll and 1 otherwise, WITHOUT
    ///      the revert `_powerFor` applies. Delegation must be able to compute a
    ///      subject's power while the creator is still assigning weights, so a
    ///      missing weight is 0 here; the refusal happens at vote time, where
    ///      the voter can act on the message.
    function _ownPowerOf(address voter) private view returns (uint256) {
        if (!config.weighted) {
            return 1;
        }

        return weightOf[voter];
    }

    // ---------------------------------------------------------------------
    // Option management (creator, before the poll opens)
    // ---------------------------------------------------------------------

    /// @notice Append an option. Only while the poll is in Setup.
    /// @dev Options are frozen once voting starts. Allowing them afterwards
    ///      would let a creator add a decoy after seeing the tally, and would
    ///      also invalidate any "count is final" claim the UI makes.
    function addOption(string calldata labelCID) external onlyOwner {
        if (phase != Phase.Setup) revert InvalidPhase(Phase.Setup, phase);

        uint256 id = ++optionCount;
        _options[id] = Option({ id: id, labelCID: labelCID, voteCount: 0 });

        emit OptionAdded(id, labelCID);
    }

    /// @notice Replace an option's metadata CID. Only while in Setup.
    function updateOption(uint256 optionId, string calldata labelCID) external onlyOwner {
        if (phase != Phase.Setup) revert InvalidPhase(Phase.Setup, phase);
        if (optionId == 0 || optionId > optionCount) revert UnknownOption(optionId);

        _options[optionId].labelCID = labelCID;

        emit OptionUpdated(optionId, labelCID);
    }

    /// @notice Remove an option. Only while in Setup.
    /// @dev Removing from the middle would shift every later id and silently
    ///      repoint existing votes, so removal compacts the array in place and
    ///      is only reachable before any vote exists. The UI treats ids as
    ///      opaque, but the indexer keys on them, so a renumbering that could
    ///      happen mid-ballot would be unrecoverable.
    function removeOption(uint256 optionId) external onlyOwner {
        if (phase != Phase.Setup) revert InvalidPhase(Phase.Setup, phase);
        if (optionId == 0 || optionId > optionCount) revert UnknownOption(optionId);
        if (optionCount <= MIN_OPTIONS) revert TooFewOptions(MIN_OPTIONS + 1, optionCount);

        // Shift everything after the removed id down by one.
        for (uint256 i = optionId; i < optionCount; ++i) {
            _options[i] = _options[i + 1];
            _options[i].id = i;
        }

        delete _options[optionCount];
        --optionCount;

        emit OptionRemoved(optionId);
    }

    /// @notice Grant or revoke voting rights for a batch of addresses.
    /// @dev On an `openToAll` poll the writes still happen and still emit, but
    ///      nothing reads them: the list is latent state that would take effect
    ///      only if the flag could be flipped, which it cannot. Keeping the call
    ///      working rather than reverting means the creator's UI does not need a
    ///      second branch, and the events still record who was intended to be
    ///      admitted.
    function setWhitelist(address[] calldata voters, bool allowed) external onlyOwner {
        if (phase == Phase.Ended) revert InvalidPhase(Phase.Voting, phase);

        uint256 length = voters.length;
        for (uint256 i = 0; i < length; ++i) {
            address voter = voters[i];
            if (voter == address(0)) revert ZeroAddress();

            isWhitelisted[voter] = allowed;

            // Remember the key the first time this address is ever mentioned, so
            // `currentRulesHash` can enumerate the list. A repeat write must not
            // append again, or the array would grow without bound and the hash
            // would depend on how many times an address was re-added.
            if (_whitelistKeyIndex[voter] == 0) {
                _whitelistKeys.push(voter);
                _whitelistKeyIndex[voter] = _whitelistKeys.length;
            }

            emit WhitelistUpdated(voter, allowed);
        }
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @notice Open the poll.
    function startPoll() external onlyOwner {
        if (phase != Phase.Setup) revert InvalidPhase(Phase.Setup, phase);
        if (optionCount < MIN_OPTIONS) revert TooFewOptions(MIN_OPTIONS, optionCount);
        if (block.timestamp >= endsAt) revert PollAlreadyEnded(endsAt);

        _setPhase(Phase.Voting);
    }

    /// @notice Close the poll early and start the refund grace period.
    function endPoll() external onlyOwner {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);

        votingEndedAt = block.timestamp;
        _setPhase(Phase.Ended);
    }

    /// @notice Close the poll once its deadline has passed. Callable by anyone.
    /// @dev Without this a poll whose creator walked away would stay open
    ///      forever, because `endPoll` is owner-only. Reaching the deadline is
    ///      not a decision anyone needs to authorise.
    function closeAfterDeadline() external {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (block.timestamp < endsAt) revert DeadlineNotInFuture(endsAt);

        votingEndedAt = block.timestamp;
        _setPhase(Phase.Ended);
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    /// @notice Cast a first vote for `optionIds`, staking exactly `STAKE`.
    /// @dev Single-select is `optionIds.length == 1`, so there is ONE write path
    ///      rather than two. A separate `voteSingle` would have to repeat the
    ///      admission, phase, stake and duplicate checks, and the two copies
    ///      would eventually disagree about one of them.
    ///
    ///      No external call happens here, so there is no reentrancy surface;
    ///      `nonReentrant` is applied for uniformity with the other two write
    ///      paths rather than necessity.
    function vote(uint256[] calldata optionIds) external payable nonReentrant {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);
        // The only admission check, and the only place `openToAll` is read on a
        // write path. Short-circuiting on the flag means an open poll costs one
        // fewer SLOAD than a whitelisted one per vote.
        if (!openToAll && !isWhitelisted[msg.sender]) revert NotWhitelisted(msg.sender);

        // A subject that handed its vote away may not also vote for itself: that
        // would count the same weight twice, once directly and once through the
        // delegate. Withdrawal is the way out, and it is refused below only
        // because there is nothing of its own to withdraw.
        if (delegatedTo[msg.sender] != address(0)) revert NotADelegate(msg.sender);

        if (_votedOptions[msg.sender].length != 0) revert AlreadyVoted(msg.sender);
        if (msg.value != STAKE) revert IncorrectStake(STAKE, msg.value);

        // One stake, one ballot, however much power it carries. The subjects that
        // delegated here do NOT each post a stake: they hold no vote of their
        // own to secure, and requiring one would make delegating cost as much as
        // voting while producing a single ballot.
        //
        // `_powerFor` rather than `_ownPowerOf` for the delegate's own share, so
        // that a weighted delegate the creator never listed is refused with a
        // message naming the problem.
        uint256 power = _powerFor(msg.sender) + _delegatedSurplus[msg.sender];

        // The surplus is deliberately NOT cleared here. A withdrawal has to be
        // able to hand the delegated weight back, and `_clearVote` restores
        // `votingPowerOf` to zero — so the surplus is the only record that the
        // power was ever delegated. Clearing it would make a delegate's
        // withdrawal silently disenfranchise every subject that named it.
        // `controlledPowerOf` reports the credited value first, so leaving this
        // in place does not double-report.
        _recordVote(msg.sender, optionIds, power);

        stakeOf[msg.sender] = msg.value;
        totalStaked += msg.value;

        // One event announcing that this ballot also carried delegated weight.
        // The individual subjects are NOT enumerated: the contract cannot walk a
        // mapping, and a per-subject event would require a delegate to pass in a
        // list the contract cannot verify. `VoteRecorded`'s `power` already says
        // how much was credited, and each `Delegated` event already names who
        // gave it — so the two together are the full account, without the
        // contract having to maintain an enumerable set it has no other use for.
        if (delegateCountOf[msg.sender] != 0) {
            emit VoteDelegated(msg.sender, msg.sender, power);
        }
    }

    /// @notice Move an existing vote to a different option set. Costs no extra stake.
    /// @dev This is the operation the old contract could not express. The two
    ///      counter updates are the whole risk: forgetting to decrement the old
    ///      options makes the tally grow on every change of mind, which is the
    ///      mutation the property test is built to catch.
    ///
    ///      Under multi-select the set is REPLACED, not merged. Merging would
    ///      make "change my vote" an accumulate operation, and an address that
    ///      changed twice could hold two votes' worth of power — exactly the
    ///      double-counting ADR-0034 forbids.
    function changeVote(uint256[] calldata optionIds) external nonReentrant {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);

        uint256[] storage previous = _votedOptions[msg.sender];
        if (previous.length == 0) revert HasNotVoted(msg.sender);

        // Re-submitting the identical set is refused rather than treated as a
        // no-op. The two are indistinguishable in the tally, but they are not
        // indistinguishable to the caller: a client that sent the current set
        // has usually lost track of the vote it already holds, and telling it so
        // is more useful than charging it gas to change nothing. Under
        // multi-select this is a comparison of the whole set, which the stored
        // ascending order makes a direct element-by-element check.
        if (_sameSet(previous, optionIds)) {
            revert SameOption(optionIds[0]);
        }

        uint256 power = votingPowerOf[msg.sender];

        // Effects: clear the old set, then record the new one, leaving the stake
        // exactly where it is.
        _clearVote(msg.sender, previous);
        _recordVote(msg.sender, optionIds, power);

        // Interactions: none. No stake is moved, so nothing to guard against
        // here beyond the guard every write path carries.
    }

    /// @notice Withdraw a vote and reclaim the stake immediately.
    /// @dev Legal while the poll is still open — a withdrawal is not a refund
    ///      of a finished ballot, it is stepping out of a live one. This is the
    ///      second of the two genuine external-call sites in the contract.
    function withdrawVote() external nonReentrant {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);

        uint256[] storage previous = _votedOptions[msg.sender];
        if (previous.length == 0) revert HasNotVoted(msg.sender);

        uint256 amount = stakeOf[msg.sender];

        // Nothing to restore: `_delegatedSurplus` was left untouched by `vote`
        // precisely so this path needs no bookkeeping. `_clearVote` zeroes the
        // credited power, and `controlledPowerOf` falls back to
        // "own weight + surplus" — which is exactly the power the delegate held
        // before it voted, so its subjects keep their voice.

        // Checks-Effects-Interactions: every piece of state is cleared BEFORE
        // the transfer, so a reentrant caller finds nothing left to take.
        _clearVote(msg.sender, previous);
        stakeOf[msg.sender] = 0;
        totalStaked -= amount;

        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        if (!ok) revert TransferFailed();

        emit VoteWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Vote recording (internal)
    // ---------------------------------------------------------------------

    /// @dev The voting power an address brings to its vote.
    ///
    ///      Equal-weight mechanisms contribute 1. A weighted poll reads the
    ///      assigned table and REFUSES an address the creator never listed:
    ///      treating an unlisted address as weight 0 would silently accept a
    ///      transaction that the voter reasonably expected to count, and the
    ///      resulting "I voted but nothing changed" is worse than a revert that
    ///      names the problem.
    function _powerFor(address voter) private view returns (uint256) {
        if (!config.weighted) {
            return 1;
        }

        uint256 weight = weightOf[voter];
        if (weight == 0) revert NoWeightAssigned(voter);

        return weight;
    }

    /// @dev Validates a submitted option set and adds it to the tally.
    ///
    ///      Structured as three passes over the input rather than one
    ///      interleaved pass: validate, count, then store. The single-pass
    ///      version needed a sorted in-place insert with a duplicate scan, which
    ///      pushed the function past the EVM's 16-slot stack ("stack too deep")
    ///      and was harder to read besides. Three simple loops also mean a
    ///      rejected vote has provably touched nothing, because counting only
    ///      starts once validation has finished.
    function _recordVote(address voter, uint256[] calldata optionIds, uint256 power) private {
        uint256 length = optionIds.length;

        if (length == 0) revert NoSelections();

        // A single-select poll accepts exactly one option. Rejecting a longer
        // set here rather than truncating it means a client that sends the wrong
        // shape is told so, instead of having part of its intent silently
        // discarded.
        if (!config.multiSelect && length != 1) {
            revert TooManySelections(1, length);
        }
        if (config.multiSelect && length > config.maxSelections) {
            revert TooManySelections(config.maxSelections, length);
        }

        // Pass 1: every id must be a real option.
        for (uint256 i = 0; i < length; ++i) {
            uint256 optionId = optionIds[i];
            if (optionId == 0 || optionId > optionCount) revert UnknownOption(optionId);
        }

        // Pass 2: no duplicates. `[1,1]` must not count as two votes for option
        // 1, and the check has to happen before any counting so that a rejected
        // vote leaves the tally untouched.
        for (uint256 i = 0; i < length; ++i) {
            for (uint256 j = i + 1; j < length; ++j) {
                if (optionIds[i] == optionIds[j]) revert DuplicateSelection(optionIds[i]);
            }
        }

        // Pass 3: count, and record the set in ascending order so that "the same
        // set" is a direct comparison for any later reader. Insertion sort over
        // the caller's array copy; the caller's own array is not mutated.
        uint256[] memory sorted = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            sorted[i] = optionIds[i];
        }
        for (uint256 i = 1; i < length; ++i) {
            uint256 key = sorted[i];
            uint256 j = i;
            while (j > 0 && sorted[j - 1] > key) {
                sorted[j] = sorted[j - 1];
                --j;
            }
            sorted[j] = key;
        }

        uint256[] storage held = _votedOptions[voter];
        uint256 newTotal;

        for (uint256 i = 0; i < length; ++i) {
            held.push(sorted[i]);
            newTotal = (_options[sorted[i]].voteCount += power);
        }

        votingPowerOf[voter] = power;

        emit VoteRecorded(voter, sorted, power, newTotal);
        emit PowerCounted(voter, power, power);
    }

    /// @dev Whether `candidate` is the set already held by `voter`.
    ///
    ///      A set comparison rather than a first-element comparison: under
    ///      multi-select, changing 1 to 2 inside a {1,3} vote is a real change
    ///      even though the first element is untouched, and treating it as
    ///      "same" would silently refuse a legitimate edit.
    ///
    ///      Deliberately order-independent on the caller's side. The stored set
    ///      is always ascending, but the submitted one is in whatever order the
    ///      client chose, so {2,1} must be recognised as the same vote as {1,2}.
    ///      Walking the submitted set and looking for each member in the stored
    ///      one is O(n*m) with both n and m bounded by `maxSelections`.
    function _sameSet(
        uint256[] storage held,
        uint256[] calldata candidate
    ) private view returns (bool) {
        if (held.length != candidate.length) {
            return false;
        }

        for (uint256 i = 0; i < candidate.length; ++i) {
            bool found;
            for (uint256 j = 0; j < held.length; ++j) {
                if (held[j] == candidate[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                return false;
            }
        }

        return true;
    }

    /// @dev Removes an address's current set from the tally and clears it.
    ///
    ///      Takes the storage pointer rather than re-reading it so the caller
    ///      can pass the reference it already resolved; `delete` on the same
    ///      reference is what guarantees the array is actually emptied.
    function _clearVote(address voter, uint256[] storage held) private {
        uint256 power = votingPowerOf[voter];
        uint256 length = held.length;

        for (uint256 i = 0; i < length; ++i) {
            _options[held[i]].voteCount -= power;
        }

        delete _votedOptions[voter];
        votingPowerOf[voter] = 0;
    }

    // ---------------------------------------------------------------------
    // Refunds
    // ---------------------------------------------------------------------

    /// @notice Reclaim the stake left behind when the poll ended.
    /// @dev Whoever still holds a vote when the poll ends must use this rather
    ///      than `withdrawVote`, because that path requires an open poll.
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
    /// @dev Centralisation risk, documented in the README: a creator can move
    ///      funds a slow voter still intended to claim. Kept because it is the
    ///      counterpart of `refund` in the reentrancy story, and because
    ///      without it a poll's ether is stranded forever.
    function sweepUnclaimed(address to) external onlyOwner {
        if (phase != Phase.Ended) revert InvalidPhase(Phase.Ended, phase);
        if (to == address(0)) revert ZeroAddress();

        uint256 availableAt = votingEndedAt + REFUND_GRACE_PERIOD;
        if (block.timestamp < availableAt) revert GracePeriodNotElapsed(availableAt);

        // Sweep what this contract is *accounted* to hold, not whatever its
        // balance happens to be.
        //
        // The earlier version asserted `totalStaked == 0` and transferred
        // `address(this).balance`. That is correct only while every wei in the
        // contract arrived through `vote`. Any ether that enters without
        // touching `totalStaked` — `selfdestruct` forced in, or a plain
        // `transfer` — is then indistinguishable from voter stake and gets paid
        // out to the creator. Sweeping `totalStaked` instead makes the amount
        // independent of the balance, so forced ether is stranded rather than
        // stolen, and it can never be mistaken for a voter's stake again.
        uint256 amount = totalStaked;

        if (amount == 0) revert NothingToRefund();

        totalStaked = 0;

        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert TransferFailed();

        emit UnclaimedSwept(to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The first option the address currently backs; 0 when it backs none.
    ///
    /// @dev Kept so that every existing single-select reader — the indexer, the
    ///      UI, the property test — keeps working without knowing that the
    ///      storage became a set. It is a VIEW over `_votedOptions`, not a second
    ///      copy, so it cannot disagree with `votedOptions()`.
    ///
    ///      It is deliberately NOT called `votedFor` in storage any more: a
    ///      reader that needs the whole set must call `votedOptions()`, and
    ///      having the name of the old scalar answer only the first element
    ///      would invite the bug this refactor exists to make impossible.
    function votedFor(address voter) external view returns (uint256) {
        uint256[] storage held = _votedOptions[voter];
        return held.length == 0 ? 0 : held[0];
    }

    /// @notice Every option the address currently backs, ascending; empty when none.
    /// @dev The authoritative answer under multi-select. `votedFor` is its first
    ///      element for readers that only understand one option.
    function votedOptions(address voter) external view returns (uint256[] memory) {
        return _votedOptions[voter];
    }

    /// @notice Full option list plus the running total of valid votes.
    /// @dev The off-chain indexer compares this against its own aggregate, so
    ///      the two can be asserted equal in a single round trip.
    ///
    ///      The total is the sum of the per-option counts. Under multi-select
    ///      that means one address can contribute to more than one option, so
    ///      the total counts <em>selections</em>, not voters. This is the
    ///      definition the indexer must reproduce, and the reason
    ///      `voteCount` per option — not the total — is what a quorum reads.
    function results() external view returns (Option[] memory list, uint256 total) {
        uint256 count = optionCount;
        list = new Option[](count);

        for (uint256 i = 1; i <= count; ++i) {
            Option storage option = _options[i];
            list[i - 1] = option;
            total += option.voteCount;
        }
    }

    /// @notice Metadata CID of a single option.
    function optionCID(uint256 optionId) external view returns (string memory) {
        if (optionId == 0 || optionId > optionCount) revert UnknownOption(optionId);

        return _options[optionId].labelCID;
    }

    /// @notice Everything the UI needs about one address, in one round trip.
    ///
    /// @dev A STRUCT rather than a tuple. The tuple version reached seven
    ///      return values, which does not compile: the ABI decoder needs a stack
    ///      slot per value and the EVM's is 16 deep, so `voterState` hit "stack
    ///      too deep". Rather than shrink the return (each field answers a
    ///      different question and dropping one just moves the problem to the
    ///      caller) or turn on `viaIR` for the whole project, the values move
    ///      into a struct — which is also what the doc comment above has claimed
    ///      this function does since it was written.
    struct VoterState {
        /// @dev The raw mapping answer, even on an open poll. See below.
        bool whitelisted;
        /// @dev The first option backed, or 0. Kept for readers that predate
        ///      multi-select.
        uint256 currentOptionId;
        /// @dev Stake currently held; 0 when the address holds no vote.
        uint256 stake;
        /// @dev True when the address holds a vote right now.
        bool marked;
        /// @dev The derived "may this address vote" decision.
        bool canVote;
        /// @dev The whole set, ascending. One element under single-select, so
        ///      the UI has one shape to render.
        uint256[] selections;
        /// @dev How much power this address's vote counted for.
        uint256 power;
        /// @dev The address this one handed its vote to, or zero.
        address delegatedTo;
        /// @dev How many subjects handed their vote to this address.
        uint256 delegatorCount;
        /// @dev Power this address controls: its own plus its subjects'. This is
        ///      the number to show BEFORE voting — "your ballot will count for
        ///      4" — because `power` is zero until a vote exists.
        uint256 controlledPower;
        /// @dev True when this address has handed its vote away, so the UI can
        ///      explain why the ballot is closed to it rather than showing a
        ///      button that would revert with `NotADelegate`.
        bool delegating;
    }

    /// @dev `whitelisted` stays the raw mapping answer even when `openToAll` is
    ///      true, and `canVote` is the derived decision. Collapsing the two into
    ///      one field would make "this address is on the list" and "this address
    ///      may vote" indistinguishable, and the UI has to explain which one
    ///      applies: an open poll that rejected someone has failed for a reason
    ///      that has nothing to do with the whitelist.
    function voterState(address voter) external view returns (VoterState memory state) {
        uint256[] storage held = _votedOptions[voter];

        state.whitelisted = isWhitelisted[voter];
        state.currentOptionId = held.length == 0 ? 0 : held[0];
        state.stake = stakeOf[voter];
        state.marked = held.length != 0;
        state.canVote = openToAll || whitelistedFor(voter);
        state.selections = held;
        state.power = votingPowerOf[voter];
        state.delegatedTo = delegatedTo[voter];
        state.delegatorCount = delegateCountOf[voter];
        // Read as "own weight plus delegated surplus", or the credited power
        // once a ballot exists — matching `controlledPowerOf` exactly, so the
        // struct and the standalone view can never disagree.
        state.controlledPower = delegatedTo[voter] != address(0)
            ? 0
            : (votingPowerOf[voter] != 0
                ? votingPowerOf[voter]
                : _ownPowerOf(voter) + _delegatedSurplus[voter]);
        state.delegating = delegatedTo[voter] != address(0);
    }

    /// @dev Split out because `voterState` reads the mapping twice and the
    ///      compiler's stack accounting is sensitive to inline re-reads here.
    function whitelistedFor(address voter) private view returns (bool) {
        return isWhitelisted[voter];
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
