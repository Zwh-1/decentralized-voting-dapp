// SPDX-License-Identifier: MIT
import { parseEventLogs } from "viem";

import { factoryAbi, pollAbi } from "../contracts";

/**
 * Turns raw chain logs into rows for the projection tables.
 *
 * Two contracts are indexed now: `VotingFactory`, which emits `PollCreated` once
 * per poll, and each `Poll` clone, which emits everything else. They are decoded
 * against their own ABI — a log is matched by topic0, so a `Poll` log cannot be
 * mistaken for a factory log even though both are handed to this function in one
 * batch. `strict: false` keeps a log from neither ABI from failing the batch.
 *
 * `pollAddress` is not read out of the arguments: every per-poll row is keyed by
 * the address that EMITTED the log. That is what makes two polls that share an
 * ABI, an event signature and even a voter address stay separate rows.
 */

export interface LogRowBase {
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

/** One row of `polls`, from VotingFactory's `PollCreated`. */
export interface PollRow extends LogRowBase {
  address: string;
  creator: string;
  question: string;
  endsAt: string;
  optionCount: number;
}

/** One row of `options`, from `OptionAdded` / `OptionUpdated` / `OptionRemoved`. */
export interface OptionRow extends LogRowBase {
  pollAddress: string;
  optionId: number;
  labelCid: string;
}

/**
 * One row of the `votes` event stream.
 *
 * `optionId` is 0 for a withdrawal, which carries an amount rather than an
 * option. On chain option ids are 1-indexed (0 means "no vote"), so 0 is a
 * sentinel that cannot collide with a real option.
 */
export interface VoteRow extends LogRowBase {
  pollAddress: string;
  voter: string;
  optionId: number;
  eventType: VoteEventType;
}

/**
 * The three things an address can do to a vote. Deliberately an event type and
 * not a state: `VoteChanged` exists as its own event precisely so the index can
 * take "the last thing this address did" and get the right answer, and it is
 * stored as its own row so that derivation stays a view over the stream.
 */
export type VoteEventType = "cast" | "changed" | "withdrawn";

export interface RefundRow extends LogRowBase {
  pollAddress: string;
  voter: string;
  amountWei: string;
}

export interface WhitelistRow extends LogRowBase {
  pollAddress: string;
  voter: string;
  allowed: boolean;
}

export interface PhaseRow extends LogRowBase {
  pollAddress: string;
  fromPhase: number;
  toPhase: number;
}

export interface DecodedEvents {
  polls: PollRow[];
  options: OptionRow[];
  votes: VoteRow[];
  refunds: RefundRow[];
  whitelist: WhitelistRow[];
  phases: PhaseRow[];
}

/** Every bucket of a `DecodedEvents`, used for `seen` totals and for tests. */
export const EVENT_BUCKETS = [
  "polls",
  "options",
  "votes",
  "refunds",
  "whitelist",
  "phases",
] as const satisfies readonly (keyof DecodedEvents)[];

/** The subset of a `getLogs` result this module needs. */
interface MinimalLog {
  address?: string;
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
}

/** Row coordinates shared by every table. */
interface RowBase extends LogRowBase {
  pollAddress: string;
}

function requireBase(log: MinimalLog): RowBase {
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error("Encountered a pending log; the indexer must only fetch finalised blocks");
  }

  if (typeof log.address !== "string" || log.address.length === 0) {
    throw new Error("Encountered a log with no emitting address; poll events cannot be keyed");
  }

