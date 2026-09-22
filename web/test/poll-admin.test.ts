// SPDX-License-Identifier: MIT
/**
 * The only piece of `PollAdmin` that can be tested without a browser.
 *
 * `parseAddressList` is extracted and exported for exactly this reason, and it
 * is the piece worth testing: it decides which addresses are about to be granted
 * voting rights. Every other decision in that component is a sentence rendered
 * next to a button, which `ui:drill` covers; this one decides what gets written.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAddressList } from "../src/lib/admin-labels";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
// Mixed case on purpose: `aBcDeF` are all hex digits, so this is a valid —
// if not correctly checksummed — address, which is what a reader pasting from
// a block explorer or a chat message will actually produce.
const C = "0xaBcDeFaBcDeFaBcDeFaBcDeFaBcDeFaBcDeFaBcD";

describe("parseAddressList", () => {
  it("splits on newlines, commas, semicolons and whitespace alike", () => {
    // All four separators reach the same result, because a reader pasting from a
    // spreadsheet, a chat message and a CSV should not have to reformat first.
    assert.deepEqual(parseAddressList(`${A}\n${B}`), [A, B]);
    assert.deepEqual(parseAddressList(`${A},${B}`), [A, B]);
    assert.deepEqual(parseAddressList(`${A};${B}`), [A, B]);
    assert.deepEqual(parseAddressList(`${A} ${B}`), [A, B]);
    assert.deepEqual(parseAddressList(`${A}\n\n  ${B}  \n`), [A, B]);
  });

  it("returns an empty list for empty input rather than null", () => {
    // Empty is a *valid* parse of zero addresses; the component decides
    // separately that zero addresses is not worth submitting. Collapsing the two
    // would make "you typed nothing" indistinguishable from "you typed garbage".
    assert.deepEqual(parseAddressList(""), []);
    assert.deepEqual(parseAddressList("   \n  \t "), []);
  });

  it("returns null when any entry is not an address", () => {
    // The safety property. A dropped bad entry would silently grant rights to
    // the addresses that remain, and the reader would believe the whole list was
    // applied.
    assert.equal(parseAddressList(`${A}\nnot-an-address`), null);
    assert.equal(parseAddressList(`${A}\n0x1234`), null);
    assert.equal(parseAddressList(`${A}\n${B}zz`), null);
    assert.equal(parseAddressList("0x"), null);
  });

  it("rejects addresses of the wrong length", () => {
    // 39 and 41 hex digits are the realistic typos, and both are caught.
    assert.equal(parseAddressList("0x11111111111111111111111111111111111111"), null);
    assert.equal(parseAddressList("0x11111111111111111111111111111111111111111"), null);
  });

  it("keeps the zero address, which is the contract's job to refuse", () => {
    // `setWhitelist` reverts with `ZeroAddress` on it, so this is a loss the
    // chain reports rather than one this parser has to guess at. Duplicating the
    // contract's checks here would be a second place they could drift.
    const zero = "0x0000000000000000000000000000000000000000";
    assert.deepEqual(parseAddressList(zero), [zero]);
  });

  it("accepts mixed case, which is what checksummed addresses look like", () => {
    assert.deepEqual(parseAddressList(C), [C]);
  });

  it("deduplicates case-insensitively and keeps the first spelling", () => {
    // The same address twice would otherwise be written twice in one batch: the
    // chain's event count would disagree with the reader's count, and nothing
    // would explain why.
    assert.deepEqual(parseAddressList(`${A}\n${A}`), [A]);
    assert.deepEqual(parseAddressList(`${C}\n${C.toLowerCase()}`), [C]);
    assert.deepEqual(parseAddressList(`${C.toLowerCase()}\n${C}`), [C.toLowerCase()]);
  });

  it("preserves the order the reader typed", () => {
    assert.deepEqual(parseAddressList(`${B}\n${A}`), [B, A]);
  });
});
