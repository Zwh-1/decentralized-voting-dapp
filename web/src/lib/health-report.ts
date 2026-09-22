// SPDX-License-Identifier: MIT
import type { HealthResponse } from "./types";

/**
 * Turning a `/api/health` payload into the rows the UI shows.
 *
 * A pure function in `lib/`, not logic inside the component, for the same
 * reason `ballot-reasons.ts` and `admin-labels.ts` are pure: `web/test/**`
 * cannot import React components (`ERR_MODULE_NOT_FOUND`), so anything that
 * lives in the component is untestable here. See ADR-0027.
 *
 * The point of the panel this feeds is that `/api/health` already computes
 * `lagBlocks` and `indexError`, and nothing rendered them — so a deployment
 * whose index was down looked identical to one that was healthy. These rows are
 * the difference between a value existing and a reader being able to see it.
 */

export interface HealthRow {
  label: string;
  value: string;
  /** `warn` renders as an actual problem; `muted` as "not applicable here". */
  tone: "normal" | "muted" | "warn";
}

/**
 * Renders one lag figure.
 *
 * `null` is not zero and must not be printed as one. It means this deployment
 * cannot answer the question — no index exists, or its cursor was unreadable —
 * and "—" with an explanation is the honest rendering. See ADR-0015.
 */
export function lagLabel(lagBlocks: string | null): { value: string; tone: HealthRow["tone"] } {
  if (lagBlocks === null) {
    return { value: "不适用", tone: "muted" };
  }

  // A lag of "0" is healthy and should not be dressed up as a warning, and any
  // non-zero lag is normal operation rather than an error: the indexer is
  // *expected* to trail by the confirmation count.
  return { value: `${lagBlocks} 个区块`, tone: "normal" };
}

/**
 * Builds the rows for one health response.
 *
 * Every row is produced here, including the uninteresting ones, so the panel
 * never decides what to show: it renders this array in order. A missing row is
 * therefore a decision made in a tested function rather than a condition in
 * JSX that no test reaches.
 */
export function healthRows(health: HealthResponse): HealthRow[] {
  const lag = lagLabel(health.lagBlocks);

  const rows: HealthRow[] = [
    {
      label: "状态",
      value: health.status === "ok" ? "正常" : "降级",
      tone: health.status === "ok" ? "normal" : "warn",
    },
    { label: "链 ID", value: String(health.chainId), tone: "normal" },
    { label: "工厂合约", value: health.contract, tone: "normal" },
    {
      label: "投票数量",
      // Null means the chain could not be read. Reporting 0 would claim "no
      // polls exist", which is a different and false statement.
      value: health.pollCount === null ? "链上读取失败" : String(health.pollCount),
      tone: health.pollCount === null ? "warn" : "normal",
    },
    { label: "确认区块数", value: String(health.confirmations), tone: "normal" },
    {
      label: "索引已配置",
      value: health.indexConfigured ? "是" : "否",
      tone: health.indexConfigured ? "normal" : "muted",
    },
    {
      label: "后台索引循环",
      value: health.indexerLoopEnabled ? "运行中" : "未运行",
      // Not running is only worth flagging when an index exists to advance;
      // without one, it is the correct state rather than a problem.
      tone: health.indexerLoopEnabled ? "normal" : health.indexConfigured ? "warn" : "muted",
    },
    {
      label: "已索引高度",
      value: health.lastIndexedBlock ?? "无",
      tone: health.lastIndexedBlock === null ? "muted" : "normal",
    },
    {
      label: "链上高度",
      value: health.chainHead ?? "读取失败",
      tone: health.chainHead === null ? "warn" : "normal",
    },
    { label: "落后区块", value: lag.value, tone: lag.tone },
  ];

  // Only present when there is something to say, and never folded into a
  // count: ADR-0012 requires a failure to name the party that failed.
  if (health.indexError !== null) {
    rows.push({ label: "索引错误", value: health.indexError, tone: "warn" });
  }

  return rows;
}
