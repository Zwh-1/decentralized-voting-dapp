// SPDX-License-Identifier: MIT
import { createPublicClient, defineChain, http, type PublicClient } from "viem";

import { votingAbi } from "./contracts";
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

  return createPublicClient({ chain, transport: http(rpcUrl) });
}

/** Adapts a viem client to the narrow interface the sync loop needs. */
export function asChainReader(client: PublicClient): ChainReader {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getLogs: (args) => client.getLogs(args),
  };
}

/**
 * Reads the authoritative tally straight from the contract.
 *
 * This is what makes the consistency check meaningful: the same question is
 * asked of the chain and of MySQL, then the two answers are compared.
 */
export async function readOnChainTally(
  client: PublicClient,
  address: `0x${string}`,
): Promise<TallyResponse> {
  const [list, total] = (await client.readContract({
    address,
    abi: votingAbi,
    functionName: "results",
  })) as readonly [readonly { id: bigint; metadataCID: string; voteCount: bigint }[], bigint];

  return {
    source: "chain",
    total: Number(total),
    candidates: list.map((candidate) => ({
      id: Number(candidate.id),
      metadataCid: candidate.metadataCID,
      voteCount: Number(candidate.voteCount),
    })),
  };
}

export interface OnChainVoter {
  hasVoted: boolean;
  votedFor: number;
  stakeWei: bigint;
}

/**
 * Reads one voter's on-chain state.
 *
 * Three independent reads issued in parallel rather than a multicall: Hardhat's
 * local network does not always have Multicall3 deployed, and three round trips
 * against a local node or a good RPC is not worth a deployment dependency.
 */
export async function readOnChainVoter(
  client: PublicClient,
  address: `0x${string}`,
  voter: `0x${string}`,
): Promise<OnChainVoter> {
  const [hasVoted, votedFor, stakeWei] = await Promise.all([
    client.readContract({ address, abi: votingAbi, functionName: "hasVoted", args: [voter] }),
    client.readContract({ address, abi: votingAbi, functionName: "votedFor", args: [voter] }),
    client.readContract({ address, abi: votingAbi, functionName: "stakeOf", args: [voter] }),
  ]);

  return {
    hasVoted: hasVoted as boolean,
    votedFor: Number(votedFor as bigint),
    stakeWei: stakeWei as bigint,
  };
}

/** Reads the current ballot phase. */
export async function readOnChainPhase(
  client: PublicClient,
  address: `0x${string}`,
): Promise<number> {
  const phase = await client.readContract({ address, abi: votingAbi, functionName: "phase" });

  return Number(phase);
}
