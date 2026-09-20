// SPDX-License-Identifier: MIT
import mysql from "mysql2/promise";

/**
 * Creates the MySQL pool used by both the indexer and the API.
 *
 * The API and the indexer share a pool type but never share a transaction: the
 * API only ever runs SELECTs, so it can never observe or produce a partial
 * write from the indexer.
 */
export function createPool(databaseUrl: string): mysql.Pool {
  return mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    waitForConnections: true,
    // Big integers come back as strings by default, which is what we want:
    // block numbers and wei amounts exceed Number.MAX_SAFE_INTEGER.
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

export type Pool = mysql.Pool;
export type PoolConnection = mysql.PoolConnection;
