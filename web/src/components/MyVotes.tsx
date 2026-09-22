"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo } from "react";
import { useAccount, useChainId, useConfig, useReadContract, useReadContracts } from "wagmi";

import { Countdown } from "@/components/Countdown";
import { EmptyState } from "@/components/ui";
import { useMounted } from "@/hooks/useMounted";
import {
  chainName,
  factoryAbi,
  PollPhase,
  phaseLabel,
  pollAbi,
  resolveChainTarget,
  shortenAddress,
  type ChainTarget,
} from "@/lib/voting";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * How many polls the "voted in" scan will look at, newest first.
 *
 * Discovering "polls I voted in" means asking every poll whether this address
 * holds a vote in it — there is no reverse index on chain, and the factory only
 * records who *created* what. One `voterState` call per poll is cheap, but it is
 * per poll and it is one round trip each, so the scan is bounded rather than
 * unbounded and the bound is shown to the reader.
 *
 * The alternative — asking this app's indexer, which does keep a `current_votes`
 * view keyed by voter — would make this page depend on MySQL, and the requirement
 * is that the app never does. A reader with the index configured gets the fast
 * answer from the server-rendered page; this scan is the fallback that always
 * works, and it says when it has truncated.
 */
const SCAN_LIMIT = 50;

export interface MyVotesProps {
  configuredTarget: ChainTarget | null;
  /**
   * The factory's addresses as the server read them, serialised across the
   * server/client boundary as plain strings. See `PollListProps`.
   */
  initialAddresses: string[] | null;
}

/**
 * 我的投票: the polls this address created, and the polls it has a vote in.
 *
 * Both lists are read from the chain. "Created" is one call —
 * `pollsByCreator(me)` — and is by construction complete. "Voted in" cannot be
 * read that way, so it is derived by reading each poll's `voterState(me)` and
 * keeping the ones where `marked` is true, which is the contract's own answer to
 * "does this address currently back an option here" and not a guess from events.
 *
 * `marked` is deliberately the test rather than "has ever voted": an address that
 * withdrew its vote holds nothing, and listing that poll under 我投过的 would
 * claim a vote the chain says is not there. A withdrawal therefore drops the poll
 * from the list on the next read, which is the honest outcome.
 */
