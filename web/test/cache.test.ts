// SPDX-License-Identifier: MIT
/**
 * Tests for the read-through cache.
 *
 * Two properties carry the whole design and neither is visible in a page:
 *
 *   1. a FAILED read is never cached, because caching a rejection turns one
 *      transient RPC blip into a guaranteed outage for the whole TTL;
 *   2. concurrent callers during a cold cache share ONE read, because otherwise
 *      the cache does not reduce load exactly when load is highest.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createReadCache } from "../src/lib/cache";

/** A controllable clock, so no test depends on wall time. */
function clock(start = 1000) {
  let current = start;

  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("createReadCache", () => {
  it("reads once and serves the cached value within the TTL", async () => {
    const time = clock();
    let reads = 0;

    const cache = createReadCache(
      async () => {
        reads += 1;
        return reads;
      },
      { ttlMs: 1000, now: time.now },
    );

    assert.equal(await cache.get(), 1);
    assert.equal(await cache.get(), 1);
    assert.equal(await cache.get(), 1);
    assert.equal(reads, 1, "the producer ran once");
  });

  it("reads again once the TTL has elapsed", async () => {
    const time = clock();
    let reads = 0;

    const cache = createReadCache(
      async () => {
        reads += 1;
        return reads;
      },
      { ttlMs: 1000, now: time.now },
    );

    assert.equal(await cache.get(), 1);

    time.advance(1001);

    assert.equal(await cache.get(), 2);
    assert.equal(reads, 2);
  });

  it("treats the TTL boundary as expired", async () => {
    // Exactly at the boundary the entry is no longer usable. Which side of the
    // line this falls on decides whether a value can be served one tick past its
    // stated lifetime, so it is pinned rather than left to `>` vs `>=`.
    const time = clock();
    let reads = 0;

    const cache = createReadCache(
      async () => {
        reads += 1;
        return reads;
      },
      { ttlMs: 1000, now: time.now },
    );

    await cache.get();
    time.advance(1000);

    assert.equal(await cache.get(), 2);
  });

  it("shares one read between concurrent callers", async () => {
    // The property that makes the cache useful under load. Without it, N callers
    // arriving during a cold cache all miss and all issue the full read.
    let reads = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const cache = createReadCache(
      async () => {
        reads += 1;
        await gate;

        return "value";
      },
      { ttlMs: 1000 },
    );

    const first = cache.get();
    const second = cache.get();
    const third = cache.get();

    release();

    assert.deepEqual(await Promise.all([first, second, third]), ["value", "value", "value"]);
    assert.equal(reads, 1, "one read served all three callers");
  });

  it("does NOT cache a rejection, so a blip does not become an outage", async () => {
    // The rule that matters most. A cached rejection would keep telling every
    // reader the chain is unreachable long after it recovered.
    let attempt = 0;

    const cache = createReadCache(
      async () => {
        attempt += 1;

        if (attempt === 1) throw new Error("transient");

        return "recovered";
      },
      { ttlMs: 60_000 },
    );

    await assert.rejects(() => cache.get(), /transient/);

    // No clock advance: well inside the TTL, so only the failure rule can explain
    // this succeeding.
    assert.equal(await cache.get(), "recovered");
    assert.equal(attempt, 2);
  });

  it("does not let an older failure evict a newer successful entry", async () => {
    // A slow failing read finishing after a fresh one must not clear that fresh
    // entry, or the cache would silently stop working after any overlap.
    let failSlowly = (): void => {};
    const slow = new Promise<void>((resolve) => {
      failSlowly = resolve;
    });

    let attempt = 0;
    let releaseSecond = (): void => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const cache = createReadCache(
      async () => {
        attempt += 1;

        if (attempt === 1) {
          await slow;
          throw new Error("slow failure");
        }

        await secondGate;

        return "fresh";
      },
      { ttlMs: 0 },
    );

    // Start the slow failing read, then invalidate and start a fresh one.
    const failing = cache.get();
    cache.invalidate();
    const succeeding = cache.get();

    releaseSecond();
    assert.equal(await succeeding, "fresh");

    failSlowly();
    await assert.rejects(() => failing, /slow failure/);

    // The fresh entry must still be held.
    assert.equal(cache.has(), true, "the newer entry survived the older failure");
    assert.equal(await cache.get(), "fresh");
  });

  it("collapses concurrent reads but never caches when ttlMs is 0", async () => {
    // A useful configuration in its own right: dedupe a burst, never serve a
    // stale answer.
    let reads = 0;

    const cache = createReadCache(
      async () => {
        reads += 1;
        return reads;
      },
      { ttlMs: 0 },
    );

    assert.equal(await cache.get(), 1);
    assert.equal(await cache.get(), 2, "the second sequential read is fresh");
    assert.equal(reads, 2);
  });

  it("reports whether a value is held", async () => {
    const cache = createReadCache(async () => "v", { ttlMs: 1000 });

    assert.equal(cache.has(), false);

    await cache.get();
    assert.equal(cache.has(), true);

    cache.invalidate();
    assert.equal(cache.has(), false);
  });

  it("invalidate makes the next read fresh even inside the TTL", async () => {
    let reads = 0;

    const cache = createReadCache(
      async () => {
        reads += 1;
        return reads;
      },
      { ttlMs: 60_000 },
    );

    await cache.get();
    cache.invalidate();

    assert.equal(await cache.get(), 2);
  });
});
