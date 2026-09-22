"use client";

import { useState } from "react";

/**
 * Download this poll's result, for someone who is not going to trust the page.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * A result shown in a web page is a claim made by whoever runs the page. The
 * point of putting the tally on a chain is that the claim can be checked without
 * trusting the page — but only if the numbers can leave the page. Before this,
 * they could not: a reader who wanted to verify a result had to read the contract
 * by hand, which is exactly the barrier that keeps "verifiable" theoretical.
 *
 * So this offers the same figures in two forms, and both are built server-side
 * from the CONTRACT, not from the index (ADR-0001):
 *
 *   * CSV, for a spreadsheet, which is where a person actually re-adds a column;
 *   * JSON, for a script, which is where a reviewer diffs two snapshots.
 *
 * ---------------------------------------------------------------------------
 * Why plain anchors rather than a fetch-and-blob
 * ---------------------------------------------------------------------------
 *
 * `Content-Disposition: attachment` on the route means the browser saves the
 * file. Fetching into a Blob and synthesising a download would mean holding the
 * whole file in memory, inventing a filename here that the route already sets,
 * and losing the browser's own download UI — for no gain.
 *
 * The `download` attribute names the file for the common case, and the route's
 * header is what makes it work when a browser ignores the attribute.
 */
export function ResultExport({ address }: { address: `0x${string}` }) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/api/polls/${address}/export?format=json`,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permissions, insecure context). The
      // link is visible beside this button, so a refusal costs the reader
      // nothing and there is no error worth showing.
      setCopied(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">导出结果</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        数字直接读自合约，与页面上显示的是同一次读取。导出的文件不依赖本页，
        可以离线核对；合约地址与截止时间也一并写进文件，便于日后比对。
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a
          href={`/api/polls/${address}/export?format=csv`}
          download
          data-export="csv"
          className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          下载 CSV
        </a>
        <a
          href={`/api/polls/${address}/export?format=json`}
          download
          data-export="json"
          className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          下载 JSON
        </a>
        <button
          type="button"
          onClick={() => void copyLink()}
          data-export="copy"
          className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          {copied ? "已复制" : "复制 JSON 链接"}
        </button>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
          如何独立核对这份结果
        </summary>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-500">
          <li>
            · 用区块浏览器打开合约{" "}
            <span className="break-all font-mono text-slate-600">{address}</span>，直接调用{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
              results()
            </code>
            ，得到的票数应当与导出的文件逐项相同。
          </li>
          <li>
            · 活动记录里每一行都带区块高度与交易哈希，可以在区块浏览器上逐条查证——
            票数不是「统计出来的」，是这些交易累加出来的。
          </li>
          <li>
            · 导出的 JSON 里也附带了当时索引的比对结果。索引是可重建的缓存，
            它若与链上不一致，链上的数字才是准的。
          </li>
        </ul>
      </details>
    </section>
  );
}
