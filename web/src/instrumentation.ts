// SPDX-License-Identifier: MIT
/**
 * Next.js calls `register()` once per server process.
 *
 * Used here to start the indexer's background loop so that `next dev` and
 * `next start` keep the projection up to date without a second command. It is a
 * convenience, not the mechanism the design depends on: `POST /api/index/sync`
 * and `pnpm drain` both work regardless, which matters because a long-running
 * in-process loop is exactly what does not survive a serverless deployment.
 *
 * Failures are swallowed on purpose. A missing or unreachable database must not
 * stop the web server from booting; the app is designed to run chain-only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
    return;
  }

  try {
    const { ensureSyncLoop } = await import("./lib/data");

    await ensureSyncLoop();
  } catch (error) {
    console.warn(
      `[instrumentation] the background indexer did not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
