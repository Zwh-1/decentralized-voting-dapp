// SPDX-License-Identifier: MIT
import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";

import { factoryAbi, pollAbi } from "./contracts";
import type { ChainReader } from "./indexer/sync";
import type { TallyResponse } from "./types";

/**
 * Chain access for the server.
 *
 * The chain is described with `defineChain` rather than a bundled preset so the
 * same code works against a local Hardhat node (31337) and Sepolia (11155111)
 * with no branching.
 */
export function buildChainClient(
  chainId: number,
  rpcUrl: string | readonly string[],
): PublicClient {
  // A bare string is accepted so that every existing caller — and every test that
  // passes one endpoint — keeps working. The list form is what the config
  // produces, and the two must describe the same client or the fallback would
  // only apply to some call sites.
  const urls = typeof rpcUrl === "string" ? [rpcUrl] : [...rpcUrl];

  if (urls.length === 0) {
    throw new Error("buildChainClient needs at least one RPC endpoint");
  }

  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });

  // More than one endpoint means the reads must survive one of them being down,
  // and `fallback` is what provides that: it tries each transport in order and
  // moves on when one throws.
  //
  // `rank: false` — the default — ranks transports by latency and reorders them.
  // That is wrong here. The order is an operator's statement of preference (a paid
  // primary, a public backup), and silently promoting whichever node answered a
  // ping fastest would send production traffic to the free endpoint. It also makes
  // failures harder to reason about, since which node answered would change
  // between requests.
  //
  // `retryCount: 0` because `fallback` retries a failing transport on its own
  // schedule before moving to the next one; a retry here would multiply the wait
  // before the backup is reached, which is the exact delay the fallback exists to
  // avoid. A single endpoint keeps viem's own defaults, so nothing about the
  // one-endpoint behaviour changes.
  const transport =
    urls.length === 1
      ? http(urls[0])
      : fallback(
          urls.map((url) => http(url, { retryCount: 0 })),
          { rank: false },
        );

  // `cacheTime: 0` because this client's whole job is to answer "what does the
  // chain say right now", and viem otherwise caches `getBlockNumber` for 4000ms.
  // Measured on a default client: 406 before mining a block, still 406 after it,
  // 408 only once the 4s window expired; the same client with `cacheTime: 0`
  // reported 407 then 408. A stale height is not a harmless display wart here —
  // `checkConsistency` derives its unindexed range from it, so a vote mined inside
  // the window landed in neither side of the comparison and the check reported
  // `divergent` with HTTP 500 for as long as the cache lived. See ADR-0017.
  return createPublicClient({ chain, transport, cacheTime: 0 });
}

/** Adapts a viem client to the narrow interface the sync loop needs. */
export function asChainReader(client: PublicClient): ChainReader {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getLogs: (args) => client.getLogs(args),
  };
}

/**
 * Every poll the factory has ever created, read from the chain.
 *
 * The factory is the authority on which polls exist — not the index, and not a
 * list in a config file. A poll that the index has not caught up with still
 * exists, and a page that hid it would be wrong in the direction that matters
 * (a creator would think their poll had vanished).
 *
 * `allPolls()` returns the whole array. The demo's poll count is small; if this
 * ever grows, the fix is to page it here rather than to trust the index.
 */
export async function readOnChainPolls(
  client: PublicClient,
  factoryAddress: `0x${string}`,
): Promise<readonly `0x${string}`[]> {
  const addresses = (await client.readContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "allPolls",
  })) as readonly `0x${string}`[];

  return addresses;
}

/**
 * Reads the authoritative tally straight from one poll contract.
 *
 * This is what makes the consistency check meaningful: the same question is
 * asked of the chain and of MySQL, then the two answers are compared.
 */
export async function readOnChainTally(
  client: PublicClient,
  address: `0x${string}`,
  blockNumber?: bigint,
): Promise<TallyResponse> {
  const [list, total] = (await client.readContract({
    address,
    abi: pollAbi,
    functionName: "results",
    // Pinning matters for the consistency check: it also enumerates logs up to a
    // height, and a tally read at "latest" while the logs stop at an earlier
    // height would count a vote twice. A caller that pins both to one height
    // compares two descriptions of the same instant.
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })) as readonly [readonly { id: bigint; labelCID: string; voteCount: bigint }[], bigint];

  return {
    source: "chain",
    total: Number(total),
    options: list.map((option) => ({
      id: Number(option.id),
      labelCid: option.labelCID,
      voteCount: Number(option.voteCount),
    })),
  };
}

