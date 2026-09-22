// SPDX-License-Identifier: MIT
/**
 * Tests for paging, searching and sorting the poll list.
 *
 * These are the rules a reader can check and cannot see: "why is my poll not on
 * page 2", "why did searching hide the poll I was looking at", "why did page 1
 * and page 2 both show the same poll". Every one is an off-by-one or an
 * ordering mistake, so the assertions are about boundaries and total order rather
 * than about the happy path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampPageSize,
  entryMatches,
  filterPolls,
  isSortOrder,
  matchesQuery,
  pageEntries,
  pagePolls,
  paginate,
  parsePositiveInteger,
  sortEntries,
  sortPolls,
  type ListEntry,
} from "../src/lib/pagination";
import type { PollSummary } from "../src/lib/types";

function poll(overrides: Partial<PollSummary> & { address: string }): PollSummary {
  return {
    creator: "0x1111111111111111111111111111111111111111",
    question: "A question",
    endsAt: "1000",
    optionCount: 2,
    phase: 1,
    totalVotes: 0,
    ...overrides,
  };
}

const POLLS: PollSummary[] = [
  poll({ address: "0xaaa1", question: "Lunch?", endsAt: "300", totalVotes: 5 }),
  poll({ address: "0xbbb2", question: "Budget?", endsAt: "100", totalVotes: 20 }),
  poll({ address: "0xccc3", question: "apricot", endsAt: "200", totalVotes: 5 }),
];

/**
 * The fixture poll at one position.
 *
 * `noUncheckedIndexedAccess` types every lookup as possibly undefined, and the
 * tests below index the fixture constantly. Doing it once here means a test that
 * asks for a poll that does not exist fails with a message naming the position,
 * rather than a confusing "cannot read 'question' of undefined".
 */
function pollAt(position: number): PollSummary {
  const entry = POLLS[position];
  assert.ok(entry, `no fixture poll at position ${position}`);

  return entry;
}

describe("parsePositiveInteger", () => {
  it("reads a plain integer", () => {
    assert.equal(parsePositiveInteger("7"), 7);
  });

  it("treats absent and empty as not supplied", () => {
    // Not 0. Zero is a number that would be silently clamped somewhere far from
    // the mistake that produced it.
    assert.equal(parsePositiveInteger(null), null);
    assert.equal(parsePositiveInteger(""), null);
    assert.equal(parsePositiveInteger("   "), null);
  });

  it("refuses a partially numeric string rather than reading its prefix", () => {
    // `parseInt("12abc")` is 12, which would let a typo through as a valid page.
    assert.equal(parsePositiveInteger("12abc"), null);
  });

  it("refuses zero, negatives and fractions", () => {
    assert.equal(parsePositiveInteger("0"), null);
    assert.equal(parsePositiveInteger("-1"), null);
    assert.equal(parsePositiveInteger("1.5"), null);
  });

  it("refuses a value that is not a number at all", () => {
    assert.equal(parsePositiveInteger("page"), null);
  });

  it("survives Infinity and NaN rather than passing them on", () => {
    assert.equal(parsePositiveInteger("Infinity"), null);
    assert.equal(parsePositiveInteger("NaN"), null);
  });
});

describe("clampPageSize", () => {
  it("defaults when not supplied", () => {
    assert.equal(clampPageSize(null), DEFAULT_PAGE_SIZE);
  });

  it("caps an oversized request rather than failing it", () => {
    // Refusing would break a caller asking for "as many as you have"; the clamp
    // is reported back in `pageSize` so it is visible.
    assert.equal(clampPageSize(100_000), MAX_PAGE_SIZE);
  });

  it("passes a reasonable size through", () => {
    assert.equal(clampPageSize(5), 5);
  });

  it("allows exactly the cap", () => {
    assert.equal(clampPageSize(MAX_PAGE_SIZE), MAX_PAGE_SIZE);
  });
});

describe("isSortOrder", () => {
  it("accepts each documented keyword", () => {
    for (const order of ["newest", "oldest", "most-voted", "question"]) {
      assert.equal(isSortOrder(order), true, order);
    }
  });

  it("refuses anything else, so an unknown sort is not silently defaulted", () => {
    assert.equal(isSortOrder("cheapest"), false);
    assert.equal(isSortOrder("NEWEST"), false, "case is part of the keyword");
    assert.equal(isSortOrder(""), false);
  });
});

describe("matchesQuery", () => {
  it("matches nothing when the query is blank", () => {
    assert.equal(matchesQuery(pollAt(0), ""), true);
    assert.equal(matchesQuery(pollAt(0), "   "), true);
  });

  it("is case insensitive on the question", () => {
    assert.equal(matchesQuery(pollAt(2), "APRICOT"), true);
    assert.equal(matchesQuery(pollAt(2), "apric"), true);
  });

  it("matches the creator address", () => {
    assert.equal(matchesQuery(pollAt(0), "0x1111"), true);
  });

  it("anchors the address at the start rather than matching a substring", () => {
    // Someone pasting an address wants THAT poll. A substring match would return
    // every poll whose address happens to contain those digits.
    assert.equal(matchesQuery(pollAt(0), "aaa1"), true, "with the 0x stripped");
    assert.equal(matchesQuery(pollAt(0), "aa1"), false, "but not from the middle");
  });

  it("does not match a poll that lacks the text", () => {
    assert.equal(matchesQuery(pollAt(0), "budget"), false);
  });
});

