// SPDX-License-Identifier: MIT
/**
 * The global audit view: every event this index has recorded, across every poll.
 *
 * ---------------------------------------------------------------------------
 * Why the filters are parsed here and not in the route
 * ---------------------------------------------------------------------------
 *
 * `?kind=whatever` is a caller mistake, and the two ways to handle it are not
 * equivalent. Defaulting to "all kinds" makes a broken link look like a working
 * one, and the reader has no way to know their filter was ignored — the same
 * mistake `?sort=` is refused for on the poll list. So an unknown kind is named
 * back to the caller, and the accepted values are listed in the message.
 *
 * Addresses are validated by SHAPE only (20 bytes of hex), because that is all
 * that can be checked without a query: whether the address was ever a poll is a
 * question for the database, and answering it here would mean a second read to
 * produce an error the empty result already communicates.
 *
 * ---------------------------------------------------------------------------
 * Why this is separate from `poll-report.ts`
 * ---------------------------------------------------------------------------
 *
 * `poll-report.ts` owns one poll's history and the export formats built from it.
 * This owns the cross-poll view and its filters. They share the entry SHAPE but
 * not the rules, and folding them together would put "which poll" into a module
 * whose whole contract is "already scoped to one poll".
 */

import { DEFAULT_LOCALE, translatorFor, type Locale } from "./i18n";
import type { ActivityEntry } from "./poll-report";

/** The event kinds the index records, as `ActivityEntry.kind` names them. */
export const AUDIT_KINDS = [
  "cast",
  "changed",
  "withdrawn",
  "refunded",
  "whitelist",
  "phase",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

/** True when `value` names a kind the index records. */
export function isAuditKind(value: string): value is AuditKind {
  return (AUDIT_KINDS as readonly string[]).includes(value);
}

/** One audit row: an ordinary activity entry plus the poll it belongs to. */
export interface AuditEntry extends ActivityEntry {
  /** The poll this happened to. Always present here, unlike in a poll's own feed. */
  pollAddress: string;
}

/** What a caller asked to see. Every field is optional: no filter means everything. */
export interface AuditFilters {
  /** Restrict to one poll. */
  poll: string | null;
  /** Restrict to events naming one address (voter, or the creator on a phase row). */
  actor: string | null;
  /** Restrict to one event kind. */
  kind: AuditKind | null;
}

/** The message shown for a rejected filter, or the parsed filters. */
export type AuditFilterResult =
  { ok: true; filters: AuditFilters } | { ok: false; error: string; message: string };

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Reads the three filters out of a query string.
 *
 * Empty string counts as absent, so `?poll=&actor=` is the same request as no
 * parameters at all. That matters for a form that submits every field: a blank
 * input must not be read as "filter by the empty address", which would match
 * nothing and look like the index is broken.
 */
export function parseAuditFilters(params: URLSearchParams): AuditFilterResult {
  const rawPoll = params.get("poll")?.trim() ?? "";
  const rawActor = params.get("actor")?.trim() ?? "";
  const rawKind = params.get("kind")?.trim() ?? "";

  if (rawPoll.length > 0 && !ADDRESS_PATTERN.test(rawPoll)) {
    return {
      ok: false,
      error: "invalid_poll",
      message: "The poll filter must be a 20 byte hex address.",
    };
  }

  if (rawActor.length > 0 && !ADDRESS_PATTERN.test(rawActor)) {
    return {
      ok: false,
      error: "invalid_actor",
      message: "The actor filter must be a 20 byte hex address.",
    };
  }

  if (rawKind.length > 0 && !isAuditKind(rawKind)) {
    return {
      ok: false,
      error: "invalid_kind",
      message: `Unknown event kind "${rawKind}". Expected one of: ${AUDIT_KINDS.join(", ")}.`,
    };
  }

  return {
    ok: true,
    filters: {
      // Lowercased for comparison. Addresses arrive from a query string, a
      // checksummed form and a lowercase form are the same address, and the
      // index stores lowercase — so an exact match on the raw input would miss
      // rows depending on how the caller capitalised them.
      poll: rawPoll.length === 0 ? null : rawPoll.toLowerCase(),
      actor: rawActor.length === 0 ? null : rawActor.toLowerCase(),
      kind: rawKind.length === 0 ? null : (rawKind as AuditKind),
    },
  };
}

/** Counts by kind, for the summary line above the table. */
export interface AuditSummary {
  total: number;
  /** Only the kinds actually present, so the summary does not list six zeroes. */
  byKind: { kind: ActivityEntry["kind"]; count: number }[];
  /** How many distinct polls appear in the result. */
  polls: number;
}

/**
 * Summarises a result set.
 *
 * Counted from the SAME rows that are returned rather than from a separate
 * aggregate query. A second query would be one more thing that can disagree with
 * what the reader sees, and the summary's job is to describe the table below it,
 * not the index in general.
 */
export function summarizeAudit(entries: readonly AuditEntry[]): AuditSummary {
  const counts = new Map<ActivityEntry["kind"], number>();
  const polls = new Set<string>();

  for (const entry of entries) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    polls.add(entry.pollAddress.toLowerCase());
  }

  return {
    total: entries.length,
    byKind: [...counts.entries()]
      // Descending by count, then by kind, so the order is total: two kinds with
      // equal counts must not swap between requests.
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({ kind, count })),
    polls: polls.size,
  };
}

/** The human label for each kind, as a catalogue key. Kept beside the kind list so they cannot drift. */
const AUDIT_KIND_KEYS: Record<
  AuditKind,
  | "audit.kind.cast"
  | "audit.kind.changed"
  | "audit.kind.withdrawn"
  | "audit.kind.refunded"
  | "audit.kind.whitelist"
  | "poll.phase"
> = {
  cast: "audit.kind.cast",
  changed: "audit.kind.changed",
  withdrawn: "audit.kind.withdrawn",
  refunded: "audit.kind.refunded",
  whitelist: "audit.kind.whitelist",
  /*
    阶段 comes from `poll.phase` rather than from a key of its own.

    The poll detail row and this table's filter chip render the same word for the
    same concept, and `i18n.test.ts` fails when one Chinese sentence appears under
    two names. A `audit.kind.phase` holding 阶段 would be exactly that second
    name, so the lookup points at the one spelling that already exists — the same
    choice the ballot's stat row makes for 阶段 and 票数合计.
  */
  phase: "poll.phase",
};

/**
 * The label for a kind, falling back to the raw name for an unknown one.
 *
 * ---------------------------------------------------------------------------
 * Why the LABEL is translated but the NAME is not
 * ---------------------------------------------------------------------------
 *
 * A kind is an IDENTIFIER before it is a word. `AUDIT_KINDS` above is the set of
 * names the index records and what `?kind=` accepts; the same names are the
 * `event_type` column in MySQL, the branches in `EVENT_BRANCHES`, and the
 * `entry.kind` a row carries. `audit/page.tsx` builds every filter link out of
 * the raw name and only calls this function for the text inside the chip — so
 * switching the reader's language changes what a chip SAYS and never what it
 * LINKS TO, which is what keeps a pasted `?kind=refunded` URL working for both
 * languages.
 *
 * The fallback stays the raw name for the same reason `TrustPanel`'s
 * `data-fingerprint` is a stable id: a row from a newer schema version must show
 * something recognisable, not a blank cell and not a translation of a word this
 * build has never heard of.
 */
export function auditKindLabel(kind: string, locale: Locale = DEFAULT_LOCALE): string {
  if (!isAuditKind(kind)) {
    return kind;
  }

  return translatorFor(locale).t(AUDIT_KIND_KEYS[kind]);
}
