"use client";

/**
 * The page controls under the poll list.
 *
 * ---------------------------------------------------------------------------
 * Why there are no numbered pages
 * ---------------------------------------------------------------------------
 *
 * The poll count is small and the list is paged mostly to keep the first paint
 * short, not to navigate a catalogue. A row of numbers would be mostly empty
 * chrome; previous/next plus a position statement answers the two questions a
 * reader actually has ("is there more" and "where am I") in one line.
 *
 * ---------------------------------------------------------------------------
 * Why the position is stated even on a single page
 * ---------------------------------------------------------------------------
 *
 * "Showing 1-20 of 137" is the only thing that tells a reader their search matched
 * 137 polls rather than the 20 on screen. Without it a truncated list looks
 * complete, which is the same class of mistake as rendering an unreadable index
 * as "no activity".
 */

export interface PaginationProps {
  /** 1-based. */
  page: number;
  pageCount: number;
  /** Rows on the current page. */
  count: number;
  /** Rows that matched, across all pages. */
  total: number;
  pageSize: number;
  onPageChange: (next: number) => void;
}

export function Pagination({
  page,
  pageCount,
  count,
  total,
  pageSize,
  onPageChange,
}: PaginationProps) {
  // Nothing to navigate and nothing worth stating: one page holding everything
  // is not a paginated list, and a control that only ever says "1 of 1" is noise.
  if (pageCount <= 1 && total <= pageSize) return null;

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = total === 0 ? 0 : first + count - 1;

  return (
    <nav
      className="mt-6 flex flex-wrap items-center justify-between gap-3"
      aria-label="投票列表分页"
    >
      <p className="text-xs text-slate-500">
        显示第 {first}–{last} 个，共 {total} 个
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 disabled:opacity-40"
        >
          上一页
        </button>

        <span className="text-xs text-slate-500" aria-current="page">
          第 {page} / {pageCount} 页
        </span>

        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 disabled:opacity-40"
        >
          下一页
        </button>
      </div>
    </nav>
  );
}
