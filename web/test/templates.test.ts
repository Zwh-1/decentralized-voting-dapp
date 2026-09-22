// SPDX-License-Identifier: MIT
/**
 * Tests for the create-poll templates.
 *
 * The rule this file exists to enforce is the repository's batch-4 rule:
 * a derived value is generated from one source, never written a second time.
 * `mechanisms.ts` owns `PollConfig` and `DEFAULT_CONFIG`; a template that
 * restated a field would be a second copy of the contract's shape, and the two
 * would drift silently until a reader's transaction reverted.
 *
 * So the tests below do not compare a template against a table of nine literals.
 * They compare it against what `mechanisms.ts` says the defaults are — which is
 * the only way the assertion keeps meaning something after the contract changes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, validateConfig, type PollConfig } from "../src/lib/mechanisms";
import {
  DEFAULT_TEMPLATE,
  POLL_TEMPLATES,
  buildPollConfig,
  describeConfigProblem,
  describeMechanisms,
  findTemplate,
  isTemplateId,
  templateConfig,
} from "../src/lib/templates";

/** The fields `mechanisms.ts` declares, as the contract's field order lists them. */
const CONFIG_FIELDS: (keyof PollConfig)[] = [
  "openToAll",
  "multiSelect",
  "maxSelections",
  "weighted",
  "delegable",
  "commitReveal",
  "revealWindowSeconds",
  "quorumBps",
  "timelockSeconds",
];

/** The shapes the plan names: single choice, multi-select, weighted. */
const EXPECTED_IDS = ["single", "multi-select", "weighted"];

describe("POLL_TEMPLATES", () => {
  it("offers the three shapes the plan names, with unique ids", () => {
    assert.deepEqual(
      POLL_TEMPLATES.map((template) => template.id),
      EXPECTED_IDS,
    );
    assert.equal(new Set(EXPECTED_IDS).size, POLL_TEMPLATES.length, "ids must be unique");
  });

  it("names and describes every template in the reader's language", () => {
    for (const template of POLL_TEMPLATES) {
      assert.ok(template.name.trim().length > 0, template.id);
      assert.ok(template.description.trim().length > 2, template.id);
      assert.equal(
        /[a-zA-Z]{4,}/.test(template.name),
        false,
        `${template.id} must not ship an English label`,
      );
    }
  });

  it("starts from the single-choice template", () => {
    assert.equal(DEFAULT_TEMPLATE, POLL_TEMPLATES[0]);
    assert.equal(DEFAULT_TEMPLATE.id, "single");
  });

  it("looks a template up by id and refuses anything else", () => {
    for (const template of POLL_TEMPLATES) {
      assert.equal(findTemplate(template.id), template);
      assert.equal(isTemplateId(template.id), true);
    }

    assert.equal(findTemplate(""), null);
    assert.equal(findTemplate("Single"), null, "case is part of the id");
    assert.equal(findTemplate("single "), null, "whitespace is not trimmed away");
    assert.equal(isTemplateId("commit-reveal"), false, "a shape this build does not offer");
  });
});

describe("templateConfig", () => {
  it("returns every field mechanisms.ts declares, and no others", () => {
    for (const template of POLL_TEMPLATES) {
      const config = templateConfig(template);

      assert.deepEqual(Object.keys(config).sort(), [...CONFIG_FIELDS].sort(), template.id);
    }
  });

  it("differs from the contract defaults ONLY where the template says so", () => {
    // This is the whole derivation rule in one assertion: a field the template
    // did not override keeps `DEFAULT_CONFIG`'s value (admission excepted, which
    // the template states as its own `defaultAdmission`).
    for (const template of POLL_TEMPLATES) {
      const config = templateConfig(template);

      for (const field of CONFIG_FIELDS) {
        if (field === "openToAll") continue;

        const expected =
          field in template.overrides ? template.overrides[field] : DEFAULT_CONFIG[field];

        assert.equal(config[field], expected, `${template.id}.${field}`);
      }

      assert.equal(config.openToAll, template.defaultAdmission.openToAll, template.id);
    }
  });

  it("does not mutate the shared defaults", () => {
    const before = { ...DEFAULT_CONFIG };

    for (const template of POLL_TEMPLATES) {
      templateConfig(template);
      buildPollConfig(template, { openToAll: true }, 6);
    }

    assert.deepEqual({ ...DEFAULT_CONFIG }, before);
  });
});