export interface OnChainVoter {
  /** True when the address currently backs at least one option. */
  hasVoted: boolean;
  /** The first option currently backed; 0 when none. */
  votedFor: number;
  /**
   * Every option currently backed, ascending; empty when none.
   *
   * The authoritative answer under multi-select. `votedFor` is its first
   * element, kept so a reader that only understands one option still gets a
   * truthful answer rather than having to know about mechanisms.
   */
  selections: number[];
  /**
   * How much this address's vote counted for.
   *
   * 1 under equal weight, the assigned weight under `weighted`. Exposed so the
   * UI can say "your vote counted for 5" instead of making a weighted voter
   * infer it from the mechanism flags and the tally.
   */
  power: number;
  stakeWei: bigint;
  /**
   * The current whitelist decision.
   *
   * Read from the chain even though the index also records whitelist events.
   * `Poll.isWhitelisted` is a public mapping getter — one cheap call that is by
   * construction at least as current as any projection, so an index that has
   * fallen behind can never make this answer wrong. ADR-0009 relies on the same
   * property for the ballot's buttons.
   */
  isWhitelisted: boolean;

  /**
   * Whether the contract would accept a first vote from this address.
   *
   * From `voterState`'s `canVote`, which is `openToAll || isWhitelisted`. Kept
   * as a separate field rather than folded into `isWhitelisted` because a poll
   * that admits everyone has no meaningful list, and a UI that reported "not
   * whitelisted" for such an address would name a gate that does not exist.
   */
  canVote: boolean;

  /**
   * The address this one handed its vote to, or the zero address.
   *
   * A delegating subject cannot vote for itself — the contract refuses with
   * `NotADelegate` — so the ballot has to know this to explain WHY it is closed
   * rather than offering a button that would revert.
   */
  delegatedTo: `0x${string}`;

  /** How many subjects handed their vote to this address. */
  delegatorCount: number;

  /**
   * Power this address controls: its own, plus every subject's that delegated
   * to it.
   *
   * The number to show BEFORE voting. `power` is zero until a ballot exists, so
   * a UI that displayed `power` to a delegate who has not voted yet would tell
   * it "your vote counts for 0" — false, and the exact kind of misreport
   * ADR-0011 exists to prevent.
   */
  controlledPower: number;

  /**
   * True when this address handed its vote away.
   *
   * Redundant with `delegatedTo !== zeroAddress` on purpose: the UI branches on
   * the question "may I vote?", not on an address comparison, and naming it
   * keeps that branch readable at every call site.
   */
  delegating: boolean;

  /**
   * True when a SEALED commitment is on file and has not been revealed.
   *
   * Not folded into `hasVoted`: a sealed ballot is not counted, so `hasVoted` is
   * false while this is true. Reporting that state as "did not vote" would tell a
   * participant it had not participated — the misreport ADR-0011 forbids.
   */
  committed: boolean;
}

/**
 * Reads one voter's on-chain state in a single round trip.
 *
 * `voterState` returns everything at once. Separate getters would let a caller
 * observe a half-updated view — for example "has voted" from one block and
 * "voted for 0" from the next — which is exactly the kind of torn read that
 * makes a UI offer the wrong button (ADR-0017's lesson, applied to a read
 * instead of a comparison).
 *
 * Read as a struct, not a tuple. The contract's `voterState` outgrew the EVM
 * stack as a tuple and now returns a named struct, which is also what makes
 * this read robust to a field being added: a positional destructure would
 * silently shift every later value.
 *
 * `canVote` is the contract's own admission decision, and `isWhitelisted` is the
 * raw list answer. Both are returned because the UI has to explain which one
 * applies: on an `openToAll` poll an address can be absent from the list and
 * still be allowed to vote, so reporting only the list would name the wrong
 * reason for a refusal.
 *
 * The delegation fields follow the same rule: `delegating` says the ballot is
 * closed to this address, `delegatedTo` says to whom, and `controlledPower` says
 * what a delegate's ballot would carry. All three come from the same read, so
 * the panel cannot show "you may vote" beside "you already delegated".
 */
