// SPDX-License-Identifier: MIT
/**
 * In-site subscriptions and the notifications derived from them.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it deliberately is not
 * ---------------------------------------------------------------------------
 *
 * A subscription is "tell me when this poll moves". A notification is DERIVED
 * from the event stream against a per-subscription watermark, never stored — see
 * the schema comment for why a stored notification would be a second record of
 * something the events already say.
 *
 * There is no email, no webhook and no push. Those need credentials, an outbound
 * worker and an operational story for delivery failure, none of which exists here;
 * shipping a "notifications" feature that silently drops messages would be worse
 * than shipping one that only shows them in the app, where the reader can see for
 * themselves that something arrived.
 *
 * ---------------------------------------------------------------------------
 * The trust model, stated where it can be read
 * ---------------------------------------------------------------------------
 *
 * `address` is caller-supplied and NOT authenticated. There are no accounts and no
 * sessions in this app, so anyone can create a subscription for any address, and
 * anyone can ask for that address's notifications.
 *
 * That is acceptable because of WHAT a notification contains: "poll P had a
 * withdrawal at block N". Every word of that is already public on chain. So the
 * worst a forged subscription achieves is showing a reader a poll they did not ask
 * about — an annoyance, not a disclosure.
 *
 * The rule that follows, and the one to hold on to: a subscription is a HINT, not
 * an authorisation. Nothing may ever be gated on holding one, and no notification
 * may ever carry anything that is not already public.
 */

import type { EventKind } from "@/lib/indexer/event-branches";

/** A subscription as the API and the page see it. */
export interface Subscription {
  pollAddress: string;
  /** The height this reader has already been told about. */
  lastReadBlock: string;
  /** When the subscription was created, as a decimal string of milliseconds. */
  createdAt?: string;
}

/** One event, as a notification: an audit-style row plus what it means. */
export interface NotificationEntry {
  pollAddress: string;
  kind: EventKind;
  blockNumber: string;
  txHash: string;
  actor?: string | undefined;
  optionId?: number | null | undefined;
  detail?: string | undefined;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** True when `value` has the shape of a 20 byte hex address. */
export function isAddressShape(value: string): boolean {
  return ADDRESS_PATTERN.test(value);
}

/** What a caller asked to subscribe to, or why it was refused. */
export type SubscribeRequestResult =
  { ok: true; address: string; poll: string } | { ok: false; error: string; message: string };

/** One address from a query string, or why it was refused. */
export type AddressResult =
  { ok: true; address: string } | { ok: false; error: string; message: string };

/**
 * Validates a single address parameter.
 *
 * Separate from `parseSubscriptionRequest` because a read supplies only an address
 * while a write supplies two, and making the read pass its address twice to reuse
 * the body parser would hide which field the error was about.
 *
 * Lowercased for the same reason the body parser lowercases: the index stores
 * lowercase, and a checksummed address copied out of a wallet is the same address.
 */
export function parseAddressParam(value: string | null | undefined): AddressResult {
  const address = (value ?? "").trim();

  if (!isAddressShape(address)) {
    return {
      ok: false,
      error: "invalid_address",
      message: "The address must be 20 byte hex.",
    };
  }

  return { ok: true, address: address.toLowerCase() };
}

/**
 * Reads a subscribe/unsubscribe request body.
 *
 * Both fields are lowercased, because the index stores lowercase and the caller
 * may have copied a checksummed address out of a wallet — matching the raw input
 * would make the same address subscribe twice or unsubscribe nothing.
 *
 * The two fields are checked in a fixed order so the same bad body always produces
 * the same message.
 */
export function parseSubscriptionRequest(body: unknown): SubscribeRequestResult {
  // An array is `typeof "object"` and not null, so it has to be excluded
  // explicitly. Without this it would fall through to the field checks and be
  // reported as a bad ADDRESS — a misleading message for a body that is simply
  // the wrong shape.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "invalid_body", message: "Expected a JSON object." };
  }

  const record = body as Record<string, unknown>;
  const address = typeof record.address === "string" ? record.address.trim() : "";
  const poll = typeof record.poll === "string" ? record.poll.trim() : "";

  if (!isAddressShape(address)) {
    return {
      ok: false,
      error: "invalid_address",
      message: "The subscriber must be a 20 byte hex address.",
    };
  }

  if (!isAddressShape(poll)) {
    return {
      ok: false,
      error: "invalid_poll",
      message: "The poll must be a 20 byte hex address.",
    };
  }

  return { ok: true, address: address.toLowerCase(), poll: poll.toLowerCase() };
}

/**
 * How many notifications each subscribed poll has, most first.
 *
 * Counted from the rows that were returned, not from a separate aggregate — the
 * job is to describe the list the reader is about to see, and a second query is
 * one more thing that can disagree with it.
 */
export interface NotificationSummary {
  total: number;
  pollCount: number;
  byPoll: { pollAddress: string; count: number }[];
  byKind: { kind: EventKind; count: number }[];
}

export function summarizeNotifications(entries: readonly NotificationEntry[]): NotificationSummary {
  const polls = new Map<string, number>();
  const kinds = new Map<EventKind, number>();

  for (const entry of entries) {
    const poll = entry.pollAddress.toLowerCase();

    polls.set(poll, (polls.get(poll) ?? 0) + 1);
    kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
  }

  // Descending by count then by name, so the order is TOTAL: two polls with the
  // same count must not swap between requests, or two screenshots of one reader's
  // notifications would differ.
  const byCount = <T extends string>(map: Map<T, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ key, count }));

  return {
    total: entries.length,
    pollCount: polls.size,
    byPoll: byCount(polls).map((row) => ({ pollAddress: row.key, count: row.count })),
    byKind: byCount(kinds).map((row) => ({ kind: row.key, count: row.count })),
  };
}

/**
 * The comparison that decides whether an event is still unread.
 *
 * Decimal strings, compared by length and then lexically. `Number()` on a block
 * height silently loses low digits for large heights, which would make two
 * distinct recent blocks compare equal and either re-notify or skip. The same
 * function shape as `poll-report.ts` uses for block ordering, and for the same
 * reason.
 */
export function isNewerThan(blockNumber: string, watermark: string): boolean {
  const left = blockNumber.replace(/^0+/, "") || "0";
  const right = watermark.replace(/^0+/, "") || "0";

  if (left.length !== right.length) {
    return left.length > right.length;
  }

  return left > right;
}

/**
 * The watermark to store when a reader marks notifications read.
 *
 * The HIGHEST block among the entries being marked, not the current head. If the
 * reader marks read while the page is showing events up to block 500 and the chain
 * has moved to 520, taking the head would silently mark 501–520 read as well —
 * they would never be shown, and nothing would say so. Advancing only to what was
 * actually displayed cannot lose an event; the cost is that an event arriving
 * during the request stays unread, which is the safe direction.
 */
export function watermarkFor(entries: readonly NotificationEntry[], current: string): string {
  let highest = current;

  for (const entry of entries) {
    if (isNewerThan(entry.blockNumber, highest)) {
      highest = entry.blockNumber;
    }
  }

  return highest;
}
