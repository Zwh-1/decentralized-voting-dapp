// SPDX-License-Identifier: MIT
/**
 * The read model's whole correctness argument, pinned.
 *
 * `current_votes` derives "which option does each (poll, voter) back" by taking
 * the LAST event for that pair; `option_tally` counts it. That derivation is
 * what replaces the old `candidate_tally`'s plain "count the rows" — a vote is
 * no longer final, so counting rows would count a change of mind twice and a
 * withdrawal not at all.
 *
 * Every case below runs against `test/helpers/derivation.ts`, which transcribes
 * the SQL. When `DATABASE_URL` is set and reachable the same rows are also run
 * through the real views so the SQL text itself is exercised; without a
 * database that leg reports as skipped, not as passing.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { Pool } from "mysql2/promise";

import {
  connectTestDatabase,
  derive,
  deriveFromViews,
  type CurrentVote,
  type OptionTableRow,
  type OptionTallyRow,
  type VoteEventRow,
} from "./helpers/derivation";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

let pool: Pool | null = null;
let poolChecked = false;

async function viewsPool(): Promise<Pool | null> {
  if (!poolChecked) {
    poolChecked = true;
    pool = await connectTestDatabase();
  }

  return pool;
}

let caseCounter = 0;

/**
 * A fresh pair of poll addresses for one test.
 *
 * Each test gets its OWN addresses rather than sharing two module constants.
 * The database leg inserts and leaves its rows behind — the projection is a
 * cache, and deleting them would need foreign keys the schema deliberately does
 * not have — so two tests sharing an address would read each other's votes and
 * fail on a phantom rather than on a real disagreement.
 *
 * The prefix is kept from the logical name so a failure message still says
 * which poll the row belongs to, and the counter makes the rest unique.
 */
function polls(): { a: string; b: string; optionsA: OptionTableRow[]; optionsB: OptionTableRow[] } {
  const tag = (caseCounter++).toString(16).padStart(4, "0");
  // 0x + 1 tag byte + 4 hex digits + 35 zeroes = 42 characters, a valid address
  // shape and unique per test.
  const a = `0xa${tag}${"0".repeat(35)}`;
  const b = `0xb${tag}${"0".repeat(35)}`;

  assert.equal(a.length, 42, "the generated address must be address-shaped");
  assert.equal(b.length, 42, "the generated address must be address-shaped");

  return {
    a,
    b,
    optionsA: [
      { pollAddress: a, optionId: 1, labelCid: "cid-a1" },
      { pollAddress: a, optionId: 2, labelCid: "cid-a2" },
      { pollAddress: a, optionId: 3, labelCid: "cid-a3" },
    ],
    optionsB: [
      { pollAddress: b, optionId: 1, labelCid: "cid-b1" },
      { pollAddress: b, optionId: 2, labelCid: "cid-b2" },
    ],
  };
}

function event(
  pollAddress: string,
  voter: string,
  optionId: number,
  eventType: VoteEventRow["eventType"],
  blockNumber: bigint,
  logIndex: number,
): VoteEventRow {
  return { pollAddress, voter, optionId, eventType, blockNumber, logIndex };
}

/** The derivation under test, from both sources. */
async function both(
  options: readonly OptionTableRow[],
  votes: readonly VoteEventRow[],
): Promise<{
  model: ReturnType<typeof derive>;
  views: Awaited<ReturnType<typeof deriveFromViews>>;
}> {
  return {
    model: derive(options, votes),
    views: await deriveFromViews(await viewsPool(), options, votes),
  };
}

/**
 * Compares a model result with the real views', for one poll's rows.
 *
 * A no-op when no database is reachable: the model leg still ran, and this
 * file's header says plainly that the SQL itself was not executed in that case.
 */
function sameAsViews(
  pollAddress: string,
  model: readonly { pollAddress: string; voter?: string }[],
  views: readonly { pollAddress: string; voter?: string }[] | null | undefined,
): void {
  if (views === null || views === undefined) {
    return;
  }

  const mine = (rows: readonly { pollAddress: string; voter?: string }[]) =>
    rows
      .filter((row) => row.pollAddress.toLowerCase() === pollAddress.toLowerCase())
      .map((row) => (row.voter === undefined ? row : { ...row, voter: row.voter.toLowerCase() }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));

  assert.deepEqual(mine(views), mine(model));
}

