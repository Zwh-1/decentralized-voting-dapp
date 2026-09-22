// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { getEligibility, getPoll, getResults } from "@/lib/data";
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
    // carries the tally and the chain-versus-index comparison; `eligibility`
    // carries the denominator turnout needs. All three are needed and none
    // implies another.
    const [summary, results, eligibility] = await Promise.all([
      getPoll(poll),
      getResults(poll),
      getEligibility(poll),
    ]);

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
      Turnout is computed against `eligiblePower`, NOT against the address count.

      `eligiblePower` is the denominator the contract itself uses: it is frozen at
      `startPoll`, so it cannot move while votes accumulate, and it is the same
      quantity the quorum is a fraction of. Using the live address count instead
      would let an address admitted during voting lower the reported turnout with
      no vote withdrawn.

      It is still `null` in two cases, and both are genuine rather than a
      placeholder: an open poll has no enumerable electorate, and a poll still in
      `Setup` has not frozen its denominator yet. `turnout()` writes null for
      those rather than 0, because "no one voted" and "this cannot be computed"
      are different statements and only one of them is true.
    */
    const eligible = eligibility.eligiblePower === null ? null : Number(eligibility.eligiblePower);
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
          /**
           * How many addresses were admitted. A live count, so it can differ
           * from `eligiblePower` — and on a weighted poll it differs in kind.
           */
          eligibleVoters: eligibility.eligibleVoters,
          /**
           * The frozen denominator `turnoutPercent` was divided by. Exported
           * alongside the percentage so a reader can redo the division and see
           * which of the two numbers produced it.
           */
          eligiblePower: eligibility.eligiblePower?.toString() ?? null,
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