export async function readOnChainVoter(
  client: PublicClient,
  address: `0x${string}`,
  voter: `0x${string}`,
): Promise<OnChainVoter> {
  const state = (await client.readContract({
    address,
    abi: pollAbi,
    functionName: "voterState",
    args: [voter],
  })) as {
    whitelisted: boolean;
    currentOptionId: bigint;
    stake: bigint;
    marked: boolean;
    canVote: boolean;
    selections: readonly bigint[];
    power: bigint;
    delegatedTo: `0x${string}`;
    delegatorCount: bigint;
    controlledPower: bigint;
    delegating: boolean;
    committed: boolean;
  };

  return {
    hasVoted: state.marked,
    votedFor: Number(state.currentOptionId),
    selections: state.selections.map(Number),
    power: Number(state.power),
    stakeWei: state.stake,
    isWhitelisted: state.whitelisted,
    canVote: state.canVote,
    delegatedTo: state.delegatedTo,
    delegatorCount: Number(state.delegatorCount),
    controlledPower: Number(state.controlledPower),
    delegating: state.delegating,
    committed: state.committed,
  };
}

/** The static facts about a poll that never change after it is created. */
export interface OnChainPoll {
  creator: `0x${string}`;
  question: string;
  endsAt: bigint;
  optionCount: number;
  phase: number;
  /** Sum of every option's `voteCount`, as the contract reports it. */
  total: number;
}

/** Reads one poll's headline facts, including its tally total. */
export async function readOnChainPoll(
  client: PublicClient,
  address: `0x${string}`,
): Promise<OnChainPoll> {
  const [creator, question, endsAt, optionCount, phase, results] = await Promise.all([
    client.readContract({ address, abi: pollAbi, functionName: "creator" }),
    client.readContract({ address, abi: pollAbi, functionName: "question" }),
    client.readContract({ address, abi: pollAbi, functionName: "endsAt" }),
    client.readContract({ address, abi: pollAbi, functionName: "optionCount" }),
    client.readContract({ address, abi: pollAbi, functionName: "phase" }),
    client.readContract({ address, abi: pollAbi, functionName: "results" }),
  ]);

  return {
    creator: creator as `0x${string}`,
    question: question as string,
    endsAt: endsAt as bigint,
    optionCount: Number(optionCount as bigint),
    phase: Number(phase as number),
    total: Number((results as readonly [unknown, bigint])[1]),
  };
}

/**
 * The poll's governance state: what it decided, and what is queued because of it.
 *
 * Read as ONE call site rather than four separate hooks, because the four values
 * are only meaningful together — a `readyAt` of zero means nothing without a
 * target, and an `outcome` of `Passed` is what makes the queue panel appear at
 * all. Reading them separately would let the UI render a queue for a poll that
 * has not passed.
 */
export interface OnChainGovernance {
  /** `PollOutcome`. 0 while the poll is still running. */
  outcome: number;
  /** The cached verdict, which is 0 until a transition settles the poll. */
  outcomeState: number;
  /** The frozen quorum denominator. 0 when there is no eligible set. */
  frozenEligiblePower: bigint;
  /** Share of eligible power that took part, in basis points. */
  turnoutBps: bigint;
  /** Quorum as a share of eligible power, in basis points. 0 means none. */
  quorumBps: bigint;
  /** Seconds between queueing an action and being able to run it. */
  timelockSeconds: bigint;
  queue: {
    /** `0x000…0` means nothing is queued. */
    target: `0x${string}`;
    value: bigint;
    data: `0x${string}`;
    readyAt: bigint;
    /** The last attempt's revert data, empty when it never failed. */
    lastError: `0x${string}`;
    done: boolean;
  };
}

