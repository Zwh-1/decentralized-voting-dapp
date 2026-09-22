// SPDX-License-Identifier: MIT
/**
 * The manifest is the only record of what a ballot's CIDs actually name, so it
 * is checked rather than trusted.
 *
 * The regression these guard is exact and was on chain: a seeded ballot named
 * `bafyseededcandidate0`, a string no gateway could resolve and no test could
 * contradict, because nothing in the repository connected a CID to bytes. So
 * every case below is about the *link*: the manifest entry vs. the document
 * beside it, the file list vs. the manifest, and the committed formatting vs.
 * what the writer produces (ADR-0010, because a regenerated manifest that
 * differs only in formatting is a diff nobody can act on).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { computedCids, dagPbFileCidV1, sameBlock } from "../scripts/cid";
import {
  MANIFEST_NAME,
  METADATA_DIR,
  documentContents,
  manifestProblems,
  readManifest,
  seedableCids,
  writeManifest,
  type ManifestEntry,
} from "../scripts/metadata";

const temporary: string[] = [];

/** A directory holding the given documents and manifest, removed after the run. */
async function fixture(documents: Record<string, string>, manifest: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "voting-metadata-"));
  temporary.push(directory);

  for (const [file, body] of Object.entries(documents)) {
    await writeFile(path.join(directory, file), body, "utf8");
  }
  if (manifest !== undefined) {
    await writeFile(path.join(directory, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");
  }

  return directory;
}

after(async () => {
  for (const directory of temporary) {
    await rm(directory, { recursive: true, force: true });
  }
});

const ONE = `{\n  "name": "林澈",\n  "slogan": "把预算花在看得见的地方"\n}\n`;

describe("the repository's own metadata", () => {
  it("records, for every document, the CID of exactly those bytes", async () => {
    // This is the check that cannot pass for a placeholder: the CID has to be
    // the hash of a file that exists.
    assert.deepEqual(await manifestProblems(), []);
  });

  it("offers one seedable CID per document, in file order", async () => {
    const cids = await seedableCids();
    const documents = await documentContents();
    const manifest = await readManifest();

    assert.equal(cids.length, documents.length);
    assert.ok(cids.length > 0, "a ballot with no candidates cannot be started");
    assert.deepEqual(
      cids,
      manifest.candidates.map((entry) => entry.cid),
      "the seed order is the manifest order, which is the document order",
    );

    for (const [index, document] of documents.entries()) {
      const { dagPb, raw } = computedCids(document.bytes);

      assert.ok(
        sameBlock(cids[index]!, dagPb) || sameBlock(cids[index]!, raw),
        `${document.file}: ${cids[index]} names neither form of these bytes`,
      );
    }
  });

  it("gives every candidate a name the card can render", async () => {
    for (const document of await documentContents()) {
      assert.equal(typeof document.metadata.name, "string");
      assert.ok(document.metadata.name.length > 0, `${document.file} has no name`);
    }
  });
});

describe("manifestProblems", () => {
  it("catches a document edited after it was pinned", async () => {
    const body = `{\n  "name": "改过的名字"\n}\n`;
    const directory = await fixture(
      { "candidate-1.json": body },
      {
        candidates: [
          { file: "candidate-1.json", cid: dagPbFileCidV1(new TextEncoder().encode(ONE)) },
        ],
      },
    );

    const problems = await manifestProblems(directory);

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /candidate-1\.json/);
    assert.match(problems[0]!, /does not name these bytes/);
    assert.match(problems[0]!, /Re-pin it, or revert the edit/);
  });

  it("catches a document nobody pinned", async () => {
    const directory = await fixture(
      { "candidate-1.json": ONE, "candidate-2.json": `{\n  "name": "周予安"\n}\n` },
      {
        candidates: [
          { file: "candidate-1.json", cid: dagPbFileCidV1(new TextEncoder().encode(ONE)) },
        ],
      },
    );

    const problems = await manifestProblems(directory);

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /candidate-2\.json: is not in manifest\.json/);
  });

  it("catches the exact placeholder that reached a live ballot", async () => {
    // `bafyseededcandidate0` in a manifest is how the defect started, so the
    // check has to name the shape rather than let it through to the contract.
    const directory = await fixture(
      { "candidate-1.json": ONE },
      {
        candidates: [{ file: "candidate-1.json", cid: "bafyseededcandidate0" }],
      },
    );

    const problems = await manifestProblems(directory);

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /the manifest CID it is not a CID/);
  });

  it("catches a manifest entry with no document", async () => {
    const directory = await fixture(
      {},
      {
        candidates: [
          { file: "candidate-9.json", cid: "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o" },
        ],
      },
    );

    const problems = await manifestProblems(directory);

    assert.equal(problems.length, 1);
    assert.match(
      problems[0]!,
      /candidate-9\.json: is named in manifest\.json but not in the directory/,
    );
  });

  it("catches a document that could never render", async () => {
    const nameless = `{\n  "slogan": "没有名字"\n}\n`;
    const directory = await fixture(
      { "candidate-1.json": nameless },
      {
        candidates: [
          { file: "candidate-1.json", cid: dagPbFileCidV1(new TextEncoder().encode(nameless)) },
        ],
      },
    );

    const problems = await manifestProblems(directory);

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /"name" must be a non-empty string/);
  });

  it("reports nothing for a document and its recorded CID", async () => {
    const directory = await fixture(
      { "candidate-1.json": ONE },
      {
        candidates: [
          { file: "candidate-1.json", cid: dagPbFileCidV1(new TextEncoder().encode(ONE)) },
        ],
      },
    );

    assert.deepEqual(await manifestProblems(directory), []);
  });
});

describe("readManifest", () => {
  it("says how to produce a missing manifest instead of guessing CIDs", async () => {
    const directory = await fixture({ "candidate-1.json": ONE }, undefined);

    await assert.rejects(readManifest(directory), /pin:metadata/);
  });

  it("refuses an empty candidate list", async () => {
    const directory = await fixture({}, { candidates: [] });

    await assert.rejects(readManifest(directory), /no "candidates" array/);
  });
});

describe("writeManifest", () => {
  it("writes the committed file byte for byte", async () => {
    // The CI check is `git diff --exit-code` after regenerating, so "regenerating
    // changes nothing" has to be true of the bytes, not of the parsed JSON.
    const entries: ManifestEntry[] = (await readManifest()).candidates;
    const directory = await mkdtemp(path.join(tmpdir(), "voting-manifest-"));
    temporary.push(directory);

    await writeManifest(entries, directory);

    const written = await readFile(path.join(directory, MANIFEST_NAME), "utf8");
    const committed = await readFile(path.join(METADATA_DIR, MANIFEST_NAME), "utf8");

    assert.equal(written, committed);
  });

  it("keeps volatile fields out of the record", async () => {
    // ADR-0010: a re-pin that only changed a timestamp would otherwise show up
    // as a diff, and a diff nobody can act on trains the reader to ignore them.
    const committed = await readFile(path.join(METADATA_DIR, MANIFEST_NAME), "utf8");

    for (const volatile of ["pinnedAt", "timestamp", "gateway", "uploadedAt"]) {
      assert.ok(!committed.includes(volatile), `the manifest must not carry ${volatile}`);
    }
  });
});
