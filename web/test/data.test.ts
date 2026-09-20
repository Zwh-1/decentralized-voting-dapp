// SPDX-License-Identifier: MIT
/**
 * Regression tests for how `data.ts` behaves when the index cannot be read.
 *
 * The index has two ways of being missing, and the first version of this module
 * only handled one of them. With `DATABASE_URL` unset every read fell back to the
 * chain, but with `DATABASE_URL` set and the database *down* every read threw, so:
 *
 *   * `/api/candidates` and `/api/voters` answered 503 although the chain could
 *     answer both;
 *   * `/api/results` refused to serve the chain tally it had already read;
 *   * the ballot page caught the failure and told the reader
 *     "服务端无法读取链上数据" — the server could not read on-chain data — when the
 *     chain was perfectly healthy and the database was the thing that was down;
 *   * `getVoter` swallowed a chain failure and substituted `hasVoted: false`,
 *     turning "unknown" into a confident claim that nobody had voted.
 *
 * `getServerState` caches its state on `globalThis`, so these tests install a fake
 * state directly and drive the real code paths with no database and no node.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { getHealth, getResults, getTally, getVoter } from "../src/lib/data";

const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as const;
const VOTER = "0x019b020913b752e0b922b1c305fde9256546c04b" as const;

const CANDIDATES = [
  { id: 1n, metadataCID: "cid-1", voteCount: 67n },
  { id: 2n, metadataCID: "cid-2", voteCount: 67n },
  { id: 3n, metadataCID: "cid-3", voteCount: 66n },
];

/** A public client that answers the five calls this module makes. */
function fakeClient(options: { chainFails?: boolean } = {}) {
  return {
    async getBlockNumber(): Promise<bigint> {
      if (options.chainFails === true) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
      }

      return 406n;
    },
    async readContract(call: { functionName: string }): Promise<unknown> {
      if (options.chainFails === true) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
      }

      switch (call.functionName) {
        case "results":
          return [CANDIDATES, 200n];
        case "hasVoted":
          return true;
        case "votedFor":
          return 3n;
        case "stakeOf":
          return 0n;
        case "isWhitelisted":
          return true;
        default:
          throw new Error(`unexpected call: ${call.functionName}`);
      }
    },
  };
}

/** A pool that fails every query the way a stopped MySQL does. */
function deadPool() {
  return {
    async query(): Promise<never> {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3306");
    },
  };
}

