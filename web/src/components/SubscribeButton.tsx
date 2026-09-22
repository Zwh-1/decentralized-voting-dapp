"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { useTranslator } from "@/components/LocaleProvider";

/**
 * "Tell me when this poll moves."
 *
 * ---------------------------------------------------------------------------
 * Why this is offered to a reader with no wallet connected
 * ---------------------------------------------------------------------------
 *
 * A subscription is not a write to the chain and needs no signature — it is a row
 * in this deployment's own index. Requiring a connection first would ask the
 * reader to identify themselves before telling them why, and the button would sit
 * disabled with no explanation.
 *
 * The address still comes from the wallet, because that is what a subscription is
 * keyed by. So the control asks for a connection in a sentence rather than
 * silently doing nothing.
 *
 * ---------------------------------------------------------------------------
 * Why the state is read back from the server rather than remembered
 * ---------------------------------------------------------------------------
 *
 * The button's label is "subscribed" or "subscribe", and that is a fact about the
 * INDEX, not about this component. Keeping it in local state alone would let the
 * label drift from the stored row after a reload, or after the same address
 * subscribed from another tab. So the component reads the subscription list on
 * mount and treats the response as the authority, with the click only triggering a
 * re-read.
 *
 * A deployment with no index cannot answer at all, and the control says so instead
 * of offering a button that would fail silently (ADR-0011).
 */
type State =
  | { state: "no-wallet" }
  | { state: "loading" }
  | { state: "no-index" }
  | { state: "failed" }
  | { state: "known"; subscribed: boolean };

export function SubscribeButton({ address }: { address: `0x${string}` }) {
  const { t } = useTranslator();
  const { address: account, isConnected } = useAccount();
  const [status, setStatus] = useState<State>({ state: "no-wallet" });
  const [busy, setBusy] = useState(false);

  const read = useCallback(
    async (subject: string) => {
      setStatus({ state: "loading" });

      try {
        const response = await fetch(`/api/subscriptions?address=${subject}`);

        if (response.status === 404) {
          setStatus({ state: "no-index" });

          return;
        }

        if (!response.ok) {
          setStatus({ state: "failed" });

          return;
        }

        const body = (await response.json()) as { subscriptions: { pollAddress: string }[] };

        setStatus({
          state: "known",
          // Compared case-insensitively: the API lowercases what it stores, and a
          // checksummed address is the same address.
          subscribed: body.subscriptions.some(
            (row) => row.pollAddress.toLowerCase() === address.toLowerCase(),
          ),
        });
      } catch (error) {
        console.error("[subscribe] read failed", error);
        setStatus({ state: "failed" });
      }
    },
    [address],
  );

  useEffect(() => {
    if (!isConnected || account === undefined) {
      setStatus({ state: "no-wallet" });

      return;
    }

    void read(account);
  }, [account, isConnected, read]);

  const toggle = useCallback(async () => {
    if (account === undefined || status.state !== "known") return;

    setBusy(true);

    try {
      const response = status.subscribed
        ? await fetch(`/api/subscriptions?address=${account}&poll=${address}`, { method: "DELETE" })
        : await fetch("/api/subscriptions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ address: account, poll: address }),
          });

      if (!response.ok) {
        console.error("[subscribe] write failed", response.status);

        return;
      }

      await read(account);
    } catch (error) {
      console.error("[subscribe] write failed", error);
    } finally {
      setBusy(false);
    }
  }, [account, address, read, status]);

  if (status.state === "no-wallet") {
    return (
      <p className="text-xs text-slate-500" data-subscribe-state="no-wallet">
        {t("subscribe.connectFirst")}{" "}
        <Link href="/notifications" className="underline">
          {t("subscribe.notifications")}
        </Link>
        {t("subscribe.connectLast")}
      </p>
    );
  }

  if (status.state === "loading") {
    return (
      <p className="text-xs text-slate-400" data-subscribe-state="loading">
        {t("subscribe.reading")}
      </p>
    );
  }

  if (status.state === "no-index") {
    return (
      <p className="text-xs leading-relaxed text-slate-500" data-subscribe-state="no-index">
        {t("subscribe.noIndex1")}
        <code className="font-mono">DATABASE_URL</code>
        {t("subscribe.noIndex2")}
      </p>
    );
  }

  if (status.state === "failed") {
    return (
      <p className="text-xs leading-relaxed text-rose-600" data-subscribe-state="failed">
        {t("subscribe.readFailed")}
      </p>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-subscribe-state={status.subscribed ? "subscribed" : "unsubscribed"}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        data-subscribe-toggle
        className={`min-h-[44px] rounded-lg border px-3 py-2 text-xs disabled:opacity-50 ${
          status.subscribed
            ? "border-slate-200 bg-white text-slate-600"
            : "border-slate-900 bg-slate-900 font-medium text-white"
        }`}
      >
        {status.subscribed ? t("subscribe.unsubscribe") : t("subscribe.subscribe")}
      </button>

      <span className="text-xs text-slate-400">{t("subscribe.note")}</span>
    </div>
  );
}
