// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getResults } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The dual-source consistency check — metric M-6.
 *
 * Reads the tally from the contract AND from MySQL and compares them. A
 * disagreement is answered with 500 and a per-candidate diff, because it means
 * the index is wrong and a caller should not treat the numbers as usable.
 *
 * When no database is configured the response is `mode: "chain-only"` with
 * `indexed: null`: there is nothing to compare, and saying so is better than
 * reporting a vacuous success.
 */
export async function GET() {
  try {
    const results = await getResults();

    return NextResponse.json(results, { status: results.consistent ? 200 : 500 });
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
