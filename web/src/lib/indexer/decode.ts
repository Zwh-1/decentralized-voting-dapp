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
 *
 * A RECORDED VOTE PRODUCES ONE ROW PER SELECTED OPTION, all sharing the same
 * `logIndex`. That is a deliberate expansion rather than one row holding an
 * array: every existing consumer joins votes to options on `option_id`, and
 * keeping the column a scalar keeps that join a plain equality under
 * multi-select. The rows of one event are still identifiable as a unit —
 * (txHash, logIndex) is unchanged across them — so a reader that needs "what
 * did this address vote for" can take the latest group rather than the latest
 * row.
 *
 * `power` is how much the selection counted for: 1 under equal weight, the
 * assigned weight under `weighted`. It is recorded per row rather than being
 * looked up from the poll's current configuration, because a projection that
 * re-derived it would report the mechanism as it is NOW for a vote cast under
 * an earlier one.
 */
export interface VoteRow extends LogRowBase {
  pollAddress: string;
  voter: string;
  optionId: number;
  eventType: VoteEventType;
  power: string;
}

/**
 * The things an address can do to its vote, including the two events that
 * record a ballot WITHOUT counting it.
 *
 * `cast` and `changed` are both produced by the contract's single
 * `VoteRecorded` event; which one a row is depends on whether the address had
 * already voted, which only the stream's order reveals. That is why this stays
 * an event type and not a state: the index takes "the last recorded set this
 * address submitted" and gets the right answer either way, and storing the
 * distinction as its own row keeps that derivation a view over the stream.
 *
 * `committed` and `expired` are a commit-reveal poll's two states that are NOT
 * a vote. Keeping them in this stream rather than in a separate table is what
 * makes "committed, awaiting reveal" expressible at all: the projection has to
 * answer "did this address participate?" and an empty result cannot distinguish
 * "no" from "yes, but sealed". A separate table would let the two drift, and the
 * drift would show up as a UI telling a committed voter it had not voted —
 * ADR-0011's misreport, arriving through the privacy feature.
 *
 * Neither carries a `power` or a real `optionId`: there is no plaintext yet.
 * `optionId` is 0 for both, which is the same sentinel `withdrawn` uses, and
 * the READ side must never treat a 0-option row as a selection.
 */
export type VoteEventType = "cast" | "changed" | "withdrawn" | "committed" | "expired";

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
      case "VoteRecorded": {
        // One event carries the whole selected set, so it expands to one row
        // per option. All rows share the log's coordinates, which is what lets
        // a reader reassemble the set: `optionId` alone cannot say whether
        // {1,2} was one multi-select vote or two separate single ones.
        const args = event.args as { voter: string; optionIds: readonly bigint[]; power: bigint };
        const voter = args.voter.toLowerCase();
        const power = args.power.toString();

        for (const optionId of args.optionIds) {
          result.votes.push({
            ...base,
            voter,
            optionId: Number(optionId),
            // Whether this is a first vote or a change is not in the event —
            // the contract emits one shape for both. The projection resolves it
            // at read time by looking at whether the address already had rows;
            // labelling every row `cast` here would make a change look like an
            // extra vote to any reader that trusted the label.
            eventType: "cast",
            power,
          });
        }
        break;
      }
      case "Committed": {
        // The commitment hash itself is deliberately NOT persisted. It is the
        // voter's own secret to keep, and a projection that stored it would
        // make the index a second place the private ballot could be attacked
        // from — while also being useless, since nothing here can open it.
        // What the projection needs is only the FACT of participation, which is
        // what `eventType: "committed"` records.
        const args = event.args as { voter: string };
        result.votes.push({
          ...base,
          voter: args.voter.toLowerCase(),
          optionId: 0,
          eventType: "committed",
          power: "0",
        });
        break;
      }
      case "Revealed": {
        // A reveal DOES count, and it arrives as its own event rather than as a
        // `VoteRecorded`. The contract emits both, and recording the plaintext
        // once — from `VoteRecorded`, which carries the running totals — keeps
        // the tally a fold over a single event shape.
        //
        // This case therefore records nothing. It exists so the event is
        // recognised rather than falling through to the default branch, where a
        // future reader would have to guess whether it was deliberately ignored.
        break;
      }
      case "CommitmentExpired": {
        const args = event.args as { voter: string };
        result.votes.push({
          ...base,
          voter: args.voter.toLowerCase(),
          optionId: 0,
          eventType: "expired",
          power: "0",
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
          // A withdrawal carries no power: the amount released is whatever the
          // vote had been worth, which the reader gets from the rows it is
          // releasing rather than from this one.
          power: "0",
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
