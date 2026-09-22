// SPDX-License-Identifier: MIT
/**
 * Server-side data access.
 *
 * One place that decides where each answer comes from:
 *
 *   * the CHAIN is authoritative for the tally, the phase, the whitelist decision,
 *     whether you voted, what you voted for and your stake. These are never taken
 *     from the index, and the chain's answer is always compared against the index
 *     when one is available.
 *   * the INDEX supplies what the chain does not cheaply expose: the vote
 *     transaction hash and the refund history.
 *
 * There are two ways for the index to be missing, and they must be handled the
 * same way, because the chain is the source of truth in both:
 *
 *   * `DATABASE_URL` is unset — the index was never configured;
 *   * `DATABASE_URL` is set but the database cannot be read — the index is down.
 *
 * In both cases every read falls back to the chain, `source` says so, and the API
 * reports the comparison as `unavailable` rather than claiming a verdict it could
 * not compute. Treating only the first case as "no index" meant a database outage
 * replaced answers the chain could still give with a 503, and the ballot page then
 * told the reader the *chain* was unreadable when it was the database that was
 * down. The outage is still visible: `/api/health` reports it in `indexError`.
 *
 * This module is server-only: it holds a MySQL pool and an RPC client. Client
 * components must never import it.
 */
import type { Pool } from "mysql2/promise";

import {
  asChainReader,
  buildChainClient,
  readOnChainEligibility,
  readOnChainPoll,
  readOnChainPolls,
  readOnChainTally,
  readOnChainVoter,
  type OnChainEligibility,
  type OnChainVoter,
} from "./chain";
import { isIndexEnabled, loadServerConfig, type ServerConfig } from "./config";
import type { AuditEntry, AuditFilters } from "./audit";
import { createReadCache, type ReadCache } from "./cache";
import {
  EVENT_BRANCHES,
  EVENT_ORDER_BY,
  branchSql,
  type EventBranch,
} from "./indexer/event-branches";
import { watermarkFor, type NotificationEntry, type Subscription } from "./notify";
import { migrate } from "./db/migrate";
import { createPool } from "./db/pool";
import { createRotatingChainReader, type RotatingChainReader } from "./indexer/endpoints";
import { classifyFailure, renderFailure, type FailureShape } from "./failure";
import { DEFAULT_LOCALE, translatorFor, type Locale } from "./i18n";
import { lagBlocks } from "./indexer/plan";
import { readCursor, startSyncLoop, syncOnce, type Logger, type SyncOutcome } from "./indexer/sync";
import { checkConsistency, readIndexedTally } from "./report";
import { orderActivity, withoutChangeEcho, type ActivityEntry } from "./poll-report";
import type {
  HealthResponse,
  PollSummary,
  ResultsResponse,
  SyncResponse,
  TallyResponse,
  VotedPollsResponse,
  VoterResponse,
} from "./types";
import type { ChainTarget } from "./voting";

/**
 * Lazily built singletons.
 *
 * Cached on `globalThis` because Next.js re-evaluates modules on hot reload in
 * development; without this every edit would leak another connection pool.
 */
interface ServerState {
  config: ServerConfig;
  client: ReturnType<typeof buildChainClient>;
  /**
   * The indexer's endpoint-rotating reader.
   *
   * A SINGLETON, and it has to be: rotation works by remembering how many times
   * the active endpoint has failed in a row, so a reader rebuilt per call would
   * forget that count every time and never rotate. Held here alongside `client`
   * because both are per-process resources with the same lifetime.
   */
  indexerChain: RotatingChainReader;
  pool: Pool | null;
  /**
   * The cached poll list.
   *
   * Built lazily on first use rather than in `initialise`, because the TTL comes
   * from config and building it eagerly would create a cache for a process that
   * never lists polls.
   */
  pollList?: ReadCache<PollSummary[]>;
  ready: Promise<void>;
  syncLoopStarted: boolean;
  /**
   * The most recent reason the index could not be read, or null.
   *
   * Cleared by any successful index read, so a recovered database stops being
   * reported without a restart. Reported through `/api/health`.
   *
   * Stored as a CLASSIFIED SHAPE rather than as a rendered sentence. This object
   * lives for the life of the process and the failure is recorded once, before any
   * reader exists — so a stored sentence would freeze whichever language was
   * active at that instant and then serve it to everybody. It is rendered per
   * request instead, at the point where a locale is actually known.
   */
  indexError: FailureShape | null;
}

/** A plain key rather than a symbol: symbols are not valid interface keys. */
interface GlobalWithState {
  __votingServerState?: ServerState;
}

function initialise(): ServerState {
  const config = loadServerConfig();
  // The whole endpoint list, not just the first: the client is built once and
  // lives for the process, so this is the single place where the configured
  // fallbacks either reach every server-side read or reach none of them.
  const client = buildChainClient(config.chainId, config.rpcUrls);

  // The indexer gets one client PER endpoint rather than the fallback client
  // above, because rotation needs to be able to talk to exactly one endpoint at a
  // time and know which one failed. A fallback transport hides that: it swallows
  // the individual failure and answers from whichever endpoint worked, so the
  // indexer could never accumulate the evidence that one endpoint is down.
  //
  // `asChainReader` is reused rather than a second adapter being written, so the
  // narrow read interface stays defined in one place (`indexer/sync.ts`).
  const indexerChain = createRotatingChainReader({
    endpoints: config.rpcUrls.map((url, position) => ({
      // Position only — never the URL, which may carry an apiKey (ADR-0020).
      label: `endpoint ${position + 1} of ${config.rpcUrls.length}`,
      create: () => asChainReader(buildChainClient(config.chainId, url)),
    })),
    onRotate: ({ from, to, consecutiveFailures }) => {
      console.warn(
        `[indexer] ${consecutiveFailures} consecutive failures on ${from}; now reading from ${to}`,
      );
    },
  });

  const state: ServerState = {
    config,
    client,
    indexerChain,
    pool: null,
    ready: Promise.resolve(),
    syncLoopStarted: false,
    indexError: null,
  };

  if (config.databaseUrl !== null) {
    const pool = createPool(config.databaseUrl);
    state.pool = pool;
    // Applying the schema on first use keeps `next dev` a one-command start.
    state.ready = migrate(config.databaseUrl);
  }

  return state;
}

