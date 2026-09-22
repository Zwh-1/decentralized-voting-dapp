// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { runSyncOnce } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

/**
 * Advances the index by one step: repair a reorg if one happened, otherwise
 * index the next range of finalised blocks.
 *
 * POST rather than GET because it has a side effect. It exists so indexing can
 * be driven externally (cron, a deploy hook, or the UI's sync button) without
 * relying on the in-process loop, which is the part most likely to be absent in
 * a serverless deployment.
 *
 * A failure gets a sentence naming the dependency that failed, not the raw
 * throwable. The raw one is a viem error carrying the endpoint **with its
 * `apiKey`** and the request body, and this route's `message` is rendered on the
 * page — so echoing it published the operator's RPC key to every visitor who
 * clicked the sync button. See `lib/failure.ts`.
 */
export async function POST() {
  try {
    const outcome = await runSyncOnce();

    // `enabled: false` is a normal answer, not an error: it means no database is
    // configured, and the caller should treat the index as absent.
    return NextResponse.json(outcome, { status: 200 });
  } catch (error) {
    console.error("[api/index/sync] sync failed", error);

    return NextResponse.json(
      { enabled: true, error: "sync_failed", message: describeFailure(error) },
      { status: 503 },
    );
  }
}
