// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title PollMechanisms
/// @notice The voting mechanisms a poll may be created with, and which
///         combinations of them are legal.
///
/// @dev WHY THIS IS ITS OWN CONTRACT. The four mechanisms below can be combined,
///      so there are 16 combinations, and `Poll` would otherwise have to decide
///      the legality of each one somewhere inside its voting path. Two problems
///      with that:
///
///        1. Every new mechanism would mean editing `vote()`, which is the one
///           function that must stay simple enough to be obviously correct.
///        2. The rules could not be tested in isolation. Exercising a
///           combination through `Poll` means building up phase, whitelist and
///           stake state first, for what is a pure predicate.
///
///      Here, `validate` is pure: no state, no permission, no storage. The
///      whole 16-combination space can be enumerated in a test, and the same
///      predicate is mirrored in `web/src/lib/mechanisms.ts` so the UI can
///      refuse to offer a combination the chain would reject. That mirror is
///      guarded by a test, because two copies of a rule that drift apart produce
///      exactly the defect class this repository already recorded once: an
///      enabled button whose transaction cannot succeed.
///
/// @dev WHAT THIS DOES NOT DO. It does not decide whether a mechanism was
///      chosen well, and it is not consulted on any write path. Mechanisms are
///      frozen at `initialize` (ADR-0030), so validation happens once, at
///      creation, and the resulting configuration is simply read afterwards.
library PollMechanisms {
    // ---------------------------------------------------------------------
    // The configuration
    // ---------------------------------------------------------------------

    /// @notice Everything that decides how a vote is counted.
    ///
    /// @dev Passed to `Poll.initialize` as a struct rather than as positional
    ///      parameters. Six positional booleans/ints at a call site is a
    ///      transposition bug waiting to happen, and the compiler cannot help:
    ///      `initialize(creator, q, cids, endsAt, true, false, 1, 0)` gives the
    ///      reader no way to tell a swapped `allowDelegation` from an intentional
    ///      one. Named fields make the mistake visible.
    struct PollConfig {
        /// @notice True to let any address vote; false to require the whitelist.
        /// @dev Carried here rather than as a separate parameter so that the
        ///      cross-mechanism rules below (weighted + open is rejected) can be
        ///      expressed in one place. Semantics are unchanged from ADR-0025.
        bool openToAll;
        /// @notice True to let one vote select several options at once.
        bool multiSelect;
        /// @notice How many options one multi-select vote may include.
        /// @dev Ignored when `multiSelect` is false. Must be >= 2 when it is
        ///      true: a cap of 1 is not multi-select at all, and accepting it
        ///      would create two ways to express single-select.
        uint256 maxSelections;
        /// @notice True to count a vote by a per-address weight instead of 1.
        bool weighted;
        /// @notice True to let an address hand its voting power to another.
        bool delegable;
        /// @notice True to hide choices until they are revealed.
        bool commitReveal;
        /// @notice Seconds after the deadline during which commits may be
        ///         revealed. Ignored unless `commitReveal` is true.
        uint256 revealWindowSeconds;
        /// @notice The minimum share of the eligible voting power that must take
        ///         part for the result to count, in basis points. 0 means no
        ///         quorum is required.
        /// @dev Basis points rather than a fraction so the comparison in
        ///      `Poll.outcome` is an integer one. A percentage would need either
        ///      floating point (unavailable) or a division, and a division
        ///      truncates: a poll sitting exactly on its threshold could be
        ///      reported as having missed it.
        uint256 quorumBps;
        /// @notice Seconds between queueing an execution and being able to run
        ///         it. 0 means execution is immediate once queued.
        /// @dev Belongs to the creation-time configuration and not to
        ///      `queueExecution` because a delay chosen at queue time is not a
        ///      delay: whoever queues would simply pass 0. Its whole purpose is
        ///      to be a window the VOTERS know about in advance (ADR-0032).
        uint256 timelockSeconds;
    }

    /// @notice The default configuration: single-select, equal weight, no
    ///         delegation, public ballots, whitelist admission.
    /// @dev This is what every poll created before this mechanism set existed
    ///      behaved like, and it stays the baseline the existing regression
    ///      suite is written against.
    function defaultConfig(uint256 endsAt_) internal pure returns (PollConfig memory) {
        endsAt_; // silence the unused-parameter warning; kept for call-site symmetry
        return
            PollConfig({
                openToAll: false,
                multiSelect: false,
                maxSelections: 0,
                weighted: false,
                delegable: false,
                commitReveal: false,
                revealWindowSeconds: 0,
                quorumBps: 0,
                timelockSeconds: 0
            });
    }

    // ---------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------

    /// @notice Whether a configuration may be used to create a poll.
    /// @return ok True when every rule below holds.
    /// @return reason A human-readable sentence naming the rule that failed.
    ///         Empty when `ok` is true.
    ///
    /// @dev The reason is a sentence rather than an error selector because it is
    ///      also read by the TypeScript mirror, where there is no selector to
    ///      match on. Keeping one string shape on both sides is what lets the
    ///      consistency test compare them directly.
    function validate(PollConfig memory config) internal pure returns (bool ok, string memory reason) {
        // --- multi-select ---------------------------------------------------
        if (config.multiSelect) {
            // A cap below 2 makes the poll impossible to vote in, and a cap of
            // exactly 1 is single-select wearing multi-select's name. Both are
            // refused rather than silently reinterpreted: two spellings of the
            // same rule would have to be kept equivalent forever.
            if (config.maxSelections < 2) {
                return (false, "multi-select requires maxSelections >= 2");
            }
        }

        // --- weighted -------------------------------------------------------
        if (config.weighted) {
            // Weighted voting needs a weight for every eligible address. In an
            // open poll the eligible set is "everyone", so no finite snapshot
            // could cover it, and an address without a weight has no defined
            // vote power. Rather than invent a default, this combination is
            // refused: a weighted poll must state who may vote.
            if (config.openToAll) {
                return (false, "weighted voting requires whitelist admission");
            }
        }

        // --- commit-reveal --------------------------------------------------
        if (config.commitReveal) {
            // Without a reveal window every commit would expire unrevealed, so
            // the poll would collect commitments and count none of them.
            if (config.revealWindowSeconds == 0) {
                return (false, "commit-reveal requires a non-zero reveal window");
            }

            // A commitment is bound to the address that will reveal it, which
            // is what stops one voter's commitment from being replayed by
            // another. Under delegation the address that casts and the address
            // whose vote is counted are different, so "which address is this
            // commitment bound to" has no single answer. Refused until that is
            // specified, rather than left to whatever the implementation
            // happens to do (ADR-0030).
            if (config.delegable) {
                return (false, "commit-reveal cannot be combined with delegation yet");
            }
        }

        // --- governance -----------------------------------------------------
        // Checked LAST so the existing mechanism refusals keep their current
        // precedence. The order is part of this function's interface (see the
        // header), and reordering it would change which sentence a caller sees
        // for a config that violates two rules at once.
        return validateGovernance(config);
    }

    /// @notice The largest legal `quorumBps`: 100% of the eligible power.
    /// @dev Named rather than written as a literal at each comparison, so the
    ///      bound and the check that enforces it cannot disagree.
    uint256 internal constant MAX_BPS = 10_000;

    /// @dev Split out from `validate` because it is checked on a different path:
    ///      `validate` runs once at creation inside the factory, while this is
    ///      also consulted by the TypeScript mirror and by tests that build a
    ///      config directly. Keeping it a separate pure function means the two
    ///      callers share one implementation.
    function validateGovernance(
        PollConfig memory config
    ) internal pure returns (bool ok, string memory reason) {
        // Above 100% no tally can ever qualify, so the poll would be created,
        // voted in, and then be incapable of passing — a configuration that is
        // broken at creation but only fails at the end, when every vote has
        // already been cast. Refused up front.
        if (config.quorumBps > MAX_BPS) {
            return (false, "quorumBps cannot exceed 10000");
        }

        // A quorum is a fraction OF the eligible set, and an open poll has no
        // eligible set to take a fraction of — "everyone" is not a countable
        // denominator. Accepting this would create a poll whose quorum check
        // compares the tally against a number the contract cannot compute, and
        // the only two available answers are both wrong: treat it as 0% (the
        // quorum silently does nothing) or as 100% (no poll ever passes).
        if (config.quorumBps != 0 && config.openToAll) {
            return (false, "quorum requires whitelist admission");
        }

        return (true, "");
    }
}
