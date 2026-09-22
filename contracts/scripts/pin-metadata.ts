// SPDX-License-Identifier: MIT
/**
 * Pins the candidate metadata documents and records the CIDs they came back as.
 *
 * The order matters and is the point. The bytes are read from `metadata/`,
 * uploaded unchanged, and the CID the service returns is **checked against the
 * CID this repository computes for those same bytes** (`scripts/cid.ts`). Only
 * then is the manifest written, and the manifest is what the seed scripts put on
 * chain. So a service that changed the bytes, re-serialised the JSON, wrapped
 * them in a directory, or imported them with a profile this repository cannot
 * reproduce fails here, loudly, before any immutable storage is involved.
 *
 *     pnpm --filter @voting/contracts pin:metadata
 *     pnpm --filter @voting/contracts pin:metadata -- --cid-version=0
 *
 * Credentials come from `contracts/.env`, the same file and the same loader
 * (`hardhat.config.ts`) the deployment credentials use. Either form a Pinata
 * account issues is accepted:
 *
 *     PINATA_JWT=eyJ…                        a JWT
 *     PINATA_API_KEY=… PINATA_SECRET_KEY=…   the key/secret pair
 *
 * Neither value is ever printed. A report that echoes a credential is a report
 * that leaks it into terminals, CI logs and screenshots, so a half-set pair is
 * reported as half-set and never quoted.
 *
 * Running it twice is a no-op: a document whose recorded CID already names the
 * bytes on disk *and* is retrievable is left alone. The retrievability half is
 * not decoration — trusting the record alone would make the manifest
 * self-certifying, which is exactly how a placeholder survived as long as it did
 * with nothing ever asking the network whether it named anything. Pass `--force`
 * to upload again regardless.
 */

import { computedCids, sameBlock } from "./cid";
import { documentContents, existingManifest, writeManifest, type ManifestEntry } from "./metadata";

/**
 * Pinata's pinning endpoint for a single file.
 *
 * The legacy host rather than `uploads.pinata.cloud/v3`, because it is the one
 * endpoint that takes both credential forms above; a newer endpoint would tie the
 * upload to a JWT and make the key/secret pair unusable for no gain here.
 */
const UPLOAD_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

/** A public gateway, used to prove the pinned bytes are retrievable. */
const GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long to keep asking a gateway for freshly pinned content.
 *
 * A gateway can answer 404 for a few seconds after a pin is accepted, and
 * reporting that as "the bytes are not there" would be the same defect as the
 * false "3 gateways unreachable" of ADR-0012: a failure blamed on the wrong
 * party. This waits instead of accusing.
 */
const RETRIEVAL_ATTEMPTS = 5;
const RETRIEVAL_DELAY_MS = 3000;

/**
 * The UnixFS import profile to ask for.
 *
 * `1` is the modern CIDv1 form. It is a request, not an assumption: whatever
 * comes back is compared with `computedCids`, so a profile change at the service
 * is caught rather than silently recorded.
 */
const CID_VERSION =
  process.argv.find((arg) => arg.startsWith("--cid-version="))?.split("=")[1] ?? "1";

const FORCE = process.argv.includes("--force");

function fail(message: string): never {
  throw new Error(message);
}

/** Removes anything credential-shaped from text that came from outside. */
function scrubbed(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9._-]{8,}/g, "<credentials removed>")
    .replace(/Bearer\s+\S+/gi, "Bearer <credentials removed>")
    .slice(0, 200);
}

interface Credentials {
  /** The variable names in use, for the log. Never their values. */
  describe: string;
  headers: Record<string, string>;
}

function credentials(): Credentials {
  const jwt = (process.env.PINATA_JWT ?? "").trim();
  if (jwt.length > 0) {
    return { describe: "PINATA_JWT", headers: { Authorization: `Bearer ${jwt}` } };
  }

  const key = (process.env.PINATA_API_KEY ?? "").trim();
  const secret = (process.env.PINATA_SECRET_KEY ?? "").trim();

  if (key.length > 0 !== secret.length > 0) {
    // `>` binds tighter than `!==`, so this is "exactly one of the two is set" —
    // spelled with the parentheses to keep a reader from having to know that.
    fail(
      `only ${key.length > 0 ? "PINATA_API_KEY" : "PINATA_SECRET_KEY"} is set, and Pinata needs ` +
        `the pair. Set the other one in contracts/.env, or set PINATA_JWT instead of both.`,
    );
  }

  if (key.length > 0) {
    return {
      describe: "PINATA_API_KEY + PINATA_SECRET_KEY",
      headers: { pinata_api_key: key, pinata_secret_api_key: secret },
    };
  }

  fail(
    `no pinning credentials are set, so nothing can be pinned.\n` +
      `Create an API key at https://app.pinata.cloud/developers/api-keys and put either form in ` +
      `contracts/.env, which is git-ignored:\n` +
      `  PINATA_JWT=<jwt>\n` +
      `  PINATA_API_KEY=<key>\n` +
      `  PINATA_SECRET_KEY=<secret>`,
  );
}

