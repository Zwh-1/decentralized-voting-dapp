// SPDX-License-Identifier: MIT
/**
 * Computing and parsing the CIDs that name the candidate metadata documents.
 *
 * Why this module exists at all, and why it is written by hand rather than
 * pulled from `multiformats`:
 *
 * The ballots this repository has seeded so far carry `bafyseededcandidate0`,
 * which is not a CID — twenty characters, including `s`, which is not even in
 * the base32 alphabet the `b` multibase prefix promises. Every layer told the
 * truth about it, and the only reason it existed is that the CID was *typed*
 * rather than *computed*. A hand-typed CID is a claim; a computed one is a
 * consequence of the bytes, and only the second can be checked.
 *
 * So the seed path now derives its CIDs from the documents it seeds, and this
 * file is the derivation. It is a few dozen lines of pure encoding against
 * `node:crypto`, verified two ways that do not depend on trusting it:
 * `test/cid.ts` pins the well-known `QmT78z…` vector (the CID of the twelve
 * bytes `hello world\n`), and `scripts/pin-metadata.ts` refuses to accept a
 * CID back from the pinning service unless it equals what this module computes
 * for the same bytes. A bug here would have to reproduce both.
 *
 * Strictness is deliberately asymmetric with the browser. `web/src/lib/ipfs.ts`
 * only checks the *shape* of a CID, because a reader must not reject data that
 * is merely unusual (that was defect ADR-0012 recorded: a valid `bafk…` CID was
 * reported to the user as malformed). A writer has the opposite duty — it must
 * not put a string on chain that no reader can resolve — so this parses the
 * bytes and refuses anything that is not a well-formed CIDv0 or CIDv1.
 */

import { createHash } from "node:crypto";

/** base32 lowercase, RFC 4648 without padding — the alphabet `b` selects. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** base58btc — the alphabet CIDv0 uses. */
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** multicodec `raw`: the bytes of one block, with no envelope around them. */
export const RAW_CODEC = 0x55;

/** multicodec `dag-pb`: the node envelope a UnixFS file is wrapped in. */
export const DAG_PB_CODEC = 0x70;

/** multihash `sha2-256`, and the digest length it implies. */
const SHA2_256 = 0x12;
const SHA2_256_BYTES = 32;

/** A CID this module has decoded, field by field. */
export interface ParsedCid {
  version: 0 | 1;
  /** The multicodec of the block it addresses. */
  codec: number;
  /** The multihash function, `0x12` for sha2-256. */
  hash: number;
  digest: Uint8Array;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

/** Unsigned LEB128, which is what every multiformats length field is. */
function varint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;

  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);

  return Uint8Array.from(out);
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let index = at;

  while (index < bytes.length) {
    const byte = bytes[index]!;
    value += (byte & 0x7f) * 2 ** shift;
    index += 1;

    if ((byte & 0x80) === 0) {
      return { value, next: index };
    }

    shift += 7;
    if (shift > 49) {
      return null; // longer than a 64-bit field: not a length this format uses
    }
  }

  return null;
}

function base32Lower(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 0x1f]!;
    }
  }

  if (bits > 0) {
    out += BASE32[(buffer << (5 - bits)) & 0x1f]!;
  }

  return out;
}

function base32Decode(text: string): Uint8Array | null {
  let out: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of text) {
    const value = BASE32.indexOf(character);
    if (value === -1) {
      return null;
    }

    buffer = (buffer << 5) | value;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(out);
}

function base58btc(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)]! + out;
    value /= 58n;
  }

  // Leading zero bytes are leading `1`s, not part of the number.
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    out = `1${out}`;
  }

  return out;
}

