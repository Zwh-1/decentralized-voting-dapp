"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  useConfig,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { useTranslator } from "@/components/LocaleProvider";
import { OptionRow } from "@/components/OptionRow";
import { ResultChart } from "@/components/ResultChart";
import { Badge, Stat } from "@/components/ui";
import { useMounted } from "@/hooks/useMounted";
import {
  describeWriteFailure,
  myStatusLabels,
  phaseText,
  readStatus,
  readText,
  type ReadState,
} from "@/lib/ballot-labels";
import {
  changeReason,
  closeReason,
  refundReason,
  voteReason,
  withdrawReason,
  type BallotInputs,
} from "@/lib/ballot-reasons";
import { accentClass, badgeClass, phaseTone } from "@/lib/presentation";
import {
  chainName,
  isPastDeadline,
  PollPhase,
  resolveChainTarget,
  STAKE,
  formatEth,
  pollAbi,
  shortenAddress,
  type ChainTarget,
} from "@/lib/voting";
import type { PollSummary } from "@/lib/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Which control a write is for.
 *
 * One wallet serves the whole page, so every write shares `isPending` and every
 * control has to stay disabled while any of them is in flight — otherwise the
 * reader can queue two conflicting transactions and the second one reverts
 * (`AlreadyVoted`, `HasNotVoted`, `SameOption`). Tagging the write is what keeps
 * that from also making every button claim to be the one submitting, which is the
 * defect the old `Ballot.tsx` had: `isSubmitting` was computed once for the page,
 * so a vote for option 1 also printed 提交中… on options 2 and 3.
 */
type WriteTarget =
  | { kind: "vote"; optionId: number }
  | { kind: "change"; optionId: number }
  | { kind: "withdraw" }
  | { kind: "refund" }
  | { kind: "close" };

export interface PollBallotProps {
  /** The poll's address, from the route's `[id]` segment. */
  address: `0x${string}`;
  /** The server's read of this poll, or null when it failed. */
  initial: PollSummary | null;
  /** The chain and factory this deployment is configured for, or null. */
  configuredTarget: ChainTarget | null;
  /** Non-null when the server's own read of this poll failed. */
  initialError: string | null;
}

/**
 * The single-poll voting UI.
 *
 * Every button's availability is derived from chain state, never from whether a
 * query has finished (ADR-0009). The four states a connected address can be in
 * are distinguished, and each disabled control says which one it is in and why —
 * "the button is grey and silent" is the one outcome this panel must not produce,
 * because the stake is the reader's own money and `sweepUnclaimed()` can hand an
 * unclaimed stake to the poll's creator once the grace period passes.
 *
 *   *  1. not whitelisted            → cannot vote at all; the reason names the gate;
 *   *  2. whitelisted, not voted    → 投票 (exactly `STAKE`);
 *   *  3. voted for option X        → 改投 on every OTHER option, plus 撤票;
 *   *  4. past `endsAt`/Ended       → nothing to vote; 取回押金 when a stake remains.
 *
 * State 4 overlaps the others rather than replacing them, and deliberately so:
 * a voter who is not whitelisted and a poll that has closed are both true at once,
 * and the contract checks the phase before the whitelist. The order of the reasons
 * below follows the contract's own check order, so the sentence the reader gets is
 * the one the revert would have produced.
 */
