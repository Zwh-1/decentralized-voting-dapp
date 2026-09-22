// SPDX-License-Identifier: MIT
/**
 * NEGATIVE CONTROL for the consistency check — not a test, a manual drill.
 *
 * The consistency check reporting `consistent` proves nothing on its own: a
 * check that always says "consistent" would report exactly the same thing. This
 * tampers with the index in a way that MUST be caught, runs the check, and then
 * restores the index by replaying from the chain.
 *
 * Usage: `pnpm tsx scripts/tamper-drill.ts` with a drained index.
 */
import mysql from "mysql2/promise";

import { loadServerConfig } from "../src/lib/config";

const config = loadServerConfig();

if (config.databaseUrl === null) {
  console.error("DATABASE_URL is not set, so there is nothing to tamper with.");
  process.exit(1);
}

const connection = await mysql.createConnection({ uri: config.databaseUrl });

try {
  // One vote's power is inflated by 1. The index now claims a tally the chain
  // does not hold, so `checkConsistency` must report the poll divergent. The
  // [power] column is the right thing to touch: it is the value the weighted
  // tally is summed from, so this is precisely the mutation the new `SUM(power)`
  // aggregate exists to get right.
  const [result] = await connection.query(
    "UPDATE votes SET power = power + 1 WHERE event_type != 'withdrawn' ORDER BY id LIMIT 1",
  );

  const affected = (result as { affectedRows: number }).affectedRows;

  if (affected !== 1) {
    console.error(`expected to tamper exactly 1 row, tampered ${affected}`);
    process.exit(1);
  }

  console.log("Tampered with 1 vote's power. The check must now report a divergence.");
} finally {
  await connection.end();
}
