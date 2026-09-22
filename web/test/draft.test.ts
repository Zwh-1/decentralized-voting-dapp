// SPDX-License-Identifier: MIT
/**
 * Tests for the create-poll draft.
 *
 * What is being pinned here is not the JSON shape — that is an implementation
 * detail — but the four promises the form makes to a reader:
 *
 *   1. what was typed comes back after a reload, exactly;
 *   2. a blob this version did not write is IGNORED, not half-read, because a
 *      half-read draft puts values into a transaction the reader never typed;
 *   3. storage that refuses to work is "no draft", never an exception, because
 *      `localStorage` is absent on the server and can throw in a browser;
 *   4. a write that did not happen is reported as not having happened.
 *
 * The storage is a three-method double (`FakeStorage`) rather than the real
 * `localStorage`, so every one of those paths can be forced here — including the
 * ones a browser only produces when it is already broken.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRAFT_RESERVED_KEYS,
  DRAFT_STORAGE_KEY,
  DRAFT_VERSION,
  clearDraft,
  createDraftStore,
  draftBoolean,
  draftStorage,
  draftString,
  draftStringArray,
  readDraft,
  saveDraft,
  type DraftStorage,
} from "../src/lib/draft";

/** How `FakeStorage` breaks, one mode per hazard `localStorage` really has. */
type Failure = "none" | "throw-on-read" | "throw-on-write" | "throw-on-remove" | "quota";

/**
 * An in-memory `DraftStorage`.
 *
 * `throw-on-read` models a browser that has storage disabled: Safari's private
 * mode has thrown from the property access itself, and a policy can do the same.
 * `quota` models a full disk, and only fires on a write — which is the asymmetry
 * the real API has, and the reason `saveDraft` has to catch separately.
 */
class FakeStorage implements DraftStorage {
  readonly entries = new Map<string, string>();
  readonly writes: string[] = [];
  readonly removals: string[] = [];
  reads = 0;
  failure: Failure = "none";

  getItem(key: string): string | null {
    this.reads += 1;
    if (this.failure === "throw-on-read") throw new Error("storage disabled");

    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failure === "quota") throw new Error("QuotaExceededError");
    if (this.failure === "throw-on-write") throw new Error("storage disabled");

    this.writes.push(key);
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failure === "throw-on-remove") throw new Error("storage disabled");

    this.removals.push(key);
    this.entries.delete(key);
  }

  /** Puts raw bytes in the slot, exactly as a hand-edited blob would arrive. */
  seed(raw: string, key: string = DRAFT_STORAGE_KEY): void {
    this.entries.set(key, raw);
  }

  /** The stored blob, for asserting that a write did or did not happen. */
  raw(key: string = DRAFT_STORAGE_KEY): string | undefined {
    return this.entries.get(key);
  }
}

/** The fields a form hands over, in the shape the form uses. */
const FIELDS = {
  question: "社区资金应该先资助哪个提案？",
  options: ["bafkrei…", "直接写的选项"],
  deadline: "2026-10-01T12:00",
  openToAll: true,
  templateId: "multi-select",
};

