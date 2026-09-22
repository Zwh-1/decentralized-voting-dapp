// SPDX-License-Identifier: MIT
/**
 * Which chain the browser reads, and which contract on it.
 *
 * `useChainId()` answers with the first chain registered in the client's wagmi
 * config — the local Hardhat node — whenever no wallet is connected, whatever
 * `CHAIN_ID` says. Against a Sepolia-configured deployment the page therefore
 * rendered the *local* contract's address (`0x5fbdb2…`) while the server read
 * Sepolia (`0x4bb0fd…`), and every `eth_call` behind it went to
 * `http://127.0.0.1:8545`, which was not running: 阶段 read 未知 forever and the
 * vote button could never be enabled. Two chains in one page, and the page named
 * the wrong one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getDeployment } from "../src/lib/contracts";
import { chainName, resolveChainTarget } from "../src/lib/voting";

/** The local Hardhat node, which is what the client config falls back to. */
const HARDHAT = 31337;
const SEPOLIA = 11155111;

function recorded(chainId: number): `0x${string}` {
  const deployment = getDeployment(chainId);

  assert.ok(deployment !== undefined, `no deployment recorded for chain ${chainId}`);

  return deployment.factory;
}

describe("resolveChainTarget", () => {
  it("follows the server's configured chain when no wallet is connected", () => {
    const target = resolveChainTarget({
      walletConnected: false,
      walletChainId: HARDHAT,
      configured: { chainId: SEPOLIA, factoryAddress: recorded(SEPOLIA) },
    });

    // The regression in one assertion: the client's default chain id is Hardhat,
    // and it must not decide which contract a Sepolia deployment talks about.
    assert.deepEqual(target, { chainId: SEPOLIA, factoryAddress: recorded(SEPOLIA) });
    assert.notEqual(target?.factoryAddress, recorded(HARDHAT));
  });

  it("lets a connected wallet choose the chain, because that is where it signs", () => {
    const target = resolveChainTarget({
      walletConnected: true,
      walletChainId: HARDHAT,
      configured: { chainId: SEPOLIA, factoryAddress: recorded(SEPOLIA) },
    });

    // The wallet's chain wins even though the deployment is configured for
    // another one: a vote sent to the Sepolia address from a Hardhat wallet
    // would simply not be the transaction the reader asked for. The mismatch is
    // surfaced separately, by the page's own warning.
    assert.deepEqual(target, { chainId: HARDHAT, factoryAddress: recorded(HARDHAT) });
  });

  it("reports no target when the wallet is on a chain with no recorded deployment", () => {
    assert.equal(
      resolveChainTarget({
        walletConnected: true,
        walletChainId: 1,
        configured: { chainId: SEPOLIA, factoryAddress: recorded(SEPOLIA) },
      }),
      null,
    );
  });

  it("falls back to the client's own chain when the server's config could not be read", () => {
    assert.deepEqual(
      resolveChainTarget({ walletConnected: false, walletChainId: HARDHAT, configured: null }),
      { chainId: HARDHAT, factoryAddress: recorded(HARDHAT) },
    );
  });

  it("always pairs the chain id with the address deployed on that chain", () => {
    for (const chainId of [HARDHAT, SEPOLIA]) {
      const target = resolveChainTarget({
        walletConnected: true,
        walletChainId: chainId,
        configured: null,
      });

      assert.equal(target?.chainId, chainId);
      assert.equal(target?.factoryAddress, getDeployment(chainId)?.factory);
    }
  });
});

describe("chainName", () => {
  it("names the two chains this project deploys to", () => {
    assert.equal(chainName(HARDHAT), "本地 Hardhat");
    assert.equal(chainName(SEPOLIA), "Sepolia");
  });

  it("names an unregistered chain as unknown rather than as one of the two", () => {
    assert.equal(chainName(1), "未知链 1");
  });
});
