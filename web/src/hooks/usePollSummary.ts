"use client";

import { useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { createPublicClient, http, isAddress } from "viem";

import { pollAbi } from "@/lib/voting";
import type { PollSummary } from "@/lib/types";

/**
 * One poll's summary, read straight from the chain.
 *
 * The list page asks the factory `allPolls()` for **which** polls exist and this
 * for what each one says. The split is deliberate: the list then depends on
 * nothing but a chain read — no MySQL, no index, no API route — which is what
 * makes the page render when the index is absent or down.
 *
 * `results()` is read for the total instead of summing the options: it is the
 * contract's own answer to "how many votes are there", and computing it a second
 * way here would create a second owner of the number (ADR-0001).
 *
 * `chainId` is required rather than inferred from the wallet. A public client
 * built without one reads through the first chain in the client config — the
 * local Hardhat node — while the page is describing Sepolia, which is ADR-0019's
 * defect in a new place. The caller has already resolved the target, so the chain
 * is passed in and the read cannot disagree with the page it is rendered on.
 */
export function usePollSummary(input: {
  chainId: number | undefined;
  address: `0x${string}`;
  enabled: boolean;
}) {
  const config = useConfig();
  const { chainId, address, enabled } = input;

  return useQuery<PollSummary>({
    queryKey: ["poll-summary", chainId, address],
    enabled: enabled && isAddress(address) && chainId !== undefined,
    refetchInterval: 10_000,
    queryFn: async () => {
      const chain = config.chains.find((candidate) => candidate.id === chainId);

      if (chain === undefined || chainId === undefined) {
        throw new Error("the resolved chain is not registered in the wagmi config");
      }

      const client = createPublicClient({ chain, transport: http() });
      const [creator, question, endsAt, optionCount, phase, results] = await Promise.all([
        client.readContract({ address, abi: pollAbi, functionName: "creator" }),
        client.readContract({ address, abi: pollAbi, functionName: "question" }),
        client.readContract({ address, abi: pollAbi, functionName: "endsAt" }),
        client.readContract({ address, abi: pollAbi, functionName: "optionCount" }),
        client.readContract({ address, abi: pollAbi, functionName: "phase" }),
        client.readContract({ address, abi: pollAbi, functionName: "results" }),
      ]);

      return {
        address,
        creator,
        question,
        endsAt: endsAt.toString(),
        optionCount: Number(optionCount),
        phase: Number(phase),
        totalVotes: Number(results[1]),
      };
    },
  });
}
