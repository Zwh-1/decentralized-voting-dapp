// SPDX-License-Identifier: MIT
/**
 * Applies `schema.sql`. Every statement is idempotent (`IF NOT EXISTS`,
 * `OR REPLACE`), so running this on every boot is safe and needs no migration
 * table: the schema is a rebuildable projection, not an accumulated history.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import mysql from "mysql2/promise";

import { loadConfig } from "../config.js";

export async function migrate(databaseUrl: string): Promise<void> {
  const schemaPath = path.join(import.meta.dirname, "schema.sql");
  const schema = await readFile(schemaPath, "utf8");

  const connection = await mysql.createConnection({
    uri: databaseUrl,
    multipleStatements: true,
  });

  try {
    await connection.query(schema);
  } finally {
    await connection.end();
  }
}

// Allow `tsx src/db/migrate.ts` to apply the schema as a one-off command.
if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const config = loadConfig();
  await migrate(config.databaseUrl);
  console.log("Schema applied.");
}
