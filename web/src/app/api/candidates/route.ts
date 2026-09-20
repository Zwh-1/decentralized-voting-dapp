// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getTally } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The candidate list and tally.
 *
 * Served from the index when one is configured, otherwise read from the
 * contract. The `source` field says which, so a client never has to guess.
 */
export async function GET() {
  try {
    const tally = await getTally();

    return NextResponse.json({
      source: tally.source,
      total: tally.total,
      candidates: tally.candidates,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "upstream_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