export function getServerState(): ServerState {
  const globalStore = globalThis as unknown as GlobalWithState;

  globalStore.__votingServerState ??= initialise();

  return globalStore.__votingServerState;
}

/**
 * Waits until the optional schema has been applied.
 *
 * A failure here is recorded rather than thrown. Applying the schema happens once
 * per process, and when it fails it means the index is unreachable — not that the
 * process is broken. Throwing would take down reads the chain can still answer,
 * and the caller would be told the chain was unreadable when it was not.
 */
async function ready(state: ServerState): Promise<void> {
  try {
    await state.ready;
  } catch (error) {
    recordIndexFailure(state, error);
  }
}

/**
 * Remembers why the index could not be read, for `/api/health` to report.
 *
 * The recorded text is the classified sentence, not the raw throwable: the raw
 * one is a driver error that can embed the endpoint and its `apiKey`, and
 * `/api/health` is unauthenticated. The raw error is logged instead — once per
 * distinct reason, because this runs on every failed read and the index is polled
 * continuously. Two different errors that classify the same way therefore log
 * once; the operator still gets the full detail at least once per outage mode.
 */
function recordIndexFailure(state: ServerState, error: unknown): void {
  const described = classifyFailure(error);

  // Compared on the SHAPE, not on rendered text, so the "log once per distinct
  // failure mode" behaviour does not depend on which language was active.
  if (!sameFailure(state.indexError, described)) {
    console.error("[index] read failed", error);
  }

  state.indexError = described;
}

/** Whether two classified failures would render to the same sentence. */
function sameFailure(a: FailureShape | null, b: FailureShape): boolean {
  if (a === null) {
    return false;
  }

  return (
    a.fromChainClient === b.fromChainClient &&
    a.fromDatabase === b.fromDatabase &&
    a.method === b.method &&
    a.isError === b.isError &&
    a.message === b.message &&
    a.name === b.name
  );
}

/** Clears a previously recorded failure: the index answered this time. */
function recordIndexSuccess(state: ServerState): void {
  state.indexError = null;
}

/**
 * Reads from the index, falling back to the chain when the index cannot be read.
 *
 * `DATABASE_URL` being set makes the index *expected*, not *guaranteed*. The two
 * ways it can be missing — never configured, and configured but down — must lead
 * to the same place for any question the chain can answer, because the chain is
 * the source of truth either way (ADR-0001). Letting only the first fall back
 * meant a MySQL outage replaced answers the chain could still give with a 503,
 * and the page then reported that the *chain* was unreadable.
 *
 * The failure is not swallowed: it is recorded so `/api/health` shows the outage,
 * and the returned `source` tells the client which path answered.
 */
