"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_STORAGE_KEY,
  translatorFor,
  type Locale,
  type Translator,
} from "@/lib/i18n";

/**
 * The reader's language, for client components.
 *
 * ---------------------------------------------------------------------------
 * Why the initial value comes from the server as a prop
 * ---------------------------------------------------------------------------
 *
 * `initialLocale` is read from the cookie by the root layout. Reading it again in
 * the browser would mean the first client render could disagree with the HTML the
 * server just produced — a hydration mismatch, and in the worst case a visible
 * swap of every string on the page.
 *
 * ---------------------------------------------------------------------------
 * Why switching refreshes instead of re-rendering
 * ---------------------------------------------------------------------------
 *
 * The pages that matter here (the poll list, a poll's rules, the audit feed) are
 * SERVER components, so no amount of React state changes what they output. The
 * switcher writes the cookie and calls `router.refresh()`, which re-runs the
 * server render with the new cookie. That is what makes the choice apply to the
 * whole page rather than only to the parts that happen to be client-side.
 *
 * The `localStorage` write is not redundant: it is the copy the client reads, and
 * it survives a cookie being cleared.
 */
interface LocaleContextValue {
  locale: Locale;
  translator: Translator;
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  translator: translatorFor(DEFAULT_LOCALE),
  setLocale: () => {},
});

export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);

      // `max-age` of a year, `path=/` so every route sees it, and `SameSite=Lax`
      // so it travels on ordinary navigations. Not `HttpOnly`: the client provider
      // is the thing that reads it back.
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; path=/; max-age=31536000; SameSite=Lax`;

      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // Private-browsing and storage-disabled modes throw here. The cookie is
        // already written and is the copy that decides what renders, so a failed
        // mirror is not worth surfacing or failing the switch over.
      }

      router.refresh();
    },
    [router],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, translator: translatorFor(locale), setLocale }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** The active translator. */
export function useTranslator(): Translator {
  return useContext(LocaleContext).translator;
}

/** The active language and how to change it. */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