function base58btcDecode(text: string): Uint8Array | null {
  let value = 0n;

  for (const character of text) {
    const digit = BASE58.indexOf(character);
    if (digit === -1) {
      return null;
    }

    value = value * 58n + BigInt(digit);
  }

  const out: number[] = [];
  while (value > 0n) {
    out.unshift(Number(value % 256n));
    value /= 256n;
  }

  for (const character of text) {
    if (character !== "1") {
      break;
    }
    out.unshift(0);
  }

  return Uint8Array.from(out);
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** `0x12 || 0x20 || digest` — a sha2-256 multihash. */
function multihash(digest: Uint8Array): Uint8Array {
  if (digest.length !== SHA2_256_BYTES) {
    throw new Error(`a sha2-256 digest is ${SHA2_256_BYTES} bytes, got ${digest.length}`);
  }

  return concat([Uint8Array.of(SHA2_256, SHA2_256_BYTES), digest]);
}

/**
 * The UnixFS `Data` message for a file that fits in a single chunk.
 *
 *     message Data {
 *       required DataType Type   = 1;   // 2 = File
 *       optional bytes    Data   = 2;
 *       optional uint64   filesize = 3;
 *     }
 *
 * Fields are emitted in ascending field order and nothing optional-but-empty is
 * written, which is the canonical form `ipfs add` produces — so a gateway that
 * re-encodes the block arrives at the same bytes, and therefore the same CID.
 * Every document this project seeds is well under the 256 KiB chunk boundary,
 * so the multi-chunk case (Links, blocksizes) does not arise; `dagPbFileCid`
 * refuses anything larger rather than silently producing a CID for a different
 * layout than the pinning service would.
 */
function unixfsFileData(bytes: Uint8Array): Uint8Array {
  return concat([
    Uint8Array.of(0x08),
    varint(2), // Type = File
    Uint8Array.of(0x12),
    varint(bytes.length),
    bytes, // Data
    Uint8Array.of(0x18),
    varint(bytes.length), // filesize
  ]);
}

/** The `PBNode` envelope: one optional `Data` field, no links. */
function dagPbNode(file: Uint8Array): Uint8Array {
  const data = unixfsFileData(file);

  return concat([Uint8Array.of(0x0a), varint(data.length), data]);
}

/** Largest file this module encodes the way `ipfs add` would. */
export const SINGLE_CHUNK_LIMIT = 262_144;

function assertSingleChunk(bytes: Uint8Array): void {
  if (bytes.length > SINGLE_CHUNK_LIMIT) {
    throw new Error(
      `a ${bytes.length}-byte document exceeds the ${SINGLE_CHUNK_LIMIT}-byte single-chunk ` +
        `limit: it would be chunked across several blocks, and this encoder only models the ` +
        `single-block form`,
    );
  }
}

function cidV1(codec: number, digest: Uint8Array): string {
  return `b${base32Lower(concat([Uint8Array.of(1), varint(codec), multihash(digest)]))}`;
}

/** The UnixFS file CID of `bytes`, as CIDv0 (`Qm…`). */
export function dagPbFileCidV0(bytes: Uint8Array): string {
  assertSingleChunk(bytes);

  return base58btc(multihash(sha256(dagPbNode(bytes))));
}

/** The same block as `dagPbFileCidV0`, as a CIDv1 in base32 (`bafy…`). */
export function dagPbFileCidV1(bytes: Uint8Array): string {
  assertSingleChunk(bytes);

  return cidV1(DAG_PB_CODEC, sha256(dagPbNode(bytes)));
}

/**
 * The CID of the bare bytes as one raw block (`bafk…`).
 *
 * This is the form an uploader produces when it stores a file as a single raw
 * block rather than wrapping it in UnixFS, and a gateway serves both alike.
 */
export function rawCidV1(bytes: Uint8Array): string {
  return cidV1(RAW_CODEC, sha256(bytes));
}

/** Every CID form this project will accept for a document, in a fixed order. */
export function computedCids(bytes: Uint8Array): { dagPb: string; raw: string } {
  return { dagPb: dagPbFileCidV1(bytes), raw: rawCidV1(bytes) };
}

/**
 * Decodes a CID, or returns `null` when the text is not one.
 *
 * Two forms are accepted because they are the two the browser can resolve
 * (`isPlausibleCid`): CIDv0 in base58btc, and CIDv1 in base32. A CIDv1 in some
 * other multibase is a real CID, but the reader would reject it, so seeding one
 * would put an unresolvable string on chain — the exact failure this module is
 * here to prevent. `bafyseededcandidate0` fails at the base32 alphabet.
 */
export function parseCid(text: string): ParsedCid | null {
  if (text.startsWith("Qm")) {
    const bytes = base58btcDecode(text);
    if (bytes === null || bytes.length !== 2 + SHA2_256_BYTES) {
      return null;
    }
    if (bytes[0] !== SHA2_256 || bytes[1] !== SHA2_256_BYTES) {
      return null;
    }

    return { version: 0, codec: DAG_PB_CODEC, hash: SHA2_256, digest: bytes.slice(2) };
  }

  if (!text.startsWith("b")) {
    return null;
  }

  const bytes = base32Decode(text.slice(1));
  if (bytes === null || bytes.length < 2) {
    return null;
  }

  const version = readVarint(bytes, 0);
  if (version === null || version.value !== 1) {
    return null;
  }

  const codec = readVarint(bytes, version.next);
  if (codec === null) {
    return null;
  }

  const hash = readVarint(bytes, codec.next);
  if (hash === null) {
    return null;
  }

  const length = readVarint(bytes, hash.next);
  if (length === null || length.next + length.value !== bytes.length) {
    return null;
  }

  return {
    version: 1,
    codec: codec.value,
    hash: hash.value,
    digest: bytes.slice(length.next),
  };
}

/**
 * Why `text` cannot be seeded as a candidate CID, or `null` when it can.
 *
 * The message names the shape and never quotes the value (ADR-0016): a CID is
 * public, but the same report is produced for anything a caller passes here, and
 * a rule that only sometimes withholds a value is not a rule.
 */
export function cidProblem(text: string): string | null {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return "the value is empty";
  }

  const parsed = parseCid(trimmed);
  if (parsed === null) {
    return (
      `it is not a CID (${trimmed.length} character${trimmed.length === 1 ? "" : "s"}). ` +
      `A CID is either 46 characters of base58 starting with "Qm", or a CIDv1 in base32: ` +
      `"b" followed by 58 base32 characters (a-z, 2-7).`
    );
  }

  if (parsed.hash !== SHA2_256 || parsed.digest.length !== SHA2_256_BYTES) {
    return (
      `it is a CIDv${parsed.version} whose multihash is not sha2-256/32 bytes, so the browser ` +
      `would refuse to resolve it`
    );
  }

  return null;
}

/** True when `text` is a CID the browser will actually try to resolve. */
export function isSeedableCid(text: string): boolean {
  return cidProblem(text) === null;
}

/**
 * Whether two CIDs address the same block.
 *
 * CIDv0 and a dag-pb CIDv1 are two encodings of one block — the multihash is
 * byte for byte identical — so a pinning service that recorded `Qm…` and a
 * repository that computed `bafy…` are describing the same content, and a
 * gateway serves either form. Comparing the strings would call that a mismatch
 * and reject a CID that is correct, which is the same mistake as reporting a
 * valid `bafk…` as malformed: a check that is too narrow blaming the data.
 *
 * The raw-codec CID of the same bytes is a *different* block and must not
 * compare equal: nothing pinned that block, so no gateway can serve it.
 */
export function sameBlock(a: string, b: string): boolean {
  const left = parseCid(a);
  const right = parseCid(b);

  return (
    left !== null &&
    right !== null &&
    left.codec === right.codec &&
    left.hash === right.hash &&
    left.digest.length === right.digest.length &&
    left.digest.every((byte, index) => byte === right.digest[index])
  );
}
