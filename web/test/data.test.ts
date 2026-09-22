// SPDX-License-Identifier: MIT
/**
 * Regression tests for how `data.ts` behaves when the index cannot be read.
 *
 * The index has two ways of being missing, and the first version of this module
 * only handled one of them. With `DATABASE_URL` unset every read fell back to the
 * chain, but with `DATABASE_URL` set and the database *down* every read threw, so:
 *
 *   * the tally and voter routes answered 503 although the chain could answer
 *     both;
 *   * the results route refused to serve the chain tally it had already read;
 *   * the ballot page caught the failure and told the reader
 *     "服务端无法读取链上数据" — the server could not read on-chain data — when the
 *     chain was perfectly healthy and the database was the thing that was down;
 *   * `getVoter` swallowed a chain failure and substituted `hasVoted: false`,
 *     turning "unknown" into a confident claim that nobody had voted.
 *
 * Every read is now scoped to one poll, so each test names a poll address. That
 * scoping is itself part of the regression surface: two polls share an ABI and an
 * event signature, so a read that forgets the address would sum every poll's
 * votes into one meaningless number and still look plausible.
 *
 * `getServerState` caches its state on `globalThis`, so these tests install a fake
 * state directly and drive the real code paths with no database and no node.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getHealth,
  getPoll,
  getPolls,
  getResults,
  getTally,
  getVotedPolls,
  getVoter,
} from "../src/lib/data";

const FACTORY = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as const;
const POLL = "0x9f1ac54bef0dd2f6f3462ea0fa94fc62300d3a8e" as const;
const OTHER_POLL = "0xbf9fbff01664500a33080da5d437028b07dfcc55" as const;
const VOTER = "0x019b020913b752e0b922b1c305fde9256546c04b" as const;

const OPTIONS = [
  { id: 1n, labelCID: "cid-1", voteCount: 67n },
  { id: 2n, labelCID: "cid-2", voteCount: 67n },
  { id: 3n, labelCID: "cid-3", voteCount: 66n },
];

/**
 * A public client that answers the calls this module makes.
 *
 * `allPolls` returns two addresses on purpose: the poll-scoped reads must be
 * issued against the address they were given, and a client that answered every
 * address identically would not notice if one of them were dropped.
 */
function fakeClient(options: { chainFails?: boolean; pollFails?: boolean } = {}) {
  const fail = (): never => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
  };

  return {
    async getBlockNumber(): Promise<bigint> {
      return options.chainFails === true ? fail() : 406n;
    },
    async readContract(call: { functionName: string; address?: string }): Promise<unknown> {
      if (options.chainFails === true) {
        return fail();
      }

      // A poll whose own reads fail: used to prove `getPolls` lists it anyway
      // rather than silently dropping it.
      if (options.pollFails === true && call.address === OTHER_POLL) {
        return fail();
      }

      switch (call.functionName) {
        case "allPolls":
          return [POLL, OTHER_POLL];
        case "results":
          // The two polls must not share a tally.
          return [
            call.address === OTHER_POLL
              ? [{ id: 1n, labelCID: "other-1", voteCount: 3n }]
              : OPTIONS,
            call.address === OTHER_POLL ? 3n : 200n,
          ];
        case "creator":
          return "0x1111111111111111111111111111111111111111";
        case "question":
          return call.address === OTHER_POLL ? "另一个投票" : "第一个投票";
        case "endsAt":
          return 1_800_000_000n;
        case "optionCount":
          return call.address === OTHER_POLL ? 1n : 3n;
        case "phase":
          return 1;
        case "voterState":
          // A struct, matching the contract's named return. `marked` is the
          // authority on "has voted" — not a non-zero `currentOptionId`, which
          // is what the previous tuple shape forced every caller to infer.
          return {
            whitelisted: true,
            currentOptionId: 3n,
            stake: 0n,
            marked: true,
            canVote: true,
            selections: [3n],
            power: 1n,
          };
        default:
          throw new Error(`unexpected call: ${call.functionName}`);
      }
    },
  };
}

/**
 * A pool that fails every query the way a stopped MySQL does.
 *
 * The `code`/`errno`/`syscall` fields are what mysql2 really attaches to a refused
 * connection, and they are load-bearing now: the failure text alone
 * (`connect ECONNREFUSED 127.0.0.1:3306`) is identical to an RPC refusal, so
 * `describeFailure` decides by the driver's own marks rather than by that text.
 * A fixture without them would exercise a shape MySQL never produces.
 */
function deadPool() {
  return {
    async query(): Promise<never> {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), {
        code: "ECONNREFUSED",
        errno: -4078,
        syscall: "connect",
        address: "127.0.0.1",
        port: 3306,
      });
    },
  };
}