export function MyVotes({ configuredTarget, initialAddresses }: MyVotesProps) {
  const mounted = useMounted();
  const config = useConfig();
  const { address, isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  const factoryKnown = target !== null && targetChain !== undefined;
  const factoryAddress = target?.factoryAddress ?? ZERO_ADDRESS;
  const subjectChainId = target?.chainId ?? walletChainId;
  const readChain = targetChain === undefined ? {} : { chainId: targetChain.id };

  const actor = address ?? ZERO_ADDRESS;
  const ready = mounted && isConnected && factoryKnown;

  const factory = useReadContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "allPolls",
    ...readChain,
    query: { enabled: factoryKnown },
  });

  const created = useReadContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "pollsByCreator",
    args: [actor],
    ...readChain,
    query: { enabled: ready },
  });

  const chainAddresses: `0x${string}`[] | null =
    factory.data === undefined ? null : [...factory.data];
  const all: `0x${string}`[] = chainAddresses ?? (initialAddresses as `0x${string}`[] | null) ?? [];
  // Newest first, then capped: a reader looking at "polls I voted in" is far more
  // likely to want the recent ones, and truncating the tail is the half that can
  // be stated honestly.
  const newestFirst = useMemo(() => [...all].reverse(), [all.join(",")]);
  const scanned = useMemo(() => newestFirst.slice(0, SCAN_LIMIT), [newestFirst]);

  /**
   * The index's answer to "which polls do I hold a vote in", when there is one.
   *
   * Preferred over the scan below because it is complete and costs one query.
   * `404` is the documented "no index" reply and is treated as data, not as an
   * error: a deployment without MySQL is supported, and this hook must not make
   * the page render a failure for it.
   */
  const indexed = useQuery({
    queryKey: ["votedPolls", actor, subjectChainId],
    enabled: ready,
    retry: false,
    queryFn: async (): Promise<`0x${string}`[] | null> => {
      const response = await fetch(`/api/voters/${actor}/polls`);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`voted-polls request failed with ${response.status}`);
      }

      const body = (await response.json()) as { polls: { address: string }[] };

      return body.polls.map((poll) => poll.address as `0x${string}`);
    },
  });

  const indexedAddresses = indexed.data ?? null;
  const indexedUsable = indexedAddresses !== null;

  const voterStates = useReadContracts({
    contracts: scanned.map((poll) => ({
      address: poll,
      abi: pollAbi,
      functionName: "voterState" as const,
      args: [actor] as const,
    })),
    ...readChain,
    // Skipped when the index answered: re-deriving the same list from the chain
    // would be a second implementation of one question, and the two could
    // disagree in the UI with no way to say which is right.
    query: { enabled: ready && !indexedUsable && scanned.length > 0 },
  });

  // One `results()` per poll that is going to be listed, so each row can show its
  // tally and phase. Skipped entirely while the voter scan is unresolved, because
  // until then there is nothing to show.
  const markedAddresses = indexedUsable
    ? indexedAddresses
    : scanned.filter((_, index) => voterStates.data?.[index]?.result?.marked === true);

  const summaries = useReadContracts({
    contracts: markedAddresses.flatMap((poll) => [
      { address: poll, abi: pollAbi, functionName: "results" as const },
      { address: poll, abi: pollAbi, functionName: "phase" as const },
      { address: poll, abi: pollAbi, functionName: "endsAt" as const },
    ]),
    ...readChain,
    query: { enabled: ready && markedAddresses.length > 0 },
  });

  const createdAddresses: `0x${string}`[] = created.data === undefined ? [] : [...created.data];

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">我发起的投票</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          来自工厂的 <code className="font-mono">pollsByCreator(你)</code>
          ，因此这份列表是完整的：链上记录了谁创建了哪个投票。
        </p>

        {!mounted && <Notice>正在读取…</Notice>}
        {mounted && !isConnected && <Notice>请先连接钱包。</Notice>}
        {mounted && isConnected && !factoryKnown && (
          <Notice>
            当前链（{subjectChainId}，{chainName(subjectChainId)}
            ）没有已登记的工厂合约，无法列出你发起的投票。
          </Notice>
        )}
        {ready && created.isError && (
          <Notice tone="danger">
            读取 pollsByCreator 失败：链上调用没有成功。请检查 RPC 后重试。
          </Notice>
        )}
        {ready && !created.isError && created.isSuccess && createdAddresses.length === 0 && (
          <div className="mt-4">
            <EmptyState
              title="你还没有发起过投票"
              description="在「全部投票」页可以发起新投票；创建者会成为该投票的合约所有者，负责它的白名单与结束。"
            />
          </div>
        )}

        <div className="mt-4 space-y-2">
          {ready &&
            createdAddresses
              .slice()
              .reverse()
              .map((poll) => <PollLink key={poll} address={poll} note="由你发起" />)}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">我投过的投票</h2>
        {indexedUsable ? (
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            来自本应用的只读索引（<code className="font-mono">current_votes</code>{" "}
            视图，由链上事件推导）。链上没有「某人投过哪些投票」的反查接口，
            所以这个问题只有索引能在一次查询里答完；只有当前确实持有一票的投票会出现，
            已经撤票的不会。
          </p>
        ) : (
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            没有可用的索引，所以这份列表是逐个投票读{" "}
            <code className="font-mono">voterState(你)</code>{" "}
            得到的：只有当前确实持有一票的投票会出现， 已经撤票的不会。
            链上共有多少投票就要读多少次，因此下面只扫描最新的一部分。
          </p>
        )}

        {!mounted && <Notice>正在读取…</Notice>}
        {mounted && !isConnected && <Notice>请先连接钱包。</Notice>}

        {ready && !indexedUsable && all.length > SCAN_LIMIT && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
            链上共有 {all.length} 个投票，本页只扫描了最新的 {SCAN_LIMIT} 个
            （逐票读取的代价随投票数线性增长，全部扫描会让页面变慢）。
            更早的投票可能里也有你投过的，本页不会显示；可以直接在
            <Link href="/" className="mx-1 underline">
              全部投票
            </Link>
            里查看。
          </p>
        )}

        {ready && all.length === 0 && (
          <div className="mt-4">
            <EmptyState
              title="工厂还没有创建过任何投票"
              description="链上一个投票都没有，所以这里没有什么可以列举。"
            />
          </div>
        )}

        {ready && indexed.isPending && <Notice>正在向索引查询你持有的票…</Notice>}

        {ready && indexed.isError && <Notice>索引查询失败，改为逐个读取链上状态。</Notice>}

        {ready && !indexedUsable && voterStates.isPending && all.length > 0 && (
          <Notice>正在逐个读取 {scanned.length} 个投票…（读到的第一个结果就会出现在这里）</Notice>
        )}

        {ready && !indexedUsable && voterStates.isError && (
          <Notice tone="danger">逐个读取投票状态时链上调用失败。请检查 RPC 后重试。</Notice>
        )}

        {ready && !indexed.isPending && !indexed.isError && markedAddresses.length === 0 && (
          <p className="mt-4 text-sm text-slate-500">
            {indexedUsable
              ? "你目前没有在任何投票里持有一票。"
              : scanned.length === 0
                ? "没有可扫描的投票。"
                : "你在扫描到的投票里目前没有持有任何一票。"}
          </p>
        )}

        <div className="mt-4 space-y-2">
          {markedAddresses.map((poll, index) => {
            // The three calls were queued three at a time per poll, so the offsets
            // are positional. Each result is narrowed rather than cast: a failed
            // call in the batch leaves its own slot undefined, and reading it as a
            // number would turn "we could not find out" into a concrete claim.
            const results = resultsOf(summaries.data?.[index * 3]?.result);
            const phase = numberOrUndefined(summaries.data?.[index * 3 + 1]?.result);
            const endsAt = bigintOrUndefined(summaries.data?.[index * 3 + 2]?.result);

            return (
              <PollLink
                key={poll}
                address={poll}
                note={
                  phase === undefined
                    ? "我投过 · 阶段读取中…"
                    : `我投过 · ${phaseLabel(phase)}${
                        results === undefined ? "" : ` · ${results} 票`
                      }`
                }
                endsAt={endsAt}
              />
            );
          })}
        </div>
      </section>

      {ready && (
        <p className="text-[11px] text-slate-400">
          当前地址 <span className="font-mono">{shortenAddress(actor)}</span>，读取的是{" "}
          {chainName(subjectChainId)}（{subjectChainId}）。
        </p>
      )}
    </div>
  );
}

