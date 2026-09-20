// SPDX-License-Identifier: MIT
/**
 * Applies the index schema.
 *
 * Idempotent, so running it twice is a no-op; CI runs it twice on purpose to
 * prove that. Does nothing when no database is configured.
 */
import { loadServerConfig } from "../src/lib/config";
import { migrate } from "../src/lib/db/migrate";

const config = loadServerConfig();

if (config.databaseUrl === null) {
  console.log("DATABASE_URL is not set, so there is no index to migrate. Nothing to do.");
  process.exit(0);
}

await migrate(config.databaseUrl);

console.log("Schema applied (idempotent).");
