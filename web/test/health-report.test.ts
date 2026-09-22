// SPDX-License-Identifier: MIT
/**
 * The health panel's decisions, tested without a browser.
 *
 * `/api/health` computed `lagBlocks` and `indexError` and nothing rendered them,
 * so a deployment with a broken index looked exactly like a healthy one. These
 * tests cover the rendering rules that make that visible — and, more
 * importantly, the cases where the honest answer is "this deployment cannot say"
 * rather than a number.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { healthRows, lagLabel } from "../src/lib/health-report";
import type { HealthResponse } from "../src/lib/types";

const FACTORY = "0xc6c080938113b7b069d9ba64a2d9c062399a22b2";

/** A healthy deployment, with each test overriding only the field it is about. */
function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "ok",
    chainId: 11155111,
    contract: FACTORY,
    pollCount: 3,
    confirmations: 5,
    indexConfigured: true,
    indexerLoopEnabled: true,
    lastIndexedBlock: "11754500",
    chainHead: "11754505",
    lagBlocks: "5",
    indexError: null,
    ...overrides,
  };
}

function rowValue(rows: ReturnType<typeof healthRows>, label: string): string {
  const row = rows.find((candidate) => candidate.label === label);

  assert.ok(row !== undefined, `expected a row labelled ${label}`);

  return row.value;
}

describe("lagLabel", () => {
  it("reports a real lag as a block count", () => {
    assert.deepEqual(lagLabel("5"), { value: "5 个区块", tone: "normal" });
  });

  it("treats zero lag as healthy rather than as a problem", () => {
    // A caught-up indexer is the goal, not a warning worth colouring.
    assert.deepEqual(lagLabel("0"), { value: "0 个区块", tone: "normal" });
  });

  it("never renders null as a number", () => {
    // Null means "this deployment cannot answer", which is a different claim
    // from "the lag is zero". Printing 0 here would invent a healthy reading
    // out of a missing one — the exact mistake ADR-0015 exists to prevent.
    const result = lagLabel(null);

    assert.equal(result.value, "不适用");
    assert.equal(result.tone, "muted");
  });
});

describe("healthRows", () => {
  it("names the chain, the factory and every count", () => {
    const rows = healthRows(health());

    assert.equal(rowValue(rows, "状态"), "正常");
    assert.equal(rowValue(rows, "链 ID"), "11155111");
    assert.equal(rowValue(rows, "工厂合约"), FACTORY);
    assert.equal(rowValue(rows, "投票数量"), "3");
    assert.equal(rowValue(rows, "确认区块数"), "5");
  });

  it("marks a degraded status as a warning", () => {
    const rows = healthRows(health({ status: "degraded" }));
    const status = rows.find((row) => row.label === "状态");

    assert.equal(status?.value, "降级");
    assert.equal(status?.tone, "warn");
  });

  it("distinguishes an unreadable chain from an empty one", () => {
    // `pollCount: null` means the read failed. Rendering it as 0 would claim
    // "no polls exist", which the response does not say.
    const rows = healthRows(health({ pollCount: null, chainHead: null }));

    assert.equal(rowValue(rows, "投票数量"), "链上读取失败");
    assert.equal(rowValue(rows, "链上高度"), "读取失败");
  });

  it("separates a configured index from a running loop", () => {
    // ADR-0015's pair: `INDEXER_ENABLED` defaults to true, so a loop that has
    // no database to advance would otherwise report itself as running.
    const idle = healthRows(health({ indexConfigured: true, indexerLoopEnabled: false }));
    const running = healthRows(health({ indexConfigured: true, indexerLoopEnabled: true }));

    assert.equal(rowValue(idle, "后台索引循环"), "未运行");
    assert.equal(rowValue(running, "后台索引循环"), "运行中");
  });

  it("does not flag a stopped loop when there is no index to advance", () => {
    const rows = healthRows(
      health({
        indexConfigured: false,
        indexerLoopEnabled: false,
        lastIndexedBlock: null,
        lagBlocks: null,
      }),
    );

    const loop = rows.find((row) => row.label === "后台索引循环");

    // Correct state, not a defect: with no database configured there is nothing
    // the loop could be doing.
    assert.equal(loop?.tone, "muted");
    assert.equal(rowValue(rows, "索引已配置"), "否");
    assert.equal(rowValue(rows, "已索引高度"), "无");
  });

  it("omits the index error row entirely when there is no error", () => {
    const rows = healthRows(health());

    assert.equal(
      rows.some((row) => row.label === "索引错误"),
      false,
      "a healthy response must not render an empty error row",
    );
  });

  it("shows the index error when one exists, as a warning", () => {
    const rows = healthRows(health({ indexError: "mysql: 连接被拒绝" }));
    const error = rows.find((row) => row.label === "索引错误");

    assert.equal(error?.value, "mysql: 连接被拒绝");
    assert.equal(error?.tone, "warn");
  });

  it("renders every row in a stable order", () => {
    // The panel renders this array as-is, so adding a field must not reorder
    // what a reader already learned to scan.
    const labels = healthRows(health()).map((row) => row.label);

    assert.deepEqual(labels, [
      "状态",
      "链 ID",
      "工厂合约",
      "投票数量",
      "确认区块数",
      "索引已配置",
      "后台索引循环",
      "已索引高度",
      "链上高度",
      "落后区块",
    ]);
  });
});

