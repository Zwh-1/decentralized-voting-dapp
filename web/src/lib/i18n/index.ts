// SPDX-License-Identifier: MIT
/**
 * The translator: one function, one language, no framework.
 *
 * ---------------------------------------------------------------------------
 * Why there is no i18n library here
 * ---------------------------------------------------------------------------
 *
 * This app has two languages, a few hundred strings and no plurals worth the name
 * (Chinese has none, and the English sentences are written to avoid `1 votes`).
 * A library would add a runtime, a message-file format, a build step and a
 * provider hierarchy to solve problems this app does not have. What it does have
 * is one rule that matters: the strings and the code that chooses between them
 * must not be able to drift apart. A typed object does that at compile time and
 * costs nothing at runtime.
 *
 * ---------------------------------------------------------------------------
 * Why an unfilled placeholder stays visible
 * ---------------------------------------------------------------------------
 *
 * `interpolate("{a} of {b}", { a: "1" })` returns `"1 of {b}"` — the missing
 * placeholder is LEFT IN, not replaced with an empty string and not thrown.
 *
 * Both alternatives are worse here. Blanking produces "1 of ", a sentence that
 * looks finished and is wrong, and the reader has no way to tell that something
 * was dropped — the failure mode ADR-0011 exists to prevent, one layer up.
 * Throwing takes down a whole page over one missing parameter, and the page is
 * about someone's money.
 *
 * A visible `{b}` is self-describing: it is obviously a bug, it names exactly
 * which parameter is missing, and it reaches whoever is looking at the screen.
 * `i18n.test.ts` pins this behaviour so it cannot be "tidied up" later.
 */

import { DEFAULT_LOCALE, type Locale } from "./locales";
import { EN_BALLOT_PHRASES, ZH_BALLOT_PHRASES, type BallotPhrases } from "./ballot-phrases";
import { EN_MESSAGES, ZH_MESSAGES, type Messages } from "./messages";

/** The values a `{placeholder}` can be replaced with. */
export type InterpolationValues = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Replaces every `{name}` that has a value, and leaves the rest untouched.
 *
 * Numbers are stringified with `String()`. Bigints are NOT accepted: a wei amount
 * rendered through here would need a formatter, and silently printing 18 digits is
 * how a reader ends up reading the wrong figure. Callers format first.
 */
export function interpolate(template: string, values?: InterpolationValues): string {
  if (values === undefined) {
    return template;
  }

  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];

    // `Object.hasOwn` rather than a truthiness test: a caller that deliberately
    // passes 0 or an empty string means it, and `{count}` with 0 must render "0"
    // rather than being treated as missing.
    return Object.hasOwn(values, name) && value !== undefined ? String(value) : whole;
  });
}

/** Everything a component needs to render in one language. */
export interface Translator {
  locale: Locale;
  /** A message from the catalogue, with placeholders filled. */
  t: (key: keyof Messages, values?: InterpolationValues) => string;
  /** The ballot's rule sentences. */
  ballot: BallotPhrases;
  /** Same as `t`, for a phrase rather than a catalogue key. */
  phrase: (template: string, values?: InterpolationValues) => string;
}

/** The catalogue for one language. */
export function messagesFor(locale: Locale): Messages {
  return locale === "en" ? EN_MESSAGES : ZH_MESSAGES;
}

/** The ballot phrases for one language. */
export function ballotPhrasesFor(locale: Locale): BallotPhrases {
  return locale === "en" ? EN_BALLOT_PHRASES : ZH_BALLOT_PHRASES;
}

/**
 * Builds a translator.
 *
 * The default is `DEFAULT_LOCALE`, so every existing call site that does not care
 * about language keeps producing exactly the Chinese it produced before. That is
 * what makes this change additive: nothing had to be rewritten to keep working,
 * and the English path is exercised only where a reader asked for it.
 */
export function translatorFor(locale: Locale = DEFAULT_LOCALE): Translator {
  const catalogue = messagesFor(locale);

  return {
    locale,
    t: (key, values) => {
      const template = catalogue[key];

      // `Messages` is a total map, so this is unreachable through the type
      // system. It exists because the key can still arrive from untyped code —
      // and a missing key must be visible, not blank, for the same reason a
      // missing placeholder must be.
      if (typeof template !== "string") {
        return `!${String(key)}!`;
      }

      return interpolate(template, values);
    },
    ballot: ballotPhrasesFor(locale),
    phrase: (template, values) => interpolate(template, values),
  };
}

export {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_STORAGE_KEY,
  LOCALES,
  htmlLang,
  isLocale,
  resolveLocale,
} from "./locales";
export type { Locale } from "./locales";
export { EN_BALLOT_PHRASES, ZH_BALLOT_PHRASES, type BallotPhrases } from "./ballot-phrases";
export { EN_MESSAGES, ZH_MESSAGES, type MessageKey, type Messages } from "./messages";
