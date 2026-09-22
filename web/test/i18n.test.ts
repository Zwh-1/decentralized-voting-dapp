// SPDX-License-Identifier: MIT
/**
 * Tests for the i18n core.
 *
 * The rules worth pinning are the two that decide what a reader sees when
 * something is wrong: a missing placeholder must stay VISIBLE, and a missing
 * translation must not be renderable at all. Both are the same principle this
 * project applies to every other read — never present "I could not produce this"
 * as "here it is, empty" (ADR-0011).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EN_MESSAGES,
  ZH_MESSAGES,
  ballotPhrasesFor,
  interpolate,
  messagesFor,
  translatorFor,
} from "../src/lib/i18n";
import {
  DEFAULT_LOCALE,
  LOCALES,
  htmlLang,
  isLocale,
  localeFromCookieHeader,
  resolveLocale,
} from "../src/lib/i18n/locales";
import { EN_BALLOT_PHRASES, ZH_BALLOT_PHRASES } from "../src/lib/i18n/ballot-phrases";

describe("interpolate", () => {
  it("fills every placeholder it has a value for", () => {
    assert.equal(interpolate("{a} and {b}", { a: "1", b: "2" }), "1 and 2");
  });

  it("LEAVES an unfilled placeholder visible rather than blanking it", () => {
    // The rule this function exists for. Blanking would produce "1 and ", a
    // sentence that looks finished, is wrong, and gives the reader no way to
    // notice something was dropped.
    assert.equal(interpolate("{a} and {b}", { a: "1" }), "1 and {b}");
  });

  it("leaves everything alone when no values are given", () => {
    assert.equal(interpolate("{a} and {b}"), "{a} and {b}");
  });

  it("renders an explicit zero rather than treating it as missing", () => {
    // `0` is a value a caller may mean, and `{count}` with 0 must say "0".
    // A truthiness check here would leave `{count}` on screen instead.
    assert.equal(interpolate("count {count}", { count: 0 }), "count 0");
  });

  it("renders an explicit empty string rather than leaving the placeholder", () => {
    assert.equal(interpolate("x{value}y", { value: "" }), "xy");
  });

  it("replaces a repeated placeholder every time", () => {
    assert.equal(interpolate("{a}/{a}", { a: "z" }), "z/z");
  });

  it("ignores placeholders whose name is not a plain word", () => {
    // `{a-b}` is not a placeholder this syntax can express, so it is left as
    // written rather than half-substituted.
    assert.equal(interpolate("{a-b} {c}", { c: "1" }), "{a-b} 1");
  });

  it("does not treat a replacement value as a template", () => {
    // A value containing braces must not be re-scanned, or a poll question with
    // `{question}` in it would consume an unrelated parameter.
    assert.equal(interpolate("{a}", { a: "{b}", b: "no" }), "{b}");
  });
});

describe("locale parsing", () => {
  it("defaults to Chinese", () => {
    assert.equal(DEFAULT_LOCALE, "zh");
    assert.equal(resolveLocale(null), "zh");
    assert.equal(resolveLocale(undefined), "zh");
    assert.equal(resolveLocale(""), "zh");
  });

  it("accepts every language with a catalogue", () => {
    for (const locale of LOCALES) {
      assert.equal(isLocale(locale), true, locale);
      assert.equal(resolveLocale(locale), locale);
    }
  });

  it("falls back rather than throwing on an unrecognised language", () => {
    // Deliberately unlike the `?sort=` parser, which refuses. A bad language is a
    // READER state that the next click repairs, not a caller mistake worth
    // failing a page render over.
    assert.equal(resolveLocale("fr"), "zh");
    assert.equal(resolveLocale("zh-CN"), "zh", "a region tag is not a catalogue key");
    assert.equal(isLocale("ZH"), false, "case is part of the key");
  });

  it("maps each language to an html lang tag", () => {
    assert.equal(htmlLang("zh"), "zh-CN");
    assert.equal(htmlLang("en"), "en");
  });
});

describe("localeFromCookieHeader", () => {
  it("reads the language out of a cookie header", () => {
    assert.equal(localeFromCookieHeader("voting_locale=en"), "en");
  });

  it("finds it among other cookies", () => {
    assert.equal(localeFromCookieHeader("a=1; voting_locale=en; b=2"), "en");
  });

  it("defaults when the cookie is absent", () => {
    assert.equal(localeFromCookieHeader("a=1; b=2"), "zh");
    assert.equal(localeFromCookieHeader(null), "zh");
    assert.equal(localeFromCookieHeader(""), "zh");
  });

  it("matches the name EXACTLY, not as a prefix", () => {
    // A `startsWith` or `includes` check would let a cookie called
    // `voting_locale_backup` decide the language.
    assert.equal(localeFromCookieHeader("voting_locale_backup=en"), "zh");
    assert.equal(localeFromCookieHeader("x_voting_locale=en"), "zh");
  });

  it("decodes a percent-encoded value", () => {
    assert.equal(localeFromCookieHeader("voting_locale=e%6E"), "en");
  });

  it("ignores a value it does not recognise instead of failing the render", () => {
    assert.equal(localeFromCookieHeader("voting_locale=fr"), "zh");
  });

  it("survives a malformed percent-escape", () => {
    // `decodeURIComponent("%E0%A4%A")` throws. A page render must not.
    assert.equal(localeFromCookieHeader("voting_locale=%E0%A4%A"), "zh");
  });

  it("ignores a segment with no equals sign", () => {
    assert.equal(localeFromCookieHeader("garbage; voting_locale=en"), "en");
  });

  it("tolerates whitespace around the name and value", () => {
    assert.equal(localeFromCookieHeader("  voting_locale = en  "), "en");
  });
});

describe("the catalogue", () => {
  it("answers every key in both languages", () => {
    // The compile-time guarantee is that `EN_MESSAGES satisfies Messages`. This
    // checks the runtime consequence: no key renders as empty or undefined.
    for (const key of Object.keys(ZH_MESSAGES) as (keyof typeof ZH_MESSAGES)[]) {
      assert.equal(typeof ZH_MESSAGES[key], "string", `zh ${key}`);
      assert.equal(typeof EN_MESSAGES[key], "string", `en ${key}`);
      assert.notEqual(ZH_MESSAGES[key].trim(), "", `zh ${key} is blank`);
      assert.notEqual(EN_MESSAGES[key].trim(), "", `en ${key} is blank`);
    }
  });

  it("has the same key set in both languages", () => {
    assert.deepEqual(Object.keys(EN_MESSAGES).sort(), Object.keys(ZH_MESSAGES).sort());
  });

  it("returns the requested language", () => {
    assert.equal(messagesFor("en")["nav.polls"], "All polls");
    assert.equal(messagesFor("zh")["nav.polls"], "全部投票");
  });
});

describe("translatorFor", () => {
  it("translates a key in the requested language", () => {
    assert.equal(translatorFor("zh").t("nav.polls"), "全部投票");
    assert.equal(translatorFor("en").t("nav.polls"), "All polls");
  });

  it("defaults to Chinese, so existing call sites did not have to change", () => {
    assert.equal(translatorFor().locale, "zh");
    assert.equal(translatorFor().t("nav.polls"), "全部投票");
  });

  it("fills placeholders in a message", () => {
    assert.equal(translatorFor("en").t("common.pageOf", { page: 2, pageCount: 5 }), "Page 2 of 5");
  });

  it("exposes the ballot phrases for the same language", () => {
    assert.equal(translatorFor("en").ballot, EN_BALLOT_PHRASES);
    assert.equal(translatorFor("zh").ballot, ZH_BALLOT_PHRASES);
  });

  it("reports the language it was built for", () => {
    assert.equal(translatorFor("en").locale, "en");
  });
});

describe("the ballot phrase catalogue", () => {
  it("answers every phrase in both languages", () => {
    const keys = Object.keys(ZH_BALLOT_PHRASES) as (keyof typeof ZH_BALLOT_PHRASES)[];

    assert.ok(keys.length > 20, "the ballot has a large copy surface");

    for (const key of keys) {
      assert.equal(typeof ZH_BALLOT_PHRASES[key], "string", `zh ${key}`);
      assert.equal(typeof EN_BALLOT_PHRASES[key], "string", `en ${key}`);
      assert.notEqual(ZH_BALLOT_PHRASES[key].trim(), "", `zh ${key} is blank`);
      assert.notEqual(EN_BALLOT_PHRASES[key].trim(), "", `en ${key} is blank`);
    }
  });

  it("has the same phrase set in both languages", () => {
    assert.deepEqual(Object.keys(EN_BALLOT_PHRASES).sort(), Object.keys(ZH_BALLOT_PHRASES).sort());
  });

  it("never repeats the same sentence under two different names", () => {
    // Two names for one sentence is the duplicated-derivation pattern this repo
    // has been burned by: the day one is edited, the two promises diverge. The
    // one exception is deliberate and is listed here.
    const allowed = new Set<string>();

    for (const [name, text] of Object.entries(ZH_BALLOT_PHRASES)) {
      if (allowed.has(name)) continue;

      const twins = Object.entries(ZH_BALLOT_PHRASES)
        .filter(([other, value]) => other !== name && value === text)
        .map(([other]) => other);

      assert.deepEqual(twins, [], `${name} duplicates the text of ${twins.join(", ")}`);
    }
  });

  it("uses the documented placeholders and no others", () => {
    // `interpolate` leaves unknown placeholders visible, so a typo inside a
    // template would reach the reader as literal braces. Checking the set here
    // turns that into a test failure.
    //
    // This used to special-case `wrongNetwork` and assert every OTHER phrase had
    // none, which was true only while one phrase was parameterised. Now that the
    // balloted statements are here too, the expected set is declared explicitly:
    // a phrase that gains a placeholder without being listed fails, and a listed
    // phrase that loses one fails as well. The declaration is the second half of
    // the check rather than a hole in it.
    const expected: Record<string, string[]> = {
      // ---- the ballot phrases ----
      wrongNetwork: ["chainId", "chainName", "suffix"],
      candidateNumbered: ["id"],
      optionNumbered: ["id"],
      metadataGatewaysUnreachable: ["attempts"],
      metadataNoUsableDocument: ["answered", "attempts"],
      indexHeight: ["indexed", "safeHead"],
      chainHeadWithPending: ["head", "confirmations"],
      syncSynced: ["from", "to", "seen", "inserted"],
      syncRewound: ["block"],
      syncIdle: ["block"],

      // ---- the catalogue keys that predate this surface ----
      //
      // Declared here because both catalogues are walked below. They were
      // unchecked while the loop visited `ZH_BALLOT_PHRASES` only, which is the
      // gap this table exists to close rather than to preserve.
      "common.pageOf": ["page", "pageCount"],
      "language.switchTo": ["language"],
      "list.matchedOf": ["matched", "total"],
      "list.showing": ["from", "to", "total"],
      "list.scanTruncated": ["total", "limit"],
      "list.headingCount": ["count"],
      "list.searchNoMatch": ["query"],
      "list.noFactory": ["chainId", "chainName"],
      "list.connectedCount": ["count"],
      "list.noMatchDescription": ["query"],
      "myVotes.createdDescription": ["call"],
      "myVotes.noFactory": ["chainId", "chainName"],
      "myVotes.votedFromIndex": ["view"],
      "myVotes.votedFromChain": ["call"],
      "myVotes.scanTruncated": ["total", "limit", "link"],
      "myVotes.scanning": ["count"],
      "myVotes.line": ["phase"],
      "myVotes.lineWithVotes": ["phase", "votes"],
      "myVotes.currentAddress": ["address", "chainName", "chainId"],
      "poll.votedSoFar": ["count"],
      "poll.optionCount": ["count"],
      "poll.cardReadFailedDetail": ["call"],
      "ballot.serverReadFailedDetail": ["error"],
      "ballot.deadlinePassed": ["time"],
      "ballot.deadline": ["time"],
      "ballot.optionsCount": ["count"],
      "countdown.deadline": ["time"],
      "countdown.closedAt": ["time"],
      "countdown.remaining": ["remaining", "absolute"],
      "countdown.daysHours": ["days", "hours"],
      "countdown.hoursMinutes": ["hours", "minutes"],
      "countdown.minutes": ["minutes"],
      "consistency.lagging": ["blocks", "onChain"],
      "consistency.divergent": ["onChain", "indexed", "count"],
      "consistency.consistent": ["onChain", "indexed"],
      "consistency.consistentPending": ["count"],
      "consistency.unknownStatus": ["status"],
      "wallet.pointsTo": ["chainName"],
      "wallet.notConnected": ["chainName"],
      "wallet.switchTo": ["chainName"],
      "trust.howComputed": ["rulesHash", "currentRulesHash"],
      "trust.stakeGraceDays": ["days"],
      "trust.whyRule": ["refund", "sweep", "gracePeriod"],
      "activity.option": ["id"],
      "activity.total": ["count"],
      "export.verifyContract2": ["results"],

      // ---- the creation/admin surface's own parameters ----
      //
      // `{count}`, `{id}` and `{number}` are the same three shapes the ballot
      // phrases above already use, but declared per key: the point of this table
      // is that every parameterised sentence is named, so a new one cannot
      // arrive unnoticed.
      "admin.addressesFound": ["count"],
      "admin.addressesList": ["list"],
      "admin.optionCount": ["count"],
      "admin.optionLabel": ["id"],
      "admin.optionEditField": ["id"],
      "admin.reason.startTooFewOptions": ["min"],
      "admin.reason.noFactoryReason": ["chainId", "chainName"],
      "admin.reason.closeNoFactory": ["chainId", "chainName"],
      "admin.reason.whitelistTooMany": ["limit", "count"],
      "admin.reason.removeTooFew": ["count"],
      "admin.reason.sweepGracePeriod": ["time"],
      "create.optionsLabel": ["min"],
      "create.optionPlaceholderNumbered": ["number"],
      "create.cidSummary1": ["total", "cids"],
      "create.cidSummary2": ["raw"],
      "create.reason.noFactory": ["chainId", "chainName"],
      // `{min}` appears TWICE in this sentence ("fewer than {min} options"), and
      // the declaration lists it twice on purpose: the assertion compares the
      // matched placeholders occurrence by occurrence, so a declaration that
      // deduplicated would stop noticing a second placeholder being dropped.
      "create.reason.tooFewOptions": ["min", "min"],
      "template.switchConfirm": ["name"],
      "mechanism.multiSelect": ["count"],
      "execution.waiting": ["seconds"],

      // ---- the pages and components outside this surface ----
      "audit.indexRequired": ["databaseUrl"],
      "audit.indexHowTo": ["databaseUrl", "commands"],
      "audit.summary": ["count", "polls", "kind"],
      "audit.summaryKind": ["kind"],
      "notifications.readFailedHttp": ["status"],
      "notifications.indexRequired": ["databaseUrl"],
      "notifications.summary": ["count", "polls", "truncated"],
      "notifications.summaryTruncated": ["limit"],
      "notifications.block": ["block"],
      "notifications.auditLine": ["audit"],
      "home.listFailedDetail": ["envFile", "rpcUrl", "chainId", "exportAbi"],
      "home.auditLine": ["audit"],
      "home.notificationsLine": ["notifications"],
      "my.serverListFailed": ["error"],
      "shell.footerWhitelist": ["call"],
      "chart.caption": ["source", "total"],
      "chart.barValue": ["votes", "percent"],
      "chart.ariaNoOptions": ["source"],
      "chart.ariaNoVotes": ["message", "source"],
      "chart.ariaItem": ["label", "votes", "percent"],
      "chart.ariaBars": ["items", "total", "source"],
      "option.voteWithStake": ["amount"],
      "pollPage.invalidDetail": ["segment", "prefix", "received"],
      "pollPage.serverReadFailed": ["address", "error"],

      // ---- the library-level label tables ----
      //
      // These are the strings `lib/failure.ts` and `lib/poll-report.ts` return
      // rather than render, so they are catalogue keys like any other and their
      // placeholders are declared here. `lib/health-report.ts` is NOT included:
      // its rows are one panel's own vocabulary and live in a locale table in
      // that file, which this walk cannot see by construction.
      "failure.rpcUnreachable": ["call"],
      "failure.unexpectedNamed": ["name"],
      "failure.callSuffix": ["method"],
    };

    // Both catalogues are walked, not just the ballot's: the table above declares
    // keys from `Messages` as well (`create.*`, `admin.*`, `audit.*`, `chart.*`),
    // and a check that only visited the ballot phrases would leave every one of
    // those unverified while still looking like it covered them.
    const catalogues: [string, Record<string, string>][] = [
      ["ZH_BALLOT_PHRASES", { ...ZH_BALLOT_PHRASES }],
      ["ZH_MESSAGES", { ...ZH_MESSAGES }],
    ];

    for (const [catalogueName, catalogue] of catalogues) {
      for (const [name, text] of Object.entries(catalogue)) {
        const found = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

        assert.deepEqual(found, (expected[name] ?? []).slice().sort(), `${catalogueName} ${name}`);
      }
    }

    // And the declaration itself must not name a key that does not exist, which
    // would otherwise let a rename silently retire a check.
    for (const name of Object.keys(expected)) {
      assert.ok(
        name in ZH_BALLOT_PHRASES || name in ZH_MESSAGES,
        `${name} is declared but not in either catalogue`,
      );
    }
  });

  it("answers the same placeholder names in English as in Chinese", () => {
    for (const [name, text] of Object.entries(EN_BALLOT_PHRASES)) {
      const zhFound = [
        ...ZH_BALLOT_PHRASES[name as keyof typeof ZH_BALLOT_PHRASES].matchAll(/\{(\w+)\}/g),
      ]
        .map((match) => match[1])
        .sort();
      const enFound = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

      assert.deepEqual(enFound, zhFound, name);
    }
  });
});

describe("ballotPhrasesFor", () => {
  it("returns the catalogue for the language", () => {
    assert.equal(ballotPhrasesFor("en"), EN_BALLOT_PHRASES);
    assert.equal(ballotPhrasesFor("zh"), ZH_BALLOT_PHRASES);
  });
});

/**
 * The byte-identity guarantee for the i18n extraction.
 *
 * ---------------------------------------------------------------------------
 * Why this is a test rather than a script
 * ---------------------------------------------------------------------------
 *
 * Moving a string out of a component and into the catalogue is a pure refactor:
 * the reader must see exactly the same Chinese afterwards. The risk is not
 * theoretical — this repository's own notes record a component whose copy changed
 * meaning during a move, and `ui-drill` asserts on many of these exact strings, so
 * a silent rewording would surface as an unrelated-looking browser failure.
 *
 * This was first written as a one-off script that replayed the pre-change files
 * out of a temp snapshot and diffed text runs. It worked, but it could only run on
 * the machine that had made the snapshot, which is the definition of a check that
 * stops being run. The strings below are the ones the extraction actually moved,
 * pinned to their exact expected values: a rewording now fails here, in CI, with
 * the string named.
 */
