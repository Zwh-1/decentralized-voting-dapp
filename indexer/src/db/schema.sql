-- SPDX-License-Identifier: MIT
--
-- The indexer's MySQL projection. This schema is a CACHE, never a source of
-- truth: every row here is derivable from Voting contract events, and the whole
-- database can be dropped and rebuilt by replaying from the deployment block.
--
-- The correctness of the whole indexer rests on one thing: UNIQUE(tx_hash,
-- log_index) on every event table. A chain log is uniquely identified by that
-- pair, so a repeated delivery (restart, overlapping getLogs range, RPC retry)
-- collides with the existing row instead of double counting a vote.

CREATE TABLE IF NOT EXISTS candidates (
  id            INT UNSIGNED     NOT NULL PRIMARY KEY,
  metadata_cid  VARCHAR(128)     NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_candidates_log (tx_hash, log_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS votes (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  voter         CHAR(42)         NOT NULL,
  candidate_id  INT UNSIGNED     NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_votes_log (tx_hash, log_index),
  KEY idx_votes_candidate (candidate_id),
  KEY idx_votes_voter (voter),
  KEY idx_votes_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS refunds (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  voter         CHAR(42)         NOT NULL,
  amount_wei    DECIMAL(38,0)    NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_refunds_log (tx_hash, log_index),
  KEY idx_refunds_voter (voter),
  KEY idx_refunds_block (block_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whitelist_events (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  voter         CHAR(42)         NOT NULL,
  allowed       TINYINT(1)       NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_whitelist_log (tx_hash, log_index),
  KEY idx_whitelist_voter (voter)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS phase_events (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  from_phase    TINYINT UNSIGNED NOT NULL,
  to_phase      TINYINT UNSIGNED NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_phase_log (tx_hash, log_index)
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

-- Aggregate view used by the API. Derived, so it can never disagree with the
-- event rows it is computed from.
CREATE OR REPLACE VIEW candidate_tally AS
SELECT
  c.id            AS candidate_id,
  c.metadata_cid  AS metadata_cid,
  COALESCE(v.vote_count, 0) AS vote_count
FROM candidates c
LEFT JOIN (
  SELECT candidate_id, COUNT(*) AS vote_count
  FROM votes
  GROUP BY candidate_id
) v ON v.candidate_id = c.id;
