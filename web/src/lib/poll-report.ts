// SPDX-License-Identifier: MIT
/**
 * Turning a poll's event stream into things a person can check.
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 *
 * The chain already holds everything needed to audit a poll — every cast, every
 * change, every withdrawal, every phase transition, each with a block number. But
 * "the data is on chain" is not the same as "anyone can check it": nobody is
 * going to reconstruct a tally by hand from raw logs. So the last mile is turning
 * the stream into a form a human or a spreadsheet can verify against, and that is
 * what this module produces.
 *
 * ---------------------------------------------------------------------------
 * Why it is pure and separate from the route that serves it
 * ---------------------------------------------------------------------------
 *
 * Two reasons, and the second is the important one.
 *
 * `web/test/**` cannot import anything that reaches React or wagmi, so logic that
 * lives in a component or a route handler cannot be tested — it can only be
 * exercised by running the whole stack.
 *
 * More importantly, the failure that matters here is producing an export that is
 * CONFIDENTLY WRONG: a tally that silently omits a kind of event, a CSV whose
 * columns shift by one because a value contained a comma, a "final result" whose
 * numbers do not add up to the total beside them. An export that is wrong is
 * worse than no export, because it is the artefact people cite. Being pure is
 * what makes those cases testable with plain values instead of a live chain.
 */

/** One thing that happened to one poll, as the indexer recorded it. */
export interface ActivityEntry {
  /** Block the event was mined in, as a decimal string. */
  blockNumber: string;
  /** Transaction that carried it. */
  txHash: string;
  /** Which table it came from; the UI labels rows by this. */
  kind: "cast" | "changed" | "withdrawn" | "refunded" | "whitelist" | "phase";
  /** The address it concerns, when the event names one. */
  actor?: string | undefined;
  /** The option id it concerns, for the vote-shaped kinds. */
  optionId?: number | null | undefined;
  /** Extra detail the row should show, already human-readable. */
  detail?: string | undefined;
}

/**
 * The activity feed, newest first.
 *
 * Sorted by block descending, and by transaction hash descending within a block
 * so the order is *stable* rather than merely arbitrary. A block contains several
 * of these events and SQLite/MySQL will not promise an order without an ORDER BY
 * — so without the tiebreak, two requests for the same page of history can
 * disagree about which row came first, and a reader comparing two screenshots
 * sees a difference that is not real.
 *
 * Descending because the interesting end of a poll's history is the recent one:
 * "did someone vote just now" is the question, not "what happened at creation".
 */
export function orderActivity(entries: ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((left, right) => {
    const blockDiff = compareDecimalStrings(right.blockNumber, left.blockNumber);
    if (blockDiff !== 0) {
      return blockDiff;
    }

    return right.txHash.localeCompare(left.txHash);
  });
}

/**
 * Compare two decimal strings as numbers.
 *
 * Block numbers arrive as strings because they exceed what a JS number holds
 * exactly, and `Number()` on a large height silently loses the low digits — which
 * would make two distinct recent blocks compare equal and scramble the feed.
 * Comparing digit length first and then lexically is exact and needs no BigInt
 * per comparison.
 */
function compareDecimalStrings(left: string, right: string): number {
  const l = left.replace(/^0+/, "") || "0";
  const r = right.replace(/^0+/, "") || "0";

  if (l.length !== r.length) {
    return l.length < r.length ? -1 : 1;
  }

  return l < r ? -1 : l > r ? 1 : 0;
}

/**
 * Drop the `VoteCast` that `changeVote` emits alongside `VoteChanged`.
 *
 * `changeVote` emits BOTH events in one transaction: the change is the action and
 * the cast re-states the new count so a tally-only consumer still sees it
 * (ADR-0024). Listing both would show a reader "改投到选项 2" immediately followed
 * by "投票 选项 2" — two rows for one click, the second reading as though the
 * address had voted twice when it holds exactly one vote.
 *
 * Keyed on the TRANSACTION, not on the voter or the option: the two events come
 * from a single call, so the hash is what identifies the pair. Two different
 * addresses changing their vote in the same block have different hashes and both
 * keep their cast rows.
 *
 * This is a pure function rather than a filter inline in the query because the
 * rule has a real failure mode in both directions — suppress too much and a first
 * vote vanishes from the record; suppress too little and the record claims an
 * action that never happened — and neither is visible without a case pinning the
 * boundary.
 */
