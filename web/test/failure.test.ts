// SPDX-License-Identifier: MIT
/**
 * What the page is allowed to say about a failure, and what it must never say.
 *
 * The trigger for these tests is a real page state: clicking 立即同步索引 while the
 * configured Sepolia endpoint was briefly unavailable rendered
 *
 *     同步失败：The request took too long to respond. URL: https://ethereum-sepolia-rpc.publicnode.com/?apiKey=WP46… Request body: {"method":"eth_blockNumber"} Details: The request timed out. Version: viem@2.56.8
 *
 * into the ballot page. Every visitor could read the operator's RPC endpoint and
 * its API key by clicking that button, and the same raw message was reachable
 * through `/api/health`'s `indexError`, all five `/api/*` `message` fields, and
 * the server-rendered failure banner. The first test below uses viem's own error
 * classes, so the fixture is the real thing rather than a paraphrase of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpRequestError, TimeoutError } from "viem";

import { describeFailure } from "../src/lib/failure";

/** The endpoint from `web/.env`, key and all. */
const RPC_URL =
  "https://ethereum-sepolia-rpc.publicnode.com/?apiKey=WP46HXE52EJNIWGKGA8AG7T2ZYGKC119EN";
const API_KEY = "WP46HXE52EJNIWGKGA8AG7T2ZYGKC119EN";

/** A mysql2 driver error, shaped the way mysql2 actually throws them. */
function mysqlError(message: string, extra: Record<string, unknown>): Error {
  return Object.assign(new Error(message), extra);
}

describe("describeFailure", () => {
  it("never republishes the endpoint, the key or the library version", () => {
    const error = new TimeoutError({ url: RPC_URL, body: { method: "eth_blockNumber" } });

    // The fixture really is the leaking shape: viem puts all of it in `message`.
    assert.ok(error.message.includes(`apiKey=${API_KEY}`));
    assert.ok(error.message.includes("viem@"));

    const text = describeFailure(error);

    assert.ok(!text.includes("http"), "no endpoint may survive");
    assert.ok(!text.includes("apiKey"));
    assert.ok(!text.includes(API_KEY), "the key itself must never be echoed");
    assert.ok(!text.includes("viem@"), "nor the library version");
    assert.ok(!text.includes("Request body"));
  });

  it("says which dependency failed and which variable configures it", () => {
    const text = describeFailure(
      new TimeoutError({ url: RPC_URL, body: { method: "eth_blockNumber" } }),
    );

    // ADR-0012: name the party that failed, and tell the operator where to look.
    assert.ok(text.includes("RPC"));
    assert.ok(text.includes("RPC_URL"));
    assert.ok(text.includes("eth_blockNumber"), "the failing call is named");
  });

  it("names the RPC endpoint for a non-timeout HTTP failure too", () => {
    const error = new HttpRequestError({ url: RPC_URL, details: "fetch failed" });

    const text = describeFailure(error);

    assert.ok(text.includes("RPC_URL"));
    assert.ok(!text.includes(API_KEY));
  });

  it("names the database — not the RPC — when the driver reports a SQL error", () => {
    const error = mysqlError("Access denied for user 'root'@'localhost' (using password: YES)", {
      code: "ER_ACCESS_DENIED_ERROR",
      errno: 1045,
      sqlState: "28000",
      sqlMessage: "Access denied for user 'root'@'localhost' (using password: YES)",
    });

    const text = describeFailure(error);

    assert.ok(text.includes("DATABASE_URL"));
    assert.ok(!text.includes("RPC_URL"));
  });

  it("names the database for a refused connection, even though the text says ECONNREFUSED", () => {
    // The ambiguity that matters: a refused connection reads the same whether it
    // came from MySQL or from `fetch`. The driver's `errno` is what distinguishes
    // them, and getting it wrong would send the operator to `RPC_URL` while the
    // database is the thing that is down.
    const error = mysqlError("connect ECONNREFUSED 127.0.0.1:3306", {
      code: "ECONNREFUSED",
      errno: -4078,
      syscall: "connect",
      address: "127.0.0.1",
      port: 3306,
    });

    const text = describeFailure(error);

    assert.ok(text.includes("DATABASE_URL"));
    assert.ok(!text.includes("RPC_URL"));
  });

  it("keeps this project's own diagnostics, which name a variable and echo no value", () => {
    // `config.ts` writes these by hand; replacing them with "unexpected failure"
    // would remove the operator's only clue about which variable to fix.
    assert.equal(
      describeFailure(new Error('CHAIN_ID must be a non-negative integer, received "abc"')),
      'CHAIN_ID must be a non-negative integer, received "abc"',
    );
    assert.equal(
      describeFailure(
        new Error(
          "Missing required environment variable RPC_URL. Copy web/.env.example to web/.env and fill it in.",
        ),
      ),
      "Missing required environment variable RPC_URL. Copy web/.env.example to web/.env and fill it in.",
    );
  });

  it("scrubs an endpoint out of an otherwise ordinary error message", () => {
    const text = describeFailure(new Error(`could not reach ${RPC_URL}`));

    assert.ok(!text.includes(API_KEY));
    assert.ok(!text.includes("https://"), "no URL survives, whatever the error came from");
    assert.ok(text.includes("已隐去"));
  });

  it("returns the first line only, so a stack cannot become the page text", () => {
    const text = describeFailure(new Error("first line\nsecond line\nthird line"));

    assert.equal(text, "first line");
  });

  it("caps the length of a passthrough message", () => {
    assert.ok(describeFailure(new Error("x".repeat(1000))).length <= 300);
  });

  it("answers for a thrown non-Error without inventing a message from it", () => {
    // `String(undefined)` is `"undefined"`, which used to be renderable.
    for (const value of [undefined, null, 0, "boom", { code: "ER_BAD_DB_ERROR" }, []]) {
      const text = describeFailure(value);

      assert.ok(text.length > 0);
      assert.ok(!text.includes("undefined"), `got ${text}`);
      assert.ok(!text.includes("ER_BAD_DB_ERROR"), "a thrown object is not a message");
    }
  });

  it("always says where the full error went", () => {
    // The reader is not left thinking the detail was lost.
    for (const error of [
      new TimeoutError({ url: RPC_URL, body: { method: "eth_getLogs" } }),
      mysqlError("connect ECONNREFUSED 127.0.0.1:3306", { errno: -4078 }),
      undefined,
    ]) {
      assert.ok(describeFailure(error).includes("服务端日志"), `got ${describeFailure(error)}`);
    }
  });
});
