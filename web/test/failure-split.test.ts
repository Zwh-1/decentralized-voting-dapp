// The classify/render split, and the property that makes it necessary.
//
// ---------------------------------------------------------------------------
// Why this file exists, and what it found
// ---------------------------------------------------------------------------
//
// `describeFailure` used to be one function: it classified a throwable and
// rendered it in the same breath. `data.ts` then stored its RESULT on a
// process-level object for `/api/health` to publish. That is fine while the answer
// has one language, and it stopped being fine once it did not: the failure is
// recorded once, before any reader exists, so a stored sentence freezes whichever
// language was active at that instant and serves it to everybody afterwards.
//
// The fix splits classification from rendering, so the shape is stored and the
// sentence is produced per request. These tests guard both halves of that:
// the split must not change any existing rendering, and it must be able to produce
// two different ones.
//
// An earlier version of this file compared against `git show HEAD:` and demanded
// agreement in BOTH languages. Every disagreement was `/en`-only, and every one was
// the working copy translating correctly -- at HEAD, `describeFailure(error)` took
// no locale parameter at all and answered in Chinese regardless. So "agrees with
// HEAD" is the right invariant for `zh` and the wrong one for `en`; the Chinese
// baseline is pinned below as literals instead.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyFailure, describeFailure, renderFailure } from "../src/lib/failure";

/** A throwable that looks like each shape the classifier distinguishes. */
function viemLike(method: string): Error {
  return Object.assign(new Error(`HTTP request failed. Body: {"method":"${method}"}`), {
    walk: () => undefined,
  });
}

/**
 * HEAD's Chinese output, pinned literally.
 *
 * These are the strings the existing callers, the existing tests and `ui-drill`
 * were written against, so they are the part of the behaviour that must not move.
 */
const HEAD_ZH: [string, unknown, string][] = [
  [
    "econnrefused falls through to the raw message",
    new Error("connect ECONNREFUSED 127.0.0.1:8545"),
    "connect ECONNREFUSED 127.0.0.1:8545",
  ],
  [
    "rpc timeout",
    new Error("fetch failed: request timed out after 10000ms"),
    "链上读取失败：所有已配置的 RPC 端点都未响应（连接失败或请求超时）。请检查 web/.env 里的 RPC_URL / RPC_URLS 是否可达；完整错误见服务端日志。",
  ],
  [
    "viem names the method it was calling",
    viemLike("eth_blockNumber"),
    "链上读取失败（eth_blockNumber 调用）：所有已配置的 RPC 端点都未响应（连接失败或请求超时）。请检查 web/.env 里的 RPC_URL / RPC_URLS 是否可达；完整错误见服务端日志。",
  ],
  [
    "mysql errno",
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { errno: -111 }),
    "索引数据库（MySQL）不可读或不可写。请检查 web/.env 里的 DATABASE_URL，以及数据库是否在运行；完整错误见服务端日志。",
  ],
  [
    "an error with its own message keeps that message",
    new Error("something entirely unexpected happened"),
    "something entirely unexpected happened",
  ],
  ["a thrown non-Error", "a bare string", "未预期的失败。完整错误见服务端日志。"],
];

/** A spread of inputs, for the invariant that the two paths never disagree. */
const CORPUS: [string, unknown][] = [
  ...HEAD_ZH.map(([name, input]) => [name, input] as [string, unknown]),
  ["fetch failed", new Error("fetch failed")],
  ["viem eth_call", viemLike("eth_call")],
  ["mysql code", Object.assign(new Error("Access denied"), { code: "ER_ACCESS_DENIED_ERROR" })],
  ["mysql sqlMessage", Object.assign(new Error("bad"), { sqlMessage: "Table missing" })],
  ["empty message", new Error("")],
  ["null", null],
  ["undefined", undefined],
  ["object", { some: "object" }],
  ["number", 42],
  ["endpoint leak", new Error("failed at https://rpc.example.com/v3/SECRETKEY123")],
  ["apikey leak", new Error("bad url ?apiKey=abcdef123456")],
  ["multiline", new Error("first line\nsecond line\nthird line")],
];

describe("the classify/render split", () => {
  it("keeps the Chinese output byte-identical to what it replaced", () => {
    for (const [name, input, expected] of HEAD_ZH) {
      assert.equal(describeFailure(input, "zh"), expected, name);
      assert.equal(renderFailure(classifyFailure(input), "zh"), expected, `${name} (split path)`);
    }
  });

  it("renders exactly what the one-shot call renders, in both languages", () => {
    // If these two paths could disagree, the health panel would show a different
    // sentence from the page banner for the same outage.
    const disagreements: string[] = [];

    for (const [name, input] of CORPUS) {
      for (const locale of ["zh", "en"] as const) {
        const direct = describeFailure(input, locale);
        const split = renderFailure(classifyFailure(input), locale);

        if (direct !== split) {
          disagreements.push(`${name}/${locale}: direct=${direct} split=${split}`);
        }
      }
    }

    assert.deepEqual(disagreements, []);
  });

  it("changes the answer for English, so the locale parameter is load-bearing", () => {
    // At HEAD there was no locale parameter and English callers silently got
    // Chinese. Guard the opposite direction now: if these stop differing, the
    // translation has been lost rather than kept.
    const prose = CORPUS.filter(
      ([, input]) => describeFailure(input, "zh") !== describeFailure(input, "en"),
    );

    assert.ok(
      prose.length >= 5,
      `expected several locale-sensitive sentences, got ${prose.length}`,
    );
  });

  it("stores a shape rather than a sentence", () => {
    // This is what lets `data.ts` render per request instead of freezing whichever
    // language happened to be active when the index failed.
    const stored = classifyFailure(new Error("fetch failed: request timed out after 10000ms"));

    assert.equal(typeof stored, "object");
    assert.notEqual(typeof stored, "string");
    assert.notEqual(renderFailure(stored, "zh"), renderFailure(stored, "en"));
  });

  it("keeps the redaction markers in Chinese in both languages", () => {
    // They are the marker an operator is told to grep for, and translating them
    // would mean an English reader searching for a string the log never contained.
    for (const locale of ["zh", "en"] as const) {
      const rendered = describeFailure(
        new Error("failed at https://rpc.example.com/v3/SECRET"),
        locale,
      );

      assert.ok(!rendered.includes("rpc.example.com"), `${locale}: the endpoint must not survive`);
    }

    assert.ok(
      describeFailure(new Error("failed at https://rpc.example.com/x"), "en").includes("已隐去"),
    );
  });
});
