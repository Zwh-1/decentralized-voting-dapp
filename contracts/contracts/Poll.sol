// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
    function currentRulesHash() external view returns (bytes32) {
        return _rulesHash();
    }

    /// @dev `abi.encode` of the rule-bearing state, hashed.
    ///
    ///      `abi.encode` rather than `abi.encodePacked`: packed encoding makes
    ///      adjacent dynamic values ambiguous — ("ab", "c") and ("a", "bc")
    ///      produce identical bytes — so two genuinely different rule sets could
    ///      share a hash and the guarantee would be worthless.
    function _rulesHash() private view returns (bytes32) {
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

    /// @notice Option the address currently backs; 0 means "no vote right now".
    /// @dev This is the slot that makes `changeVote` and `withdrawVote`
    ///      expressible at all — the old contract only had a boolean.
    mapping(address => uint256) public votedFor;

    /// @notice Stake currently held for the address; 0 when it holds no vote.
    mapping(address => uint256) public stakeOf;

    /// @notice Sum of every outstanding stake. Invariant: it equals
    ///         `address(this).balance` minus anything already swept.
    uint256 public totalStaked;

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
    /// @param openToAll_ True to let any address vote, false to require the
    ///        whitelist. Read once per `vote` and never changed.
    function initialize(
        address creator_,
        string calldata question_,
        string[] calldata optionCIDs,
        uint256 endsAt_,
        bool openToAll_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (creator_ == address(0)) revert ZeroAddress();
        if (bytes(question_).length == 0) revert EmptyQuestion();
        if (optionCIDs.length < MIN_OPTIONS) {
            revert TooFewOptions(MIN_OPTIONS, optionCIDs.length);
        }
        if (endsAt_ <= block.timestamp) revert DeadlineNotInFuture(endsAt_);

        _initialized = true;
        creator = creator_;
        question = question_;
        endsAt = endsAt_;
        openToAll = openToAll_;

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

    /// @notice Cast a first vote for `optionId`, staking exactly `STAKE`.
    /// @dev No external call happens here, so there is no reentrancy surface;
    ///      `nonReentrant` is applied for uniformity with the other two write
    ///      paths rather than necessity.
    function vote(uint256 optionId) external payable nonReentrant {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);
        // The only admission check, and the only place `openToAll` is read on a
        // write path. Short-circuiting on the flag means an open poll costs one
        // fewer SLOAD than a whitelisted one per vote.
        if (!openToAll && !isWhitelisted[msg.sender]) revert NotWhitelisted(msg.sender);
        if (votedFor[msg.sender] != 0) revert AlreadyVoted(msg.sender);
        if (optionId == 0 || optionId > optionCount) revert UnknownOption(optionId);
        if (msg.value != STAKE) revert IncorrectStake(STAKE, msg.value);

        votedFor[msg.sender] = optionId;
        stakeOf[msg.sender] = msg.value;
        totalStaked += msg.value;

        uint256 newCount = ++_options[optionId].voteCount;

        emit VoteCast(msg.sender, optionId, newCount);
    }

    /// @notice Move an existing vote to a different option. Costs no extra stake.
    /// @dev This is the operation the old contract could not express. The two
    ///      counter updates are the whole risk: forgetting to decrement the old
    ///      option makes the tally grow on every change of mind, which is the
    ///      mutation the property test is built to catch.
    function changeVote(uint256 optionId) external nonReentrant {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);

        uint256 previous = votedFor[msg.sender];
        if (previous == 0) revert HasNotVoted(msg.sender);
        if (optionId == 0 || optionId > optionCount) revert UnknownOption(optionId);
        if (optionId == previous) revert SameOption(optionId);

        // Effects: move the vote, leaving the stake exactly where it is.
        votedFor[msg.sender] = optionId;
        --_options[previous].voteCount;
        uint256 newCount = ++_options[optionId].voteCount;

        // Interactions: none. No stake is moved, so nothing to guard against
        // here beyond the guard every write path carries.

        emit VoteChanged(msg.sender, previous, optionId);
        emit VoteCast(msg.sender, optionId, newCount);
    }

    /// @notice Withdraw a vote and reclaim the stake immediately.
    /// @dev Legal while the poll is still open — a withdrawal is not a refund
    ///      of a finished ballot, it is stepping out of a live one. This is the
    ///      second of the two genuine external-call sites in the contract.
    function withdrawVote() external nonReentrant {
        if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
        if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);

        uint256 previous = votedFor[msg.sender];
        if (previous == 0) revert HasNotVoted(msg.sender);

        uint256 amount = stakeOf[msg.sender];

        // Checks-Effects-Interactions: every piece of state is cleared BEFORE
        // the transfer, so a reentrant caller finds nothing left to take.
        delete votedFor[msg.sender];
        stakeOf[msg.sender] = 0;
        totalStaked -= amount;
        --_options[previous].voteCount;

        (bool ok, ) = payable(msg.sender).call{ value: amount }("");
        if (!ok) revert TransferFailed();

        emit VoteWithdrawn(msg.sender, amount);
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

    /// @notice Full option list plus the running total of valid votes.
    /// @dev The off-chain indexer compares this against its own aggregate, so
    ///      the two can be asserted equal in a single round trip.
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
    /// @dev Returned as a struct rather than separate getters so a caller
    ///      cannot observe a half-updated view across two calls.
    ///
    ///      `whitelisted` stays the raw mapping answer even when `openToAll` is
    ///      true, and `canVote` is the derived decision. Collapsing the two into
    ///      one field would make "this address is on the list" and "this address
    ///      may vote" indistinguishable, and the UI has to explain which one
    ///      applies: an open poll that rejected someone has failed for a reason
    ///      that has nothing to do with the whitelist.
    function voterState(
        address voter
    )
        external
        view
        returns (
            bool whitelisted,
            uint256 currentOptionId,
            uint256 stake,
            bool marked,
            bool canVote
        )
    {
        whitelisted = isWhitelisted[voter];
        currentOptionId = votedFor[voter];
        stake = stakeOf[voter];
        marked = currentOptionId != 0;
        canVote = openToAll || whitelisted;
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