describe("filterPolls", () => {
  it("returns everything for a blank query", () => {
    assert.equal(filterPolls(POLLS, "").length, 3);
  });

  it("narrows to the match", () => {
    const found = filterPolls(POLLS, "budget");

    assert.equal(found.length, 1);
    assert.equal(found[0]?.address, "0xbbb2");
  });

  it("returns an empty list rather than throwing when nothing matches", () => {
    assert.deepEqual(filterPolls(POLLS, "nothing here"), []);
  });

  it("does not mutate the input", () => {
    const before = POLLS.map((p) => p.address);
    filterPolls(POLLS, "budget");

    assert.deepEqual(
      POLLS.map((p) => p.address),
      before,
    );
  });
});

describe("sortPolls", () => {
  it("puts the latest deadline first for newest", () => {
    assert.deepEqual(
      sortPolls(POLLS, "newest").map((p) => p.endsAt),
      ["300", "200", "100"],
    );
  });

  it("puts the earliest deadline first for oldest", () => {
    assert.deepEqual(
      sortPolls(POLLS, "oldest").map((p) => p.endsAt),
      ["100", "200", "300"],
    );
  });

  it("compares deadlines as numbers, not as strings", () => {
    // The bug this pins down: `endsAt` crosses the wire as a string, and as text
    // "999999999" sorts BEFORE "1000000000" because "9" > "1".
    const polls = [
      poll({ address: "0xa", endsAt: "999999999" }),
      poll({ address: "0xb", endsAt: "1000000000" }),
    ];

    assert.deepEqual(
      sortPolls(polls, "newest").map((p) => p.endsAt),
      ["1000000000", "999999999"],
    );
  });

  it("ranks the most voted first", () => {
    assert.deepEqual(
      sortPolls(POLLS, "most-voted").map((p) => p.totalVotes),
      [20, 5, 5],
    );
  });

  it("breaks ties by address so the order is total", () => {
    // Without this, two polls with the same deadline could swap between requests
    // and a reader paging through would see one twice and miss another.
    const tied = [
      poll({ address: "0xccc3", endsAt: "200" }),
      poll({ address: "0xaaa1", endsAt: "200" }),
      poll({ address: "0xbbb2", endsAt: "200" }),
    ];

    assert.deepEqual(
      sortPolls(tied, "newest").map((p) => p.address),
      ["0xaaa1", "0xbbb2", "0xccc3"],
    );
  });

  it("sorts by question alphabetically", () => {
    assert.deepEqual(
      sortPolls(POLLS, "question").map((p) => p.question),
      ["apricot", "Budget?", "Lunch?"],
    );
  });

  it("does not mutate the input", () => {
    const before = POLLS.map((p) => p.address);
    sortPolls(POLLS, "most-voted");

    assert.deepEqual(
      POLLS.map((p) => p.address),
      before,
    );
  });
});

describe("paginate", () => {
  const items = [1, 2, 3, 4, 5];

  it("returns the first page by default shape", () => {
    const page = paginate(items, 1, 2);

    assert.deepEqual(page.items, [1, 2]);
    assert.equal(page.page, 1);
    assert.equal(page.pageCount, 3);
    assert.equal(page.total, 5);
    assert.equal(page.clamped, false);
  });

  it("returns a middle page", () => {
    assert.deepEqual(paginate(items, 2, 2).items, [3, 4]);
  });

  it("returns a short final page rather than padding it", () => {
    assert.deepEqual(paginate(items, 3, 2).items, [5]);
  });

  it("clamps a page beyond the end and says so", () => {
    const page = paginate(items, 99, 2);

    assert.equal(page.page, 3, "clamped to the last page");
    assert.equal(page.clamped, true);
    assert.deepEqual(page.items, [5]);
  });

  it("treats an empty list as one empty page, not zero pages", () => {
    // `pageCount: 0` would render "page 1 of 0" — a page that cannot exist.
    const page = paginate([], 1, 10);

    assert.deepEqual(page.items, []);
    assert.equal(page.page, 1);
    assert.equal(page.pageCount, 1);
    assert.equal(page.total, 0);
  });

  it("does not duplicate or drop rows across consecutive pages", () => {
    // The property that matters most and is hardest to see by eye. Every item
    // must appear exactly once across the whole run of pages.
    const seen: number[] = [];
    const pageCount = paginate(items, 1, 2).pageCount;

    for (let page = 1; page <= pageCount; page += 1) {
      seen.push(...paginate(items, page, 2).items);
    }

    assert.deepEqual(seen, items, "each row exactly once, in order");
  });

  it("caps the page size even when called directly", () => {
    assert.equal(paginate(items, 1, 100_000).pageSize, MAX_PAGE_SIZE);
  });

  it("treats a nonsensical page number as the first page", () => {
    assert.equal(paginate(items, 0, 2).page, 1);
    assert.equal(paginate(items, -3, 2).page, 1);
  });
});

