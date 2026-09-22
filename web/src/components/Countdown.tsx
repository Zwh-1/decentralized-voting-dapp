"use client";

import { useEffect, useState } from "react";

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
      <span className="text-xs text-slate-500">
        截止 <span className="tabular-nums">{absolute}</span>
      </span>
    );
  }

  if (isPastDeadline({ endsAt, nowSeconds })) {
    return (
      <span className="text-xs text-slate-500">
        已于 <span className="tabular-nums">{absolute}</span> 截止（已关闭）
      </span>
    );
  }

  return (
    <span className="text-xs text-slate-500">
      还剩 <span className="tabular-nums">{remaining(endsAt - nowSeconds)}</span>
      <span className="text-slate-400">（截止 {absolute}）</span>
    </span>
  );
}

/**
 * A duration as whole days/hours/minutes, largest unit first.
 *
 * Two units, not three: "3 天 4 小时" is a duration a reader can hold, while
 * "3 天 4 小时 17 分" reads as spurious precision on a deadline days away. Under
 * a minute it says 不到一分钟 rather than 0 分钟, which would look like it had
 * already passed.
 */
export function remaining(seconds: bigint): string {
  if (seconds < MINUTE) {
    return "不到 1 分钟";
  }

  const days = seconds / DAY;
  const hours = (seconds % DAY) / HOUR;
  const minutes = (seconds % HOUR) / MINUTE;

  if (days > 0n) {
    return `${days} 天 ${hours} 小时`;
  }

  return hours > 0n ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}
