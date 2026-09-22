"use client";

import Link from "next/link";

import { Countdown } from "@/components/Countdown";
import { useMounted } from "@/hooks/useMounted";
import { usePollSummary } from "@/hooks/usePollSummary";
import { PollPhase, STAKE, formatEth, phaseLabel, shortenAddress } from "@/lib/voting";
import type { PollSummary } from "@/lib/types";

/**
 * One poll, as the list page shows it.
 *
 * The card is a client component because it re-reads itself: a list is exactly
 * where a stale tally is most visible, since a reader comparing two cards is
 * comparing the two numbers. The question, the creator and the deadline cannot
 * change after `createPoll` — they are written once by `initialize` — so only the
 * tally genuinely needs refreshing, and the whole summary is refetched because it
 * arrives in one round trip anyway.
 *
 * `initial` is the server's own read. It is used only until the first client read
 * lands, so the list does not blink empty between SSR and the browser's first
 * `eth_call`, and it is never preferred over a completed client read: the chain,
 * asked directly by the reader's own browser, is the more current of the two.
 */
export function PollCard({
  address,
  initial,
  chainId,
}: {
  address: `0x${string}`;
  /** The server's read, or null when it failed. */
  initial: PollSummary | null;
  /** The chain the page resolved, or undefined when it has no usable one. */
  chainId: number | undefined;
}) {
  const mounted = useMounted();
  const query = usePollSummary({ chainId, address, enabled: chainId !== undefined });

  // `mounted` gates the client read's *result* rather than its execution: the
  // hook runs on the server render too, and a server-rendered card that showed
  // the query's state would disagree with the browser's first render. Before
  // mount the card prints the server's answer, which is the one both sides agree
  // on.
  const summary = mounted ? (query.data ?? initial) : initial;

  if (summary === null) {
    return (
      <article className="rounded-xl border border-rose-200 bg-rose-50 p-5">
        <h3 className="text-sm font-medium text-rose-800">
          这个投票的链上信息读取失败，无法显示问题与票数。
        </h3>
        <p className="mt-2 break-all font-mono text-[11px] text-rose-700">{address}</p>
        <p className="mt-2 text-xs leading-relaxed text-rose-700">
          这个地址来自工厂的 <code className="font-mono">allPolls()</code>
          ，所以投票确实存在，失败的是它的详情读取。
          {mounted && query.isError ? "请检查钱包所在网络的 RPC 后重试。" : "请检查 RPC 后重试。"}
        </p>
        <Link
          href={`/poll/${address}`}
          className="mt-3 inline-block rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 transition hover:bg-rose-100"
        >
          仍然打开这个投票 →
        </Link>
      </article>
    );
  }

  // The phase the contract reports, not one inferred from the deadline. A poll
  // past `endsAt` is already unvotable — `vote` reverts — but it stays in phase
  // Voting until somebody calls the permissionless `closeAfterDeadline()`. The
  // single poll page states that difference; this card only needs the phase, and
  // the countdown beside it says the deadline separately.
  const open = summary.phase === PollPhase.Voting;

  return (
    <article className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300">
      <header className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-semibold leading-snug text-slate-900">
          {summary.question}
        </h3>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
            open ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          {phaseLabel(summary.phase)}
        </span>
      </header>

      <p className="mt-1 text-xs text-slate-400">
        发起人{" "}
        <span className="font-mono text-slate-500" title={summary.creator}>
          {shortenAddress(summary.creator)}
        </span>
        {mounted && query.isFetching && <span className="ml-2 text-slate-300">刷新中…</span>}
      </p>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <Field label="选项数" value={String(summary.optionCount)} />
        <Field label="当前票数" value={String(summary.totalVotes)} />
        <Field label="投票押金" value={`${formatEth(STAKE)} ETH`} />
      </dl>

      <div className="mt-3">
        <Countdown endsAt={BigInt(summary.endsAt)} />
      </div>

      <footer className="mt-4 flex justify-end border-t border-slate-100 pt-3">
        <Link
          href={`/poll/${address}`}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700"
        >
          {open ? "去投票 →" : "查看详情 →"}
        </Link>
      </footer>
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-2">
      <dt className="text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{value}</dd>
    </div>
  );
}