describe("the extracted copy is byte-identical to what it replaced", () => {
  it("still renders the poll list's own sentences", () => {
    const t = translatorFor("zh");

    assert.equal(t.t("list.title"), "去中心化投票平台");
    assert.equal(t.t("list.empty"), "还没有任何投票。");
    assert.equal(t.t("list.noMatch"), "没有匹配的投票");
    assert.equal(t.t("list.searchPlaceholder"), "搜索问题或发起人地址");
    assert.equal(t.t("list.sort.newest"), "最新截止");
    assert.equal(t.t("list.sort.question"), "按问题");
  });

  it("still renders the shared chrome", () => {
    const t = translatorFor("zh");

    assert.equal(t.t("common.loading"), "读取中…");
    assert.equal(t.t("common.retry"), "重试");
    assert.equal(t.t("common.previous"), "上一页");
    assert.equal(t.t("common.next"), "下一页");
    assert.equal(t.t("common.back"), "返回");
    assert.equal(t.t("nav.polls"), "全部投票");
    assert.equal(t.t("nav.myVotes"), "我的投票");
    assert.equal(t.t("nav.audit"), "审计视图");
    assert.equal(t.t("language.label"), "语言");
  });

  it("still fills the paginated and counted sentences the same way", () => {
    const t = translatorFor("zh");

    // The placeholders are load-bearing here: assertion messages and the drill
    // both read these, so a changed separator or order is a real change.
    assert.equal(t.t("common.pageOf", { page: 2, pageCount: 5 }), "第 2 / 5 页");
    assert.equal(t.t("list.showing", { from: 1, to: 20, total: 57 }), "显示第 1–20 个，共 57 个");
    assert.equal(t.t("list.matchedOf", { matched: 3, total: 57 }), "匹配 3 / 57 个投票");
    assert.equal(
      t.t("list.scanTruncated", { total: 900, limit: 500 }),
      "链上共有 900 个投票，本页只扫描了最新的 500 个。",
    );
  });

  it("still renders the poll detail rows", () => {
    const t = translatorFor("zh");

    assert.equal(t.t("poll.question"), "问题");
    assert.equal(t.t("poll.creator"), "发起人");
    assert.equal(t.t("poll.endsAt"), "截止时间");
    assert.equal(t.t("poll.phase"), "阶段");
    assert.equal(t.t("poll.totalVotes"), "票数合计");
    assert.equal(t.t("poll.turnoutUnknown"), "—");
  });

  it("still renders the audit view", () => {
    const t = translatorFor("zh");

    assert.equal(t.t("audit.title"), "审计视图");
    assert.equal(t.t("audit.allKinds"), "全部");
    assert.equal(t.t("audit.kind"), "类型");
    assert.equal(t.t("audit.block"), "区块");
    assert.equal(t.t("audit.tx"), "交易");
  });

  it("keeps the ballot's read-state sentences exactly as they were", () => {
    // These are the sentences that decide whether the page is telling the truth
    // about a read it may not have completed, so they are pinned individually
    // rather than by shape.
    const p = ballotPhrasesFor("zh");

    assert.equal(p.readFailed, "读取失败");
    assert.equal(p.reading, "读取中…");
    assert.equal(p.nothing, "—");
    assert.equal(p.yes, "是");
    assert.equal(p.no, "否");
    assert.equal(p.notConnected, "未连接");
    assert.equal(p.notAvailable, "未启用");
    assert.equal(p.candidateNumbered, "候选人 #{id}");
    assert.equal(p.optionNumbered, "选项 #{id}");
    assert.equal(p.tallyFromIndex, "MySQL 索引");
    assert.equal(p.tallyFromChain, "链上直读");
  });

  it("keeps the write-failure sentences, which name the failing party", () => {
    const p = ballotPhrasesFor("zh");

    assert.equal(p.writeUserRejected, "你在钱包里拒绝了这笔交易，链上没有任何变化。");
    assert.equal(
      p.writeAlreadyPending,
      "你的钱包里已经有一个待处理的请求，请先在上面那个弹窗里处理完，再重试；链上没有任何变化。",
    );
    assert.equal(
      p.writeWrongChain,
      "钱包所在的网络与页面配置的网络不是同一条链，交易没有发出。请切换钱包网络后重试。",
    );
    assert.equal(
      p.writeInsufficientFunds,
      "钱包余额不足以支付押金和网络费，交易没有发出，链上没有任何变化。",
    );
  });
});
