// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getResults } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The dual-source consistency check — metric M-6.
 *
 * Reads the tally from the contract AND from MySQL and compares them.
 *
 * Only a genuine divergence answers 500: the index has reached the newest block
 * it is allowed to read and still disagrees, so the numbers are wrong and a
 * caller should not treat them as usable. A `lagging` index answers 200 — it is
 * what the confirmation window is supposed to do, and a check that fired on
 * expected behaviour would be ignored by the time a real divergence arrived.
 *
 * With no database the response is `status: "unavailable"` with `indexed: null`:
 * there is nothing to compare, and saying so beats a vacuous success.
 */
export async function GET() {
  try {
    const results = await getResults();

    return NextResponse.json(results, { status: results.status === "divergent" ? 500 : 200 });
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
