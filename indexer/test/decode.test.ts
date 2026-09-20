// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, encodeEventTopics, getAbiItem, type AbiEvent } from "viem";

import { votingAbi } from "@voting/shared";

import { decodeLogs } from "../src/indexer/decode.js";

const CONTRACT = "0x1111111111111111111111111111111111111111" as const;

/** The events `Voting` emits, narrowed so viem can resolve them by name. */
type VotingEventName =
  | "CandidateAdded"
  | "VoteCast"
  | "Refunded"
  | "WhitelistUpdated"
  | "PhaseChanged";

/**
 * Builds a realistic log entry by encoding the event against the very ABI the
 * indexer decodes with. Reading the `indexed` flags from the ABI means this
 * helper stays correct if the contract's event signatures ever change.
 */
function makeLog(
  eventName: VotingEventName,
  args: Record<string, unknown>,
  base: { blockNumber: bigint; txHash: string; logIndex: number },
) {
  const item = getAbiItem({ abi: votingAbi, name: eventName }) as unknown as AbiEvent;
  const inputs = item.inputs;

  const indexedArgs = Object.fromEntries(
    inputs.filter((input) => input.indexed).map((input) => [input.name, args[input.name as string]]),
  );
  const nonIndexed = inputs.filter((input) => !input.indexed);

  // `encodeAbiParameters` takes bare `{ name, type }` parameters; the ABI's
  // extra fields (`indexed`, `internalType`) are not part of that shape.
  const dataParams = nonIndexed.map((input) => ({ name: input.name, type: input.type }));

  return {
    address: CONTRACT,
    blockNumber: base.blockNumber,
    transactionHash: base.txHash,
    logIndex: base.logIndex,
    topics: encodeEventTopics({
      abi: votingAbi,
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
  it("decodes CandidateAdded", () => {
    const result = decodeLogs([makeLog("CandidateAdded", { id: 1n, metadataCID: "cid-a" }, base)]);

    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.candidates[0], {
      ...base,
      id: 1,
      metadataCid: "cid-a",
    });
  });

  it("decodes VoteCast", () => {
    const result = decodeLogs([
      makeLog(
        "VoteCast",
        { voter: CONTRACT, candidateId: 2n, newCount: 1n },
        base,
      ),
    ]);

    assert.equal(result.votes.length, 1);
    assert.equal(result.votes[0]?.candidateId, 2);
    assert.equal(result.votes[0]?.voter, CONTRACT);
  });

  it("converts a Refunded amount to a decimal string, never a number", () => {
    const amount = 1_000_000_000_000_000n;

    const result = decodeLogs([makeLog("Refunded", { voter: CONTRACT, amount }, base)]);

    assert.equal(result.refunds.length, 1);
    assert.equal(result.refunds[0]?.amountWei, "1000000000000000");
    assert.equal(typeof result.refunds[0]?.amountWei, "string");
  });

  it("decodes WhitelistUpdated both ways", () => {
    const added = decodeLogs([
      makeLog("WhitelistUpdated", { voter: CONTRACT, allowed: true }, base),
    ]);
    const removed = decodeLogs([
      makeLog("WhitelistUpdated", { voter: CONTRACT, allowed: false }, { ...base, logIndex: 8 }),
    ]);

    assert.equal(added.whitelist[0]?.allowed, true);
    assert.equal(removed.whitelist[0]?.allowed, false);
  });

  it("decodes PhaseChanged", () => {
    const result = decodeLogs([makeLog("PhaseChanged", { from: 0, to: 1 }, base)]);

    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0]?.fromPhase, 0);
    assert.equal(result.phases[0]?.toPhase, 1);
  });

  it("sorts mixed events into the right tables", () => {
    const result = decodeLogs([
      makeLog("CandidateAdded", { id: 1n, metadataCID: "cid-a" }, { ...base, logIndex: 1 }),
      makeLog("VoteCast", { voter: CONTRACT, candidateId: 1n, newCount: 1n }, { ...base, logIndex: 2 }),
      makeLog("Refunded", { voter: CONTRACT, amount: 5n }, { ...base, logIndex: 3 }),
      makeLog("PhaseChanged", { from: 0, to: 1 }, { ...base, logIndex: 4 }),
      makeLog("WhitelistUpdated", { voter: CONTRACT, allowed: true }, { ...base, logIndex: 5 }),
    ]);

    assert.equal(result.candidates.length, 1);
    assert.equal(result.votes.length, 1);
    assert.equal(result.refunds.length, 1);
    assert.equal(result.phases.length, 1);
    assert.equal(result.whitelist.length, 1);
  });

  it("ignores a log it does not recognise instead of failing the batch", () => {
    const foreign = {
      address: CONTRACT,
      blockNumber: 1n,
      transactionHash: `0x${"cd".repeat(32)}`,
      logIndex: 0,
      topics: [`0x${"ef".repeat(32)}`],
      data: "0x" as const,
    };

    const result = decodeLogs([foreign]);

    assert.equal(result.candidates.length, 0);
    assert.equal(result.votes.length, 0);
  });

  it("refuses a pending log rather than indexing a block number of null", () => {
    const pending = {
      ...makeLog("VoteCast", { voter: CONTRACT, candidateId: 1n, newCount: 1n }, base),
      blockNumber: null,
    };

    assert.throws(() => decodeLogs([pending]), /pending log/);
  });

  it("returns empty buckets for an empty input", () => {
    const result = decodeLogs([]);

    assert.deepEqual(result, {
      candidates: [],
      votes: [],
      refunds: [],
      whitelist: [],
      phases: [],
    });
  });
});
