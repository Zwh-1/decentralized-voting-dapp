"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslator } from "@/components/LocaleProvider";
import { EmptyState, Skeleton } from "@/components/ui";
import { fetchActivity } from "@/lib/client-api";
import type { MessageKey } from "@/lib/i18n";
import { shortenAddress } from "@/lib/voting";
/**
 * Everything that happened in this poll, newest first.
 *
 * ---------------------------------------------------------------------------
 * Why this is worth a panel of its own
 * ---------------------------------------------------------------------------
 *
 * The chain already holds every one of these events, and before this panel the
 * interface showed almost none of them: a reader could see the current tally and
 * their own state, and nothing about how the poll reached that state. That gap is
 * what makes a result hard to trust — "67 votes for option 2" is a claim, whereas
 * "these 67 addresses each did this, at these blocks" is a record someone can
 * check.
 *
 * ---------------------------------------------------------------------------
 * Why it is collapsed, and why the honest empty states matter
 * ---------------------------------------------------------------------------
 *
 * It is a long list about other people, which is not what most readers came for,
 * so it stays closed until asked for.
 *
 * The three states are kept strictly distinct, and this is the part worth being
 * careful about:
 *
 *   * no index      — `null` from the API. The history EXISTS on chain, this
 *                     deployment just cannot list it. Rendering an empty timeline
 *                     here would assert that nothing ever happened.
 *   * no events     — an empty array. The poll genuinely has no history yet.
 *   * loading       — a skeleton, so the panel does not flash "empty" before its
 *                     answer arrives.
 *
 * Only the middle one may say "还没有任何活动".
 */
export function PollActivity({ address }: { address: `0x${string}` }) {
  const translator = useTranslator();
  const [open, setOpen] = useState(false);

  const query = useQuery({
    queryKey: ["activity", address],
    queryFn: ({ signal }) => fetchActivity(address, signal),
    // Only on demand: this is a UNION across four tables, and a reader who never
    // opens the panel should not pay for it.
    enabled: open,
    retry: false,
  });

  const entries = query.data?.entries;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        data-testid="activity-toggle"
        className="flex w-full items-center justify-between gap-3 rounded-xl px-5 py-4 text-left transition hover:bg-slate-50"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-900">
            {translator.t("activity.heading")}
          </span>
          <span className="mt-0.5 block text-xs text-slate-500">
            {translator.t("activity.subheading")}
          </span>
        </span>
        <span className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600">
          {open ? translator.t("common.collapse") : translator.t("common.expand")}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4" data-testid="activity-panel">
          {query.isPending && (
            <div className="space-y-2" data-testid="activity-loading">
              <Skeleton className="h-8 w-full rounded-lg" />
              <Skeleton className="h-8 w-full rounded-lg" />
              <Skeleton className="h-8 w-full rounded-lg" />
            </div>
          )}

          {/*
            A failed read and an absent index are reported differently. The first
            is a fault in this deployment; the second is a deployment that was
            never given a database, which is a supported configuration and not an
            error at all.

            Each state carries its own `data-testid` because the browser drill has
            to distinguish "still loading" from "settled with nothing to show".
            Reading the row count alone cannot tell those apart — both are zero —
            and an earlier version of that assertion concluded "renders nothing"
            from a panel that was simply mid-fetch.
          */}
          {query.isError && (
            <div
              className="rounded-lg border border-rose-200 bg-rose-50 p-4"
              data-testid="activity-error"
            >
              <p className="text-sm font-medium text-rose-800">
                {translator.t("activity.readFailedTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-rose-700">
                {translator.t("activity.readFailedDetail")}
              </p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="mt-2 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 transition hover:bg-rose-100"
              >
                {translator.t("common.retry")}
              </button>
            </div>
          )}

          {query.isSuccess && query.data === null && (
            <div
              className="rounded-lg border border-slate-200 bg-slate-50 p-4"
              data-testid="activity-unavailable"
            >
              <p className="text-sm font-medium text-slate-700">
                {translator.t("activity.noIndexTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                {translator.t("activity.noIndexDetail")}
                <strong className="text-slate-600">
                  {translator.t("activity.noIndexEmphasis")}
                </strong>
              </p>
            </div>
          )}

          {entries !== undefined && entries !== null && entries.length === 0 && (
            <div data-testid="activity-empty">
              <EmptyState
                title={translator.t("activity.emptyTitle")}
                description={translator.t("activity.emptyDescription")}
              />
            </div>
          )}

          {entries !== undefined && entries !== null && entries.length > 0 && (
            <>
              <p className="mb-3 text-xs text-slate-500">
                {translator.t("activity.total", { count: entries.length })}
              </p>
              <ol className="divide-y divide-slate-100">
                {entries.map((entry) => (
                  <ActivityRow
                    key={`${entry.txHash}-${entry.kind}-${entry.blockNumber}`}
                    entry={entry}
                  />
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * What each kind of event is called, and how it is coloured.
 *
 * The label is a catalogue KEY rather than a string: a module-level table of
 * translated text would be frozen in whichever language was current when the
 * module was first evaluated, which is a bug that only shows up for the second
 * reader on a long-lived server.
 */
const KIND_LABELS: Record<string, { labelKey: MessageKey; className: string }> = {
  cast: {
    labelKey: "activity.kind.cast",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  changed: { labelKey: "activity.kind.changed", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  withdrawn: {
    labelKey: "activity.kind.withdrawn",
    className: "bg-amber-50 text-amber-800 ring-amber-200",
  },
  refunded: {
    labelKey: "activity.kind.refunded",
    className: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  },
  whitelist: {
    labelKey: "activity.kind.whitelist",
    className: "bg-slate-100 text-slate-600 ring-slate-200",
  },
  phase: { labelKey: "activity.kind.phase", className: "bg-slate-900 text-white ring-slate-900" },
};

function ActivityRow({ entry }: { entry: import("@/lib/poll-report").ActivityEntry }) {
  const translator = useTranslator();

  // An unrecognised kind gets a neutral chip rather than being dropped from the
  // list. A newer indexer could write a kind this bundle does not know, and
  // silently omitting it would make the record incomplete without saying so.
  // An unknown kind has no catalogue key, so its own name is shown as-is.
  const kind = KIND_LABELS[entry.kind];
  const label = kind === undefined ? entry.kind : translator.t(kind.labelKey);
  const className = kind?.className ?? "bg-slate-100 text-slate-600 ring-slate-200";

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-xs">
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 font-medium ring-1 ${className}`}
        data-activity-kind={entry.kind}
      >
        {label}
      </span>

      {entry.actor !== undefined && (
        <span className="font-mono text-slate-600" title={entry.actor}>
          {shortenAddress(entry.actor)}
        </span>
      )}

      {entry.optionId !== null && entry.optionId !== undefined && (
        <span className="text-slate-600">
          {translator.t("activity.option", { id: entry.optionId })}
        </span>
      )}

      {entry.detail !== undefined && <span className="text-slate-600">{entry.detail}</span>}

      <span className="ml-auto flex items-center gap-3 text-slate-400">
        {/* The block number is the audit anchor: it is what a third party looks
            up to verify this row exists. */}
        <span className="tabular-nums" title={translator.t("activity.blockTitle")}>
          #{entry.blockNumber}
        </span>
        <span className="font-mono" title={entry.txHash}>
          {entry.txHash.slice(0, 10)}…
        </span>
      </span>
    </li>
  );
}