/** A stable, bigint-safe key for ordering rows before comparing them. */
function canonical(row: unknown): string {
  return JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** `[optionId, voteCount]` pairs, the shape most of the tally assertions use. */
function counts(tally: readonly OptionTallyRow[]): [number, number][] {
  return tally.map((row) => [row.optionId, row.voteCount]);
}

after(async () => {
  if (pool !== null) {
    await pool.end();
  }
});

describe("current_votes", () => {
  it("takes a plain cast as the current vote", async () => {
    const { a, optionsA } = polls();
    const votes = [event(a, ALICE, 2, "cast", 10n, 0)];
    const { model, views } = await both(optionsA, votes);

    assert.deepEqual(model.currentVotes, [
      { pollAddress: a, voter: ALICE, optionId: 2, blockNumber: 10n, logIndex: 0 },
    ]);

    sameAsViews(a, model.currentVotes, views?.currentVotes);
  });

  it("takes a change as the current vote, not the original cast", async () => {
    const { a, optionsA } = polls();
    const votes = [event(a, ALICE, 1, "cast", 10n, 0), event(a, ALICE, 3, "changed", 11n, 0)];
    const { model, views } = await both(optionsA, votes);

    assert.equal(model.currentVotes.length, 1, "one voter, one current vote");
    assert.equal(model.currentVotes[0]?.optionId, 3);

    sameAsViews(a, model.currentVotes, views?.currentVotes);
  });

  it("leaves a withdrawn voter with no current option, present and null", async () => {
    const { a, optionsA } = polls();
    const votes = [event(a, ALICE, 1, "cast", 10n, 0), event(a, ALICE, 0, "withdrawn", 12n, 0)];
    const { model, views } = await both(optionsA, votes);

    assert.equal(model.currentVotes.length, 1);
    assert.equal(
      model.currentVotes[0]?.optionId,
      null,
      "a withdrawal must clear the vote rather than leave the last one standing",
    );

    sameAsViews(a, model.currentVotes, views?.currentVotes);
  });

  it("re-votes after withdrawing", async () => {
    const { a, optionsA } = polls();
    const votes = [
      event(a, ALICE, 1, "cast", 10n, 0),
      event(a, ALICE, 0, "withdrawn", 11n, 0),
      event(a, ALICE, 2, "cast", 12n, 0),
    ];
    const { model, views } = await both(optionsA, votes);

    assert.equal(model.currentVotes[0]?.optionId, 2);

    sameAsViews(a, model.currentVotes, views?.currentVotes);
  });

  it("orders by (block_number, log_index), not by log_index alone", async () => {
    // Two events in one block: a withdrawal at log 0 and a re-cast at log 5.
    // Both orders are representable in the table; only one is right.
    const { a, optionsA } = polls();
    const votes = [
      event(a, ALICE, 0, "withdrawn", 20n, 0),
      event(a, ALICE, 2, "cast", 20n, 5),
      event(a, ALICE, 1, "cast", 19n, 9),
    ];
    const { model, views } = await both(optionsA, votes);

    assert.equal(model.currentVotes[0]?.optionId, 2, "block 20 log 5 is the latest event");

    sameAsViews(a, model.currentVotes, views?.currentVotes);
  });

  it("keeps two voters in the same poll separate", async () => {
    const { a, optionsA } = polls();
    const votes = [event(a, ALICE, 1, "cast", 10n, 0), event(a, BOB, 2, "cast", 10n, 1)];
    const { model, views } = await both(optionsA, votes);

    assert.deepEqual(
      model.currentVotes.map((vote) => [vote.voter, vote.optionId]).sort(),
      [
        [ALICE, 1],
        [BOB, 2],
      ].sort(),
    );

    sameAsViews(a, model.currentVotes, views?.currentVotes);
  });

  it("keeps the same voter separate across two polls", async () => {
    // The whole point of `poll_address` in the key: one address voting in two
    // polls must produce two independent current votes.
    const { a, b, optionsA, optionsB } = polls();
    const votes = [event(a, ALICE, 1, "cast", 10n, 0), event(b, ALICE, 2, "cast", 10n, 1)];
    const { model, views } = await both([...optionsA, ...optionsB], votes);

    assert.deepEqual(
      model.currentVotes.map((vote) => [vote.pollAddress, vote.optionId]).sort(),
      [
        [a, 1],
        [b, 2],
      ].sort(),
    );

    sameAsViews(a, model.currentVotes, views?.currentVotes);
    sameAsViews(b, model.currentVotes, views?.currentVotes);
  });
});

describe("option_tally", () => {
  it("counts a plain cast once", async () => {
    const { a, optionsA } = polls();
    const { model, views } = await both(optionsA, [event(a, ALICE, 2, "cast", 10n, 0)]);

    assert.deepEqual(
      counts(model.tally),
      [
        [1, 0],
        [2, 1],
        [3, 0],
      ],
      "options nobody backs are reported as 0, matching results()",
    );

    sameAsViews(a, model.tally, views?.tally);
  });

  it("moves the vote, rather than counting both, after a change", async () => {
    // vote -> change -> the tally shows ONE vote on the new option and NONE on
    // the old one. Counting rows instead of deriving would show 1 and 1.
    const { a, optionsA } = polls();
    const votes = [event(a, ALICE, 1, "cast", 10n, 0), event(a, ALICE, 3, "changed", 11n, 0)];
    const { model, views } = await both(optionsA, votes);

    assert.deepEqual(counts(model.tally), [
      [1, 0],
      [2, 0],
      [3, 1],
    ]);

    sameAsViews(a, model.tally, views?.tally);
  });

  it("drops the vote entirely after a withdrawal", async () => {
    // vote -> withdraw -> the tally shows NONE for that voter.
    const { a, optionsA } = polls();
    const votes = [event(a, ALICE, 1, "cast", 10n, 0), event(a, ALICE, 0, "withdrawn", 11n, 0)];
    const { model, views } = await both(optionsA, votes);

    assert.deepEqual(counts(model.tally), [
      [1, 0],
      [2, 0],
      [3, 0],
    ]);

    sameAsViews(a, model.tally, views?.tally);
  });

  it("does not treat a withdrawal as a vote for option 0", async () => {
    const { a, optionsA } = polls();
    const votes = [event(a, ALICE, 1, "cast", 10n, 0), event(a, ALICE, 0, "withdrawn", 11n, 0)];
    const { model, views } = await both(optionsA, votes);

    assert.equal(
      model.tally.some((row) => row.optionId === 0),
      false,
      "option 0 is the sentinel, never a row",
    );

    sameAsViews(a, model.tally, views?.tally);
  });

  it("keeps two polls' votes from ever mixing", async () => {
    const { a, b, optionsA, optionsB } = polls();
    const votes = [
      // Three voters back option 2 of poll A...
      event(a, ALICE, 2, "cast", 10n, 0),
      event(a, BOB, 2, "cast", 10n, 1),
      event(a, "0x3333333333333333333333333333333333333333", 2, "cast", 10n, 2),
      // ...and one backs option 2 of poll B, which must not be counted with them.
      event(b, ALICE, 2, "cast", 10n, 3),
    ];
    const { model, views } = await both([...optionsA, ...optionsB], votes);

    assert.deepEqual(
      model.tally.map((row) => [row.pollAddress, row.optionId, row.voteCount]),
      [
        [a, 1, 0],
        [a, 2, 3],
        [a, 3, 0],
        [b, 1, 0],
        [b, 2, 1],
      ],
    );

    sameAsViews(a, model.tally, views?.tally);
    sameAsViews(b, model.tally, views?.tally);
  });

  it("counts only the last event when a voter changes twice", async () => {
    const { a, optionsA } = polls();
    const votes = [
      event(a, ALICE, 1, "cast", 10n, 0),
      event(a, ALICE, 2, "changed", 11n, 0),
      event(a, ALICE, 3, "changed", 12n, 0),
    ];
    const { model, views } = await both(optionsA, votes);

    assert.deepEqual(counts(model.tally), [
      [1, 0],
      [2, 0],
      [3, 1],
    ]);
    assert.equal(
      model.tally.reduce((sum, row) => sum + row.voteCount, 0),
      1,
      "one voter contributes exactly one vote, however many times they moved",
    );

    sameAsViews(a, model.tally, views?.tally);
  });

  it("counts a full voter population correctly across a mixed event stream", async () => {
    const { a, b, optionsA, optionsB } = polls();
    const CAROL = "0x4444444444444444444444444444444444444444";
    const DAVE = "0x5555555555555555555555555555555555555555";

    const votes = [
      // Alice: cast 1, change to 3, withdraw -> no vote.
      event(a, ALICE, 1, "cast", 10n, 0),
      event(a, ALICE, 3, "changed", 11n, 0),
      event(a, ALICE, 0, "withdrawn", 12n, 0),
      // Bob: cast 2 -> option 2 has one.
      event(a, BOB, 2, "cast", 10n, 1),
      // Carol: cast 1, withdraw, re-cast 2 -> option 2 has two.
      event(a, CAROL, 1, "cast", 10n, 2),
      event(a, CAROL, 0, "withdrawn", 13n, 0),
      event(a, CAROL, 2, "cast", 14n, 0),
      // Dave: cast 3 -> option 3 has one.
      event(a, DAVE, 3, "cast", 15n, 0),
      // And one vote in the OTHER poll, to prove the grouping key.
      event(b, DAVE, 1, "cast", 15n, 1),
    ];

    const { model, views } = await both([...optionsA, ...optionsB], votes);

    assert.deepEqual(
      model.tally.map((row) => [row.pollAddress, row.optionId, row.voteCount]),
      [
        [a, 1, 0],
        [a, 2, 2],
        [a, 3, 1],
        [b, 1, 1],
        [b, 2, 0],
      ],
    );

    // The invariant `Poll.results()` reports: the total equals the number of
    // addresses that currently back something, per poll.
    const totalFor = (poll: string) =>
      model.tally
        .filter((row) => row.pollAddress === poll)
        .reduce((sum, row) => sum + row.voteCount, 0);

    assert.equal(totalFor(a), 3, "Alice withdrew, so three of four voters remain");
    assert.equal(totalFor(b), 1);
    assert.equal(
      model.currentVotes.filter((vote) => vote.optionId !== null).length,
      4,
      "three in A plus one in B",
    );

    sameAsViews(a, model.tally, views?.tally);
    sameAsViews(b, model.tally, views?.tally);
  });
});

describe("the current vote agrees with what the contract's mapping would say", () => {
  it("reports at most one non-null vote per (poll, voter)", async () => {
    // `Poll.votedFor` is a single slot, so the derived answer must also be a
    // single row per pair. Two rows would mean the index can express a state the
    // contract cannot, which is exactly the kind of second authority ADR-0001
    // forbids.
    const { a, b, optionsA, optionsB } = polls();
    const votes = [
      event(a, ALICE, 1, "cast", 10n, 0),
      event(a, ALICE, 2, "changed", 11n, 0),
      event(a, ALICE, 0, "withdrawn", 12n, 0),
      event(a, ALICE, 3, "cast", 13n, 0),
      event(a, BOB, 1, "cast", 10n, 1),
      event(b, ALICE, 1, "cast", 10n, 2),
    ];
    const { model } = await both([...optionsA, ...optionsB], votes);

    const keys = model.currentVotes.map((vote) => `${vote.pollAddress}:${vote.voter}`);
    assert.equal(new Set(keys).size, keys.length, "no (poll, voter) appears twice");

    const aliceInA = model.currentVotes.filter(
      (vote) => vote.pollAddress === a && vote.voter === ALICE,
    );
    assert.equal(aliceInA.length, 1);
    assert.equal(aliceInA[0]?.optionId, 3, "the last thing Alice did in poll A was cast 3");
  });

  it("returns nothing for a (poll, voter) that has no events", async () => {
    const { a, optionsA } = polls();
    const { model } = await both(optionsA, [event(a, ALICE, 1, "cast", 10n, 0)]);

    // The contract's mapping would answer 0 for an address that never voted; the
    // view simply has no row, which the reader maps to null. The distinction the
    // view must NOT lose is "withdrew" (a row with NULL) versus "never voted"
    // (no row) — both mean "no current vote", but only one of them happened.
    const bob = model.currentVotes.find((vote: CurrentVote) => vote.voter === BOB);
    assert.equal(bob, undefined);

    const alice = model.currentVotes.find((vote: CurrentVote) => vote.voter === ALICE);
    assert.notEqual(alice, undefined);
  });
});

describe("option_tally rows", () => {
  it("carries the option's label so a reader needs no second query", async () => {
    const { b, optionsB } = polls();
    const { model, views } = await both(optionsB, [event(b, ALICE, 1, "cast", 10n, 0)]);

    assert.deepEqual(model.tally, [
      { pollAddress: b, optionId: 1, labelCid: "cid-b1", voteCount: 1 },
      { pollAddress: b, optionId: 2, labelCid: "cid-b2", voteCount: 0 },
    ] satisfies OptionTallyRow[]);

    sameAsViews(b, model.tally, views?.tally);
  });
});
