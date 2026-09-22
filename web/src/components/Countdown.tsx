"use client";

import { useEffect, useState } from "react";

import { useTranslator } from "@/components/LocaleProvider";
import { translatorFor, type Translator } from "@/lib/i18n";
import { isPastDeadline } from "@/lib/voting";

const SECOND = 1000;
const MINUTE = 60n;
const HOUR = 60n * MINUTE;
const DAY = 24n * HOUR;

/**
 * How long is left until a poll closes, or that it has closed.
 *
 * Client-only, and that is the point. The remaining time depends on the current
 * instant, so rendering it during server rendering produces two different
 * answers for the same request — the server's clock at render time and the
 * browser's at hydration — which is a hydration mismatch and, worse, a number
 * the reader acts on. `useEffect` keeps the server output and the first client
 * render identical (both say 读取中…), and only then does the clock start.
 *
 * `now` is re-read on a one-second interval rather than computed once: a page
 * left open on a countdown that never moves is a page that lies about the one
 * thing it is counting down to. `isPastDeadline` is used for the verdict so the
 * "has the deadline passed" rule lives in exactly one place — the same function
 * the ballot uses to decide whether to offer a vote button at all.
 */
export function Countdown({ endsAt }: { endsAt: bigint }) {
  const translator = useTranslator();
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null);

  useEffect(() => {
    const tick = () => setNowSeconds(BigInt(Math.floor(Date.now() / SECOND)));

    tick();
    const handle = setInterval(tick, SECOND);

    return () => clearInterval(handle);
  }, []);

  const absolute = new Date(Number(endsAt) * SECOND).toLocaleString();

  if (nowSeconds === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
        <ClockMark />
        {translator.t("countdown.deadline", { time: absolute })}
      </span>
    );
  }

  if (isPastDeadline({ endsAt, nowSeconds })) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600">
        <ClockMark />
        {translator.t("countdown.closedAt", { time: absolute })}
      </span>
    );
  }

  /*
    Urgency, shown only in the last day.
    A deadline three weeks away and one nine minutes away are not the same
    situation, and a reader deciding whether to vote now is asking exactly which
    one this is. The threshold is one day rather than a raw "soon" because a day
    is a unit the reader already reasons in — the countdown itself switches to
    hours below that, so the colour and the text change together.
  */
  const soon = endsAt - nowSeconds < DAY;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
        soon ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-500"
      }`}
    >
      <ClockMark />
      {translator.t("countdown.remaining", {
        remaining: remaining(endsAt - nowSeconds, translator),
        absolute,
      })}
    </span>
  );
}

/**
 * A small clock, drawn inline.
 *
 * `aria-hidden` for the same reason the shield is: the text beside it already
 * says everything it depicts, so announcing it would only add noise.
 */
function ClockMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0 opacity-70"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/**
 * A duration as whole days/hours/minutes, largest unit first.
 *
 * Two units, not three: "3 天 4 小时" is a duration a reader can hold, while
 * "3 天 4 小时 17 分" reads as spurious precision on a deadline days away. Under
 * a minute it says 不到一分钟 rather than 0 分钟, which would look like it had
 * already passed.
 *
 * The translator is a parameter rather than a hook call, because this is a pure
 * function with an exported name — a hook here would make a module-level call
 * impossible, and the units are part of the copy, not of the arithmetic.
 * `translatorFor()` (the default) keeps it callable without a provider, which is
 * what the no-argument call sites from before this took rely on.
 */
export function remaining(seconds: bigint, translator: Translator = translatorFor()): string {
  if (seconds < MINUTE) {
    return translator.t("countdown.lessThanMinute");
  }

  const days = seconds / DAY;
  const hours = (seconds % DAY) / HOUR;
  const minutes = (seconds % HOUR) / MINUTE;

  if (days > 0n) {
    // `interpolate` accepts `string | number` only — a bigint is deliberately not
    // accepted (see `i18n/index.ts`), so the unit counts are stringified here.
    return translator.t("countdown.daysHours", { days: days.toString(), hours: hours.toString() });
  }

  return hours > 0n
    ? translator.t("countdown.hoursMinutes", {
        hours: hours.toString(),
        minutes: minutes.toString(),
      })
    : translator.t("countdown.minutes", { minutes: minutes.toString() });
}
