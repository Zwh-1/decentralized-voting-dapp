// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getPoll, getResults } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import { resultCsv, resultRows, turnout } from "@/lib/poll-report";
import { phaseLabel } from "@/lib/voting";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * A poll's result, as a downloadable file.
 *
 * ---------------------------------------------------------------------------
 * Why `?format=` rather than two routes
 * ---------------------------------------------------------------------------
 *
 * The two formats are the same artefact for two audiences: CSV for a person
 * opening a spreadsheet, JSON for a script checking the numbers. Splitting them
 * into separate routes would duplicate the read, the error handling and the
 * arithmetic — and the arithmetic is the part that must not diverge between the
 * two, since a reviewer comparing the CSV against the JSON is exactly how a bad
 * export gets caught.
 *
 * ---------------------------------------------------------------------------
 * Why the numbers come from the chain read, not the index
 * ---------------------------------------------------------------------------
 *
 * `getResults` reads the contract directly and reports the index separately for
 * comparison. An export is the artefact a third party cites, so it is built from
 * the same source the contract itself would give; the index appears alongside as
 * corroboration, never as the primary value (ADR-0001).
 */
export async function GET(request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;

  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Expected the poll address to be 20 byte hex." },
      { status: 400 },
    );
  }

  const format = new URL(request.url).searchParams.get("format") ?? "csv";

  if (format !== "csv" && format !== "json") {
    return NextResponse.json(
      { error: "invalid_format", message: "Expected format=csv or format=json." },
      { status: 400 },
    );
  }

  try {
    const poll = address as `0x${string}`;
    // The summary carries the question, the creator and the deadline; `results`
    // carries the tally and the chain-versus-index comparison. Both are needed
    // and neither implies the other.
    const [summary, results] = await Promise.all([getPoll(poll), getResults(poll)]);

    const rows = resultRows(
      results.onChain.options.map((option) => ({
        id: option.id,
        // The CID or literal text the creator wrote, exported verbatim rather
        // than resolved through IPFS: an export must be reproducible offline,
        // and a gateway being down would otherwise change the file's contents.
        label: option.labelCid,
        votes: option.voteCount,
      })),
    );

    /*
      Turnout is reported only when a denominator exists.

      There is no contract getter for "how many addresses are whitelisted" —
      the list lives in a mapping, and counting it would mean replaying every
      `WhitelistUpdated` event. So this is `null`, which the export writes as
      null rather than 0: "no one voted" and "this cannot be computed" are
      different statements, and only one of them is true.
    */
    const eligible: number | null = null;
    const base = `${address}-result`;

    if (format === "json") {
      const body = {
        poll: {
          address,
          question: summary.question,
          creator: summary.creator,
          phase: summary.phase,
          phaseLabel: phaseLabel(summary.phase),
          endsAt: summary.endsAt,
        },
        totals: {
          votes: results.onChainTotal,
          eligibleVoters: eligible,
          turnoutPercent: turnout(results.onChainTotal, eligible),
        },
        options: rows,
        // Included so a third party sees whether the index agreed at export
        // time. A divergence here does not invalidate the chain numbers above —
        // it names a second party that disagrees with them.
        indexComparison: {
          status: results.status,
          indexedTotal: results.indexedTotal,
          pendingVotes: results.pendingVotes,
          discrepancies: results.discrepancies,
        },
        exportedAt: new Date().toISOString(),
        source: "chain",
      };

      return new NextResponse(JSON.stringify(body, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${base}.json"`,
          // An export is a snapshot; caching it would let a reader download a
          // stale tally with no way to tell.
          "cache-control": "no-store",
        },
      });
    }

    const csv = resultCsv({
      pollAddress: address,
      question: summary.question,
      phase: phaseLabel(summary.phase),
      endsAt: new Date(Number(summary.endsAt) * 1000).toISOString(),
      totalVotes: results.onChainTotal,
      rows,
    });

    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${base}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("[api/polls/:address/export] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}
