// SPDX-License-Identifier: MIT
/**
 * The derivation the `current_votes` / `option_tally` views perform, as a real
 * MySQL database if one is reachable, and as a faithful TypeScript model if not.
 *
 * The views are the heart of the multi-tenant rewrite: a vote is no longer
 * final, so the index must DERIVE "which option does each (poll, voter) back"
 * from the event stream instead of keeping a tally of its own — otherwise the
 * index becomes a second authority over a contract `mapping`, which ADR-0001
 * forbids.
 *
 * A unit-test process has no MySQL, so this file carries both halves:
 *
 *   * `modelDerivation` is a direct transcription of the SQL — the same
 *     "last event per (poll, voter), then count the non-null options" rule,
 *     applied to the same rows. Every assertion in the test file runs against
 *     it unconditionally.
 *   * when `DATABASE_URL` is set and reachable, the SAME rows are inserted into
 *     a real schema and the SAME assertions are run against the actual views.
 *     That is the only thing that proves the SQL text and the model agree;
 *     without a database the test reports that leg as skipped rather than as
 *     passing.
 *
 * Keeping the model and the SQL in one file, with the SQL quoted in the
 * doc comment below, is deliberate: a model that drifts from the view it models
 * is worse than no model, because it makes a wrong view look verified.
 */
import type { Pool, RowDataPacket } from "mysql2/promise";

/** A row of `current_votes`, as the view returns it. */
interface CurrentVoteDbRow extends RowDataPacket {
  poll_address: string;
  voter: string;
  option_id: number | null;
  block_number: string;
  log_index: number;
}

/** A row of `option_tally`, as the view returns it. */
interface OptionTallyDbRow extends RowDataPacket {
  poll_address: string;
  option_id: number;
  label_cid: string;
  vote_count: string;
}

/** One row of the `votes` table. */
export interface VoteEventRow {
  pollAddress: string;
  voter: string;
  optionId: number;
  eventType: "cast" | "changed" | "withdrawn";
  blockNumber: bigint;
  logIndex: number;
}

/** One row of the `options` table. */
export interface OptionTableRow {
  pollAddress: string;
  optionId: number;
  labelCid: string;
}

/** A row of `current_votes`, as the view returns it. */
export interface CurrentVote {
  pollAddress: string;
  voter: string;
  /** null when the voter's last event was a withdrawal. */
  optionId: number | null;
  blockNumber: bigint;
  logIndex: number;
}

/** A row of `option_tally`. */
export interface OptionTallyRow {
  pollAddress: string;
  optionId: number;
  labelCid: string;
  voteCount: number;
}

/**
 * `current_votes`, as TypeScript.
 *
 * Mirrors:
 *
 *   SELECT ... CASE WHEN v.event_type = 'withdrawn' THEN NULL ELSE v.option_id END ...
 *   FROM votes v
 *   WHERE NOT EXISTS (SELECT 1 FROM votes later
 *                     WHERE later.poll_address = v.poll_address
 *                       AND later.voter = v.voter
 *                       AND (later.block_number > v.block_number
 *                            OR (later.block_number = v.block_number
 *                                AND later.log_index > v.log_index)));
 */
export function modelCurrentVotes(votes: readonly VoteEventRow[]): CurrentVote[] {
  const latest = new Map<string, VoteEventRow>();

  for (const vote of votes) {
    const key = `${vote.pollAddress.toLowerCase()}\u0000${vote.voter.toLowerCase()}`;
    const incumbent = latest.get(key);

    // Strictly greater on (block_number, log_index): the FIRST row wins a tie,
    // exactly as `NOT EXISTS` does, so the model and the view cannot disagree
    // about an impossible-but-representable duplicate.
    if (
      incumbent === undefined ||
      vote.blockNumber > incumbent.blockNumber ||
      (vote.blockNumber === incumbent.blockNumber && vote.logIndex > incumbent.logIndex)
    ) {
      latest.set(key, vote);
    }
  }

  return [...latest.values()].map((vote) => ({
    pollAddress: vote.pollAddress.toLowerCase(),
    voter: vote.voter.toLowerCase(),
    optionId: vote.eventType === "withdrawn" ? null : vote.optionId,
    blockNumber: vote.blockNumber,
    logIndex: vote.logIndex,
  }));
}

/**
 * `option_tally`, as TypeScript: count `current_votes` per (poll, option),
 * skipping the nulls, and keep every option row even at zero.
 */
