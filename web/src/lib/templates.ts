// SPDX-License-Identifier: MIT
/**
 * The pre-set poll shapes offered when creating a poll.
 *
 * ---------------------------------------------------------------------------
 * Why the configs are DERIVED rather than listed
 * ---------------------------------------------------------------------------
 *
 * Every field of a `PollConfig` has one owner: `mechanisms.ts`, the mirror of
 * `PollMechanisms.sol`. A template that restated the nine fields would be a
 * second copy of that shape, and the two would drift the first time the contract
 * gained a tenth — with the failure landing on a reader whose transaction reverts
 * for a reason the UI never mentioned. This repository has already paid for that
 * mistake three times (`ADR-0031`), so the rule batch 4 works under is: derive,
 * never restate.
 *
 * A template here therefore states only its NAME, its description, and the
 * fields it actually differs in. Everything else comes from `DEFAULT_CONFIG` by
 * spread, so a new field is automatically every template's default, and
 * `templateConfig` never contains a field this file wrote out by hand.
 *
 * ---------------------------------------------------------------------------
 * Why admission is not part of a template's stored config
 * ---------------------------------------------------------------------------
 *
 * Admission (`openToAll`) affects a poll's TRUST model far more than its shape,
 * and the form owns it as a radio choice the reader makes explicitly. It is
 * still part of a `PollConfig` and still has to agree with the mechanism fields
 * (`weighted` requires the whitelist, see `validateConfig`), so a template
 * carries the admission it NEEDS as `defaultAdmission` and `templateConfig`
 * applies it to the base — one spelling, adopted rather than duplicated.
 *
 * ---------------------------------------------------------------------------
 * Why the multi-select cap is clamped to the option count
 * ---------------------------------------------------------------------------
 *
 * The contract only requires `maxSelections >= 2`; whether a cap ABOVE the
 * number of options is meaningful is not a contract rule, and a template cannot
 * know how many options the reader will type. Sending 4 for a two-option poll
 * would be a cap the poll can never reach — allowed, and confusing to read later.
 * `buildPollConfig` therefore lowers the cap to the options that exist, and never
 * raises it, so the template keeps its identity as an upper bound while the
 * calldata stays something a reader can explain.
 */

import { DEFAULT_LOCALE, interpolate, messagesFor, type Locale } from "./i18n";
import { DEFAULT_CONFIG, validateConfig, type PollConfig } from "./mechanisms";

/** How a template decides its default admission. Mirrors a `PollConfig` field. */
export interface TemplateDefaults {
  openToAll: boolean;
}

/**
 * A template's name and its explanation, in one language.
 *
 * Two fields rather than one string with a separator, because the picker styles
 * them differently: the name is the button's label and the description is the
 * prose underneath it.
 */
export interface TemplateText {
  name: string;
  description: string;
}

/**
 * A template's own wording, per language.
 *
 * ---------------------------------------------------------------------------
 * Why this is a record of literals rather than catalogue keys
 * ---------------------------------------------------------------------------
 *
 * The alternative — `t("template.multi-select.name")` — needs the message key
 * to be derivable from the template's id, and a template id is DATA: it is
 * persisted in a draft, used as a React key, and matched against what
 * `findTemplate` was given. Building a key from it would make a typo in the
 * draft storage silently address a different message, and the compiler could not
 * see it because the key would be a computed string.
 *
 * A record makes the correspondence explicit and total: `TemplateText` wants both
 * fields for every locale, so a language that has not answered one is a compile
 * error, not an empty button. `templates.test.ts` checks the same property at
 * runtime for every locale the app offers.
 *
 * Deliberately NOT `Record<Locale, ...>`: `Locale` is a union with a closed
 * member list, and indexing such a record with a `Locale` is fine — but the two
 * languages here are written out beside the template they describe on purpose, so
 * that a mechanism's explanation cannot drift away from the config it explains.
 */
const TEMPLATE_TEXT: Record<string, Record<Locale, TemplateText>> = {
  single: {
    zh: {
      name: "单选",
      description: "一个问题、一个答案，一人一票。默认所有人可投，最快能开始收集意见。",
    },
    en: {
      name: "Single choice",
      description:
        "One question, one answer, one vote each. Open to everyone by default, which is the fastest way to start collecting opinions.",
    },
  },
  "multi-select": {
    zh: {
      name: "多选",
      description: "一次可选多个选项；每张票最多选中的数量由选项数量决定，不必手填。",
    },
    en: {
      name: "Multi-select",
      description:
        "Several options can be chosen at once; the most a single ballot may select follows from the number of options, so there is nothing to fill in by hand.",
    },
  },
  weighted: {
    zh: {
      name: "加权",
      description: "按地址权重计票，适合股东或成员表决；合约要求先建白名单，因此默认仅白名单可投。",
    },
    en: {
      name: "Weighted",
      description:
        "Votes are counted by address weight, which suits a shareholder or member vote; the contract requires an allowlist first, so only allowlisted addresses may vote by default.",
    },
  },
};

