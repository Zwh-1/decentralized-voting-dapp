// SPDX-License-Identifier: MIT
/**
 * The TypeScript mirror of `contracts/contracts/PollMechanisms.sol`.
 *
 * WHY A MIRROR EXISTS AT ALL. The UI has to refuse to offer a combination the
 * chain would reject, for the same reason `ballot-reasons.ts` exists (ADR-0027):
 * a disabled control that explains itself is better than an enabled one whose
 * transaction fails. That requires knowing the rules before submitting.
 *
 * WHY THE MIRROR IS DANGEROUS. Two copies of a rule drift. When they do, the UI
 * offers a combination, the transaction reverts, and the user is told their
 * input was wrong when it was the two rule sets that disagreed. This is not
 * hypothetical for this repository: `baseline/2026-09-21-optimization-pass.md`
 * §7 records a defect of exactly this shape.
 *
 * THE GUARD. `web/test/mechanisms.test.ts` asserts that this module and the
 * Solidity predicate agree on every one of the 16 combinations, with the
 * Solidity side's answers pinned in that test. If someone changes one side
 * without the other, that test fails. Changing a rule therefore means changing
 * three things: the library, this file, and the pinned table.
 *
 * Keep the reason strings identical to the Solidity ones. They are compared
 * verbatim by the test, so a reworded sentence on one side is a failure rather
 * than a silent divergence.
 */

/** Everything that decides how a vote is counted. Mirrors `PollMechanisms.PollConfig`. */
export interface PollConfig {
  /** True to let any address vote; false to require the whitelist. */
  openToAll: boolean;
  /** True to let one vote select several options at once. */
  multiSelect: boolean;
  /** How many options a multi-select vote may include. Ignored unless `multiSelect`. */
  maxSelections: number;
  /** True to count a vote by a per-address weight instead of 1. */
  weighted: boolean;
  /** True to let an address hand its voting power to another. */
  delegable: boolean;
  /** True to hide choices until they are revealed. */
  commitReveal: boolean;
  /** Seconds after the deadline during which commits may be revealed. */
  revealWindowSeconds: number;
  /**
   * The minimum share of eligible voting power that must take part for the
   * result to count, in basis points. 0 means no quorum.
   *
   * Basis points on both sides of the boundary: the contract compares integers,
   * and a percentage here would have to be converted back before the two could
   * be checked against each other — which is the division the contract's own
   * comment explains would truncate a poll sitting exactly on its threshold.
   */
  quorumBps: number;
  /** Seconds between queueing an execution and being able to run it. 0 is immediate. */
  timelockSeconds: number;
}

/** The configuration every poll created before mechanisms existed behaved like. */
export const DEFAULT_CONFIG: PollConfig = Object.freeze({
  openToAll: false,
  multiSelect: false,
  maxSelections: 0,
  weighted: false,
  delegable: false,
  commitReveal: false,
  revealWindowSeconds: 0,
  // Governance off by default, matching `PollMechanisms.defaultConfig`. A poll
  // with no quorum and no timelock decides on the count alone, which is what
  // every poll did before these existed.
  quorumBps: 0,
  timelockSeconds: 0,
});

export interface ConfigVerdict {
  ok: boolean;
  /** Empty when `ok` is true. Verbatim-identical to the Solidity reason. */
  reason: string;
}

/**
 * Whether a configuration may be used to create a poll.
 *
 * Order matters and is part of the contract: the first failing rule wins, so a
 * configuration that breaks two rules reports the first one. The Solidity side
 * uses the same order.
 */
export function validateConfig(config: PollConfig): ConfigVerdict {
  if (config.multiSelect) {
    if (config.maxSelections < 2) {
      return { ok: false, reason: "multi-select requires maxSelections >= 2" };
    }
  }

  if (config.weighted) {
    if (config.openToAll) {
      return { ok: false, reason: "weighted voting requires whitelist admission" };
    }
  }

  if (config.commitReveal) {
    if (config.revealWindowSeconds === 0) {
      return { ok: false, reason: "commit-reveal requires a non-zero reveal window" };
    }

    if (config.delegable) {
      return { ok: false, reason: "commit-reveal cannot be combined with delegation yet" };
    }
  }

  return { ok: true, reason: "" };
}

/** True when this address may not vote because its power is elsewhere. */
export function isDelegated(config: PollConfig): boolean {
  return config.delegable;
}

/** True when the poll hides choices until they are revealed. */
export function isPrivate(config: PollConfig): boolean {
  return config.commitReveal;
}
