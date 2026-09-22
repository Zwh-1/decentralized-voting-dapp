// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { currentLocale } from "@/lib/i18n/server";
import { getTally } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * One poll's option tally, and which source answered.
 *
 * Separate from `/api/polls/[address]` because it is the endpoint that can
 * legitimately fail on its own: the poll's facts come from one contract call and
 * the tally from another, and a caller that only wants the numbers should not
 * have to receive (and re-check) the poll's metadata to get them.
 */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;

  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Expected a 20 byte hex address." },
      { status: 400 },
    );
  }

  try {
    const tally = await getTally(address as `0x${string}`);

    return NextResponse.json({
      source: tally.source,
      total: tally.total,
      options: tally.options,
    });
  } catch (error) {
    console.error("[api/polls/:address/tally] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error, await currentLocale()) },
      { status: 503 },
    );
  }
}
