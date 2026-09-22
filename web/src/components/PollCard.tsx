"use client";

import Link from "next/link";

import { Countdown } from "@/components/Countdown";
import { useTranslator } from "@/components/LocaleProvider";
import { Badge, Card, ShareBar, Skeleton, Stat } from "@/components/ui";
import { useMounted } from "@/hooks/useMounted";
import { usePollSummary } from "@/hooks/usePollSummary";
import { accentClass, badgeClass, phaseTone, sharePercent } from "@/lib/presentation";
import type { Translator } from "@/lib/i18n";
import { PollPhase, STAKE, formatEth, isPastDeadline, shortenAddress } from "@/lib/voting";
import type { PollSummary } from "@/lib/types";

/**
 * One poll, as the list page shows it.
 *
 * The card is a client component because it re-reads itself: a list is exactly
 * where a stale tally is most visible, since a reader comparing two cards is
 * comparing the two numbers. The question, the creator and the deadline cannot
 * change after `createPoll` — they are written once by `initialize` — so only the
 * tally genuinely needs refreshing, and the whole summary is refetched because it
 * arrives in one round trip anyway.
 *
 * `initial` is the server's own read. It is used only until the first client read
 * lands, so the list does not blink empty between SSR and the browser's first
 * `eth_call`, and it is never preferred over a completed client read: the chain,
 * asked directly by the reader's own browser, is the more current of the two.
 */
export function PollCard({
  address,
  initial,
  chainId,
}: {
  address: `0x${string}`;
  /** The server's read, or null when it failed. */
  initial: PollSummary | null;
  /** The chain the page resolved, or undefined when it has no usable one. */
  chainId: number | undefined;
}) {
  const translator = useTranslator();
  const mounted = useMounted();
  const query = usePollSummary({ chainId, address, enabled: chainId !== undefined });

  // `mounted` gates the client read's *result* rather than its execution: the
  // hook runs on the server render too, and a server-rendered card that showed
  // the query's state would disagree with the browser's first render. Before
  // mount the card prints the server's answer, which is the one both sides agree
  // on.
  const summary = mounted ? (query.data ?? initial) : initial;

  if (summary === null) {
    return (
      <BrokenCard address={address} retryHint={mounted && query.isError} translator={translator} />
    );
  }

  // A poll past `endsAt` is already unvotable — `vote` reverts — but it stays in
  // phase Voting until somebody calls the permissionless `closeAfterDeadline()`.
  // The full three-way distinction (setup / live / past-due-but-not-ended / ended)
  // is owned by `phaseTone`, so the card and the detail page cannot disagree
  // about what a given chain state is called.
  const { label, tone, votable } = phaseTone(
    summary.phase,
    isPastDeadline({
      endsAt: BigInt(summary.endsAt),
      nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    }),
  );

  return (
    <Card
      as="article"
      className={`flex flex-col p-5 transition hover:border-slate-300 hover:shadow ${accentClass(tone)}`}
    >
      <header className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-semibold leading-snug text-slate-900">
          {summary.question}
        </h3>
        {/* `data-phase` is what the drill reads to check the badge against the
            chain, so it travels with the badge rather than with the text. */}
        <Badge className={badgeClass(tone)}>
          <span data-phase={summary.phase}>{label}</span>
        </Badge>
      </header>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
        <span>
          {translator.t("poll.creatorInline")}{" "}
          <span className="font-mono text-slate-500" title={summary.creator}>
            {shortenAddress(summary.creator)}
          </span>
        </span>
        {mounted && query.isFetching && (
          <span className="inline-flex items-center gap-1 text-slate-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-300" />
            {translator.t("common.refreshingShort")}
          </span>
        )}
      </p>

      {/*
        The participation bar. It turns the three numbers below into one
        glanceable fact — how much of the electorate has actually voted — which
        is the thing a reader deciding whether to bother voting wants to know,
        and which a bare total of 3 cannot tell them.
      */}
      {summary.optionCount > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-slate-500">
              {translator.t("poll.votedSoFar", { count: summary.totalVotes })}
            </span>
            <span className="tabular-nums text-slate-400">
              {translator.t("poll.optionCount", { count: summary.optionCount })}
            </span>
          </div>
          <div className="mt-1.5">
            <ShareBar
              percent={sharePercent(summary.totalVotes, Math.max(summary.totalVotes, 1))}
              tone="mine"
            />
          </div>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label={translator.t("poll.statOptionCount")} value={String(summary.optionCount)} />
        <Stat label={translator.t("poll.statTotalVotes")} value={String(summary.totalVotes)} />
        <Stat
          label={translator.t("poll.statStake")}
          value={`${formatEth(STAKE)} ETH`}
          hint={votable ? translator.t("poll.stakeRefundable") : undefined}
        />
      </dl>

      <div className="mt-3">
        <Countdown endsAt={BigInt(summary.endsAt)} />
      </div>

      <footer className="mt-4 flex justify-end border-t border-slate-100 pt-3">
        <Link
          href={`/poll/${address}`}
          className={`rounded-lg px-3.5 py-2 text-xs font-medium transition ${
            votable
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-slate-900 text-white hover:bg-slate-700"
          }`}
        >
          {/* The label states what is behind the link. A reader scanning for
              somewhere to vote should not have to open every card to find one. */}
          {votable ? translator.t("poll.goVote") : translator.t("poll.viewDetail")}
        </Link>
      </footer>
    </Card>
  );
}

/**
 * The card for a poll whose details could not be read.
 *
 * A distinct surface rather than a grey placeholder, because the situation is
 * genuinely different from every other empty state here: the poll is KNOWN to
 * exist — its address came from the factory's own `allPolls()` — so the failure
 * is in reading it, not in finding it. Saying so, and keeping the link, stops the
 * reader from concluding the poll was deleted.
 */
function BrokenCard({
  address,
  retryHint,
  translator,
}: {
  address: `0x${string}`;
  retryHint: boolean;
  translator: Translator;
}) {
  return (
    <Card as="article" className="border-rose-200 bg-rose-50/60 p-5">
      <h3 className="flex items-center gap-2 text-sm font-medium text-rose-800">
        <span className="h-2 w-2 rounded-full bg-rose-400" />
        {translator.t("poll.cardReadFailed")}
      </h3>
      <p className="mt-2 break-all font-mono text-[11px] text-rose-700">{address}</p>
      <p className="mt-2 text-xs leading-relaxed text-rose-700">
        {translator.t("poll.cardReadFailedDetail", { call: "allPolls()" })}
        {retryHint
          ? translator.t("poll.retryAfterNetworkCheck")
          : translator.t("poll.retryAfterRpcCheck")}
      </p>
      <Link
        href={`/poll/${address}`}
        className="mt-3 inline-block rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 transition hover:bg-rose-100"
      >
        {translator.t("poll.stillOpen")}
      </Link>
    </Card>
  );
}

/** A placeholder card, sized like a real one so the list does not jump. */
export function PollCardSkeleton() {
  return (
    <Card as="article" className="border-l-4 border-l-slate-200 p-5">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-5 w-3/5" />
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-3 w-32" />
      <div className="mt-4 flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="mt-1.5 h-1.5 w-full rounded-full" />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Skeleton className="h-14 rounded-lg" />
        <Skeleton className="h-14 rounded-lg" />
        <Skeleton className="h-14 rounded-lg" />
      </div>
      <div className="mt-4 flex justify-end border-t border-slate-100 pt-3">
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
    </Card>
  );
}