export function modelOptionTally(
  options: readonly OptionTableRow[],
  currentVotes: readonly CurrentVote[],
): OptionTallyRow[] {
  const counts = new Map<string, number>();

  for (const vote of currentVotes) {
    if (vote.optionId === null) {
      continue;
    }

    const key = `${vote.pollAddress}\u0000${vote.optionId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return options
    .map((option) => ({
      pollAddress: option.pollAddress.toLowerCase(),
      optionId: option.optionId,
      labelCid: option.labelCid,
      voteCount: counts.get(`${option.pollAddress.toLowerCase()}\u0000${option.optionId}`) ?? 0,
    }))
    .sort((a, b) =>
      a.pollAddress === b.pollAddress
        ? a.optionId - b.optionId
        : a.pollAddress.localeCompare(b.pollAddress),
    );
}

/** The whole read model, in one call, for a set of inserted rows. */
export function derive(
  options: readonly OptionTableRow[],
  votes: readonly VoteEventRow[],
): { currentVotes: CurrentVote[]; tally: OptionTallyRow[] } {
  const currentVotes = modelCurrentVotes(votes);

  return { currentVotes, tally: modelOptionTally(options, currentVotes) };
}

// ---------------------------------------------------------------------------
// The same rows, through the real views, when a MySQL is reachable
// ---------------------------------------------------------------------------

/** A database that can host the real views, or null when none is configured. */
export async function connectTestDatabase(): Promise<Pool | null> {
  const url = process.env["DATABASE_URL"];

  if (url === undefined || url.length === 0) {
    return null;
  }

  const mysql = await import("mysql2/promise");

  try {
    return mysql.createPool({ uri: url, connectionLimit: 2, multipleStatements: true });
  } catch {
    return null;
  }
}

/**
 * A `tx_hash` unique to one event.
 *
 * The schema's idempotency key is `UNIQUE(tx_hash, log_index)`, so two rows
 * sharing that pair would collide and one would silently overwrite the other —
 * exactly the bug this helper must not have, since it would make the views look
 * empty rather than wrong. Deriving the hash from the event's whole identity
 * (poll, block, log index) keeps every row distinct.
 */
function eventTxHash(pollAddress: string, blockNumber: bigint, logIndex: number): string {
  const body = [
    pollAddress.slice(2).toLowerCase(),
    blockNumber.toString(16).padStart(16, "0"),
    logIndex.toString(16).padStart(16, "0"),
  ].join("");

  return `0x${body.padEnd(64, "0").slice(0, 64)}`;
}

/**
 * Measures what the real views say.
 *
 * Returns null when no database is reachable, so the caller can report the leg
 * as skipped. Every row is inserted under a fresh poll address, so this never
 * disturbs whatever the developer has indexed.
 */
export async function deriveFromViews(
  pool: Pool | null,
  options: readonly OptionTableRow[],
  votes: readonly VoteEventRow[],
): Promise<{ currentVotes: CurrentVote[]; tally: OptionTallyRow[] } | null> {
  if (pool === null) {
    return null;
  }

  const polls = [...new Set([...votes, ...options].map((row) => row.pollAddress.toLowerCase()))];
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const [index, address] of polls.entries()) {
      await connection.query(
        `INSERT IGNORE INTO polls
           (address, creator, question, ends_at, option_count, block_number, tx_hash, log_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          address,
          `0x${"ee".repeat(20)}`,
          `derivation probe ${index}`,
          "0",
          64,
          "0",
          eventTxHash(address, 0n, 0),
          0,
        ],
      );
    }

    for (const option of options) {
      await connection.query(
        `INSERT INTO options (poll_address, option_id, label_cid, block_number, tx_hash, log_index)
         VALUES (?, ?, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE label_cid = new.label_cid`,
        [
          option.pollAddress.toLowerCase(),
          option.optionId,
          option.labelCid,
          "0",
          eventTxHash(option.pollAddress, 0n, option.optionId),
          option.optionId,
        ],
      );
    }

    for (const vote of votes) {
      await connection.query(
        `INSERT INTO votes
           (poll_address, voter, option_id, event_type, block_number, tx_hash, log_index)
         VALUES (?, ?, ?, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE event_type = new.event_type`,
        [
          vote.pollAddress.toLowerCase(),
          vote.voter.toLowerCase(),
          vote.optionId,
          vote.eventType,
          vote.blockNumber.toString(),
          eventTxHash(vote.pollAddress, vote.blockNumber, vote.logIndex),
          vote.logIndex,
        ],
      );
    }

    const [currentRows] = await connection.query<CurrentVoteDbRow[]>(
      `SELECT poll_address, voter, option_id, block_number, log_index
       FROM current_votes
       WHERE poll_address IN (${polls.map(() => "?").join(",")})
       ORDER BY poll_address, voter`,
      polls,
    );

    const [tallyRows] = await connection.query<OptionTallyDbRow[]>(
      `SELECT poll_address, option_id, label_cid, vote_count
       FROM option_tally
       WHERE poll_address IN (${polls.map(() => "?").join(",")})
       ORDER BY poll_address, option_id`,
      polls,
    );

    await connection.commit();

    return {
      currentVotes: currentRows.map((row) => ({
        pollAddress: row.poll_address,
        voter: row.voter,
        optionId: row.option_id === null ? null : Number(row.option_id),
        blockNumber: BigInt(row.block_number),
        logIndex: Number(row.log_index),
      })),
      tally: tallyRows.map((row) => ({
        pollAddress: row.poll_address,
        optionId: Number(row.option_id),
        labelCid: row.label_cid,
        voteCount: Number(row.vote_count),
      })),
    };
  } finally {
    // The rows are left behind on purpose: this database is a projection that
    // can be dropped and rebuilt, and deleting them would need the same care
    // about foreign keys that the schema deliberately does not have.
    connection.release();
  }
}
