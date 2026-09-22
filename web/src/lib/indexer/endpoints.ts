// SPDX-License-Identifier: MIT
/**
 * Demoting an endpoint the indexer keeps failing on.
 *
 * ---------------------------------------------------------------------------
 * What this actually fixes
 * ---------------------------------------------------------------------------
 *
 * `buildChainClient` wraps several endpoints in viem's `fallback`, which retries
 * the next transport when a call throws. For a single request that is enough.
 *
 * What it does not do is remember. `fallback` tries the endpoints in order on
 * EVERY call, starting from the first each time. So an endpoint that is down is
 * not merely used once and skipped — it is contacted at the head of every single
 * read, and its full connect-or-timeout delay is paid again before the backup is
 * reached. With a 10s timeout and a read per second, a dead primary is a
 * permanent tax on the whole process, and it looks like "the indexer is slow"
 * rather than "one endpoint is down".
 *
 * Counting consecutive failures is what turns that per-call retry into a
 * demotion: after `failuresBeforeRotate` failures the next endpoint becomes the
 * head of the list, and the dead one is no longer in the path of every request.
 * The dead primary is retried on the next wrap-around, so a recovered endpoint
 * comes back on its own.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does NOT do
 * ---------------------------------------------------------------------------
 *
 * An endpoint that ANSWERS and is wrong — a stale head, a pruned range returned
 * as empty, a cached block number that never advances — throws nothing, so no
 * count of failures can see it. This is a known and accepted limit rather than an
 * oversight, because the only signal that distinguishes a lie from the truth is
 * the comparison itself: `checkConsistency` reads the same chain the indexer read
 * and reports `divergent` when the two disagree (ADR-0008, ADR-0017). A transport
 * that tried to judge which endpoint was lying would have to trust one of them to
 * do it, and that is the same second-source-of-truth mistake the indexer exists
 * to avoid.
 *
 * So: this module demotes endpoints that FAIL. Endpoints that LIE are the
 * consistency check's problem, and it already has an owner.
 */

import type { ChainReader } from "./sync";

/**
 * One endpoint, with the reader that talks to it.
 *
 * The reader is built lazily by `create` so that a process that never rotates
 * does not construct clients for endpoints it never used, and so that a test can
 * supply a fake without an RPC endpoint existing at all.
 */
export interface ChainEndpoint {
  /**
   * A name safe to log.
   *
   * An INDEX, not a URL. ADR-0020 forbids echoing an endpoint — it may carry an
   * `apiKey` — and this value ends up in the operator's log line for every
   * rotation. "Endpoint 2 of 3" identifies which one moved without publishing
   * where it points.
   */
  label: string;
  create: () => ChainReader;
}

export interface RotatingChainReaderOptions {
  /** Every endpoint, in preference order. Must not be empty. */
  endpoints: readonly ChainEndpoint[];
  /**
   * How many consecutive failures one endpoint may produce before the next is
   * tried.
   *
   * Not 1: a single dropped request would move the indexer off a healthy
   * primary, and the point of the threshold is to react to an endpoint being
   * DOWN rather than to one request being unlucky. Three tolerates the ordinary
   * hiccups a public RPC produces and still reacts within a few seconds at the
   * loop's interval.
   */
  failuresBeforeRotate?: number;
  /** Called on each rotation, so the operator can see it happened. */
  onRotate?: (info: { from: string; to: string; consecutiveFailures: number }) => void;
}

export interface RotatingChainReader {
  /** The reader the sync loop uses. Rotates underneath it. */
  reader: ChainReader;
  /** Which endpoint is active now. Exposed for the loop's own logging. */
  activeLabel: () => string;
  /** How many times the active endpoint has failed in a row. */
  consecutiveFailures: () => number;
  /** How many rotations have happened since construction. */
  rotations: () => number;
}

/**
 * Wraps several chain readers so the indexer moves to the next when one keeps
 * failing.
 *
 * The wrapped reader NEVER swallows an error. It records the failure, rotates if
 * the endpoint has earned it, and rethrows — because the caller decides what a
 * failure means. `syncOnce` uses that to abort the iteration without advancing
 * the cursor, which is what makes the retry safe; a wrapper that returned an empty
 * result instead would advance the cursor past blocks that were never read, which
 * is the one outcome strictly worse than failing.
 *
 * Rotation is round-robin over the whole list rather than "primary then give up",
 * so a three-endpoint configuration keeps trying all three and a recovered
 * primary is picked up again on the next wrap.
 */
export function createRotatingChainReader(
  options: RotatingChainReaderOptions,
): RotatingChainReader {
  const { endpoints, onRotate } = options;
  const threshold = options.failuresBeforeRotate ?? 3;

  if (endpoints.length === 0) {
    throw new Error("createRotatingChainReader needs at least one endpoint");
  }

  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`failuresBeforeRotate must be a positive integer, received ${threshold}`);
  }

  let index = 0;
  let failures = 0;
  let rotations = 0;

  // The reader for each endpoint, built on first use and kept, so a rotation
  // reuses a reader that already exists rather than rebuilding a client per call.
  const readers = endpoints.map((): ChainReader | undefined => undefined);

  /**
   * The endpoint and reader in use right now.
   *
   * `endpoints` is non-empty (checked above) and `index` is only ever assigned
   * `(index + 1) % endpoints.length`, so both lookups are always defined. That
   * invariant is stated here ONCE rather than asserted at each of the four call
   * sites below, which keeps the reasoning in one place and stops a `!` from
   * quietly outliving the check it depended on.
   */
  function current(): { endpoint: ChainEndpoint; reader: ChainReader } {
    const endpoint = endpoints[index];

    if (endpoint === undefined) {
      throw new Error(`No endpoint at index ${index}; the endpoint list shrank after construction`);
    }

    readers[index] ??= endpoint.create();

    const reader = readers[index];

    if (reader === undefined) {
      throw new Error(`Endpoint ${endpoint.label} produced no reader`);
    }

    return { endpoint, reader };
  }

  /**
   * Records one failure and decides whether to move on.
   *
   * Does not rethrow or return: every caller is inside a `catch` that rethrows
   * the original error, and converting it here would replace the real reason with
   * this function's own.
   */
  function recordFailure(): void {
    failures += 1;

    if (failures < threshold) return;

    const { endpoint: from } = current();

    index = (index + 1) % endpoints.length;
    rotations += 1;
    failures = 0;

    onRotate?.({ from: from.label, to: current().endpoint.label, consecutiveFailures: threshold });
  }

  /** Runs one read, recording success or failure around it. */
  async function attempt<T>(call: (reader: ChainReader) => Promise<T>): Promise<T> {
    try {
      const result = await call(current().reader);

      // A success is the only thing that clears the count. Resetting on rotation
      // instead would let a partly-broken endpoint keep its turn forever: it would
      // fail, rotate, and the count would already be zero when it came back.
      failures = 0;

      return result;
    } catch (error) {
      recordFailure();

      throw error;
    }
  }

  return {
    reader: {
      getBlockNumber: () => attempt((reader) => reader.getBlockNumber()),
      getLogs: (args) => attempt((reader) => reader.getLogs(args)),
    },
    activeLabel: () => current().endpoint.label,
    consecutiveFailures: () => failures,
    rotations: () => rotations,
  };
}
