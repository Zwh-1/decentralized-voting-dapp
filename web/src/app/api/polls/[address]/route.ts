// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getPoll, getTally } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * One poll: its headline facts and its option tally.
 *
 * The two reads are settled independently so a tally that fails does not hide
 * the poll itself — the poll exists, and saying so is still useful. The `tally`
 * field is null in that case, which a client can tell apart from an empty tally.
 */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;

  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Expected a 20 byte hex address." },
      { status: 400 },
    );
  }

  const pollAddress = address as `0x${string}`;

  let poll;
  try {
    poll = await getPoll(pollAddress);
  } catch (error) {
    console.error("[api/polls/:address] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }

  let tally = null;
  try {
    const value = await getTally(pollAddress);
    tally = { source: value.source, total: value.total, options: value.options };
  } catch (error) {
    // Reported, not raised: the poll's own facts came back, and returning them
    // is more useful than a 503 that discards what did work.
    console.error("[api/polls/:address] tally read failed", error);
  }

  return NextResponse.json({ poll, tally });
}
