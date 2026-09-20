// SPDX-License-Identifier: MIT

/**
 * Pure decision logic for the indexer: which block range to fetch next, and
 * whether a reorg has invalidated what we already stored.
 *
 * This module deliberately has no I/O so it can be unit tested exhaustively
 * without a chain or a database. `sync.ts` owns the effects.
 */

export interface PlanInput {
  /** Highest block the chain reports. */
  chainHead: bigint;
  /** Highest block already persisted, or null when nothing has been indexed. */
  lastIndexedBlock: bigint | null;
  /** Blocks to leave on top of the head before treating a block as final. */
  confirmations: number;
  /** Maximum span per `getLogs` call. */
  chunkBlocks: number;
}

export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * The highest block that is safe to index.
 *
 * Returns -1n when the chain is shorter than the confirmation window, i.e.
 * there is nothing final yet. Using -1n as "below genesis" keeps every
 * comparison a plain bigint compare with no null handling at the call sites.
 */
export function safeHead(chainHead: bigint, confirmations: number): bigint {
  return chainHead - BigInt(confirmations);
}

/**
 * The next range to fetch, or null when the indexer is already caught up.
 *
 * The returned range never crosses the safe head, so an event that is later
 * reorged out can never have been written.
 */
export function planNextRange(input: PlanInput): BlockRange | null {
  const { chainHead, lastIndexedBlock, confirmations, chunkBlocks } = input;

  if (chunkBlocks < 1) {
    throw new RangeError("chunkBlocks must be at least 1");
  }
  if (confirmations < 0) {
    throw new RangeError("confirmations must not be negative");
  }

  const head = safeHead(chainHead, confirmations);
  const from = lastIndexedBlock === null ? 0n : lastIndexedBlock + 1n;

  if (from > head) {
    return null;
  }

  const to = from + BigInt(chunkBlocks) - 1n;

  return { fromBlock: from, toBlock: to < head ? to : head };
}

/**
 * Detects that the chain has moved backwards past what we stored, which is the
 * signature of a reorg.
 *
 * `rewindTo` is the block the cursor must be reset to so that the discarded
 * blocks are re-fetched. It is capped at the safe head: blocks inside the
 * confirmation window are treated as unfinal by definition, so a reorg that
 * only touches them needs no repair of the finalised data.
 *
 * Returns null when there is nothing to do.
 */
export function planReorgRewind(input: {
  chainHead: bigint;
  lastIndexedBlock: bigint | null;
  confirmations: number;
}): { rewindTo: bigint; discardedFrom: bigint } | null {
  const { chainHead, lastIndexedBlock, confirmations } = input;

  if (lastIndexedBlock === null || lastIndexedBlock <= chainHead) {
    return null;
  }

  const head = safeHead(chainHead, confirmations);
  const rewindTo = head > 0n ? head : -1n;

  // Every block above `rewindTo` must be re-fetched; reporting the lowest one
  // lets the caller log exactly what it dropped.
  return { rewindTo, discardedFrom: rewindTo + 1n };
}

/**
 * Number of blocks between the chain head and what we have indexed, counting
 * only blocks that are safe to index. Used for the `/api/health` lag figure.
 */
export function lagBlocks(input: {
  chainHead: bigint;
  lastIndexedBlock: bigint | null;
  confirmations: number;
}): bigint {
  const head = safeHead(input.chainHead, input.confirmations);
  const last = input.lastIndexedBlock ?? -1n;

  return head > last ? head - last : 0n;
}