async function withIndex<T>(
  state: ServerState,
  readFromIndex: (pool: Pool) => Promise<T>,
  readFromChain: () => Promise<T>,
): Promise<T> {
  if (state.pool === null) {
    return readFromChain();
  }

  try {
    const value = await readFromIndex(state.pool);
    recordIndexSuccess(state);

    return value;
  } catch (error) {
    recordIndexFailure(state, error);

    return readFromChain();
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The chain and contract this deployment is configured for, for the browser.
 *
 * The browser cannot work this out for itself: `process.env.CHAIN_ID` is
 * server-only, and Next.js only inlines `NEXT_PUBLIC_*` into the client bundle.
 * Without this the client fell back to the first chain in its wagmi config — the
 * local Hardhat node — and a Sepolia-configured page rendered the local
 * contract's address and polled a node that was not running. See ADR-0019.
 *
 * Configuration errors are not raised here. This value only decides which chain
 * the *page* names; a deployment with a broken `.env` still has to render, and
 * `page.tsx` already reports the reads that genuinely failed.
 */
export function getConfiguredTarget(): ChainTarget | null {
  try {
    const config = loadServerConfig();

    return { chainId: config.chainId, factoryAddress: config.factoryAddress };
  } catch {
    return null;
  }
}

/**
 * Every poll, newest first.
 *
 * Read from the CHAIN, not the index. The factory's `allPolls()` is one call and
 * is by construction complete; an index that has not yet caught up with a
 * freshly created poll would hide it, and "my poll is not in the list" is a far
 * worse failure than a slow list. The index is used only to enrich, never to
 * decide what exists.
 *
 * A poll whose own reads fail is reported rather than dropped: silently omitting
 * it would look like the poll does not exist, which is the one wrong answer this
 * function must not give. The fields that could not be read become the honest
 * placeholders, and `totalVotes` falls back to 0 with the poll still listed.
 *
 * The whole result is cached briefly — see `readPollList` below for why that is
 * safe here and nowhere else.
 */
export async function getPolls(): Promise<PollSummary[]> {
  const state = getServerState();

  return readPollList(state);
}

/**
 * The cached body of `getPolls`.
 *
 * Cached for `readCacheTtlMs` because this is the one server read whose cost
 * grows with the number of polls: `allPolls()` plus one summary read per poll,
 * repeated by the list page, the API route and the poll detail page within the
 * same second. On a public RPC that is how an app reaches its own rate limit.
 *
 * Two things make the brief staleness acceptable, and both had to hold:
 *
 *   * the browser re-reads the same function through the wallet's chain and
 *     replaces this answer as soon as it lands, so the cached copy is only ever
 *     the FIRST PAINT. A poll created a second ago appears from the chain read
 *     without waiting for the cache to expire;
 *   * the TTL is far below the confirmation window, so nothing here can be
 *     described as final while the app is still calling it unconfirmed.
 *
 * The consistency check does not go through this and must not: it compares one
 * instant against the index (ADR-0017), and a cached head would make it accuse a
 * healthy index of diverging. See `cache.ts`.
 */
async function readPollList(state: ServerState): Promise<PollSummary[]> {
  state.pollList ??= createReadCache(() => readPollListUncached(state), {
    ttlMs: state.config.readCacheTtlMs,
  });

  return state.pollList.get();
}

/** One uncached pass over the factory and its polls. */
async function readPollListUncached(state: ServerState): Promise<PollSummary[]> {
  const addresses = await readOnChainPolls(state.client, state.config.factoryAddress);

  const summaries = await Promise.all(
    addresses.map(async (address): Promise<PollSummary | null> => {
      try {
        const poll = await readOnChainPoll(state.client, address);

        return {
          address,
          creator: poll.creator,
          question: poll.question,
          endsAt: poll.endsAt.toString(),
          optionCount: poll.optionCount,
          phase: poll.phase,
          totalVotes: poll.total,
        };
      } catch (error) {
        console.error("[polls] could not read poll", address, error);

        return null;
      }
    }),
  );

  // Reversed so the newest poll is first: the factory appends, so the last
  // address is the most recent. A reader arriving at the page wants what just
  // happened, not the oldest demo poll.
  return summaries.filter((summary): summary is PollSummary => summary !== null).reverse();
}

/** One poll's headline facts. Throws when the poll cannot be read at all. */
export async function getPoll(address: `0x${string}`): Promise<PollSummary> {
  const state = getServerState();
  const poll = await readOnChainPoll(state.client, address);

  return {
    address,
    creator: poll.creator,
    question: poll.question,
    endsAt: poll.endsAt.toString(),
    optionCount: poll.optionCount,
    phase: poll.phase,
    totalVotes: poll.total,
  };
}

/**
 * The tally of one poll. From MySQL when the index answers, otherwise straight
 * from the contract.
 */
export async function getTally(address: `0x${string}`): Promise<TallyResponse> {
  const state = getServerState();
  await ready(state);

  return withIndex(
    state,
    (pool) => readIndexedTally(pool, address),
    () => readOnChainTally(state.client, address),
  );
}

/** The shape reported when the two sources cannot be compared at all. */
function withoutComparison(onChain: TallyResponse): ResultsResponse {
  return {
    status: "unavailable",
    onChainTotal: onChain.total,
    indexedTotal: null,
    discrepancies: [],
    pendingVotes: 0,
    unindexedBlocks: null,
    onChain,
    indexed: null,
    lastIndexedBlock: null,
  };
}

/**
 * Both answers plus the comparison between them, for one poll.
 *
 * With no usable index this degrades honestly: `status` becomes "unavailable",
 * `indexedTotal` is null, and no comparison is claimed. That applies whether the
 * index was never configured or is configured and unreachable — in both cases
 * nothing was compared, so nothing may be asserted.
 *
 * The comparison itself lives in `checkConsistency` so that this route and the
 * `check-consistency` script cannot drift into different verdicts.
 */
export async function getResults(address: `0x${string}`): Promise<ResultsResponse> {
  const state = getServerState();
  await ready(state);

  // Read the chain first and let a failure propagate: this endpoint's whole
  // purpose is the comparison, and it cannot report a chain-side number it does
  // not have. An index-side failure below is a different matter — the comparison
  // is simply not available.
  const onChain = await readOnChainTally(state.client, address);

  if (state.pool === null) {
    return withoutComparison(onChain);
  }

  let check;
  try {
    check = await checkConsistency({
      client: state.client,
      pool: state.pool,
      address,
    });
    recordIndexSuccess(state);
  } catch (error) {
    recordIndexFailure(state, error);

    return withoutComparison(onChain);
  }

  return {
    status: check.status,
    onChainTotal: check.onChain.total,
    indexedTotal: check.indexed.total,
    discrepancies: check.discrepancies,
    pendingVotes: check.pendingVotes,
    unindexedBlocks: check.unindexedBlocks,
    onChain: check.onChain,
    indexed: check.indexed,
    lastIndexedBlock: check.lastIndexedBlock?.toString() ?? null,
  };
}

/**
 * How many may vote in a poll, and the denominator turnout is measured against.
 *
 * Read from the chain, like every other figure that ends up in an export: a
 * downloadable artefact is what a third party cites, and it must come from the
 * same source the contract itself would give (ADR-0001).
 *
 * A failure PROPAGATES rather than degrading to null, because the caller decides
 * what to do about it. The export route treats a failure as an error; a UI that
 * only displays the figure can show "unavailable" without failing the page. A
 * helper that swallowed it would make both callers unable to tell the difference
 * between "not computable" and "the read broke".
 */
export async function getEligibility(address: `0x${string}`): Promise<OnChainEligibility> {
  const state = getServerState();
  await ready(state);

  return readOnChainEligibility(state.client, address);
}

export async function getHealth(locale: Locale = DEFAULT_LOCALE): Promise<HealthResponse> {
  const state = getServerState();
  await ready(state);

  const indexConfigured = isIndexEnabled(state.config);

  let lastIndexedBlock: bigint | null = null;
  // `lastIndexedBlock === null` does not mean "the lag is unknown". A configured
  // index that has been migrated but never synced also has no cursor row, and
  // there "every safe block so far is unindexed" is the real answer. Telling the
  // two apart is what keeps the `lagBlocks` figure below honest, so track the
  // read itself rather than inferring it from the value.
  let cursorKnown = false;
  if (state.pool !== null) {
    try {
      lastIndexedBlock = await readCursor(state.pool);
      cursorKnown = true;
      recordIndexSuccess(state);
    } catch (error) {
      // Reported, not raised: the chain half of this response is still true, and
      // an index that is down is a degradation rather than a failure to answer.
      recordIndexFailure(state, error);
    }
  }

  let chainHead: bigint | null = null;
  try {
    chainHead = await state.client.getBlockNumber();
  } catch {
    chainHead = null;
  }

  // Read for the same reason `chainHead` is: it is a chain fact this response
  // claims, so a chain that cannot answer must yield null rather than a zero
  // that reads like "no polls exist".
  let pollCount: number | null = null;
  try {
    pollCount = (await readOnChainPolls(state.client, state.config.factoryAddress)).length;
  } catch {
    pollCount = null;
  }

  return {
    status: chainHead === null || state.indexError !== null ? "degraded" : "ok",
    chainId: state.config.chainId,
    contract: state.config.factoryAddress,
    pollCount,
    confirmations: state.config.confirmations,
    indexConfigured,
    // The flag alone is not the answer. `INDEXER_ENABLED` defaults to true, so
    // with no database configured it would report `true` for a loop that has
    // nothing to advance and never runs — the same "the name claims more than the
    // code does" trap this pair of fields exists to close.
    indexerLoopEnabled: indexConfigured && state.config.indexerEnabled,
    lastIndexedBlock: lastIndexedBlock?.toString() ?? null,
    chainHead: chainHead?.toString() ?? null,
    // Null whenever a lag figure would be a claim this response cannot support:
    // no index exists, or the cursor could not be read. Both cases used to report
    // `safeHead + 1` — the same number an empty cursor legitimately reports — so a
    // deployment with no index at all, and one whose database was unreachable,
    // each published a concrete "lag" that described neither. An empty cursor on
    // a live index still reports the real figure, because there the answer really
    // is "every safe block so far is unindexed".
    lagBlocks:
      chainHead === null || !cursorKnown
        ? null
        : lagBlocks({
            chainHead,
            lastIndexedBlock,
            confirmations: state.config.confirmations,
          }).toString(),
    // Rendered HERE, per request, rather than stored ready-made: the failure was
    // recorded once at process level, so the only place a reader's language is
    // known is this one.
    indexError: state.indexError === null ? null : renderFailure(state.indexError, locale),
  };
}

/**
 * One voter's status in one poll.
 *
 * The chain is authoritative for the whitelist decision, whether they currently
 * hold a vote, what they back and the stake. The index only adds what the chain
 * does not cheaply expose: the history of what they did (cast / changed /
 * withdrawn) and the refund transactions.
 *
 * A failure to read the chain is deliberately *not* caught. Substituting
 * `hasVoted: false` used to make a chain outage report that nobody had voted —
 * a confident false answer to the one question this endpoint exists for. The
 * route turns the throw into a 503, which is the honest reply.
 */
export async function getVoter(
  address: `0x${string}`,
  voter: `0x${string}`,
): Promise<VoterResponse> {
  const state = getServerState();
  await ready(state);

  const onChain = await readOnChainVoter(state.client, address, voter);

  const fromChain: VoterResponse = {
    address: voter,
    source: "chain",
    whitelisted: onChain.isWhitelisted,
    hasVoted: onChain.hasVoted,
    votedFor: onChain.votedFor === 0 ? null : onChain.votedFor,
    stakeWei: onChain.stakeWei.toString(),
    history: [],
    voteTxHash: null,
    refunds: [],
  };

  if (state.pool === null) {
    return fromChain;
  }

  const pool = state.pool;

  try {
    // The history is the whole point of the index here: the chain says what is
    // true NOW, and only the event stream says how it got there. A reader who
    // changed their vote three times has one current answer and four facts.
    //
    // `log_index` is selected because it is what groups a multi-select vote's
    // rows back into one action — see the fold below.
    const [voteRows] = await pool.query<
      (
        | {
            event_type: "cast" | "changed" | "withdrawn";
            option_id: number | null;
            tx_hash: string;
            block_number: string;
            log_index: number;
          }
        | undefined
      ) &
        import("mysql2/promise").RowDataPacket[]
    >(
      `SELECT event_type, option_id, tx_hash, block_number, log_index FROM votes
       WHERE poll_address = ? AND voter = ?
       ORDER BY block_number ASC, log_index ASC, option_id ASC`,
      [address, voter],
    );

    const [refundRows] = await pool.query<
      ({ amount_wei: string; tx_hash: string } & import("mysql2/promise").RowDataPacket)[]
    >(
      `SELECT amount_wei, tx_hash FROM refunds
       WHERE poll_address = ? AND voter = ?
       ORDER BY block_number ASC, log_index ASC`,
      [address, voter],
    );

    // The first cast is what the old wire format called "the vote transaction".
    // Kept because it is still the useful answer to "when did this address first
    // vote", and because dropping a field other code reads would be a silent
    // shape change.
    const firstCast = voteRows.find((row) => row !== undefined && row.event_type === "cast");

    // Build the history the reader sees.
    //
    // A multi-select vote is ONE on-chain log that the decoder expands into one
    // row per selected option, so the rows of a single action share both
    // `tx_hash` and `log_index`. Folding them back into one entry is what makes
    // the history say "changed to {2,3}" instead of listing two separate changes
    // — the latter would tell a reader their address voted twice in the same
    // block when it voted once for two things.
    //
    // Grouping on the LOG and not merely the transaction is the load-bearing
    // detail: a transaction can contain more than one vote action (a `vote`
    // followed by a `withdrawVote`), and merging on `tx_hash` alone would
    // collapse two real actions into one.
    const history: {
      kind: "cast" | "changed" | "withdrawn";
      optionId: number | null;
      optionIds: number[];
      blockNumber: string;
      txHash: string;
    }[] = [];

    for (const row of voteRows) {
      if (row === undefined) {
        continue;
      }

      const optionId = row.option_id === null ? null : Number(row.option_id);
      const previous = history[history.length - 1];

      const sameAction =
        previous !== undefined &&
        previous.txHash === row.tx_hash &&
        row.event_type !== "withdrawn" &&
        previous.kind !== "withdrawn";

      if (sameAction) {
        // `log_index` is not carried on the history entry, so the fold is
        // expressed as "adjacent rows of the same transaction and kind". The
        // query orders by (block, log_index, option_id), so rows of one log are
        // adjacent and rows of two different logs in one transaction are not.
        if (optionId !== null && !previous.optionIds.includes(optionId)) {
          previous.optionIds.push(optionId);
        }
        continue;
      }

      history.push({
        kind: row.event_type,
        optionId,
        optionIds: optionId === null ? [] : [optionId],
        blockNumber: row.block_number,
        txHash: row.tx_hash,
      });
    }

    recordIndexSuccess(state);

    return {
      address: voter,
      source: "index",
      // From the chain, not from `whitelist_events`. The mapping getter is the
      // current decision by construction, so a lagging index cannot make this
      // wrong — the same reasoning ADR-0009 applies to the ballot's buttons.
      whitelisted: onChain.isWhitelisted,
      hasVoted: onChain.hasVoted,
      votedFor: onChain.votedFor === 0 ? null : onChain.votedFor,
      stakeWei: onChain.stakeWei.toString(),
      history,
      voteTxHash: firstCast?.tx_hash ?? null,
      refunds: refundRows.map((row) => ({ amountWei: row.amount_wei, txHash: row.tx_hash })),
    };
  } catch (error) {
    // The index supplied only the history and the refund transactions. Losing
    // those is a loss of detail, not of the answer, so fall back to the
    // chain-only shape and say which source answered.
    recordIndexFailure(state, error);

    return fromChain;
  }
}

/**
 * The polls an address currently holds a vote in, answered by the index.
 *
 * ---------------------------------------------------------------------------
 * Why this read is allowed to be index-only
 * ---------------------------------------------------------------------------
 *
 * Every other read in this module falls back to the chain when the index is
 * unavailable (ADR-0011), because the chain can always answer. This one is the
 * single exception, and the reason is structural rather than a shortcut: the
 * chain has no reverse index from a voter to the polls they joined. The factory
 * records who *created* what, and a poll's `voterState(you)` answers for *that*
 * poll — so the only way to ask "which polls have I voted in" without the index
 * is to call every poll in existence, one round trip each. That is what
 * `MyVotes.tsx` does, which is why it needs a `SCAN_LIMIT` and has to tell the
 * reader when it truncated.
 *
 * The index already derives exactly this: `current_votes` is the set of
 * `(poll, voter)` pairs whose last event left them backing an option. Querying
 * it is one indexed lookup instead of N round trips, and the answer is complete
 * rather than capped.
 *
 * Returning `null` rather than falling back is therefore deliberate. The caller
 * decides what to do without an index, and the honest options are "scan the
 * chain and say you truncated" or "say you cannot answer" — never "silently
 * return a short list", which is the one outcome that would look like a complete
 * answer while being incomplete.
 *
 * A withdrawal is excluded by the view itself: `current_votes` maps a withdrawn
 * voter to `option_id NULL`, and this query filters those out. An address that
 * stepped out of a poll genuinely holds nothing in it, so listing it would claim
 * a vote the chain says is not there.
 */
export async function getVotedPolls(voter: `0x${string}`): Promise<VotedPollsResponse | null> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return null;
  }

  try {
    // `question` comes from `polls` via a LEFT JOIN rather than an INNER one: a
    // vote whose `PollCreated` has not been indexed yet is a real intermediate
    // state (the poll's own events and the factory's share a block, but a chunk
    // boundary can still split the batch), and dropping the row would hide a
    // vote that exists.
    const [rows] = await pool.query<
      ({
        address: string;
        option_id: number;
        question: string | null;
        block_number: string;
        tx_hash: string;
      } & import("mysql2/promise").RowDataPacket)[]
    >(
      `SELECT c.poll_address AS address,
              c.option_id     AS option_id,
              p.question      AS question,
              c.block_number  AS block_number,
              c.tx_hash       AS tx_hash
       FROM current_votes c
       LEFT JOIN polls p ON p.address = c.poll_address
       WHERE c.voter = ? AND c.option_id IS NOT NULL
       ORDER BY c.block_number DESC, c.log_index DESC`,
      [voter],
    );

    recordIndexSuccess(state);

    return {
      address: voter,
      source: "index",
      polls: rows.map((row) => ({
        address: row.address,
        optionId: Number(row.option_id),
        question: row.question,
        blockNumber: row.block_number,
        txHash: row.tx_hash,
      })),
    };
  } catch (error) {
    recordIndexFailure(state, error);

    return null;
  }
}