/**
 * The language checks.
 *
 * ---------------------------------------------------------------------------
 * Why this block exists at all
 * ---------------------------------------------------------------------------
 *
 * Two reviewers independently found that nothing here asserted the panel was
 * translated. Every other test in this file pins the DEFAULT-locale output, so
 * they pass whether or not `healthRows` consults a locale at all — the panel
 * could have stayed Chinese-only on English pages with the whole suite green.
 * A test that passes for both the correct and the broken implementation is not
 * coverage, so this closes that specifically rather than by adding another
 * default-locale assertion.
 */
describe("healthRows in English", () => {
  it("translates every row label", () => {
    const rows = healthRows(health(), "en");

    // Asserted as a whole list, not one spot check: a single translated row
    // proves a locale parameter exists, not that all ten use it.
    assert.deepEqual(
      rows.map((row) => row.label),
      [
        "Status",
        "Chain ID",
        "Factory contract",
        "Poll count",
        "Confirmations",
        "Index configured",
        "Indexer loop",
        "Indexed height",
        "Chain height",
        "Lag",
      ],
    );
  });

  it("translates the values that are words rather than data", () => {
    const rows = healthRows(health(), "en");

    // "Healthy" rather than "OK": the Chinese pair is 正常 / 降级, two parallel
    // adjectives, and an English pair of "OK" / "Degraded" mixes an initialism
    // with an adjective. The catalogue is the place to be faithful to the source
    // pairing rather than to the shortest rendering of it.
    assert.equal(rowValue(rows, "Status"), "Healthy");
    assert.equal(rowValue(rows, "Index configured"), "Yes");
    assert.equal(rowValue(rows, "Indexer loop"), "Running");
    assert.equal(rowValue(rows, "Lag"), "5 blocks");
  });

  it("leaves the values that are data alone", () => {
    const rows = healthRows(health(), "en");

    // The factory address and the chain id are the same in every language, and
    // translating them would break the copy-paste a reader uses to check them.
    assert.equal(rowValue(rows, "Factory contract"), FACTORY);
    assert.equal(rowValue(rows, "Chain ID"), "11155111");
  });

  it("says 'not applicable' rather than 'not enabled' when a number cannot exist", () => {
    // These are two different claims and the panel must not conflate them: a
    // feature that is switched off is `未启用` / "Not enabled", while a number
    // this deployment cannot compute is `不适用` / "Not applicable". ADR-0015 is
    // the reason — inventing a reading out of a missing one is the failure this
    // whole panel exists to avoid.
    assert.equal(lagLabel(null, "en").value, "Not applicable");
    assert.equal(lagLabel(null).value, "不适用");
  });

  it("returns a different string per language, so the parameter is load-bearing", () => {
    const zh = healthRows(health(), "zh").map((row) => row.label);
    const en = healthRows(health(), "en").map((row) => row.label);

    // Guards the failure mode where someone "translates" by passing the locale
    // through and then reading the Chinese table anyway.
    assert.notDeepEqual(zh, en);
    assert.equal(zh.length, en.length, "both languages must describe the same rows");
  });
});
