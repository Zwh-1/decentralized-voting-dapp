// SPDX-License-Identifier: MIT
/**
 * Paging, searching and sorting the poll list.
 *
 * ---------------------------------------------------------------------------
 * Why this is pure and separate from the route
 * ---------------------------------------------------------------------------
 *
 * These are the rules a reader can check: "why is my poll not on page 2", "why
 * did searching hide the poll I was looking at", "why is the newest poll last".
 * Every one of them is an off-by-one or an ordering mistake, none is visible in a
 * rendered page, and a route handler cannot be unit tested for them without a
 * chain and a database. So the arithmetic lives here, in functions that take an
 * array and return an array, and the route only parses its query string.
 *
 * ---------------------------------------------------------------------------
 * Why the input is never mutated
 * ---------------------------------------------------------------------------
 *
 * `sort` in place would reorder the array the caller passed — and the caller is
 * `getPolls`, which returns a freshly built array today but is free to memoise
 * tomorrow. A paging helper that silently reorders its caller's cache makes the
 * next reader see an order nobody asked for, and it would look like the chain
 * returned polls out of order.
 */

import type { PollSummary } from "./types";

/**
 * How a page of results was chosen, so a caller can report it honestly.
 *
 * The point of returning this rather than just the rows: a reader who asked for
 * page 9 of 3 needs to be told the page was clamped, not shown page 3 and left to
 * believe there were nine. An empty page is the other case — it means the search
 * matched nothing, which is different from "this poll does not exist".
 */
export interface Page<T> {
  /** The rows on this page, in the requested order. */
  items: T[];
  /** 1-based page number actually used, after clamping. */
  page: number;
  pageSize: number;
  /** How many rows matched before paging. */
  total: number;
  /** How many pages exist for this filter. Always at least 1. */
  pageCount: number;
  /** True when `page` differs from the requested one. */
  clamped: boolean;
}

export const DEFAULT_PAGE_SIZE = 20;

/**
 * The largest page a caller may request.
 *
 * A cap is not about performance here — the poll list is small — but about the
 * response being a page at all. Without it `?pageSize=100000` silently means
 * "everything", and a caller that believes it is paging would be wrong.
 */
export const MAX_PAGE_SIZE = 100;

