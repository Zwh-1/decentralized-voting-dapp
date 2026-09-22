// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { currentLocale } from "@/lib/i18n/server";
import { getVotedPolls } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * The polls one address currently holds a vote in.
 *
 * Answered only by the index, because the chain cannot answer it: there is no
 * reverse index from a voter to the polls they joined, and the factory records
 * only who created what. `getVotedPolls` documents why that makes this the one
 * read in the app with no chain fallback.
 *
 * `404` is therefore a real outcome rather than an error: it means no index is
 * available, which is a deployment this app supports. The caller is expected to
 * fall back to scanning the chain and to say that its answer is truncated — the
 * browser component does exactly that. Returning an empty list instead would be
 * the one wrong answer here, because "you have voted in nothing" and "I cannot
 * tell you" are different claims and only one of them is true.
 */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;

  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json(
      {
        error: "invalid_address",
        message: "Expected the voter address to be 20 byte hex.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await getVotedPolls(address as `0x${string}`);

    if (result === null) {
      return NextResponse.json(
        {
          error: "index_unavailable",
          message:
            "No index is available, so this question cannot be answered here. " +
            "The chain has no reverse index from a voter to their polls.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/voters/:address/polls] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error, await currentLocale()) },
      { status: 503 },
    );
  }
}
