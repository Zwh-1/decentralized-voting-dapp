// SPDX-License-Identifier: MIT
import mysql from "mysql2/promise";

import { SCHEMA_SQL } from "./schema";

/**
 * Applies the schema.
 *
 * Every statement is idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`), so this
 * is safe to run on every boot and needs no migration table: the schema is a
 * rebuildable projection, not an accumulated history.
 */
export async function migrate(databaseUrl: string): Promise<void> {
  const connection = await mysql.createConnection({
    uri: databaseUrl,
    multipleStatements: true,
  });

  try {
    await connection.query(SCHEMA_SQL);
  } finally {
    await connection.end();
  }
}
