// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getHealth } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

/**
 * Liveness and indexing progress.
 *
 * The `message` on a 503 is the classified sentence, not the raw throwable: a
 * config error's own text is kept (it names the variable and never echoes a
 * value), while a driver error is replaced by the dependency it came from. See
 * `lib/failure.ts`.
 */
export async function GET() {
  try {
    return NextResponse.json(await getHealth());
  } catch (error) {
    console.error("[api/health] read failed", error);

    return NextResponse.json(
      { status: "degraded", error: "config_error", message: describeFailure(error) },
      { status: 503 },
    );
  }
}
