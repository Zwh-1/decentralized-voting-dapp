// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getVoter } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * One voter's status in one poll: whitelist, current vote, stake and history.
 *
 * Scoped by poll because the same address has an independent answer in every
 * poll — "has this address voted" was a question with one answer before the
 * platform existed, and is now a question that only makes sense per poll.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ address: string; voter: string }> },
) {
  const { address, voter } = await context.params;

  for (const [name, value] of [
    ["poll address", address],
    ["voter address", voter],
  ] as const) {
    if (!ADDRESS_PATTERN.test(value)) {
      return NextResponse.json(
        { error: "invalid_address", message: `Expected the ${name} to be 20 byte hex.` },
        { status: 400 },
      );
    }
  }

  try {
    return NextResponse.json(await getVoter(address as `0x${string}`, voter as `0x${string}`));
  } catch (error) {
    console.error("[api/polls/:address/voters/:voter] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}
