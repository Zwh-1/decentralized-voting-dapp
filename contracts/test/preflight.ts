// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configurationProblems, preflight } from "../scripts/preflight";

/**
 * The deployment preflight.
 *
 * These exist because the way a hand-edited `.env` actually fails is "set and
 * unusable", not "missing". The old guard only counted variables, so an unusable
 * value reached viem, which reported an error that never named the variable and
 * echoed the value.
 *
 * The `VOTING_OWNER` coverage that used to live here is gone with the variable:
 * a `VotingFactory` has no owner, because every poll belongs to whoever created
 * it. Keeping a validated-but-unused variable would have been a check that
 * cannot affect a deployment.
 */
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = `0x${"a".repeat(64)}`;
const ADDRESS = `0x${"b".repeat(40)}`;

const names = (problems: { name: string }[]) => problems.map((problem) => problem.name);

describe("configurationProblems", () => {
  it("asks for no credentials on a local network", () => {
    // `hardhat node` supplies its own accounts; demanding credentials there would
    // make the documented local workflow refuse to run.
    for (const network of ["hardhat", "localhost"]) {
      assert.deepEqual(configurationProblems(network, {}), []);
    }
  });

  it("names both credentials when neither is set", () => {
    const problems = configurationProblems("sepolia", {});

    assert.deepEqual(names(problems), ["SEPOLIA_RPC_URL", "SEPOLIA_PRIVATE_KEY"]);
  });

  it("treats an empty value as unset", () => {
    // The shape a half-filled `.env` has: the name is there, the value is not.
    const problems = configurationProblems("sepolia", {
      SEPOLIA_RPC_URL: "",
      SEPOLIA_PRIVATE_KEY: "",
    });

    assert.deepEqual(names(problems), ["SEPOLIA_RPC_URL", "SEPOLIA_PRIVATE_KEY"]);
  });

  it("accepts a complete configuration", () => {
    assert.deepEqual(
      configurationProblems("sepolia", {
        SEPOLIA_RPC_URL: RPC,
        SEPOLIA_PRIVATE_KEY: KEY,
      }),
      [],
    );
  });

  it("ignores variables it no longer reads", () => {
    // `VOTING_OWNER` is retired. A stale line in an existing `.env` must not
    // fail a deployment that no longer has the concept.
    assert.deepEqual(
      configurationProblems("sepolia", {
        SEPOLIA_RPC_URL: RPC,
        SEPOLIA_PRIVATE_KEY: KEY,
        VOTING_OWNER: "not an address",
      }),
      [],
    );
  });

  it("rejects an RPC endpoint that is not an http(s) URL", () => {
    for (const value of ["127.0.0.1:8545", "ws://example.com", "not a url"]) {
      const problems = configurationProblems("sepolia", {
        SEPOLIA_RPC_URL: value,
        SEPOLIA_PRIVATE_KEY: KEY,
      });

      assert.deepEqual(names(problems), ["SEPOLIA_RPC_URL"], `should reject ${value}`);
    }
  });

  it("accepts an RPC endpoint that carries a query string", () => {
    // A hosted endpoint may carry its own key in the URL, as the measured one does.
    const problems = configurationProblems("sepolia", {
      SEPOLIA_RPC_URL: `${RPC}?apiKey=abc123`,
      SEPOLIA_PRIVATE_KEY: KEY,
    });

    assert.deepEqual(problems, []);
  });

  it("rejects a private key that is the wrong shape", () => {
    // A 40-hex address in the key field: the mis-paste that motivated this module.
    const problems = configurationProblems("sepolia", {
      SEPOLIA_RPC_URL: RPC,
      SEPOLIA_PRIVATE_KEY: ADDRESS,
    });

    assert.deepEqual(names(problems), ["SEPOLIA_PRIVATE_KEY"]);
    assert.match(problems[0]!.detail, /64 hex characters/);
  });

  it("never puts a value in the report", () => {
    // The reason this module exists at all: viem's own message echoes the value,
    // so a malformed key would reach the terminal and the CI log.
    const misplacedKey = `0x${"c".repeat(40)}`;
    const problems = configurationProblems("sepolia", {
      SEPOLIA_RPC_URL: RPC,
      SEPOLIA_PRIVATE_KEY: misplacedKey,
    });

    assert.deepEqual(names(problems), ["SEPOLIA_PRIVATE_KEY"]);
    for (const problem of problems) {
      assert.ok(!problem.detail.includes(misplacedKey), `${problem.name} echoed its value`);
      assert.ok(
        !problem.detail.includes(misplacedKey.slice(2, 6)),
        `${problem.name} echoed part of it`,
      );
      assert.match(problem.detail, /\d+ characters/, "it should say how long the value is instead");
    }
  });

  it("reports every problem at once rather than one per attempt", () => {
    const problems = configurationProblems("sepolia", {});

    assert.deepEqual(names(problems), ["SEPOLIA_RPC_URL", "SEPOLIA_PRIVATE_KEY"]);
  });
});

describe("preflight", () => {
  it("throws with the variable names and how to supply them", () => {
    assert.throws(
      () => preflight("sepolia", {}),
      (error: Error) => {
        for (const name of ["SEPOLIA_RPC_URL", "SEPOLIA_PRIVATE_KEY"]) {
          assert.ok(error.message.includes(name), `should mention ${name}`);
        }
        assert.match(error.message, /keystore set SEPOLIA_PRIVATE_KEY/);

        return true;
      },
    );
  });

  it("returns quietly when there is nothing to report", () => {
    assert.doesNotThrow(() =>
      preflight("sepolia", { SEPOLIA_RPC_URL: RPC, SEPOLIA_PRIVATE_KEY: KEY }),
    );
    assert.doesNotThrow(() => preflight("localhost", {}));
  });
});