/** A pool that answers the three reads this module makes, as a live index would. */
function livePool() {
  return {
    async query(sql: string): Promise<unknown[]> {
      if (sql.includes("FROM candidate_tally")) {
        return [
          [
            { candidate_id: 1, metadata_cid: "cid-1", vote_count: 67 },
            { candidate_id: 2, metadata_cid: "cid-2", vote_count: 67 },
            { candidate_id: 3, metadata_cid: "cid-3", vote_count: 66 },
          ],
        ];
      }

      if (sql.includes("FROM sync_cursor")) {
        return [[{ last_block: 406 }]];
      }

      if (sql.includes("FROM votes")) {
        return [[{ tx_hash: "0xabc" }]];
      }

      if (sql.includes("FROM refunds")) {
        return [[]];
      }

      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

/**
 * A live index whose cursor row is absent, i.e. migrated but never synced.
 *
 * Distinct from `deadPool()`: the read succeeds and the answer is "nothing has
 * been indexed yet", which is a fact about the deployment rather than a failure
 * to observe one.
 */
function emptyCursorPool() {
  return {
    async query(sql: string): Promise<unknown[]> {
      if (sql.includes("FROM sync_cursor")) {
        return [[]];
      }

      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function install(options: {
  pool?: unknown;
  chainFails?: boolean;
  migrateFails?: boolean;
  config?: Record<string, unknown>;
}): void {
  const ready =
    options.migrateFails === true
      ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:3306"))
      : Promise.resolve();

  // Swallowed here only so this construction does not become an unhandled
  // rejection; `ready()` in the module records it.
  ready.catch(() => {});

  (globalThis as Record<string, unknown>).__votingServerState = {
    config: {
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      votingAddress: CONTRACT,
      databaseUrl: options.pool === undefined ? null : "mysql://root@127.0.0.1:3306/voting",
      confirmations: 0,
      chunkBlocks: 2000,
      pollIntervalMs: 2000,
      indexerEnabled: true,
      startBlock: 1n,
      ...options.config,
    },
    client: fakeClient(options.chainFails === true ? { chainFails: true } : {}),
    pool: options.pool ?? null,
    ready,
    syncLoopStarted: true,
    indexError: null,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__votingServerState;
});

describe("getTally with a configured but unreachable index", () => {
  it("answers from the chain instead of failing", async () => {
    install({ pool: deadPool() });

    const tally = await getTally();

    assert.equal(tally.source, "chain", "a dead index must not take the chain answer with it");
    assert.equal(tally.total, 200);
    assert.deepEqual(
      tally.candidates.map((candidate) => candidate.voteCount),
      [67, 67, 66],
    );
  });

  it("still answers from the index when the index works", async () => {
    install({ pool: livePool() });

    const tally = await getTally();

    assert.equal(tally.source, "index");
  });
});

describe("getResults with a configured but unreachable index", () => {
  it("refuses to claim a verdict, but still reports the chain tally", async () => {
    install({ pool: deadPool() });

    const results = await getResults();

    assert.equal(results.status, "unavailable", "nothing was compared, so nothing may be claimed");
    assert.equal(results.indexedTotal, null);
    assert.equal(results.indexed, null);
    assert.deepEqual(results.discrepancies, []);
    assert.equal(results.onChainTotal, 200, "the chain half was readable and must be served");
    assert.equal(results.lastIndexedBlock, null);
  });
});

describe("getVoter with a configured but unreachable index", () => {
  it("keeps the chain-derived answers, including the whitelist decision", async () => {
    install({ pool: deadPool() });

    const voter = await getVoter(VOTER);

    assert.equal(voter.source, "chain");
    assert.equal(voter.hasVoted, true, "whether you voted is chain-authoritative");
    assert.equal(voter.votedFor, 3);
    assert.equal(
      voter.whitelisted,
      true,
      "isWhitelisted is a public getter, so the answer must not depend on the index",
    );
    assert.equal(voter.voteTxHash, null, "the index supplied that, and it is gone");
  });

  it("does not turn an unreachable chain into 'nobody has voted'", async () => {
    install({ pool: livePool(), chainFails: true });

    await assert.rejects(
      () => getVoter(VOTER),
      /ECONNREFUSED/,
      "a chain failure must surface, not be replaced by hasVoted: false",
    );
  });
});

describe("getHealth", () => {
  it("reports an unreachable index without pretending the chain is down", async () => {
    install({ pool: deadPool() });

    const health = await getHealth();

    assert.equal(health.status, "degraded");
    assert.equal(health.indexError, "connect ECONNREFUSED 127.0.0.1:3306");
    assert.equal(health.chainHead, "406", "the chain was readable and must be reported");
    assert.equal(health.lastIndexedBlock, null);
  });

  it("reports no index error when the index works", async () => {
    install({ pool: livePool() });

    const health = await getHealth();

    assert.equal(health.status, "ok");
    assert.equal(health.indexError, null);
  });

  it("reports no index error when no index is configured at all", async () => {
    install({});

    const health = await getHealth();

    assert.equal(health.status, "ok");
    assert.equal(health.indexError, null);
    assert.equal(health.indexConfigured, false);
  });

  it("reports a schema-application failure rather than throwing", async () => {
    install({ pool: deadPool(), migrateFails: true });

    const health = await getHealth();

    assert.equal(health.status, "degraded");
    assert.match(String(health.indexError), /ECONNREFUSED/);
  });

  it("separates 'an index exists' from 'the loop that advances it is on'", async () => {
    // These were one field once. `isIndexEnabled` computes `databaseUrl !== null`,
    // so it reported `true` while `INDEXER_ENABLED=false` had deliberately stopped
    // the loop, and a reader could not tell whether the height would ever move on
    // its own.
    install({ pool: livePool(), config: { indexerEnabled: false } });

    const health = await getHealth();

    assert.equal(health.indexConfigured, true, "DATABASE_URL is set, so an index exists");
    assert.equal(health.indexerLoopEnabled, false, "but the background loop is switched off");
  });

  it("never claims a running loop when there is no index to advance", async () => {
    // `INDEXER_ENABLED` defaults to true, so reporting the raw flag would answer
    // `true` here — for a loop that has nothing to advance and never runs.
    install({ pool: null, config: { databaseUrl: null, indexerEnabled: true } });

    const health = await getHealth();

    assert.equal(health.indexConfigured, false);
    assert.equal(health.indexerLoopEnabled, false);
  });

  it("reports no lag figure when there is no index to be behind", async () => {
    // The chain is healthy here, so a figure was computable — and was published:
    // with a 406-block chain at 0 confirmations this read `406`, the whole chain.
    // A reader saw `索引高度 未启用` next to `落后区块 406`, i.e. a lag for an index
    // that does not exist.
    install({ pool: null, config: { databaseUrl: null, confirmations: 0 } });

    const health = await getHealth();

    assert.equal(health.chainHead, "406", "the chain was readable and must still be reported");
    assert.equal(health.indexConfigured, false);
    assert.equal(health.lastIndexedBlock, null);
    assert.equal(
      health.lagBlocks,
      null,
      "an index-less deployment has no index lag, so it must not publish one",
    );
  });

  it("reports no lag figure when the cursor could not be read", async () => {
    // Same defect, harder to notice: the index is configured, so a lag figure
    // looks legitimate, but the read that would produce it failed. It fell back to
    // "nothing has been indexed", which on a real chain reports millions of blocks
    // behind for an outage that may have started one second ago.
    install({ pool: deadPool(), config: { confirmations: 0 } });

    const health = await getHealth();

    assert.equal(health.indexConfigured, true, "an index is configured...");
    assert.match(String(health.indexError), /ECONNREFUSED/, "...and it is what failed");
    assert.equal(health.lastIndexedBlock, null);
    assert.equal(
      health.lagBlocks,
      null,
      "a lag we could not read must not be rendered as the number we assume",
    );
  });

  it("still reports the lag for a migrated index that has never synced", async () => {
    // The case the fix must not swallow: `lastIndexedBlock: null` here is a fact,
    // not an absence of one, and every safe block genuinely is unindexed. Nulling
    // the figure wherever the cursor is null would hide real work from the reader.
    install({ pool: emptyCursorPool(), config: { confirmations: 0 } });

    const health = await getHealth();

    assert.equal(health.indexConfigured, true);
    assert.equal(health.lastIndexedBlock, null, "the cursor row exists but is empty");
    // Blocks 0..406 inclusive, all of them safe to index at 0 confirmations.
    assert.equal(health.lagBlocks, "407", "all 407 safe blocks are unindexed");
  });
});