describe("pagePolls", () => {
  it("searches, sorts and pages in that order", () => {
    // Sorting after paging would sort only the page, which looks right on page 1
    // and is wrong on every page after it.
    const page = pagePolls(POLLS, { sort: "newest", page: 1, pageSize: 1 });

    assert.equal(page.total, 3);
    assert.deepEqual(
      page.items.map((p) => p.endsAt),
      ["300"],
    );
    assert.equal(page.pageCount, 3);
  });

  it("pages the FILTERED list, so total reflects the search", () => {
    const page = pagePolls(POLLS, { query: "0x1111" });

    assert.equal(page.total, 3, "all three have that creator");
    assert.equal(page.pageCount, 1);
  });

  it("defaults to newest with the default page size", () => {
    const page = pagePolls(POLLS, {});

    assert.equal(page.pageSize, DEFAULT_PAGE_SIZE);
    assert.deepEqual(
      page.items.map((p) => p.endsAt),
      ["300", "200", "100"],
    );
  });

  it("yields one empty page when the search matches nothing", () => {
    const page = pagePolls(POLLS, { query: "no such poll" });

    assert.deepEqual(page.items, []);
    assert.equal(page.total, 0);
    assert.equal(page.pageCount, 1);
    assert.equal(page.clamped, false, "page 1 of an empty result is not clamped");
  });
});

// ---------------------------------------------------------------------------
// Entries: the browser list, where some polls have no summary yet
// ---------------------------------------------------------------------------

/** An entry whose summary the browser has not read yet. */
function unread(address: string): ListEntry {
  return { address, summary: null };
}

function read(pollSummary: PollSummary): ListEntry {
  return { address: pollSummary.address, summary: pollSummary };
}

describe("entryMatches", () => {
  it("KEEPS an entry with no summary whatever the query says", () => {
    // The rule the whole entry design exists for. There is nothing to match
    // against, and dropping the poll would hide one the chain says exists — a
    // search result that silently omits polls is worse than one that includes a
    // poll the reader did not want, because the omission cannot be noticed.
    assert.equal(entryMatches(unread("0xdead"), "lunch"), true);
    assert.equal(entryMatches(unread("0xdead"), "no such poll"), true);
  });

  it("applies the ordinary query rules once a summary exists", () => {
    assert.equal(entryMatches(read(pollAt(0)), "lunch"), true);
    assert.equal(entryMatches(read(pollAt(0)), "budget"), false);
  });
});

describe("sortEntries", () => {
  it("puts unread polls FIRST under newest", () => {
    // A poll that appeared after the server read is by definition the newest
    // thing on the page, and it belongs where the reader who just made it looks.
    const entries = [read(pollAt(1)), unread("0xfff"), read(pollAt(0))];

    assert.deepEqual(
      sortEntries(entries, "newest").map((entry) => entry.address),
      ["0xfff", "0xaaa1", "0xbbb2"],
    );
  });

  it("puts unread polls LAST under every other order", () => {
    // Those orders are statements about a value the unread poll does not have,
    // so placing it by guess would be a coincidence rather than a ranking.
    const entries = [read(pollAt(1)), unread("0xfff"), read(pollAt(0))];

    for (const order of ["oldest", "most-voted", "question"] as const) {
      const sorted = sortEntries(entries, order);
      assert.equal(sorted[sorted.length - 1]?.address, "0xfff", order);
    }
  });

  it("orders the unread group by address so it does not reshuffle", () => {
    const entries = [unread("0xccc"), unread("0xaaa"), unread("0xbbb")];

    assert.deepEqual(
      sortEntries(entries, "newest").map((entry) => entry.address),
      ["0xaaa", "0xbbb", "0xccc"],
    );
  });

  it("keeps every entry, so nothing is dropped by ordering alone", () => {
    const entries = [read(pollAt(0)), unread("0xfff"), read(pollAt(1)), read(pollAt(2))];

    assert.equal(sortEntries(entries, "most-voted").length, 4);
  });
});

describe("pageEntries", () => {
  it("pages the list, counting unread polls in the total", () => {
    const entries = [...POLLS.map(read), unread("0xfff")];
    const page = pageEntries(entries, { page: 1, pageSize: 10 });

    assert.equal(page.total, 4);
    assert.equal(page.items.length, 4);
  });

  it("does not hide an unread poll behind a search that cannot match it", () => {
    // The end-to-end consequence of the rule above, at the level the UI uses.
    const entries = [read(pollAt(0)), unread("0xfff")];
    const page = pageEntries(entries, { query: "budget" });

    assert.ok(
      page.items.some((entry) => entry.address === "0xfff"),
      "the unread poll survives a search that no summary of it could satisfy",
    );
  });

  it("still narrows to a genuine match when every entry is read", () => {
    const entries = POLLS.map(read);
    const page = pageEntries(entries, { query: "budget" });

    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.address, "0xbbb2");
  });

  it("returns the first page of an empty list rather than throwing", () => {
    const page = pageEntries([], { query: "anything" });

    assert.deepEqual(page.items, []);
    assert.equal(page.pageCount, 1);
  });
});
