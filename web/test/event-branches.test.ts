// SPDX-License-Identifier: MIT
/**
 * Tests for the shared event-branch definition.
 *
 * The reason this file exists is a property no single consumer can check for
 * itself: `UNION ALL` matches by POSITION, not by name, so a branch that listed
 * its columns in a different order would put a wei amount in the "allowed" column
 * and still succeed. Counting and comparing the six column lists is the only way
 * to catch that before it reaches a reader.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVENT_BRANCHES,
  EVENT_ORDER_BY,
  branchColumns,
  branchSql,
} from "../src/lib/indexer/event-branches";

/** The columns of a `SELECT` list, split on the top-level commas. */
function selectList(sql: string): string[] {
  const match = /^SELECT (.*?) FROM /s.exec(sql);

  assert.ok(match, `no SELECT list in: ${sql}`);

  return (match[1] ?? "").split(",").map((part) => part.trim());
}

describe("EVENT_BRANCHES", () => {
  it("covers every kind the indexer records", () => {
    assert.deepEqual(EVENT_BRANCHES.map((branch) => branch.kind).sort(), [
      "cast",
      "changed",
      "phase",
      "refunded",
      "whitelist",
      "withdrawn",
    ]);
  });

  it("has a unique kind per branch", () => {
    // Two branches for one kind would be a union that returns every matching row
    // exactly twice.
    const kinds = EVENT_BRANCHES.map((branch) => branch.kind);

    assert.equal(new Set(kinds).size, kinds.length);
  });

  it("reuses `votes` for the three vote-shaped kinds, each with its own condition", () => {
    const voteBranches = EVENT_BRANCHES.filter((branch) => branch.table === "votes");

    assert.equal(voteBranches.length, 3);

    for (const branch of voteBranches) {
      assert.ok(branch.condition !== null, `${branch.kind} needs an event_type condition`);
      assert.match(branch.condition ?? "", /^event_type = '/);
    }
  });

  it("marks exactly the branches that have no voter column", () => {
    // `phase_events` names nobody. Getting `hasVoter` wrong either produces a SQL
    // error against a missing column, or returns phase rows for an address filter.
    const withoutVoter = EVENT_BRANCHES.filter((branch) => !branch.hasVoter).map((b) => b.kind);

    assert.deepEqual(withoutVoter, ["phase"]);
  });
});

describe("branchColumns", () => {
  it("produces the same number of columns for every branch", () => {
    const counts = new Set(EVENT_BRANCHES.map((branch) => branchColumns(branch).length));

    assert.deepEqual([...counts], [10], "a UNION matches by position, so the counts must agree");
  });

  it("puts each column in the same position in every branch", () => {
    // Compared by the ALIAS, which is what `mysql2` keys the row by. A branch
    // whose third column were not `actor` would silently populate the wrong field.
    const alias = (part: string): string => {
      const match = /(?:AS )?(\w+)$/i.exec(part);

      return match?.[1] ?? "";
    };

    const expected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

    for (const branch of EVENT_BRANCHES) {
      const aliases = branchColumns(branch).map(alias);

      assert.deepEqual(
        aliases,
        [
          "kind",
          "poll_address",
          "actor",
          "option_id",
          "allowed",
          "from_phase",
          "to_phase",
          "amount_wei",
          "block_number",
          "tx_hash",
        ],
        `${branch.kind} has the wrong alias order`,
      );
      assert.equal(aliases.length, expected.length);
    }
  });

  it("puts the branch's own kind literal in the first column", () => {
    for (const branch of EVENT_BRANCHES) {
      assert.equal(branchColumns(branch)[0], `'${branch.kind}' AS kind`);
    }
  });

  it("selects NULL for every column the branch has no value for", () => {
    const branch = EVENT_BRANCHES.find((candidate) => candidate.kind === "withdrawn");

    assert.ok(branch);

    const columns = branchColumns(branch);

    assert.equal(columns[3], "NULL AS option_id");
    assert.equal(columns[4], "NULL AS allowed");
    assert.equal(columns[7], "NULL AS amount_wei");
  });
});

describe("branchSql", () => {
  it("merges the branch condition and the caller's into ONE where clause", () => {
    // Two `WHERE` clauses is a syntax error; dropping the branch's would return
    // every kind of vote row from the `cast` branch.
    const cast = EVENT_BRANCHES[0];

    assert.ok(cast);

    const sql = branchSql(cast, ["poll_address = ?", "voter = ?"]);

    assert.equal((sql.match(/ WHERE /g) ?? []).length, 1, sql);
    assert.match(sql, /event_type = 'cast'/);
    assert.match(sql, /poll_address = \?/);
    assert.match(sql, /voter = \?/);
  });

  it("omits the where clause entirely for a branch with no condition of its own", () => {
    const refunded = EVENT_BRANCHES.find((branch) => branch.kind === "refunded");

    assert.ok(refunded);
    assert.equal(refunded.condition, null, "this test needs a branch with no own condition");

    const sql = branchSql(refunded, []);

    assert.ok(!sql.includes("WHERE"), sql);
  });

  it("keeps the branch's OWN condition when the caller adds none", () => {
    // The `cast` branch shares its table with two other kinds, so it must always
    // carry `event_type = 'cast'` — even with no caller filters. Losing it would
    // return changed and withdrawn rows as casts.
    const cast = EVENT_BRANCHES.find((branch) => branch.kind === "cast");

    assert.ok(cast);

    const sql = branchSql(cast, []);

    assert.equal((sql.match(/ WHERE /g) ?? []).length, 1, sql);
    assert.match(sql, /event_type = 'cast'/);
  });

  it("applies the caller's conditions even to a branch with no own condition", () => {
    const refunded = EVENT_BRANCHES.find((branch) => branch.kind === "refunded");

    assert.ok(refunded);

    const sql = branchSql(refunded, ["poll_address = ?"]);

    assert.match(sql, /WHERE poll_address = \?/);
  });

  it("keeps the column list identical whether or not conditions are given", () => {
    // The union's positions must not depend on whether a filter happened to be
    // present, or the same query would mean two different things.
    for (const branch of EVENT_BRANCHES) {
      assert.deepEqual(selectList(branchSql(branch, [])), selectList(branchSql(branch, ["a = ?"])));
    }
  });

  it("never interpolates a value, only placeholders", () => {
    // Every caller's condition is a constant fragment with `?`; a value smuggled
    // into the text is how a filter becomes SQL.
    for (const branch of EVENT_BRANCHES) {
      const sql = branchSql(branch, ["poll_address = ?"]);

      assert.ok(!sql.includes("0x"), `a literal address leaked into: ${sql}`);
    }
  });
});

describe("EVENT_ORDER_BY", () => {
  it("orders by block then transaction hash, so the order is total", () => {
    // Without the tiebreak, two same-block events can swap between requests and a
    // reader paging through sees one twice and misses another.
    assert.match(EVENT_ORDER_BY, /block_number DESC/);
    assert.match(EVENT_ORDER_BY, /tx_hash DESC/);
  });
});
