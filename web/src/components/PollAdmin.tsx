"use client";

import { useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  useConfig,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { useMounted } from "@/hooks/useMounted";
import { parseAddressList, WHITELIST_BATCH_LIMIT } from "@/lib/admin-labels";
import { describeWriteFailure } from "@/lib/ballot-labels";
import {
  chainName,
  PollPhase,
  pollAbi,
  REFUND_GRACE_PERIOD_SECONDS,
  resolveChainTarget,
  type ChainTarget,
} from "@/lib/voting";

/** Mirrors `Poll.MIN_OPTIONS`: `removeOption` reverts below it. */
const MIN_OPTIONS = 2;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Which administrative write is in flight.
 *
 * One wallet serves the whole panel, so every control shares `isPending` and all
 * of them must stay disabled while any write is outstanding — otherwise two
 * conflicting transactions can be queued and the second reverts. Tagging the
 * write keeps that from also making every button claim to be the one submitting,
 * the same defect `PollBallot`'s `WriteTarget` exists to avoid.
 */
type AdminTarget =
  | { kind: "whitelist"; allowed: boolean }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "addOption" }
  | { kind: "updateOption"; optionId: number }
  | { kind: "removeOption"; optionId: number }
  | { kind: "sweep" };

export interface PollAdminProps {
  /** The poll's address, from the route's `[id]` segment. */
  address: `0x${string}`;
  /** The chain and factory this deployment is configured for, or null. */
  configuredTarget: ChainTarget | null;
}

/**
 * 发起人管理: the creator-only half of a poll.
 *
 * ---------------------------------------------------------------------------
 * Why this panel had to exist
 * ---------------------------------------------------------------------------
 *
 * `Poll` implements a full lifecycle — `startPoll`, `endPoll`, `setWhitelist`,
 * `addOption`/`updateOption`/`removeOption`, `sweepUnclaimed` — and the ABI
 * exports every one of them. Before this component, the web app called NONE of
 * them. The consequence was not a missing convenience, it was a dead end:
 *
 *   1. `createPoll` leaves the poll in `Phase.Setup`;
 *   2. `vote` reverts with `InvalidPhase` until `startPoll` runs;
 *   3. `startPoll` is `onlyOwner` and had no UI anywhere;
 *   4. so every poll ever created through this app stayed unvotable forever.
 *
 * The reader saw 投票尚未开始：发起人还没有调用 startPoll() — a sentence that names
 * the missing call and offers no way to make it. This panel is that way.
 *
 * ---------------------------------------------------------------------------
 * Why the controls are gated the way they are
 * ---------------------------------------------------------------------------
 *
 * Rendering is gated on `creator === connected address`, but that is a
 * *presentation* decision and not a security one: the contract's `onlyOwner`
 * checks are the real gate, and this panel would be harmless if it rendered for
 * everyone. It is hidden because showing a stranger a wall of buttons that all
 * revert with `OwnableUnauthorizedAccount` is worse than showing nothing.
 *
 * Each control's availability is derived from chain state (ADR-0009), and each
 * disabled control says which state it is in and why — the sentence follows the
 * contract's own check order, so what the reader is told is what the revert
 * would have said. A grey, silent button is the one outcome this must not
 * produce, exactly as in `PollBallot`.
 */