export function withoutChangeEcho(entries: ActivityEntry[]): ActivityEntry[] {
  const changedTxHashes = new Set(
    entries.filter((entry) => entry.kind === "changed").map((entry) => entry.txHash),
  );

  return entries.filter((entry) => !(entry.kind === "cast" && changedTxHashes.has(entry.txHash)));
}

/** One row of a result export. */
export interface ExportRow {
  optionId: number;
  label: string;
  votes: number;
  sharePercent: number;
}

/**
 * The result table, in the order a reader should see it.
 *
 * Sorted by votes descending, then by option id ascending. The second key is not
 * decoration: without it two options tied at zero — which is every option before
 * the first vote — come back in whatever order the source array happened to be
 * in, and the export changes shape between runs for no reason.
 *
 * Ties keep their option order, so "the first option listed" is stable and a
 * reader can compare two exports of the same poll line by line.
 */
export function resultRows(options: { id: number; label: string; votes: number }[]): ExportRow[] {
  const total = options.reduce((sum, option) => sum + option.votes, 0);

  return [...options]
    .sort((left, right) => right.votes - left.votes || left.id - right.id)
    .map((option) => ({
      optionId: option.id,
      label: option.label,
      votes: option.votes,
      sharePercent:
        total <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((option.votes / total) * 1000) / 10)),
    }));
}

/**
 * A CSV cell, quoted so the file cannot be broken by its own contents.
 *
 * Every field is quoted rather than only the ones that look like they need it.
 * The alternative is a rule — "quote if it contains a comma, a quote or a
 * newline" — and that rule is exactly the kind of thing that is right until an
 * option label contains a semicolon in one locale and a comma in another. Since
 * option labels here are free text supplied by a poll's creator, they can contain
 * anything at all.
 *
 * A double quote inside a cell is escaped by doubling it, which is what RFC 4180
 * specifies and what every spreadsheet implements.
 */
export function csvCell(value: string | number): string {
  const text = String(value);

  /*
    A leading =, +, - or @ makes Excel and LibreOffice treat the cell as a
    FORMULA. In an export whose whole purpose is that a third party can open it
    and check the numbers, a label of `=1+1` executing in the reviewer's
    spreadsheet is a real hazard — it is the CSV-injection case, and it arrives
    through data a poll's creator controls. Prefixing with a single quote makes it
    text in every spreadsheet while leaving the visible label unchanged.
  */
  const neutralised = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return `"${neutralised.replace(/"/g, '""')}"`;
}

/** A whole CSV document for a poll's result. */
export function resultCsv(input: {
  pollAddress: string;
  question: string;
  phase: string;
  endsAt: string;
  totalVotes: number;
  rows: ExportRow[];
}): string {
  const lines = [
    ["投票合约", input.pollAddress],
    ["问题", input.question],
    ["阶段", input.phase],
    ["截止时间", input.endsAt],
    ["票数合计", input.totalVotes],
    [],
    ["选项 ID", "选项", "票数", "占比%"],
    ...input.rows.map((row) => [row.optionId, row.label, row.votes, row.sharePercent]),
  ];

  /*
    CRLF line endings, per RFC 4180. Not cosmetic: this file exists to be opened
    in Excel, and a bare LF is what makes a CSV arrive as one long line there.
  */
  return `${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/**
 * The share of the electorate that has voted.
 *
 * `eligible` is the DENOMINATOR — the frozen eligible voting power — and not the
 * number of admitted addresses. The two are equal on an equal-weight poll and
 * differ everywhere else: on a weighted poll the tally is a sum of weights, so
 * dividing it by an address count would report a turnout above 100% as soon as
 * any weight exceeded one.
 *
 * It is optional because it is genuinely not always knowable. An open poll has no
 * enumerable electorate, and a poll still in `Setup` has not frozen its
 * denominator yet — a quorum on an open poll is refused at creation for exactly
 * that reason. When it is unknown this returns `null` rather than a percentage of
 * the wrong denominator: "0% turnout" and "we cannot compute turnout" are
 * different statements and only one of them is true (ADR-0011).
 */
export function turnout(votes: number, eligible: number | null | undefined): number | null {
  if (eligible === null || eligible === undefined || !Number.isFinite(eligible) || eligible <= 0) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round((votes / eligible) * 1000) / 10));
}