/** The sorts a caller may ask for. Anything else is refused, not guessed at. */
export const SORT_ORDERS = ["newest", "oldest", "most-voted", "question"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const DEFAULT_SORT: SortOrder = "newest";

/** True when `value` is one of the accepted sort keywords. */
export function isSortOrder(value: string): value is SortOrder {
  return (SORT_ORDERS as readonly string[]).includes(value);
}

/**
 * Reads a positive integer query parameter.
 *
 * Returns `null` for anything that is not one, so the caller can decide between
 * defaulting and reporting an error. Absent and empty both mean "not supplied"
 * and yield `null` rather than `0`, which matters because `0` is a valid-looking
 * number that would then be clamped somewhere far away from the mistake.
 */
export function parsePositiveInteger(raw: string | null): number | null {
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // `Number` rather than `parseInt`: `parseInt("12abc")` is 12, which would let a
  // typo through as a valid page number. `Number` rejects the whole string.
  const parsed = Number(trimmed);

  if (!Number.isInteger(parsed) || parsed < 1) return null;

  return parsed;
}

/**
 * Narrows a requested page size into the allowed range.
 *
 * A size above the cap is clamped to it rather than refused. The alternative —
 * an error — would break a caller that asked for 200 expecting "as many as you
 * have", and the clamp is visible in the returned `pageSize`.
 */
export function clampPageSize(requested: number | null): number {
  if (requested === null) return DEFAULT_PAGE_SIZE;

  return Math.min(requested, MAX_PAGE_SIZE);
}

/**
 * Searches a poll by its human-readable fields.
 *
 * Case-insensitive substring, not a fuzzy match: a reader typing part of a
 * question expects the polls containing it, and a fuzzy matcher would return
 * polls that do not contain what they typed — which reads as a broken search
 * rather than a helpful one.
 *
 * The address is matched too, and prefix-anchored for it. Someone pasting an
 * address is looking for THAT poll; a substring match on a hex address would
 * return every poll whose address happens to contain those digits.
 */
export function matchesQuery(poll: PollSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  if (poll.question.toLowerCase().includes(needle)) return true;
  if (poll.creator.toLowerCase().includes(needle)) return true;

  // `startsWith` after stripping `0x`, so both "0xabc…" and "abc…" find it.
  const address = poll.address.toLowerCase();
  if (address.startsWith(needle)) return true;
  if (address.replace(/^0x/, "").startsWith(needle.replace(/^0x/, ""))) return true;

  return false;
}

/** Applies the search filter, preserving the input order. */
export function filterPolls(polls: readonly PollSummary[], query: string): PollSummary[] {
  if (query.trim().length === 0) return [...polls];

  return polls.filter((poll) => matchesQuery(poll, query));
}

/**
 * Orders polls.
 *
 * Ties are broken by address so the order is TOTAL. Without a tie-break, two
 * polls with the same deadline could swap places between requests — JS sort is
 * stable, so they would not within one array, but the array itself is rebuilt
 * from a chain read whose order is not guaranteed. A list that reshuffles
 * between page 1 and page 2 loses and duplicates rows across pages, which is the
 * classic paging bug and the reason this tie-break is not optional.
 *
 * `endsAt` and `totalVotes` are compared as numbers: both are bounded well below
 * 2^53 in practice, and `endsAt` arrives as a string that MUST be converted, or
 * "999999999" would sort before "1000000000" as text.
 */
export function sortPolls(polls: readonly PollSummary[], order: SortOrder): PollSummary[] {
  const sorted = [...polls];

  const byAddress = (a: PollSummary, b: PollSummary) => a.address.localeCompare(b.address);

  switch (order) {
    case "oldest":
      sorted.sort((a, b) => Number(a.endsAt) - Number(b.endsAt) || byAddress(a, b));
      break;
    case "most-voted":
      // Highest first: "most voted" is a ranking a reader scans from the top.
      sorted.sort((a, b) => b.totalVotes - a.totalVotes || byAddress(a, b));
      break;
    case "question":
      sorted.sort((a, b) => a.question.localeCompare(b.question) || byAddress(a, b));
      break;
    case "newest":
    default:
      sorted.sort((a, b) => Number(b.endsAt) - Number(a.endsAt) || byAddress(a, b));
      break;
  }

  return sorted;
}

/**
 * Splits a filtered list into one page.
 *
 * A page beyond the end is CLAMPED to the last page rather than returned empty,
 * and `clamped` says so. This is the deliberate choice: a reader who deletes a
 * search term while on page 5 should land on the last real page, not on a blank
 * screen that looks like the app is broken. The flag exists so the caller can
 * mention it rather than hide it.
 *
 * `pageSize` is clamped to `MAX_PAGE_SIZE` here as well as at the route, so a
 * caller that builds a `Page` directly cannot bypass the cap.
 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const size = clampPageSize(pageSize);
  const total = items.length;

  // Never zero: a filter that matches nothing still has page 1, and reporting
  // `pageCount: 0` would make "page 1 of 0" — a page that cannot exist.
  const pageCount = Math.max(1, Math.ceil(total / size));

  const requested = Number.isInteger(page) && page >= 1 ? page : 1;
  const used = Math.min(requested, pageCount);

  const start = (used - 1) * size;

  return {
    items: items.slice(start, start + size),
    page: used,
    pageSize: size,
    total,
    pageCount,
    clamped: used !== requested,
  };
}

/**
 * The whole list transform in one call: filter, sort, page.
 *
 * Exists so the route and any other caller cannot apply these in a different
 * order. Paging before sorting would page the unsorted list and then sort only
 * the page, which looks right on page 1 and is wrong on every page after it —
 * exactly the bug that would survive a casual check.
 */
export function pagePolls(
  polls: readonly PollSummary[],
  options: { query?: string; sort?: SortOrder; page?: number; pageSize?: number },
): Page<PollSummary> {
  const filtered = filterPolls(polls, options.query ?? "");
  const sorted = sortPolls(filtered, options.sort ?? DEFAULT_SORT);

  return paginate(sorted, options.page ?? 1, options.pageSize ?? DEFAULT_PAGE_SIZE);
}

/**
 * One poll in the browser's list: an address that certainly exists, and the
 * summary for it if one has been read.
 *
 * The address comes from the chain, so it is never wrong about existence. The
 * summary comes from a server read that happened earlier, so a poll created
 * since then has `null` here — and that null is the whole reason this type
 * exists rather than a plain `PollSummary[]`.
 */
export interface ListEntry {
  address: string;
  summary: PollSummary | null;
}

/**
 * Whether an entry answers a search.
 *
 * THE RULE THAT MATTERS: an entry with no summary is KEPT, whatever the query.
 * There is nothing to match against — the question has not been read yet — and
 * dropping it would hide a poll the chain says exists. A search result that
 * quietly omits polls is worse than one that includes a poll the reader did not
 * want, because the reader has no way to notice the omission.
 *
 * This is why the list is not simply filtered as `PollSummary[]`: doing that
 * would require a summary for every poll before any search ran, which is the
 * round trip the chain-direct design exists to avoid.
 */
export function entryMatches(entry: ListEntry, query: string): boolean {
  if (entry.summary === null) return true;

  return matchesQuery(entry.summary, query);
}

/**
 * Orders entries.
 *
 * Entries without a summary sort FIRST under `newest` and LAST under every other
 * order, and the asymmetry is deliberate:
 *
 *   * `newest` is what the browser list uses by default, and a poll that appeared
 *     after the server read is by definition the newest thing on the page. It
 *     belongs at the top, where the reader who just created it will look.
 *   * every other order is a statement about a VALUE (oldest, most-voted,
 *     alphabetical). An unread poll has no such value, so guessing one would
 *     place it by coincidence. Putting those last keeps the sorted part sorted
 *     and marks the rest as not-yet-known rather than interleaving noise.
 */
export function sortEntries(entries: readonly ListEntry[], order: SortOrder): ListEntry[] {
  const known = entries.filter((entry) => entry.summary !== null);
  const unknown = entries.filter((entry) => entry.summary === null);

  const sortedKnown = sortPolls(
    known.map((entry) => entry.summary as PollSummary),
    order,
  );

  const byAddress = (a: ListEntry, b: ListEntry) => a.address.localeCompare(b.address);
  const unknownSorted = [...unknown].sort(byAddress);

  const knownSorted = sortedKnown.map((summary) => ({
    address: summary.address,
    summary,
  }));

  return order === "newest"
    ? [...unknownSorted, ...knownSorted]
    : [...knownSorted, ...unknownSorted];
}

/**
 * Filter, sort and page a list that may be missing some summaries.
 *
 * The list equivalent of `pagePolls`, for the case where the addresses came from
 * the chain but the summaries did not all arrive with them.
 */
export function pageEntries(
  entries: readonly ListEntry[],
  options: { query?: string; sort?: SortOrder; page?: number; pageSize?: number },
): Page<ListEntry> {
  const query = options.query ?? "";

  const filtered = entries.filter((entry) => entryMatches(entry, query));
  const sorted = sortEntries(filtered, options.sort ?? DEFAULT_SORT);

  return paginate(sorted, options.page ?? 1, options.pageSize ?? DEFAULT_PAGE_SIZE);
}
