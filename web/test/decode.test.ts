// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Abi, type AbiEvent } from "viem";

import { factoryAbi, pollAbi } from "../src/lib/contracts";

import { decodeLogs } from "../src/lib/indexer/decode";

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const POLL_A = "0xaaaa000000000000000000000000000000000000" as const;
const POLL_B = "0xbbbb000000000000000000000000000000000000" as const;
// Lower-case on purpose: `toLowerCase()` in the decoder must be doing real work
// for these assertions to pass, and a mixed-case address would also have to be
// checksum-valid for viem to encode it at all.
const VOTER = "0x019b020913b752e0b922b1c305fde9256546c04b" as const;

/** The three events `VotingFactory` / `Poll` emit, narrowed so viem can resolve them. */
type EventName =
  | "PollCreated"
  | "OptionAdded"
  | "OptionUpdated"
  | "OptionRemoved"
  | "VoteCast"
  | "VoteChanged"
  | "VoteWithdrawn"
  | "Refunded"
  | "WhitelistUpdated"
  | "PhaseChanged";

/** `PollCreated` comes from the factory; everything else from a poll. */
function abiFor(eventName: EventName): Abi {
  return (eventName === "PollCreated" ? factoryAbi : pollAbi) as unknown as Abi;
}

/**
 * Builds a realistic log entry by encoding the event against the very ABI the
 * indexer decodes with. Reading the `indexed` flags from the ABI means this
 * helper stays correct if the contract's event signatures ever change.
 */
function makeLog(
  eventName: EventName,
  args: Record<string, unknown>,
  base: { blockNumber: bigint; txHash: string; logIndex: number; address?: string },
) {
  const abi = abiFor(eventName);
  const item = getAbiItem({ abi, name: eventName }) as unknown as AbiEvent;
  const inputs = item.inputs;

  const indexedArgs = Object.fromEntries(
    inputs
      .filter((input) => input.indexed)
      .map((input) => [input.name, args[input.name as string]]),
  );
  const nonIndexed = inputs.filter((input) => !input.indexed);

  // `encodeAbiParameters` takes bare `{ name, type }` parameters; the ABI's
  // extra fields (`indexed`, `internalType`) are not part of that shape.
  const dataParams = nonIndexed.map((input) => ({ name: input.name, type: input.type }));

  return {
    address: base.address ?? (eventName === "PollCreated" ? FACTORY : POLL_A),
    blockNumber: base.blockNumber,
    transactionHash: base.txHash,
    logIndex: base.logIndex,
    topics: encodeEventTopics({
      abi,
      eventName,
      args: indexedArgs as never,
    }),
    data: encodeAbiParameters(
      dataParams as never,
      nonIndexed.map((input) => args[input.name as string]) as never,
    ),
  };
}

const base = {
  blockNumber: 42n,
  txHash: `0x${"ab".repeat(32)}`,
  logIndex: 7,
};

