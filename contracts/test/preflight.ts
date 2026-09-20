// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configurationProblems, preflight } from "../scripts/preflight";

/**
 * The deployment preflight.
 *
 * These exist because the two ways a hand-edited `.env` actually fails are both
 * "set and unusable", not "missing": a mistyped owner and a key pasted into the
 * wrong field. The old guard only counted variables, so both reached viem, which
 * reported an error that never named the variable and echoed the value.
 */
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = `0x${"a".repeat(64)}`;
const OWNER = `0x${"b".repeat(40)}`;

const names = (problems: { name: string }[]) => problems.map((problem) => problem.name);

describe("configurationProblems", () => {
  it("asks for no credentials on a local network", () => {
    // `hardhat node` supplies its own accounts; demanding credentials there would
    // make the documented local workflow refuse to run.
    for (const network of ["hardhat", "localhost"]) {
      assert.deepEqual(configurationProblems(network, {}), []);
    }
  });

  it("still validates VOTING_OWNER on a local network", () => {
    // It is a deployment input, not a credential, so the local early-return must
    // not skip it. Gating it on the network name let a measured `contracts/.env`
    // reach viem through `deploy:local`, and viem echoes the value it rejects —
    // which put a 32-byte secret in the terminal on a path that needs no secrets.
    const problems = configurationProblems("localhost", { VOTING_OWNER: KEY });

    assert.deepEqual(names(problems), ["VOTING_OWNER"]);
    assert.ok(!problems[0]!.detail.includes(KEY));
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
        VOTING_OWNER: OWNER,
      }),
      [],
    );
  });

  it("accepts an absent VOTING_OWNER, which defaults to the deployer", () => {
    assert.deepEqual(
      configurationProblems("sepolia", { SEPOLIA_RPC_URL: RPC, SEPOLIA_PRIVATE_KEY: KEY }),
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
    // A 40-hex address in the key field is the mirror image of the mis-paste that
    // motivated this module.
    const problems = configurationProblems("sepolia", {
      SEPOLIA_RPC_URL: RPC,
      SEPOLIA_PRIVATE_KEY: OWNER,
    });

    assert.deepEqual(names(problems), ["SEPOLIA_PRIVATE_KEY"]);
    assert.match(problems[0]!.detail, /64 hex characters/);
  });

  it("rejects a VOTING_OWNER that is actually a private key", () => {
    // The measured state of a real `contracts/.env`. It used to reach viem, which
    // threw `InvalidAddressError` without ever naming the variable.
    const problems = configurationProblems("sepolia", {
      SEPOLIA_RPC_URL: RPC,
      SEPOLIA_PRIVATE_KEY: KEY,
      VOTING_OWNER: KEY,
    });

    assert.deepEqual(names(problems), ["VOTING_OWNER"]);
    assert.match(problems[0]!.detail, /40 hex characters/);
    assert.match(problems[0]!.detail, /private key/, "it must suggest what went wrong");
  });

  it("never puts a value in the report", () => {
    // The reason this module exists at all: viem's own message echoes the value,
    // so a misplaced deployer key would reach the terminal and the CI log.
    // Two different wrong shapes, because a 64-hex value is a *valid* private key
    // and therefore belongs in that field.
    const misplacedKey = `0x${"c".repeat(40)}`; // address-shaped, invalid as a key
    const misplacedOwner = `0x${"d".repeat(64)}`; // key-shaped, invalid as an address
    const problems = configurationProblems("sepolia", {
      SEPOLIA_RPC_URL: RPC,
      SEPOLIA_PRIVATE_KEY: misplacedKey,
      VOTING_OWNER: misplacedOwner,
    });

    assert.deepEqual(names(problems), ["SEPOLIA_PRIVATE_KEY", "VOTING_OWNER"]);
    for (const [problem, value] of [
      [problems[0]!, misplacedKey],
      [problems[1]!, misplacedOwner],
    ] as const) {
      assert.ok(!problem.detail.includes(value), `${problem.name} echoed its value`);
      assert.ok(!problem.detail.includes(value.slice(2, 6)), `${problem.name} echoed part of it`);
      assert.match(problem.detail, /\d+ characters/, "it should say how long the value is instead");
    }
  });

  it("reports every problem at once rather than one per attempt", () => {
    const problems = configurationProblems("sepolia", { VOTING_OWNER: KEY });

    assert.deepEqual(names(problems), ["SEPOLIA_RPC_URL", "SEPOLIA_PRIVATE_KEY", "VOTING_OWNER"]);
  });
});

describe("preflight", () => {
  it("throws with the variable names and how to supply them", () => {
    assert.throws(
      () => preflight("sepolia", { VOTING_OWNER: KEY }),
      (error: Error) => {
        for (const name of ["SEPOLIA_RPC_URL", "SEPOLIA_PRIVATE_KEY", "VOTING_OWNER"]) {
          assert.ok(error.message.includes(name), `should mention ${name}`);
        }
        assert.match(error.message, /keystore set SEPOLIA_PRIVATE_KEY/);

        return true;
      },
    );
  });

  it("does not offer the keystore for a variable that is not a secret", () => {
    // `VOTING_OWNER` is an address. Sending someone to `keystore set` for it would
    // encrypt a public value and hide it from `deploy.ts`, which reads `process.env`.
    assert.throws(
      () =>
        preflight("sepolia", { SEPOLIA_RPC_URL: RPC, SEPOLIA_PRIVATE_KEY: KEY, VOTING_OWNER: KEY }),
      (error: Error) => {
        assert.ok(!/keystore set VOTING_OWNER/.test(error.message));

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
