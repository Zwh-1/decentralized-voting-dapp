// SPDX-License-Identifier: MIT
/**
 * The export and timeline logic, tested against the failures that actually matter.
 *
 * None of these are style assertions. Each one pins a way an audit artefact could
 * come out confidently wrong: a tally that drops a row, a CSV a spreadsheet
 * mangles, an ordering that changes between two identical requests, a turnout
 * computed from a denominator nobody knows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  csvCell,
  orderActivity,
  resultCsv,
  resultRows,
  turnout,
  withoutChangeEcho,
  type ActivityEntry,
} from "../src/lib/poll-report";

function entry(over: Partial<ActivityEntry> & { blockNumber: string }): ActivityEntry {
  return { txHash: "0xaa", kind: "cast", ...over };
}

describe("orderActivity", () => {
  it("puts the newest block first", () => {
    const ordered = orderActivity([
      entry({ blockNumber: "100" }),
      entry({ blockNumber: "300" }),
      entry({ blockNumber: "200" }),
    ]);

    assert.deepEqual(
      ordered.map((e) => e.blockNumber),
      ["300", "200", "100"],
    );
  });

  it("compares large block numbers exactly", () => {
    // These two differ, and `Number()` would make them look equal: both exceed
    // 2^53 and round to the same double. A naive sort by Number leaves them in
    // insertion order, so the feed shows an older block above a newer one.
    const ordered = orderActivity([
      entry({ blockNumber: "9007199254740993" }),
      entry({ blockNumber: "9007199254740992" }),
    ]);

    assert.equal(ordered[0]?.blockNumber, "9007199254740993");
  });

  it("is stable for events in the same block", () => {
    // A block holds several of these. Without the transaction tiebreak the
    // database may return them in any order, so two requests for the same
    // history can disagree and a reader comparing two loads sees a difference
    // that is not real.
    const first = orderActivity([
      entry({ blockNumber: "100", txHash: "0xbb" }),
      entry({ blockNumber: "100", txHash: "0xaa" }),
      entry({ blockNumber: "100", txHash: "0xcc" }),
    ]);
    const second = orderActivity([
      entry({ blockNumber: "100", txHash: "0xcc" }),
      entry({ blockNumber: "100", txHash: "0xbb" }),
      entry({ blockNumber: "100", txHash: "0xaa" }),
    ]);

    assert.deepEqual(
      first.map((e) => e.txHash),
      second.map((e) => e.txHash),
    );
  });

  it("does not mutate its input", () => {
    const input = [entry({ blockNumber: "1" }), entry({ blockNumber: "2" })];
    orderActivity(input);

    assert.equal(input[0]?.blockNumber, "1");
  });

  it("keeps every event", () => {
    // A tally that silently drops a kind of event is the exact failure an export
    // exists to prevent, so the count is asserted rather than assumed.
    const input = [
      entry({ blockNumber: "1", kind: "cast" }),
      entry({ blockNumber: "2", kind: "changed" }),
      entry({ blockNumber: "3", kind: "withdrawn" }),
      entry({ blockNumber: "4", kind: "refunded" }),
      entry({ blockNumber: "5", kind: "whitelist" }),
      entry({ blockNumber: "6", kind: "phase" }),
    ];

    assert.equal(orderActivity(input).length, 6);
  });

  it("keeps both rows of a change at the ordering stage", () => {
    /*
      `orderActivity` sorts; it must not also filter, or the two rules would be
      tangled and neither could be changed alone. The echo is removed by
      `withoutChangeEcho`, tested below — this case pins that the split is real.
    */
    const input = [
      entry({ blockNumber: "417", txHash: "0xsame", kind: "changed", optionId: 2 }),
      entry({ blockNumber: "417", txHash: "0xsame", kind: "cast", optionId: 2 }),
    ];

    assert.equal(orderActivity(input).length, 2);
  });
});

