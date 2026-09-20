// SPDX-License-Identifier: MIT
/**
 * Tests for how the indexer decides where to start reading.
 *
 * This default is load-bearing rather than cosmetic. Public RPCs prune old
 * history — Sepolia's earliest available block is around 1,000,000 — so an
 * index that starts at block 0 does not crawl slowly, it fails outright with
 * `pruned history unavailable` after a couple of thousand blocks. Worse, the
 * cursor has already advanced past those blocks by then, so every retry replays
 * the same failing range and the index never recovers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadServerConfig } from "../src/lib/config";
import { getDeployment } from "../src/lib/contracts";

/** An env that satisfies every other required field. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", RPC_URL: "http://127.0.0.1:8545", ...overrides };
}

describe("startBlock", () => {
  it("defaults to the block the contract was deployed in, not to 0", () => {
    const config = loadServerConfig(env({ CHAIN_ID: "31337" }));

    const recorded = getDeployment(31337);
    assert.notEqual(recorded, undefined);

    // If this ever becomes 0 or undefined, a fresh index against a
    // pruned-history RPC stops working.
    assert.equal(config.startBlock, BigInt(recorded!.blockNumber!));
    assert.notEqual(config.startBlock, 0n);
  });

  it("lets START_BLOCK override the recorded deployment block", () => {
    const config = loadServerConfig(env({ CHAIN_ID: "31337", START_BLOCK: "250" }));

    assert.equal(config.startBlock, 250n);
  });

  it("honours an explicit START_BLOCK of 0, rather than treating it as unset", () => {
    const config = loadServerConfig(env({ CHAIN_ID: "31337", START_BLOCK: "0" }));

    assert.equal(config.startBlock, 0n);
  });

  it("is undefined for a chain with no recorded deployment", () => {
    const config = loadServerConfig(
      env({
        CHAIN_ID: "11155111",
        VOTING_ADDRESS: "0x0000000000000000000000000000000000000001",
      }),
    );

    // Nothing is known about where to start; the operator must say.
    assert.equal(config.startBlock, undefined);
  });
});
