// SPDX-License-Identifier: MIT
/**
 * Tests for the global audit filters and summary.
 *
 * The rules here are the ones a reader cannot check by looking: why a filter link
 * was rejected instead of ignored, why an address typed in capitals still finds
 * its rows, why the summary counts differ from the number of rows on screen.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUDIT_KINDS,
  auditKindLabel,
  isAuditKind,
  parseAuditFilters,
  summarizeAudit,
  type AuditEntry,
} from "../src/lib/audit";

const POLL_A = "0x1111111111111111111111111111111111111111";
const POLL_B = "0x2222222222222222222222222222222222222222";

function entry(overrides: Partial<AuditEntry> & { kind: AuditEntry["kind"] }): AuditEntry {
  return {
    pollAddress: POLL_A,
    blockNumber: "100",
    txHash: "0xabc",
    ...overrides,
  };
}

describe("isAuditKind", () => {
  it("accepts every kind the index records", () => {
    for (const kind of AUDIT_KINDS) {
      assert.equal(isAuditKind(kind), true, kind);
    }

    assert.equal(AUDIT_KINDS.length, 6, "the six tables the indexer writes");
  });

  it("refuses anything else", () => {
    assert.equal(isAuditKind("voted"), false);
    assert.equal(isAuditKind("CAST"), false, "case is part of the keyword");
    assert.equal(isAuditKind(""), false);
  });
});

describe("parseAuditFilters", () => {
  it("reads no filters from an empty query", () => {
    const parsed = parseAuditFilters(new URLSearchParams());

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.filters, { poll: null, actor: null, kind: null });
  });

  it("treats a blank value as absent rather than as a filter", () => {
    // A form that submits every field sends `?poll=&actor=`. Reading a blank as
    // "the empty address" would match nothing and look like a broken index.
    const parsed = parseAuditFilters(new URLSearchParams("poll=&actor=&kind="));

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.filters, { poll: null, actor: null, kind: null });
  });

  it("treats a whitespace-only value as absent", () => {
    const parsed = parseAuditFilters(new URLSearchParams("kind=%20%20"));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.filters.kind, null);
  });

  it("reads all three filters", () => {
    const parsed = parseAuditFilters(
      new URLSearchParams(`poll=${POLL_A}&actor=${POLL_B}&kind=refunded`),
    );

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.filters, {
      poll: POLL_A,
      actor: POLL_B,
      kind: "refunded",
    });
  });

  it("lowercases addresses so a checksummed filter still matches", () => {
    // The index stores lowercase. Matching the raw input would make the same
    // address find its rows or not depending on how the caller capitalised it.
    const parsed = parseAuditFilters(
      new URLSearchParams("poll=0xAAA1111111111111111111111111111111111111"),
    );

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.filters.poll, "0xaaa1111111111111111111111111111111111111");
  });

  it("REJECTS an unknown kind instead of defaulting to all", () => {
    // Defaulting would make a broken link look like a working one: the reader
    // would see unfiltered results and no way to know their filter was ignored.
    const parsed = parseAuditFilters(new URLSearchParams("kind=whatever"));

    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.error, "invalid_kind");
    assert.match(!parsed.ok ? parsed.message : "", /cast/);
    assert.match(!parsed.ok ? parsed.message : "", /whatever/);
  });

  it("rejects a poll filter that is not an address", () => {
    const parsed = parseAuditFilters(new URLSearchParams("poll=0x123"));

    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.error, "invalid_poll");
  });

  it("rejects an actor filter that is not an address", () => {
    const parsed = parseAuditFilters(new URLSearchParams("actor=nope"));

    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.error, "invalid_actor");
  });

  it("reports the first bad filter when several are bad", () => {
    // Deterministic, so the same broken link always produces the same message.
    const parsed = parseAuditFilters(new URLSearchParams("poll=bad&actor=bad&kind=bad"));

    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.error, "invalid_poll");
  });

  it("accepts a kind filter on its own", () => {
    const parsed = parseAuditFilters(new URLSearchParams("kind=phase"));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.filters.kind, "phase");
  });
});

describe("summarizeAudit", () => {
  it("counts an empty result as zero", () => {
    const summary = summarizeAudit([]);

    assert.equal(summary.total, 0);
    assert.equal(summary.polls, 0);
    assert.deepEqual(summary.byKind, [], "no kinds listed rather than six zeroes");
  });

  it("counts each kind, most frequent first", () => {
    const summary = summarizeAudit([
      entry({ kind: "cast" }),
      entry({ kind: "cast" }),
      entry({ kind: "cast" }),
      entry({ kind: "whitelist" }),
      entry({ kind: "whitelist" }),
      entry({ kind: "phase" }),
    ]);

    assert.equal(summary.total, 6);
    assert.deepEqual(summary.byKind, [
      { kind: "cast", count: 3 },
      { kind: "whitelist", count: 2 },
      { kind: "phase", count: 1 },
    ]);
  });

  it("breaks equal counts by kind name so the order is total", () => {
    // Two kinds with the same count must not swap between requests, or two
    // screenshots of the same query would differ.
    const summary = summarizeAudit([entry({ kind: "phase" }), entry({ kind: "cast" })]);

    assert.deepEqual(
      summary.byKind.map((row) => row.kind),
      ["cast", "phase"],
    );
  });

  it("counts DISTINCT polls, not rows", () => {
    const summary = summarizeAudit([
      entry({ kind: "cast", pollAddress: POLL_A }),
      entry({ kind: "cast", pollAddress: POLL_A }),
      entry({ kind: "cast", pollAddress: POLL_B }),
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.polls, 2, "two polls, three events");
  });

  it("counts a poll once regardless of address casing", () => {
    const summary = summarizeAudit([
      entry({ kind: "cast", pollAddress: POLL_A }),
      entry({ kind: "cast", pollAddress: POLL_A.toUpperCase().replace("0X", "0x") }),
    ]);

    assert.equal(summary.polls, 1);
  });

  it("ignores page boundaries, because it is given the whole filtered set", () => {
    // Pinned deliberately: the route passes the full result, not the page. If a
    // caller ever passes a page, the summary would silently describe 20 events
    // while the history has hundreds.
    const all = Array.from({ length: 500 }, (_, index) =>
      entry({ kind: "cast", blockNumber: String(index) }),
    );

    assert.equal(summarizeAudit(all).total, 500);
  });
});

describe("auditKindLabel", () => {
  it("labels every known kind", () => {
    for (const kind of AUDIT_KINDS) {
      assert.ok(auditKindLabel(kind).length > 0, kind);
    }
  });

  it("falls back to the raw name rather than showing nothing", () => {
    // A row from a future schema version should be visible and obviously odd,
    // not rendered as a blank cell.
    assert.equal(auditKindLabel("something-new"), "something-new");
  });
});
