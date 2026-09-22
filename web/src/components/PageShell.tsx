// SPDX-License-Identifier: MIT
import Link from "next/link";
import type { ReactNode } from "react";

import { HealthPanel } from "@/components/HealthPanel";
import { WalletSlot } from "@/components/WalletSlot";
import type { ChainTarget } from "@/lib/voting";
/**
 * The frame every page shares: masthead, navigation, content, footer.
 *
 * A plain Server Component with no `"use client"`. That is not tidiness — the
 * pages it wraps are the ones that must render when the index is down or absent,
 * and a shell that pulled in client state of its own would make the frame part of
 * what can fail. The two client pieces, `WalletSlot` and the poll list, are
 * mounted from inside it as proper Client Components.
 *
 * ---------------------------------------------------------------------------
 * The visual decisions, and why they are these ones
 * ---------------------------------------------------------------------------
 *
 * The masthead is dark and full-bleed while the content below is a light column.
 * That contrast does real work: it separates "what this site is and which chain
 * you are on" from "the polls", so a reader who has scrolled halfway down a long
 * list still knows at a glance which deployment they are looking at. On a page
 * whose whole premise is "the chain is the source of truth", the chain's identity
 * should not be the least visible thing on screen.
 *
 * `sticky` on the nav, not on the masthead: the masthead carries the chain badge,
 * which is the one thing worth keeping in view, but a taller pinned header eats
 * a phone's viewport. The nav is one line and earns the space.
 */
export function PageShell({
  title,
  subtitle,
  configuredTarget,
  children,
  actions,
}: {
  title: string;
  subtitle: string;
  /** The chain and factory this deployment reads; the wallet slot names it. */
  configuredTarget: ChainTarget | null;
  children: ReactNode;
  /** Optional primary actions, right-aligned in the page header. */
  actions?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-50">
      <Masthead configuredTarget={configuredTarget} />

      <main className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              {title}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">{subtitle}</p>
          </div>
          {actions !== undefined && <div className="shrink-0">{actions}</div>}
        </header>

        <div className="mt-8">{children}</div>

        {/*
          Collapsed by default, and mounted inside the shell rather than on one
          page so the diagnostics are reachable wherever a reader is looking for
          a vote that seems missing. It fetches only once opened.
        */}
        <HealthPanel />

        <Footer />
      </main>
    </div>
  );
}

/**
 * The dark band at the top: identity, navigation, and the deployment's chain.
 *
 * The chain badge is rendered here rather than only in the wallet control because
 * it is true whether or not a wallet is connected — it is the chain this
 * deployment was built against (ADR-0019), not the one the reader's wallet
 * happens to be on. Showing it unconditionally is what lets a reader notice they
 * are on the wrong one before they try to vote.
 */
function Masthead({ configuredTarget }: { configuredTarget: ChainTarget | null }) {
  return (
    <div className="bg-slate-900 text-slate-100">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/" className="group flex items-center gap-2.5">
            <ShieldMark />
            <span className="text-sm font-semibold tracking-tight">去中心化投票平台</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            <NavLink href="/">全部投票</NavLink>
            {/*
              `prefetch={false}` on 我的投票, and not as a micro-optimisation: that
              page is dynamic and its render performs a chain read of every poll, so
              letting Next prefetch it would fire that read for readers who never
              open the link.
            */}
            <NavLink href="/my" prefetch={false}>
              我的投票
            </NavLink>
          </nav>
        </div>

        {/*
          The wallet control: a Client Component mounted from this Server
          Component. It lives in the masthead rather than in each page because the
          chain it reports is true of the whole deployment, not of one page — and
          because this dark band is what gives the chain badge enough contrast to
          be noticed at all.
        */}
        <WalletSlot configuredTarget={configuredTarget} />
      </div>
    </div>
  );
}

function NavLink({
  href,
  children,
  prefetch,
}: {
  href: string;
  children: ReactNode;
  prefetch?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      className="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </Link>
  );
}

/**
 * A small shield, drawn rather than imported.
 *
 * The project is named Aegis and the whole point of it is that the tally is
 * guarded by a contract; an inline SVG keeps that self-contained. `aria-hidden`
 * because the wordmark beside it already names the site, and a screen reader
 * announcing "shield, 去中心化投票平台" is noise.
 */
function ShieldMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5 text-emerald-400"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/**
 * The footer, which is a disclosure rather than decoration.
 *
 * The centralisation risks are stated on every page in plain language, including
 * the one that costs the project something to admit: a creator can take unclaimed
 * stakes after the grace period. An interface that only advertises the trustless
 * half of its design is not being honest with the person deciding whether to put
 * money into it.
 */
function Footer() {
  return (
    <footer className="mt-12 border-t border-slate-200 pt-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">使用前请知悉</h2>
      <ul className="mt-3 space-y-2 text-xs leading-relaxed text-slate-500">
        <li className="flex gap-2">
          <Mark />
          <span>
            每个投票的发起人可以维护自己的白名单，也可以在宽限期后调用{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
              sweepUnclaimed()
            </code>{" "}
            取走无人领回的押金。
          </span>
        </li>
        <li className="flex gap-2">
          <Mark />
          <span>
            索引器（本应用内的只读层）是可重建的缓存，
            <strong className="text-slate-600">链上数据才是唯一真相</strong>
            ，索引不可用时页面会直接读链。
          </span>
        </li>
        <li className="flex gap-2">
          <Mark />
          <span>任何写入都由你自己的钱包签名，后端不持私钥。</span>
        </li>
      </ul>
    </footer>
  );
}

function Mark() {
  return <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />;
}
