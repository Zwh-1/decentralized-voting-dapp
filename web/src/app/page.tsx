// SPDX-License-Identifier: MIT
import { Ballot } from "@/components/Ballot";
import { getHealth, getResults, getTally } from "@/lib/data";
import type { HealthResponse, ResultsResponse, TallyResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The ballot page.
 *
 * A server component that reads the initial data directly, so the first paint
 * already shows the real tally and the consistency verdict rather than a
 * loading state. The client component then takes over polling.
 *
 * A failure to reach the chain is a supported state, not a crash: the page still
 * renders and tells the reader what to check.
 */
export default async function Home() {
  let initialTally: TallyResponse | null = null;
  let initialResults: ResultsResponse | null = null;
  let initialHealth: HealthResponse | null = null;
  let initialError: string | null = null;

  try {
    [initialTally, initialResults, initialHealth] = await Promise.all([
      getTally(),
      getResults(),
      getHealth(),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : String(error);
  }

  return (
    <Ballot
      initialTally={initialTally}
      initialResults={initialResults}
      initialHealth={initialHealth}
      initialError={initialError}
    />
  );
}