describe("saveDraft / readDraft round trip", () => {
  it("returns every field that was saved", () => {
    const storage = new FakeStorage();

    assert.equal(saveDraft(storage, FIELDS, DRAFT_STORAGE_KEY, 1_700_000_000_000), true);

    const result = readDraft(storage);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.draft?.fields, FIELDS);
    assert.equal(result.draft?.version, DRAFT_VERSION);
    assert.equal(result.draft?.savedAt, 1_700_000_000_000);
  });

  it("survives JSON's own round trip, including an empty option list", () => {
    const storage = new FakeStorage();

    saveDraft(storage, { options: [], question: "" });

    const fields = readDraft(storage).draft?.fields;
    assert.deepEqual(fields, { options: [], question: "" });
  });

  it("rejects a draft carrying a non-finite number rather than reading it back as something else", () => {
    // `JSON.stringify` turns NaN into null, and null is not a draft scalar, so the
    // blob is refused as a whole on the way back in. Pinned so a future numeric
    // field cannot start storing NaN as null without someone deciding what that
    // should mean — the current answer is "that draft is not readable".
    const storage = new FakeStorage();

    assert.equal(saveDraft(storage, { maybe: Number.NaN }), true);

    const result = readDraft(storage);
    assert.equal(result.status, "rejected");
    assert.equal(result.draft, null);
  });

  it("writes under the key it was given and not a fixed one", () => {
    const storage = new FakeStorage();

    saveDraft(storage, { question: "a" }, "another:key");

    assert.deepEqual(storage.writes, ["another:key"]);
    assert.equal(storage.raw("another:key")?.includes('"a"'), true);
    assert.equal(storage.raw(DRAFT_STORAGE_KEY), undefined);
  });

  it("reports an empty slot as empty rather than as a rejected blob", () => {
    const result = readDraft(new FakeStorage());

    assert.equal(result.status, "empty");
    assert.equal(result.draft, null);
  });

  it("gives the getters the value and the right type", () => {
    const storage = new FakeStorage();
    saveDraft(storage, FIELDS);

    const draft = readDraft(storage).draft;

    assert.equal(draftString(draft, "question"), FIELDS.question);
    assert.equal(draftBoolean(draft, "openToAll"), true);
    assert.deepEqual(draftStringArray(draft, "options"), FIELDS.options);
  });

  it("answers null for a field of the wrong type instead of casting it", () => {
    const storage = new FakeStorage();
    storage.seed(JSON.stringify({ version: DRAFT_VERSION, fields: { options: "not a list" } }));

    const draft = readDraft(storage).draft;

    // The value is a legal draft scalar, so the field itself is accepted — the
    // type check is per getter, per field: a string where a list belongs is not
    // a list, and casting it would put a string into `options`.
    assert.equal(draftString(draft, "options"), "not a list");
    assert.equal(draftStringArray(draft, "options"), null);
    assert.equal(draftBoolean(draft, "options"), null);
    assert.deepEqual(draftStringArray(draft, "missing"), null);
    assert.equal(draftString(draft, "missing"), null);
    assert.equal(draftBoolean(draft, "missing"), null);
  });

  it("refuses a list with a non-string entry whole, rather than shortening it", () => {
    const storage = new FakeStorage();
    storage.seed(JSON.stringify({ version: DRAFT_VERSION, fields: { options: ["a", 7] } }));

    const draft = readDraft(storage).draft;

    assert.equal(draftStringArray(draft, "options"), null);
  });
});

describe("a stored draft is untrusted input", () => {
  it("rejects a blob that is not valid JSON", () => {
    const storage = new FakeStorage();
    storage.seed('{"version":1,"fields":{"question":"half a fi');

    const result = readDraft(storage);

    assert.equal(result.status, "rejected");
    assert.equal(result.draft, null);
  });

  it("rejects an unknown version instead of reading it field by field", () => {
    const storage = new FakeStorage();
    storage.seed(
      JSON.stringify({ version: DRAFT_VERSION + 1, fields: { question: "from the future" } }),
    );

    assert.equal(readDraft(storage).draft, null);

    storage.seed(
      JSON.stringify({ version: DRAFT_VERSION - 1, fields: { question: "from an old" } }),
    );

    assert.equal(readDraft(storage).draft, null);
  });

  it("rejects a blob with no version at all", () => {
    const storage = new FakeStorage();
    storage.seed(JSON.stringify({ fields: { question: "no version" } }));

    assert.equal(readDraft(storage).draft, null);
  });

  it("rejects anything that is not an object with fields", () => {
    const storage = new FakeStorage();

    for (const blob of ['"a string"', "42", "null", "[1,2,3]", '{"version":1}']) {
      storage.seed(blob);
      assert.equal(readDraft(storage).draft, null, blob);
    }

    storage.seed(JSON.stringify({ version: DRAFT_VERSION, fields: [1, 2] }));
    assert.equal(readDraft(storage).draft, null, "fields must be an object, not an array");
  });

  it("rejects a field this module reserves for its own bookkeeping", () => {
    const storage = new FakeStorage();

    for (const reserved of DRAFT_RESERVED_KEYS) {
      storage.seed(JSON.stringify({ version: DRAFT_VERSION, fields: { [reserved]: "shadowed" } }));

      assert.equal(readDraft(storage).draft, null, reserved);
    }
  });

  it("rejects a nested value, which no form field may hold", () => {
    const storage = new FakeStorage();
    const rejected: unknown[] = [{ nested: true }, [["a"]], null];

    for (const value of rejected) {
      storage.seed(JSON.stringify({ version: DRAFT_VERSION, fields: { question: value } }));

      assert.equal(readDraft(storage).draft, null, JSON.stringify(value));
    }

    // An explicit `undefined` serialises to nothing at all, so the field is
    // absent rather than invalid — which is not a rejection, it is an empty
    // draft, and the getters answer null for it either way.
    storage.seed(JSON.stringify({ version: DRAFT_VERSION, fields: { question: undefined } }));
    assert.equal(readDraft(storage).status, "ok");
  });

  it("rejects an unreadable savedAt rather than guessing a time", () => {
    const storage = new FakeStorage();
    storage.seed(JSON.stringify({ version: DRAFT_VERSION, savedAt: "yesterday", fields: {} }));

    assert.equal(readDraft(storage).draft, null);
  });

  it("accepts a blob with no savedAt, reporting it as unknown", () => {
    const storage = new FakeStorage();
    storage.seed(JSON.stringify({ version: DRAFT_VERSION, fields: { question: "a" } }));

    const draft = readDraft(storage).draft;

    assert.equal(draft?.savedAt, null);
    assert.equal(draftString(draft, "question"), "a");
  });
});

