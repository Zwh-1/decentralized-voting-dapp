// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getHealth } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Liveness and indexing progress. */
export async function GET() {
  try {
    return NextResponse.json(await getHealth());
  } catch (error) {
    return NextResponse.json(
      {
        status: "degraded",
        error: "config_error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