/** A short status line under a section heading. */
function Notice({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "danger";
}) {
  return (
    <p className={`mt-4 text-sm ${tone === "danger" ? "text-rose-600" : "text-slate-500"}`}>
      {children}
    </p>
  );
}

function PollLink({
  address,
  note,
  endsAt,
}: {
  address: `0x${string}`;
  note: string;
  endsAt?: bigint | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-slate-300 hover:shadow-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href={`/poll/${address}`}
          className="font-mono text-xs text-slate-700 underline decoration-slate-300 underline-offset-2 transition hover:text-slate-900"
        >
          {shortenAddress(address)}
        </Link>
        <span className="text-xs text-slate-500">{note}</span>
      </div>
      {endsAt !== undefined && <Countdown endsAt={endsAt} />}
    </div>
  );
}

/**
 * The three narrowings below exist because `useReadContracts` types each slot as
 * the union of every ABI's return type, and a slot is `undefined` when that
 * particular call failed while its neighbours in the batch succeeded.
 *
 * Casting would compile and would be wrong: `.result` on a failed call is
 * `undefined`, and reading it as a number would render "0 票" for a poll whose
 * tally was never read — the exact confusion between "zero" and "unknown" that
 * `ballot-labels.ts` exists to prevent. Each helper answers `undefined` for
 * anything that is not the value it expects, so the caller's own "读取中…" branch
 * handles it.
 */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "bigint" || typeof value === "number" ? Number(value) : undefined;
}

function bigintOrUndefined(value: unknown): bigint | undefined {
  return typeof value === "bigint" ? value : undefined;
}

/** `results()` returns `[Option[], total]`; this returns the total, or undefined. */
function resultsOf(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }

  return numberOrUndefined(value[1]);
}
