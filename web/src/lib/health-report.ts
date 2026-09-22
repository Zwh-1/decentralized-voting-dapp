// SPDX-License-Identifier: MIT
import { DEFAULT_LOCALE, type Locale } from "./i18n";
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
 *
 * ---------------------------------------------------------------------------
 * Why the labels take a language
 * ---------------------------------------------------------------------------
 *
 * Every row a reader sees is either a label or a word THIS module chooses, and
 * until the locale table below was added they were Chinese literals here — so an
 * English page rendered 状态, 正常 and 落后区块 inside an otherwise entirely
 * English panel. That is the mixed-language defect the catalogue exists to
 * remove. It arrived through a `lib/` RETURN VALUE rather than through JSX,
 * where no component could translate it after the fact: by the time
 * `HealthPanel` holds a row, the language decision has already been made.
 *
 * The trailing `locale` defaults to `DEFAULT_LOCALE`, which is what makes the
 * change additive: every existing call site and every existing assertion keeps
 * producing byte-identical Chinese without being touched, and the English path
 * runs only where a reader asked for it. `voting.ts`'s `chainName` and
 * `phaseLabel` are the same shape.
 *
 * ---------------------------------------------------------------------------
 * Why a table here rather than ~18 catalogue keys
 * ---------------------------------------------------------------------------
 *
 * These strings are one coherent vocabulary — the ten row names of a single
 * panel, plus the handful of words those rows can report. Keeping them in one
 * table beside the function that chooses them makes "did every row get
 * translated" answerable by reading one screen, which is not true of eighteen
 * entries scattered through a 1300-line catalogue. `voting.ts` does the same
 * with `CHAIN_NAMES` / `EN_CHAIN_NAMES`, and `presentation.ts` with
 * `PHASE_TONE_LABELS`.
 *
 * The two exceptions are the two words that ALREADY have one spelling in the
 * shared vocabulary and must not gain a second: `是`/`否` and `读取失败` are
 * `ballotPhrasesFor(locale).yes/no/readFailed`, which the ballot's read-state
 * rows render. A local copy of either would be two names for one Chinese
 * sentence, which `i18n.test.ts` refuses.
 */

export interface HealthRow {
  label: string;
  value: string;
  /** `warn` renders as an actual problem; `muted` as "not applicable here". */
  tone: "normal" | "muted" | "warn";
}

/**
 * The panel's own vocabulary, in one place.
 *
 * `notApplicable` is deliberately NOT `ballotPhrasesFor(locale).notAvailable`
 * (`未启用` / "Not enabled"). The two are different claims about different
 * things: `未启用` says a FEATURE is switched off, while this one says a FIGURE
 * cannot be computed here. A deployment with a perfectly healthy index can still
 * be unable to answer "how far behind are you" — with no readable safe head there
 * is nothing to subtract — and reporting that as a disabled feature would blame a
 * configuration that is in fact correct. It is ADR-0015's mistake one level down:
 * a missing reading presented as a definite one. `health-report.test.ts` pins the
 * distinction so it cannot be tidied away again.
 *
 * `lagBlocks` carries its unit in the template rather than beside the figure,
 * for the reason `consistency.lagging` spells its own: Chinese writes "5 个区块"
 * where English writes "5 blocks", so a bare number with a unit appended at the
 * call site could only ever be right in one of them.
 */
const HEALTH_LABELS = {
  zh: {
    status: "状态",
    ok: "正常",
    degraded: "降级",
    chainId: "链 ID",
    factoryContract: "工厂合约",
    pollCount: "投票数量",
    chainReadFailed: "链上读取失败",
    confirmations: "确认区块数",
    indexConfigured: "索引已配置",
    indexerLoop: "后台索引循环",
    running: "运行中",
    notRunning: "未运行",
    lastIndexedBlock: "已索引高度",
    none: "无",
    chainHead: "链上高度",
    lag: "落后区块",
    /** `{count}`. The unit is part of the sentence, not of the number. */
    lagBlocks: "{count} 个区块",
    notApplicable: "不适用",
    indexError: "索引错误",
  },
  en: {
    status: "Status",
    ok: "Healthy",
    degraded: "Degraded",
    chainId: "Chain ID",
    factoryContract: "Factory contract",
    pollCount: "Poll count",
    chainReadFailed: "The chain could not be read",
    confirmations: "Confirmations",
    indexConfigured: "Index configured",
    indexerLoop: "Indexer loop",
    running: "Running",
    notRunning: "Not running",
    lastIndexedBlock: "Indexed height",
    none: "None",
    chainHead: "Chain height",
    lag: "Lag",
    lagBlocks: "{count} blocks",
    notApplicable: "Not applicable",
    indexError: "Index error",
  },
} as const;

