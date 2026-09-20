// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getVoter } from "@/lib/data";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** One voter's status: whitelist, whether they voted, and any refunds. */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;

  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Expected a 20 byte hex address." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await getVoter(address as `0x${string}`));
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
