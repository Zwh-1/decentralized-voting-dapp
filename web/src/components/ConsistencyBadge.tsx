import type { ReactNode } from "react";

import type { ResultsResponse } from "../lib/types";

interface Props {
  results: ResultsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Renders the on-chain versus indexed comparison.
 *
 * The point of showing this in the UI is that it is checkable: the badge is
 * green only when the contract's own `results()` agrees with the indexer for
 * every candidate, and it names the candidates that disagree when it does not.
 *
 * `lagging` gets its own wording rather than borrowing the failure one. The
 * indexer holds back recent blocks on purpose, so a red "不一致" during normal
 * confirmation lag would be wrong twice over: it would describe correct
 * behaviour as a fault, and it would make a real divergence look like the same
 * thing.
 */
export function ConsistencyBadge({ results, isLoading, isError }: Props) {
  if (isLoading) {
    return <Badge tone="neutral">正在比对链上与索引结果…</Badge>;
  }

  if (isError || results === undefined) {
    return <Badge tone="warn">无法比对（索引 API 不可达）</Badge>;
  }

  switch (results.status) {
    case "unavailable":
      return <Badge tone="neutral">未启用索引 · 数字直接来自链上</Badge>;

    case "lagging":
      return (
        <Badge tone="warn">
          索引落后 {results.unindexedBlocks} 个区块 · 链上 {results.onChainTotal} 票，暂不比对
        </Badge>
      );

    case "divergent":
      return (
        <Badge tone="bad">
          链上 {results.onChainTotal} 票 ≠ 索引 {results.indexedTotal} 票 ·{" "}
          {results.discrepancies.length} 处偏差
        </Badge>
      );

    case "consistent":
      return (
        <Badge tone="ok">
          链上与索引一致 · {results.onChainTotal} / {results.indexedTotal} 票 · 0 处偏差
          {results.pendingVotes > 0 ? `（已计入 ${results.pendingVotes} 票待确认）` : ""}
        </Badge>
      );
  }
}

function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "neutral";
  children: ReactNode;
}) {
  const tones = {
    ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warn: "bg-amber-50 text-amber-700 border-amber-200",
    bad: "bg-rose-50 text-rose-700 border-rose-200",
    neutral: "bg-slate-50 text-slate-600 border-slate-200",
  } as const;

  return (
    <span
      className={`inline-block rounded-full border px-3 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