// ===========================================================================
// The poll-wide activity feed
// ===========================================================================

/**
 * Everything that ever happened to one poll, newest first.
 *
 * Returns `null` when there is no index, for the same reason `getVotedPolls`
 * does: this is the read the chain cannot serve. There is no contract function
 * that returns "the events of this poll" — a log query would need an archive
 * node and a range, and the result would be unbounded. So this is genuinely
 * index-only, and `null` means "not available here" rather than "nothing
 * happened". The UI says exactly that instead of rendering an empty timeline,
 * which would read as "nobody has done anything".
 *
 * The four sources are UNION ALL-ed rather than joined, because they are four
 * unrelated shapes that share only "this poll, and a block". A join would need a
 * common key they do not have.
 *
 * `option_id = 0` is the withdrawal sentinel (ids are 1-indexed on chain), and it
 * is mapped back to `null` here so the caller never has to know that convention —
 * a UI that rendered "option 0" would be showing a row that does not exist.
 */
export async function getPollActivity(
  address: `0x${string}`,
  locale: Locale = DEFAULT_LOCALE,
): Promise<ActivityEntry[] | null> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return null;
  }

  try {
    const [rows] = await pool.query<
      ({
        kind: ActivityEntry["kind"];
        actor: string | null;
        option_id: number | null;
        allowed: number | null;
        from_phase: number | null;
        to_phase: number | null;
        amount_wei: string | null;
        block_number: string;
        tx_hash: string;
      } & import("mysql2/promise").RowDataPacket)[]
    >(
      `SELECT 'cast' AS kind, voter AS actor, option_id, NULL AS allowed,
              NULL AS from_phase, NULL AS to_phase, NULL AS amount_wei,
              block_number, tx_hash
         FROM votes WHERE poll_address = ? AND event_type = 'cast'
        UNION ALL
       SELECT 'changed', voter, option_id, NULL, NULL, NULL, NULL, block_number, tx_hash
         FROM votes WHERE poll_address = ? AND event_type = 'changed'
        UNION ALL
       SELECT 'withdrawn', voter, NULL, NULL, NULL, NULL, NULL, block_number, tx_hash
         FROM votes WHERE poll_address = ? AND event_type = 'withdrawn'
        UNION ALL
       SELECT 'refunded', voter, NULL, NULL, NULL, NULL, amount_wei, block_number, tx_hash
         FROM refunds WHERE poll_address = ?
        UNION ALL
       SELECT 'whitelist', voter, NULL, allowed, NULL, NULL, NULL, block_number, tx_hash
         FROM whitelist_events WHERE poll_address = ?
        UNION ALL
       SELECT 'phase', NULL, NULL, NULL, from_phase, to_phase, NULL, block_number, tx_hash
         FROM phase_events WHERE poll_address = ?`,
      [address, address, address, address, address, address],
    );

    recordIndexSuccess(state);

    /*
      The `VoteCast` that `changeVote` emits beside `VoteChanged` is dropped here,
      by the same rule `getVoter` applies to a voter's own history. The two views
      read one event stream, so a reader comparing them must not find the feed
      claiming an extra action that never happened.
    */
    return orderActivity(
      withoutChangeEcho(
        rows.map((row) => ({
          kind: row.kind,
          blockNumber: row.block_number,
          txHash: row.tx_hash,
          actor: row.actor ?? undefined,
          optionId: row.option_id === null || row.option_id === 0 ? null : Number(row.option_id),
          detail: activityDetail(row, locale),
        })),
      ),
    );
  } catch (error) {
    recordIndexFailure(state, error);

    return null;
  }
}