describe("decodeLogs", () => {
  it("decodes PollCreated into a polls row, with the poll address from the event", () => {
    const result = decodeLogs([
      makeLog(
        "PollCreated",
        {
          poll: POLL_A,
          creator: VOTER,
          question: "Which of these?",
          endsAt: 1_800_000_000n,
          optionCount: 3n,
          openToAll: false,
        },
        base,
      ),
    ]);

    assert.equal(result.polls.length, 1);
    assert.deepEqual(result.polls[0], {
      ...base,
      pollAddress: FACTORY.toLowerCase(),
      address: POLL_A.toLowerCase(),
      creator: VOTER.toLowerCase(),
      question: "Which of these?",
      endsAt: "1800000000",
      optionCount: 3,
    });
  });

  it("decodes OptionAdded against the poll that emitted it", () => {
    const result = decodeLogs([
      makeLog("OptionAdded", { id: 1n, labelCID: "cid-a" }, { ...base, address: POLL_A }),
      makeLog(
        "OptionAdded",
        { id: 1n, labelCID: "cid-b" },
        { ...base, logIndex: 8, address: POLL_B },
      ),
    ]);

    assert.equal(result.options.length, 2);
    assert.equal(result.options[0]?.pollAddress, POLL_A.toLowerCase());
    assert.equal(result.options[0]?.labelCid, "cid-a");
    assert.equal(
      result.options[1]?.pollAddress,
      POLL_B.toLowerCase(),
      "two polls' options must not collapse into one another",
    );
  });

  it("decodes OptionUpdated and OptionRemoved", () => {
    const result = decodeLogs([
      makeLog("OptionUpdated", { id: 2n, labelCID: "cid-new" }, { ...base, logIndex: 1 }),
      makeLog("OptionRemoved", { id: 3n }, { ...base, logIndex: 2 }),
    ]);

    assert.equal(result.options.length, 2);
    assert.equal(result.options[0]?.optionId, 2);
    assert.equal(result.options[0]?.labelCid, "cid-new");
    assert.equal(result.options[1]?.optionId, 3);
    assert.equal(
      result.options[1]?.labelCid,
      "",
      "a removal is recorded as a tombstone, not silently dropped",
    );
  });

  it("decodes VoteCast as a 'cast' event", () => {
    const result = decodeLogs([
      makeLog("VoteCast", { voter: VOTER, optionId: 2n, newCount: 1n }, base),
    ]);

    assert.equal(result.votes.length, 1);
    assert.equal(result.votes[0]?.eventType, "cast");
    assert.equal(result.votes[0]?.optionId, 2);
    assert.equal(result.votes[0]?.voter, VOTER.toLowerCase());
    assert.equal(result.votes[0]?.pollAddress, POLL_A.toLowerCase());
  });

  it("decodes VoteChanged as a 'changed' event carrying the NEW option", () => {
    const result = decodeLogs([
      makeLog("VoteChanged", { voter: VOTER, fromOptionId: 1n, toOptionId: 3n }, base),
    ]);

    assert.equal(result.votes.length, 1);
    assert.equal(result.votes[0]?.eventType, "changed");
    assert.equal(
      result.votes[0]?.optionId,
      3,
      "the current vote after a change is where it moved TO",
    );
  });

  it("decodes VoteWithdrawn as a 'withdrawn' event with option 0", () => {
    const result = decodeLogs([
      makeLog("VoteWithdrawn", { voter: VOTER, amount: 1_000_000_000_000_000n }, base),
    ]);

    assert.equal(result.votes.length, 1);
    assert.equal(result.votes[0]?.eventType, "withdrawn");
    assert.equal(
      result.votes[0]?.optionId,
      0,
      "a withdrawal carries an amount, not an option; 0 is the sentinel",
    );
  });

  it("converts a Refunded amount to a decimal string, never a number", () => {
    const amount = 1_000_000_000_000_000n;

    const result = decodeLogs([makeLog("Refunded", { voter: VOTER, amount }, base)]);

    assert.equal(result.refunds.length, 1);
    assert.equal(result.refunds[0]?.amountWei, "1000000000000000");
    assert.equal(typeof result.refunds[0]?.amountWei, "string");
    assert.equal(result.refunds[0]?.pollAddress, POLL_A.toLowerCase());
  });

  it("decodes WhitelistUpdated both ways", () => {
    const added = decodeLogs([makeLog("WhitelistUpdated", { voter: VOTER, allowed: true }, base)]);
    const removed = decodeLogs([
      makeLog("WhitelistUpdated", { voter: VOTER, allowed: false }, { ...base, logIndex: 8 }),
    ]);

    assert.equal(added.whitelist[0]?.allowed, true);
    assert.equal(removed.whitelist[0]?.allowed, false);
  });

  it("decodes PhaseChanged against the emitting poll", () => {
    const result = decodeLogs([
      makeLog("PhaseChanged", { from: 0, to: 1 }, { ...base, address: POLL_B }),
    ]);

    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0]?.fromPhase, 0);
    assert.equal(result.phases[0]?.toPhase, 1);
    assert.equal(result.phases[0]?.pollAddress, POLL_B.toLowerCase());
  });

  it("decodes a factory log and a poll log from the same batch", () => {
    const result = decodeLogs([
      makeLog(
        "PollCreated",
        {
          poll: POLL_A,
          creator: VOTER,
          question: "q",
          endsAt: 1_800_000_000n,
          optionCount: 2n,
          openToAll: true,
        },
        { ...base, logIndex: 0 },
      ),
      makeLog("OptionAdded", { id: 1n, labelCID: "cid-a" }, { ...base, logIndex: 1 }),
      makeLog("VoteCast", { voter: VOTER, optionId: 1n, newCount: 1n }, { ...base, logIndex: 2 }),
      makeLog("Refunded", { voter: VOTER, amount: 5n }, { ...base, logIndex: 3 }),
      makeLog("PhaseChanged", { from: 0, to: 1 }, { ...base, logIndex: 4 }),
      makeLog("WhitelistUpdated", { voter: VOTER, allowed: true }, { ...base, logIndex: 5 }),
    ]);

    assert.equal(result.polls.length, 1);
    assert.equal(result.options.length, 1);
    assert.equal(result.votes.length, 1);
    assert.equal(result.refunds.length, 1);
    assert.equal(result.phases.length, 1);
    assert.equal(result.whitelist.length, 1);
  });

  it("ignores a log it does not recognise instead of failing the batch", () => {
    const foreign = {
      address: POLL_A,
      blockNumber: 1n,
      transactionHash: `0x${"cd".repeat(32)}`,
      logIndex: 0,
      topics: [`0x${"ef".repeat(32)}`],
      data: "0x" as const,
    };

    const result = decodeLogs([foreign]);

    assert.equal(result.votes.length, 0);
    assert.equal(result.options.length, 0);
    assert.equal(result.polls.length, 0);
  });

  it("refuses a pending log rather than indexing a block number of null", () => {
    const pending = {
      ...makeLog("VoteCast", { voter: VOTER, optionId: 1n, newCount: 1n }, base),
      blockNumber: null,
    };

    assert.throws(() => decodeLogs([pending]), /pending log/);
  });

  it("returns empty buckets for an empty input", () => {
    const result = decodeLogs([]);

    assert.deepEqual(result, {
      polls: [],
      options: [],
      votes: [],
      refunds: [],
      whitelist: [],
      phases: [],
    });
  });
});
