// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { currentLocale } from "@/lib/i18n/server";
import { getPollActivity } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * One poll's full activity feed.
 *
 * 404 when there is no index, and that status is chosen deliberately over an
 * empty list. An empty `200` would mean "this poll has no history", which is a
 * confident claim about a poll that may have hundreds of events — the index is
 * simply not available to answer. The two are different facts and only one of
 * them is knowable here (ADR-0012: name the party that failed).
 */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;

  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Expected the poll address to be 20 byte hex." },
      { status: 400 },
    );
  }

  try {
    const entries = await getPollActivity(address as `0x${string}`, await currentLocale());

    if (entries === null) {
      return NextResponse.json(
        {
          error: "index_unavailable",
          message:
            "This deployment has no usable index, so the event history cannot be listed. " +
            "It is not empty — it is unavailable.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({ address, source: "index", entries });
  } catch (error) {
    console.error("[api/polls/:address/activity] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error, await currentLocale()) },
      { status: 503 },
    );
  }
}