/**
 * Every event the index has recorded, across every poll, newest first.
 *
 * ---------------------------------------------------------------------------
 * Why this is a second query rather than a loop over `getPollActivity`
 * ---------------------------------------------------------------------------
 *
 * `getPollActivity` takes one poll address. Looping it over the poll table to
 * build a global feed would issue one query per poll and then sort the union in
 * memory — the cost grows with the number of polls while the result stays the
 * same size. The union below is the same six tables with the poll filter made
 * OPTIONAL instead of required, so the database does the filtering and the
 * ordering it already has indexes for.
 *
 * ---------------------------------------------------------------------------
 * Why null rather than an empty list
 * ---------------------------------------------------------------------------
 *
 * `null` means "this deployment has no index", which is a different statement
 * from "nothing has happened". The route and the page both say so explicitly,
 * because rendering an empty audit table would tell a reader that no one has ever
 * done anything — a confident claim about data that was never read (ADR-0012).
 *
 * A query that fails after the index was reached also returns `null`, but records
 * the failure so `/api/health` reports it. The caller cannot tell those two apart
 * from the return value alone, and does not need to: both mean "the audit cannot
 * be shown", and the distinction belongs on the health endpoint where the
 * operator can act on it.
 *
 * Filters are applied in SQL, so a filtered request does not read the whole table.
 * The `LIKE`-free design is deliberate: every filter is an equality on an indexed
 * column or nothing at all.
 */
