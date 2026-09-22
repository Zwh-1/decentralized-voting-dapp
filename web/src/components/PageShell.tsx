// SPDX-License-Identifier: MIT
import Link from "next/link";
import type { ReactNode } from "react";

import { HealthPanel } from "@/components/HealthPanel";
import { WalletSlot } from "@/components/WalletSlot";
import type { ChainTarget } from "@/lib/voting";
/**
 * The frame every page shares: title, navigation, wallet control, footer.
 *
 * A plain Server Component with no `"use client"`. That is not tidiness — the
 * pages it wraps are the ones that must render when the index is down or absent,
 * and a shell that pulled in client state of its own would make the frame part of
 * what can fail. The two client pieces, `WalletSlot` and the poll list, are
 * mounted from inside it as proper Client Components.
 */
export function PageShell({
  title,
  subtitle,
  configuredTarget,
  children,
}: {
  title: string;
  subtitle: string;
  /** The chain and factory this deployment reads; the wallet slot names it. */
  configuredTarget: ChainTarget | null;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-xs text-slate-400 transition hover:text-slate-600">
            去中心化投票平台
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{subtitle}</p>
        </div>
        <WalletSlot configuredTarget={configuredTarget} />
      </header>

      <nav className="mt-4 flex items-center gap-4 border-b border-slate-200 pb-3 text-sm">
        <Link href="/" className="text-slate-600 transition hover:text-slate-900">
          全部投票
        </Link>
        {/*
          `prefetch={false}` on 我的投票, and not as a micro-optimisation: that page
          is dynamic and its render performs a chain read of every poll, so letting
          Next prefetch it would fire that read for readers who never open the link.
        */}
        <Link
          href="/my"
          prefetch={false}
          className="text-slate-600 transition hover:text-slate-900"
        >
          我的投票
        </Link>
      </nav>

      {children}

      {/*
        Collapsed by default, and mounted inside the shell rather than on one
        page so the diagnostics are reachable wherever a reader is looking for a
        vote that seems missing. It fetches only once opened.
      */}
      <HealthPanel />

      <footer className="mt-10 border-t border-slate-200 pt-5 text-xs leading-relaxed text-slate-400">
        <p>
          已知中心化风险：每个投票的发起人可以维护自己的白名单、可调用{" "}
          <code className="font-mono">sweepUnclaimed()</code>
          取走超过宽限期未被领回的押金；索引器（本 Next 应用内的只读层）是可重建的缓存，
          链上数据才是唯一真相。任何写入都由你自己的钱包签名，后端不持私钥。
        </p>
      </footer>
    </main>
  );
}
