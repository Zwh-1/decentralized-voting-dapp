"use client";

import { LOCALES, type Locale } from "@/lib/i18n";
import { useLocale } from "@/components/LocaleProvider";

/**
 * The language switcher.
 *
 * ---------------------------------------------------------------------------
 * Why links-in-a-nav rather than a dropdown or a select
 * ---------------------------------------------------------------------------
 *
 * Two languages means the whole control is two targets, and a dropdown would hide
 * one of them behind a click while adding a popover that has to be dismissed,
 * focused and trapped. Two buttons show the reader every option at once and cost
 * one tap.
 *
 * ---------------------------------------------------------------------------
 * Why the hit area is 44px
 * ---------------------------------------------------------------------------
 *
 * 44 CSS pixels is the smallest target a finger reliably hits (Apple's HIG says
 * 44pt, Android's Material says 48dp). The visible pill is smaller than that on
 * purpose — a row of 44px-tall pills would dominate the header — so the padding
 * carries the touch area while the border and background stay compact.
 *
 * `aria-current` marks the active language rather than a colour alone, so the
 * state is available to a screen reader and not only to sighted readers.
 */
export function LanguageSwitcher() {
  const { locale, translator, setLocale } = useLocale();

  return (
    <nav
      className="flex items-center gap-1"
      aria-label={translator.t("language.label")}
      data-language-switcher
    >
      {LOCALES.map((candidate: Locale) => {
        const active = candidate === locale;
        const label = translator.t(candidate === "zh" ? "language.zh" : "language.en");

        return (
          <button
            key={candidate}
            type="button"
            onClick={() => setLocale(candidate)}
            aria-current={active ? "true" : undefined}
            // The visible text is already the language's own name, so the
            // accessible name says what the button DOES rather than repeating the
            // label — "Switch to English" is the action, "English" is the state.
            aria-label={translator.t("language.switchTo", { language: label })}
            data-language-option={candidate}
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg px-2 text-xs ${
              active ? "bg-slate-900 font-medium text-white" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
