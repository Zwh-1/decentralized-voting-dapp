// SPDX-License-Identifier: MIT
/**
 * An unfinished form, kept in the browser so a reload does not discard it.
 *
 * ---------------------------------------------------------------------------
 * Why this is a pure module with the storage passed in
 * ---------------------------------------------------------------------------
 *
 * The rules this file owns are exactly the ones a rendered page cannot show:
 * whether a half-filled form survives a refresh, what happens when the browser
 * refuses to store it, and what happens when the stored bytes are not what this
 * version wrote. None of those can be observed in a component test without a
 * real browser, and none of them can be observed in a browser without breaking
 * something first. So the storage is an injected interface (`DraftStorage`, which
 * the global `localStorage` satisfies structurally) and the whole module is
 * callable with a plain object — see `web/test/draft.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * Why every storage failure is "no draft" rather than an exception
 * ---------------------------------------------------------------------------
 *
 * `localStorage` is not a dependable API in a browser. It is ABSENT during server
 * rendering, and `window.localStorage` itself can THROW on access when the
 * browser has storage disabled (Safari private browsing has done this, and so do
 * some enterprise policies). A read that throws is not a bug in the caller — it
 * is a browser saying no. This module therefore catches around every access and
 * reports the outcome, so the page renders an empty form instead of dying. The
 * same reasoning applies to a QUOTA_EXCEEDED write: the reader's form is still
 * valid, it just cannot be remembered.
 *
 * ---------------------------------------------------------------------------
 * Why a stored draft is treated as hostile input
 * ---------------------------------------------------------------------------
 *
 * Whoever wrote the bytes was the browser, but the bytes are not trustworthy:
 * they may be from a previous version of this app, hand-edited in devtools, or
 * truncated garbage. Injecting them into a form would put values the reader never
 * typed into a transaction they are about to sign. So `readDraft` VALIDATES the
 * shape field by field, treats any mismatch as "no draft", and refuses a
 * `version` it does not recognise. The persisted `version` exists precisely so
 * that a future change of shape is rejected loudly instead of being half-read.
 *
 * ---------------------------------------------------------------------------
 * Why metadata keys are rejected
 * ---------------------------------------------------------------------------
 *
 * `version` and `savedAt` are this module's own bookkeeping, so a form field may
 * not use those names: a draft whose `fields` contained `version` would have two
 * different meanings for one key and one of them would win silently. Rather than
 * reserve the names in prose and hope, `readDraft` refuses such a blob.
 */

/** The one key this app keeps a create-poll draft under. */
export const DRAFT_STORAGE_KEY = "voting:create-poll:draft";

/**
 * The shape version of what is stored.
 *
 * Bump this whenever the draft's field names or meanings change. An older or
 * newer blob is then rejected as a whole rather than read field by field, which
 * is the only safe way to change a persisted format: partial reads of a changed
 * shape produce a form that is half old values and half defaults, and nobody can
 * tell which half is which.
 */
export const DRAFT_VERSION = 1;

/** The two keys `fields` may not contain, because this module uses them. */
export const DRAFT_RESERVED_KEYS = ["version", "savedAt"] as const;

/**
 * The slice of the Web Storage API a draft needs.
 *
 * Deliberately narrow: `getItem`, `setItem` and `removeItem` are all this module
 * calls, so a test double is three lines and the global `localStorage` still
 * satisfies it. `Storage` itself would drag in `length` and `key()`, which a
 * draft never uses and which a double would then have to fake.
 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The scalar values a draft field may hold. No nested objects, no null. */
export type DraftValue = string | number | boolean;

/** What a form hands over to be persisted: flat, scalar, and nothing else. */
export type DraftFields = Record<string, DraftValue | DraftValue[]>;

/** A draft that was read back and passed validation. */
export interface Draft {
  /** The version that was stored, which is always `DRAFT_VERSION` here. */
  version: number;
  /** When it was written, in epoch milliseconds. Absent if the blob had none. */
  savedAt: number | null;
  /**
   * The form values, under the keys the writer supplied.
   *
   * A value is what JSON can round-trip, which is not quite what the writer
   * passed: `NaN` and `Infinity` are legal `number`s here and are serialised as
   * `null`, which this module then refuses — as the whole draft, not as the one
   * field, because a value it cannot read is a value it must not half-trust.
   * Every field this app stores is a string, a boolean or a list of strings, so
   * nothing readable is lost.
   */
  fields: DraftFields;
}

/** How a read ended. `"unavailable"` means storage refused to be touched. */
export type DraftReadStatus = "empty" | "ok" | "rejected" | "unavailable";

/**
 * What `readDraft` returns.
 *
 * A missing draft is the ordinary outcome, so it is a result rather than an
 * exception: the caller renders an empty form either way. `status` is there so a
 * problem the reader can act on (storage that throws) can be told apart from the
 * ordinary "there is nothing saved yet".
 */
export type DraftReadResult =
  { draft: null; status: "empty" | "rejected" | "unavailable" } | { draft: Draft; status: "ok" };

/** Whether `value` is a scalar a draft field is allowed to hold. */
function isDraftValue(value: unknown): value is DraftValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Whether a parsed field value has the persisted shape.
 *
 * A scalar or an array of scalars, and nothing else — no nested objects, no
 * `null`, no arrays of arrays. Arrays are allowed because a form legitimately
 * holds one (the option list) and JSON preserves them.
 */
function isDraftFieldValue(value: unknown): value is DraftValue | DraftValue[] {
  if (isDraftValue(value)) return true;

  return Array.isArray(value) && value.every(isDraftValue);
}

