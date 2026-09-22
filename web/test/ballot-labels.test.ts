// SPDX-License-Identifier: MIT

/**
 * The 合约状态 / 我的状态 panels must tell "we could not read it" apart from "the
 * answer is zero". These tests exist because the panel used to answer the second
 * while meaning the first: with the RPC endpoint unreachable the server-rendered
 * page announced `数据来源 链上直读` and `票数合计 0` / `候选人（0）`, none of which had
 * been established.
 *
 * The same rule had to be applied to the rows that describe *the reader's own
 * state*, which is where it costs money: 押金 rendered `0 ETH` from a `stakeOf`
 * read that had failed, and `sweepUnclaimed()` hands an unclaimed stake to the
 * owner once the grace period passes. 已投票 and 投给 answered from the same kind
 * of uncompleted request, and 白名单 said 读取中… forever once it errored.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chainHeadText,
  describeWriteFailure,
  indexHeightText,
  lagText,
  myStatusLabels,
  optionMetadataLabel,
  optionName,
  phaseText,
  readStatus,
  readText,
  syncSummary,
  tallyLabels,
  tallySourceLabel,
} from "../src/lib/ballot-labels";
import type { HealthResponse, SyncResponse } from "../src/lib/types";
// Named members rather than literals: these assertions used to hard-code 1 and 2,
// and inserting `Reveal` into the contract's enum turned `2` into the wrong
// phase without any test noticing it had stopped testing what it claimed.
import { PollPhase } from "../src/lib/contracts";
// The "no value" placeholder, read from the catalogue rather than written as a
// literal here, for the same reason.
import { ZH_BALLOT_PHRASES } from "../src/lib/i18n";

describe("tallyLabels", () => {
  it("never claims a source, a total or a count while the read is in flight", () => {
    const labels = tallyLabels({ isPending: true, isError: false, candidateCount: 0 });

    assert.equal(labels.source, "读取中…");
    assert.equal(labels.total, "—");
    assert.equal(labels.candidates, "—");
  });

  it("reports a failed read as a failure, not as a direct chain read", () => {
    // The exact defect: `source === "index" ? "MySQL 索引" : "链上直读"` sent every
    // non-index case, including a thrown request, to "链上直读".
    const labels = tallyLabels({ isPending: false, isError: true, candidateCount: 0 });

    assert.equal(labels.source, "读取失败");
    assert.notEqual(labels.source, "链上直读");
    assert.equal(labels.total, "—", "a failed read must not render as 0 votes");
    assert.equal(labels.candidates, "—", "a failed read must not render as 0 candidates");
  });

  it("names the index when the index answered, including a real zero", () => {
    const labels = tallyLabels({
      isPending: false,
      isError: false,
      source: "index",
      total: 0,
      candidateCount: 0,
    });

    assert.equal(labels.source, "MySQL 索引");
    assert.equal(labels.total, "0", "a real zero is still a number, unlike an unknown");
    assert.equal(labels.candidates, "0");
  });

  it("names the chain when the chain answered", () => {
    const labels = tallyLabels({
      isPending: false,
      isError: false,
      source: "chain",
      total: 200,
      candidateCount: 3,
    });

    assert.deepEqual(labels, { source: "链上直读", total: "200", candidates: "3" });
  });

  it("treats settled-but-dataless as unknown rather than as zero", () => {
    // Not pending, not errored, but no payload: TanStack can settle a query with
    // no data (e.g. an aborted fetch), and `source` is the field that proves a
    // real answer arrived.
    const labels = tallyLabels({ isPending: false, isError: false, candidateCount: 0 });

    assert.equal(labels.source, "读取中…");
    assert.equal(labels.total, "—");
    assert.equal(labels.candidates, "—");
  });

  it("prefers the error label when a query is both errored and refetching", () => {
    // A failed query that retries reports isPending and isError together; the
    // reader needs to know it failed, not that it is merely loading.
    const labels = tallyLabels({ isPending: true, isError: true, candidateCount: 0 });

    assert.equal(labels.source, "读取失败");
  });
});

describe("readStatus", () => {
  it("treats a successful read of zero as a real answer", () => {
    // `stakeOf` returns 0 for an address that never voted. That is a fact, not an
    // absence, and it is the only case where "you have nothing to reclaim" is true.
    assert.equal(readStatus(true, false), "ready");
    assert.equal(readStatus(true, true), "ready", "data wins over a stale error flag");
  });

  it("separates a failed read from one that is still loading", () => {
    assert.equal(readStatus(false, true), "failed");
    assert.equal(readStatus(false, false), "loading");
  });

  it("never reports a failed read as merely loading", () => {
    // The reason string shown to the user is picked from this value, so conflating
    // these two is what let a failed `stakeOf` become "没有可取回的押金。".
    assert.notEqual(readStatus(false, true), readStatus(false, false));
  });
});

describe("phaseText", () => {
  it("does not call a chain 未知 when no contract was ever queried", () => {
    assert.equal(phaseText({ contractKnown: false, status: "loading", phase: undefined }), "—");
    assert.equal(phaseText({ contractKnown: false, status: "failed", phase: undefined }), "—");
  });

  it("separates a failed phase read from one still in flight", () => {
    assert.equal(
      phaseText({ contractKnown: true, status: "failed", phase: undefined }),
      "读取失败",
    );
    assert.equal(
      phaseText({ contractKnown: true, status: "loading", phase: undefined }),
      "读取中…",
    );
  });

  it("names the phase once it has been read", () => {
    assert.equal(
      phaseText({ contractKnown: true, status: "ready", phase: PollPhase.Voting }),
      "投票中",
    );
    assert.equal(
      phaseText({ contractKnown: true, status: "ready", phase: PollPhase.Ended }),
      "已结束",
    );
  });

  it("still reports an unrecognised phase value rather than guessing", () => {
    assert.equal(phaseText({ contractKnown: true, status: "ready", phase: 7 }), "未知 (7)");
  });

  it("does not claim a phase from a ready status with no value", () => {
    assert.equal(phaseText({ contractKnown: true, status: "ready", phase: undefined }), "读取中…");
  });
});

describe("myStatusLabels", () => {
  const readyRead = <T>(value: T) => ({ status: "ready" as const, value });
  const failedRead = <T>() => ({ status: "failed" as const, value: undefined as T | undefined });
  const loadingRead = <T>() => ({ status: "loading" as const, value: undefined as T | undefined });

  const base = {
    mounted: true,
    isConnected: true,
    contractKnown: true,
    hasVoted: readyRead(false),
    votedFor: readyRead(0),
    stake: readyRead(0n),
    whitelisted: readyRead(true),
  };

  it("says 未连接 rather than inventing a wallet state before mount", () => {
    const labels = myStatusLabels({ ...base, mounted: false });

    assert.deepEqual(labels, { hasVoted: "—", votedFor: "—", stake: "—", whitelisted: "—" });
  });

  it("reports no address as 未连接, not as 否", () => {
    const labels = myStatusLabels({ ...base, isConnected: false });

    assert.equal(labels.hasVoted, "未连接");
    assert.equal(labels.stake, "—", "there is no address to ask about");
  });

  it("renders nothing concrete when there is no contract to ask", () => {
    const labels = myStatusLabels({ ...base, contractKnown: false });

    assert.deepEqual(labels, { hasVoted: "—", votedFor: "—", stake: "—", whitelisted: "—" });
  });

  it("never turns a failed stake read into 0 ETH", () => {
    // The one that can cost the reader their deposit.
    const labels = myStatusLabels({ ...base, stake: failedRead<bigint>() });

    assert.equal(labels.stake, "读取失败");
    assert.notEqual(labels.stake, "0 ETH");
  });

  it("still reports a stake read of exactly zero as 0 ETH", () => {
    assert.equal(myStatusLabels({ ...base, stake: readyRead(0n) }).stake, "0 ETH");
    assert.equal(
      myStatusLabels({ ...base, stake: readyRead(1_000_000_000_000_000n) }).stake,
      "0.001 ETH",
    );
  });

  it("never turns a failed hasVoted read into 否", () => {
    const labels = myStatusLabels({ ...base, hasVoted: failedRead<boolean>() });

    assert.equal(labels.hasVoted, "读取失败");
    assert.notEqual(labels.hasVoted, "否");
    assert.notEqual(labels.hasVoted, "读取中…");
  });

  it("never turns a failed votedFor read into the same dash as not having voted", () => {
    assert.equal(myStatusLabels({ ...base, votedFor: failedRead<number>() }).votedFor, "读取失败");
    assert.equal(myStatusLabels({ ...base, votedFor: readyRead(0) }).votedFor, "—");
    assert.equal(myStatusLabels({ ...base, votedFor: readyRead(3) }).votedFor, "候选人 #3");
  });

  it("never leaves a failed whitelist read saying 读取中…", () => {
    const labels = myStatusLabels({ ...base, whitelisted: failedRead<boolean>() });

    assert.equal(labels.whitelisted, "读取失败");
    assert.notEqual(labels.whitelisted, "读取中…");
  });

  it("distinguishes loading from both a value and a failure", () => {
    assert.equal(myStatusLabels({ ...base, hasVoted: loadingRead<boolean>() }).hasVoted, "读取中…");
    assert.equal(myStatusLabels({ ...base, stake: loadingRead<bigint>() }).stake, "读取中…");
  });

  it("reports a whitelisted address as 是 and a refused one as 否", () => {
    assert.equal(myStatusLabels({ ...base, whitelisted: readyRead(true) }).whitelisted, "是");
    assert.equal(myStatusLabels({ ...base, whitelisted: readyRead(false) }).whitelisted, "否");
  });
});

function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "ok",
    chainId: 11155111,
    contract: "0x4bb0fd8c1a7e5e2bd95e2702c716f21e5ed6503e",
    pollCount: 2,
    confirmations: 5,
    indexConfigured: true,
    indexerLoopEnabled: true,
    lastIndexedBlock: "11748968",
    chainHead: "11748973",
    lagBlocks: "0",
    indexError: null,
    ...overrides,
  };
}

describe("indexHeightText", () => {
  it("compares the cursor with the head the index may read, not with the raw head", () => {
    // Measured on Sepolia: `11748968 / 链头 11748973` beside `落后区块 0` read as a
    // contradiction — five blocks apparently missing while the lag said zero. The
    // lag counts from `chainHead − CONFIRMATIONS`, so that is what it must sit next to.
    assert.equal(indexHeightText(health()), "11748968 / 安全头 11748968");
  });

  it("keeps the raw head out of this row", () => {
    assert.ok(!indexHeightText(health()).includes("11748973"));
  });

  it("does not invent a height while the health read is in flight", () => {
    assert.equal(indexHeightText(undefined), "读取中…");
  });

  it("says 未启用 when there is no index to have a height", () => {
    assert.equal(indexHeightText(health({ indexConfigured: false })), "未启用");
  });

  it("reports an unreadable head as unknown rather than as a number", () => {
    assert.equal(indexHeightText(health({ chainHead: null })), "11748968 / 安全头 —");
    assert.equal(indexHeightText(health({ chainHead: "not-a-number" })), "11748968 / 安全头 —");
  });

  it("reports a chain shorter than the confirmation window as unknown, not negative", () => {
    assert.equal(
      indexHeightText(health({ chainHead: "3", confirmations: 5 })),
      "11748968 / 安全头 —",
    );
  });
});

describe("chainHeadText", () => {
  it("names the confirmation window that explains the difference", () => {
    assert.equal(chainHeadText(health()), "11748973（最近 5 块待确认）");
  });

  it("does not mention a window when there is none", () => {
    assert.equal(chainHeadText(health({ confirmations: 0 })), "11748973");
  });

  it("says unknown rather than guessing a head", () => {
    assert.equal(chainHeadText(health({ chainHead: null })), "—");
    assert.equal(chainHeadText(undefined), "读取中…");
  });
});

describe("lagText", () => {
  it("reports the lag the API computed", () => {
    assert.equal(lagText(health()), "0");
  });

  it("says 未启用 rather than — when there is no index", () => {
    assert.equal(lagText(health({ indexConfigured: false, lagBlocks: null })), "未启用");
  });

  it("leaves a lag the API refused to claim as unknown", () => {
    assert.equal(lagText(health({ lagBlocks: null })), "—");
  });
});

describe("syncSummary", () => {
  it("names the range and the row count of a pass that indexed something", () => {
    const result: SyncResponse = {
      enabled: true,
      status: "synced",
      fromBlock: "11748969",
      toBlock: "11748970",
      seen: 2,
      inserted: 2,
    };

    assert.equal(syncSummary(result), "已索引区块 11748969–11748970，读取 2 个事件，写入 2 行。");
  });

  it("says a reorg was repaired rather than that nothing happened", () => {
    assert.equal(
      syncSummary({ enabled: true, status: "rewound", toBlock: "406" }),
      "检测到链重组，已回退到区块 406，被孤立的行已删除。",
    );
  });

  it("reports being caught up with the height it is caught up to", () => {
    assert.equal(
      syncSummary({ enabled: true, status: "idle", lastIndexedBlock: "406" }),
      "索引已经追上安全头（406），没有新的可索引区块。",
    );
  });

  it("carries the reason when there is no database at all", () => {
    assert.equal(
      syncSummary({ enabled: false, reason: "DATABASE_URL is not set; the index is disabled." }),
      "DATABASE_URL is not set; the index is disabled.",
    );
  });

  it("does not render an empty sentence for an unenabled sync with no reason", () => {
    assert.ok(syncSummary({ enabled: false }).length > 0);
  });
});

describe("describeWriteFailure", () => {
  /**
   * The reported case, in the shape it arrives in: viem wraps the wallet's
   * `ProviderRpcError` in a `BaseError` whose own message is viem's English, and
   * the code that identifies the cause lives one or two `cause` links down. A
   * classifier that only reads `error.message` cannot see it.
   */
  const reportedRefusal = {
    name: "UserRejectedRequestError",
    message:
      "User rejected the request.\n\nDetails: User rejected the request.\nVersion: viem@2.56.8",
    shortMessage: "User rejected the request.",
    details: "User rejected the request.",
    cause: { name: "ProviderRpcError", code: 4001, message: "User rejected the request." },
  };

  it("names the wallet as the party that refused, and that nothing was sent", () => {
    const failure = describeWriteFailure(reportedRefusal);

    assert.equal(failure.classified, true);
    assert.equal(failure.text, "你在钱包里拒绝了这笔交易，链上没有任何变化。");
    assert.ok(!failure.text.includes("User rejected"), "the wall of English must not survive");
  });

  it("finds the rejection code even when only the cause carries it", () => {
    // Exactly the reported shape: no code at the top level at all.
    assert.equal(describeWriteFailure({ message: "boom", cause: { code: 4001 } }).classified, true);
  });

  it("recognises a wallet that reports the refusal without a code", () => {
    // Some wallets answer with text only — MetaMask's older string, and the
    // wording Coinbase/Frame use.
    for (const message of [
      "User denied transaction signature.",
      "User rejected the request.",
      "MetaMask Message Signature: User denied message signature.",
    ]) {
      const failure = describeWriteFailure(new Error(message));

      assert.equal(failure.classified, true, message);
      assert.equal(failure.text, "你在钱包里拒绝了这笔交易，链上没有任何变化。");
    }
  });

  it("tells the reader a request is already pending rather than that they refused", () => {
    const failure = describeWriteFailure({ code: -32002, message: "Already processing request" });

    assert.equal(failure.classified, true);
    assert.match(failure.text, /已经有一个待处理的请求/);
    assert.notEqual(failure.text, "你在钱包里拒绝了这笔交易，链上没有任何变化。");
  });

  it("names the chain mismatch instead of blaming the contract", () => {
    const failure = describeWriteFailure({
      name: "ChainMismatchError",
      message: 'Chain mismatch: expected "Sepolia", received "Ethereum Mainnet".',
    });

    assert.equal(failure.classified, true);
    assert.match(failure.text, /网络/);
    assert.match(failure.text, /交易没有发出/);
  });

  it("says the wallet cannot afford it, without inventing an amount", () => {
    const failure = describeWriteFailure({
      code: -32000,
      message: "insufficient funds for gas * price + value",
    });

    assert.equal(failure.classified, true);
    assert.match(failure.text, /余额不足/);
    assert.ok(!/\d/.test(failure.text), "the stake lives on the button, not in this sentence");
  });

  it("does not claim nothing happened when a node says it already knows the transaction", () => {
    // The one class where something may genuinely be in flight: "already known"
    // means the node holds this transaction. "链上没有任何变化" would be a lie.
    const failure = describeWriteFailure({ code: -32000, message: "already known" });

    assert.equal(failure.classified, true);
    assert.match(failure.text, /可能已经有一笔相同的交易/);
    assert.ok(!failure.text.includes("链上没有任何变化"), "must not assert that nothing was sent");
  });

  it("blames the contract for a revert, and says the state was rolled back", () => {
    const failure = describeWriteFailure({
      name: "ContractFunctionExecutionError",
      message:
        "Execution reverted with reason: AlreadyVoted(0x0000000000000000000000000000000000000001).",
      cause: { name: "ContractFunctionRevertedError" },
    });

    assert.equal(failure.classified, true);
    assert.match(failure.text, /合约回滚/);
    assert.ok(!failure.text.includes("Execution reverted"), "no Solidity text in the DOM");
  });

  it("refuses to guess at an error it does not recognise, and points at the console", () => {
    const failure = describeWriteFailure(new Error("socket hang up while talking to the node"));

    assert.equal(failure.classified, false);
    assert.match(failure.text, /无法归类/);
    assert.match(failure.text, /浏览器控制台/);
    assert.ok(
      !failure.text.includes("socket hang up"),
      "an unrecognised error must not be rendered verbatim",
    );
  });

  it("survives a thrown non-Error", () => {
    for (const thrown of ["nope", 42, null, undefined]) {
      const failure = describeWriteFailure(thrown);

      assert.equal(failure.classified, false);
      assert.ok(failure.text.length > 0);
    }
  });

  it("walks a self-referential cause chain without hanging", () => {
    const loop: Record<string, unknown> = { message: "boom" };
    loop.cause = loop;

    assert.equal(describeWriteFailure(loop).classified, false);
  });

  it("prefers the wallet's refusal over the words a revert message may share", () => {
    // viem's execution error carries the request it failed on, and a refusal can
    // arrive wrapped in one. The code is the stronger evidence, so it wins.
    const failure = describeWriteFailure({
      name: "ContractFunctionExecutionError",
      message: "Execution reverted while estimating gas",
      cause: { code: 4001, message: "User rejected the request." },
    });

    assert.equal(failure.text, "你在钱包里拒绝了这笔交易，链上没有任何变化。");
  });
});

