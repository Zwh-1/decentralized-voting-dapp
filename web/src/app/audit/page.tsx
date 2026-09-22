// SPDX-License-Identifier: MIT
import Link from "next/link";

import { PageShell } from "@/components/PageShell";
import {
  AUDIT_KINDS,
  auditKindLabel,
  parseAuditFilters,
  summarizeAudit,
  type AuditKind,
} from "@/lib/audit";
import { getAuditActivity, getConfiguredTarget } from "@/lib/data";
import { paginate, parsePositiveInteger } from "@/lib/pagination";
import { shortenAddress } from "@/lib/voting";

export const dynamic = "force-dynamic";

/**
 * 审计视图: every event the index has recorded, across every poll.
 *
 * ---------------------------------------------------------------------------
 * Why this is server-rendered with link filters
 * ---------------------------------------------------------------------------
 *
 * An audit feed is something a reviewer opens, filters, and then cites — so its
 * state belongs in the URL. `?kind=refunded&poll=0x…` is a link that can be
 * pasted into a report and reopened exactly; component state could not be. Links
 * also mean the whole view works before JavaScript runs, which is the same
 * standard the rest of the read-only pages hold themselves to.
 *
 * ---------------------------------------------------------------------------
 * What it must never do
 * ---------------------------------------------------------------------------
 *
 * Show an empty table when the index is unavailable. "No events" and "this
 * deployment cannot list events" are different statements, and on a deployment
 * without `DATABASE_URL` the first is simply false — events are being mined the
 * whole time. The two cases render as two different pages.
 *
 * The same rule applies to a mismatch between the chain and the index: this view
 * reads the INDEX, and says so. It is not the consistency check, and a reader
 * should not mistake a clean feed for proof that the index is complete — that is
 * what the per-poll consistency badge is for (ADR-0001).
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const configuredTarget = getConfiguredTarget();

  // The page receives `searchParams` as a plain record, so it is adapted to the
  // `URLSearchParams` the shared parser takes rather than a second parser being
  // written here. A duplicated parser is how the page and the API would end up
  // disagreeing about what `?kind=` means.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const parsed = parseAuditFilters(params);

  const page = parsePositiveInteger(params.get("page")) ?? 1;

  let entries = null as Awaited<ReturnType<typeof getAuditActivity>>;
  let loadError: string | null = null;

  if (parsed.ok) {
    try {
      entries = await getAuditActivity(parsed.filters);
    } catch (error) {
      console.error("[audit page] read failed", error);
      loadError = "读取审计事件时发生未预期的错误。完整错误见服务端日志。";
    }
  }

  const current = entries === null ? null : paginate(entries, page, 50);

  /** Builds a filter link, dropping the page so a filter change starts at page 1. */
  function hrefWith(next: { poll?: string | null; actor?: string | null; kind?: string | null }) {
    const query = new URLSearchParams();

    const poll = next.poll === undefined ? parsed.ok && parsed.filters.poll : next.poll;
    const actor = next.actor === undefined ? parsed.ok && parsed.filters.actor : next.actor;
    const kind = next.kind === undefined ? parsed.ok && parsed.filters.kind : next.kind;

    if (poll) query.set("poll", poll);
    if (actor) query.set("actor", actor);
    if (kind) query.set("kind", kind);

    const text = query.toString();

    return text.length === 0 ? "/audit" : `/audit?${text}`;
  }

  /**
   * A page link that keeps the current filters.
   *
   * Built from `hrefWith` rather than string-concatenated at the call site, so the
   * separator is decided once. Getting it wrong produces `/audit?&page=2`, which
   * mostly works and is not a shape worth leaving in the markup.
   */
  function pageHref(target: number): string {
    const base = hrefWith({});

    return `${base}${base.includes("?") ? "&" : "?"}page=${target}`;
  }

  return (
    <PageShell
      title="审计视图"
      subtitle="索引器记录过的全部事件，跨所有投票。按事件类型、投票合约或地址过滤。此页读取的是索引，不是链上实时状态——索引与链上是否一致请看每个投票页的一致性标记。"
      configuredTarget={configuredTarget}
    >
      <p className="mt-4 text-xs text-slate-400">
        <Link href="/" className="underline">
          ← 全部投票
        </Link>
      </p>

      {/* A rejected filter is stated, not silently ignored. */}
      {!parsed.ok && (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {parsed.message}
        </section>
      )}

      {/* The kind filter, as links, so the state survives a copy-paste and works without JS. */}
      <nav className="mt-6 flex flex-wrap items-center gap-2" aria-label="按事件类型过滤">
        <Link
          href={hrefWith({ kind: null })}
          className={`rounded-full border px-3 py-1.5 text-xs ${
            parsed.ok && parsed.filters.kind === null
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-600"
          }`}
        >
          全部
        </Link>
        {AUDIT_KINDS.map((kind: AuditKind) => (
          <Link
            key={kind}
            href={hrefWith({ kind })}
            className={`rounded-full border px-3 py-1.5 text-xs ${
              parsed.ok && parsed.filters.kind === kind
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            {auditKindLabel(kind)}
          </Link>
        ))}
      </nav>

      {/*
        The two "cannot show this" cases, kept visually distinct from the
        "nothing matched" case below.
      */}
      {loadError !== null && (
        <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
          {loadError}
        </section>
      )}

      {loadError === null && entries === null && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-sm font-medium text-slate-800">这个部署没有可用的索引</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            审计事件来自 MySQL 索引，而当前部署没有配置{" "}
            <code className="font-mono">DATABASE_URL</code>，所以无法列出历史事件。
            这不代表「没有活动」——链上的事件仍然在发生，只是这里读不到。
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            配置 <code className="font-mono">DATABASE_URL</code> 后运行{" "}
            <code className="font-mono">pnpm indexer:migrate &amp;&amp; pnpm indexer:drain</code>{" "}
            即可建立索引；每个投票页的活动记录也会随之出现。
          </p>
        </section>
      )}

      {current !== null && (
        <>
          {/*
            The summary describes the whole filtered set, not the page on screen.
            Counting only the visible rows would make a 500-event history look like
            a 50-event one.
          */}
          <p className="mt-6 text-xs text-slate-500">
            共 {current.total} 条事件，涉及 {summarizeAudit(entries ?? []).polls} 个投票
            {parsed.ok && parsed.filters.kind !== null
              ? `，类型：${auditKindLabel(parsed.filters.kind)}`
              : ""}
            。
          </p>

          {current.items.length === 0 ? (
            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm text-slate-600">
                索引里没有符合当前过滤条件的事件。过滤条件与索引自身都是可读的，所以这是「没有匹配」而不是「读不到」。
              </p>
            </section>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">类型</th>
                    <th className="px-3 py-2 font-medium">投票</th>
                    <th className="px-3 py-2 font-medium">地址</th>
                    <th className="px-3 py-2 font-medium">详情</th>
                    <th className="px-3 py-2 font-medium">区块</th>
                    <th className="px-3 py-2 font-medium">交易</th>
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((entry) => (
                    <tr
                      key={`${entry.txHash}-${entry.blockNumber}-${entry.kind}`}
                      className="border-t border-slate-100"
                    >
                      <td className="px-3 py-2 text-slate-700">{auditKindLabel(entry.kind)}</td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/poll/${entry.pollAddress}`}
                          className="font-mono text-xs underline"
                        >
                          {shortenAddress(entry.pollAddress)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">
                        {entry.actor === undefined ? "—" : shortenAddress(entry.actor)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {entry.detail ??
                          (entry.optionId === null || entry.optionId === undefined
                            ? "—"
                            : `选项 ${entry.optionId}`)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">
                        {entry.blockNumber}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">
                        {shortenAddress(entry.txHash)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {current.pageCount > 1 && (
            <nav className="mt-6 flex items-center justify-between" aria-label="审计分页">
              <p className="text-xs text-slate-500">
                第 {current.page} / {current.pageCount} 页
              </p>
              <div className="flex gap-2">
                {current.page > 1 && (
                  <Link
                    href={pageHref(current.page - 1)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    上一页
                  </Link>
                )}
                {current.page < current.pageCount && (
                  <Link
                    href={pageHref(current.page + 1)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    下一页
                  </Link>
                )}
              </div>
            </nav>
          )}
        </>
      )}
    </PageShell>
  );
}