/**
 * One pre-set poll shape.
 *
 * The wording is not on the object: `text(locale)` answers it, so a template
 * cannot be rendered in a language it does not carry and the picker cannot end up
 * with a name from one language and a description from another.
 */
export interface PollTemplate {
  /** Stable id, persisted in a draft and used as a React key. Never translated. */
  id: string;
  /** The fields this template differs from `DEFAULT_CONFIG` in. */
  overrides: Partial<PollConfig>;
  /** The admission the template needs for its config to be valid. */
  defaultAdmission: TemplateDefaults;
  /** This template's name and description in the reader's language. */
  text: (locale: Locale) => TemplateText;
}

/** The wording for a template id, in a language. Never returns `undefined`. */
function templateText(id: string, locale: Locale): TemplateText {
  const byLocale = TEMPLATE_TEXT[id];
  const text = byLocale?.[locale];

  // A template whose id has no entry is a programming error, not a reader state:
  // the two are built in the same file. The name falls back to the raw id, which
  // is visibly not copy, rather than to an empty button that looks deliberate.
  return text ?? { name: id, description: "" };
}

/**
 * The template the form starts from: the shape a poll has always had.
 *
 * A named constant as well as the list's first entry, because the form needs a
 * `PollTemplate` and not a `PollTemplate | undefined` — `noUncheckedIndexedAccess`
 * makes `POLL_TEMPLATES[0]` optional, and the two ways to quiet that are a non-null
 * assertion (banned here) or this constant. It is the same object the list holds.
 */
export const DEFAULT_TEMPLATE: PollTemplate = {
  id: "single",
  overrides: {},
  defaultAdmission: { openToAll: true },
  text: (locale) => templateText("single", locale),
};

/**
 * The templates, in the order the picker offers them.
 *
 * Three shapes, each one a decision the contract already supports and the form
 * would otherwise never offer: one answer, several answers, or answers of
 * different weight.
 */
export const POLL_TEMPLATES: readonly PollTemplate[] = Object.freeze([
  DEFAULT_TEMPLATE,
  {
    id: "multi-select",
    overrides: { multiSelect: true, maxSelections: 4 },
    defaultAdmission: { openToAll: true },
    text: (locale) => templateText("multi-select", locale),
  },
  {
    id: "weighted",
    overrides: { weighted: true },
    // Not a preference: `validateConfig` refuses `weighted && openToAll`, because
    // an open poll has no finite eligible set to take a weight from.
    defaultAdmission: { openToAll: false },
    text: (locale) => templateText("weighted", locale),
  },
]);

