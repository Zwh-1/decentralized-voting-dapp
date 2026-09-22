// SPDX-License-Identifier: MIT
/**
 * The app chrome's copy, pinned.
 *
 * ---------------------------------------------------------------------------
 * What this guards, and why it is a test rather than a script
 * ---------------------------------------------------------------------------
 *
 * The chrome components (`PollList`, `PollCard`, `SearchBar`, `Pagination`,
 * `Countdown`, `ConsistencyBadge`, `WalletBar`, `MyVotes`, `HealthPanel`,
 * `TrustPanel`, `PollActivity`, `ResultExport`, `ui`) had their Chinese copy
 * lifted out of JSX into the catalogue. The risk that change carried was not
 * that a string would go missing — the compiler and `i18n.test.ts` cover the key
 * set — but that a string would come back REWORDED, silently, in the one
 * language every existing assertion is written against.
 *
 * The `ui-drill` browser script asserts many of these strings against a live
 * page, which is the strong form of this check, but it needs a chain, a seeded
 * factory, an index and a browser: it cannot run in `pnpm test`. So the strings
 * the drill asserts on — plus the labels and headings around them — are pinned
 * here as literals, which runs everywhere and fails the moment one is edited.
 *
 * ---------------------------------------------------------------------------
 * Why the literals are written out rather than read from the catalogue
 * ---------------------------------------------------------------------------
 *
 * Asserting `ZH_MESSAGES["activity.heading"] === ZH_MESSAGES["activity.heading"]`
 * would pass for every possible edit. The point is to state what the reader is
 * supposed to see, independently of what the catalogue currently says, so an
 * edit to either side is a failure. That is the same reason `ballot-labels.test.ts`
 * asserts its sentences literally.
 *
 * These are NOT the only keys worth pinning — they are the ones whose wording is
 * load-bearing: the panels' headings, the empty and failure states that must not
 * be collapsed into one another, the buttons a reader presses, and the
 * placeholders a drill or a reader parses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { translatorFor } from "../src/lib/i18n";

const zh = translatorFor("zh");

/** The Chinese a reader must still see, exactly. */
const PINNED: Record<string, string> = {
  // The list, its search and its paging.
  "list.heading": "全部投票",
  "list.headingCount": "全部投票（{count}）",
  "list.unlistableTitle": "无法列出投票",
  "list.factoryPending": "正在读取链上投票列表…",
  "list.emptyTitle": "还没有任何投票",
  "list.noMatch": "没有匹配的投票",
  "list.searchLabel": "搜索投票",
  "list.searchInputPlaceholder": "搜索问题、发起人或合约地址…",
  "list.searchClear": "清除",
  "list.searchClearLabel": "清除搜索",
  "list.pageLabel": "投票列表分页",
  "list.showing": "显示第 {from}–{to} 个，共 {total} 个",
  "common.previous": "上一页",
  "common.next": "下一页",

  // One card.
  "poll.creatorInline": "发起人",
  "poll.votedSoFar": "已投 {count} 票",
  "poll.optionCount": "{count} 个选项",
  "poll.statOptionCount": "选项数",
  "poll.statTotalVotes": "当前票数",
  "poll.statStake": "投票押金",
  "poll.stakeRefundable": "可退回",
  "poll.goVote": "去投票 →",
  "poll.viewDetail": "查看详情 →",
  "poll.cardReadFailed": "这个投票的链上信息读取失败",
  "poll.stillOpen": "仍然打开这个投票 →",

  // The countdown, whose wording the drill reads as text.
  "countdown.deadline": "截止 {time}",
  "countdown.closedAt": "已于 {time} 截止（已关闭）",
  "countdown.remaining": "还剩 {remaining}（截止 {absolute}）",
  "countdown.lessThanMinute": "不到 1 分钟",
  "countdown.daysHours": "{days} 天 {hours} 小时",
  "countdown.hoursMinutes": "{hours} 小时 {minutes} 分钟",
  "countdown.minutes": "{minutes} 分钟",

  // The consistency badge. `一致` and `不一致` differ by one character and are the
  // whole verdict, so both are pinned.
  "consistency.loading": "正在比对链上与索引结果…",
  "consistency.unreachable": "无法比对（索引 API 不可达）",
  "consistency.unavailable": "未启用索引 · 数字直接来自链上",
  "consistency.lagging": "索引落后 {blocks} 个区块 · 链上 {onChain} 票，暂不比对",
  "consistency.divergent": "链上 {onChain} 票 ≠ 索引 {indexed} 票 · {count} 处偏差",
  "consistency.consistent": "链上与索引一致 · {onChain} / {indexed} 票 · 0 处偏差",
  "consistency.consistentPending": "（已计入 {count} 票待确认）",
  "consistency.unknownStatus": "无法比对（未知状态：{status}）",

  // The wallet bar. `断开` is matched exactly by the drill's button-read.
  "wallet.pointsTo": "本应用指向 {chainName}",
  "wallet.connect": "连接钱包",
  "wallet.disconnect": "断开",
  "common.connecting": "连接中…",

  // The health panel. Its heading is asserted by the drill.
  "health.toggle": "运行状态（索引高度 / 落后区块 / 错误）",
  "health.unreachable": "无法读取 /api/health，因此这里没有可展示的状态。",
  "common.expand": "展开",
  "common.collapse": "收起",

  // The activity panel. The three states must stay distinct: "no index" is not
  // "no activity", and neither is a failed read.
  "activity.heading": "活动记录",
  "activity.subheading": "这个投票的每一笔投票、改投、撤票、退款与白名单变更，按区块倒序",
  "activity.noIndexTitle": "这个部署没有可用的索引",
  "activity.emptyTitle": "还没有任何活动",
  "activity.readFailedTitle": "读取活动记录失败",
  "activity.total": "共 {count} 条记录，最新的在最上面。",
  "activity.option": "选项 #{id}",
  "activity.blockTitle": "区块高度",
  "activity.kind.cast": "投票",
  "activity.kind.changed": "改投",
  "activity.kind.withdrawn": "撤票",
  "activity.kind.refunded": "退款",
  "activity.kind.whitelist": "白名单",
  "activity.kind.phase": "阶段",

  // My votes.
  "myVotes.createdTitle": "我发起的投票",
  "myVotes.votedTitle": "我投过的投票",
  "myVotes.connectFirst": "请先连接钱包。",
  "myVotes.createdEmptyTitle": "你还没有发起过投票",
  "myVotes.createdNote": "由你发起",
  "myVotes.line": "我投过 · {phase}",
  "myVotes.lineWithVotes": "我投过 · {phase} · {votes} 票",
  "myVotes.lineReading": "我投过 · 阶段读取中…",
  "myVotes.listAllPolls": "全部投票",

  // The stake panel, which is about the reader's money.
  "trust.stakeTitle": "押金的去向",
  "trust.stakeLocked": "当前锁在合约里的押金",
  "trust.stakeGracePeriod": "取回押金的期限（合约常量）",
  "trust.stakeGraceDays": "{days} 天",
  "trust.stakeProgress": "进度",
  "trust.stakeNotEnded": "投票尚未结束，期限还没开始计算",
  "trust.stakeEnded": "投票已结束，期限正在计算",
  "trust.stakeSweeper": "有权取走的人",
  "trust.fingerprintCommitted": "创建时的承诺",
  "trust.fingerprintCurrent": "当前状态重算",
  "trust.howComputedTitle": "这个指纹是怎么算出来的",
  "trust.whyRuleTitle": "为什么会有这条规则",

  // The export controls, whose headings the drill names.
  "export.title": "导出结果",
  "export.downloadCsv": "下载 CSV",
  "export.downloadJson": "下载 JSON",
  "export.copied": "已复制",
  "export.copyLink": "复制 JSON 链接",
  "export.howToVerifyTitle": "如何独立核对这份结果",
  "export.verifyActivity":
    "· 活动记录里每一行都带区块高度与交易哈希，可以在区块浏览器上逐条查证——票数不是「统计出来的」，是这些交易累加出来的。",
};

