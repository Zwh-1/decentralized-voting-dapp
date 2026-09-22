"use client";

import { useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  useConfig,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { useMounted } from "@/hooks/useMounted";
import { describeWriteFailure } from "@/lib/ballot-labels";
import { isPlausibleCid } from "@/lib/ipfs";
import { DEFAULT_CONFIG } from "@/lib/mechanisms";
import { chainName, factoryAbi, resolveChainTarget, type ChainTarget } from "@/lib/voting";

/** The fewest options `Poll.MIN_OPTIONS` accepts. A poll with fewer reverts. */
const MIN_OPTIONS = 2;

/** What `new Date(value).getTime()` returns for an empty or unparseable value. */
const INVALID_DATE = Number.NaN;

export interface CreatePollFormProps {
  configuredTarget: ChainTarget | null;
}

/**
 * Create a poll, signed by the reader's own wallet.
 *
 * The backend holds no private key (ADR-0001 / D6), and this form is where that
 * matters most: `createPoll` deploys a clone and initialises it, and the caller
 * becomes the poll's owner — the one address that may manage its whitelist and
 * end it. That signature can only come from the reader, so this is a direct
 * wallet write and never a server call.
 *
 * **What is stored, honestly.** The contract takes `string[] optionCIDs`, but
 * nothing on chain checks that a string *is* a CID: it is stored verbatim, in
 * storage that is immutable after creation. So this form accepts either and says
 * which one it is registering, per option:
 *
 *   * a value that parses as an IPFS CID is registered as a metadata CID, and the
 *     document is fetched from a gateway by everyone who opens the poll;
 *   * anything else is registered as the option's literal text. The poll still
 *     works — votes are counted by id — but there is no document, and whoever
 *     reads the poll later sees exactly that string.
 *
 * Saying which of the two is about to be written, before the transaction, is the
 * whole point of the hint under the field. The old ballot's failure was a seeded
 * `bafyseededcandidate0` sitting in immutable storage that nothing could correct;
 * the fix is not to pretend the chain validates, it is to tell the reader what
 * they are about to make permanent.
 */
export function CreatePollForm({ configuredTarget }: CreatePollFormProps) {
  const mounted = useMounted();
  const config = useConfig();
  const { address, isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  const factoryKnown = target !== null && targetChain !== undefined;

  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  // Whether the panel is open. Closed by default so the poll list owns the
  // page's vertical space; see the header's comment for why the form is hidden
  // rather than unmounted when it closes.
  const [expanded, setExpanded] = useState(false);
  // A local `datetime-local` value, e.g. "2026-10-01T12:00". Interpreted in the
  // browser's timezone, which is the only timezone the reader can reason about.
  const [deadline, setDeadline] = useState("");
  // Who may vote. Defaults to the open option because the whitelist path makes
  // the poll unusable until the creator remembers to add addresses, and a poll
  // nobody can vote in is the failure this whole feature exists to remove.
  const [openToAll, setOpenToAll] = useState(true);

  const { writeContract, data: hash, isPending, error: writeError, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const txBusy = isPending || receipt.isLoading;

  const writeFailure = writeError === null ? null : describeWriteFailure(writeError);

  useEffect(() => {
    if (writeError !== null && writeFailure?.classified === false) {
      console.error("createPoll failed with an unclassified error", writeError);
    }
  }, [writeError, writeFailure]);

  // A failure must never be hidden behind a collapsed panel. The only way a
  // write error can exist is that the reader submitted, which means they had the
  // panel open — but the panel could have been closed again while the wallet
  // prompt was up, and a rejected transaction that silently does nothing is the
  // worst outcome this form can produce.
  useEffect(() => {
    if (writeError !== null) {
      setExpanded(true);
    }
  }, [writeError]);

  useEffect(() => {
    if (!receipt.isSuccess) {
      return;
    }

    // The poll exists now. Clearing the form is not cosmetic: leaving the values
    // in place invites a second identical transaction, and `createPoll` has no
    // idempotency — it would deploy a second poll with the same question.
    setQuestion("");
    setOptions(["", ""]);
    setDeadline("");
    // Reset to the open default rather than to whatever was last submitted: the
    // next poll should start from the choice that cannot strand it.
    setOpenToAll(true);
    reset();
  }, [receipt.isSuccess, reset]);

  const deadlineMs = deadline === "" ? INVALID_DATE : new Date(deadline).getTime();
  const endsAt = Number.isNaN(deadlineMs) ? null : BigInt(Math.floor(deadlineMs / 1000));

  // Only non-empty option fields become options. An empty field is a row the
  // reader added and has not filled in yet, not an option named "".
  const filled = options.map((option) => option.trim()).filter((option) => option.length > 0);

  function reason(): string | undefined {
    if (!mounted) {
      return undefined;
    }

    if (!factoryKnown) {
      const chainId = target?.chainId ?? walletChainId;

      return `当前链（${chainId}，${chainName(chainId)}）没有已登记的工厂合约，无法创建投票。请在钱包里切到本应用部署的那条链。`;
    }

    if (!isConnected) {
      return "请先连接钱包：创建投票要由你的钱包签名，合约会把发起人记成这个地址。";
    }

    if (txBusy) {
      return "上一笔交易还在确认中，请等它完成。";
    }

    if (question.trim().length === 0) {
      return "请填写投票的问题：合约会以 EmptyQuestion 拒绝空问题。";
    }

    if (filled.length < MIN_OPTIONS) {
      return `至少需要 ${MIN_OPTIONS} 个选项：合约会以 TooFewOptions 拒绝少于 ${MIN_OPTIONS} 个选项的投票。`;
    }

    if (endsAt === null) {
      return "请选择截止时间：合约会以 DeadlineNotInFuture 拒绝空或无效的时间。";
    }

    if (endsAt <= BigInt(Math.floor(Date.now() / 1000))) {
      // Checked here as well as by the contract because the transaction would
      // otherwise cost a wallet prompt and a revert for a field the reader can
      // plainly see is in the past.
      return "截止时间必须在未来：合约会以 DeadlineNotInFuture 拒绝已经过去的时间。";
    }

    return undefined;
  }

  const disabledReason = reason();

  function submit() {
    if (endsAt === null || target === null) {
      return;
    }

    // The ABI types the two count fields as `bigint`, and the mirror in
    // `mechanisms.ts` deliberately uses plain `number` — a UI control deals in
    // counts a human typed, and carrying `bigint` through the form state would
    // make every comparison against the input's value awkward. The conversion
    // therefore belongs here, at the boundary where the numbers become calldata,
    // rather than in the shared mirror where it would infect every consumer.
    const config = {
      ...DEFAULT_CONFIG,
      openToAll,
      maxSelections: BigInt(DEFAULT_CONFIG.maxSelections),
      revealWindowSeconds: BigInt(DEFAULT_CONFIG.revealWindowSeconds),
    };

    writeContract({
      address: target.factoryAddress,
      abi: factoryAbi,
      functionName: "createPoll",
      args: [question.trim(), filled, endsAt, config],
    });
  }

  const cidCount = filled.filter((option) => isPlausibleCid(option)).length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/*
        Collapsed by default, and the form's own state is NOT discarded when it
        closes: a reader who fills in three options, collapses the panel to check
        the poll list, and reopens it would otherwise lose everything they typed.
        So this is a `hidden` wrapper rather than conditional rendering — the
        inputs stay mounted and keep their values.

        The panel opens itself when there is something to show: an error from a
        failed attempt must not be invisible behind a collapsed header.
      */}
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-5 py-4 text-left transition hover:bg-slate-50"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-900">发起新投票</span>
          <span className="mt-0.5 block text-xs text-slate-500">
            {expanded
              ? "交易由你自己的钱包签名，后端不持私钥。"
              : "任何人都能创建投票；发起人负责它的白名单与结束。"}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition ${
            expanded ? "" : "bg-slate-50"
          }`}
        >
          {expanded ? "收起" : "展开"}
        </span>
      </button>

      {/*
        `data-create-panel` is what the browser drill toggles: it must be able to
        reach this form in every run, and a click target keyed on Chinese text
        would break the moment the copy is edited.
      */}
      <div
        hidden={!expanded}
        data-create-panel={expanded ? "open" : "closed"}
        className="border-t border-slate-100 px-5 pb-5 pt-4"
      >
        <p className="text-xs leading-relaxed text-slate-500">
          交易由你自己的钱包签名，后端不持私钥；合约会把发起人记成你的地址，之后只有你能维护这个投票的白名单。
        </p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs text-slate-500">问题</span>
            <input
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：社区资金应该先资助哪个提案？"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
          </label>

          <div>
            <span className="text-xs text-slate-500">
              选项（至少 {MIN_OPTIONS} 个；可以填元数据 CID，也可以直接填文字）
            </span>

            <div className="mt-1 space-y-2">
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={option}
                    onChange={(event) =>
                      setOptions((current) =>
                        current.map((value, i) => (i === index ? event.target.value : value)),
                      )
                    }
                    placeholder={index === 0 ? "bafkrei… 或 直接写选项文字" : `选项 ${index + 1}`}
                    aria-label={`选项 ${index + 1}`}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-500"
                  />
                  {options.length > MIN_OPTIONS && (
                    <button
                      type="button"
                      onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                      className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-2 text-xs text-slate-500 transition hover:bg-slate-50"
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setOptions((current) => [...current, ""])}
              className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              + 增加一个选项
            </button>
          </div>

          <label className="block">
            <span className="text-xs text-slate-500">截止时间</span>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              按你本机时区解释，上链时换算成 Unix 时间戳。
            </span>
          </label>

          {/*
          The admission choice, and the one field here that cannot be changed
          afterwards: `openToAll` is fixed at `initialize` and there is no setter.
          Saying so before the transaction is the same discipline the CID hint
          below applies — the reader is about to make a permanent choice, and the
          contract will not let them revise it.
        */}
          <fieldset>
            <legend className="text-xs text-slate-500">谁可以投票</legend>

            <div className="mt-1 space-y-1.5">
              <label className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="radio"
                  name="admission"
                  checked={openToAll}
                  onChange={() => setOpenToAll(true)}
                  className="mt-0.5"
                />
                <span>
                  <strong>所有人可投</strong>
                  <span className="ml-1 text-slate-500">——任何地址都能投，无需你事先添加。</span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="radio"
                  name="admission"
                  checked={!openToAll}
                  onChange={() => setOpenToAll(false)}
                  className="mt-0.5"
                />
                <span>
                  <strong>仅白名单</strong>
                  <span className="ml-1 text-slate-500">
                    ——创建后你要在投票页的管理面板里逐个添加地址，否则没有人能投票。
                  </span>
                </span>
              </label>
            </div>

            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              这个选择在创建时写入合约，<strong>之后无法更改</strong>
              （合约没有对应的修改函数）。要换一种准入方式，只能另建一个投票。
            </p>
          </fieldset>
        </div>

        {/*
        The honesty line. It states what will be written, per option, before the
        transaction — because after it, nothing can correct the value.
      */}
        {filled.length > 0 && (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
            这 {filled.length} 个选项里，有 {cidCount} 个会被登记为
            <strong>元数据 CID</strong>
            （打开投票的人会按 CID 去 IPFS 网关取文档）；另外 {filled.length - cidCount} 个不是 CID
            形状，会被<strong>原样存成选项文字</strong>
            ，没有文档可取。合约不做这个检查，字符串是永久写入的，创建后不可修改。
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={disabledReason !== undefined}
            title={disabledReason}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {txBusy ? "提交中…" : "创建投票"}
          </button>
          {mounted && disabledReason !== undefined && (
            <span className="text-xs text-slate-400">{disabledReason}</span>
          )}
        </div>

        {hash !== undefined && (
          <p className="mt-3 break-all font-mono text-[11px] text-slate-500">
            交易 {hash}
            {receipt.isPending && " · 等待确认…"}
            {receipt.isSuccess && " · 已确认，新投票已出现在下面的列表里"}
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

        {address === undefined && mounted && (
          <p className="mt-2 text-[11px] text-slate-400">连接钱包后这里会显示发起人地址。</p>
        )}
      </div>
    </section>
  );
}
