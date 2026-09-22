// SPDX-License-Identifier: MIT
/**
 * A small read-through cache with single-flight, for the expensive chain reads.
 *
 * ---------------------------------------------------------------------------
 * Why a cache at all when every page reads the chain directly
 * ---------------------------------------------------------------------------
 *
 * `getPolls` is not one call. It reads `allPolls()`, then asks EVERY poll for its
 * question, its deadline and its tally — so the cost grows with the number of
 * polls, and the poll list page, the poll detail page and the API routes all read
 * the same figures within the same second. On a public RPC that is both slow and
 * rate-limited, and the limit is reached by the app talking to itself.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does NOT cache
 * ---------------------------------------------------------------------------
 *
 * The consistency check. It exists to compare the chain against the index at ONE
 * instant (ADR-0017), and a cached chain-head would make it compare a live index
 * against a stale height. A vote mined inside the cache window would land in
 * neither side of the comparison and the check would report `divergent` — a false
 * accusation produced by the cache itself. `getResults`, `checkConsistency` and
 * `/api/health` therefore keep reading live, and the TTL below is short enough
 * that everything else stays well inside the confirmation window.
 *
 * ---------------------------------------------------------------------------
 * Why single-flight matters more than the TTL
 * ---------------------------------------------------------------------------
 *
 * Without it, N concurrent requests during a cold cache all miss and all issue
 * the full read — so the cache would not reduce load exactly when load is highest.
 * The in-flight promise is shared instead, which is what makes a page that mounts
 * several components reading the same data cost one read rather than several.
 */

/** A cache entry and the moment it stops being usable. */
interface Entry<T> {
  value: Promise<T>;
  expiresAt: number;
}

export interface CacheOptions {
  /** How long a value stays usable, in milliseconds. */
  ttlMs: number;
  /** Injected so tests do not depend on wall-clock time. */
  now?: () => number;
}

export interface ReadCache<T> {
  /** Returns the cached value, or starts one read and shares it. */
  get: () => Promise<T>;
  /** Drops the cached value, so the next `get` reads again. */
  invalidate: () => void;
  /** True when a value is currently held (even if a read is still in flight). */
  has: () => boolean;
}

/**
 * Builds a cache for one producer.
 *
 * A FAILED read is never cached. This is the rule worth stating: caching a
 * rejection would turn a single transient RPC blip into a guaranteed outage for
 * the whole TTL, and the reader would be told the chain is unreachable long after
 * it recovered. The entry is dropped on failure so the next caller retries
 * immediately.
 *
 * `ttlMs: 0` disables caching while keeping the single-flight behaviour, which is
 * a useful configuration in its own right: it collapses a burst of concurrent
 * reads without ever serving a stale answer.
 */
export function createReadCache<T>(
  producer: () => Promise<T>,
  options: CacheOptions,
): ReadCache<T> {
  const now = options.now ?? Date.now;
  let entry: Entry<T> | undefined;

  function invalidate(): void {
    entry = undefined;
  }

  return {
    get: () => {
      const current = entry;

      if (current !== undefined && current.expiresAt > now()) {
        return current.value;
      }

      const value = producer();

      // Stored BEFORE the await, which is what makes this single-flight: a second
      // caller arriving during the read finds this promise rather than starting
      // another one.
      entry = { value, expiresAt: now() + options.ttlMs };

      // The producer's rejection must not outlive the attempt. Attaching a
      // handler here is not swallowing it — the caller still receives the
      // rejection through the returned promise — it only makes sure the cache
      // stops holding it.
      value.catch(() => {
        // Only clear the entry if it is still OURS: a concurrent `invalidate`
        // followed by a fresh read must not have its entry thrown away by this
        // older failure.
        if (entry?.value === value) {
          entry = undefined;
        }
      });

      return value;
    },
    invalidate,
    has: () => entry !== undefined,
  };
}