  return {
    pollAddress: log.address.toLowerCase(),
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

/**
 * Decodes every log either contract emits.
 *
 * Unrecognised logs are ignored rather than fatal: `parseEventLogs` with
 * `strict: false` keeps one stray log from halting the whole indexer.
 */
export function decodeLogs(logs: readonly MinimalLog[]): DecodedEvents {
  const result: DecodedEvents = {
    polls: [],
    options: [],
    votes: [],
    refunds: [],
    whitelist: [],
    phases: [],
  };

  // The factory's ABI first, then the polls'. The two cannot collide: each ABI
  // only ever decodes its own topic0 hashes, and `parseEventLogs` with
  // `strict: false` returns only what it recognised.
  const decoded = [
    ...parseEventLogs({ abi: factoryAbi, logs: logs as never, strict: false }),
    ...parseEventLogs({ abi: pollAbi, logs: logs as never, strict: false }),
  ];

  for (const event of decoded) {
    const log = event as unknown as MinimalLog;

    // A log that decodes against neither ABI is not an error, but it is not a
    // row either. `parseEventLogs` only returns recognised logs, so reaching
    // here without coordinates would mean a malformed batch, not a stray event.
    if (log.address === undefined) {
      continue;
    }

    const base = requireBase(log);

    switch (event.eventName) {
      case "PollCreated": {
        const args = event.args as {
          poll: string;
          creator: string;
          question: string;
          endsAt: bigint;
          optionCount: bigint;
        };
        result.polls.push({
          ...base,
          address: args.poll.toLowerCase(),
          creator: args.creator.toLowerCase(),
          question: args.question,
          endsAt: args.endsAt.toString(),
          optionCount: Number(args.optionCount),
        });
        break;
      }
      case "OptionAdded":
      case "OptionUpdated": {
        const args = event.args as { id: bigint; labelCID: string };
        result.options.push({
          ...base,
          optionId: Number(args.id),
          labelCid: args.labelCID,
        });
        break;
      }
      case "OptionRemoved": {
        // Recorded as a tombstone row (empty label), NOT as a delete.
        //
        // `removeOption` compacts the on-chain array: removing option 2 of 4
        // shifts 3->2 and 4->3 and decrements `optionCount`, so the ids in every
        // LATER event refer to different labels than the same ids did before.
        // Replaying that in the projection would mean predicting, for each
        // OptionRemoved, the exact shifted id of every subsequent event — and
        // getting it wrong repoints votes at the wrong option.
        //
        // It is safe not to replay it because the contract makes it safe:
        // `removeOption` reverts unless `phase == Setup`, and voting is
        // unreachable in Setup. So a renumbering can only happen before any
        // vote exists; no vote row can ever be repointed by it. What the
        // projection loses is the option's LABEL row when the removed id is
        // still referenced by a later OptionAdded/Updated — in that case the
        // later event overwrites this row with the shifted label, which is the
        // correct final state. What remains wrong is a poll whose option list
        // shrank: the stale trailing id keeps a row that `optionCount` no
        // longer covers.
        //
        // The honest statement of the tradeoff: the projection records that a
        // removal happened and does not replay the renumbering. A poll edited
        // after options were added may therefore show a stale label or a stale
        // trailing option until it is rebuilt from the `Poll.optionCID()` view
        // functions. Fixing it properly means keying options on the label CID
        // rather than the id, which would break `option_id` as the join key
        // between `votes` (whose ids ARE the chain's ids) and `options`.
        const args = event.args as { id: bigint };
        result.options.push({
          ...base,
          optionId: Number(args.id),
          labelCid: "",
        });
        break;
      }
      case "VoteCast": {
        const args = event.args as { voter: string; optionId: bigint };
        result.votes.push({
          ...base,
          voter: args.voter.toLowerCase(),
          optionId: Number(args.optionId),
          eventType: "cast",
        });
        break;
      }
      case "VoteChanged": {
        const args = event.args as { voter: string; toOptionId: bigint };
        result.votes.push({
          ...base,
          voter: args.voter.toLowerCase(),
          optionId: Number(args.toOptionId),
          eventType: "changed",
        });
        break;
      }
      case "VoteWithdrawn": {
        const args = event.args as { voter: string };
        result.votes.push({
          ...base,
          voter: args.voter.toLowerCase(),
          optionId: 0,
          eventType: "withdrawn",
        });
        break;
      }
      case "Refunded": {
        const args = event.args as { voter: string; amount: bigint };
        result.refunds.push({
          ...base,
          voter: args.voter.toLowerCase(),
          amountWei: args.amount.toString(),
        });
        break;
      }
      case "WhitelistUpdated": {
        const args = event.args as { voter: string; allowed: boolean };
        result.whitelist.push({
          ...base,
          voter: args.voter.toLowerCase(),
          allowed: args.allowed,
        });
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
        // `OwnershipTransferred` and any other recognised-but-unindexed event.
        // Nothing in the read model depends on it.
        break;
    }
  }

  return result;
}

/** Total rows across every bucket. This is what `seen` counts. */
export function countEvents(events: DecodedEvents): number {
  return EVENT_BUCKETS.reduce((sum, bucket) => sum + events[bucket].length, 0);
}

/**
 * The poll addresses a decoded batch discovered.
 *
 * Used by the sync loop to extend its log query to polls created inside the very
 * range it is scanning — see `syncOnce`, where missing this would silently drop
 * that poll's first events.
 */
export function newPollAddresses(events: DecodedEvents): string[] {
  return events.polls.map((poll) => poll.address);
}
