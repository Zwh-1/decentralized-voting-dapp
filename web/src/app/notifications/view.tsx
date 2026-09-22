"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { useTranslator } from "@/components/LocaleProvider";
import { EmptyState, Skeleton } from "@/components/ui";
import { auditKindLabel } from "@/lib/audit";
import type { NotificationEntry, NotificationSummary } from "@/lib/notify";
import { shortenAddress } from "@/lib/voting";

/**
 * 通知列表: the client half of the notifications page.
 *
 * The subject is the CONNECTED WALLET, which only the browser knows: there is no
 * session and no server-side notion of who is asking. So the address comes from
 * `useAccount` and the read happens after mount.
 *
 * That produces three states that must stay distinct rather than two:
 * "no wallet yet", "read, and here is what is unread", and "the read could not be
 * answered". Collapsing the third into "nothing is waiting" would tell a reader
 * their polls are quiet when the deployment cannot say — the lie ADR-0011 forbids
 * everywhere else in this app.
 *
 * `mark read` is only offered once the entries it would acknowledge are in hand,
 * and the request names only the SCOPE (all, or one poll). The server re-derives
 * the heights from the index. Letting the client send "what I was shown" would let
 * any address advance any other address's watermark over events that were never
 * displayed.
 */
interface NotificationsResponse {
  address: string;
  source: string;
  summary: NotificationSummary;
  truncated: boolean;
  limit: number;
  entries: NotificationEntry[];
}

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; data: NotificationsResponse }
  | { state: "no-index" }
  | { state: "failed"; message: string };

export function NotificationsView() {
  const translator = useTranslator();
  const { address, isConnected } = useAccount();
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [busy, setBusy] = useState(false);

  const read = useCallback(
    async (subject: string) => {
      setLoad({ state: "loading" });

      try {
        const response = await fetch(`/api/notifications?address=${subject}`);

        if (response.status === 404) {
          setLoad({ state: "no-index" });

          return;
        }

        if (!response.ok) {
          setLoad({
            state: "failed",
            message: translator.t("notifications.readFailedHttp", { status: response.status }),
          });

          return;
        }

        setLoad({ state: "ready", data: (await response.json()) as NotificationsResponse });
      } catch (error) {
        console.error("[notifications] read failed", error);
        setLoad({
          state: "failed",
          message: translator.t("notifications.readFailedUnexpected"),
        });
      }
    },
    [translator],
  );

  useEffect(() => {
    if (!isConnected || address === undefined) {
      // Back to the "connect a wallet" state rather than leaving a previous
      // address's notifications on screen after a disconnect.
      setLoad({ state: "idle" });

      return;
    }

    void read(address);
  }, [address, isConnected, read]);

  const markRead = useCallback(
    async (poll: string | null) => {
      if (address === undefined) return;

      setBusy(true);

      try {
        const response = await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, poll }),
        });

        if (!response.ok) {
          console.error("[notifications] mark read failed", response.status);
        }

        await read(address);
      } catch (error) {
        console.error("[notifications] mark read failed", error);
      } finally {
        setBusy(false);
      }
    },
    [address, read],
  );

  if (!isConnected) {
    return (
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-600">{translator.t("notifications.connectFirst")}</p>
      </section>
    );
  }

  if (load.state === "loading" || load.state === "idle") {
    return (
      <div className="mt-6 space-y-3">
        <Skeleton />
        <Skeleton />
      </div>
    );
  }

  if (load.state === "no-index") {
    return (
      <section className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
        <h2 className="text-sm font-medium text-slate-800">{translator.t("audit.noIndexTitle")}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
          {translator.t("notifications.indexRequired", {
            // The variable is quoted into the sentence rather than restyled by it:
            // it is the exact name an operator sets.
            databaseUrl: (<code className="font-mono">DATABASE_URL</code>) as unknown as string,
          })}
        </p>
      </section>
    );
  }

  if (load.state === "failed") {
    return (
      <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
        {load.message}
      </section>
    );
  }

  const { summary, entries, truncated, limit } = load.data;

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500" data-notification-summary>
          {translator.t("notifications.summary", {
            count: summary.total,
            polls: summary.pollCount,
            truncated: truncated ? translator.t("notifications.summaryTruncated", { limit }) : "",
          })}
        </p>

        {summary.total > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void markRead(null)}
            data-notification-mark-read
            className="min-h-[44px] rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {translator.t("notifications.markAllRead")}
          </button>
        )}
      </div>

      {summary.total === 0 ? (
        <EmptyState
          title={translator.t("notifications.emptyTitle")}
          description={translator.t("notifications.emptyDescription")}
        />
      ) : (
        <ul className="mt-4 space-y-2" data-notification-list>
          {entries.map((entry) => (
            <li
              key={`${entry.txHash}-${entry.blockNumber}-${entry.kind}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3"
              data-notification
            >
              <div className="min-w-0">
                <p className="text-sm text-slate-800">
                  <span className="font-medium">
                    {auditKindLabel(entry.kind, translator.locale)}
                  </span>
                  {" · "}
                  <Link href={`/poll/${entry.pollAddress}`} className="font-mono text-xs underline">
                    {shortenAddress(entry.pollAddress)}
                  </Link>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {entry.detail ??
                    (entry.optionId === null || entry.optionId === undefined
                      ? translator.ballot.nothing
                      : translator.t("activity.option", { id: entry.optionId }))}
                  {entry.actor === undefined ? "" : ` · ${shortenAddress(entry.actor)}`}
                  {` · ${translator.t("notifications.block", { block: entry.blockNumber })}`}
                </p>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => void markRead(entry.pollAddress)}
                className="min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 disabled:opacity-50"
              >
                {translator.t("notifications.markThisRead")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        {translator.t("notifications.auditLine", { audit: translator.t("nav.audit") })}
      </p>
    </>
  );
}
