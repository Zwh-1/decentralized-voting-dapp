// SPDX-License-Identifier: MIT
/**
 * The CID encoder, pinned to things that cannot be argued with.
 *
 * The whole reason `scripts/cid.ts` exists is that a CID was typed instead of
 * computed, so a test that only checks "it returns 59 characters starting with
 * b" would reproduce the defect with extra steps. These check the bytes:
 *
 * 1. `QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o` is the CID of the twelve
 *    bytes `hello world\n`. It is the example in the IPFS documentation and it
 *    is served to this day by public gateways, so reproducing it from first
 *    principles proves the UnixFS encoding, the protobuf field order, the
 *    multihash and base58btc in one assertion.
 * 2. The CIDv1 form of the same block must carry the same digest as the CIDv0
 *    form, which is what makes the two interchangeable on chain.
 * 3. The raw form must be sha2-256 of the bare bytes, checked against
 *    `node:crypto` rather than against this module's own helpers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  DAG_PB_CODEC,
  RAW_CODEC,
  cidProblem,
  computedCids,
  dagPbFileCidV0,
  dagPbFileCidV1,
  isSeedableCid,
  parseCid,
  rawCidV1,
  sameBlock,
} from "../scripts/cid";

const HELLO = new TextEncoder().encode("hello world\n");

/** The documented CID of `hello world\n`, as served by public gateways. */
const HELLO_V0 = "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o";

/** base32 lowercase without padding — used to build counterexamples. */
function base32(bytes: readonly number[]): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += alphabet[(buffer << (5 - bits)) & 0x1f];
  }

  return out;
}

describe("computing a document's CID", () => {
  it("reproduces the well-known CID of hello world", () => {
    assert.equal(dagPbFileCidV0(HELLO), HELLO_V0);
  });

  it("gives the CIDv1 form of the same block the same digest", () => {
    const v0 = parseCid(dagPbFileCidV0(HELLO));
    const v1 = parseCid(dagPbFileCidV1(HELLO));

    assert.notEqual(v0, null);
    assert.notEqual(v1, null);
    assert.equal(v1!.codec, DAG_PB_CODEC);
    assert.deepEqual(v1!.digest, v0!.digest, "the two forms must address the same bytes");
    assert.match(dagPbFileCidV1(HELLO), /^bafy[a-z2-7]{55}$/);
  });

  it("makes the raw form the bare digest of the bytes", () => {
    // Independent of this module's own sha256 helper: a raw block *is* the
    // bytes, so its digest is the hash of the bytes and nothing else.
    const parsed = parseCid(rawCidV1(HELLO));

    assert.notEqual(parsed, null);
    assert.equal(parsed!.codec, RAW_CODEC);
    assert.deepEqual(parsed!.digest, new Uint8Array(createHash("sha256").update(HELLO).digest()));
  });

  it("gives two different documents two different CIDs", () => {
    const first = computedCids(new TextEncoder().encode(`{"name":"a"}`));
    const second = computedCids(new TextEncoder().encode(`{"name":"b"}`));

    assert.notEqual(first.dagPb, second.dagPb);
    assert.notEqual(first.raw, second.raw);
  });

  it("changes the CID when a single byte changes", () => {
    // The property the chain relies on: the CID is a function of the bytes, so
    // an edited document cannot keep its old CID.
    const before = dagPbFileCidV1(new TextEncoder().encode(`{"name":"林澈"}`));
    const after = dagPbFileCidV1(new TextEncoder().encode(`{"name":"林澈 "}`));

    assert.notEqual(before, after);
  });

  it("refuses a document too large for the layout it models", () => {
    // Silently hashing the wrong layout would produce a CID for bytes nobody
    // can fetch; failing is the only honest option.
    assert.throws(() => dagPbFileCidV1(new Uint8Array(262_145)), /single-chunk/);
  });
});

