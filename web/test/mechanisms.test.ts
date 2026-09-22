// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, validateConfig, type PollConfig } from "../src/lib/mechanisms";

/**
 * Tests for the TypeScript mirror of `PollMechanisms.sol`.
 *
 * The most important test in this file is the last one: it pins the Solidity
 * side's verdicts for all 16 boolean combinations and asserts the mirror agrees
 * cell for cell, including the reason strings. Everything else here tests the
 * mirror against itself, which proves much less.
 *
 * The pinned table was produced by running the Solidity suite
 * (`contracts/contracts/PollMechanisms.t.sol`), not by reasoning about what the
 * answers should be. If the two ever disagree, one of them was changed alone,
 * and this test is the only thing that notices.
 */

/** A legal starting point; each test flips exactly what it is about. */
function base(): PollConfig {
  return { ...DEFAULT_CONFIG };
}

describe("validateConfig", () => {
  describe("the default configuration", () => {
    it("is legal", () => {
      const verdict = validateConfig(base());

      assert.equal(verdict.ok, true);
      assert.equal(verdict.reason, "");
    });

    it("matches the behaviour every poll had before mechanisms existed", () => {
      // If any of these flipped, the existing regression suite -- written
      // against pre-mechanism behaviour -- would silently start testing
      // something else.
      assert.equal(DEFAULT_CONFIG.openToAll, false);
      assert.equal(DEFAULT_CONFIG.multiSelect, false);
      assert.equal(DEFAULT_CONFIG.weighted, false);
      assert.equal(DEFAULT_CONFIG.delegable, false);
      assert.equal(DEFAULT_CONFIG.commitReveal, false);
    });
  });

  describe("multi-select", () => {
    it("rejects a cap below two", () => {
      const verdict = validateConfig({
        ...base(),
        multiSelect: true,
        maxSelections: 1,
      });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "multi-select requires maxSelections >= 2");
    });

    it("rejects an unset cap", () => {
      const verdict = validateConfig({ ...base(), multiSelect: true });

      assert.equal(verdict.ok, false);
    });

    it("accepts a cap of two", () => {
      const verdict = validateConfig({
        ...base(),
        multiSelect: true,
        maxSelections: 2,
      });

      assert.equal(verdict.ok, true);
    });

    it("ignores the cap when multi-select is off", () => {
      const verdict = validateConfig({
        ...base(),
        multiSelect: false,
        maxSelections: 0,
      });

      assert.equal(verdict.ok, true);
    });
  });

  describe("weighted", () => {
    it("rejects open admission", () => {
      const verdict = validateConfig({
        ...base(),
        weighted: true,
        openToAll: true,
      });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "weighted voting requires whitelist admission");
    });

    it("accepts whitelist admission", () => {
      const verdict = validateConfig({ ...base(), weighted: true });

      assert.equal(verdict.ok, true);
    });
  });

  describe("commit-reveal", () => {
    it("rejects a missing reveal window", () => {
      const verdict = validateConfig({
        ...base(),
        commitReveal: true,
        revealWindowSeconds: 0,
      });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "commit-reveal requires a non-zero reveal window");
    });

    it("accepts a reveal window", () => {
      const verdict = validateConfig({
        ...base(),
        commitReveal: true,
        revealWindowSeconds: 172_800,
      });

      assert.equal(verdict.ok, true);
    });

    it("rejects delegation", () => {
      const verdict = validateConfig({
        ...base(),
        commitReveal: true,
        revealWindowSeconds: 172_800,
        delegable: true,
      });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "commit-reveal cannot be combined with delegation yet");
    });

    it("reports the window rule before the delegation rule", () => {
      // Order is part of the interface: the Solidity side uses the same order,
      // so a reordering on one side must fail the cross-language test rather
      // than quietly change which message a user sees.
      const verdict = validateConfig({
        ...base(),
        commitReveal: true,
        revealWindowSeconds: 0,
        delegable: true,
      });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "commit-reveal requires a non-zero reveal window");
    });
  });

  describe("every caller-supplied reason names what failed", () => {
    it("never returns an empty reason alongside ok: false", () => {
      // A disabled control with no explanation is the defect ADR-0027 exists to
      // prevent; the same applies to a refusal with no reason.
      const illegal: PollConfig[] = [
        { ...base(), multiSelect: true, maxSelections: 0 },
        { ...base(), multiSelect: true, maxSelections: 1 },
        { ...base(), weighted: true, openToAll: true },
        { ...base(), commitReveal: true },
        { ...base(), commitReveal: true, revealWindowSeconds: 60, delegable: true },
      ];

      for (const config of illegal) {
        const verdict = validateConfig(config);
        assert.equal(verdict.ok, false, JSON.stringify(config));
        assert.notEqual(verdict.reason, "", `no reason for ${JSON.stringify(config)}`);
      }
    });
  });

  describe("cross-language agreement with PollMechanisms.sol", () => {
    /**
     * The Solidity verdicts, pinned.
     *
     * Key: bit 3 = multi-select, bit 2 = weighted, bit 1 = commit-reveal,
     * bit 0 = delegable. Open admission is false and the quantities are set to
     * legal values, matching `test_AllSixteenCombinations_MatchTheSpecifiedTable`.
     *
     * An empty string means "legal". These strings are copied from the Solidity
     * suite's expectations and must stay verbatim identical -- they are compared
     * character for character below.
     */
    const PINNED: ReadonlyArray<{ bits: number; reason: string }> = [
      { bits: 0b0000, reason: "" },
      { bits: 0b0001, reason: "" },
      { bits: 0b0010, reason: "" },
      { bits: 0b0011, reason: "commit-reveal cannot be combined with delegation yet" },
      { bits: 0b0100, reason: "" },
      { bits: 0b0101, reason: "" },
      { bits: 0b0110, reason: "" },
      { bits: 0b0111, reason: "commit-reveal cannot be combined with delegation yet" },
      { bits: 0b1000, reason: "" },
      { bits: 0b1001, reason: "" },
      { bits: 0b1010, reason: "" },
      { bits: 0b1011, reason: "commit-reveal cannot be combined with delegation yet" },
      { bits: 0b1100, reason: "" },
      { bits: 0b1101, reason: "" },
      { bits: 0b1110, reason: "" },
      { bits: 0b1111, reason: "commit-reveal cannot be combined with delegation yet" },
    ];

    for (const { bits, reason } of PINNED) {
      const label = bits.toString(2).padStart(4, "0");

      it(`agrees with the contract for combination ${label}`, () => {
        const config: PollConfig = {
          ...base(),
          multiSelect: (bits & 0b1000) !== 0,
          maxSelections: (bits & 0b1000) !== 0 ? 3 : 0,
          weighted: (bits & 0b0100) !== 0,
          commitReveal: (bits & 0b0010) !== 0,
          revealWindowSeconds: (bits & 0b0010) !== 0 ? 172_800 : 0,
          delegable: (bits & 0b0001) !== 0,
        };

        const verdict = validateConfig(config);

        assert.equal(verdict.ok, reason === "", `ok mismatch for ${label}: ${verdict.reason}`);
        // Verbatim, not merely equivalent. A reworded sentence on one side is a
        // silent divergence the user would experience as an inconsistent UI.
        assert.equal(verdict.reason, reason, `reason mismatch for ${label}`);
      });
    }

    it("agrees on the legal-cell count the Solidity suite pins", () => {
      const legal = PINNED.filter((cell) => cell.reason === "").length;

      assert.equal(legal, 12);
    });

    it("agrees that open admission makes every weighted combination illegal", () => {
      for (const { bits } of PINNED) {
        const weighted = (bits & 0b0100) !== 0;
        const config: PollConfig = {
          ...base(),
          openToAll: true,
          multiSelect: (bits & 0b1000) !== 0,
          maxSelections: (bits & 0b1000) !== 0 ? 3 : 0,
          weighted,
          commitReveal: (bits & 0b0010) !== 0,
          revealWindowSeconds: (bits & 0b0010) !== 0 ? 172_800 : 0,
          delegable: (bits & 0b0001) !== 0,
        };

        const verdict = validateConfig(config);

        if (weighted) {
          assert.equal(verdict.ok, false, `weighted + open leaked at ${bits}`);
          assert.equal(verdict.reason, "weighted voting requires whitelist admission");
        }
      }
    });
  });
});
