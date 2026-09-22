"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { fetchHealth } from "@/lib/client-api";
import { healthRows } from "@/lib/health-report";

/**
 * 运行状态: the `/api/health` payload, rendered.
 *
 * The endpoint already computed `lagBlocks`, `indexError`, `indexConfigured` and
 * `indexerLoopEnabled`, and nothing in the interface showed any of them — so a
 * deployment whose index was down was indistinguishable from a healthy one to
 * anyone not reading the JSON by hand. This panel closes that gap.
 *
 * Collapsed by default. That is deliberate rather than cosmetic: these are
 * operator-facing diagnostics, and the pages this sits on are read by voters.
 * A reader who never opens it sees no change; a reader debugging a missing vote
 * has the numbers one click away.
 *
 * Every decision about *what* to show lives in `lib/health-report.ts`, which is
 * a pure function with its own tests. This component only lays the rows out.
 */
export function HealthPanel() {
  const [open, setOpen] = useState(false);

  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    // Diagnostics are worth re-reading on demand, but polling them would turn a
    // status panel into traffic for readers who never open it.
    enabled: open,
    retry: false,
  });

  const rows = data === undefined ? [] : healthRows(data);

  return (
    <section className="mt-10 rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        data-testid="health-toggle"
        className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-sm text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
      >
        <span className="flex items-center gap-2">
          <GaugeMark />
          运行状态（索引高度 / 落后区块 / 错误）
        </span>
        <span className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open ? (
        <div className="border-t border-slate-200 px-4 py-3">
          {isPending ? <p className="text-sm text-slate-400">读取中…</p> : null}

          {/*
            The panel must not claim "everything is fine" when the request
            itself failed: an unreachable /api/health is a different fact from a
            degraded one, and `describeFailure`-style honesty applies here too.
          */}
          {error !== null && error !== undefined ? (
            <div className="text-sm text-amber-700">
              <p>无法读取 /api/health，因此这里没有可展示的状态。</p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 transition hover:text-slate-900"
              >
                重试
              </button>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <dl
              className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2"
              data-testid="health-rows"
            >
              {rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-slate-400">{row.label}</dt>
                  <dd
                    className={
                      row.tone === "warn"
                        ? "break-all text-right text-xs text-amber-700"
                        : row.tone === "muted"
                          ? "break-all text-right text-xs text-slate-400"
                          : "break-all text-right text-xs text-slate-700"
                    }
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** A gauge, drawn inline. Decorative; the label beside it says what this is. */
function GaugeMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-slate-400"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
      <path d="m13.4 12.6 4.1-4.1" />
      <path d="M3 20a9 9 0 1 1 18 0" />
    </svg>
  );
}