/**
 * A pool that answers the reads this module makes, as a live index would.
 *
 * The flags change only the `votes` rows, because that is the one read whose
 * projection the module does real work on: the other tables are returned as-is.
 */
function livePool(options: { multiSelectShareTx?: boolean; revoteAfterWithdrawal?: boolean } = {}) {
  return {
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      if (sql.includes("FROM option_tally")) {
        assert.deepEqual(
          params,
          [POLL],
          "the indexed tally must be scoped to the poll it was asked about",
        );

        return [
          [
            { option_id: 1, label_cid: "cid-1", vote_count: 67 },
            { option_id: 2, label_cid: "cid-2", vote_count: 67 },
            { option_id: 3, label_cid: "cid-3", vote_count: 66 },
          ],
        ];
      }

      if (sql.includes("FROM sync_cursor")) {
        return [[{ last_block: 406 }]];
      }

      if (sql.includes("FROM votes")) {
        assert.deepEqual(params, [POLL, VOTER], "the history must be scoped to poll and voter");

        // A multi-select change of mind: ONE log, TWO rows, because the
        // selection was {2,3}. They share a transaction and a log index, which
        // is what tells the projection these are one action rather than two.
        // Listing them separately would tell a reader their address voted twice
        // in the same block.
        if (options.multiSelectShareTx === true) {
          return [
            [
              {
                event_type: "cast",
                option_id: 1,
                tx_hash: "0xfirst",
                block_number: "100",
                log_index: 0,
              },
              {
                event_type: "changed",
                option_id: 2,
                tx_hash: "0xsecond",
                block_number: "120",
                log_index: 3,
              },
              {
                event_type: "changed",
                option_id: 3,
                tx_hash: "0xsecond",
                block_number: "120",
                log_index: 3,
              },
            ],
          ];
        }

        // A genuine re-vote after a withdrawal: its own transaction, so it is a
        // real action and must be kept.
        if (options.revoteAfterWithdrawal === true) {
          return [
            [
              {
                event_type: "cast",
                option_id: 2,
                tx_hash: "0xfirst",
                block_number: "100",
                log_index: 0,
              },
              {
                event_type: "withdrawn",
                option_id: 0,
                tx_hash: "0xsecond",
                block_number: "120",
                log_index: 1,
              },
              {
                event_type: "cast",
                option_id: 1,
                tx_hash: "0xthird",
                block_number: "140",
                log_index: 0,
              },
            ],
          ];
        }

        return [
          [
            {
              event_type: "cast",
              option_id: 2,
              tx_hash: "0xfirst",
              block_number: "100",
              log_index: 0,
            },
            {
              event_type: "changed",
              option_id: 3,
              tx_hash: "0xsecond",
              block_number: "120",
              log_index: 1,
            },
          ],
        ];
      }

      if (sql.includes("FROM refunds")) {
        return [[]];
      }

      // The reverse lookup: which polls does this address hold a vote in. Not
      // scoped by poll — that is the whole point of the query, and a version
      // that took a poll address would be the scan it exists to replace.
      if (sql.includes("FROM current_votes")) {
        assert.deepEqual(
          params,
          [VOTER],
          "the reverse lookup must be scoped to the voter it was asked about",
        );

        return [
          [
            {
              address: POLL,
              option_id: 3,
              question: "Which one?",
              block_number: "120",
              tx_hash: "0xsecond",
            },
            {
              address: OTHER_POLL,
              option_id: 1,
              // A vote whose `polls` row has not been indexed yet. The LEFT JOIN
              // must keep the row and leave the question null rather than
              // dropping a vote that really exists.
              question: null,
              block_number: "100",
              tx_hash: "0xfirst",
            },
          ],
        ];
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
  pollFails?: boolean;
  migrateFails?: boolean;
  config?: Record<string, unknown>;
}): void {
  const ready =
    options.migrateFails === true
      ? Promise.reject(
          Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), {
            code: "ECONNREFUSED",
            errno: -4078,
            syscall: "connect",
            address: "127.0.0.1",
            port: 3306,
          }),
        )
      : Promise.resolve();

  // Swallowed here only so this construction does not become an unhandled
  // rejection; `ready()` in the module records it.
  ready.catch(() => {});

  (globalThis as Record<string, unknown>).__votingServerState = {
    config: {
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      factoryAddress: FACTORY,
      databaseUrl: options.pool === undefined ? null : "mysql://root@127.0.0.1:3306/voting",
      confirmations: 0,
      chunkBlocks: 2000,
      pollIntervalMs: 2000,
      indexerEnabled: true,
      startBlock: 1n,
      ...options.config,
    },
    client: fakeClient({
      ...(options.chainFails === true ? { chainFails: true } : {}),
      ...(options.pollFails === true ? { pollFails: true } : {}),
    }),
    pool: options.pool ?? null,
    ready,
    syncLoopStarted: true,
    indexError: null,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__votingServerState;
});

