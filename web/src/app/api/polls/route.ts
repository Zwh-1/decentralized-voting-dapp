// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getPolls } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

/**
 * Every poll created through the factory.
 *
 * Read from the chain, not the index: the factory is the authority on which
 * polls exist, and this route must not hide a poll merely because the index has
 * not caught up with it yet.
 */
export async function GET() {
  try {
    const polls = await getPolls();

    return NextResponse.json({ count: polls.length, polls });
  } catch (error) {
    console.error("[api/polls] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}