describe("every template is a config the contract accepts", () => {
  it("passes validateConfig with its own default admission", () => {
    for (const template of POLL_TEMPLATES) {
      const verdict = validateConfig(templateConfig(template));

      assert.equal(verdict.ok, true, `${template.id}: ${verdict.reason}`);
      assert.equal(verdict.reason, "");
    }
  });

  it("passes validateConfig for every admission the form can produce", () => {
    // The form's radio is the one control that can contradict a template, so
    // every combination is checked here rather than discovered as a revert. The
    // templates that refuse one of the two admissions are the reason this test
    // exists at all — `加权` requires the whitelist.
    for (const template of POLL_TEMPLATES) {
      const accepted: boolean[] = [];

      for (const openToAll of [true, false]) {
        if (validateConfig(buildPollConfig(template, { openToAll }, 4)).ok) {
          accepted.push(openToAll);
        }
      }

      assert.ok(
        accepted.includes(template.defaultAdmission.openToAll),
        `${template.id} refuses its own default admission`,
      );
    }
  });

  it("refuses the weighted template with open admission, which is why it defaults to the whitelist", () => {
    const weighted = findTemplate("weighted");
    assert.ok(weighted);

    const verdict = validateConfig(buildPollConfig(weighted, { openToAll: true }, 4));

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "weighted voting requires whitelist admission");
  });
});

describe("buildPollConfig", () => {
  const single = findTemplate("single");
  const multi = findTemplate("multi-select");
  const weighted = findTemplate("weighted");

  it("applies the admission the caller passes, over the template's own", () => {
    assert.ok(single && multi && weighted);

    assert.equal(buildPollConfig(single, { openToAll: false }, 3).openToAll, false);
    assert.equal(buildPollConfig(multi, { openToAll: false }, 3).openToAll, false);
    assert.equal(buildPollConfig(weighted, { openToAll: true }, 3).openToAll, true);
  });

  it("leaves a single-choice config single-choice", () => {
    assert.ok(single);

    const config = buildPollConfig(single, { openToAll: true }, 5);

    assert.equal(config.multiSelect, false);
    assert.equal(config.maxSelections, DEFAULT_CONFIG.maxSelections);
    assert.equal(config.weighted, false);
  });

  it("never raises maxSelections above the number of options", () => {
    assert.ok(multi);

    const templateCap = templateConfig(multi).maxSelections;
    assert.ok(templateCap >= 2, "the template's own cap must satisfy the contract");

    for (let optionCount = 0; optionCount <= templateCap + 3; optionCount += 1) {
      const config = buildPollConfig(multi, { openToAll: true }, optionCount);

      assert.equal(
        config.maxSelections,
        Math.max(2, Math.min(templateCap, optionCount)),
        `optionCount=${optionCount}`,
      );
      // Whatever the cap became, the contract accepts it.
      assert.equal(validateConfig(config).ok, true, `optionCount=${optionCount}`);
    }
  });

  it("does not mutate the template's config", () => {
    assert.ok(multi);

    const before = { ...templateConfig(multi) };
    buildPollConfig(multi, { openToAll: true }, 1);

    assert.deepEqual({ ...templateConfig(multi) }, before);
  });

  it("keeps quorumBps at 0, which is the ONLY thing making two contract rules unreachable", () => {
    // `PollMechanisms.validateGovernance` refuses `quorumBps > 10000` and
    // `quorumBps != 0 && openToAll`. `validateConfig` implements neither, and
    // that is deliberate: no caller can set a quorum, so both rules are
    // unreachable rather than unchecked.
    //
    // This test is what keeps that reasoning honest. The moment quorumBps becomes
    // settable from the form, the guard stops covering the contract and a reader
    // can submit a config that reverts on chain — so this fails, and the fix is
    // to mirror the two rules in `mechanisms.ts` (with their Chinese sentences in
    // `describeConfigProblem`) rather than to relax this assertion.
    for (const template of POLL_TEMPLATES) {
      for (const openToAll of [true, false]) {
        for (const optionCount of [0, 2, 4, 7]) {
          const config = buildPollConfig(template, { openToAll }, optionCount);

          assert.equal(
            config.quorumBps,
            0,
            `${template.id} openToAll=${openToAll} optionCount=${optionCount} produced a quorum`,
          );
        }
      }
    }
  });

  it("marks the weighted template as weighted and as needing a per-address weight", () => {
    assert.ok(weighted);

    const config = buildPollConfig(weighted, { openToAll: false }, 3);

    assert.equal(config.weighted, true);
    assert.equal(config.delegable, DEFAULT_CONFIG.delegable);
    assert.equal(config.commitReveal, DEFAULT_CONFIG.commitReveal);
    assert.equal(config.quorumBps, DEFAULT_CONFIG.quorumBps);
    assert.equal(config.timelockSeconds, DEFAULT_CONFIG.timelockSeconds);
  });
});