/**
 * Validates one parsed blob into a `Draft`, or `null`.
 *
 * Every rejection reason returns the same thing — `null` — because the caller
 * must treat them all identically: use the defaults. Naming the reason to the
 * reader is not useful here ("your draft is corrupt" asks them to do something
 * about a value they cannot inspect), and reporting it is the job of the
 * `rejected` status.
 */
function parseDraft(parsed: unknown): Draft | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;

  // An unknown version is refused, not migrated. There is no previous version to
  // migrate FROM yet; when there is one, the migration belongs here and must be
  // written deliberately rather than falling out of a field-by-field read.
  if (record["version"] !== DRAFT_VERSION) return null;

  const rawSavedAt = record["savedAt"];
  let savedAt: number | null = null;
  if (rawSavedAt !== undefined) {
    if (typeof rawSavedAt !== "number" || !Number.isFinite(rawSavedAt)) return null;
    savedAt = rawSavedAt;
  }

  const rawFields = record["fields"];
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) return null;

  const fields: DraftFields = {};

  for (const [name, value] of Object.entries(rawFields)) {
    if ((DRAFT_RESERVED_KEYS as readonly string[]).includes(name)) return null;
    if (name.length === 0) return null;
    if (!isDraftFieldValue(value)) return null;

    fields[name] = value;
  }

  return { version: DRAFT_VERSION, savedAt, fields };
}

/**
 * The `localStorage` a draft may use, or `null` when there is none.
 *
 * Two separate hazards, both handled here rather than at each call site:
 * server rendering has no `window` at all, and a browser with storage disabled
 * throws on the property access itself. Neither is an error worth propagating.
 */
export function draftStorage(): DraftStorage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    // Storage disabled by policy. Treated as "there is nowhere to save", which
    // is what it is; the form still works, it just cannot be remembered.
    return null;
  }
}

/**
 * Reads the draft, validating everything it finds.
 *
 * Never throws. A missing key, a malformed blob, an unknown version and storage
 * that refuses to be read all come back as `draft: null`, because in every one of
 * those cases the only correct thing for a form to do is start from its defaults.
 */
export function readDraft(
  storage: DraftStorage | null,
  key: string = DRAFT_STORAGE_KEY,
): DraftReadResult {
  if (storage === null) return { draft: null, status: "unavailable" };

  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { draft: null, status: "unavailable" };
  }

  if (raw === null) return { draft: null, status: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated or hand-edited bytes. Not worth logging: the reader cannot act
    // on it, and the form it produces is the same one an empty slot produces.
    return { draft: null, status: "rejected" };
  }

  const draft = parseDraft(parsed);

  return draft === null ? { draft: null, status: "rejected" } : { draft, status: "ok" };
}

/**
 * Writes the draft, reporting whether it was actually stored.
 *
 * The boolean is the point. `false` means the values are NOT saved, and a caller
 * that tells the reader "已保存草稿" on a `false` would be claiming something the
 * browser refused to do. Callers must branch on this rather than assume.
 */
export function saveDraft(
  storage: DraftStorage | null,
  fields: DraftFields,
  key: string = DRAFT_STORAGE_KEY,
  now: number = Date.now(),
): boolean {
  if (storage === null) return false;

  // A payload this module cannot read back is not worth writing. `JSON.stringify`
  // returns `undefined` (not a string) for a value it cannot represent, and
  // `setItem` would then store the literal text "undefined".
  let payload: string | undefined;
  try {
    payload = JSON.stringify({ version: DRAFT_VERSION, savedAt: now, fields });
  } catch {
    return false;
  }

  if (payload === undefined) return false;

  try {
    storage.setItem(key, payload);
    return true;
  } catch {
    // Quota exceeded, or storage disabled between the read and this write.
    return false;
  }
}

/** Removes the draft, reporting whether the slot is now empty. */
export function clearDraft(storage: DraftStorage | null, key: string = DRAFT_STORAGE_KEY): boolean {
  if (storage === null) return false;

  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads one field out of a draft.
 *
 * The getters below exist instead of casting `draft.fields["question"]` at each
 * call site, because `noUncheckedIndexedAccess` makes every index a `T | undefined`
 * — and using a non-null assertion to quiet that would be the one place where a
 * corrupt blob could reach the form. Each getter takes the `Draft | null` that
 * `readDraft` returned, so the null case has a single spelling.
 */

/** The stored string, or `null` when the field is absent or not a string. */
export function draftString(draft: Draft | null, field: string): string | null {
  const value = draft?.fields[field];

  return typeof value === "string" ? value : null;
}

/** The stored boolean, or `null` when the field is absent or not a boolean. */
export function draftBoolean(draft: Draft | null, field: string): boolean | null {
  const value = draft?.fields[field];

  return typeof value === "boolean" ? value : null;
}

/**
 * The stored list of strings, or `null` when the field is absent or has any
 * non-string entry. A partially-valid option list is refused whole: keeping the
 * strings and dropping the rest would silently shorten a ballot.
 */
export function draftStringArray(draft: Draft | null, field: string): string[] | null {
  const value = draft?.fields[field];
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === "string")) return null;

  return value;
}

/**
 * A draft bound to one storage slot, for a component that wants the key in one
 * place.
 *
 * `storage` may be `null` (no `window`, or storage disabled). Every method then
 * reports the negative outcome rather than throwing, so the component needs no
 * null check of its own.
 */
export interface DraftStore {
  read(): DraftReadResult;
  save(fields: DraftFields): boolean;
  clear(): boolean;
}

/** Binds the draft functions to one storage and key. */
export function createDraftStore(
  storage: DraftStorage | null,
  key: string = DRAFT_STORAGE_KEY,
): DraftStore {
  return {
    read: () => readDraft(storage, key),
    save: (fields) => saveDraft(storage, fields, key),
    clear: () => clearDraft(storage, key),
  };
}
