// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { currentLocale } from "@/lib/i18n/server";
import { getPolls } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import {
  DEFAULT_SORT,
  clampPageSize,
  isSortOrder,
  pagePolls,
  parsePositiveInteger,
  type SortOrder,
} from "@/lib/pagination";

export const dynamic = "force-dynamic";

/**
 * Every poll created through the factory, one page at a time.
 *
 * ---------------------------------------------------------------------------
 * Why the chain is the source, and paging here is therefore real
 * ---------------------------------------------------------------------------
 *
 * Read from the chain, not the index: the factory is the authority on which
 * polls exist, and this route must not hide a poll merely because the index has
 * not caught up with it yet.
 *
 * That choice is also what makes the paging honest. The whole list is in hand
 * before a page is cut, so `total` and `pageCount` describe the real result set
 * rather than "how many rows the index happened to return". There is no degraded
 * mode to disclaim — the alternative, asking MySQL for a LIMIT, would have made
 * the page boundaries depend on index lag, and a poll created seconds ago would
 * then be on no page at all until the indexer caught up.
 *
 * ---------------------------------------------------------------------------
 * Why an unknown sort is refused rather than defaulted
 * ---------------------------------------------------------------------------
 *
 * `?sort=cheapest` is a caller mistake. Silently answering with `newest` would
 * make a broken link look like a working one, and the reader would have no way to
 * tell that their ordering was ignored. The accepted keywords are listed in the
 * error so the caller can fix it without reading this file.
 *
 * ---------------------------------------------------------------------------
 * Why this response can repeat itself for a couple of seconds
 * ---------------------------------------------------------------------------
 *
 * `getPolls` is cached for `READ_CACHE_TTL_MS` (2s by default), because it is one
 * `allPolls()` plus one summary read PER POLL, and this route, the list page and
 * the detail page all read it within the same second — which is how an app
 * reaches its own RPC rate limit. See `cache.ts`.
 *
 * The response therefore does NOT claim to be fresh, and deliberately does not
 * carry a "possibly stale" marker either. A caller cannot act on the difference:
 * there is no parameter that would make it fresher, and the browser-side read
 * through the wallet replaces this answer regardless. Advertising a staleness the
 * caller cannot avoid would only invite it to be handled wrongly.
 *
 * The bound is what makes this acceptable rather than the marker: 2s sits far
 * inside the confirmation window, so nothing here can be presented as final while
 * the chain still calls it unconfirmed. The consistency check does not read
 * through this cache — see ADR-0039.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const rawSort = params.get("sort");
  const sort: SortOrder =
    rawSort === null || rawSort === "" ? DEFAULT_SORT : (rawSort as SortOrder);

  if (!isSortOrder(sort)) {
    return NextResponse.json(
      {
        error: "invalid_sort",
        message: `Unknown sort "${sort}". Expected one of: newest, oldest, most-voted, question.`,
      },
      { status: 400 },
    );
  }

  // Not an error when absent, and not an error when unparseable either: a bad
  // page number falls back to the first page. Refusing would turn a mistyped link
  // into a broken page, and the clamped/first-page outcome is already reported
  // back in `page`, so nothing is hidden.
  const page = parsePositiveInteger(params.get("page")) ?? 1;
  const pageSize = clampPageSize(parsePositiveInteger(params.get("pageSize")));
  const query = params.get("q") ?? "";

  try {
    const polls = await getPolls();
    const result = pagePolls(polls, { query, sort, page, pageSize });

    return NextResponse.json({
      // `count` and `polls` are the original fields and are kept: `polls` is the
      // page, and `count` is its length. The paging fields below are additive, so
      // a caller that only knew the old shape still reads what it expects.
      count: result.items.length,
      polls: result.items,

      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      pageCount: result.pageCount,
      /** True when the requested page did not exist and the last one was used. */
      pageClamped: result.clamped,
      sort,
      /** Echoed so a caller can confirm which search produced this page. */
      query,
      source: "chain" as const,
    });
  } catch (error) {
    console.error("[api/polls] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error, await currentLocale()) },
      { status: 503 },
    );
  }
}