export function PollBallot({ address, initial, configuredTarget, initialError }: PollBallotProps) {
  const { t, ballot, locale } = useTranslator();
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const config = useConfig();

  const { address: account, isConnected } = useAccount();
  const walletChainId = useChainId();

  // Which chain this page is about. The wallet's chain wins when there is one,
  // because that is where a transaction would be signed; with no wallet the
  // deployment's own chain does, because that is what the server read. See
  // ADR-0019 — two chains in one page, and the page must name the right one.
  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  // The poll is a specific contract, not a factory-derived lookup: its addresses
  // are the same on every chain, so what has to be resolved here is which chain to
  // *ask*, not which address to ask about.
  const contractKnown = targetChain !== undefined;
  const readChain = targetChain === undefined ? {} : { chainId: targetChain.id };
  const subjectChainId = target?.chainId ?? walletChainId;

  const actor = account ?? ZERO_ADDRESS;

  // ---- reads: everything the buttons depend on ----
  //
  // One `useReadContracts` rather than six `useReadContract`s, so the page can
  // tell "still reading" from "read and answered" for all of them at once and so
  // the values come from a single block. A torn read here is not cosmetic: `phase`
  // from one block with `voterState` from the next is exactly how a UI offers a
  // button the contract then rejects (ADR-0017's lesson applied to a read).
  //
  // Gated on `contractKnown`, NOT on `isConnected`. The earlier version required a
  // wallet, which meant a reader who had not connected one saw 阶段/票数/选项 all
  // stuck on 读取中… forever — the poll's own facts do not depend on who is asking.
  // `voterState` is the one read that needs an address, and with no wallet it is
  // asked about the zero address, which answers "not whitelisted, no vote, no
  // stake". That answer is discarded rather than rendered (see `voter` below), so
  // the rows say 未连接 instead of reporting the zero address's state as if it were
  // the reader's.
  const reads = useReadContracts({
    contracts: [
      { address, abi: pollAbi, functionName: "phase" },
      { address, abi: pollAbi, functionName: "endsAt" },
      { address, abi: pollAbi, functionName: "creator" },
      { address, abi: pollAbi, functionName: "results" },
      { address, abi: pollAbi, functionName: "voterState", args: [actor] },
    ],
    ...readChain,
    query: { enabled: contractKnown },
  });

  const [phaseResult, endsAtResult, creatorResult, resultsResult, voterResult] = reads.data ?? [];

  const phase = phaseResult?.result === undefined ? undefined : Number(phaseResult.result);
  const endsAt = endsAtResult?.result === undefined ? undefined : endsAtResult.result;
  const creator = creatorResult?.result;
  const results = resultsResult?.result;
  // Deliberately dropped when no wallet is connected: it describes the zero
  // address, and every "我的状态" row would otherwise render its answer as the
  // reader's own (未连接 is the truth there).
  const voter = isConnected ? voterResult?.result : undefined;

  // ---- the tally, in the one shape both the numbers and the chart read ----
  //
  // A single expression rather than two, because two would be two chances to
  // disagree: the 票数合计 stat, the per-option cards and `ResultChart` all read
  // this object, and there is no second derivation of the total or of an
  // option's count anywhere below. The shape is the app's shared wire shape
  // (`TallyResponse`), the same one the API's index path produces, so the chart
  // is not a special case that only the ballot can render.
  //
  // `source: "chain"` is not a guess. These numbers come from this component's
  // own `results()` read on `target.chainId` — the chain the wallet would sign
  // on (ADR-0019) — so they are the contract's own tally, and the chart names
  // them the way the rest of the app already names a chain read.
  const tally =
    results === undefined
      ? undefined
      : {
          source: "chain" as const,
          total: Number(results[1]),
          options: results[0].map((option) => ({
            id: Number(option.id),
            voteCount: Number(option.voteCount),
          })),
        };

  const phaseState = readStatus(phase !== undefined, reads.isError);
  // `ready` only when there is an address to have a state. Without one the state
  // is not "unknown", it is "not applicable", which the rows render as 未连接.
  const voterState: ReadState = !isConnected
    ? "ready"
    : readStatus(voter !== undefined, reads.isError);
  const endsAtState = readStatus(endsAt !== undefined, reads.isError);

  // The block timestamp is not read here. `isPastDeadline` compares against the
  // *browser's* clock, which can differ from the chain's by a little; the
  // contract is the authority either way and reverts with `PollAlreadyEnded`, so
  // this only decides whether the page offers a button that would fail.
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const deadlinePassed = endsAt === undefined ? false : isPastDeadline({ endsAt, nowSeconds });

  // `voterState` returns a struct. The gate is `canVote`, NOT `whitelisted`:
  // on an `openToAll` poll every address may vote and none of them needs to be
  // on the list, so testing the raw mapping would refuse everyone.
  const canVote = voter?.canVote === true;
  const whitelisted = voter?.whitelisted === true;
  const myOptionId = voter === undefined ? 0 : Number(voter.currentOptionId);
  const myStake = voter?.stake;
  const marked = voter?.marked === true;
  // A sealed ballot is NOT a counted one, so `marked` is false while a
  // commitment is on file. Without this the ballot would tell a committed voter
  // it had not voted — reporting participation as non-participation.
  const committed = voter?.committed === true;
  // The whole set, not just `currentOptionId`: under multi-select the ballot's
  // "already chosen" marks have to cover every selected option, and reading only
  // the first element would leave the others looking unselected.
  const mySelections = voter?.selections ?? [];

  // ---- writes ----
  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const [writing, setWriting] = useState<WriteTarget | null>(null);

  // `receipt.isLoading`, never `receipt.isPending`. wagmi disables the receipt
  // query while there is no hash, and a disabled TanStack query still reports
  // `status: "pending"` — so `isPending` here was permanently true and every
  // button read 提交中… and was unclickable. `isLoading` is `isPending &&
  // isFetching`, i.e. true only while a receipt is genuinely in flight.
  const txBusy = isPending || receipt.isLoading;

  const writeFailure = writeError === null ? null : describeWriteFailure(writeError);

  useEffect(() => {
    if (writeError !== null && writeFailure?.classified === false) {
      // The sentence on the page deliberately does not guess at an unrecognised
      // cause; the raw error is kept reachable instead (ADR-0022).
      console.error("the poll write failed with an unclassified error", writeError);
    }
  }, [writeError, writeFailure]);

  useEffect(() => {
    if (!receipt.isSuccess) {
      return;
    }

    setWriting(null);
    // The transaction changed on-chain state, so every cached answer is stale.
    // This is what makes the UI follow the chain rather than the click: the
    // buttons are re-derived from a fresh `voterState`, so a change of vote moves
    // the highlighted option and a withdrawal removes it.
    void queryClient.invalidateQueries();
  }, [receipt.isSuccess, queryClient]);

  function send(target_: WriteTarget) {
    setWriting(target_);

    if (target_.kind === "vote") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "vote",
        // A set, even for a single choice. `vote` takes the whole selection so
        // that one transaction is one vote under every mechanism; a multi-select
        // poll just puts more than one id in this array.
        args: [[BigInt(target_.optionId)]],
        value: STAKE,
      });
      return;
    }

    if (target_.kind === "change") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "changeVote",
        args: [[BigInt(target_.optionId)]],
      });
      return;
    }

    writeContract({
      address,
      abi: pollAbi,
      functionName:
        target_.kind === "withdraw"
          ? "withdrawVote"
          : target_.kind === "refund"
            ? "refund"
            : "closeAfterDeadline",
    });
  }

  // ---- the sentences ----
  //
  // The rules live in `lib/ballot-reasons.ts` as pure functions so they can be
  // unit tested; this component only assembles their input from the reads above.
  // The order the branches are checked in IS the specification — it follows the
  // contract's own check order, so the sentence the reader gets is the one the
  // revert would have produced (ADR-0009, ADR-0012).
  const reasons: BallotInputs = {
    contractKnown,
    subjectChainId,
    isConnected,
    txBusy,
    phaseState,
    voterState,
    phase,
    deadlinePassed,
    canVote,
    whitelisted,
    marked,
    myOptionId,
    myStake,
    committed,
  };

  const readFailed = reads.isError;
  // `mounted` is the only reason to withhold anything here: the chain reads do not
  // depend on the wallet, so a reader who has not connected one still gets the
  // options, the tally and the phase. Only the "我的状态" rows and the two buttons
  // need an address, and they say 未连接 on their own.
  const loading = !mounted || reads.isPending;

  // Which of the four chain states this poll is in, decided in one place so the
  // header badge and the list card cannot disagree. `phase` is `undefined` until
  // the read lands, which `phaseTone` already renders as 读取中.
  const phaseInfo = phaseTone(phaseState === "ready" ? phase : undefined, deadlinePassed, locale);

  // ---- the rows' values ----
  //
  // Both derivations live here rather than inline in the JSX because inline is
  // what produced the defect this replaces. 我的状态 carried five hand-written
  // ternary chains that each re-answered the same question — "was this read
  // completed, and did it fail or is it still running?" — and re-answering it per
  // row is how one row drifted out of step with the others. The 押金 row is the
  // one that actually did: it rendered `${formatEth(myStake ?? 0n)} ETH`, so a
  // FAILED or still-loading `stakeOf` read became a confident `0 ETH` — a
  // statement about the reader's own money, which `sweepUnclaimed()` can hand to
  // the poll's creator once the grace period passes.
  //
  // `myStatusLabels` takes each read's STATUS alongside its value, so no row can
  // print a number it never read (see that function, and this module's header).
  // Every read here is `voterState`'s own slot, so all four rows share
  // `voterState` as their status: one read, one answer about whether it landed.
  //
  // `mounted` and `isConnected` are checked inside `myStatusLabels` rather than
  // before the call, because "no address to ask about" is a different sentence
  // from "the read failed" and only that function is allowed to choose between
  // them.
  const status = myStatusLabels(
    {
      mounted,
      isConnected,
      contractKnown,
      hasVoted: { status: voterState, value: voter === undefined ? undefined : marked },
      // A zero option id is the contract's "no vote", not a candidate numbered 0,
      // and `myStatusLabels` renders it as `—` rather than as "选项 #0".
      votedFor: { status: voterState, value: voter === undefined ? undefined : myOptionId },
      stake: { status: voterState, value: myStake },
      whitelisted: { status: voterState, value: voter === undefined ? undefined : whitelisted },
    },
    locale,
  );

  // 可投票 is not one of the four `myStatusLabels` rows — it is `canVote`, a
  // different question from `whitelisted` (see the admission-rows note below) —
  // but it must answer "could not read it" by the same rule, so it goes through
  // the same helper rather than through a sixth ternary chain.
  //
  // The formatter ignores its argument on purpose: what this row prints is a
  // verdict about a boolean, and `readText` still has to be the thing that
  // decides whether there is a verdict to print at all.
  const canVoteText = readText(
    voterState,
    voter === undefined ? undefined : canVote,
    (value) => (value ? ballot.yes : ballot.no),
    locale,
  );

  return (
    <div className="space-y-6">
      {initialError !== null && (
        <section className="rounded-xl border border-rose-200 bg-rose-50 p-5">
          <h2 className="text-sm font-medium text-rose-800">{t("ballot.serverReadFailedTitle")}</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-rose-700">
            {t("ballot.serverReadFailedDetail", { error: initialError })}
          </p>
        </section>
      )}

      {/* ---- the poll's own facts ---- */}
      <section
        className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${accentClass(phaseInfo.tone)}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 text-xl font-semibold leading-snug tracking-tight text-slate-900 sm:text-2xl">
            {initial?.question ??
              (readFailed ? t("ballot.questionReadFailed") : t("ballot.readingPoll"))}
          </h1>
          <Badge className={badgeClass(phaseInfo.tone)}>
            {/*
              The attribute names the PHASE, not its label.

              It used to be a bare `data-phase-label` wrapping `phaseInfo.label`,
              which made its text look like a machine-readable value while being
              translatable copy — the same trap `TrustPanel`'s `data-fingerprint`
              fell into. Nothing selected on it, so nothing broke; but a hook that
              reads as a value and changes with the reader's language is one that
              breaks the day somebody finally selects on it. The phase number is
              the stable thing, so that is what the attribute carries.
            */}
            <span data-phase={phase}>{phaseInfo.label}</span>
          </Badge>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label={t("poll.phase")}
            value={phaseText({ contractKnown, status: phaseState, phase }, locale)}
          />
          <Stat
            label={t("ballot.statOptionCount")}
            value={
              initial === null
                ? readFailed
                  ? ballot.readFailed
                  : ballot.reading
                : String(initial.optionCount)
            }
          />
          <Stat
            label={t("poll.totalVotes")}
            value={tally === undefined ? ballot.reading : String(tally.total)}
          />
          {/*
            The one stat whose value is the reader's own money, so it is rendered
            from `readText` rather than from the value alone: `myStake` is
            `undefined` both while `stakeOf` is in flight AND after it has failed,
            and printing a zero for the second case is the defect this file's
            header records. The status is `voterState` because `stake` is one
            field of the same `voterState` read that answers the other three rows.
          */}
          <Stat
            label={t("ballot.statStake")}
            value={readText(voterState, myStake, (wei) => `${formatEth(wei)} ETH`, locale)}
          />
        </dl>

        <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
          <span>
            {t("poll.creatorInline")}{" "}
            <span className="font-mono text-slate-500" title={creator ?? undefined}>
              {creator === undefined
                ? (initial?.creator ?? ballot.reading)
                : shortenAddress(creator)}
            </span>
          </span>
          <Dot />
          <span>
            {t("ballot.contract")}{" "}
            <span className="font-mono text-slate-500">{shortenAddress(address)}</span>
          </span>
          <Dot />
          <span>
            {endsAtState !== "ready"
              ? endsAtState === "failed"
                ? t("ballot.deadlineReadFailed")
                : t("ballot.readingDeadline")
              : deadlinePassed
                ? t("ballot.deadlinePassed", {
                    time: new Date(Number(endsAt) * 1000).toLocaleString(),
                  })
                : t("ballot.deadline", { time: new Date(Number(endsAt) * 1000).toLocaleString() })}
          </span>
        </p>

        {/*
          The distinction the list page does not make: a poll past its deadline is
          unvotable immediately (the contract reverts), but it is still in phase
          Voting until somebody calls the permissionless `closeAfterDeadline()`.

          This used to be a paragraph that explained the situation and offered no
          way out of it — which meant every voter's stake was stuck behind a call
          this page told them existed but would not make. `refund()` requires
          `Phase.Ended`, and neither `endPoll` (owner-only) nor anything else can
          get the poll there once the creator is gone. The button below is the way
          out, and it is deliberately outside the "我的状态" section because it
          does not belong to any one reader.
        */}
        {phase === PollPhase.Voting && deadlinePassed && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
            <p>
              {t("ballot.pastDeadlineOpenPhase")}
              <strong>{t("ballot.pastDeadlineOpenPhaseEmphasis")}</strong>
              {t("ballot.pastDeadlineOpenPhaseTail")}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => send({ kind: "close" })}
                disabled={closeReason(reasons) !== undefined}
                className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                {writing?.kind === "close" && txBusy ? ballot.busy : t("ballot.closePoll")}
              </button>
              {mounted && closeReason(reasons) !== undefined && (
                <span className="text-slate-500">{closeReason(reasons)}</span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ---- my state ---- */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t("ballot.myStatus")}
        </h2>

        <dl className="mt-3 divide-y divide-slate-100 text-sm">
          <Row label={t("ballot.canVote")}>{canVoteText}</Row>
          {/*
            The admission rows, and why there are two of them.

            `canVote` and `whitelisted` are different questions and both are
            worth showing, but showing the wrong one alone misleads in opposite
            directions on the two poll types:

              * Open poll — `whitelisted` is false for everyone, so a row built
                from it alone would say 否 to every reader on a poll they can all
                vote in.
              * Whitelisted poll — `canVote` is true for exactly the admitted
                addresses, so a row built from it alone would render 是 with no
                indication that admission came from a LIST, and an admitted
                reader could not tell the two poll types apart.

            So each row appears where it carries information, and exactly one of
            them is ever shown:

              * 准入方式 "所有人可投" — the poll is open, so there is no list and
                the mode is the fact worth stating;
              * 白名单 是/否 — the poll has a list, so this reader's membership is
                the fact worth stating, whether or not they were admitted. An
                admitted reader needs the 是 to tell a whitelisted poll apart from
                an open one, and a reader whose entry was removed after they voted
                needs the 否 to understand why 投票 now refuses them.
          */}
          {voterState === "ready" && canVote && !whitelisted && (
            <Row label={t("ballot.admissionMode")}>
              <span className="font-normal text-slate-500">{t("ballot.openToAll")}</span>
            </Row>
          )}
          {voterState === "ready" && !canVote && !whitelisted && (
            <Row label={t("ballot.whitelist")}>
              <span className="text-rose-600">{status.whitelisted}</span>
            </Row>
          )}
          {voterState === "ready" && whitelisted && (
            <Row label={t("ballot.whitelist")}>
              <span className="text-emerald-600">{status.whitelisted}</span>
            </Row>
          )}
          <Row label={t("ballot.hasVoted")}>{status.hasVoted}</Row>
          <Row label={t("ballot.votedFor")}>{status.votedFor}</Row>
          <Row label={t("ballot.statStake")}>{status.stake}</Row>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => send({ kind: "withdraw" })}
            disabled={withdrawReason(reasons) !== undefined}
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
          >
            {writing?.kind === "withdraw" && txBusy ? ballot.busy : t("ballot.withdrawVote")}
          </button>
          {mounted && withdrawReason(reasons) !== undefined && (
            <span className="text-xs text-slate-400">{withdrawReason(reasons)}</span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => send({ kind: "refund" })}
            disabled={refundReason(reasons) !== undefined}
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
          >
            {writing?.kind === "refund" && txBusy ? ballot.busy : t("ballot.reclaimStake")}
          </button>
          {mounted && refundReason(reasons) !== undefined && (
            <span className="text-xs text-slate-400">{refundReason(reasons)}</span>
          )}
        </div>

        {hash !== undefined && (
          <p className="mt-3 break-all font-mono text-[11px] text-slate-500">
            {t("ballot.transaction")} {hash}
            {receipt.isPending && t("ballot.awaitingConfirmation")}
            {receipt.isSuccess && t("ballot.confirmed")}
          </p>
        )}

        {writeFailure !== null && (
          // The attribute is what `ui:drill` asserts on, so its check does not
          // depend on matching a sentence word for word (ADR-0022).
          <p
            className="mt-2 text-xs text-rose-600"
            data-write-error={writeFailure.classified ? "classified" : "unclassified"}
          >
            {writeFailure.text}
          </p>
        )}
      </section>

      {/*
        ---- the result, as a picture ----

        Placed above the option cards because it answers the question the panel
        above it asks: 票数合计 says how many votes there are, and this says how
        they are split. It is rendered ONLY when `tally` exists, i.e. when the
        same `results()` read the cards below are built from succeeded — a poll
        whose tally could not be read gets the failure notice further down and no
        chart at all, because an empty chart would report "could not read" as
        "nothing to show" (ADR-0011).

        Zero votes is a different story and gets its own honest sentence from
        `ResultChart`: the read answered, and the answer is that nobody has voted.
      */}
      {tally !== undefined && (
        <section>
          {/*
            `locale` rather than a translator: `ResultChart` is a Server Component
            with no `"use client"`, so it cannot call the hook and takes the
            language as data. This component already resolved it, and passing it
            down is what keeps the chart's caption, its spoken label and the tally
            beside it in one language.
          */}
          <ResultChart tally={tally} locale={locale} />
        </section>
      )}

      {/* ---- the options ---- */}
      <section>
        <h2 className="text-sm font-semibold text-slate-900">
          {t("ballot.options")}
          {results === undefined ? "" : t("ballot.optionsCount", { count: results[0].length })}
        </h2>

        {loading && <p className="mt-4 text-sm text-slate-500">{t("ballot.readingOptions")}</p>}

        {!loading && readFailed && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            {t("ballot.optionsReadFailed")}
          </div>
        )}

        {!loading && !readFailed && results !== undefined && results[0].length === 0 && (
          <p className="mt-4 text-sm text-slate-500">{t("ballot.noOptions")}</p>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {!loading &&
            !readFailed &&
            results?.[0].map((option) => {
              const id = Number(option.id);
              const mine = marked && id === myOptionId;

              return (
                <OptionRow
                  key={id}
                  id={id}
                  labelCid={option.labelCID}
                  voteCount={Number(option.voteCount)}
                  totalVotes={Number(results[1])}
                  isMine={mine}
                  // Which write this card's button performs is decided here, not
                  // in the card: "投票" and "改投" are the same control with two
                  // different chain calls, and the difference is entirely a
                  // function of whether this address already holds a vote.
                  action={marked ? "change" : "vote"}
                  disabledReason={marked ? changeReason(reasons, id) : voteReason(reasons)}
                  isSubmitting={
                    txBusy && writing !== null && "optionId" in writing && writing.optionId === id
                  }
                  onAct={(kind) => send({ kind, optionId: id })}
                />
              );
            })}
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{children}</dd>
    </div>
  );
}

/**
 * The separator between the header's inline facts.
 *
 * `aria-hidden` because it carries no meaning — a screen reader announcing a
 * bullet between "发起人" and "合约" is noise, and the surrounding text already
 * reads as a list of facts.
 */
function Dot() {
  return (
    <span aria-hidden="true" className="text-slate-300">
      ·
    </span>
  );
}