export function PollAdmin({ address, configuredTarget }: PollAdminProps) {
  const mounted = useMounted();
  const config = useConfig();
  const { address: account, isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  const contractKnown = targetChain !== undefined;

  const readChain = targetChain === undefined ? {} : { chainId: targetChain.id };
  const subjectChainId = target?.chainId ?? walletChainId;

  // ---- reads ----
  //
  // One `useReadContracts` for the same reason `PollBallot` uses one: the phase,
  // the option list and the stake are read from a single block, so the panel
  // cannot offer `startPoll` based on a phase that a later read in the same
  // render has already moved past (ADR-0017's lesson applied to a read).
  const reads = useReadContracts({
    contracts: [
      { address, abi: pollAbi, functionName: "phase" },
      { address, abi: pollAbi, functionName: "creator" },
      { address, abi: pollAbi, functionName: "results" },
      { address, abi: pollAbi, functionName: "endsAt" },
      { address, abi: pollAbi, functionName: "votingEndedAt" },
      { address, abi: pollAbi, functionName: "totalStaked" },
    ],
    ...readChain,
    query: { enabled: contractKnown },
  });

  const [phaseResult, creatorResult, resultsResult, endsAtResult, endedAtResult, stakedResult] =
    reads.data ?? [];

  const phase = phaseResult?.result === undefined ? undefined : Number(phaseResult.result);
  const creator = creatorResult?.result;
  const results = resultsResult?.result;
  const endsAt = endsAtResult?.result;
  const votingEndedAt = endedAtResult?.result;
  const totalStaked = stakedResult?.result;

  const isCreator =
    account !== undefined &&
    creator !== undefined &&
    account.toLowerCase() === creator.toLowerCase();
  const setup = phase === PollPhase.Setup;
  const voting = phase === PollPhase.Voting;
  const ended = phase === PollPhase.Ended;
  const optionCount = results === undefined ? undefined : results[0].length;

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const deadlinePassed = endsAt === undefined ? false : nowSeconds >= endsAt;

  // ---- writes ----
  const { writeContract, data: hash, isPending, error: writeError, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const [writing, setWriting] = useState<AdminTarget | null>(null);

  // `receipt.isLoading`, never `receipt.isPending`: wagmi disables the receipt
  // query while there is no hash, and a disabled TanStack query still reports
  // `status: "pending"`. See the same note in `PollBallot`.
  const txBusy = isPending || receipt.isLoading;

  const writeFailure = writeError === null ? null : describeWriteFailure(writeError);

  useEffect(() => {
    if (writeError !== null && writeFailure?.classified === false) {
      console.error("the poll admin write failed with an unclassified error", writeError);
    }
  }, [writeError, writeFailure]);

  // ---- form state ----
  const [whitelistText, setWhitelistText] = useState("");
  const [newOption, setNewOption] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [sweepTo, setSweepTo] = useState("");

  useEffect(() => {
    if (!receipt.isSuccess) {
      return;
    }

    // Each form's own fields are cleared on success, because every one of these
    // writes is non-idempotent in a way the reader would not expect: a second
    // `startPoll` reverts, but a second `addOption` succeeds and silently appends
    // a duplicate option, and a second `sweepUnclaimed` would move whatever
    // arrived since. Leaving the values in place invites exactly that.
    setWriting(null);
    setWhitelistText("");
    setNewOption("");
    setEditingId(null);
    setEditingValue("");
    setSweepTo("");
    reset();
  }, [receipt.isSuccess, reset]);

  /**
   * Every address on its own line or separated by commas, deduplicated.
   *
   * Returns `null` when any entry is not an address, rather than silently
   * dropping it: `setWhitelist` would revert on `address(0)` alone, but a
   * mistyped address that is still 20 hex bytes would be accepted by the
   * contract and grant voting rights to a stranger. Refusing the whole batch is
   * the only outcome that cannot hide a typo.
   */
  const parsedWhitelist = parseAddressList(whitelistText);

  function send(target_: AdminTarget) {
    setWriting(target_);

    if (target_.kind === "whitelist") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "setWhitelist",
        args: [parsedWhitelist ?? [], target_.allowed],
      });
      return;
    }

    if (target_.kind === "updateOption") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "updateOption",
        args: [BigInt(target_.optionId), editingValue.trim()],
      });
      return;
    }

    if (target_.kind === "removeOption") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "removeOption",
        args: [BigInt(target_.optionId)],
      });
      return;
    }

    if (target_.kind === "addOption") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "addOption",
        args: [newOption.trim()],
      });
      return;
    }

    if (target_.kind === "sweep") {
      writeContract({
        address,
        abi: pollAbi,
        functionName: "sweepUnclaimed",
        args: [sweepTo.trim() as `0x${string}`],
      });
      return;
    }

    writeContract({
      address,
      abi: pollAbi,
      functionName: target_.kind === "start" ? "startPoll" : "endPoll",
    });
  }

  // ---- the sentences ----

  /**
   * The checks that come before anything else, in the contract's own order.
   *
   * Kept as one function returning a discriminant-bearing sentence rather than
   * per-button duplication, for the reason `PollBallot` documents: comparing
   * rendered strings to decide a branch breaks the moment a sentence is edited.
   */
  function blocked(): string | undefined {
    if (!contractKnown) {
      return `当前链（${subjectChainId}，${chainName(subjectChainId)}）没有已登记的工厂合约，无法确定投票合约。请在钱包里切到本应用部署的那条链。`;
    }

    if (!isConnected) {
      return "请先连接钱包：这些调用都由你的钱包签名。";
    }

    if (txBusy) {
      return "上一笔交易还在确认中，请等它完成。";
    }

    if (reads.isError) {
      return "读取合约状态失败，无法判断可以做什么；请检查 RPC 后重试。";
    }

    if (reads.isPending) {
      return "正在读取合约状态…";
    }

    return undefined;
  }

  /** Why `startPoll` is unavailable. */
  function startReason(): string | undefined {
    const reason = blocked();
    if (reason !== undefined) {
      return reason;
    }

    if (!voting && !setup) {
      return "投票已经开始过了，合约会以 InvalidPhase 拒绝再次调用 startPoll()。";
    }

    if (optionCount !== undefined && optionCount < MIN_OPTIONS) {
      return `至少要有 ${MIN_OPTIONS} 个选项才能开始，合约会以 TooFewOptions 拒绝。`;
    }

    if (endsAt !== undefined && nowSeconds >= endsAt) {
      return "截止时间已经过去了，合约会以 PollAlreadyEnded 拒绝开始；请重新建一个投票。";
    }

    return undefined;
  }

  /** Why `endPoll` is unavailable. */
  function endReason(): string | undefined {
    const reason = blocked();
    if (reason !== undefined) {
      return reason;
    }

    if (!voting) {
      return setup
        ? "投票还没开始，合约会以 InvalidPhase 拒绝 endPoll()。"
        : "投票已经结束了，合约会以 InvalidPhase 拒绝 endPoll()。";
    }

    return undefined;
  }

  /**
   * Why `closeAfterDeadline` is unavailable.
   *
   * Nothing identity-related appears here on purpose: the call is
   * permissionless, so the only blocking conditions are the phase and the
   * deadline. This is the button that unlocks `refund()` when a creator walks
   * away, and gating it behind a wallet would defeat the point.
   */
  function closeReason(): string | undefined {
    if (!contractKnown) {
      return `当前链（${subjectChainId}，${chainName(subjectChainId)}）没有已登记的工厂合约。`;
    }

    if (reads.isError) {
      return "读取合约阶段失败，无法判断能否关闭；请检查 RPC 后重试。";
    }

    if (reads.isPending) {
      return "正在读取合约状态…";
    }

    if (ended) {
      return "投票已经正式关闭了。";
    }

    if (setup) {
      return "投票还没开始，合约会以 InvalidPhase 拒绝 closeAfterDeadline()。";
    }

    if (!deadlinePassed) {
      return "还没到截止时间，合约会以 DeadlineNotInFuture 拒绝 closeAfterDeadline()。";
    }

    return undefined;
  }

  /** Why either whitelist button is unavailable. */
  function whitelistReason(): string | undefined {
    const reason = blocked();
    if (reason !== undefined) {
      return reason;
    }

    if (ended) {
      return "投票已经结束，合约会以 InvalidPhase 拒绝改动白名单。";
    }

    if (whitelistText.trim().length === 0) {
      return "请先填写地址：每行一个，或用逗号分隔。";
    }

    if (parsedWhitelist === null) {
      return "有地址不是 20 字节的十六进制格式（0x 加 40 位），整批都不会提交。";
    }

    if (parsedWhitelist.length > WHITELIST_BATCH_LIMIT) {
      return `一次最多提交 ${WHITELIST_BATCH_LIMIT} 个地址，收到 ${parsedWhitelist.length} 个；请分批。`;
    }

    return undefined;
  }

  /** Why the option editors are unavailable. */
  function optionReason(): string | undefined {
    const reason = blocked();
    if (reason !== undefined) {
      return reason;
    }

    if (!setup) {
      return "选项只能在投票开始前改动；一旦开始，合约会以 InvalidPhase 拒绝所有选项写入。";
    }

    return undefined;
  }

  /** Why a specific `removeOption` is unavailable. */
  function removeReason(): string | undefined {
    const reason = optionReason();
    if (reason !== undefined) {
      return reason;
    }

    if (optionCount !== undefined && optionCount <= MIN_OPTIONS) {
      return `只剩 ${optionCount} 个选项，合约会以 TooFewOptions 拒绝删除。`;
    }

    return undefined;
  }

  /** Why `sweepUnclaimed` is unavailable. */
  function sweepReason(): string | undefined {
    const reason = blocked();
    if (reason !== undefined) {
      return reason;
    }

    if (!ended) {
      return "投票还没结束，合约会以 InvalidPhase 拒绝 sweepUnclaimed()。";
    }

    // The grace period starts when the poll was closed, not when its deadline
    // was. `endPoll` and `closeAfterDeadline` both record `votingEndedAt`, and
    // that is the value `sweepUnclaimed` compares against.
    if (votingEndedAt === undefined || votingEndedAt === 0n) {
      return "合约还没有记录关闭时间，无法判断宽限期是否已过。";
    }

    const availableAt = votingEndedAt + REFUND_GRACE_PERIOD_SECONDS;
    if (nowSeconds < availableAt) {
      return `宽限期还没结束，合约会以 GracePeriodNotElapsed 拒绝；可领取时间是 ${new Date(
        Number(availableAt) * 1000,
      ).toLocaleString()}。`;
    }

    if (sweepTo.trim().length === 0) {
      return "请填写接收地址。";
    }

    if (!ADDRESS_PATTERN.test(sweepTo.trim())) {
      return "接收地址必须是 20 字节的十六进制地址。";
    }

    return undefined;
  }

  // Nothing to render until the creator is known. Rendering a placeholder would
  // flash an admin panel at every visitor before the read settles.
  if (!mounted || reads.isPending || reads.isError || !contractKnown || !isConnected) {
    return null;
  }

  if (!isCreator) {
    return null;
  }

  const disabled = (reason: string | undefined) => reason !== undefined;

  return (
    <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50/40 p-5">
      <h2 className="text-sm font-semibold text-slate-900">
        发起人管理
        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-normal text-amber-800">
          仅你可见
        </span>
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        你创建了这个投票，所以只有你能维护白名单、改动选项、开始与结束投票。
        这些调用都由你的钱包签名；面板的显示与否只是界面决定，真正的权限检查在合约的{" "}
        <code className="font-mono">onlyOwner</code> 里。
      </p>

      {/* ---- lifecycle ---- */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">生命周期</h3>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => send({ kind: "start" })}
            disabled={disabled(startReason())}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {writing?.kind === "start" && txBusy ? "提交中…" : "开始投票"}
          </button>
          {startReason() !== undefined && (
            <span className="text-xs text-slate-400">{startReason()}</span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => send({ kind: "end" })}
            disabled={disabled(endReason())}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {writing?.kind === "end" && txBusy ? "提交中…" : "提前结束投票"}
          </button>
          {endReason() !== undefined && (
            <span className="text-xs text-slate-400">{endReason()}</span>
          )}
        </div>

        {/*
          The permissionless close. It is rendered here as well as in the ballot
          because it is the one lifecycle call that does NOT need to be the
          creator — and it is the only thing that unlocks `refund()` for a poll
          whose creator never called `endPoll`. Explaining that is the point.
        */}
        <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
          若截止时间已过而投票仍显示「投票中」，任何人都可以调用{" "}
          <code className="font-mono">closeAfterDeadline()</code> 正式关闭它——
          在那之前，连你自己的押金也取不回来。
        </p>
      </div>

      {/* ---- whitelist ---- */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">白名单</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          每行一个地址，或用逗号分隔。合约按批次写入，重复地址会被幂等地设为同一状态。
        </p>

        <textarea
          value={whitelistText}
          onChange={(event) => setWhitelistText(event.target.value)}
          rows={3}
          placeholder={"0xabc…\n0xdef…"}
          aria-label="白名单地址"
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-500"
        />

        {parsedWhitelist !== null && whitelistText.trim().length > 0 && (
          <p className="mt-1 text-[11px] text-slate-400">
            识别到 {parsedWhitelist.length} 个地址
            {parsedWhitelist.length > 0 && parsedWhitelist.length <= 3
              ? `：${parsedWhitelist.join("、")}`
              : ""}
            。
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => send({ kind: "whitelist", allowed: true })}
            disabled={disabled(whitelistReason())}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {writing?.kind === "whitelist" && writing.allowed && txBusy ? "提交中…" : "加入白名单"}
          </button>
          <button
            type="button"
            onClick={() => send({ kind: "whitelist", allowed: false })}
            disabled={disabled(whitelistReason())}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {writing?.kind === "whitelist" && !writing.allowed && txBusy ? "提交中…" : "移出白名单"}
          </button>
          {whitelistReason() !== undefined && (
            <span className="text-xs text-slate-400">{whitelistReason()}</span>
          )}
        </div>
      </div>

      {/* ---- options ---- */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          选项管理
          {optionCount !== undefined && (
            <span className="ml-2 font-normal normal-case tracking-normal text-slate-400">
              当前 {optionCount} 个
            </span>
          )}
        </h3>

        {optionReason() !== undefined && (
          <p className="mt-2 text-xs text-slate-400">{optionReason()}</p>
        )}

        {results !== undefined && results[0].length > 0 && (
          <ul className="mt-2 space-y-2">
            {results[0].map((option) => {
              const id = Number(option.id);
              const editing = editingId === id;

              return (
                <li key={id} className="flex flex-wrap items-center gap-2">
                  <span className="w-8 shrink-0 text-[11px] text-slate-400">#{id}</span>

                  {editing ? (
                    <>
                      <input
                        type="text"
                        value={editingValue}
                        onChange={(event) => setEditingValue(event.target.value)}
                        aria-label={`选项 ${id} 的新内容`}
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
                      />
                      <button
                        type="button"
                        onClick={() => send({ kind: "updateOption", optionId: id })}
                        disabled={disabled(optionReason()) || editingValue.trim().length === 0}
                        className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                      >
                        {writing?.kind === "updateOption" && txBusy ? "提交中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditingValue("");
                        }}
                        className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 transition hover:bg-slate-50"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600">
                        {option.labelCID}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(id);
                          setEditingValue(option.labelCID);
                        }}
                        disabled={disabled(optionReason())}
                        className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        onClick={() => send({ kind: "removeOption", optionId: id })}
                        disabled={disabled(removeReason())}
                        className="shrink-0 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-slate-300"
                      >
                        {writing?.kind === "removeOption" && txBusy ? "提交中…" : "删除"}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/*
          Removal compacts the ids in place, and the note is not trivia: option
          ids are what the indexer keys on, so deleting #1 of 3 renumbers the
          others. Saying so before the click is cheaper than debugging it after.
        */}
        {results !== undefined && results[0].length > MIN_OPTIONS && (
          <p className="mt-2 text-[11px] text-amber-700">
            删除中间选项会让它后面的选项编号整体前移；投票开始后无法再改动。
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <input
            type="text"
            value={newOption}
            onChange={(event) => setNewOption(event.target.value)}
            placeholder="新的选项文字或 CID"
            aria-label="新选项"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
          />
          <button
            type="button"
            onClick={() => send({ kind: "addOption" })}
            disabled={disabled(optionReason()) || newOption.trim().length === 0}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {writing?.kind === "addOption" && txBusy ? "提交中…" : "增加选项"}
          </button>
        </div>
      </div>

      {/* ---- unclaimed stake ---- */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          无人认领的押金
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          宽限期（7 天）过后，仍未被投票人取回的押金可以由你取走。
          这是本项目已声明的中心化风险：押金是投票人的钱，取走前请确认宽限期确实已过。
        </p>

        {totalStaked !== undefined && (
          <p className="mt-1 text-[11px] text-slate-500">
            合约当前记在账上的押金合计： <span className="font-mono">{totalStaked.toString()}</span>{" "}
            wei
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={sweepTo}
            onChange={(event) => setSweepTo(event.target.value)}
            placeholder="接收地址 0x…"
            aria-label="扫款接收地址"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
          />
          <button
            type="button"
            onClick={() => {
              setSweepTo(account ?? "");
            }}
            className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 transition hover:bg-slate-50"
          >
            填入我的地址
          </button>
          <button
            type="button"
            onClick={() => send({ kind: "sweep" })}
            disabled={disabled(sweepReason())}
            className="shrink-0 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {writing?.kind === "sweep" && txBusy ? "提交中…" : "取走无人认领的押金"}
          </button>
        </div>

        {sweepReason() !== undefined && (
          <p className="mt-2 text-xs text-slate-400">{sweepReason()}</p>
        )}
      </div>

      {hash !== undefined && (
        <p className="mt-4 break-all font-mono text-[11px] text-slate-500">
          交易 {hash}
          {receipt.isPending && " · 等待确认…"}
          {receipt.isSuccess && " · 已确认"}
        </p>
      )}

      {writeFailure !== null && (
        <p
          className="mt-2 text-xs text-rose-600"
          data-write-error={writeFailure.classified ? "classified" : "unclassified"}
        >
          {writeFailure.text}
        </p>
      )}
    </section>
  );
}