describe("getPolls", () => {
  it("lists every poll the factory created, newest first", async () => {
    install({});

    const polls = await getPolls();

    assert.deepEqual(
      polls.map((poll) => poll.address),
      [OTHER_POLL, POLL],
      "the factory appends, so the newest poll is last on chain and first here",
    );
    assert.equal(polls[1]?.question, "第一个投票");
  });

  it("keeps each poll's own tally apart from the other's", async () => {
    install({});

    const polls = await getPolls();
    const first = polls.find((poll) => poll.address === POLL);
    const second = polls.find((poll) => poll.address === OTHER_POLL);

    assert.equal(first?.totalVotes, 200);
    assert.equal(second?.totalVotes, 3, "two polls must never share a tally");
  });

  it("still lists a poll whose own reads failed, rather than hiding it", async () => {
    // Omitting it would say "this poll does not exist", which is the one wrong
    // answer this function must not give.
    install({ pollFails: true });

    const polls = await getPolls();

    assert.deepEqual(
      polls.map((poll) => poll.address),
      [POLL],
      "the readable poll is listed and the unreadable one is not invented",
    );
  });
});

describe("getPoll", () => {
  it("reads the facts of the poll it was given", async () => {
    install({});

    const poll = await getPoll(POLL);

    assert.equal(poll.address, POLL);
    assert.equal(poll.question, "第一个投票");
    assert.equal(poll.optionCount, 3);
    assert.equal(poll.endsAt, "1800000000", "a uint256 deadline travels as a string");
  });
});

describe("getTally with a configured but unreachable index", () => {
  it("answers from the chain instead of failing", async () => {
    install({ pool: deadPool() });

    const tally = await getTally(POLL);

    assert.equal(tally.source, "chain", "a dead index must not take the chain answer with it");
    assert.equal(tally.total, 200);
    assert.deepEqual(
      tally.options.map((option) => option.voteCount),
      [67, 67, 66],
    );
  });

  it("still answers from the index when the index works", async () => {
    install({ pool: livePool() });

    const tally = await getTally(POLL);

    assert.equal(tally.source, "index");
  });
});

