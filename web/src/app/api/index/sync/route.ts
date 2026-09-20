// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { runSyncOnce } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Advances the index by one step: repair a reorg if one happened, otherwise
 * index the next range of finalised blocks.
 *
 * POST rather than GET because it has a side effect. It exists so indexing can
 * be driven externally (cron, a deploy hook, or the UI's sync button) without
 * relying on the in-process loop, which is the part most likely to be absent in
 * a serverless deployment.
 */
export async function POST() {
  try {
    const outcome = await runSyncOnce();

    // `enabled: false` is a normal answer, not an error: it means no database is
    // configured, and the caller should treat the index as absent.
    return NextResponse.json(outcome, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        enabled: true,
        error: "sync_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