/** Reads a poll's verdict, quorum figures and queued action in one round trip. */
export async function readOnChainGovernance(
  client: PublicClient,
  address: `0x${string}`,
): Promise<OnChainGovernance> {
  const [outcome, outcomeState, frozenEligiblePower, turnoutBps, config, execution] =
    await Promise.all([
      client.readContract({ address, abi: pollAbi, functionName: "outcome" }),
      client.readContract({ address, abi: pollAbi, functionName: "outcomeState" }),
      client.readContract({ address, abi: pollAbi, functionName: "frozenEligiblePower" }),
      client.readContract({ address, abi: pollAbi, functionName: "turnoutBps" }),
      client.readContract({ address, abi: pollAbi, functionName: "config" }),
      client.readContract({ address, abi: pollAbi, functionName: "execution" }),
    ]);

  // `config()` is the struct getter, so it comes back as a tuple rather than a
  // named object and the two governance fields have to be taken positionally.
  // Destructuring the whole thing would couple this reader to every field the
  // struct gains later; only the two that are read here are pulled out.
  const configTuple = config as readonly unknown[];

  const queue = execution as readonly [
    `0x${string}`,
    bigint,
    `0x${string}`,
    bigint,
    `0x${string}`,
    boolean,
  ];

  return {
    outcome: Number(outcome as number),
    outcomeState: Number(outcomeState as number),
    frozenEligiblePower: frozenEligiblePower as bigint,
    turnoutBps: turnoutBps as bigint,
    quorumBps: BigInt(configTuple[7] as bigint),
    timelockSeconds: BigInt(configTuple[8] as bigint),
    queue: {
      target: queue[0],
      value: queue[1],
      data: queue[2],
      readyAt: queue[3],
      lastError: queue[4],
      done: queue[5],
    },
  };
}

/** The addresses a passed vote may call, besides the poll itself. */
export async function readExecutionTargets(
  client: PublicClient,
  address: `0x${string}`,
): Promise<readonly `0x${string}`[]> {
  const targets = await client.readContract({
    address,
    abi: pollAbi,
    functionName: "executionTargets",
  });

  return targets as readonly `0x${string}`[];
}

/**
 * How many may vote, and how much voting power they hold.
 *
 * ---------------------------------------------------------------------------
 * Why two numbers rather than one
 * ---------------------------------------------------------------------------
 *
 * They answer different questions and are both needed:
 *
 *   * `eligibleVoters` is a COUNT of admitted addresses. It is what a reader
 *     means by "how many people could vote here", and it is the same figure under
 *     every mechanism.
 *   * `eligiblePower` is the frozen denominator the quorum and the turnout are
 *     measured against. On an equal-weight poll it equals the count; on a
 *     weighted poll it is the sum of weights, and the two differ in kind.
 *
 * Turnout MUST use `eligiblePower`. Dividing a weighted tally by an address
 * count would report a turnout above 100% on any poll where a weight exceeds one.
 *
 * ---------------------------------------------------------------------------
 * Why power is zero in two different situations
 * ---------------------------------------------------------------------------
 *
 * `frozenEligiblePower` is set at `startPoll`, so it is 0 while the poll is still
 * in `Setup`. And an open poll has no enumerable electorate, so it stays 0
 * forever — a quorum on an open poll is refused at creation for exactly this
 * reason. The caller cannot distinguish those two from the number alone, which is
 * why it is returned as null-when-unusable rather than as a bare 0: "no one is
 * eligible" and "this cannot be computed yet" are different statements (ADR-0011).
 */
export interface OnChainEligibility {
  /** Admitted addresses right now. `null` when the read failed. */
  eligibleVoters: number | null;
  /** The frozen turnout/quorum denominator, or `null` when there is not one. */
  eligiblePower: bigint | null;
}

/** Reads a poll's electorate, live count and frozen denominator together. */
export async function readOnChainEligibility(
  client: PublicClient,
  address: `0x${string}`,
): Promise<OnChainEligibility> {
  const [count, power] = await Promise.all([
    client.readContract({ address, abi: pollAbi, functionName: "whitelistedCount" }),
    client.readContract({ address, abi: pollAbi, functionName: "frozenEligiblePower" }),
  ]);

  const frozen = power as bigint;

  return {
    eligibleVoters: Number(count as bigint),
    // Zero means "not started, or no enumerable electorate" — a denominator that
    // would divide by zero, not a denominator of zero. Reported as absent.
    eligiblePower: frozen === 0n ? null : frozen,
  };
}
