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

  const read = useCallback(async (subject: string) => {
    setLoad({ state: "loading" });

    try {
      const response = await fetch(`/api/notifications?address=${subject}`);

      if (response.status === 404) {
        setLoad({ state: "no-index" });

        return;
      }

      if (!response.ok) {
        setLoad({ state: "failed", message: `读取失败（HTTP ${response.status}）。` });

        return;
      }

      setLoad({ state: "ready", data: (await response.json()) as NotificationsResponse });
    } catch (error) {
      console.error("[notifications] read failed", error);
      setLoad({
        state: "failed",
        message: "读取通知时发生未预期的错误。完整错误见浏览器控制台。",
      });
    }
  }, []);

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
        <p className="text-sm text-slate-600">
          通知按钱包地址归属，所以需要先连接钱包。连接后这一页会列出你订阅的投票的新动态。
        </p>
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
        <h2 className="text-sm font-medium text-slate-800">这个部署没有可用的索引</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
          通知由索引器记录的事件推导，而当前部署没有配置{" "}
          <code className="font-mono">DATABASE_URL</code>，所以无法列出任何动态。
          这不代表「没有新动态」——链上事件仍然在发生，只是这里读不到。
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
          未读 {summary.total} 条，涉及 {summary.pollCount} 个投票
          {truncated ? `（本页只列出最新的 ${limit} 条）` : ""}。
        </p>

        {summary.total > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void markRead(null)}
            data-notification-mark-read
            className="min-h-[44px] rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            全部标记为已读
          </button>
        )}
      </div>

      {summary.total === 0 ? (
        <EmptyState
          title="没有未读动态"
          description="索引可读，且你订阅的投票在上次查看之后没有新事件。这是一种确定的状态，不是读取失败。还没有订阅？在任意投票页点「订阅这个投票」，之后它的投票、改投、撤票、退款与阶段变更都会出现在这里。"
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
                  <span className="font-medium">{auditKindLabel(entry.kind)}</span>
                  {" · "}
                  <Link href={`/poll/${entry.pollAddress}`} className="font-mono text-xs underline">
                    {shortenAddress(entry.pollAddress)}
                  </Link>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {entry.detail ??
                    (entry.optionId === null || entry.optionId === undefined
                      ? "—"
                      : `选项 ${entry.optionId}`)}
                  {entry.actor === undefined ? "" : ` · ${shortenAddress(entry.actor)}`}
                  {` · 区块 ${entry.blockNumber}`}
                </p>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => void markRead(entry.pollAddress)}
                className="min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 disabled:opacity-50"
              >
                这个投票标记为已读
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        {translator.t("nav.audit")} 会列出全部事件（跨所有投票），这里只列出你订阅的部分。
      </p>
    </>
  );
}