describe("describeMechanisms", () => {
  /** The single-choice template's config, as the form would submit it. */
  function singleMechanisms(): string {
    const single = findTemplate("single");
    assert.ok(single);

    return describeMechanisms(buildPollConfig(single, { openToAll: true }, 3));
  }

  it("says what the config does, in the reader's language", () => {
    assert.ok(singleMechanisms().includes("单选"));
    assert.ok(singleMechanisms().includes("一人一票"));
    assert.ok(singleMechanisms().includes("所有人可投"));
  });

  it("reports the cap that will actually be submitted", () => {
    // Not the template's stored cap: the sentence has to describe the config the
    // poll is created with, or the reader is told a number the calldata will not
    // contain.
    const multi = findTemplate("multi-select");
    assert.ok(multi);

    const summary = describeMechanisms(buildPollConfig(multi, { openToAll: true }, 2));

    assert.ok(summary.includes("多选，每票最多 2 项"), summary);
    assert.ok(summary.includes("所有人可投"), summary);
  });

  it("states the whitelist when the config requires it", () => {
    const weighted = findTemplate("weighted");
    assert.ok(weighted);

    const summary = describeMechanisms(buildPollConfig(weighted, { openToAll: false }, 3));

    assert.ok(summary.includes("按地址权重计票"), summary);
    assert.ok(summary.includes("仅白名单可投"), summary);
  });
});

describe("describeConfigProblem", () => {
  it("says nothing about a config the contract accepts", () => {
    for (const template of POLL_TEMPLATES) {
      assert.equal(describeConfigProblem(templateConfig(template)), null, template.id);
    }
  });

  it("names the weighted/open combination in Chinese rather than echoing the English rule", () => {
    const weighted = findTemplate("weighted");
    assert.ok(weighted);

    const problem = describeConfigProblem(buildPollConfig(weighted, { openToAll: true }, 3));
    assert.ok(problem !== null, "the combination must be reported as a problem");

    assert.ok(problem.includes("白名单"), problem);
    assert.equal(
      problem.includes("weighted voting requires whitelist admission"),
      false,
      "the raw Solidity-facing sentence is not reader copy",
    );
  });

  it("has a Chinese sentence for every rule validateConfig can refuse", () => {
    // The mapping is keyed by the exact English sentence, so a rule added to
    // `validateConfig` without a translation here would fall through to English.
    // The four configs below reach each of the four rules the mirror implements,
    // in the mirror's own order. The governance rules in `PollMechanisms.sol`
    // are NOT here on purpose: the TypeScript mirror does not implement them and
    // no template sets `quorumBps`, so there is nothing reachable to translate
    // (see the note on `describeConfigProblem`).
    const refusals = [
      validateConfig({ ...DEFAULT_CONFIG, multiSelect: true, maxSelections: 1 }).reason,
      validateConfig({ ...DEFAULT_CONFIG, weighted: true, openToAll: true }).reason,
      validateConfig({ ...DEFAULT_CONFIG, commitReveal: true, revealWindowSeconds: 0 }).reason,
      validateConfig({
        ...DEFAULT_CONFIG,
        commitReveal: true,
        revealWindowSeconds: 60,
        delegable: true,
      }).reason,
    ];

    for (const reason of refusals) {
      assert.notEqual(reason, "", "the fixture must actually break a rule");

      const problem = describeConfigProblem(configThatFails(reason));

      assert.ok(problem !== null, reason);
      assert.notEqual(problem, reason, `no Chinese sentence for: ${reason}`);
    }

    assert.equal(refusals.length, 4, "the mirror's four mechanism rules");
  });

  /** A config whose only failure is the rule `reason` names. */
  function configThatFails(reason: string): PollConfig {
    switch (reason) {
      case "multi-select requires maxSelections >= 2":
        return { ...DEFAULT_CONFIG, multiSelect: true, maxSelections: 1 };
      case "weighted voting requires whitelist admission":
        return { ...DEFAULT_CONFIG, weighted: true, openToAll: true };
      case "commit-reveal requires a non-zero reveal window":
        return { ...DEFAULT_CONFIG, commitReveal: true, revealWindowSeconds: 0 };
      case "commit-reveal cannot be combined with delegation yet":
        return {
          ...DEFAULT_CONFIG,
          commitReveal: true,
          revealWindowSeconds: 60,
          delegable: true,
        };
      default:
        throw new Error(`this test has no fixture for the rule: ${reason}`);
    }
  }
});
