// SPDX-License-Identifier: MIT
/**
 * The index's MySQL projection, as a TypeScript constant rather than a .sql
 * file loaded from disk.
 *
 * Reading the file at runtime would mean depending on `import.meta.dirname`
 * resolving to the source tree, which is not true inside a Next.js server
 * bundle. Inlining removes that failure mode entirely and keeps the schema
 * next to the code that applies it.
 *
 * This schema is a CACHE, never a source of truth: every row is derivable from
 * `VotingFactory` / `Poll` events, and the whole database can be dropped and
 * rebuilt by replaying from the deployment block.
 *
 * The correctness of the whole index rests on one thing: UNIQUE(tx_hash,
 * log_index) on every event table. A chain log is uniquely identified by that
 * pair, so a repeated delivery (restart, overlapping getLogs range, RPC retry)
 * collides with the existing row instead of double counting a vote.
 *
 * ---------------------------------------------------------------------------
 * Why `votes` is an EVENT STREAM and the current vote is a VIEW
 * ---------------------------------------------------------------------------
 *
 * The multi-tenant rewrite changed what a vote *is*. `Voting` recorded a
 * boolean `hasVoted`, so a vote was final and "count the rows per candidate"
 * was the whole tally. `Poll` records which option an address currently backs
 * and lets it move between options (`VoteChanged`) or step out
 * (`VoteWithdrawn`), so the same `(poll, voter)` pair can appear many times.
 *
 * "One address, one vote" is enforced by the contract's own `mapping`, and
 * ADR-0001 makes the chain the single source of truth. The index must therefore
 * DERIVE the current vote from the event stream rather than keep a tally of its
 * own: a mutable counter that the sync loop increments would be a second
 * authority, and a disagreement between the two would become undetectable
 * instead of visible. `current_votes` + `option_tally` below are that
 * derivation, expressed as views so they cannot drift from the rows they read.
 */