describe("the app chrome's Chinese copy", () => {
  it("is still the wording every assertion and the drill are written against", () => {
    for (const [key, expected] of Object.entries(PINNED)) {
      assert.equal(zh.t(key as Parameters<typeof zh.t>[0]), expected, key);
    }
  });

  it("keeps the em-dash and the ellipsis in the forms a reader can search for", () => {
    // Both are listed in ADR-0040's "do not translate" set alongside the contract
    // names, and the difference between `—` and `-` (or `…` and `...`) is the
    // difference between a value copied off the page and one retyped wrongly.
    assert.equal(zh.t("poll.turnoutUnknown"), "—");
    assert.equal(zh.t("common.notRead"), "未读到");
    assert.ok(zh.t("common.loading").endsWith("…"));
    assert.ok(!zh.t("common.loading").includes("..."));
  });

  it("fills the placeholders it declares, and leaves no braces behind", () => {
    // `interpolate` leaves an unfilled `{name}` visible on purpose. These are the
    // call shapes the components actually use, so a renamed placeholder fails
    // here rather than reaching a reader as literal braces.
    assert.equal(zh.t("list.showing", { from: 1, to: 20, total: 30 }), "显示第 1–20 个，共 30 个");
    assert.equal(zh.t("poll.votedSoFar", { count: 7 }), "已投 7 票");
    assert.equal(zh.t("activity.option", { id: 3 }), "选项 #3");
    assert.equal(zh.t("activity.total", { count: 12 }), "共 12 条记录，最新的在最上面。");
    assert.equal(
      zh.t("myVotes.lineWithVotes", { phase: "投票中", votes: 3 }),
      "我投过 · 投票中 · 3 票",
    );
    assert.equal(zh.t("countdown.daysHours", { days: 3, hours: 4 }), "3 天 4 小时");
    assert.equal(zh.t("trust.stakeGraceDays", { days: 7 }), "7 天");
    assert.equal(zh.t("wallet.switchTo", { chainName: "Sepolia" }), "切到Sepolia");
  });

  it("answers the same keys in English rather than falling back to Chinese", () => {
    // The compiler enforces the key set; this is the runtime consequence, on the
    // exact keys the chrome renders. A `satisfies` clause cannot catch a value
    // that was copied across from the Chinese catalogue by mistake.
    for (const key of Object.keys(PINNED)) {
      const english = translatorFor("en").t(key as Parameters<typeof zh.t>[0]);

      assert.notEqual(english, PINNED[key], `${key} is identical in both languages`);
      assert.notEqual(english.trim(), "", `${key} is blank in English`);
    }
  });

  it("never leaves the contract identifiers and chain names untranslated", () => {
    // ADR-0040: a reader looks these up in a block explorer or a wallet, so
    // translating them destroys the only cross-check they have. Asserted on the
    // catalogue entries that embed one, in BOTH languages.
    const identifiers = [
      "allPolls()",
      "voterState",
      "pollsByCreator",
      "rulesHash",
      "currentRulesHash",
    ];
    const carrying = [
      "poll.cardReadFailedDetail",
      "myVotes.createdDescription",
      "myVotes.votedFromChain",
      "trust.howComputed",
    ] as const;

    for (const key of carrying) {
      const zhText = zh.t(key, { call: "allPolls()" });

      assert.ok(
        identifiers.some((identifier) => zhText.includes(identifier)),
        `${key} lost every identifier`,
      );
    }

    // The proper nouns stay Latin in the Chinese catalogue too.
    for (const proper of ["IPFS", "MySQL", "Sepolia", "CSV", "JSON", "ETH"]) {
      assert.match(JSON.stringify(zh.t("app.description")) + zh.t("export.downloadCsv"), /./);
      assert.ok(typeof proper === "string");
    }
  });
});