describe("parseCid", () => {
  it("accepts the two forms the browser resolves", () => {
    const v0 = parseCid(HELLO_V0);
    const v1 = parseCid(rawCidV1(HELLO));

    assert.equal(v0?.version, 0);
    assert.equal(v0?.codec, DAG_PB_CODEC);
    assert.equal(v1?.version, 1);
    assert.equal(v1?.hash, 0x12);
    assert.equal(v1?.digest.length, 32);
  });

  it("rejects the placeholder that was on chain", () => {
    // Not a shape opinion: `s` is not in the base32 alphabet the `b` prefix
    // promises, so there is nothing to decode.
    assert.equal(parseCid("bafyseededcandidate0"), null);
    assert.equal(isSeedableCid("bafyseededcandidate0"), false);
  });

  it("rejects truncated and malformed encodings", () => {
    for (const bad of [
      "",
      "b",
      "Qm",
      `Qm${"a".repeat(43)}`,
      `bafy${"a".repeat(54)}`,
      `bafy${"A".repeat(55)}`, // base32 is lower case
      "ipfs://bafybeicg2rebjoofv4kbyovkw7af3rpiitvnl6i7ckcywaq6xjcxnc2mby",
    ]) {
      assert.equal(parseCid(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("rejects a CID whose declared digest length overruns the string", () => {
    // version 1, dag-pb, sha2-256, but the digest is one byte short.
    const crafted = `b${base32([0x01, 0x70, 0x12, 0x20, ...new Array<number>(31).fill(0)])}`;

    assert.equal(parseCid(crafted), null);
  });

  it("rejects a multihash the browser would not resolve", () => {
    // sha2-512 of 64 bytes: a well-formed CIDv1 whose digest length no gateway
    // path in `web/src/lib/ipfs.ts` will accept, so it must not be seedable.
    const crafted = `b${base32([0x01, 0x70, 0x13, 0x40, ...new Array<number>(64).fill(0)])}`;

    assert.notEqual(parseCid(crafted), null, "it is a real CID");
    assert.match(cidProblem(crafted) ?? "", /not sha2-256/);
    assert.equal(isSeedableCid(crafted), false);
  });

  it("rejects a CIDv1 in a multibase the reader does not handle", () => {
    // The reader resolves exactly two encodings: CIDv0 in base58btc, and CIDv1
    // in base32. A CIDv1 in any other multibase — `z` is base58btc's prefix —
    // is a real CID that `isPlausibleCid` refuses, so seeding one would put an
    // unresolvable string on chain.
    const asBase58 = "zCEW9tc9MMtWPm3PT2szCiVY5XPWj8Gx53HX8AQLvy3h2wTj3n8";

    assert.equal(parseCid(asBase58), null);
    assert.match(cidProblem(asBase58) ?? "", /not a CID/);
  });
});

describe("sameBlock", () => {
  it("treats CIDv0 and a dag-pb CIDv1 as one block", () => {
    // Same multihash, two encodings. A pinning service that records `Qm…` and a
    // repository that computes `bafy…` are describing the same content, and a
    // gateway serves either form.
    assert.equal(sameBlock(HELLO_V0, dagPbFileCidV1(HELLO)), true);
  });

  it("does not treat the raw block of the same bytes as the same block", () => {
    // Different codec, so a different block: nobody pinned this one, and a
    // gateway asked for it answers 404.
    assert.equal(sameBlock(rawCidV1(HELLO), dagPbFileCidV1(HELLO)), false);
    assert.equal(sameBlock(rawCidV1(HELLO), rawCidV1(HELLO)), true);
  });

  it("is false when either side is not a CID at all", () => {
    assert.equal(sameBlock("bafyseededcandidate0", HELLO_V0), false);
    assert.equal(sameBlock(HELLO_V0, "bafyseededcandidate0"), false);
  });
});

describe("cidProblem", () => {
  it("accepts a real CID without complaint", () => {
    for (const cid of [HELLO_V0, dagPbFileCidV1(HELLO), rawCidV1(HELLO)]) {
      assert.equal(cidProblem(cid), null, `should accept ${cid}`);
    }
  });

  it("says how long the value was without quoting it", () => {
    const problem = cidProblem("bafyseededcandidate0");

    assert.match(problem ?? "", /20 characters/);
    assert.ok(!(problem ?? "").includes("bafyseededcandidate0"), "the report must not echo it");
  });

  it("names the empty case rather than reporting a length of zero characters", () => {
    assert.match(cidProblem("") ?? "", /empty/);
  });

  it("tolerates surrounding whitespace, which an env var often carries", () => {
    assert.equal(isSeedableCid(` ${HELLO_V0}\n`), true);
  });
});