export const SCHEMA_SQL = `
-- SPDX-License-Identifier: MIT
--
-- The indexer's MySQL projection. This schema is a CACHE, never a source of
-- truth: every row here is derivable from VotingFactory / Poll contract events,
-- and the whole database can be dropped and rebuilt by replaying from the
-- factory's deployment block.
--
-- The correctness of the whole indexer rests on one thing: a unique key on every
-- event table that identifies the chain log a row came from. A chain log is
-- uniquely identified by (tx_hash, log_index) — EXCEPT on votes, where one log
-- legitimately produces one row per selected option, so its key additionally
-- includes option_id. A repeated delivery (restart, overlapping getLogs range,
-- RPC retry) then collides with the existing row instead of double counting a
-- vote.
--
-- SCHEMA CHANGES. Everything below is idempotent — IF NOT EXISTS, CREATE OR
-- REPLACE — which is what lets this run on every boot with no migration table.
-- That property holds for CREATE, DROP and for views, but NOT for adding a
-- column to an existing table: MySQL has no ADD COLUMN IF NOT EXISTS, so a new
-- column simply never appears on a database that already has the table, and
-- every later statement referencing it fails.
--
-- votes therefore carries an explicit rebuild, guarded so it fires ONLY when
-- the table is actually the old shape. The guard matters: an unconditional DROP
-- would empty votes on every boot while the cursor stays put, and the next
-- drain would then have nothing to refill from — silently losing the whole vote
-- history. Dropping on a shape mismatch instead is safe for the reason the whole
-- database is disposable: votes is nothing but a projection of chain events,
-- so the rows are reproducible by replaying from the cursor. The cursor is
-- deliberately NOT reset, so the next drain refills exactly the discarded range.
--
-- A table that does not exist yet makes the SELECT below fail; that is handled
-- by running the guard as a separate, error-tolerant step rather than inline.
SET @votes_needs_rebuild := (
  SELECT COUNT(*) = 0
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'votes'
    AND COLUMN_NAME = 'power'
);
SET @rebuild_sql := IF(
  @votes_needs_rebuild = 1,
  'DROP TABLE IF EXISTS votes',
  'DO 0'
);
PREPARE rebuild_stmt FROM @rebuild_sql;
EXECUTE rebuild_stmt;
DEALLOCATE PREPARE rebuild_stmt;
--
-- One poll per contract address (EIP-1167 clone of Poll, created by
-- VotingFactory), so every event table carries poll_address: the fact that two
-- polls share an ABI and an event signature is exactly why the address has to
-- be part of the key rather than inferred from it.

-- One row per poll, discovered from VotingFactory's PollCreated event.
--
-- Deletable on a reorg: a PollCreated that is reorged out leaves an address
-- that no longer exists, so the row (and everything keyed by it) must go.
CREATE TABLE IF NOT EXISTS polls (
  address       CHAR(42)         NOT NULL PRIMARY KEY,
  creator       CHAR(42)         NOT NULL,
  question      TEXT             NOT NULL,
  ends_at       VARCHAR(78)      NOT NULL,
  option_count  INT UNSIGNED     NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_polls_log (tx_hash, log_index),
  KEY idx_polls_creator (creator),
  KEY idx_polls_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per option. PRIMARY KEY (poll_address, option_id) rather than a
-- surrogate id: "option 3 of this poll" IS the identity, which is what makes
-- an OptionUpdated an idempotent upsert onto the same row instead of a second
-- row for the same option.
--
-- Option ids are 1-indexed on chain (0 means "no vote"), and they are NOT
-- stable across a removeOption: see the note on OptionRemoved below.
CREATE TABLE IF NOT EXISTS options (
  poll_address  CHAR(42)         NOT NULL,
  option_id     INT UNSIGNED     NOT NULL,
  label_cid     VARCHAR(128)     NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  PRIMARY KEY (poll_address, option_id),
  UNIQUE KEY uk_options_log (tx_hash, log_index),
  KEY idx_options_poll (poll_address),
  KEY idx_options_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The vote EVENT STREAM, one row per chain event, never overwritten.
--
-- This table deliberately does NOT say "voter X voted for option Y". It says
-- "at this log, voter X did this". The current answer is derived, for two
-- reasons: a vote is no longer final, and deriving it keeps the index a
-- projection rather than a second authority over a contract mapping.
--
-- event_type:
--   'cast'      VoteRecorded       - a recorded set that added to the tally
--   'changed'   VoteRecorded       - a recorded set that replaced an earlier one
--   'withdrawn' VoteWithdrawn      - stepped out; option_id is 0 = "no option"
--   'committed' Committed          - a SEALED ballot on a commit-reveal poll
--   'expired'   CommitmentExpired  - a commitment that was never opened
--
-- 'cast' and 'changed' come from the SAME on-chain event. The contract emits one
-- 'VoteRecorded(voter, optionIds, power, newTotal)' for both a first vote and a
-- change, because the index only ever needs "the set this address last
-- submitted". The distinction is preserved as a column because readers do want
-- it — the activity log says "changed" — but it is DERIVED: the writer marks a
-- row 'changed' when the address already had rows before this event.
--
-- 'committed' and 'expired' are a commit-reveal poll's two states that are NOT a
-- vote, and they live in this stream for one reason: "committed, awaiting
-- reveal" has to be distinguishable from "did not vote". Both have an empty
-- tally, so a reader given only counted rows would report a participant as a
-- non-participant — the misreport ADR-0011 forbids. Neither carries a power or a
-- real option.
--
-- VoteWithdrawn carries an amount rather than an option, so its option_id is
-- stored as 0. 0 is never a valid option on chain (ids are 1-indexed), so the
-- sentinel cannot collide with a real option. 'committed' and 'expired' use the
-- same sentinel, and the read side must never treat a 0-option row as a
-- selection.
--
-- power is how much the selection counted for (1 under equal weight). Stored
-- per row rather than re-derived from the poll's mechanism flags, because the
-- flags describe the poll NOW and the row describes a vote cast at its own
-- block.
--
-- uk_votes_log INCLUDES option_id, and that is load-bearing. A multi-select vote
-- is ONE log that produces one row per selected option, so a uniqueness key of
-- (tx_hash, log_index) alone would reject every row after the first — and
-- because the insert is INSERT IGNORE, it would do so SILENTLY, losing
-- selections from the tally with no error anywhere. Including option_id keeps
-- the key a true per-log uniqueness constraint while allowing a log to own one
-- row per option it selected.
CREATE TABLE IF NOT EXISTS votes (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  poll_address  CHAR(42)         NOT NULL,
  voter         CHAR(42)         NOT NULL,
  option_id     INT UNSIGNED     NOT NULL,
  event_type    VARCHAR(16)      NOT NULL,
  power         DECIMAL(38,0)    NOT NULL DEFAULT 1,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_votes_log (tx_hash, log_index, option_id),
  KEY idx_votes_poll_voter (poll_address, voter),
  KEY idx_votes_poll_option (poll_address, option_id),
  KEY idx_votes_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS refunds (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  poll_address  CHAR(42)         NOT NULL,
  voter         CHAR(42)         NOT NULL,
  amount_wei    DECIMAL(38,0)    NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_refunds_log (tx_hash, log_index),
  KEY idx_refunds_poll_voter (poll_address, voter),
  KEY idx_refunds_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whitelist_events (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  poll_address  CHAR(42)         NOT NULL,
  voter         CHAR(42)         NOT NULL,
  allowed       TINYINT(1)       NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_whitelist_log (tx_hash, log_index),
  KEY idx_whitelist_poll_voter (poll_address, voter),
  KEY idx_whitelist_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS phase_events (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  poll_address  CHAR(42)         NOT NULL,
  from_phase    TINYINT UNSIGNED NOT NULL,
  to_phase      TINYINT UNSIGNED NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_phase_log (tx_hash, log_index),
  KEY idx_phase_poll (poll_address),
  KEY idx_phase_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Single-row cursor. Advancing it and inserting the events of the same range
-- happen in ONE transaction, so there is no state where the cursor has moved
-- past events that were never persisted.
CREATE TABLE IF NOT EXISTS sync_cursor (
  id          TINYINT          NOT NULL PRIMARY KEY DEFAULT 1,
  last_block  BIGINT UNSIGNED  NOT NULL,
  updated_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT ck_sync_cursor_single_row CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Subscriptions and notifications
-- ---------------------------------------------------------------------------

-- "Tell me when this poll moves."
--
-- THERE IS NO NOTIFICATIONS TABLE, and that is the design. A notification is
-- DERIVED from the event stream, not stored, for the same reason the current
-- vote is a view and not a counter (ADR-0023): a stored notification would be a
-- second record of something the events already say, and the two would drift the
-- first time the indexer replayed a range. It would also mean every reorg
-- recovery had to remember to un-write notifications, which is exactly the kind
-- of step that gets forgotten.
--
-- So a subscription stores only the WATERMARK: \`last_read_block\`, the height up
-- to which this reader has already been told what happened. Notifications are
-- "events in my subscribed polls above that height".
--
-- last_read_block defaults to 0 for a row inserted by hand, but \`subscribe()\`
-- writes the current head instead, so a new subscriber is not handed the whole
-- history as unread. Marking read moves it forward.
--
-- THE TRUST MODEL IS WEAK AND IS STATED HERE ON PURPOSE. \`address\` is supplied
-- by the caller and is NOT authenticated: this app has no accounts and no
-- sessions, so anyone can create a subscription for any address. That is
-- tolerable only because of what a notification reveals — "poll P had a refund at
-- block N" — which is public on chain already. It does mean a subscription is a
-- HINT, not an authorisation, and nothing may ever be gated on holding one.
CREATE TABLE IF NOT EXISTS subscriptions (
  address         CHAR(42)         NOT NULL,
  poll_address    CHAR(42)         NOT NULL,
  last_read_block BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  created_at      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (address, poll_address),
  KEY idx_subscriptions_address (address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which block the index has reached, for a reader with no subscriptions yet.
--
-- Read from \`sync_cursor\` rather than from the chain head: a subscriber should be
-- flooded with nothing, and the only height at which "nothing has happened yet"
-- is true is the height the index has actually processed. Using the chain head
-- would set the watermark past events the index has not written, and those events
-- would then never notify anyone.


-- ---------------------------------------------------------------------------
-- The read model: derive the CURRENT vote, then count it
-- ---------------------------------------------------------------------------

-- Which option each (poll, voter) currently backs.
--
-- DERIVED, never stored. ON CHAIN THIS IS \Poll.votedFor\, a mapping the
-- contract maintains itself; this view exists so the index can be compared
-- against that mapping instead of competing with it (ADR-0001). If the two
-- ever disagree it is a bug in one of them, and a bug that a stored tally
-- would have hidden.
--
-- The rule is "the last thing the address did", ordered by the chain's own
-- total order (block_number, log_index):
--
--   * 'cast' or 'changed' -> option_id is part of the current selection;
--   * 'withdrawn'         -> the voter currently backs NOTHING.
--
-- MULTI-SELECT: a selection is a SET, and it is one log that produced several
-- rows sharing a (block_number, log_index). The correlated NOT EXISTS handles
-- that without a special case, and it is worth saying why, because the obvious
-- worry is that rows of the SAME event would exclude each other. They do not:
-- exclusion requires a strictly greater position, and the sibling rows of one
-- event are equal in both coordinates. So every row of the latest event
-- survives and every row of an earlier one is dropped — which is exactly "the
-- latest set this address submitted".
--
-- That is also why option_tally's SUM(power) is the right aggregate under
-- multi-select. One vote selecting {1,2} contributes one row to option 1 and one
-- to option 2, and each option's count is the number of voters currently backing
-- it — the same number Poll.results() reports, which is what the consistency
-- check compares.
--
-- A withdrawn voter IS returned, with option_id NULL, rather than filtered
-- out. That is the deliberate choice: "no longer voting" is a real state that
-- a reader asks about ("does this address still back something?"), and
-- dropping the row would make "withdrew" indistinguishable from "this poll and
-- voter were never indexed". option_tally filters the NULLs out, so every
-- consumer that wants counts is unaffected.
--
-- 'committed' and 'expired' map to NULL for the same reason AND a stricter one.
-- A committed row stores option_id 0 as a sentinel, and 0 is not NULL: leaving
-- it alone would let option_tally's LEFT JOIN treat it as a real option and
-- invent an option 0 row, or — worse — silently drop the whole group. Which of
-- those happens depends on whether an option 0 row exists, so the bug would be
-- data-dependent. Mapping the sentinel to NULL here makes both impossible and
-- keeps "this address currently backs nothing" the single meaning of NULL.
--
-- The correlated NOT EXISTS rather than ROW_NUMBER()/window functions: MySQL
-- 5.7 and MariaDB have no window functions, and this project's MySQL version is
-- whatever the operator happens to be running. It is a correlated subquery per
-- (poll, voter) pair, which is fine at this scale and is index-backed by
-- idx_votes_poll_voter.
CREATE OR REPLACE VIEW current_votes AS
SELECT
  v.poll_address AS poll_address,
  v.voter       AS voter,
  CASE WHEN v.event_type IN ('withdrawn', 'committed', 'expired')
       THEN NULL ELSE v.option_id END AS option_id,
  CASE WHEN v.event_type IN ('withdrawn', 'committed', 'expired')
       THEN 0 ELSE v.power END AS power,
  v.block_number AS block_number,
  v.log_index    AS log_index,
  v.tx_hash      AS tx_hash,
  v.event_type   AS event_type
FROM votes v
WHERE NOT EXISTS (
  SELECT 1
  FROM votes later
  WHERE later.poll_address = v.poll_address
    AND later.voter = v.voter
    AND (
      later.block_number > v.block_number
      OR (later.block_number = v.block_number AND later.log_index > v.log_index)
    )
);

-- Votes per (poll, option), counting only voters who currently back something.
--
-- Replaces the old candidate_tally. It is the indexer's answer to
-- Poll.results(), and the M-6 consistency check compares the two.
--
-- WEIGHTED voting is why this SUMs power instead of COUNTing rows. On chain
-- Option.voteCount is incremented by the voter's power, so a weighted poll's
-- results() reports 5 where one voter of weight 5 stands. Counting rows would
-- report 1 and the consistency check would fail — correctly, because the index
-- would be describing a different tally than the chain holds.
--
-- COALESCE on the sum as well as the join: SUM over an empty group is NULL, and
-- a NULL vote_count would read as "unknown" rather than "nobody", which is the
-- same reason the LEFT JOIN exists.
--
-- LEFT JOIN from options so an option nobody currently backs is reported as
-- 0 rather than omitted: the chain's results() returns every option, and a
-- missing row would read as a discrepancy.
CREATE OR REPLACE VIEW option_tally AS
SELECT
  o.poll_address  AS poll_address,
  o.option_id     AS option_id,
  o.label_cid     AS label_cid,
  COALESCE(c.vote_count, 0) AS vote_count
FROM options o
LEFT JOIN (
  SELECT poll_address, option_id, SUM(power) AS vote_count
  FROM current_votes
  WHERE option_id IS NOT NULL
  GROUP BY poll_address, option_id
) c ON c.poll_address = o.poll_address AND c.option_id = o.option_id;

-- Refunds, enriched with the poll's question, so a statement listing a voter's
-- refund history does not need a second round trip per poll.
CREATE OR REPLACE VIEW refund_history AS
SELECT
  r.poll_address AS poll_address,
  p.question     AS question,
  r.voter        AS voter,
  r.amount_wei   AS amount_wei,
  r.block_number AS block_number,
  r.log_index    AS log_index,
  r.tx_hash      AS tx_hash
FROM refunds r
LEFT JOIN polls p ON p.address = r.poll_address;
`;