export async function getAuditActivity(
  filters: AuditFilters,
  locale: Locale = DEFAULT_LOCALE,
): Promise<AuditEntry[] | null> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return null;
  }

  // `?` placeholders for every value, so a filter can never become SQL. The
  // clause TEXT comes from `EVENT_BRANCHES` (the single owner of what an event is)
  // plus these two constants; nothing a caller sends is interpolated.
  const shared: { sql: string; value: string }[] = [];

  if (filters.poll !== null) {
    shared.push({ sql: "poll_address = ?", value: filters.poll });
  }

  if (filters.actor !== null) {
    shared.push({ sql: "voter = ?", value: filters.actor });
  }

  const branches: EventBranch[] = EVENT_BRANCHES.filter(
    (candidate) =>
      (filters.kind === null || filters.kind === candidate.kind) &&
      // A phase event names nobody, so it cannot match an address filter. The
      // BRANCH is dropped rather than the clause: dropping only the clause would
      // be a SQL error against a table with no `voter` column, and keeping both
      // would return phase rows for a filter that asked about one address.
      !(filters.actor !== null && !candidate.hasVoter),
  );

  // Nothing to ask for: either the kind filter matched no branch, or an actor
  // filter excluded the only branch. An empty UNION is a syntax error rather than
  // an empty result, so it is short-circuited here.
  if (branches.length === 0) {
    recordIndexSuccess(state);

    return [];
  }

  const clauses = shared.map((clause) => clause.sql);
  const statement = branches.map((b) => branchSql(b, clauses)).join(" UNION ALL ");

  // The shared values repeat once per branch, in the order the clauses were named.
  // `branchSql` cannot check this for us — it only sees the fragments.
  const values = branches.flatMap(() => shared.map((clause) => clause.value));

  try {
    const [rows] = await pool.query<
      ({
        kind: ActivityEntry["kind"];
        poll_address: string;
        actor: string | null;
        option_id: number | null;
        allowed: number | null;
        from_phase: number | null;
        to_phase: number | null;
        amount_wei: string | null;
        block_number: string;
        tx_hash: string;
      } & import("mysql2/promise").RowDataPacket)[]
    >(
      // Ordered in SQL as well as in memory: `orderActivity` is applied below, but
      // a LIMIT-free feed should not depend on the planner for its shape.
      `${statement} ${EVENT_ORDER_BY}`,
      values,
    );

    recordIndexSuccess(state);

    return orderActivity(
      withoutChangeEcho(
        rows.map((row) => ({
          kind: row.kind,
          pollAddress: row.poll_address,
          blockNumber: row.block_number,
          txHash: row.tx_hash,
          actor: row.actor ?? undefined,
          optionId: row.option_id === null || row.option_id === 0 ? null : Number(row.option_id),
          detail: activityDetail(row, locale),
        })),
      ),
    ) as AuditEntry[];
  } catch (error) {
    recordIndexFailure(state, error);

    return null;
  }
}

// ===========================================================================
// Subscriptions and the notifications derived from them
// ===========================================================================
//
// A subscription stores only a WATERMARK; a notification is derived from the
// event stream above that watermark. There is no notifications table, for the
// same reason `current_votes` is a view rather than a counter (ADR-0023): a
// stored copy of something the events already say is a second record that drifts.

/**
 * The height the index has actually processed.
 *
 * Read from `sync_cursor`, never from the chain. A watermark set to the chain head
 * would sit ABOVE events the index has not written yet, and those events would
 * then never notify anyone — a silent loss, and exactly the failure mode this
 * feature exists to avoid.
 *
 * Returns `null` when the index has never synced, which is distinguishable from
 * block 0 on purpose: `null` means "no watermark can be chosen yet".
 */
export async function indexedHead(): Promise<string | null> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return null;
  }

  try {
    const [rows] = await pool.query<
      ({ last_block: string } & import("mysql2/promise").RowDataPacket)[]
    >("SELECT last_block FROM sync_cursor WHERE id = 1");

    return rows[0]?.last_block ?? null;
  } catch (error) {
    recordIndexFailure(state, error);

    return null;
  }
}

/** Adds or refreshes a subscription. Returns false when there is no index. */
export async function subscribe(address: string, pollAddress: string): Promise<boolean> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return false;
  }

  // The watermark starts at the index's CURRENT head, so a new subscriber is not
  // handed the poll's entire history as unread. `?? 0` only applies on a
  // deployment whose cursor row is missing, where there is no history to flood
  // anyone with anyway.
  const head = (await indexedHead()) ?? "0";

  try {
    await pool.query(
      `INSERT INTO subscriptions (address, poll_address, last_read_block)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE address = VALUES(address)`,
      [address.toLowerCase(), pollAddress.toLowerCase(), head],
    );

    recordIndexSuccess(state);

    return true;
  } catch (error) {
    recordIndexFailure(state, error);

    return false;
  }
}

