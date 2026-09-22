// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Test } from "forge-std/Test.sol";

import { PollMechanisms } from "./PollMechanisms.sol";

/// @notice Exhaustive tests for the mechanism-combination predicate.
///
/// @dev WHY EXHAUSTIVE RATHER THAN REPRESENTATIVE. The predicate has four
///      independent boolean mechanisms plus two dependent quantities, so the
///      legal/illegal boundary is not obvious by inspection: "weighted + open"
///      is illegal, "weighted + whitelist" is legal, and the difference is one
///      unrelated-looking flag. Sampling would leave exactly the cells nobody
///      thought about, which are the ones a reader will hit.
///
///      This suite therefore enumerates the whole boolean space and asserts a
///      specific verdict for each cell, so the table below IS the specification.
///      Adding a mechanism means adding a column and re-deciding every row --
///      which is the point: the decision is forced into the open rather than
///      being discovered when someone tries the combination.
contract PollMechanismsTest is Test {
    using PollMechanisms for PollMechanisms.PollConfig;

    // ---------------------------------------------------------------------
    // The default configuration
    // ---------------------------------------------------------------------

    function test_DefaultConfig_IsLegal() public pure {
        (bool ok, string memory reason) = PollMechanisms.validate(PollMechanisms.defaultConfig(0));
        assertTrue(ok, "the default configuration must be legal");
        assertEq(reason, "", "a legal configuration carries no reason");
    }

    /// @dev The default must be single-select, equal-weight, undelegated and
    ///      public. If any of these flipped, the existing regression suite --
    ///      written against the pre-mechanism behaviour -- would silently start
    ///      testing something else.
    function test_DefaultConfig_MatchesThePreMechanismBehaviour() public pure {
        PollMechanisms.PollConfig memory config = PollMechanisms.defaultConfig(0);

        assertFalse(config.openToAll, "default admission is the whitelist");
        assertFalse(config.multiSelect, "default is single-select");
        assertFalse(config.weighted, "default is equal-weight");
        assertFalse(config.delegable, "default has no delegation");
        assertFalse(config.commitReveal, "default is a public ballot");
    }

    // ---------------------------------------------------------------------
    // Multi-select
    // ---------------------------------------------------------------------

    function test_MultiSelect_RejectsACapBelowTwo() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.multiSelect = true;
        config.maxSelections = 1;

        (bool ok, string memory reason) = PollMechanisms.validate(config);

        assertFalse(ok, "a cap of 1 is not multi-select");
        assertEq(reason, "multi-select requires maxSelections >= 2");
    }

    function test_MultiSelect_RejectsACapOfZero() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.multiSelect = true;

        (bool ok, ) = PollMechanisms.validate(config);

        assertFalse(ok, "an unset cap under multi-select is not votable");
    }

    function test_MultiSelect_AcceptsACapOfTwo() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.multiSelect = true;
        config.maxSelections = 2;

        (bool ok, ) = PollMechanisms.validate(config);

        assertTrue(ok, "a cap of 2 is the smallest legal multi-select");
    }

    /// @dev The cap is only read when multi-select is on, so a stray value left
    ///      behind in the struct must not make a single-select poll illegal.
    function test_MultiSelect_IgnoresTheCapWhenSingleSelect() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.multiSelect = false;
        config.maxSelections = 0;

        (bool ok, ) = PollMechanisms.validate(config);

        assertTrue(ok, "the cap is irrelevant without multi-select");
    }

    // ---------------------------------------------------------------------
    // Weighted
    // ---------------------------------------------------------------------

    function test_Weighted_RejectsOpenAdmission() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.weighted = true;
        config.openToAll = true;

        (bool ok, string memory reason) = PollMechanisms.validate(config);

        assertFalse(ok, "an open poll has no finite set to weight");
        assertEq(reason, "weighted voting requires whitelist admission");
    }

    function test_Weighted_AcceptsWhitelistAdmission() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.weighted = true;
        config.openToAll = false;

        (bool ok, ) = PollMechanisms.validate(config);

        assertTrue(ok, "weighted voting over a stated list is legal");
    }

    // ---------------------------------------------------------------------
    // Commit-reveal
    // ---------------------------------------------------------------------

    function test_CommitReveal_RejectsAMissingRevealWindow() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.commitReveal = true;
        config.revealWindowSeconds = 0;

        (bool ok, string memory reason) = PollMechanisms.validate(config);

        assertFalse(ok, "without a window every commit would expire unrevealed");
        assertEq(reason, "commit-reveal requires a non-zero reveal window");
    }

    function test_CommitReveal_AcceptsARevealWindow() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.commitReveal = true;
        config.revealWindowSeconds = 2 days;

        (bool ok, ) = PollMechanisms.validate(config);

        assertTrue(ok, "commit-reveal with a window is legal");
    }

    function test_CommitReveal_RejectsDelegation() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.commitReveal = true;
        config.revealWindowSeconds = 2 days;
        config.delegable = true;

        (bool ok, string memory reason) = PollMechanisms.validate(config);

        assertFalse(ok, "a commitment has no single bound address under delegation");
        assertEq(reason, "commit-reveal cannot be combined with delegation yet");
    }

    /// @dev Order matters and is part of the interface: a configuration that
    ///      breaks two rules reports the window rule, not the delegation rule.
    ///      The TypeScript mirror relies on the same order, so a reordering on
    ///      one side must fail the cross-language test rather than quietly
    ///      changing which message a user sees.
    function test_CommitReveal_ReportsTheWindowRuleFirst() public pure {
        PollMechanisms.PollConfig memory config = _base();
        config.commitReveal = true;
        config.revealWindowSeconds = 0;
        config.delegable = true;

        (bool ok, string memory reason) = PollMechanisms.validate(config);

        assertFalse(ok, "two rules are broken");
        assertEq(reason, "commit-reveal requires a non-zero reveal window");
    }

    // ---------------------------------------------------------------------
    // The whole boolean space
    // ---------------------------------------------------------------------

    /// @dev Enumerates all 16 boolean combinations with the quantities set to
    ///      legal values, and asserts the exact set of illegal cells.
    ///
    ///      The expected illegal set is written out literally rather than
    ///      recomputed from the same conditions the library uses -- deriving it
    ///      would make the test a restatement of the implementation and it could
    ///      never fail.
    function test_AllSixteenCombinations_MatchTheSpecifiedTable() public pure {
        string[16] memory expectedIllegal = [
            "", // 0000
            "", // 0001 delegable
            "", // 0010 commitReveal (window ok)
            "commit-reveal cannot be combined with delegation yet", // 0011
            "", // 0100 weighted
            "", // 0101 weighted + delegable
            "", // 0110 weighted + commitReveal
            "commit-reveal cannot be combined with delegation yet", // 0111
            "", // 1000 multiSelect
            "", // 1001 multiSelect + delegable
            "", // 1010 multiSelect + commitReveal
            "commit-reveal cannot be combined with delegation yet", // 1011
            "", // 1100 multiSelect + weighted
            "", // 1101 multiSelect + weighted + delegable
            "", // 1110 multiSelect + weighted + commitReveal
            "commit-reveal cannot be combined with delegation yet" // 1111
        ];

        for (uint256 bits = 0; bits < 16; ++bits) {
            PollMechanisms.PollConfig memory config = _base();
            config.multiSelect = (bits & 8) != 0;
            config.maxSelections = config.multiSelect ? 3 : 0;
            config.weighted = (bits & 4) != 0;
            config.commitReveal = (bits & 2) != 0;
            config.revealWindowSeconds = config.commitReveal ? 2 days : 0;
            config.delegable = (bits & 1) != 0;

            (bool ok, string memory reason) = PollMechanisms.validate(config);

            if (bytes(expectedIllegal[bits]).length == 0) {
                assertTrue(ok, "expected this combination to be legal");
            } else {
                assertFalse(ok, "expected this combination to be illegal");
                assertEq(reason, expectedIllegal[bits], "wrong reason for the combination");
            }
        }
    }

    /// @dev The same sweep with open admission forced on, which is the setting
    ///      that makes every weighted cell illegal regardless of the other bits.
    ///      Run separately because it changes two columns at once and mixing it
    ///      into the table above would make that table harder to read than the
    ///      rule it encodes.
    function test_OpenAdmission_MakesEveryWeightedCombinationIllegal() public pure {
        for (uint256 bits = 0; bits < 16; ++bits) {
            PollMechanisms.PollConfig memory config = _base();
            config.openToAll = true;
            config.multiSelect = (bits & 8) != 0;
            config.maxSelections = config.multiSelect ? 3 : 0;
            config.weighted = (bits & 4) != 0;
            config.commitReveal = (bits & 2) != 0;
            config.revealWindowSeconds = config.commitReveal ? 2 days : 0;
            config.delegable = (bits & 1) != 0;

            (bool ok, string memory reason) = PollMechanisms.validate(config);

            if (config.weighted) {
                assertFalse(ok, "weighted + open must be refused");
                assertEq(reason, "weighted voting requires whitelist admission");
            } else if (config.commitReveal && config.delegable) {
                assertFalse(ok, "commit-reveal + delegation must be refused");
            } else {
                assertTrue(ok, "this combination carries no weighted conflict");
            }
        }
    }

    /// @dev A guard against the table above going stale: the number of legal
    ///      cells is asserted, so making a combination illegal without editing
    ///      the table changes this count and fails here.
    function test_LegalCombinationCount_IsPinned() public pure {
        uint256 legal;

        for (uint256 bits = 0; bits < 16; ++bits) {
            PollMechanisms.PollConfig memory config = _base();
            config.multiSelect = (bits & 8) != 0;
            config.maxSelections = config.multiSelect ? 3 : 0;
            config.weighted = (bits & 4) != 0;
            config.commitReveal = (bits & 2) != 0;
            config.revealWindowSeconds = config.commitReveal ? 2 days : 0;
            config.delegable = (bits & 1) != 0;

            (bool ok, ) = PollMechanisms.validate(config);
            if (ok) {
                ++legal;
            }
        }

        // 16 cells minus the four that combine commit-reveal with delegation.
        assertEq(legal, 12, "the legal-cell count changed");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev A legal starting point: whitelist admission, single-select,
    ///      equal-weight, public. Each test then flips exactly the flags it is
    ///      about, so a failure names one mechanism rather than a combination.
    function _base() private pure returns (PollMechanisms.PollConfig memory) {
        return PollMechanisms.defaultConfig(0);
    }
}
