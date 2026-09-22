// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";

/**
 * The small pieces every page composes from.
 *
 * ---------------------------------------------------------------------------
 * Why these exist rather than repeating classes
 * ---------------------------------------------------------------------------
 *
 * The interface previously described each surface inline, which is how the same
 * panel ended up with three different paddings, two border radii and two shadow
 * treatments across four files. None of those differences meant anything — they
 * were the drift of copying a class string and editing part of it.
 *
 * These are Server Components with no `"use client"`. That matters for the same
 * reason `PageShell` has none: the pages that must render when the index is down
 * are built out of these, so a primitive that pulled in client state would make
 * the frame part of what can fail.
 */

/** A card surface: white, bordered, softly lifted. */
export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "article" | "section" | "li";
}) {
  return (
    <Tag className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {children}
    </Tag>
  );
}

/** A titled section inside a card. */
export function Section({
  title,
  description,
  children,
  tone = "default",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <section
      className={`rounded-xl border p-5 ${
        tone === "danger" ? "border-amber-200 bg-amber-50/40" : "border-slate-200 bg-white"
      }`}
    >
      <h2
        className={`text-sm font-semibold ${tone === "danger" ? "text-amber-900" : "text-slate-900"}`}
      >
        {title}
      </h2>
      {description !== undefined && (
        <p
          className={`mt-1 text-xs leading-relaxed ${
            tone === "danger" ? "text-amber-800" : "text-slate-500"
          }`}
        >
          {description}
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * A labelled value, for the "我的状态" panel and stat rows.
 *
 * Renders a real `<dt>`/`<dd>` pair. `ui-drill` reads rows by finding the `<dt>`
 * whose text equals the label and taking its sibling `<dd>`, so the element
 * choice here is load-bearing: swapping these for `<div>`s would make every row
 * assertion in the drill silently read `null` and fail for a reason that looks
 * nothing like "the markup changed".
 */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-slate-900">{children}</dd>
    </div>
  );
}

/** A compact statistic, used in card footers. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{value}</dd>
      {hint !== undefined && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/** A status pill. `className` carries the tone, which `presentation.ts` owns. */
export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${className}`}
      data-badge
    >
      {children}
    </span>
  );
}

/**
 * An empty state.
 *
 * Every list in the app previously rendered a single line of grey text when it
 * had nothing to show, which reads as "this page is broken" rather than "there
 * is nothing here yet". Naming the situation and offering the next action is the
 * difference between an empty screen and an unfinished one.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-slate-500">{description}</p>
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * The placeholder shown while a value is still being read.
 *
 * A sized grey block rather than the word 读取中…: reserved space means the
 * layout does not jump when the value arrives, and 0.001 ETH replacing a
 * same-width block reads as data landing. Text that reflows the row instead
 * makes the page look like it changed its mind.
 */
export function Skeleton({ className = "h-4 w-16" }: { className?: string }) {
  return <span className={`inline-block animate-pulse rounded bg-slate-200 ${className}`} />;
}

/** A horizontal share bar, for a tally. */
export function ShareBar({ percent, tone = "live" }: { percent: number; tone?: "live" | "mine" }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div
        className={`h-full rounded-full transition-all ${
          tone === "mine" ? "bg-emerald-500" : "bg-slate-400"
        }`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
