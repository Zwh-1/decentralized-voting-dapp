"use client";

import { SORT_ORDERS, type SortOrder } from "@/lib/pagination";

/**
 * The search box and sort selector above the poll list.
 *
 * ---------------------------------------------------------------------------
 * Why the sort is a select rather than a column header
 * ---------------------------------------------------------------------------
 *
 * The list is a grid of cards, not a table, so there is no header row to click.
 * A select also states the CURRENT order in words, which matters more here than
 * in a table: a reader who arrives at `?sort=question` from a shared link can see
 * why the newest poll is not at the top.
 *
 * ---------------------------------------------------------------------------
 * Why the query is not debounced here
 * ---------------------------------------------------------------------------
 *
 * Filtering happens in the browser over an array that is already in memory, so
 * each keystroke is a cheap array pass. Debouncing would add latency to the one
 * interaction where immediate feedback is the whole point — a reader typing to
 * find one poll should see the list narrow as they type.
 */

/** The sort labels, in the order they appear in the control. */
const SORT_LABELS: Record<SortOrder, string> = {
  newest: "最新截止",
  oldest: "最早截止",
  "most-voted": "票数最多",
  question: "按问题排序",
};

export interface SearchBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  sort: SortOrder;
  onSortChange: (next: SortOrder) => void;
  /** How many polls matched, and how many exist. Shown so a search is never silent. */
  matched: number;
  total: number;
}

export function SearchBar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  matched,
  total,
}: SearchBarProps) {
  const searching = query.trim().length > 0;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label className="relative min-w-56 flex-1">
        <span className="sr-only">搜索投票</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索问题、发起人或合约地址…"
          // 44px minimum touch target: the same rule the PWA manifest follows,
          // and this is the control a phone reader uses most.
          className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
        {searching && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="清除搜索"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-900"
          >
            清除
          </button>
        )}
      </label>

      <label className="flex items-center gap-2 text-xs text-slate-500">
        <span className="sr-only sm:not-sr-only">排序</span>
        <select
          value={sort}
          onChange={(event) => onSortChange(event.target.value as SortOrder)}
          className="h-11 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
        >
          {SORT_ORDERS.map((order) => (
            <option key={order} value={order}>
              {SORT_LABELS[order]}
            </option>
          ))}
        </select>
      </label>

      {/*
        The match count is shown only while searching. Outside a search it would
        repeat the heading's total, and two identical numbers in one viewport
        teach a reader to ignore both.
      */}
      {searching && (
        <p className="text-xs text-slate-500" role="status">
          {matched === 0
            ? `没有匹配「${query.trim()}」的投票`
            : `匹配 ${matched} / ${total} 个投票`}
        </p>
      )}
    </div>
  );
}