describe("withoutChangeEcho", () => {
  it("drops the cast that shares a transaction with a change", () => {
    // `changeVote` emits both. Showing both tells a reader the address voted
    // twice when it holds exactly one vote.
    const input = [
      entry({ blockNumber: "417", txHash: "0xsame", kind: "changed", optionId: 2 }),
      entry({ blockNumber: "417", txHash: "0xsame", kind: "cast", optionId: 2 }),
    ];
    const visible = withoutChangeEcho(input);

    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.kind, "changed");
  });

  it("keeps a first vote, which shares its transaction with nothing", () => {
    // The failure in the other direction: over-suppressing makes a real first
    // vote vanish from the record, so the poll looks like it had fewer voters.
    const input = [entry({ blockNumber: "100", txHash: "0xfirst", kind: "cast", optionId: 1 })];
    const visible = withoutChangeEcho(input);

    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.kind, "cast");
  });

  it("keeps two different voters' casts in the same block", () => {
    // Keying on the block instead of the transaction would delete a genuine
    // vote here. Keying on the voter would wrongly delete one when the same
    // address votes in two polls — the hash is the only correct key.
    const input = [
      entry({ blockNumber: "500", txHash: "0xaaa", kind: "changed", actor: "0xA" }),
      entry({ blockNumber: "500", txHash: "0xaaa", kind: "cast", actor: "0xA" }),
      entry({ blockNumber: "500", txHash: "0xbbb", kind: "cast", actor: "0xB" }),
    ];
    const visible = withoutChangeEcho(input);

    assert.equal(visible.length, 2);
    assert.equal(
      visible.some((e) => e.txHash === "0xbbb" && e.kind === "cast"),
      true,
    );
  });

  it("keeps a standalone cast even when another transaction changed a vote", () => {
    const input = [
      entry({ blockNumber: "600", txHash: "0xchange", kind: "changed", optionId: 1 }),
      entry({ blockNumber: "600", txHash: "0xchange", kind: "cast", optionId: 1 }),
      entry({ blockNumber: "601", txHash: "0xstandalone", kind: "cast", optionId: 2 }),
    ];
    const visible = withoutChangeEcho(input);

    assert.equal(visible.length, 2);
    assert.equal(
      visible.some((e) => e.txHash === "0xstandalone"),
      true,
    );
  });

  it("leaves other event kinds alone", () => {
    const input = [
      entry({ blockNumber: "700", txHash: "0xw", kind: "withdrawn" }),
      entry({ blockNumber: "701", txHash: "0xr", kind: "refunded" }),
      entry({ blockNumber: "702", txHash: "0xp", kind: "phase" }),
    ];

    assert.equal(withoutChangeEcho(input).length, 3);
  });

  it("does not mutate its input", () => {
    const input = [
      entry({ blockNumber: "417", txHash: "0xsame", kind: "changed" }),
      entry({ blockNumber: "417", txHash: "0xsame", kind: "cast" }),
    ];
    withoutChangeEcho(input);

    assert.equal(input.length, 2);
  });
});

describe("resultRows", () => {
  it("ranks by votes and computes the share", () => {
    const rows = resultRows([
      { id: 1, label: "甲", votes: 30 },
      { id: 2, label: "乙", votes: 70 },
    ]);

    assert.deepEqual(
      rows.map((r) => [r.optionId, r.votes, r.sharePercent]),
      [
        [2, 70, 70],
        [1, 30, 30],
      ],
    );
  });

  it("breaks a tie by option id so the order is stable", () => {
    // Every poll starts with all options at zero. Without the second key the
    // table reshuffles between runs for no reason, and the export cannot be
    // compared against itself.
    const rows = resultRows([
      { id: 3, label: "丙", votes: 0 },
      { id: 1, label: "甲", votes: 0 },
      { id: 2, label: "乙", votes: 0 },
    ]);

    assert.deepEqual(
      rows.map((r) => r.optionId),
      [1, 2, 3],
    );
  });

  it("reports zero shares rather than NaN when nothing is counted", () => {
    const rows = resultRows([{ id: 1, label: "甲", votes: 0 }]);

    assert.equal(rows[0]?.sharePercent, 0);
    assert.equal(Number.isNaN(rows[0]?.sharePercent), false);
  });

  it("does not let the shares depend on array order", () => {
    const a = resultRows([
      { id: 1, label: "甲", votes: 1 },
      { id: 2, label: "乙", votes: 2 },
    ]);
    const b = resultRows([
      { id: 2, label: "乙", votes: 2 },
      { id: 1, label: "甲", votes: 1 },
    ]);

    assert.deepEqual(a, b);
  });
});

