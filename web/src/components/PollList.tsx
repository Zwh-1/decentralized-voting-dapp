"use client";

import { useAccount, useChainId, useConfig, useReadContract } from "wagmi";

import { PollCard, PollCardSkeleton } from "@/components/PollCard";
import { EmptyState } from "@/components/ui";
import { useMounted } from "@/hooks/useMounted";
import { chainName, factoryAbi, resolveChainTarget, type ChainTarget } from "@/lib/voting";
import type { PollSummary } from "@/lib/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface PollListProps {
  /** Read on the server, so the first paint already lists the real polls. */
  initialPolls: PollSummary[] | null;
  /**
   * The factory's poll addresses, as the server read them.
   *
   * Typed as plain strings, not as the `` `0x${string}` `` brand `ChainTarget`
   * uses: these cross the server/client boundary as serialised JSON, and a branded
   * type that survives serialisation only by asserting it back is a claim the
   * compiler cannot check. They are validated where they are used — wagmi's own
   * read functions reject a malformed address — so the assertion below is the
   * narrow one, at the boundary, rather than a lie at the type level.
   */
  initialAddresses: string[] | null;
  /**
   * The chain and factory this deployment is configured for, or null when the
   * server's own configuration could not be read.
   *
   * Passed down rather than left to the client to guess, for ADR-0019's reason:
   * `process.env.CHAIN_ID` is server-only, and `useChainId()` answers with the
   * first chain in the browser's own wagmi config when no wallet is connected.
   */
  configuredTarget: ChainTarget | null;
}

/**
 * Every poll the factory has created.
 *
 * The list of *which* polls exist is read with one `allPolls()` call, in the
 * browser, through the wallet's chain. That is the difference between this page
 * working and not working: the chain is the authority on which polls exist
 * (ADR-0001), the call is cheap, and it means the page depends on no index, no
 * MySQL and no API route. The server's own read of the same function is the first
 * paint, not the source of truth.
 *
 * With no wallet connected the reads follow the deployment the server is
 * configured for — the same target `resolveChainTarget` picks there — so a reader
 * who has not connected anything still sees the real polls rather than an empty
 * list for the uninteresting reason.
 */
export function PollList({ initialPolls, initialAddresses, configuredTarget }: PollListProps) {
  const mounted = useMounted();
  const config = useConfig();
  const { isConnected } = useAccount();
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

  const factory = useReadContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "allPolls",
    ...readChain,
    query: { enabled: factoryKnown },
  });

  const summaries = new Map<string, PollSummary>(
    (initialPolls ?? []).map((poll) => [poll.address.toLowerCase(), poll]),
  );

  // The server's answer is used until the browser's own read lands. `mounted`
  // gates it so the server render and the first client render agree; after that
  // the chain's list wins, because a poll created a second ago is in it and the
  // server-rendered one was built before that.
  const chainAddresses: `0x${string}`[] | null =
    factory.data === undefined ? null : [...factory.data];
  const addresses: `0x${string}`[] = mounted
    ? (chainAddresses ?? (initialAddresses as `0x${string}`[] | null) ?? [])
    : ((initialAddresses as `0x${string}`[] | null) ?? []);

  const notListing = !mounted
    ? null
    : !factoryKnown
      ? `当前链（${subjectChainId}，${chainName(subjectChainId)}）没有已登记的工厂地址，无法列出投票。`
      : factory.isError
        ? "读取工厂的投票列表失败：链上调用没有成功。请检查钱包所在网络的 RPC 后重试。"
        : factory.isPending
          ? "正在读取链上投票列表…"
          : null;

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          全部投票{mounted && chainAddresses !== null ? `（${chainAddresses.length}）` : ""}
        </h2>
        {/*
          A refresh indicator that only exists once a refresh can have happened:
          before mount there is no client read to be fetching from.
        */}
        {mounted && factory.isFetching && chainAddresses !== null && (
          <span className="text-xs text-slate-400">刷新中…</span>
        )}
      </div>

      {/*
        Three distinct situations, three distinct surfaces. They were previously
        all one line of grey text, which made "still loading", "the read failed"
        and "there are genuinely no polls" look identical — and the first of
        those is not a state a reader should ever be shown as a conclusion.
      */}
      {notListing !== null && !factory.isPending && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50/60 p-5">
          <p className="text-sm font-medium text-rose-800">无法列出投票</p>
          <p className="mt-1.5 text-xs leading-relaxed text-rose-700">{notListing}</p>
        </div>
      )}

      {notListing !== null && factory.isPending && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <PollCardSkeleton />
          <PollCardSkeleton />
          <PollCardSkeleton />
        </div>
      )}

      {notListing === null && addresses.length === 0 && (
        <div className="mt-4">
          <EmptyState
            title="还没有任何投票"
            description="工厂合约还没有创建过投票。用页面顶部的「发起新投票」建第一个——创建者可以在开始前调整选项与白名单。"
          />
        </div>
      )}

      {addresses.length > 0 && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {addresses.map((address) => (
            <PollCard
              key={address}
              address={address}
              initial={summaries.get(address.toLowerCase()) ?? null}
              chainId={factoryKnown ? subjectChainId : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
