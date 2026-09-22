// SPDX-License-Identifier: MIT
/**
 * Tests for the endpoint list both the server and the browser build from.
 *
 * This rule has two callers on opposite sides of the server/client boundary, and
 * the failure it prevents is not a crash: two copies that drift would give the
 * page and the API a different endpoint order from an identically configured
 * deployment, which surfaces as "the tally disagrees" rather than as a
 * configuration error. So the ordering guarantees are asserted rather than
 * assumed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRpcEndpoints } from "../src/lib/rpc-endpoints";

describe("resolveRpcEndpoints", () => {
  it("keeps the primary first and the listed extras behind it", () => {
    assert.deepEqual(resolveRpcEndpoints("http://primary", "http://a,http://b"), [
      "http://primary",
      "http://a",
      "http://b",
    ]);
  });

  it("returns just the primary when no list is configured", () => {
    // The single-endpoint case must be byte-for-byte what it was before
    // `RPC_URLS` existed, since every existing deployment sets only `RPC_URL`.
    assert.deepEqual(resolveRpcEndpoints("http://primary", undefined), ["http://primary"]);
    assert.deepEqual(resolveRpcEndpoints("http://primary", ""), ["http://primary"]);
  });

  it("uses only the list when there is no primary", () => {
    assert.deepEqual(resolveRpcEndpoints(undefined, "http://a,http://b"), ["http://a", "http://b"]);
  });

  it("drops blanks rather than producing an empty endpoint", () => {
    // A trailing comma is the ordinary result of editing a list by hand. An empty
    // entry kept here would become a transport pointing at "" and fail on every
    // read while appearing to be a configured endpoint.
    assert.deepEqual(resolveRpcEndpoints("http://primary", "http://a, ,http://b,"), [
      "http://primary",
      "http://a",
      "http://b",
    ]);
  });

  it("does not let the primary be repeated by the list", () => {
    // `RPC_URL=x` plus `RPC_URLS=x,y` is the obvious way to write "x, then y".
    // Repeated, the dead-endpoint timeout would be paid twice before y is reached.
    assert.deepEqual(resolveRpcEndpoints("http://x", "http://x,http://y"), [
      "http://x",
      "http://y",
    ]);
  });

  it("treats endpoints differing only in case as the same one", () => {
    assert.deepEqual(resolveRpcEndpoints("HTTP://X", "http://x"), ["HTTP://X"]);
  });

  it("trims whitespace rather than carrying it into the transport", () => {
    assert.deepEqual(resolveRpcEndpoints("  http://primary  ", " http://a "), [
      "http://primary",
      "http://a",
    ]);
  });

  it("treats a whitespace-only primary as absent", () => {
    // Otherwise the primary would be a single space, which is not a URL and not
    // an empty string either — it would survive every blank check above.
    assert.deepEqual(resolveRpcEndpoints("   ", "http://a"), ["http://a"]);
  });

  it("returns an empty list when nothing is configured, so callers can decide", () => {
    // Deliberate: the browser needs "nothing configured" to mean "use viem's
    // default for the chain", which it cannot express if this invented localhost.
    assert.deepEqual(resolveRpcEndpoints(undefined, undefined), []);
  });

  it("does not validate URLs, because a bad one must fail where it is used", () => {
    // Checking here would move the failure earlier while adding a second place
    // that believes it knows what a URL looks like.
    assert.deepEqual(resolveRpcEndpoints("not-a-url", undefined), ["not-a-url"]);
  });
});
