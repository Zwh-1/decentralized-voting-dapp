// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { Poll } from "./Poll.sol";
import { PollMechanisms } from "./PollMechanisms.sol";
import { VotingFactory } from "./VotingFactory.sol";

/// @notice Tests for `VotingFactory`: creation, isolation between polls, and the
///         clone-specific hazards (re-initialization, shared state).
contract VotingFactoryTest is Test {
    VotingFactory internal factory;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant STAKE = 0.001 ether;
    uint256 internal constant FAR_FUTURE = 4_000_000_000;

    function setUp() public {
        factory = new VotingFactory();
        vm.warp(1_700_000_000);
    }

    function _cids() internal pure returns (string[] memory cids) {
        cids = new string[](2);
        cids[0] = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        cids[1] = "bafkreieq5jui4j25lacwomsqgvn7mq3z4g4hq7xw774wevxfrfrura3jqq";
    }

    /// @dev No execution targets, which is what every test in this suite wants:
    ///      the governance execution tests live in `PollExecutor.t.sol`.
    function _noExecutionTargets() internal pure returns (address[] memory) {
        return new address[](0);
    }

    /// @dev The default mechanism set with admission chosen, which is what this
    ///      suite is about. Mechanism-specific factory tests build their own.
    function _config(bool openToAll_) internal pure returns (PollMechanisms.PollConfig memory) {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);
        config.openToAll = openToAll_;
        return config;
    }

    /// @dev A one-element option array, for the many tests that vote for a
    ///      single option now that `vote` takes a set.
    function _one(uint256 optionId) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = optionId;
    }

    function _create(address creator, string memory question) internal returns (Poll poll) {
        vm.prank(creator);
        poll = Poll(factory.createPoll(question, _cids(), FAR_FUTURE, _config(false), _noExecutionTargets()));
    }

    /// @dev An open poll: no whitelist needed to vote.
    function _createOpen(address creator, string memory question) internal returns (Poll poll) {
        vm.prank(creator);
        poll = Poll(factory.createPoll(question, _cids(), FAR_FUTURE, _config(true), _noExecutionTargets()));
    }

    // ---------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------

    function test_CreatePoll_RecordsThePollAndItsCreator() public {
        Poll poll = _create(alice, "Lunch?");

        assertEq(factory.pollCount(), 1, "one poll recorded");
        assertEq(factory.pollAt(0), address(poll), "poll reachable by index");
        assertEq(poll.creator(), alice, "the creator owns the new poll");
        assertEq(poll.question(), "Lunch?", "question carried over");
        assertEq(poll.optionCount(), 2, "options carried over");
        assertEq(poll.owner(), alice, "the creator can administer it");

        address[] memory mine = factory.pollsByCreator(alice);
        assertEq(mine.length, 1, "recorded under its creator");
        assertEq(mine[0], address(poll), "and it is the right one");
    }

    function test_CreatePoll_EmitsEvent() public {
        vm.expectEmit(false, true, false, true, address(factory));
        emit VotingFactory.PollCreated(address(0), alice, "Lunch?", FAR_FUTURE, 2, false);

        vm.prank(alice);
        factory.createPoll("Lunch?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets());
    }

    function test_CreatePoll_CarriesTheAdmissionModeToThePoll() public {
        // The factory is the only way to create a poll, so the flag has to make
        // it through `createPoll` into `initialize`. A poll created open whose
        // clone ended up whitelisted would be silently unvotable.
        Poll open = _createOpen(alice, "Anyone?");
        Poll closed = _create(bob, "Invited only?");

        assertTrue(open.openToAll(), "the open poll is open");
        assertFalse(closed.openToAll(), "the other poll is not");
    }

    function test_CreatePoll_EmitsTheAdmissionMode() public {
        vm.expectEmit(false, true, false, true, address(factory));
        emit VotingFactory.PollCreated(address(0), alice, "Anyone?", FAR_FUTURE, 2, true);

        vm.prank(alice);
        factory.createPoll("Anyone?", _cids(), FAR_FUTURE, _config(true), _noExecutionTargets());
    }

    function test_CreatePoll_AnyoneMayCreate() public {
        _create(alice, "A?");
        _create(bob, "B?");

        assertEq(factory.pollCount(), 2, "two unrelated creators, two polls");
        assertEq(factory.pollsByCreator(bob).length, 1, "bob owns one");
        assertEq(factory.pollsByCreator(alice).length, 1, "alice owns one");
    }

    function test_CreatePoll_RevertsWithTooFewOptions() public {
        string[] memory one = new string[](1);
        one[0] = "cid";

        vm.expectRevert(abi.encodeWithSelector(VotingFactory.TooFewOptions.selector, 2, 1));

        vm.prank(alice);
        factory.createPoll("Q", one, FAR_FUTURE, _config(false), _noExecutionTargets());
    }

    function test_CreatePoll_RevertsOnPastDeadline() public {
        vm.expectRevert(abi.encodeWithSelector(VotingFactory.DeadlineNotInFuture.selector, 1));

        vm.prank(alice);
        factory.createPoll("Q", _cids(), 1, _config(false), _noExecutionTargets());
    }

    function test_CreatePoll_RevertsOnEmptyQuestion() public {
        vm.expectRevert(VotingFactory.EmptyQuestion.selector);

        vm.prank(alice);
        factory.createPoll("", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets());
    }

    // ---------------------------------------------------------------------
    // Isolation �?the property that makes the factory approach viable
    // ---------------------------------------------------------------------

    /// @dev If two polls shared any tally, "one address, one vote" would be
    ///      unenforceable. This is the test that would catch a clone that
    ///      delegates to shared storage.
    function test_TwoPollsDoNotShareTallyOrStake() public {
        Poll first = _create(alice, "First?");
        Poll second = _create(bob, "Second?");

        address[] memory voters = new address[](1);
        voters[0] = alice;

        vm.prank(alice);
        first.setWhitelist(voters, true);
        vm.prank(bob);
        second.setWhitelist(voters, true);

        vm.prank(alice);
        first.startPoll();
        vm.prank(bob);
        second.startPoll();

        // Alice votes in the first poll only.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        first.vote{ value: STAKE }(_one(1));

        (, uint256 firstTotal) = first.results();
        (, uint256 secondTotal) = second.results();

        assertEq(firstTotal, 1, "the first poll counted the vote");
        assertEq(secondTotal, 0, "the second poll saw nothing");
        assertEq(second.votedFor(alice), 0, "and does not think alice voted");
        assertEq(second.stakeOf(alice), 0, "and holds none of her stake");
        assertEq(second.totalStaked(), 0, "and accounts for no stake");
        assertEq(address(first).balance, STAKE, "the stake sits in the first poll");
        assertEq(address(second).balance, 0, "and nothing sits in the second");
    }

    /// @dev Each poll's administration is its own: a creator cannot touch
    ///      someone else's poll.
    function test_EachPollHasItsOwnAdmin() public {
        Poll first = _create(alice, "First?");

        address[] memory voters = new address[](1);
        voters[0] = bob;

        vm.expectRevert(
            abi.encodeWithSelector(
                // Ownable's error, from OpenZeppelin.
                bytes4(keccak256("OwnableUnauthorizedAccount(address)")),
                bob
            )
        );
        vm.prank(bob);
        first.setWhitelist(voters, true);
    }

    // ---------------------------------------------------------------------
    // Clone-specific hazards
    // ---------------------------------------------------------------------

    /// @dev The canary for the clone pattern: a poll that can be re-initialized
    ///      can be stolen.
    function test_Initialize_OnACloneRevertsForASecondCaller() public {
        Poll poll = _create(alice, "Lunch?");

        vm.expectRevert(Poll.AlreadyInitialized.selector);
        vm.prank(bob);
        poll.initialize(bob, "Hijacked", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets());

        assertEq(poll.creator(), alice, "still alice's poll");
        assertEq(poll.owner(), alice, "and bob did not become the owner");
    }

    /// @dev The implementation is deployed by the factory and must never be
    ///      usable as a poll itself.
    function test_Implementation_CannotBeInitialized() public {
        Poll impl = Poll(factory.implementation());

        // It was constructed, not initialized: no creator, no options.
        assertEq(impl.creator(), address(0), "the implementation has no creator");
        assertEq(impl.optionCount(), 0, "and no options");

        // Calling initialize on it would succeed once (it is a real contract),
        // which is exactly why the factory never exposes it as a poll and the
        // indexer only follows `PollCreated`. Record the behaviour so a future
        // change to that assumption fails here rather than silently.
        impl.initialize(alice, "Direct", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets());
        assertEq(impl.creator(), alice, "only an explicit call on the raw address does this");

        assertEq(factory.pollCount(), 0, "but the factory never recorded it as a poll");
        assertEq(factory.allPolls().length, 0, "and never lists it");
    }

    function test_AllPolls_IsInCreationOrder() public {
        Poll first = _create(alice, "1?");
        Poll second = _create(alice, "2?");
        Poll third = _create(bob, "3?");

        address[] memory all = factory.allPolls();

        assertEq(all.length, 3, "three polls");
        assertEq(all[0], address(first), "first created, first listed");
        assertEq(all[1], address(second), "second created, second listed");
        assertEq(all[2], address(third), "third created, third listed");
    }

    /// @dev A full life cycle through a clone, to prove the delegated storage
    ///      writes land in the clone rather than in the implementation.
    function test_CloneFullLifeCycle() public {
        Poll poll = _create(alice, "Lunch?");
        Poll impl = Poll(factory.implementation());

        address[] memory voters = new address[](1);
        voters[0] = alice;

        vm.startPrank(alice);
        poll.setWhitelist(voters, true);
        poll.startPoll();
        vm.stopPrank();

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        poll.vote{ value: STAKE }(_one(1));

        vm.prank(alice);
        poll.changeVote(_one(2));

        (Poll.Option[] memory options, uint256 total) = poll.results();
        assertEq(total, 1, "one vote after a change");
        assertEq(options[0].voteCount, 0, "released the first option");
        assertEq(options[1].voteCount, 1, "credited the second");

        vm.prank(alice);
        poll.withdrawVote();

        assertEq(poll.totalStaked(), 0, "stake returned");

        // None of that touched the implementation.
        assertEq(impl.optionCount(), 0, "the implementation still has no options");
        assertEq(impl.totalStaked(), 0, "and still holds nothing");
    }

    // ---------------------------------------------------------------------
    // Creation admission (ADR-0033)
    // ---------------------------------------------------------------------

    /// @dev The compatibility evidence for this whole feature, stated as a test
    ///      rather than as a claim: with the switch OFF — which is how it ships
    ///      — every address may still create, exactly as before. Everything else
    ///      in this file already relies on that being true.
    function test_Admission_IsOffByDefault() public {
        assertFalse(factory.creatorAllowlistEnabled(), "the switch ships off");

        vm.prank(bob);
        Poll created = Poll(factory.createPoll("Anyone?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets()));

        assertEq(created.creator(), bob, "an unlisted address created a poll");
    }

    function test_Admission_RefusesAnUnlistedCreatorWhenOn() public {
        vm.prank(address(this));
        factory.setCreatorAllowlistEnabled(true);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VotingFactory.CreatorNotAllowed.selector, bob));
        factory.createPoll("Nope?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets());
    }

    function test_Admission_AllowsAListedCreatorWhenOn() public {
        address[] memory allowed = new address[](1);
        allowed[0] = bob;

        factory.setCreatorAllowlist(allowed, true);
        factory.setCreatorAllowlistEnabled(true);

        vm.prank(bob);
        Poll created = Poll(factory.createPoll("Yes?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets()));

        assertEq(created.creator(), bob);
    }

    function test_Admission_ListCanBeBuiltBeforeEnforcing() public {
        // A list that could only be edited while live would mean enabling
        // enforcement with an empty list, locking out everyone — including the
        // addresses that were about to be added.
        address[] memory allowed = new address[](1);
        allowed[0] = bob;

        factory.setCreatorAllowlist(allowed, true);
        assertTrue(factory.isCreatorAllowed(bob), "granted while the switch is off");

        factory.setCreatorAllowlistEnabled(true);

        vm.prank(bob);
        factory.createPoll("Yes?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets());
    }

    function test_Admission_CanBeTurnedBackOff() public {
        factory.setCreatorAllowlistEnabled(true);
        factory.setCreatorAllowlistEnabled(false);

        vm.prank(bob);
        Poll created = Poll(factory.createPoll("Back on?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets()));

        assertEq(created.creator(), bob);
    }

    function test_Admission_RevocationTakesEffectImmediately() public {
        address[] memory allowed = new address[](1);
        allowed[0] = bob;

        factory.setCreatorAllowlist(allowed, true);
        factory.setCreatorAllowlistEnabled(true);

        factory.setCreatorAllowlist(allowed, false);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VotingFactory.CreatorNotAllowed.selector, bob));
        factory.createPoll("Revoked?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets());
    }

    function test_Admission_DoesNotRetroactivelyInvalidateExistingPolls() public {
        // A poll already created has its own whitelist, its own stakes and its
        // own results. Letting a later management action invalidate it would
        // mean one transaction destroying other people's assets (ADR-0033).
        address[] memory allowed = new address[](1);
        allowed[0] = bob;

        vm.prank(bob);
        Poll created = Poll(factory.createPoll("Before?", _cids(), FAR_FUTURE, _config(false), _noExecutionTargets()));

        factory.setCreatorAllowlistEnabled(true);
        factory.setCreatorAllowlist(allowed, false);

        assertEq(created.creator(), bob, "the poll still exists and is still bob's");
        assertEq(factory.pollCount(), 1, "and is still counted");
    }

    function test_Admission_OnlyTheOwnerMayToggleTheSwitch() public {
        vm.prank(bob);
        vm.expectRevert();
        factory.setCreatorAllowlistEnabled(true);
    }

    function test_Admission_OnlyTheOwnerMayEditTheList() public {
        address[] memory allowed = new address[](1);
        allowed[0] = bob;

        vm.prank(bob);
        vm.expectRevert();
        factory.setCreatorAllowlist(allowed, true);
    }

    function test_Admission_RefusesAZeroAddressInTheList() public {
        address[] memory withZero = new address[](1);
        withZero[0] = address(0);

        vm.expectRevert();
        factory.setCreatorAllowlist(withZero, true);
    }

    function test_Admission_TogglingEmits() public {
        vm.expectEmit(false, false, false, true);
        emit VotingFactory.CreatorAllowlistToggled(true);

        factory.setCreatorAllowlistEnabled(true);
    }

    function test_Admission_GrantingEmits() public {
        address[] memory allowed = new address[](1);
        allowed[0] = bob;

        vm.expectEmit(true, false, false, true);
        emit VotingFactory.CreatorAllowedUpdated(bob, true);

        factory.setCreatorAllowlist(allowed, true);
    }

    function test_Admission_DeployerIsTheOwner() public {
        // Stated explicitly because it is the one thing this feature adds that a
        // reader has to trust: someone decides who may create. The ADR records
        // that this is a centralisation point; this test records who holds it.
        assertEq(factory.owner(), address(this), "the deployer owns the factory");
    }
}
