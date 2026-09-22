// SPDX-License-Identifier: MIT
/**
 * The one place that decides which RPC endpoints a process has, and in what order.
 *
 * ---------------------------------------------------------------------------
 * Why this is its own module
 * ---------------------------------------------------------------------------
 *
 * Two callers need this and they live on opposite sides of the server/client
 * boundary: `config.ts` reads the server's `RPC_URL` / `RPC_URLS`, and `wagmi.ts`
 * reads the browser's `NEXT_PUBLIC_LOCAL_RPC_URL(S)` / `NEXT_PUBLIC_SEPOLIA_RPC_URL(S)`.
 * The environment variables differ; the RULE does not, and the rule is the part
 * that matters:
 *
 *   - the singular variable is the primary and stays first,
 *   - the plural variable adds endpoints behind it,
 *   - blanks are dropped and duplicates removed case-insensitively.
 *
 * Two copies of that would drift. The failure would not be a crash: the browser
 * and the server would read a different endpoint order from an identically
 * configured deployment, and the symptom would be "the page and the API disagree
 * about the tally" — which looks like an indexing bug and is not one. The
 * browser also cannot import `config.ts` (it carries `mysql2` and the validated
 * server environment), so the shared part has to live outside both.
 *
 * This module therefore takes VALUES, never `process.env`. Each caller reads its
 * own environment, because `NEXT_PUBLIC_*` variables only survive a Next.js build
 * when the exact `process.env.NEXT_PUBLIC_NAME` expression appears in the source
 * — a shared function reading `process.env[name]` would compile and then always
 * see nothing.
 */

/**
 * Merges a primary endpoint with a comma-separated list of extras.
 *
 * Duplicates are removed case-insensitively and blanks dropped, because this list
 * is something a human edits. `RPC_URL=x` with `RPC_URLS=x,y` is the obvious way
 * to write "x, then y"; it must not mean "try x twice and then y", which is what
 * a naive concatenation produces and which delays reaching y by one full dead
 * endpoint timeout.
 *
 * The entries are NOT validated as URLs. A malformed one fails when used, and
 * `describeFailure` already reports that without echoing the value (ADR-0020);
 * checking here would move the same failure earlier while adding a second place
 * that believes it knows what a URL looks like.
 */
export function resolveRpcEndpoints(
  primary: string | undefined,
  extra: string | undefined,
): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const listed = (extra ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const candidates =
    primary === undefined || primary.trim().length === 0 ? listed : [primary.trim(), ...listed];

  for (const url of candidates) {
    const key = url.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    ordered.push(url);
  }

  return ordered;
}