/** The template with this id, or `null` for an id this build does not know. */
export function findTemplate(id: string): PollTemplate | null {
  return POLL_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** True when `id` names a template this build offers. */
export function isTemplateId(id: string): boolean {
  return findTemplate(id) !== null;
}

/**
 * The overrides a template actually states.
 *
 * A `Partial<PollConfig>` may carry an explicit `undefined`, and spreading that
 * over `DEFAULT_CONFIG` would overwrite a real default with `undefined` — a
 * value `validateConfig` and the ABI encoder would both reject, from a field the
 * template never meant to mention. `JSON.parse` can produce exactly that, so the
 * undefined entries are dropped here rather than trusted not to exist.
 */
function definedOverrides(overrides: Partial<PollConfig>): Partial<PollConfig> {
  const kept: Partial<PollConfig> = {};

  for (const [field, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      kept[field as keyof PollConfig] = value as never;
    }
  }

  return kept;
}

/**
 * The template's configuration, complete.
 *
 * Built by spreading `DEFAULT_CONFIG` and then the template's own overrides, so
 * every field the template does not mention keeps its contract default and no
 * field is written down twice. The result is never frozen here: `buildPollConfig`
 * copies it before adjusting the cap, and the caller may keep it in state.
 */
export function templateConfig(template: PollTemplate): PollConfig {
  return {
    ...DEFAULT_CONFIG,
    ...definedOverrides(template.overrides),
    openToAll: template.defaultAdmission.openToAll,
  };
}

/**
 * The configuration to submit for a chosen template and an explicit admission.
 *
 * `admission` is applied AFTER the template's own default on purpose: the radio
 * the reader can see and change is the one that decides, so choosing the weighted
 * template and then opening the poll up does not silently persist the whitelist
 * the reader just switched away from. That combination then fails
 * `validateConfig` and the form explains it before the transaction.
 */
export function buildPollConfig(
  template: PollTemplate,
  admission: { openToAll: boolean },
  optionCount: number,
): PollConfig {
  const config = { ...templateConfig(template), openToAll: admission.openToAll };

  if (!config.multiSelect) return config;

  // Never raised: a cap larger than the choices available is a number that can
  // never be reached, and `validateConfig` requires at least 2 regardless.
  return { ...config, maxSelections: Math.max(2, Math.min(config.maxSelections, optionCount)) };
}

/**
 * The template's mechanism fields in the reader's language, for the picker.
 *
 * Written as sentences about a CONFIG, not about a template: the reader's
 * question is "what will this poll do", and a list that includes `quorumBps: 0`
 * answers a question nobody asked. It takes a config rather than a template so
 * the sentence describes the config that will actually be submitted — the
 * multi-select cap it prints is the one the options allowed, not the cap the
 * template stored. `web/test/templates.test.ts` pins the caps and the sentences
 * that must follow them.
 *
 * The five clauses are catalogue entries joined here, in one place, rather than
 * one template sentence for the whole line: the English clauses are not word-for-
 * word images of the Chinese ones, so a single sentence with placeholders would
 * have to be written to fit one grammar and would read as broken in the other.
 */
export function describeMechanisms(config: PollConfig, locale: Locale = DEFAULT_LOCALE): string {
  const messages = messagesFor(locale);
  const parts: string[] = [];

  parts.push(
    config.multiSelect
      ? interpolate(messages["mechanism.multiSelect"], { count: config.maxSelections })
      : messages["mechanism.single"],
  );
  parts.push(config.weighted ? messages["mechanism.weighted"] : messages["mechanism.oneVoteEach"]);
  parts.push(messages["mechanism.notCommitReveal"]);
  parts.push(
    config.delegable ? messages["mechanism.delegable"] : messages["mechanism.notDelegable"],
  );
  parts.push(
    config.openToAll ? messages["mechanism.openToAll"] : messages["mechanism.whitelistOnly"],
  );

  return parts.join(" · ");
}

/**
 * The `validateConfig` refusal in the reader's language, or `null` when the
 * config is fine.
 *
 * The reason strings themselves are part of `mechanisms.ts`'s contract with the
 * Solidity side and are compared verbatim by `mechanisms.test.ts`, so they are
 * NOT reworded there. This maps them for display instead, and the mapping is
 * keyed by the exact English sentence: a rule added to `validateConfig` without
 * a sentence here falls through to the English one rather than to a wrong
 * translation, which is the failure mode that leaves a reader reading a rule the
 * contract is not enforcing.
 *
 * TWO RULES ARE DELIBERATELY ABSENT, and the absence is not an oversight. The
 * Solidity side validates quorum (`PollMechanisms.validateGovernance`), but the
 * TypeScript mirror does not implement those two checks, and every config this
 * module builds keeps `quorumBps` at the contract default of 0 and never sets
 * `timelockSeconds`. Writing Chinese sentences for rules the mirror cannot report
 * would be copy for an unreachable branch — and if governance ever reaches the
 * form, the fix belongs in `mechanisms.ts` first, so that the guard and the
 * contract agree, with the two sentences arriving here with it.
 *
 * Reached in practice by choosing a template whose config conflicts with the
 * admission radio — `加权` with `所有人可投` is the one a reader can produce from
 * the visible controls.
 *
 * The mapping is per language rather than per call site: the sentence is a
 * catalogue entry, so this returns the same message `i18n.test.ts` knows about
 * and `chrome-copy.test.ts` can pin, instead of a private table inside a module.
 */
export function describeConfigProblem(
  config: PollConfig,
  locale: Locale = DEFAULT_LOCALE,
): string | null {
  const verdict = validateConfig(config);
  if (verdict.ok) return null;

  const messages = messagesFor(locale);

  const translations: Record<string, string> = {
    "multi-select requires maxSelections >= 2": messages["mechanism.problem.multiSelect"],
    "weighted voting requires whitelist admission": messages["mechanism.problem.weighted"],
    "commit-reveal requires a non-zero reveal window":
      messages["mechanism.problem.commitRevealWindow"],
    "commit-reveal cannot be combined with delegation yet":
      messages["mechanism.problem.commitRevealDelegation"],
  };

  return translations[verdict.reason] ?? verdict.reason;
}
