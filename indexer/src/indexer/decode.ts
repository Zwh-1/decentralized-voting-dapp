// SPDX-License-Identifier: MIT
import { parseEventLogs } from "viem";

import { votingAbi } from "@voting/shared";

/**
 * Turns raw chain logs into rows for the projection tables.
 *
 * Decoding uses the generated ABI from `@voting/shared`, so a contract change
 * that is not reflected in the ABI surfaces here as a decode failure rather
 * than as silently missing data.
 */

export interface LogRowBase {
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export interface CandidateRow extends LogRowBase {
  id: number;
  metadataCid: string;
}

export interface VoteRow extends LogRowBase {
  voter: string;
  candidateId: number;
}

export interface RefundRow extends LogRowBase {
  voter: string;
  amountWei: string;
}

export interface WhitelistRow extends LogRowBase {
  voter: string;
  allowed: boolean;
}

export interface PhaseRow extends LogRowBase {
  fromPhase: number;
  toPhase: number;
}

export interface DecodedEvents {
  candidates: CandidateRow[];
  votes: VoteRow[];
  refunds: RefundRow[];
  whitelist: WhitelistRow[];
  phases: PhaseRow[];
}

/** The subset of a `getLogs` result this module needs. */
interface MinimalLog {
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
}

function requireBase(log: MinimalLog): LogRowBase {
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error("Encountered a pending log; the indexer must only fetch finalised blocks");
  }

  return {
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

/**
 * Decodes every log the Voting contract emits.
 *
 * Unrecognised logs are ignored rather than fatal: an address can emit events
 * from a different contract only if it was misconfigured, and `parseEventLogs`
 * with `strict: false` keeps one stray log from halting the whole indexer.
 */
export function decodeLogs(logs: readonly MinimalLog[]): DecodedEvents {
  const decoded = parseEventLogs({
    abi: votingAbi,
    logs: logs as Parameters<typeof parseEventLogs>[0]["logs"],
    strict: false,
  });

  const result: DecodedEvents = {
    candidates: [],
    votes: [],
    refunds: [],
    whitelist: [],
    phases: [],
  };

  for (const event of decoded) {
    const base = requireBase(event as unknown as MinimalLog);

    switch (event.eventName) {
      case "CandidateAdded": {
        const args = event.args as { id: bigint; metadataCID: string };
        result.candidates.push({ ...base, id: Number(args.id), metadataCid: args.metadataCID });
        break;
      }
      case "VoteCast": {
        const args = event.args as { voter: string; candidateId: bigint };
        result.votes.push({
          ...base,
          voter: args.voter,
          candidateId: Number(args.candidateId),
        });
        break;
      }
      case "Refunded": {
        const args = event.args as { voter: string; amount: bigint };
        result.refunds.push({ ...base, voter: args.voter, amountWei: args.amount.toString() });
        break;
      }
      case "WhitelistUpdated": {
        const args = event.args as { voter: string; allowed: boolean };
        result.whitelist.push({ ...base, voter: args.voter, allowed: args.allowed });
        break;
      }
      case "PhaseChanged": {
        const args = event.args as { from: number; to: number };
        result.phases.push({
          ...base,
          fromPhase: Number(args.from),
          toPhase: Number(args.to),
        });
        break;
      }
      default:
        break;
    }
  }

  return result;
}