/** Removes a subscription. Returns false when there is no index. */
export async function unsubscribe(address: string, pollAddress: string): Promise<boolean> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return false;
  }

  try {
    await pool.query("DELETE FROM subscriptions WHERE address = ? AND poll_address = ?", [
      address.toLowerCase(),
      pollAddress.toLowerCase(),
    ]);

    recordIndexSuccess(state);

    return true;
  } catch (error) {
    recordIndexFailure(state, error);

    return false;
  }
}

/** Every poll one address is subscribed to. */
export async function listSubscriptions(address: string): Promise<Subscription[] | null> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return null;
  }

  try {
    const [rows] = await pool.query<
      ({
        poll_address: string;
        last_read_block: string;
        created_at: string | null;
      } & import("mysql2/promise").RowDataPacket)[]
    >(
      `SELECT poll_address, last_read_block, created_at
         FROM subscriptions WHERE address = ? ORDER BY poll_address`,
      [address.toLowerCase()],
    );

    recordIndexSuccess(state);

    return rows.map((row) => ({
      pollAddress: row.poll_address,
      lastReadBlock: row.last_read_block,
      createdAt: row.created_at ?? undefined,
    }));
  } catch (error) {
    recordIndexFailure(state, error);

    return null;
  }
}

/**
 * Everything that has happened in this address's subscribed polls since it was
 * last told, newest first.
 *
 * The join is what makes this one query rather than one per subscription: the
 * union of events is INNER JOINed to the reader's subscriptions on the poll, with
 * the watermark as a join condition. So the database discards the uninteresting
 * rows, and the cost tracks the reader's own event count rather than the number of
 * polls they follow.
 *
 * `JOIN subscriptions` also means an unsubscribed poll contributes nothing without
 * a second `WHERE`.
 */
export async function listNotifications(
  address: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<NotificationEntry[] | null> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return null;
  }

  const subscriber = address.toLowerCase();

  // The join conditions are the same for every branch, so they are built once and
  // passed to each — which is what keeps the placeholder order equal to the bound
  // values. `s.address = ?` is the only value, repeated per branch.
  const join = [
    "JOIN subscriptions s ON s.poll_address = e.poll_address AND s.address = ?",
    "WHERE e.block_number > s.last_read_block",
  ];

  /*
    Each branch is wrapped in its own derived table so it can be aliased as `e` and
    joined. Wrapping the UNION as a whole would work too, but MySQL would then
    materialise every event in the index before discarding almost all of them —
    the join would be applied after the fact rather than pushed into each branch.
  */
  const statement = EVENT_BRANCHES.map((branch) => {
    const inner = branchSql(branch);

    return `SELECT * FROM (${inner}) AS e ${join.join(" ")}`;
  }).join(" UNION ALL ");

  const values = EVENT_BRANCHES.map(() => subscriber);

  try {
    const [rows] = await pool.query<
      ({
        kind: NotificationEntry["kind"];
        poll_address: string;
        actor: string | null;
        option_id: number | null;
        allowed: number | null;
        from_phase: number | null;
        to_phase: number | null;
        amount_wei: string | null;
        block_number: string;
        tx_hash: string;
      } & import("mysql2/promise").RowDataPacket)[]
    >(`${statement} ${EVENT_ORDER_BY}`, values);

    recordIndexSuccess(state);

    return orderActivity(
      withoutChangeEcho(
        rows.map((row) => ({
          kind: row.kind,
          pollAddress: row.poll_address,
          blockNumber: row.block_number,
          txHash: row.tx_hash,
          actor: row.actor ?? undefined,
          optionId: row.option_id === null || row.option_id === 0 ? null : Number(row.option_id),
          detail: activityDetail(row, locale),
        })),
      ),
    ) as NotificationEntry[];
  } catch (error) {
    recordIndexFailure(state, error);

    return null;
  }
}

/**
 * Marks notifications read.
 *
 * Pass a poll address to mark only that poll, or `null` for every subscription.
 *
 * The new watermark is the HIGHEST BLOCK in `entries` (the ones actually shown),
 * never the current head — see `watermarkFor` for why taking the head would
 * silently swallow everything that arrived during the request.
 */
export async function markNotificationsRead(
  address: string,
  entries: readonly NotificationEntry[],
  pollAddress: string | null,
): Promise<boolean> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null) {
    return false;
  }

  const subscriber = address.toLowerCase();

  // Grouped per poll, because each subscription carries its own watermark and the
  // per-poll maximum is the only correct value for it.
  const byPoll = new Map<string, string>();

  for (const entry of entries) {
    const poll = entry.pollAddress.toLowerCase();

    byPoll.set(poll, watermarkFor([entry], byPoll.get(poll) ?? "0"));
  }

  if (pollAddress !== null) {
    const wanted = pollAddress.toLowerCase();
    const watermark = byPoll.get(wanted);

    if (watermark === undefined) {
      // Nothing was shown for this poll, so there is nothing to call read.
      // Advancing the watermark anyway would mark unseen events read.
      return true;
    }

    byPoll.clear();
    byPoll.set(wanted, watermark);
  }

  try {
    for (const [poll, watermark] of byPoll) {
      await pool.query(
        `UPDATE subscriptions SET last_read_block = ?
          WHERE address = ? AND poll_address = ? AND last_read_block < ?`,
        [watermark, subscriber, poll, watermark],
      );
    }

    recordIndexSuccess(state);

    return true;
  } catch (error) {
    recordIndexFailure(state, error);

    return false;
  }
}

/**
 * The extra column a row shows, per kind.
 *
 * Built here rather than in the component so the "0 means withdrawn" and
 * "which phase did it move to" rules live beside the query that produced them,
 * instead of being re-derived from raw columns in the view layer.
 *
 * ---------------------------------------------------------------------------
 * Why this takes a language
 * ---------------------------------------------------------------------------
 *
 * The `detail` it produces is rendered as TEXT by three readers — the poll
 * page's activity feed, the audit table's 详情 column and the notifications
 * list — so it is copy, even though it is built in a data module. It used to be
 * hardcoded Chinese, which meant an English page showed 加入白名单 in its own
 * detail column with no way for the component to translate it: the string
 * arrives already finished, as a plain `ActivityEntry` field.
 *
 * 阶段 comes from `poll.phase` and 退回 has no existing spelling, so the latter
 * is a key of its own. `ETH` and the two phase numbers are values and stay
 * verbatim — `formatWei` is doing arithmetic, not wording.
 */
