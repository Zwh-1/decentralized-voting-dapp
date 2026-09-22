// SPDX-License-Identifier: MIT
import { createPublicClient, defineChain, http, type PublicClient } from "viem";

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
export function buildChainClient(chainId: number, rpcUrl: string): PublicClient {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  // `cacheTime: 0` because this client's whole job is to answer "what does the
  // chain say right now", and viem otherwise caches `getBlockNumber` for 4000ms.
  // Measured on a default client: 406 before mining a block, still 406 after it,
  // 408 only once the 4s window expired; the same client with `cacheTime: 0`
  // reported 407 then 408. A stale height is not a harmless display wart here —
  // `checkConsistency` derives its unindexed range from it, so a vote mined inside
  // the window landed in neither side of the comparison and the check reported
  // `divergent` with HTTP 500 for as long as the cache lived. See ADR-0017.
  return createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
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
  /** True when the address currently backs an option. */
  hasVoted: boolean;
  /** The option currently backed; 0 when none. */
  votedFor: number;
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
}

/**
 * Reads one voter's on-chain state in a single round trip.
 *
 * `voterState` returns all five values at once. Separate getters would let a
 * caller observe a half-updated view — for example "has voted" from one block
 * and "voted for 0" from the next — which is exactly the kind of torn read that
 * makes a UI offer the wrong button (ADR-0017's lesson, applied to a read
 * instead of a comparison).
 *
 * `canVote` is the contract's own admission decision, and `isWhitelisted` is the
 * raw list answer. Both are returned because the UI has to explain which one
 * applies: on an `openToAll` poll an address can be absent from the list and
 * still be allowed to vote, so reporting only the list would name the wrong
 * reason for a refusal.
 */
export async function readOnChainVoter(
  client: PublicClient,
  address: `0x${string}`,
  voter: `0x${string}`,
): Promise<OnChainVoter> {
  const [whitelisted, currentOptionId, stakeWei, , canVote] = (await client.readContract({
    address,
    abi: pollAbi,
    functionName: "voterState",
    args: [voter],
  })) as readonly [boolean, bigint, bigint, boolean, boolean];

  return {
    hasVoted: currentOptionId !== 0n,
    votedFor: Number(currentOptionId),
    stakeWei,
    isWhitelisted: whitelisted,
    canVote,
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
