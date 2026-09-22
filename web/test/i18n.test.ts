// SPDX-License-Identifier: MIT
/**
 * Tests for the i18n core.
 *
 * The rules worth pinning are the two that decide what a reader sees when
 * something is wrong: a missing placeholder must stay VISIBLE, and a missing
 * translation must not be renderable at all. Both are the same principle this
 * project applies to every other read — never present "I could not produce this"
 * as "here it is, empty" (ADR-0011).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EN_MESSAGES,
  ZH_MESSAGES,
  ballotPhrasesFor,
  interpolate,
  messagesFor,
  translatorFor,
} from "../src/lib/i18n";
import {
  DEFAULT_LOCALE,
  LOCALES,
  htmlLang,
  isLocale,
  localeFromCookieHeader,
  resolveLocale,
} from "../src/lib/i18n/locales";
import { EN_BALLOT_PHRASES, ZH_BALLOT_PHRASES } from "../src/lib/i18n/ballot-phrases";

describe("interpolate", () => {
  it("fills every placeholder it has a value for", () => {
    assert.equal(interpolate("{a} and {b}", { a: "1", b: "2" }), "1 and 2");
  });

  it("LEAVES an unfilled placeholder visible rather than blanking it", () => {
    // The rule this function exists for. Blanking would produce "1 and ", a
    // sentence that looks finished, is wrong, and gives the reader no way to
    // notice something was dropped.
    assert.equal(interpolate("{a} and {b}", { a: "1" }), "1 and {b}");
  });

  it("leaves everything alone when no values are given", () => {
    assert.equal(interpolate("{a} and {b}"), "{a} and {b}");
  });

  it("renders an explicit zero rather than treating it as missing", () => {
    // `0` is a value a caller may mean, and `{count}` with 0 must say "0".
    // A truthiness check here would leave `{count}` on screen instead.
    assert.equal(interpolate("count {count}", { count: 0 }), "count 0");
  });

  it("renders an explicit empty string rather than leaving the placeholder", () => {
    assert.equal(interpolate("x{value}y", { value: "" }), "xy");
  });

  it("replaces a repeated placeholder every time", () => {
    assert.equal(interpolate("{a}/{a}", { a: "z" }), "z/z");
  });

  it("ignores placeholders whose name is not a plain word", () => {
    // `{a-b}` is not a placeholder this syntax can express, so it is left as
    // written rather than half-substituted.
    assert.equal(interpolate("{a-b} {c}", { c: "1" }), "{a-b} 1");
  });

  it("does not treat a replacement value as a template", () => {
    // A value containing braces must not be re-scanned, or a poll question with
    // `{question}` in it would consume an unrelated parameter.
    assert.equal(interpolate("{a}", { a: "{b}", b: "no" }), "{b}");
  });
});

describe("locale parsing", () => {
  it("defaults to Chinese", () => {
    assert.equal(DEFAULT_LOCALE, "zh");
    assert.equal(resolveLocale(null), "zh");
    assert.equal(resolveLocale(undefined), "zh");
    assert.equal(resolveLocale(""), "zh");
  });

  it("accepts every language with a catalogue", () => {
    for (const locale of LOCALES) {
      assert.equal(isLocale(locale), true, locale);
      assert.equal(resolveLocale(locale), locale);
    }
  });

  it("falls back rather than throwing on an unrecognised language", () => {
    // Deliberately unlike the `?sort=` parser, which refuses. A bad language is a
    // READER state that the next click repairs, not a caller mistake worth
    // failing a page render over.
    assert.equal(resolveLocale("fr"), "zh");
    assert.equal(resolveLocale("zh-CN"), "zh", "a region tag is not a catalogue key");
    assert.equal(isLocale("ZH"), false, "case is part of the key");
  });

  it("maps each language to an html lang tag", () => {
    assert.equal(htmlLang("zh"), "zh-CN");
    assert.equal(htmlLang("en"), "en");
  });
});

describe("localeFromCookieHeader", () => {
  it("reads the language out of a cookie header", () => {
    assert.equal(localeFromCookieHeader("voting_locale=en"), "en");
  });

  it("finds it among other cookies", () => {
    assert.equal(localeFromCookieHeader("a=1; voting_locale=en; b=2"), "en");
  });

  it("defaults when the cookie is absent", () => {
    assert.equal(localeFromCookieHeader("a=1; b=2"), "zh");
    assert.equal(localeFromCookieHeader(null), "zh");
    assert.equal(localeFromCookieHeader(""), "zh");
  });

  it("matches the name EXACTLY, not as a prefix", () => {
    // A `startsWith` or `includes` check would let a cookie called
    // `voting_locale_backup` decide the language.
    assert.equal(localeFromCookieHeader("voting_locale_backup=en"), "zh");
    assert.equal(localeFromCookieHeader("x_voting_locale=en"), "zh");
  });

  it("decodes a percent-encoded value", () => {
    assert.equal(localeFromCookieHeader("voting_locale=e%6E"), "en");
  });

  it("ignores a value it does not recognise instead of failing the render", () => {
    assert.equal(localeFromCookieHeader("voting_locale=fr"), "zh");
  });

  it("survives a malformed percent-escape", () => {
    // `decodeURIComponent("%E0%A4%A")` throws. A page render must not.
    assert.equal(localeFromCookieHeader("voting_locale=%E0%A4%A"), "zh");
  });

  it("ignores a segment with no equals sign", () => {
    assert.equal(localeFromCookieHeader("garbage; voting_locale=en"), "en");
  });

  it("tolerates whitespace around the name and value", () => {
    assert.equal(localeFromCookieHeader("  voting_locale = en  "), "en");
  });
});

describe("the catalogue", () => {
  it("answers every key in both languages", () => {
    // The compile-time guarantee is that `EN_MESSAGES satisfies Messages`. This
    // checks the runtime consequence: no key renders as empty or undefined.
    for (const key of Object.keys(ZH_MESSAGES) as (keyof typeof ZH_MESSAGES)[]) {
      assert.equal(typeof ZH_MESSAGES[key], "string", `zh ${key}`);
      assert.equal(typeof EN_MESSAGES[key], "string", `en ${key}`);
      assert.notEqual(ZH_MESSAGES[key].trim(), "", `zh ${key} is blank`);
      assert.notEqual(EN_MESSAGES[key].trim(), "", `en ${key} is blank`);
    }
  });

  it("has the same key set in both languages", () => {
    assert.deepEqual(Object.keys(EN_MESSAGES).sort(), Object.keys(ZH_MESSAGES).sort());
  });

  it("returns the requested language", () => {
    assert.equal(messagesFor("en")["nav.polls"], "All polls");
    assert.equal(messagesFor("zh")["nav.polls"], "全部投票");
  });
});

describe("translatorFor", () => {
  it("translates a key in the requested language", () => {
    assert.equal(translatorFor("zh").t("nav.polls"), "全部投票");
    assert.equal(translatorFor("en").t("nav.polls"), "All polls");
  });

  it("defaults to Chinese, so existing call sites did not have to change", () => {
    assert.equal(translatorFor().locale, "zh");
    assert.equal(translatorFor().t("nav.polls"), "全部投票");
  });

  it("fills placeholders in a message", () => {
    assert.equal(translatorFor("en").t("common.pageOf", { page: 2, pageCount: 5 }), "Page 2 of 5");
  });

  it("exposes the ballot phrases for the same language", () => {
    assert.equal(translatorFor("en").ballot, EN_BALLOT_PHRASES);
    assert.equal(translatorFor("zh").ballot, ZH_BALLOT_PHRASES);
  });

  it("reports the language it was built for", () => {
    assert.equal(translatorFor("en").locale, "en");
  });
});

describe("the ballot phrase catalogue", () => {
  it("answers every phrase in both languages", () => {
    const keys = Object.keys(ZH_BALLOT_PHRASES) as (keyof typeof ZH_BALLOT_PHRASES)[];

    assert.ok(keys.length > 20, "the ballot has a large copy surface");

    for (const key of keys) {
      assert.equal(typeof ZH_BALLOT_PHRASES[key], "string", `zh ${key}`);
      assert.equal(typeof EN_BALLOT_PHRASES[key], "string", `en ${key}`);
      assert.notEqual(ZH_BALLOT_PHRASES[key].trim(), "", `zh ${key} is blank`);
      assert.notEqual(EN_BALLOT_PHRASES[key].trim(), "", `en ${key} is blank`);
    }
  });

  it("has the same phrase set in both languages", () => {
    assert.deepEqual(Object.keys(EN_BALLOT_PHRASES).sort(), Object.keys(ZH_BALLOT_PHRASES).sort());
  });

  it("never repeats the same sentence under two different names", () => {
    // Two names for one sentence is the duplicated-derivation pattern this repo
    // has been burned by: the day one is edited, the two promises diverge. The
    // one exception is deliberate and is listed here.
    const allowed = new Set<string>();

    for (const [name, text] of Object.entries(ZH_BALLOT_PHRASES)) {
      if (allowed.has(name)) continue;

      const twins = Object.entries(ZH_BALLOT_PHRASES)
        .filter(([other, value]) => other !== name && value === text)
        .map(([other]) => other);

      assert.deepEqual(twins, [], `${name} duplicates the text of ${twins.join(", ")}`);
    }
  });

  it("uses the documented placeholders and no others", () => {
    // `interpolate` leaves unknown placeholders visible, so a typo inside a
    // template would reach the reader as literal braces. Checking the set here
    // turns that into a test failure.
    for (const [name, text] of Object.entries(ZH_BALLOT_PHRASES)) {
      const found = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);

      if (name === "wrongNetwork") {
        assert.deepEqual(found.sort(), ["chainId", "chainName", "suffix"], name);
        continue;
      }

      assert.deepEqual(found, [], `${name} has unexpected placeholders`);
    }
  });

  it("answers the same placeholder names in English as in Chinese", () => {
    for (const [name, text] of Object.entries(EN_BALLOT_PHRASES)) {
      const zhFound = [
        ...ZH_BALLOT_PHRASES[name as keyof typeof ZH_BALLOT_PHRASES].matchAll(/\{(\w+)\}/g),
      ]
        .map((match) => match[1])
        .sort();
      const enFound = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

      assert.deepEqual(enFound, zhFound, name);
    }
  });
});

describe("ballotPhrasesFor", () => {
  it("returns the catalogue for the language", () => {
    assert.equal(ballotPhrasesFor("en"), EN_BALLOT_PHRASES);
    assert.equal(ballotPhrasesFor("zh"), ZH_BALLOT_PHRASES);
  });
});
