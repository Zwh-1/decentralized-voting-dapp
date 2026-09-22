// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { currentLocale } from "@/lib/i18n/server";
import { getResults } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * One poll's chain-versus-index comparison.
 *
 * `status` is the verdict and it is not softened: `lagging` means the unindexed
 * range was too large to reconcile, so the comparison is inconclusive rather
 * than failed. A client that treated every non-`consistent` value as an error
 * would report a healthy index as broken.
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
    return NextResponse.json(await getResults(address as `0x${string}`));
  } catch (error) {
    console.error("[api/polls/:address/results] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error, await currentLocale()) },
      { status: 503 },
    );
  }
}
