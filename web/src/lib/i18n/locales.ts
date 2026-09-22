// SPDX-License-Identifier: MIT
/**
 * Which languages this app speaks, and where that choice is kept.
 *
 * ---------------------------------------------------------------------------
 * Why the choice lives in a cookie rather than only in localStorage
 * ---------------------------------------------------------------------------
 *
 * Most of this app renders on the server: the poll list, a poll's rules, the
 * audit feed. A language kept only in `localStorage` is invisible to the server,
 * so the first paint would always be the default language and then swap — a
 * flash of the wrong language on every navigation, and `<html lang>` wrong for
 * anything that reads the markup without running scripts (screen readers, search
 * engines, the browser's own font and hyphenation choices).
 *
 * A cookie is sent with the request, so the server renders the right language on
 * the first try and `<html lang>` is correct in the HTML that leaves the server.
 * `localStorage` is still written alongside it, because the switcher needs to
 * read the current choice synchronously on the client and a cookie read is not
 * synchronous in the browser.
 *
 * ---------------------------------------------------------------------------
 * Why the default is Chinese and must stay Chinese
 * ---------------------------------------------------------------------------
 *
 * Every existing test that asserts user-visible copy asserts the Chinese wording,
 * and the browser drill (`ui:drill`) does the same against a live deployment.
 * Changing the default would not be an i18n change — it would be a silent
 * rewrite of what the app says, with the test suite as the only witness. English
 * is therefore something a reader chooses; it is never something that happens to
 * them.
 */

/** The languages with a complete catalogue. */
export const LOCALES = ["zh", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * The language used when nothing has been chosen.
 *
 * Named rather than inlined because three separate places need it — the server
 * cookie reader, the client provider and the balloting module defaults — and a
 * second literal `"zh"` is exactly the kind of duplicated derived value that
 * drifts.
 */
export const DEFAULT_LOCALE: Locale = "zh";

/** The cookie the server reads. Prefixed so it is obviously this app's. */
export const LOCALE_COOKIE = "voting_locale";

/** The `localStorage` key the client reads. */
export const LOCALE_STORAGE_KEY = "voting.locale";

/** True when `value` names a language with a catalogue. */
export function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (LOCALES as readonly string[]).includes(value);
}

/**
 * The language to use for a request or a page load.
 *
 * A recognised preference wins; anything else falls back to the default rather
 * than throwing. That is a deliberate asymmetry with the other parsers in this
 * codebase (an unknown `?sort=` is a 400): a bad sort is a CALLER mistake worth
 * naming, while a stale or hand-edited language cookie is a READER state that the
 * next click repairs. Refusing to render a page over it would be punishing the
 * reader for the app's own stale cookie.
 */
export function resolveLocale(preference: string | null | undefined): Locale {
  return isLocale(preference) ? preference : DEFAULT_LOCALE;
}

/** The `<html lang>` value for a language. */
export function htmlLang(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en";
}

/**
 * Reads the language out of a `Cookie` header.
 *
 * Parsed here rather than with `next/headers` so it is a pure function that can
 * be tested without a request. The server helper wraps this.
 *
 * The value is decoded because a cookie may arrive percent-encoded, and matched
 * on the NAME only — a cookie called `voting_locale_backup` must not be mistaken
 * for `voting_locale` (which a `includes` or `startsWith` check would do).
 */
export function localeFromCookieHeader(header: string | null | undefined): Locale {
  if (header === null || header === undefined || header === "") {
    return DEFAULT_LOCALE;
  }

  for (const part of header.split(";")) {
    const equals = part.indexOf("=");

    if (equals === -1) continue;

    const name = part.slice(0, equals).trim();

    if (name !== LOCALE_COOKIE) continue;

    const raw = part.slice(equals + 1).trim();

    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is not worth failing a page render over; the
      // raw value is compared instead and almost certainly falls back.
      value = raw;
    }

    return resolveLocale(value);
  }

  return DEFAULT_LOCALE;
}