describe("getResults with a configured but unreachable index", () => {
  it("refuses to claim a verdict, but still reports the chain tally", async () => {
    install({ pool: deadPool() });

    const results = await getResults(POLL);

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

    const voter = await getVoter(POLL, VOTER);

    assert.equal(voter.source, "chain");
    assert.equal(voter.hasVoted, true, "whether you voted is chain-authoritative");
    assert.equal(voter.votedFor, 3);
    assert.equal(
      voter.whitelisted,
      true,
      "isWhitelisted is a public getter, so the answer must not depend on the index",
    );
    assert.equal(voter.voteTxHash, null, "the index supplied that, and it is gone");
    assert.deepEqual(voter.history, [], "the history is index-only, so it is empty not wrong");
  });

  it("carries the whole history from the index, including a change", async () => {
    install({ pool: livePool() });

    const voter = await getVoter(POLL, VOTER);

    assert.equal(voter.source, "index");
    assert.deepEqual(
      voter.history.map((event) => [event.kind, event.optionId]),
      [
        ["cast", 2],
        ["changed", 3],
      ],
      "a change is an event in its own right, not a second cast",
    );
    assert.equal(voter.stakeWei, "0");
  });

  it("lists a multi-select change as ONE history entry, not one per option", async () => {
    // A multi-select vote is one log that produced one row per selected option,
    // and the rows share a transaction AND a log index. The projection has to
    // recognise them as a single action: listing {2,3} as two entries would tell
    // a reader their address voted twice in the same block, when it voted once
    // for two things.
    install({ pool: livePool({ multiSelectShareTx: true }) });

    const voter = await getVoter(POLL, VOTER);

    assert.equal(voter.history.length, 2, "two actions: the first vote, then the change");
    assert.equal(voter.history[1]?.kind, "changed");
    assert.deepEqual(
      voter.history[1]?.optionIds,
      [2, 3],
      "and the one entry carries the whole new set",
    );
  });

  it("still lists a re-vote after a withdrawal as its own action", async () => {
    // The negative control for the rule above. Collapsing rows by transaction is
    // only correct when they are the same action; a vote cast in its own
    // transaction, after an intervening withdrawal, is a genuinely separate
    // event and must survive. Without this, "merge everything that shares a tx"
    // would look correct.
    install({ pool: livePool({ revoteAfterWithdrawal: true }) });

    const voter = await getVoter(POLL, VOTER);

    assert.deepEqual(
      voter.history.map((event) => event.kind),
      ["cast", "withdrawn", "cast"],
      "withdrawing is an action, and voting again afterwards is another",
    );
  });

  it("does not turn an unreachable chain into 'nobody has voted'", async () => {
    install({ pool: livePool(), chainFails: true });

    await assert.rejects(
      () => getVoter(POLL, VOTER),
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
    // The reason names the dependency and the variable that configures it. It is
    // also *not* the driver's raw text: that text is what carries the endpoint and
    // key on the chain side, `/api/health` is unauthenticated, and this very
    // response is fetched by the browser. The raw error goes to the server log.
    assert.match(String(health.indexError), /DATABASE_URL/, "the reason names what to fix");
    assert.ok(!String(health.indexError).includes("127.0.0.1:3306"));
    assert.equal(health.chainHead, "406", "the chain was readable and must be reported");
    assert.equal(health.lastIndexedBlock, null);
    assert.equal(health.pollCount, 2, "the factory was readable, so its count is reported");
  });

  it("reports the factory address, not a single poll", async () => {
    install({ pool: livePool() });

    const health = await getHealth();

    assert.equal(health.contract, FACTORY);
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
    assert.match(String(health.indexError), /DATABASE_URL/);
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
    assert.match(String(health.indexError), /DATABASE_URL/, "...and it is what failed");
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

  it("does not invent a poll count when the factory cannot be read", async () => {
    // A zero would read as "no polls exist", which is a fact this deployment
    // cannot assert while the chain is unreachable.
    install({ chainFails: true });

    const health = await getHealth();

    assert.equal(health.pollCount, null);
    assert.equal(health.chainHead, null);
  });
});

describe("getVotedPolls", () => {
  it("answers from the index without touching the chain", async () => {
    // The one read in this module with no chain fallback, and the reason is
    // structural: the chain has no reverse index from a voter to their polls, so
    // the alternative is one round trip per poll. A chain call here would be a
    // regression, so the fake chain throws on every method.
    install({ pool: livePool(), chainFails: true });

    const result = await getVotedPolls(VOTER);

    assert.notEqual(result, null);
    assert.equal(result?.source, "index");
    assert.equal(result?.address, VOTER);
  });

  it("returns the polls with their option and question, newest first", async () => {
    install({ pool: livePool() });

    const result = await getVotedPolls(VOTER);

    assert.deepEqual(result?.polls, [
      {
        address: POLL,
        optionId: 3,
        question: "Which one?",
        blockNumber: "120",
        txHash: "0xsecond",
      },
      {
        address: OTHER_POLL,
        optionId: 1,
        question: null,
        blockNumber: "100",
        txHash: "0xfirst",
      },
    ]);
  });

  it("keeps a vote whose poll row is not indexed yet, with a null question", async () => {
    // The LEFT JOIN is load-bearing. A vote can be indexed in a batch whose
    // factory `PollCreated` has not been written yet, and dropping the row would
    // hide a vote that genuinely exists — the reader would be told they hold
    // nothing in a poll they are actually voting in.
    install({ pool: livePool() });

    const result = await getVotedPolls(VOTER);
    const orphan = result?.polls.find((poll) => poll.address === OTHER_POLL);

    assert.notEqual(orphan, undefined, "the vote survives a missing polls row");
    assert.equal(orphan?.question, null, "and its question is honestly unknown");
    assert.equal(orphan?.optionId, 1, "while the option it backs is still known");
  });

  it("returns null rather than an empty list when no index is configured", async () => {
    // The distinction this whole function exists to preserve: "you have voted in
    // nothing" and "I cannot tell you" are different answers, and only the second
    // one is true here. An empty array would be the confident false answer.
    install({ pool: undefined });

    assert.equal(await getVotedPolls(VOTER), null);
  });

  it("returns null when the database is configured but down", async () => {
    // Same outcome as no index at all, for the reason ADR-0011 gives: whether the
    // index was never configured or is unreachable, the app still has to answer,
    // and here the honest answer is that this question cannot be answered.
    install({ pool: deadPool() });

    assert.equal(await getVotedPolls(VOTER), null);
  });

  it("records the failure so /api/health can report it", async () => {
    // A null return must not be silent: the outage is what the reader needs to
    // see in order to understand why this page fell back to a scan.
    install({ pool: deadPool() });

    await getVotedPolls(VOTER);
    const health = await getHealth();

    assert.notEqual(health.indexError, null, "the outage is reported");
    assert.equal(health.status, "degraded");
  });
});
