// SPDX-License-Identifier: MIT
/**
 * The one definition of "an event", as SQL.
 *
 * ---------------------------------------------------------------------------
 * Why this is a shared constant rather than two similar queries
 * ---------------------------------------------------------------------------
 *
 * Two features read the same event stream across polls: the audit feed and a
 * reader's notifications. Before this module each carried its own six branch
 * `UNION ALL`, and the two would have drifted the first time a table gained a
 * column — with the drift showing up as "the audit view shows a refund that my
 * notifications never mentioned", which is a difference nobody thinks to test for.
 *
 * So the branch list lives here, once. Each entry names the table, the columns it
 * can answer, and the literal condition selecting its own rows out of a shared
 * table (`votes` holds three of the six kinds).
 *
 * ---------------------------------------------------------------------------
 * The output shape is fixed, and that is the contract
 * ---------------------------------------------------------------------------
 *
 * `UNION ALL` matches by POSITION, not by name. A branch that listed `amount_wei`
 * where another listed `allowed` would put a wei amount in the "allowed" column
 * and the union would still succeed — no error, wrong data. Every branch is
 * therefore built by `branchSql` from the same template, in the same order, so the
 * positions cannot differ. `event-branches.test.ts` counts the columns of all six
 * to keep it that way.
 *
 * ---------------------------------------------------------------------------
 * Why the caller's conditions go through `branchSql` and not appended afterwards
 * ---------------------------------------------------------------------------
 *
 * The branch's own condition and the caller's filters must end up in ONE `WHERE`.
 * An earlier version of this module exposed `FROM … WHERE <branch condition>` for
 * callers to append to, which produces `… WHERE a WHERE b` — a syntax error — and
 * tempts the caller into dropping the branch condition instead, which would return
 * every kind of vote row from the `cast` branch. `branchSql` takes the conditions
 * and merges them, so neither mistake is expressible.
 *
 * `hasVoter` records which branches have an address to filter on. `phase_events`
 * records a transition and names nobody, so a filter by address must EXCLUDE that
 * branch rather than drop the condition — dropping it would return phase rows for
 * a filter that asked about one address.
 */

/** A kind of event the indexer records. */
export type EventKind = "cast" | "changed" | "withdrawn" | "refunded" | "whitelist" | "phase";

export interface EventBranch {
  kind: EventKind;
  /** The table the rows live in. */
  table: string;
  /**
   * A literal condition selecting this kind's rows, or `null` when the table holds
   * only this kind. Never caller input — these strings are constants, and every
   * value a caller supplies travels as a `?` placeholder.
   */
  condition: string | null;
  /** False when the table has no `voter` column, so an address filter excludes it. */
  hasVoter: boolean;
  /** The column for `option_id`, or `NULL` when the kind has no option. */
  optionId: string;
  /** The column for `allowed`, or `NULL`. */
  allowed: string;
  /** The column for `amount_wei`, or `NULL`. */
  amountWei: string;
}

export const EVENT_BRANCHES: readonly EventBranch[] = [
  {
    kind: "cast",
    table: "votes",
    condition: "event_type = 'cast'",
    hasVoter: true,
    optionId: "option_id",
    allowed: "NULL",
    amountWei: "NULL",
  },
  {
    kind: "changed",
    table: "votes",
    condition: "event_type = 'changed'",
    hasVoter: true,
    optionId: "option_id",
    allowed: "NULL",
    amountWei: "NULL",
  },
  {
    kind: "withdrawn",
    table: "votes",
    condition: "event_type = 'withdrawn'",
    hasVoter: true,
    optionId: "NULL",
    allowed: "NULL",
    amountWei: "NULL",
  },
  {
    kind: "refunded",
    table: "refunds",
    condition: null,
    hasVoter: true,
    optionId: "NULL",
    allowed: "NULL",
    amountWei: "amount_wei",
  },
  {
    kind: "whitelist",
    table: "whitelist_events",
    condition: null,
    hasVoter: true,
    optionId: "NULL",
    allowed: "allowed",
    amountWei: "NULL",
  },
  {
    kind: "phase",
    table: "phase_events",
    condition: null,
    hasVoter: false,
    optionId: "NULL",
    allowed: "NULL",
    amountWei: "NULL",
  },
];

/** The ten output columns, in the order every branch must produce them. */
export function branchColumns(branch: EventBranch): string[] {
  return [
    `'${branch.kind}' AS kind`,
    "poll_address",
    branch.hasVoter ? "voter AS actor" : "NULL AS actor",
    `${branch.optionId} AS option_id`,
    `${branch.allowed} AS allowed`,
    branch.table === "phase_events" ? "from_phase" : "NULL AS from_phase",
    branch.table === "phase_events" ? "to_phase" : "NULL AS to_phase",
    `${branch.amountWei} AS amount_wei`,
    "block_number",
    "tx_hash",
  ];
}

/**
 * One branch, with the branch's own condition and the caller's merged into a
 * single `WHERE`.
 *
 * `conditions` are SQL fragments with `?` placeholders. Their bound values are NOT
 * handled here — the caller collects them in the same order it named the
 * conditions, which is the one thing this function cannot check for it.
 */
export function branchSql(branch: EventBranch, conditions: readonly string[] = []): string {
  const all = branch.condition === null ? [...conditions] : [branch.condition, ...conditions];
  const where = all.length === 0 ? "" : ` WHERE ${all.join(" AND ")}`;

  return `SELECT ${branchColumns(branch).join(", ")} FROM ${branch.table}${where}`;
}

/**
 * The `ORDER BY` every consumer shares.
 *
 * By block, then transaction hash, so the order is TOTAL rather than merely
 * arbitrary: two requests for the same page of history must not disagree about
 * which of two same-block events came first. Named by column name, which MySQL
 * resolves against the union's first `SELECT`.
 */
export const EVENT_ORDER_BY = "ORDER BY block_number DESC, tx_hash DESC";
