// SPDX-License-Identifier: MIT
import { createPublicClient, defineChain, http, type PublicClient } from "viem";

import { votingAbi } from "@voting/shared";

import type { OnChainResults } from "./api/server.js";
import type { ChainReader } from "./indexer/sync.js";

/**
 * Chain access for the indexer and the API.
 *
 * The chain is described with `defineChain` rather than a bundled preset so the
 * same code works against a local Hardhat node (31337) and Sepolia (11155111)
 * without branching.
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
 * This is the other half of the consistency check in `/api/results`: the same
 * question asked of the chain and of MySQL, then compared.
 */
export function makeOnChainResultsReader(
  client: PublicClient,
  address: `0x${string}`,
): () => Promise<OnChainResults> {
  return async () => {
    const [list, total] = (await client.readContract({
      address,
      abi: votingAbi,
      functionName: "results",
    })) as readonly [readonly { id: bigint; metadataCID: string; voteCount: bigint }[], bigint];

    return {
      candidates: list.map((candidate) => ({
        id: Number(candidate.id),
        metadataCid: candidate.metadataCID,
        voteCount: Number(candidate.voteCount),
      })),
      total: Number(total),
    };
  };
}
