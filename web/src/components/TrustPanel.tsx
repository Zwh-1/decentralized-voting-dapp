"use client";

import { useAccount, useChainId, useConfig, useReadContracts } from "wagmi";

import { useMounted } from "@/hooks/useMounted";
import { rulesCheck as compareRules, rulesSummary } from "@/lib/trust";
import { pollAbi, resolveChainTarget, shortenAddress, type ChainTarget } from "@/lib/voting";

/**
 * The rules check: whether this poll's rules still match what it promised.
 *
 * ---------------------------------------------------------------------------
 * Why this reads the chain instead of an API route
 * ---------------------------------------------------------------------------
 *
 * `rulesHash` and `currentRulesHash()` are two contract calls, so a reader's own
 * browser can perform the comparison directly against the chain the poll lives
 * on — no index, no server, nothing this deployment could get wrong or lie about.
 * That matters more here than anywhere else in the app: a "the rules are intact"
 * badge served by the same party that could have changed the rules is worth
 * nothing, and the whole point of the panel is that the reader does not have to
 * take this page's word for anything.
 *
 * The two reads go out in one batch so they describe the SAME block. Reading them
 * separately could straddle a block boundary and compare a commitment against a
 * state from a different moment — a torn read that would show a spurious
 * "changed" (ADR-0017).
 *
 * ---------------------------------------------------------------------------
 * What it deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * It does not say the poll is trustworthy, and it does not say a change was
 * wrongdoing. See `rulesSummary` — the wording is the feature, and it lives in a
 * pure module with its own tests.
 */