describe("storage that refuses to work", () => {
  it("treats absent storage as unavailable and never throws", () => {
    const result = readDraft(null);

    assert.equal(result.status, "unavailable");
    assert.equal(result.draft, null);
  });

  it("reports a read that throws as unavailable instead of propagating", () => {
    const storage = new FakeStorage();
    storage.failure = "throw-on-read";

    const result = readDraft(storage);

    assert.equal(result.status, "unavailable");
    assert.equal(result.draft, null);
  });

  it("returns false for a write that throws, and stores nothing", () => {
    const storage = new FakeStorage();
    storage.failure = "quota";

    assert.equal(saveDraft(storage, FIELDS), false);
    assert.equal(storage.raw(), undefined);
    assert.deepEqual(storage.writes, []);
  });

  it("returns false for a write into absent storage", () => {
    assert.equal(saveDraft(null, FIELDS), false);
  });

  it("returns false for a removal that throws", () => {
    const storage = new FakeStorage();
    saveDraft(storage, FIELDS);
    storage.failure = "throw-on-remove";

    assert.equal(clearDraft(storage), false);
    assert.notEqual(storage.raw(), undefined);
  });

  it("returns false for a removal from absent storage", () => {
    assert.equal(clearDraft(null), false);
  });

  it("does not let a payload it cannot serialise reach setItem", () => {
    const storage = new FakeStorage();
    // A form cannot build this today, but a draft API that silently stored the
    // text "undefined" would read it back as a corrupt blob on the next load.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    assert.equal(saveDraft(storage, cyclic as never), false);
    assert.deepEqual(storage.writes, []);
  });

  it("lets the exception through when the guard is bypassed, which is what it guards", () => {
    // The negative control for the tests above: this is the behaviour the module
    // exists to stop, shown on the same double so the guard cannot be mistaken
    // for the fake being incapable of throwing.
    const storage = new FakeStorage();
    storage.failure = "throw-on-read";

    assert.throws(() => storage.getItem(DRAFT_STORAGE_KEY), /storage disabled/);
  });

  it("resolves no storage during server rendering, without touching window", () => {
    assert.equal(typeof window, "undefined", "node:test runs without a DOM");
    assert.equal(draftStorage(), null);
  });
});

describe("clearDraft", () => {
  it("empties the slot, so the next read is empty rather than rejected", () => {
    const storage = new FakeStorage();
    saveDraft(storage, FIELDS);

    assert.equal(clearDraft(storage), true);
    assert.deepEqual(storage.removals, [DRAFT_STORAGE_KEY]);
    assert.equal(readDraft(storage).status, "empty");
  });

  it("is safe to call when nothing was saved", () => {
    const storage = new FakeStorage();

    assert.equal(clearDraft(storage), true);
    assert.equal(readDraft(storage).draft, null);
  });
});

describe("createDraftStore", () => {
  it("binds one key, so a caller cannot read one slot and write another", () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, "bound:key");

    assert.equal(store.save(FIELDS), true);
    assert.equal(storage.raw("bound:key")?.includes("multi-select"), true);
    assert.deepEqual(store.read().draft?.fields, FIELDS);
    assert.equal(store.clear(), true);
    assert.equal(store.read().status, "empty");
  });

  it("reports the negative outcome on every method when there is no storage", () => {
    const store = createDraftStore(null);

    assert.equal(store.read().status, "unavailable");
    assert.equal(store.save(FIELDS), false);
    assert.equal(store.clear(), false);
  });
});
