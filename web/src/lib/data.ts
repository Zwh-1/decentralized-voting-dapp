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
  readOnChainPoll,
  readOnChainPolls,
  readOnChainTally,
  readOnChainVoter,
  type OnChainVoter,
} from "./chain";
import { isIndexEnabled, loadServerConfig, type ServerConfig } from "./config";
import { migrate } from "./db/migrate";
import { createPool } from "./db/pool";
import { describeFailure } from "./failure";
import { lagBlocks } from "./indexer/plan";
import { readCursor, startSyncLoop, syncOnce, type Logger, type SyncOutcome } from "./indexer/sync";
import { checkConsistency, readIndexedTally } from "./report";
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
  pool: Pool | null;
  ready: Promise<void>;
  syncLoopStarted: boolean;
  /**
   * The most recent reason the index could not be read, or null.
   *
   * Cleared by any successful index read, so a recovered database stops being
   * reported without a restart. Reported through `/api/health`.
   */
  indexError: string | null;
}

/** A plain key rather than a symbol: symbols are not valid interface keys. */
interface GlobalWithState {
  __votingServerState?: ServerState;
}

function initialise(): ServerState {
  const config = loadServerConfig();
  const client = buildChainClient(config.chainId, config.rpcUrl);

  const state: ServerState = {
    config,
    client,
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
  const described = describeFailure(error);

  if (state.indexError !== described) {
    console.error("[index] read failed", error);
  }

  state.indexError = described;
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
 */
export async function getPolls(): Promise<PollSummary[]> {
  const state = getServerState();

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

export async function getHealth(): Promise<HealthResponse> {
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
    indexError: state.indexError,
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
    const [voteRows] = await pool.query<
      (
        | {
            event_type: "cast" | "changed" | "withdrawn";
            option_id: number | null;
            tx_hash: string;
            block_number: string;
          }
        | undefined
      ) &
        import("mysql2/promise").RowDataPacket[]
    >(
      `SELECT event_type, option_id, tx_hash, block_number FROM votes
       WHERE poll_address = ? AND voter = ?
       ORDER BY block_number ASC, log_index ASC`,
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
    // `changeVote` emits BOTH `VoteChanged` and `VoteCast` in one transaction:
    // the change is the action and the cast re-states the new count so a
    // tally-only consumer still sees it. Listing both would show a reader
    // "cast for option 2" immediately after "changed to option 2" — two entries
    // for one click, and the second one reading as though the address had voted
    // twice when it holds exactly one vote. The `VoteCast` is therefore dropped
    // when it shares a transaction with a `VoteChanged`, which is exactly the
    // echo ADR-0024 describes. A standalone cast is untouched: `vote` emits only
    // `VoteCast`, so a first vote still appears.
    const changedTxHashes = new Set(
      voteRows
        .filter((row) => row !== undefined && row.event_type === "changed")
        .map((row) => row!.tx_hash),
    );
    const history = voteRows
      .filter((row) => row !== undefined)
      .filter((row) => !(row.event_type === "cast" && changedTxHashes.has(row.tx_hash)))
      .map((row) => ({
        kind: row.event_type,
        optionId: row.option_id === null ? null : Number(row.option_id),
        blockNumber: row.block_number,
        txHash: row.tx_hash,
      }));

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
    chain: asChainReader(state.client),
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
    chain: asChainReader(state.client),
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