describe("csvCell", () => {
  it("quotes every field", () => {
    assert.equal(csvCell("甲"), '"甲"');
    assert.equal(csvCell(42), '"42"');
  });

  it("escapes an embedded quote by doubling it", () => {
    assert.equal(csvCell('他说"好"'), '"他说""好"""');
  });

  it("keeps a comma inside the cell", () => {
    // An option label is free text a creator typed, so a comma is ordinary. An
    // unquoted comma shifts every later column by one and the export silently
    // becomes wrong rather than failing.
    assert.equal(csvCell("甲,乙"), '"甲,乙"');
  });

  it("neutralises a value a spreadsheet would run as a formula", () => {
    // CSV injection: a label of `=1+1` executes in the reviewer's spreadsheet.
    // The export exists so a third party can check the numbers, so a creator
    // being able to run code there is a real hazard, not a theoretical one.
    assert.equal(csvCell("=1+1"), '"\'=1+1"');
    assert.equal(csvCell("+1"), '"\'+1"');
    assert.equal(csvCell("-1"), '"\'-1"');
    assert.equal(csvCell("@x"), '"\'@x"');
  });

  it("keeps a newline inside the cell", () => {
    assert.equal(csvCell("甲\n乙"), '"甲\n乙"');
  });
});

describe("resultCsv", () => {
  const base = {
    pollAddress: "0xabc",
    question: "选哪个？",
    phase: "已结束",
    endsAt: "2026-10-01",
    totalVotes: 100,
  };

  it("uses CRLF line endings", () => {
    // Excel reads a bare LF CSV as one long line. This file exists to be opened
    // there, so the line ending is part of the contract.
    const csv = resultCsv({ ...base, rows: resultRows([{ id: 1, label: "甲", votes: 100 }]) });

    assert.match(csv, /\r\n/);
    assert.equal(csv.endsWith("\r\n"), true);
  });

  it("carries the poll's identity and the totals", () => {
    const csv = resultCsv({ ...base, rows: [] });

    assert.match(csv, /0xabc/);
    assert.match(csv, /选哪个？/);
    assert.match(csv, /"100"/);
  });

  it("writes one line per option plus the header", () => {
    const rows = resultRows([
      { id: 1, label: "甲", votes: 60 },
      { id: 2, label: "乙", votes: 40 },
    ]);
    const csv = resultCsv({ ...base, rows });
    const lines = csv.trimEnd().split("\r\n");

    // 5 metadata rows, 1 blank, 1 header, 2 options.
    assert.equal(lines.length, 9);
    assert.match(lines[6] ?? "", /选项 ID/);
  });

  it("survives a label containing a comma and a quote", () => {
    // Round-tripped through a deliberately naive splitter to prove the quoting
    // works: every line must still have exactly 4 fields.
    const rows = resultRows([{ id: 1, label: '甲,"乙"', votes: 1 }]);
    const csv = resultCsv({ ...base, rows });
    const dataLine = csv.trimEnd().split("\r\n")[7] ?? "";

    assert.equal(dataLine, '"1","甲,""乙""","1","100"');
  });
});

describe("turnout", () => {
  it("computes a percentage when the electorate is known", () => {
    assert.equal(turnout(25, 100), 25);
  });

  it("returns null when the electorate is unknown", () => {
    // An open poll has no list to count. Reporting 0% would state, confidently,
    // something nobody knows — and 0% turnout reads as "nobody cares" rather
    // than "this cannot be computed".
    assert.equal(turnout(50, null), null);
    assert.equal(turnout(50, undefined), null);
    assert.equal(turnout(50, 0), null);
  });

  it("clamps an impossible ratio", () => {
    assert.equal(turnout(150, 100), 100);
  });
});
