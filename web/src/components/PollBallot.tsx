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

import { OptionRow } from "@/components/OptionRow";
import { Badge, Stat } from "@/components/ui";
import { useMounted } from "@/hooks/useMounted";
import { describeWriteFailure, phaseText, readStatus, type ReadState } from "@/lib/ballot-labels";
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

  // `voterState` returns five values. The gate is `canVote`, NOT `whitelisted`:
  // on an `openToAll` poll every address may vote and none of them needs to be
  // on the list, so testing the raw mapping would refuse everyone.
  const canVote = voter?.[4] === true;
  const whitelisted = voter?.[0] === true;
  const myOptionId = voter === undefined ? 0 : Number(voter[1]);
  const myStake = voter?.[2];
  const marked = voter?.[3] === true;

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
        args: [BigInt(target_.optionId)],
        value: STAKE,
      });
      return;
    }

    if (target_.kind === "change") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "changeVote",
        args: [BigInt(target_.optionId)],
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
  const phaseInfo = phaseTone(phaseState === "ready" ? phase : undefined, deadlinePassed);

  return (
    <div className="space-y-6">
      {initialError !== null && (
        <section className="rounded-xl border border-rose-200 bg-rose-50 p-5">
          <h2 className="text-sm font-medium text-rose-800">服务端读取这个投票时失败了</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-rose-700">
            下面能读到的数据仍会显示：{initialError}
          </p>
        </section>
      )}

      {/* ---- the poll's own facts ---- */}
      <section
        className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${accentClass(phaseInfo.tone)}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 text-xl font-semibold leading-snug tracking-tight text-slate-900 sm:text-2xl">
            {initial?.question ?? (readFailed ? "读取问题失败" : "正在读取投票…")}
          </h1>
          <Badge className={badgeClass(phaseInfo.tone)}>
            <span data-phase-label>{phaseInfo.label}</span>
          </Badge>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="阶段" value={phaseText({ contractKnown, status: phaseState, phase })} />
          <Stat
            label="选项数"
            value={
              initial === null ? (readFailed ? "读取失败" : "读取中…") : String(initial.optionCount)
            }
          />
          <Stat label="票数合计" value={results === undefined ? "读取中…" : String(results[1])} />
          <Stat
            label="押金"
            value={myStake === undefined ? "读取中…" : `${formatEth(myStake)} ETH`}
          />
        </dl>

        <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
          <span>
            发起人{" "}
            <span className="font-mono text-slate-500" title={creator ?? undefined}>
              {creator === undefined ? (initial?.creator ?? "读取中…") : shortenAddress(creator)}
            </span>
          </span>
          <Dot />
          <span>
            合约 <span className="font-mono text-slate-500">{shortenAddress(address)}</span>
          </span>
          <Dot />
          <span>
            {endsAtState !== "ready"
              ? endsAtState === "failed"
                ? "截止时间读取失败"
                : "正在读取截止时间…"
              : deadlinePassed
                ? `已过截止时间（${new Date(Number(endsAt) * 1000).toLocaleString()}）`
                : `截止 ${new Date(Number(endsAt) * 1000).toLocaleString()}`}
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
              已过截止时间，但合约仍处于「投票中」：投票、改投、撤票都会被合约拒绝，
              而押金要等投票正式关闭后才能取回。这个关闭调用<strong>不需要权限</strong>
              ，任何人都可以发起——包括你。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => send({ kind: "close" })}
                disabled={closeReason(reasons) !== undefined}
                className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                {writing?.kind === "close" && txBusy ? "提交中…" : "关闭这个投票（任何人都可以）"}
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
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">我的状态</h2>

        <dl className="mt-3 divide-y divide-slate-100 text-sm">
          <Row label="可投票">
            {!mounted
              ? "—"
              : !isConnected
                ? "未连接"
                : voterState === "failed"
                  ? "读取失败"
                  : voterState === "loading"
                    ? "读取中…"
                    : canVote
                      ? "是"
                      : "否"}
          </Row>
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
            <Row label="准入方式">
              <span className="font-normal text-slate-500">所有人可投</span>
            </Row>
          )}
          {voterState === "ready" && !canVote && !whitelisted && (
            <Row label="白名单">
              <span className="text-rose-600">否</span>
            </Row>
          )}
          {voterState === "ready" && whitelisted && (
            <Row label="白名单">
              <span className="text-emerald-600">是</span>
            </Row>
          )}
          <Row label="已投票">
            {!mounted
              ? "—"
              : !isConnected
                ? "未连接"
                : voterState !== "ready"
                  ? voterState === "failed"
                    ? "读取失败"
                    : "读取中…"
                  : marked
                    ? "是"
                    : "否"}
          </Row>
          <Row label="投给">
            {!mounted
              ? "—"
              : !isConnected
                ? "未连接"
                : voterState !== "ready"
                  ? voterState === "failed"
                    ? "读取失败"
                    : "读取中…"
                  : myOptionId === 0
                    ? "—"
                    : `选项 #${myOptionId}`}
          </Row>
          <Row label="押金">
            {!mounted
              ? "—"
              : !isConnected
                ? "未连接"
                : voterState !== "ready"
                  ? voterState === "failed"
                    ? "读取失败"
                    : "读取中…"
                  : `${formatEth(myStake ?? 0n)} ETH`}
          </Row>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => send({ kind: "withdraw" })}
            disabled={withdrawReason(reasons) !== undefined}
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
          >
            {writing?.kind === "withdraw" && txBusy ? "提交中…" : "撤票（退回押金）"}
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
            {writing?.kind === "refund" && txBusy ? "提交中…" : "取回押金"}
          </button>
          {mounted && refundReason(reasons) !== undefined && (
            <span className="text-xs text-slate-400">{refundReason(reasons)}</span>
          )}
        </div>

        {hash !== undefined && (
          <p className="mt-3 break-all font-mono text-[11px] text-slate-500">
            交易 {hash}
            {receipt.isPending && " · 等待确认…"}
            {receipt.isSuccess && " · 已确认"}
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

      {/* ---- the options ---- */}
      <section>
        <h2 className="text-sm font-semibold text-slate-900">
          选项
          {results === undefined ? "" : `（${results[0].length}）`}
        </h2>

        {loading && <p className="mt-4 text-sm text-slate-500">正在读取选项…</p>}

        {!loading && readFailed && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            读取选项列表失败：链上调用没有成功。请检查 RPC 后重试。
          </div>
        )}

        {!loading && !readFailed && results !== undefined && results[0].length === 0 && (
          <p className="mt-4 text-sm text-slate-500">这个投票还没有任何选项。</p>
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