async function upload(file: string, bytes: Uint8Array, auth: Credentials): Promise<string> {
  const form = new FormData();

  form.append("file", new File([bytes], file, { type: "application/json" }));
  // Import options for the legacy endpoint, as a JSON string. `wrapWithDirectory:
  // false` is the half that matters: wrapping would return the CID of a
  // *directory* holding the document, which is a different block from the one
  // computed here, and the check below would then refuse a CID that is real but
  // is not the document's.
  form.append(
    "pinataOptions",
    JSON.stringify({ cidVersion: Number(CID_VERSION), wrapWithDirectory: false }),
  );

  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: auth.headers,
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => ({}))) as {
    IpfsHash?: unknown;
    error?: unknown;
    message?: unknown;
  };

  if (!response.ok) {
    // The service's own words say which fault it is — a bad key, a quota, a
    // rejected body — and this project cannot invent them. Scrubbed and
    // truncated, because it is text from outside that may quote the request.
    const reason = (body.error as { reason?: unknown } | undefined)?.reason;
    const detail =
      typeof body.error === "string"
        ? body.error
        : typeof reason === "string"
          ? reason
          : typeof body.message === "string"
            ? body.message
            : "no reason given";

    fail(`the pinning service refused ${file}: HTTP ${response.status} ${scrubbed(detail)}`);
  }

  if (typeof body.IpfsHash !== "string" || body.IpfsHash.length === 0) {
    fail(`the pinning service accepted ${file} but returned no CID`);
  }

  return body.IpfsHash;
}

/** Reads the bytes back through a public gateway, so "pinned" is not a claim. */
async function readBack(cid: string, bytes: Uint8Array): Promise<string | null> {
  try {
    const response = await fetch(`${GATEWAY}${cid}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return `HTTP ${response.status}`;
    }

    const served = new Uint8Array(await response.arrayBuffer());
    if (served.length !== bytes.length) {
      return `the gateway served ${served.length} bytes, the document is ${bytes.length}`;
    }

    for (let i = 0; i < bytes.length; i += 1) {
      if (served[i] !== bytes[i]) {
        return `the gateway served different bytes at offset ${i}`;
      }
    }

    return null;
  } catch (error) {
    return `the gateway could not be reached (${error instanceof Error ? error.name : "unknown"})`;
  }
}

async function retrievable(cid: string, bytes: Uint8Array): Promise<string | null> {
  let problem = "not attempted";

  for (let attempt = 1; attempt <= RETRIEVAL_ATTEMPTS; attempt += 1) {
    problem = await readBack(cid, bytes);
    if (problem === null) {
      return null;
    }

    if (attempt < RETRIEVAL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRIEVAL_DELAY_MS));
    }
  }

  const waited = (RETRIEVAL_ATTEMPTS - 1) * RETRIEVAL_DELAY_MS;

  return `${problem} (after ${RETRIEVAL_ATTEMPTS} attempts over ${waited} ms)`;
}

const auth = credentials();
const documents = await documentContents();
const recorded = await existingManifest();

console.log(
  `Pinning ${documents.length} candidate document(s) to public IPFS\n` +
    `  credentials  ${auth.describe}\n` +
    `  cid_version  ${CID_VERSION}${FORCE ? " (--force)" : ""}\n`,
);

const manifest: ManifestEntry[] = [];

for (const document of documents) {
  const computed = computedCids(document.bytes);
  const already = recorded.find((entry) => entry.file === document.file)?.cid;
  const known =
    already !== undefined &&
    (sameBlock(already, computed.dagPb) || sameBlock(already, computed.raw));

  let cid: string | undefined;
  let verified = false;

  if (already !== undefined && known && !FORCE) {
    // A recorded CID is only worth reusing if the content is actually there.
    const problem = await retrievable(already, document.bytes);

    if (problem === null) {
      cid = already;
      verified = true;
      console.log(`${document.file}\n  cid      ${cid} (already recorded and retrievable)`);
    } else {
      console.log(`${document.file}\n  recorded ${already} is not retrievable (${problem})`);
    }
  }

  if (cid === undefined) {
    cid = await upload(document.file, document.bytes, auth);

    if (!sameBlock(cid, computed.dagPb) && !sameBlock(cid, computed.raw)) {
      fail(
        `${document.file} came back with a CID this repository cannot reproduce.\n` +
          `  returned   ${cid}\n` +
          `  dag-pb     ${computed.dagPb}\n` +
          `  raw        ${computed.raw}\n` +
          `Either the bytes changed in transit, or the service imported them with a profile ` +
          `scripts/cid.ts does not model (a wrapped directory, for instance). A CID nobody can ` +
          `recompute cannot be checked, so it is not recorded.`,
      );
    }

    console.log(`${document.file}\n  cid      ${cid} (uploaded)`);
  }

  if (!verified) {
    const problem = await retrievable(cid, document.bytes);
    if (problem !== null) {
      fail(`${cid} was accepted by the service but is not retrievable: ${problem}`);
    }

    console.log(`  gateway  ${GATEWAY}${cid} (bytes match)`);
  }

  manifest.push({ file: document.file, cid });
}

await writeManifest(manifest);

const unchanged =
  recorded.length === manifest.length &&
  recorded.every(
    (entry, index) => entry.file === manifest[index]!.file && entry.cid === manifest[index]!.cid,
  );

console.log(
  unchanged
    ? `\nmetadata/manifest.json is unchanged; the recorded CIDs already name these documents.`
    : `\nwrote metadata/manifest.json with ${manifest.length} entries; commit it with the documents.`,
);

console.log(
  `\nPoint the browser at the gateway these are pinned to, so a card does not try the ` +
    `unreachable defaults first:\n  web/.env: NEXT_PUBLIC_IPFS_GATEWAY=${GATEWAY}\n` +
    `(NEXT_PUBLIC_* is inlined at build time — a rebuild is what applies it.)`,
);
