// SPDX-License-Identifier: MIT
/**
 * Tests for the wallet connector decision.
 *
 * The rule under test is about what happens when configuration is ABSENT or
 * WRONG. Presence is the easy case and is barely worth asserting; the value here
 * is that a missing project id produces a named reason and a message that does
 * not leak the value it rejected.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WALLET_APP_NAME,
  resolveWalletConnect,
  walletConnectNotice,
} from "../src/lib/wallet-connectors";

/** A project id shaped the way Reown issues them. */
const VALID = "0123456789abcdef0123456789abcdef";

describe("resolveWalletConnect", () => {
  it("accepts a well-formed project id", () => {
    const status = resolveWalletConnect(VALID);

    assert.equal(status.available, true);
    assert.equal(status.available && status.projectId, VALID);
  });

  it("accepts uppercase hex", () => {
    const upper = VALID.toUpperCase();

    assert.equal(resolveWalletConnect(upper).available, true);
  });

  it("treats an unset value as not configured", () => {
    // Not as "malformed": the two produce different advice, and telling an
    // operator their unset variable is malformed would send them looking for a
    // typo that is not there.
    for (const value of [undefined, null, "", "   "]) {
      const status = resolveWalletConnect(value);

      assert.equal(status.available, false, String(value));
      assert.equal(!status.available && status.reason, "not-configured");
    }
  });

  it("REFUSES a placeholder rather than registering a broken connector", () => {
    // `changeme` would otherwise produce a connector that fails at the relay
    // handshake — on mobile only, long after deploy, with an error that mentions
    // nothing about configuration.
    for (const value of ["changeme", "your_project_id", "abc", "0123456789abcdef0123456789abcde"]) {
      const status = resolveWalletConnect(value);

      assert.equal(status.available, false, value);
      assert.equal(!status.available && status.reason, "malformed", value);
    }
  });

  it("refuses a value with internal whitespace even if it is long enough", () => {
    assert.equal(resolveWalletConnect("0123456789abcdef 123456789abcdef").available, false);
  });

  it("trims surrounding whitespace before judging the shape", () => {
    // A trailing newline from an editor or a CI secret store is not a typo the
    // operator made in the value.
    assert.equal(resolveWalletConnect(`  ${VALID}  `).available, true);
  });
});

describe("walletConnectNotice", () => {
  it("says nothing when WalletConnect is available", () => {
    assert.equal(walletConnectNotice(resolveWalletConnect(VALID)), null);
  });

  it("names the variable when it is unset", () => {
    const notice = walletConnectNotice(resolveWalletConnect(undefined));

    assert.ok(notice !== null);
    assert.match(notice, /NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID/);
    // The consequence a reader would actually hit, so the operator can judge
    // whether it matters to them.
    assert.match(notice, /mobile/i);
  });

  it("says what was expected when the value is malformed", () => {
    const notice = walletConnectNotice(resolveWalletConnect("changeme"));

    assert.ok(notice !== null);
    assert.match(notice, /32 hex/i);
  });

  it("NEVER repeats the rejected value", () => {
    // The rule from ADR-0016: give the shape, never the value. A project id is
    // credential-shaped, and a warning is a place it could easily leak.
    const secret = "supersecretvalue";

    for (const status of [resolveWalletConnect(secret), resolveWalletConnect(VALID)]) {
      const notice = walletConnectNotice(status);

      if (notice !== null) {
        assert.ok(!notice.includes(secret), "the notice must not echo the value");
      }
    }

    const malformed = walletConnectNotice(
      resolveWalletConnect("deadbeefdeadbeefdeadbeefdeadbeefX"),
    );

    assert.ok(malformed !== null);
    assert.ok(!malformed.includes("deadbeefdeadbeefdeadbeefdeadbeefX"));
  });
});

describe("WALLET_APP_NAME", () => {
  it("is a non-empty string, so every connector names the app the same way", () => {
    assert.equal(typeof WALLET_APP_NAME, "string");
    assert.ok(WALLET_APP_NAME.trim().length > 0);
  });
});
