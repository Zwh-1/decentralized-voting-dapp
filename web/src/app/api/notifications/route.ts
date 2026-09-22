// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { listNotifications, markNotificationsRead } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import { parseAddressParam, summarizeNotifications } from "@/lib/notify";
import { parsePositiveInteger } from "@/lib/pagination";

export const dynamic = "force-dynamic";

/** How many notifications one request returns. Bounded so a busy poll cannot flood. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * A reader's unread notifications, newest first.
 *
 * ---------------------------------------------------------------------------
 * Why the summary counts the WHOLE unread set, not the page on screen
 * ---------------------------------------------------------------------------
 *
 * `limit` bounds the response, not the meaning of the numbers. A reader who has
 * 400 unread events and is shown 50 must see "400", not "50" — otherwise the badge
 * would read as "you are nearly caught up" when the opposite is true. So the rows
 * are read in full and only the returned page is capped.
 *
 * ---------------------------------------------------------------------------
 * Why 404 when there is no index
 * ---------------------------------------------------------------------------
 *
 * "No index" is not "you have nothing waiting". Reporting the first as an empty
 * list would tell a reader their subscriptions are quiet, when in fact the
 * deployment cannot tell them anything at all.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const parsed = parseAddressParam(params.get("address"));

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  }

  const requested = parsePositiveInteger(params.get("limit"));
  const limit = Math.min(requested ?? DEFAULT_LIMIT, MAX_LIMIT);

  try {
    const entries = await listNotifications(parsed.address);

    if (entries === null) {
      return NextResponse.json(
        {
          error: "index_unavailable",
          message:
            "This deployment has no usable index, so notifications cannot be derived. " +
            "They are not empty — they are unavailable.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      address: parsed.address,
      source: "index",
      summary: summarizeNotifications(entries),
      // `truncated` says the rows were capped, so a caller never has to infer it
      // by comparing `entries.length` against `summary.total` and guessing.
      truncated: entries.length > limit,
      limit,
      entries: entries.slice(0, limit),
    });
  } catch (error) {
    console.error("[api/notifications] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}

/**
 * Marks notifications read.
 *
 * The watermark advances only as far as the block heights actually unread, never
 * to the chain head — see `watermarkFor`. A reader whose page is showing events up
 * to block 500 must not silently lose 501–520 because the request happened to
 * arrive after they were mined. The cost of the safe direction is that an event
 * mined during the request stays unread, which is visible; the other direction
 * would be a silent loss.
 *
 * The body names WHICH POLL to acknowledge (or omits it for all of them). It does
 * NOT supply the list of entries, and that is a security decision, not a
 * simplification: a caller-supplied list of "what I was shown" would let anyone
 * advance anyone else's watermark to any height, marking events read that were
 * never displayed. Re-deriving from the index means the body can only choose the
 * scope, while the heights always come from the index itself.
 */
export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Expected a JSON object." },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "invalid_body", message: "Expected a JSON object." },
      { status: 400 },
    );
  }

  const record = body as Record<string, unknown>;
  const parsed = parseAddressParam(typeof record.address === "string" ? record.address : null);

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  }

  const poll =
    typeof record.poll === "string" && record.poll.trim() !== "" ? record.poll.trim() : null;

  if (poll !== null && !/^0x[0-9a-fA-F]{40}$/.test(poll)) {
    return NextResponse.json(
      { error: "invalid_poll", message: "The poll must be a 20 byte hex address." },
      { status: 400 },
    );
  }

  /*
    The entries are re-derived from the index rather than trusted from the body.

    A caller-supplied list of "what I was shown" would let any address advance any
    other address's watermark to any height — marking events read that were never
    displayed. Deriving them means the only thing the body can influence is WHICH
    poll is acknowledged, and the heights always come from the index.
  */
  try {
    const entries = await listNotifications(parsed.address);

    if (entries === null) {
      return NextResponse.json(
        { error: "index_unavailable", message: "This deployment has no usable index." },
        { status: 404 },
      );
    }

    const acknowledged =
      poll === null
        ? entries
        : entries.filter((entry) => entry.pollAddress.toLowerCase() === poll.toLowerCase());
    const marked = await markNotificationsRead(parsed.address, acknowledged, poll);

    if (!marked) {
      return NextResponse.json(
        { error: "index_unavailable", message: "This deployment has no usable index." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      address: parsed.address,
      poll,
      acknowledged: acknowledged.length,
    });
  } catch (error) {
    console.error("[api/notifications] write failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}
