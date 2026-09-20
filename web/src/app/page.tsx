// SPDX-License-Identifier: MIT
import { Ballot } from "@/components/Ballot";
import { getHealth, getResults, getTally } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The ballot page.
 *
 * A server component that reads the initial data directly, so the first paint
 * already shows the real tally and the consistency verdict rather than a
 * loading state. The client component then takes over polling.
 *
 * The three reads are settled independently. They fail independently: when the
 * RPC endpoint is unreachable the tally and the health check still succeed from
 * the index while only the chain-versus-index comparison cannot be made, and an
 * earlier `Promise.all` in a single try/catch threw both good results away — the
 * first paint then showed placeholders for data the server was holding, which is
 * the opposite of what prefetching here is for. Each failure is also attributed
 * to the read that produced it, so the banner does not blame the chain for a
 * comparison it could not run.
 */
export default async function Home() {
  const [tally, results, health] = await Promise.allSettled([
    getTally(),
    getResults(),
    getHealth(),
  ]);

  const describe = (result: PromiseRejectedResult): string =>
    result.reason instanceof Error ? result.reason.message : String(result.reason);

  const failed: [string, PromiseRejectedResult][] = (
    [
      ["票数", tally],
      ["链与索引的一致性比对", results],
      ["健康状态", health],
    ] as [string, PromiseSettledResult<unknown>][]
  ).filter((entry): entry is [string, PromiseRejectedResult] => entry[1].status === "rejected");

  const initialError =
    failed.length === 0
      ? null
      : failed.map(([name, result]) => `${name}：${describe(result)}`).join("；");

  return (
    <Ballot
      initialTally={tally.status === "fulfilled" ? tally.value : null}
      initialResults={results.status === "fulfilled" ? results.value : null}
      initialHealth={health.status === "fulfilled" ? health.value : null}
      initialError={initialError}
    />
  );
}