export function RulesCheck({
  address,
  configuredTarget,
}: {
  address: `0x${string}`;
  configuredTarget: ChainTarget | null;
}) {
  const mounted = useMounted();
  const config = useConfig();
  const { isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  // The poll only exists at this address on the chain it was deployed to, so the
  // read is pinned to that chain rather than the wallet's (ADR-0019).
  const readChain = targetChain === undefined ? {} : { chainId: targetChain.id };

  const reads = useReadContracts({
    contracts: [
      { address, abi: pollAbi, functionName: "rulesHash" as const },
      { address, abi: pollAbi, functionName: "currentRulesHash" as const },
    ],
    ...readChain,
  });

  const committed = hexOrNull(reads.data?.[0]?.result);
  const current = hexOrNull(reads.data?.[1]?.result);

  const check = compareRules({ committed, current });
  const summary = rulesSummary(check);

  return (
    <section
      className={`rounded-xl border p-5 shadow-sm ${
        summary.tone === "ok"
          ? "border-emerald-200 bg-emerald-50/40"
          : summary.tone === "warn"
            ? "border-amber-200 bg-amber-50/40"
            : "border-slate-200 bg-white"
      }`}
      data-testid="rules-check"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2
          className={`text-sm font-semibold ${
            summary.tone === "ok"
              ? "text-emerald-900"
              : summary.tone === "warn"
                ? "text-amber-900"
                : "text-slate-900"
          }`}
        >
          {!mounted ? "正在比对规则指纹…" : summary.title}
        </h2>
        {/*
          The verdict as a machine-readable attribute, so the browser drill can
          check it against the contract's own answer rather than against the
          sentence — which would let a wrong verdict pass by having the right
          wording.
        */}
        <span
          data-rules-verdict={mounted ? check.verdict : "pending"}
          className="shrink-0 rounded-full bg-white/70 px-2.5 py-1 font-mono text-[11px] text-slate-500 ring-1 ring-slate-200"
        >
          {mounted ? check.verdict : "pending"}
        </span>
      </div>

      <p
        className={`mt-1.5 text-xs leading-relaxed ${
          summary.tone === "ok"
            ? "text-emerald-800"
            : summary.tone === "warn"
              ? "text-amber-800"
              : "text-slate-500"
        }`}
      >
        {mounted ? summary.detail : "正在读取链上的规则指纹…"}
      </p>

      {mounted && (
        <dl className="mt-4 space-y-1.5 text-xs">
          <Fingerprint label="创建时的承诺" value={check.committed} />
          <Fingerprint label="当前状态重算" value={check.current} />
        </dl>
      )}

      {mounted && reads.isError && (
        <button
          type="button"
          onClick={() => void reads.refetch()}
          data-rules-retry
          className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          重试
        </button>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
          这个指纹是怎么算出来的
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          创建时，合约把发起人地址、问题、截止时间、准入方式、选项列表（含每个选项的固定 ID
          与链上字符串）以及白名单，连同合约自身地址与链 ID 一起做哈希，结果写进{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">rulesHash</code>
          ，此后永不改动。
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
            currentRulesHash()
          </code>{" "}
          用同样的方式对<strong>当前</strong>
          状态重算一次。两者相同，说明这些内容自创建以来没有变过；
          不同，说明其中某一项在创建后被改过。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          白名单在计入哈希前会先排序，所以「先加谁后加谁」不会影响结果；
          票数不在哈希范围内——投票不是规则，否则每一个有票的投票都会显示成「被改过」。
        </p>
      </details>
    </section>
  );
}

/** One fingerprint, shown in full so a reader can copy and compare it. */
function Fingerprint({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd
        className={
          value === null ? "text-slate-400" : "break-all font-mono text-[11px] text-slate-700"
        }
        data-fingerprint={label}
      >
        {value ?? "未读到"}
      </dd>
    </div>
  );
}

/** A `0x…` string as read, or null when the read did not produce one. */
function hexOrNull(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("0x") ? value : null;
}

/**
 * The stake the creator may take, and when they may take it.
 *
 * ---------------------------------------------------------------------------
 * Why this is on the page at all
 * ---------------------------------------------------------------------------
 *
 * `sweepUnclaimed()` lets a creator take every stake not reclaimed within the
 * grace period after closing. That is the single most consequential rule in this
 * project for a voter — it is the one that can cost them money — and before this
 * panel it appeared nowhere in the interface. A voter had no way to learn that
 * their deposit had a deadline attached.
 *
 * `REFUND_GRACE_PERIOD` is read from the contract rather than hardcoded here, so
 * the number on screen is the number the contract will actually enforce. A UI
 * constant that disagreed with the deployed one would be a polite fiction.
 */
export function StakeRisk({
  address,
  configuredTarget,
}: {
  address: `0x${string}`;
  configuredTarget: ChainTarget | null;
}) {
  const mounted = useMounted();
  const config = useConfig();
  const { isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  const readChain = targetChain === undefined ? {} : { chainId: targetChain.id };

  const reads = useReadContracts({
    contracts: [
      { address, abi: pollAbi, functionName: "totalStaked" as const },
      { address, abi: pollAbi, functionName: "REFUND_GRACE_PERIOD" as const },
      { address, abi: pollAbi, functionName: "votingEndedAt" as const },
      { address, abi: pollAbi, functionName: "creator" as const },
    ],
    ...readChain,
  });

  const totalStaked = bigintOrNull(reads.data?.[0]?.result);
  const gracePeriod = bigintOrNull(reads.data?.[1]?.result);
  const votingEndedAt = bigintOrNull(reads.data?.[2]?.result);
  const creator = typeof reads.data?.[3]?.result === "string" ? reads.data[3].result : null;

  // Nothing staked means nothing can be taken, so the panel says nothing. A
  // warning about a risk of zero is noise, and noise is what teaches people to
  // skip warnings.
  if (mounted && totalStaked === 0n) {
    return null;
  }

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid="stake-risk"
    >
      <h2 className="text-sm font-semibold text-slate-900">押金的去向</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        投票时押金锁在合约里。投票结束后你可以随时取回；但如果一直不取，发起人有权在规定期限之后取走无人领回的押金。
      </p>

      <dl className="mt-4 space-y-1.5 text-xs">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-slate-500">当前锁在合约里的押金</dt>
          <dd className="font-medium tabular-nums text-slate-900" data-stake-total>
            {totalStaked === null ? "读取中…" : `${formatEth(totalStaked)} ETH`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-slate-500">取回押金的期限（合约常量）</dt>
          <dd className="font-medium text-slate-900">
            {gracePeriod === null ? "读取中…" : `${Number(gracePeriod) / 86400} 天`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-slate-500">进度</dt>
          <dd className="text-slate-600">
            {votingEndedAt === null || votingEndedAt === 0n
              ? "投票尚未结束，期限还没开始计算"
              : "投票已结束，期限正在计算"}
          </dd>
        </div>
        {creator !== null && (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-slate-500">有权取走的人</dt>
            <dd className="font-mono text-[11px] text-slate-700" title={creator}>
              {shortenAddress(creator as `0x${string}`)}
            </dd>
          </div>
        )}
      </dl>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
          为什么会有这条规则
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          押金的作用是让「一人一票」有成本，从而抑制重复投票。投票结束后合约会进入「已结束」阶段，
          此时每个人都可以调用{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">refund()</code>{" "}
          取回自己的押金。若某个地址长期不取，合约允许发起人在上述期限之后调用{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
            sweepUnclaimed()
          </code>{" "}
          把剩余部分取走——这是为了不让资金永久锁死。这条规则写在合约里且不可更改，
          时间长度可以直接调用 <code className="font-mono text-[11px]">REFUND_GRACE_PERIOD()</code>{" "}
          核对。你随时可以取回，不取才会失去。
        </p>
      </details>
    </section>
  );
}

function bigintOrNull(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null;
}

/** Wei as ETH, without losing precision on the way. */
function formatEth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");

  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