/**
 * The language contract for this module.
 *
 * `ballot-labels.ts` is where the page decides WHAT to say about a read it may
 * not have completed — "we could not find out" versus "the answer is zero". A
 * translation must be able to change only the wording, never which of those two
 * claims is made. So the shape of every result is asserted to be identical across
 * languages, and only the text is allowed to differ.
 */
describe("language", () => {
  /** A CID-shaped string, which is what makes `optionName` consult the metadata. */
  const CID = "bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a";

  const HEALTH: HealthResponse = health();
  const SYNCED: SyncResponse = {
    enabled: true,
    status: "synced",
    fromBlock: "10",
    toBlock: "20",
    seen: 3,
    inserted: 2,
  };

  /**
   * Every function in the module, called with inputs that reach a real branch.
   *
   * Only sentences that are actually COPY belong here. Two returns are
   * deliberately locale-independent and were removed after they made the
   * "everything moved" assertion fail for a non-defect:
   *
   *   * `phaseText` with `contractKnown: false` returns the bare `—`, which says
   *     "there is no contract to report a phase for". A dash is not a sentence in
   *     either language.
   *   * `optionName` over a non-CID string returns that string, because a raw
   *     label IS the option's label. It is the poll's own on-chain data, and the
   *     `optionName` test at the end of this block asserts it is NOT translated.
   *
   * Both were false failures: the assertion exists to catch a catalogue entry that
   * was never wired up, and a data value that is correctly identical in both
   * languages is not that.
   */
  function everySentence(locale: "zh" | "en"): string[] {
    return [
      tallyLabels({ isPending: true, isError: false, candidateCount: 0 }, locale).source,
      tallyLabels({ isPending: false, isError: true, candidateCount: 0 }, locale).source,
      tallyLabels(
        { isPending: false, isError: false, source: "index", total: 2, candidateCount: 2 },
        locale,
      ).source,
      readText("failed", undefined, String, locale),
      readText("loading", undefined, String, locale),
      phaseText({ contractKnown: true, status: "failed", phase: undefined }, locale),
      myStatusLabels(
        {
          mounted: true,
          isConnected: false,
          contractKnown: true,
          hasVoted: { status: "ready", value: true },
          votedFor: { status: "ready", value: 7 },
          stake: { status: "ready", value: 1n },
          whitelisted: { status: "ready", value: false },
        },
        locale,
      ).hasVoted,
      optionMetadataLabel("not-a-cid", undefined, { isPending: false, isError: false }, locale),
      optionMetadataLabel(
        "bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a",
        { status: "unreachable", attempts: 3 },
        { isPending: false, isError: false },
        locale,
      ),
      optionMetadataLabel(
        "bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a",
        { status: "no-metadata", answered: 2, attempts: 3 },
        { isPending: false, isError: false },
        locale,
      ),
      // A CID-shaped input with no metadata result, so this reaches the numbered
      // fallback. The non-CID case is deliberately absent: it returns the poll's
      // own string unchanged, which is data, not copy.
      optionName(
        4,
        "bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a",
        undefined,
        locale,
      ),
      indexHeightText(HEALTH, locale),
      chainHeadText(HEALTH, locale),
      lagText({ ...HEALTH, indexConfigured: false }, locale),
      syncSummary(SYNCED, locale),
      syncSummary({ enabled: true, status: "rewound", toBlock: "9" }, locale),
      syncSummary({ enabled: true, status: "idle", lastIndexedBlock: "9" }, locale),
      syncSummary({ enabled: false, status: "idle" }, locale),
      describeWriteFailure({ code: 4001 }, locale).text,
      describeWriteFailure({ code: -32002 }, locale).text,
      describeWriteFailure({ code: 4902 }, locale).text,
      describeWriteFailure({ message: "insufficient funds for gas" }, locale).text,
      describeWriteFailure({ message: "nonce too low" }, locale).text,
      describeWriteFailure({ name: "ContractFunctionExecutionError" }, locale).text,
      describeWriteFailure({ code: 12345, message: "something else" }, locale).text,
    ];
  }

  it("defaults to Chinese, so every pre-existing call site is unchanged", () => {
    for (const [index, sentence] of everySentence("zh").entries()) {
      assert.equal(sentence, everySentence("zh")[index]);
    }

    assert.equal(
      tallyLabels({ isPending: true, isError: false, candidateCount: 0 }).source,
      "读取中…",
    );
    assert.equal(indexHeightText(HEALTH), indexHeightText(HEALTH, "zh"));
    assert.equal(chainHeadText(HEALTH), chainHeadText(HEALTH, "zh"));
    assert.equal(lagText(HEALTH), lagText(HEALTH, "zh"));
    assert.equal(syncSummary(SYNCED), syncSummary(SYNCED, "zh"));
    assert.equal(
      describeWriteFailure({ code: 4001 }).text,
      describeWriteFailure({ code: 4001 }, "zh").text,
    );
  });

  it("answers in English when asked, and the two languages actually differ", () => {
    const zh = everySentence("zh");
    const en = everySentence("en");

    assert.equal(zh.length, en.length);

    // Every single sentence must move. A phrase that stayed identical would mean
    // a catalogue entry was never wired up, which is invisible to a type check
    // because the key exists and its value is a perfectly good string.
    const unchanged = zh.filter((sentence, index) => sentence === en[index]);

    assert.deepEqual(unchanged, [], "these sentences were not translated at all");
  });

  it("leaves no placeholder unfilled in either language", () => {
    // `interpolate` deliberately shows an unknown placeholder rather than blanking
    // it, so a translation that renamed `{id}` to `{identifier}` would reach the
    // reader as literal braces. Sweep both languages.
    for (const locale of ["zh", "en"] as const) {
      for (const sentence of everySentence(locale)) {
        assert.doesNotMatch(sentence, /\{\w+\}/, `${locale}: ${sentence}`);
      }
    }
  });

  it("keeps the SHAPE of every result identical across languages", () => {
    // The rule this protects: a translation changes wording, never which claim is
    // made. `classified` is a judgement about the error, and the dash/blank
    // distinction is a judgement about whether a read answered.
    for (const error of [
      { code: 4001 },
      { code: -32002 },
      { code: 4902 },
      { message: "insufficient funds" },
      { message: "nonce too low" },
      { name: "ContractFunctionExecutionError" },
      { code: 999, message: "unclassifiable" },
      "a thrown string",
      null,
    ]) {
      assert.equal(
        describeWriteFailure(error, "zh").classified,
        describeWriteFailure(error, "en").classified,
        `classified must not depend on the language: ${JSON.stringify(error)}`,
      );
    }

    const statuses = [
      { mounted: false, isConnected: true, contractKnown: true },
      { mounted: true, isConnected: false, contractKnown: true },
      { mounted: true, isConnected: true, contractKnown: false },
    ];

    for (const partial of statuses) {
      const input = {
        ...partial,
        hasVoted: { status: "ready" as const, value: true },
        votedFor: { status: "ready" as const, value: 3 },
        stake: { status: "ready" as const, value: 2n },
        whitelisted: { status: "ready" as const, value: true },
      };

      const zh = myStatusLabels(input, "zh");
      const en = myStatusLabels(input, "en");

      // SHAPE, not values. Comparing the values here would contradict this test's
      // own rule — the words are supposed to differ. It passed only while
      // `notConnected` happened to be the same string in both languages; giving
      // English a real translation is what exposed it.
      assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());

      // And the shape that actually carries meaning: whether a row reports a
      // concrete value or the "no value" placeholder must not move. Those are
      // different claims, and a translation must not be able to swap them.
      //
      // The placeholder is read from the catalogue rather than written as a
      // literal, so changing the dash cannot silently turn this check into a
      // comparison of two `false`s.
      const blank = ZH_BALLOT_PHRASES.nothing;

      for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
        assert.equal(
          zh[key] === blank,
          en[key] === blank,
          `${key}: blank-ness must not depend on the language`,
        );
      }
    }
  });

  it("names the option by its metadata in both languages, and by number in neither when resolved", () => {
    // A resolved name is data, not copy: it must not be translated, and it must
    // not fall back to the numbered form differently per language.
    const resolved = {
      status: "ok" as const,
      metadata: { name: "林澈", description: "", image: "" },
      answered: 1,
      attempts: 1,
    };

    assert.equal(optionName(1, CID, resolved, "zh"), "林澈");
    assert.equal(optionName(1, CID, resolved, "en"), "林澈");

    assert.notEqual(optionName(1, CID, undefined, "zh"), optionName(1, CID, undefined, "en"));
  });
});
