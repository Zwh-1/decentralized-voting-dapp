// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { currentLocale } from "@/lib/i18n/server";
import { parseAuditFilters, summarizeAudit } from "@/lib/audit";
import { getAuditActivity } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import { paginate, parsePositiveInteger, clampPageSize } from "@/lib/pagination";

export const dynamic = "force-dynamic";

/**
 * The global audit feed: every event this index recorded, across every poll.
 *
 * ---------------------------------------------------------------------------
 * Why 404 and not an empty 200 when there is no index
 * ---------------------------------------------------------------------------
 *
 * The two are different facts and only one is knowable here. An empty list would
 * assert "nothing has ever happened on this deployment", which is a confident
 * claim about data that was never read — and on a deployment with no
 * `DATABASE_URL` it is exactly wrong, because events are happening on chain the
 * whole time. `404` with a sentence saying the history is unavailable, not empty,
 * is the honest answer (ADR-0012).
 *
 * ---------------------------------------------------------------------------
 * Why a bad filter is 400 and not a default
 * ---------------------------------------------------------------------------
 *
 * `?kind=whatever` is a caller mistake, and answering it with "all kinds" makes a
 * broken link look like a working one. The message names the accepted values.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = parseAuditFilters(params);

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  }

  const page = parsePositiveInteger(params.get("page")) ?? 1;
  const pageSize = clampPageSize(parsePositiveInteger(params.get("pageSize")));

  try {
    const entries = await getAuditActivity(parsed.filters, await currentLocale());

    if (entries === null) {
      return NextResponse.json(
        {
          error: "index_unavailable",
          message:
            "This deployment has no usable index, so the audit feed cannot be listed. " +
            "It is not empty — it is unavailable.",
        },
        { status: 404 },
      );
    }

    /*
      Paged in memory rather than with SQL LIMIT.

      Two reasons, and the first is the important one. The union is assembled from
      the branches the KIND filter selected, so a `LIMIT` would have to be applied
      to each branch and then again to the union — and getting that wrong silently
      drops rows from the middle of the feed rather than from its end. The second
      is that `summary` below must describe the WHOLE filtered set, and a query
      that only fetched one page could not compute it.
    */
    const current = paginate(entries, page, pageSize);

    return NextResponse.json({
      source: "index",
      filters: {
        poll: parsed.filters.poll,
        actor: parsed.filters.actor,
        kind: parsed.filters.kind,
      },
      // Counted over every matching entry, not over the page — a summary that
      // described only the 20 rows on screen would look like the whole history.
      summary: summarizeAudit(entries),
      entries: current.items,
      page: current.page,
      pageSize: current.pageSize,
      pageCount: current.pageCount,
      total: current.total,
      pageClamped: current.clamped,
    });
  } catch (error) {
    console.error("[api/audit] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error, await currentLocale()) },
      { status: 503 },
    );
  }
}
