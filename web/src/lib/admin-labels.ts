// SPDX-License-Identifier: MIT
/**
 * The pure decisions behind the creator's admin panel.
 *
 * Extracted from `PollAdmin.tsx` for the reason the whole `ballot-labels.ts`
 * family exists: a component that imports wagmi and React cannot be unit tested
 * at all, so any decision that lives inside it can only be covered by a browser
 * drill. These are the decisions where being wrong is expensive — which
 * addresses get voting rights, and how many of them a single call can carry.
 */

/** `Poll.setWhitelist` writes one storage slot and one event per entry. */
export const WHITELIST_BATCH_LIMIT = 100;

/** A 20 byte hex address, the only shape `setWhitelist` accepts. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Splits on any run of the separators a reader is likely to paste. */
const SEPARATORS = /[\s,;]+/;

/**
 * Splits a textarea into addresses, or returns null when any entry is malformed.
 *
 * Returning `null` rather than a filtered list is the whole safety property. A
 * mistyped address that is still shaped like one passes the contract's only
 * check — `setWhitelist` reverts on `address(0)` and on nothing else — so a
 * dropped entry would grant a stranger the right to vote while the reader
 * believed their whole list had been applied. Refusing the batch is the only
 * outcome that cannot hide a typo.
 *
 * An empty input is `[]`, not `null`: "you typed nothing" and "you typed
 * garbage" are different states, and the caller renders a different sentence for
 * each.
 *
 * Duplicates are removed case-insensitively, keeping the first spelling. The
 * same address twice would write the same slot twice in one transaction, which
 * is merely wasteful — but it also makes the chain's event count disagree with
 * the count the reader was shown, and nothing on the page would explain that.
 *
 * The zero address is deliberately *kept*: `setWhitelist` reverts on it with
 * `ZeroAddress`, so it is a loss the chain reports. Re-checking it here would be
 * a second place for the contract's rules to drift.
 */
export function parseAddressList(raw: string): `0x${string}`[] | null {
  const entries = raw
    .split(SEPARATORS)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.some((entry) => !ADDRESS_PATTERN.test(entry))) {
    return null;
  }

  const seen = new Set<string>();
  const unique: `0x${string}`[] = [];

  for (const entry of entries) {
    const key = entry.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entry as `0x${string}`);
    }
  }

  return unique;
}
