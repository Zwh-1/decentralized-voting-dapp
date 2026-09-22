// SPDX-License-Identifier: MIT
/**
 * Tests for the subscription and notification rules.
 *
 * The two that matter are about not losing an event: the watermark must only ever
 * advance over what was actually shown, and block heights must be compared as
 * numbers rather than as text. Everything else here is input validation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAddressShape,
  isNewerThan,
  parseAddressParam,
  parseSubscriptionRequest,
  summarizeNotifications,
  watermarkFor,
  type NotificationEntry,
} from "../src/lib/notify";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const POLL = "0x3333333333333333333333333333333333333333";

function entry(
  overrides: Partial<NotificationEntry> & { kind: NotificationEntry["kind"] },
): NotificationEntry {
  return {
    pollAddress: POLL,
    blockNumber: "100",
    txHash: "0xabc",
    ...overrides,
  };
}

describe("isAddressShape", () => {
  it("accepts 20 bytes of hex", () => {
    assert.equal(isAddressShape(A), true);
    assert.equal(isAddressShape(A.toUpperCase().replace("0X", "0x")), true);
  });

  it("refuses anything shorter, longer or non-hex", () => {
    assert.equal(isAddressShape("0x123"), false);
    assert.equal(isAddressShape(`${A}0`), false);
    assert.equal(isAddressShape(A.replace("1", "z")), false);
    assert.equal(isAddressShape(""), false);
  });

  it("does not accept a transaction hash length", () => {
    assert.equal(isAddressShape(`${A}${"1".repeat(24)}`), false);
  });
});

describe("parseAddressParam", () => {
  it("reads an address", () => {
    const parsed = parseAddressParam(A);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.address, A);
  });

  it("lowercases so a checksummed address still matches the index", () => {
    const parsed = parseAddressParam("0xAAA1111111111111111111111111111111111111");

    assert.equal(parsed.ok && parsed.address, "0xaaa1111111111111111111111111111111111111");
  });

  it("refuses a missing address by name", () => {
    for (const value of [null, undefined, "", "   ", "nope"]) {
      const parsed = parseAddressParam(value);

      assert.equal(parsed.ok, false, String(value));
      assert.equal(!parsed.ok && parsed.error, "invalid_address");
    }
  });
});

describe("parseSubscriptionRequest", () => {
  it("reads both addresses", () => {
    const parsed = parseSubscriptionRequest({ address: A, poll: POLL });

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.address, A);
    assert.equal(parsed.ok && parsed.poll, POLL);
  });

  it("lowercases both", () => {
    const parsed = parseSubscriptionRequest({
      address: "0xAAA1111111111111111111111111111111111111",
      poll: "0xBBB1111111111111111111111111111111111111",
    });

    assert.equal(parsed.ok && parsed.address, "0xaaa1111111111111111111111111111111111111");
    assert.equal(parsed.ok && parsed.poll, "0xbbb1111111111111111111111111111111111111");
  });

  it("names which field was wrong, so the caller can fix the right one", () => {
    const badAddress = parseSubscriptionRequest({ address: "x", poll: POLL });
    const badPoll = parseSubscriptionRequest({ address: A, poll: "x" });

    assert.equal(!badAddress.ok && badAddress.error, "invalid_address");
    assert.equal(!badPoll.ok && badPoll.error, "invalid_poll");
  });

  it("checks the address before the poll, so the message is deterministic", () => {
    const parsed = parseSubscriptionRequest({ address: "x", poll: "y" });

    assert.equal(!parsed.ok && parsed.error, "invalid_address");
  });

  it("refuses a non-object body", () => {
    for (const body of [null, undefined, "text", 42, []]) {
      const parsed = parseSubscriptionRequest(body);

      assert.equal(parsed.ok, false, String(body));
      assert.equal(!parsed.ok && parsed.error, "invalid_body");
    }
  });

  it("refuses a non-string field", () => {
    assert.equal(parseSubscriptionRequest({ address: 42, poll: POLL }).ok, false);
    assert.equal(parseSubscriptionRequest({ address: A, poll: { a: 1 } }).ok, false);
  });
});

describe("isNewerThan", () => {
  it("compares heights as numbers, not as text", () => {
    // The bug this pins: as strings, "999999999" sorts AFTER "1000000000"
    // because "9" > "1" — so a nearly-caught-up reader would be treated as read.
    assert.equal(isNewerThan("1000000000", "999999999"), true);
    assert.equal(isNewerThan("999999999", "1000000000"), false);
  });

  it("is false for equal heights", () => {
    assert.equal(isNewerThan("100", "100"), false);
  });

  it("ignores leading zeroes", () => {
    assert.equal(isNewerThan("0100", "99"), true);
    assert.equal(isNewerThan("0100", "100"), false, "padding is not a different height");
    assert.equal(isNewerThan("000", "0"), false);
  });

  it("handles heights beyond what a JS number holds exactly", () => {
    const a = "9007199254740993";
    const b = "9007199254740992";

    assert.equal(isNewerThan(a, b), true);
    assert.equal(isNewerThan(b, a), false);
  });

  it("treats 0 as a real watermark", () => {
    assert.equal(isNewerThan("1", "0"), true);
    assert.equal(isNewerThan("0", "0"), false);
  });
});

describe("watermarkFor", () => {
  it("returns the current watermark when there is nothing to mark", () => {
    assert.equal(watermarkFor([], "500"), "500");
  });

  it("advances to the highest block among the entries", () => {
    const entries = [
      entry({ kind: "cast", blockNumber: "420" }),
      entry({ kind: "cast", blockNumber: "500" }),
      entry({ kind: "cast", blockNumber: "480" }),
    ];

    assert.equal(watermarkFor(entries, "400"), "500");
  });

  it("NEVER goes backwards", () => {
    // Marking a stale page read must not rewind the watermark, or the reader
    // would be re-notified for events they already saw.
    const entries = [entry({ kind: "cast", blockNumber: "300" })];

    assert.equal(watermarkFor(entries, "500"), "500");
  });

  it("does not jump to the chain head", () => {
    // The whole point: marking read what was SHOWN must not swallow what arrived
    // during the request. Only the entries' own heights may be used.
    const entries = [entry({ kind: "cast", blockNumber: "500" })];

    assert.equal(watermarkFor(entries, "0"), "500", "not 520, the head at the time");
  });
});

describe("summarizeNotifications", () => {
  it("counts an empty set as zero", () => {
    const summary = summarizeNotifications([]);

    assert.equal(summary.total, 0);
    assert.equal(summary.pollCount, 0);
    assert.deepEqual(summary.byPoll, []);
    assert.deepEqual(summary.byKind, []);
  });

  it("counts rows per poll, most first", () => {
    const summary = summarizeNotifications([
      entry({ kind: "cast", pollAddress: A }),
      entry({ kind: "cast", pollAddress: A }),
      entry({ kind: "cast", pollAddress: B }),
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.pollCount, 2);
    assert.deepEqual(summary.byPoll[0], { pollAddress: A, count: 2 });
  });

  it("counts rows per kind, most first", () => {
    const summary = summarizeNotifications([
      entry({ kind: "refunded" }),
      entry({ kind: "refunded" }),
      entry({ kind: "cast" }),
    ]);

    assert.deepEqual(summary.byKind[0], { kind: "refunded", count: 2 });
  });

  it("breaks equal counts by name so the order is total", () => {
    // Two screenshots of one reader's notifications must not differ.
    const summary = summarizeNotifications([entry({ kind: "phase" }), entry({ kind: "cast" })]);

    assert.deepEqual(
      summary.byKind.map((row) => row.kind),
      ["cast", "phase"],
    );
  });

  it("counts a poll once regardless of address casing", () => {
    const summary = summarizeNotifications([
      entry({ kind: "cast", pollAddress: A }),
      entry({ kind: "cast", pollAddress: A.toUpperCase().replace("0X", "0x") }),
    ]);

    assert.equal(summary.pollCount, 1);
  });
});