function activityDetail(
  row: {
    kind: ActivityEntry["kind"];
    allowed: number | null;
    from_phase: number | null;
    to_phase: number | null;
    amount_wei: string | null;
  },
  locale: Locale,
): string | undefined {
  const t = translatorFor(locale);

  switch (row.kind) {
    case "whitelist":
      // These record an event that HAS happened, which is why they are not the
      // `admin.addToWhitelist` / `admin.removeFromWhitelist` button captions.
      // The two are byte-identical today and the shared Chinese is allowed to
      // stay that way — see the allowance table in `i18n.test.ts`.
      return row.allowed === 1 ? t.t("whitelist.added") : t.t("whitelist.removed");
    case "phase":
      /*
        "阶段 1 → 4": the LABEL is translated, the two NUMBERS are not.

        A phase number is what `PollPhase` is, and the contract stores it. A
        reader checking this row against a block explorer needs the same digits
        the explorer shows them, so the ordinal is passed through as data while
        the word in front of it follows the reader's language.
      */
      return `${t.t("activity.kind.phase")} ${row.from_phase} → ${row.to_phase}`;
    case "refunded":
      return row.amount_wei === null
        ? undefined
        : `${t.t("activity.refundedPrefix")} ${formatWei(row.amount_wei)} ETH`;
    default:
      return undefined;
  }
}

/** Wei, as a decimal string, shown as ETH without losing precision. */
function formatWei(wei: string): string {
  const padded = wei.padStart(19, "0");
  const whole = padded.slice(0, -18);
  const fraction = padded.slice(-18).replace(/0+$/, "");

  return fraction === "" ? whole : `${whole}.${fraction}`;
}

// ===========================================================================
// The indexer's own driver
// ===========================================================================
//
// Everything below drives the index rather than reading from it, and it is kept
// in this file on purpose rather than split into a module of its own.
//
// The separation is real but it is not a file boundary: `syncOnce` and
// `startSyncLoop` need the same lazily-built singleton — the pool, the chain
// client and the validated config — that every read above needs, and that
// singleton is cached on `globalThis` so Next.js hot reload cannot leak a pool
// per edit. A separate module would therefore have to import the accessor back
// from here, which is a cycle for no structural gain.
//
// What matters is that the boundary is visible and one-directional: the reads
// above never call into this section, and this section never decides where an
// answer comes from. The indexer's *policy* — chunking, confirmations, backoff,
// reorg rewinds — lives in `lib/indexer/`, which knows nothing about this file
// and is unit tested against fakes.
// ===========================================================================

/**
 * Runs one indexing pass.
 *
 * Exposed as an API route so the index can be advanced on demand (and by cron),
 * independently of the background loop. Returns `enabled: false` rather than
 * throwing when no database is configured, so a caller can treat "there is no
 * index" as a normal condition.
 */
export async function runSyncOnce(): Promise<SyncResponse> {
  const state = getServerState();
  await ready(state);

  if (state.pool === null) {
    return { enabled: false, reason: "DATABASE_URL is not set; the index is disabled." };
  }

  const outcome: SyncOutcome = await syncOnce({
    pool: state.pool,
    // The rotating reader, not `asChainReader(state.client)`: this path must
    // share the SAME failure counters as the background loop, or the on-demand
    // route would reset the evidence the loop accumulated and neither would ever
    // reach the threshold on an endpoint that fails intermittently.
    chain: state.indexerChain.reader,
    factoryAddress: state.config.factoryAddress,
    confirmations: state.config.confirmations,
    chunkBlocks: state.config.chunkBlocks,
    ...(state.config.startBlock !== undefined ? { startBlock: state.config.startBlock } : {}),
  });

  if (outcome.status === "synced") {
    return {
      enabled: true,
      status: "synced",
      fromBlock: outcome.fromBlock.toString(),
      toBlock: outcome.toBlock.toString(),
      seen: outcome.seen,
      inserted: outcome.inserted,
    };
  }

  if (outcome.status === "rewound") {
    return { enabled: true, status: "rewound", toBlock: outcome.rewoundTo.toString() };
  }

  return {
    enabled: true,
    status: "idle",
    lastIndexedBlock: outcome.lastIndexedBlock?.toString() ?? null,
  };
}

/**
 * Starts a background polling loop, once per process.
 *
 * Driven from `instrumentation.ts` so `next dev` and `next start` index
 * continuously without anyone remembering to run a second command. The on-demand
 * route above remains the reliable path, because a long-running loop is exactly
 * the kind of thing that quietly does not start in a serverless deployment.
 */
export async function ensureSyncLoop(): Promise<void> {
  const state = getServerState();
  await ready(state);

  const pool = state.pool;

  if (pool === null || !state.config.indexerEnabled || state.syncLoopStarted) {
    return;
  }

  state.syncLoopStarted = true;

  // The loop itself lives in the indexer as `startSyncLoop`, which is also what
  // the `drain` script drives. Reusing it keeps one owner of the backoff policy
  // so the two entry points cannot drift apart.
  const handle = startSyncLoop({
    pool,
    // Same rotating reader as `runSyncOnce`, so both paths share one set of
    // failure counters and one notion of which endpoint is current.
    chain: state.indexerChain.reader,
    factoryAddress: state.config.factoryAddress,
    confirmations: state.config.confirmations,
    chunkBlocks: state.config.chunkBlocks,
    pollIntervalMs: state.config.pollIntervalMs,
    logger: consoleLogger(),
    ...(state.config.startBlock !== undefined ? { startBlock: state.config.startBlock } : {}),
  });

  // Deliberately not awaited: the loop runs for the lifetime of the process.
  void handle.done;
}

/** Routes the loop's structured logging into the server console. */
function consoleLogger(): Logger {
  return {
    info: (obj, msg) => console.log(msg ?? "indexer", obj),
    warn: (obj, msg) => console.warn(msg ?? "indexer", obj),
    error: (obj, msg) => console.error(msg ?? "indexer", obj),
  };
}
