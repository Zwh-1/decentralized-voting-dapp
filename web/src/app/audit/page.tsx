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
import { translatorFor } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/server";
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
 *
 * ---------------------------------------------------------------------------
 * Why the language is read here rather than through a hook
 * ---------------------------------------------------------------------------
 *
 * This is a Server Component that reads the database, so it must not gain
 * `"use client"` — the hook would drag the whole feed across a client boundary
 * and the page would stop being part of the server's answer. `currentLocale()`
 * reads the same cookie the root layout does, and `translatorFor` turns it into
 * the same translator the client components get, so one language governs both.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = translatorFor(await currentLocale());
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
      entries = await getAuditActivity(parsed.filters, t.locale);
    } catch (error) {
      console.error("[audit page] read failed", error);
      loadError = t.t("audit.readFailed");
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
      title={t.t("audit.title")}
      subtitle={t.t("audit.subtitle")}
      configuredTarget={configuredTarget}
      translator={t}
    >
      <p className="mt-4 text-xs text-slate-400">
        <Link href="/" className="underline">
          {t.t("audit.backToPolls")}
        </Link>
      </p>

      {/* A rejected filter is stated, not silently ignored. */}
      {!parsed.ok && (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {parsed.message}
        </section>
      )}

      {/* The kind filter, as links, so the state survives a copy-paste and works without JS. */}
      <nav className="mt-6 flex flex-wrap items-center gap-2" aria-label={t.t("audit.filterLabel")}>
        <Link
          href={hrefWith({ kind: null })}
          className={`rounded-full border px-3 py-1.5 text-xs ${
            parsed.ok && parsed.filters.kind === null
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-600"
          }`}
        >
          {t.t("audit.allKinds")}
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
            {auditKindLabel(kind, t.locale)}
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
          <h2 className="text-sm font-medium text-slate-800">{t.t("audit.noIndexTitle")}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            {t.t("audit.indexRequired", {
              // The variable and the commands are quoted into the sentence, not
              // reformatted by it: they are the exact strings an operator types.
              databaseUrl: (<code className="font-mono">DATABASE_URL</code>) as unknown as string,
            })}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {t.t("audit.indexHowTo", {
              databaseUrl: (<code className="font-mono">DATABASE_URL</code>) as unknown as string,
              commands: (
                <code className="font-mono">
                  pnpm indexer:migrate &amp;&amp; pnpm indexer:drain
                </code>
              ) as unknown as string,
            })}
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
            {t.t("audit.summary", {
              count: current.total,
              polls: summarizeAudit(entries ?? []).polls,
              kind:
                parsed.ok && parsed.filters.kind !== null
                  ? t.t("audit.summaryKind", {
                      kind: auditKindLabel(parsed.filters.kind, t.locale),
                    })
                  : "",
            })}
          </p>

          {current.items.length === 0 ? (
            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm text-slate-600">
                {t.t("audit.empty")}
                {t.t("audit.emptyDetail")}
              </p>
            </section>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t.t("audit.kind")}</th>
                    <th className="px-3 py-2 font-medium">{t.t("audit.poll")}</th>
                    <th className="px-3 py-2 font-medium">{t.t("audit.actor")}</th>
                    <th className="px-3 py-2 font-medium">{t.t("audit.detail")}</th>
                    <th className="px-3 py-2 font-medium">{t.t("audit.block")}</th>
                    <th className="px-3 py-2 font-medium">{t.t("audit.tx")}</th>
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((entry) => (
                    <tr
                      key={`${entry.txHash}-${entry.blockNumber}-${entry.kind}`}
                      className="border-t border-slate-100"
                    >
                      <td className="px-3 py-2 text-slate-700">
                        {auditKindLabel(entry.kind, t.locale)}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/poll/${entry.pollAddress}`}
                          className="font-mono text-xs underline"
                        >
                          {shortenAddress(entry.pollAddress)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">
                        {entry.actor === undefined ? t.ballot.nothing : shortenAddress(entry.actor)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {entry.detail ??
                          (entry.optionId === null || entry.optionId === undefined
                            ? t.ballot.nothing
                            : t.t("activity.option", { id: entry.optionId }))}
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
            <nav
              className="mt-6 flex items-center justify-between"
              aria-label={t.t("audit.pagination")}
            >
              <p className="text-xs text-slate-500">
                {t.t("common.pageOf", { page: current.page, pageCount: current.pageCount })}
              </p>
              <div className="flex gap-2">
                {current.page > 1 && (
                  <Link
                    href={pageHref(current.page - 1)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    {t.t("common.previous")}
                  </Link>
                )}
                {current.page < current.pageCount && (
                  <Link
                    href={pageHref(current.page + 1)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    {t.t("common.next")}
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