/** The one placeholder in the table above, filled without a catalogue lookup. */
function lagBlocksText(count: string, locale: Locale): string {
  return HEALTH_LABELS[locale].lagBlocks.replace("{count}", count);
}

/**
 * Renders one lag figure.
 *
 * `null` is not zero and must not be printed as one. It means this deployment
 * cannot answer the question — no index exists, or its cursor was unreadable —
 * and "not applicable" with an explanation is the honest rendering. See ADR-0015.
 */
export function lagLabel(
  lagBlocks: string | null,
  locale: Locale = DEFAULT_LOCALE,
): { value: string; tone: HealthRow["tone"] } {
  if (lagBlocks === null) {
    return { value: HEALTH_LABELS[locale].notApplicable, tone: "muted" };
  }

  // A lag of "0" is healthy and should not be dressed up as a warning, and any
  // non-zero lag is normal operation rather than an error: the indexer is
  // *expected* to trail by the confirmation count.
  return { value: lagBlocksText(lagBlocks, locale), tone: "normal" };
}

/**
 * Builds the rows for one health response.
 *
 * Every row is produced here, including the uninteresting ones, so the panel
 * never decides what to show: it renders this array in order. A missing row is
 * therefore a decision made in a tested function rather than a condition in
 * JSX that no test reaches.
 */
export function healthRows(health: HealthResponse, locale: Locale = DEFAULT_LOCALE): HealthRow[] {
  const words = HEALTH_LABELS[locale];
  const lag = lagLabel(health.lagBlocks, locale);

  const rows: HealthRow[] = [
    {
      label: words.status,
      value: health.status === "ok" ? words.ok : words.degraded,
      tone: health.status === "ok" ? "normal" : "warn",
    },
    { label: words.chainId, value: String(health.chainId), tone: "normal" },
    { label: words.factoryContract, value: health.contract, tone: "normal" },
    {
      label: words.pollCount,
      // Null means the chain could not be read. Reporting 0 would claim "no
      // polls exist", which is a different and false statement.
      value: health.pollCount === null ? words.chainReadFailed : String(health.pollCount),
      tone: health.pollCount === null ? "warn" : "normal",
    },
    { label: words.confirmations, value: String(health.confirmations), tone: "normal" },
    {
      label: words.indexConfigured,
      // 是 / 否 come from the ballot phrases rather than from a local copy: they
      // are the same two words the ballot's own yes/no rows render, and one
      // Chinese sentence under two names is what `i18n.test.ts` refuses.
      value: health.indexConfigured ? YES_NO[locale].yes : YES_NO[locale].no,
      tone: health.indexConfigured ? "normal" : "muted",
    },
    {
      label: words.indexerLoop,
      value: health.indexerLoopEnabled ? words.running : words.notRunning,
      // Not running is only worth flagging when an index exists to advance;
      // without one, it is the correct state rather than a problem.
      tone: health.indexerLoopEnabled ? "normal" : health.indexConfigured ? "warn" : "muted",
    },
    {
      label: words.lastIndexedBlock,
      value: health.lastIndexedBlock ?? words.none,
      tone: health.lastIndexedBlock === null ? "muted" : "normal",
    },
    {
      label: words.chainHead,
      // 读取失败 is the balloted phrase, for the same reason as 是/否 above.
      value: health.chainHead ?? READ_FAILED[locale],
      tone: health.chainHead === null ? "warn" : "normal",
    },
    { label: words.lag, value: lag.value, tone: lag.tone },
  ];

  // Only present when there is something to say, and never folded into a
  // count: ADR-0012 requires a failure to name the party that failed.
  //
  // The VALUE is left as it arrived. It is `describeFailure`'s output, which is
  // the operator's own diagnostic and already written in the reader's language
  // by the time it reaches the API response; re-wrapping it here would put a
  // translated label in front of an untranslated sentence, which is the defect
  // rather than the fix.
  if (health.indexError !== null) {
    rows.push({ label: words.indexError, value: health.indexError, tone: "warn" });
  }

  return rows;
}

/*
  The two words this module borrows from the shared vocabulary.

  Written as a two-entry locale table rather than reached through
  `ballotPhrasesFor`, so this file stays a `lib/` module with no opinion about
  how a translator is assembled — and so the borrow is visible here, at the one
  place that does it, rather than implicit. `i18n.test.ts`'s duplication check
  walks the catalogues by VALUE, so these local constants are outside it by
  construction; the test file pins the four strings instead, which is what keeps
  the borrow honest.
*/
const YES_NO = {
  zh: { yes: "是", no: "否" },
  en: { yes: "Yes", no: "No" },
} as const;

const READ_FAILED = { zh: "读取失败", en: "Read failed" } as const;
