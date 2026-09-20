"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { CandidateCard } from "@/components/CandidateCard";
import { ConsistencyBadge } from "@/components/ConsistencyBadge";
import { WalletBar } from "@/components/WalletBar";
import { useMounted } from "@/hooks/useMounted";
import { fetchHealth, fetchResults, fetchTally } from "@/lib/client-api";
import type { HealthResponse, ResultsResponse, TallyResponse } from "@/lib/types";
import {
  formatEth,
  phaseLabel,
  STAKE,
  votingAbi,
  votingAddressFor,
  VotingPhase,
} from "@/lib/voting";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * The three labels in the 合约状态 panel that describe the tally read.
 *
 * Pure so the "unknown is not zero" rule can be tested without a browser. Every
 * one of these used to collapse three states into two:
 *
 * - the source fell through to `"链上直读"` for a query that had failed, so the
 *   panel claimed a direct chain read while the chain was unreachable;
 * - the total used `?? 0`, announcing "0 votes" when nothing had been read;
 * - the candidate count used `list.length`, announcing "0 candidates" likewise.
 *
 * "We could not find out" is a different claim from "the answer is zero", and the
 * page must not answer the second when it means the first.
 */
export function tallyLabels(query: {
  isPending: boolean;
  isError: boolean;
  source?: "chain" | "index";
  total?: number;
  candidateCount: number;
}): { source: string; total: string; candidates: string } {
  if (query.isError) {
    return { source: "读取失败", total: "—", candidates: "—" };
  }

  if (query.isPending || query.source === undefined) {
    return { source: "读取中…", total: "—", candidates: "—" };
  }

  return {
    source: query.source === "index" ? "MySQL 索引" : "链上直读",
    total: String(query.total ?? 0),
    candidates: String(query.candidateCount),
  };
}

/**
 * A single on-chain read has three outcomes, and the UI needs all three.
 *
 * `hasData` is checked first because a successful read of `0` is still a real
 * answer: `stakeOf` legitimately returns 0 for an address that never voted, and
 * that must stay distinguishable from a read that never completed.
 */
export function readStatus(hasData: boolean, isError: boolean): "ready" | "loading" | "failed" {
  if (hasData) {
    return "ready";
  }
  return isError ? "failed" : "loading";
}

export interface BallotProps {
  /** Prefetched on the server so the first paint already has real data. */
  initialTally: TallyResponse | null;
  initialResults: ResultsResponse | null;
  initialHealth: HealthResponse | null;
  /**
   * Which of the server's three reads failed, and why, or null when all three
   * succeeded.
   *
   * Per-read rather than one flag for the whole page: the reads fail
   * independently, and a single string let a failed comparison read as if the
   * chain itself had been unreadable while the tally beside it came from a
   * successful read.
   */
  initialError: string | null;
}

export function Ballot({ initialTally, initialResults, initialHealth, initialError }: BallotProps) {
  const mounted = useMounted();
  const queryClient = useQueryClient();

  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const deployment = votingAddressFor(chainId);
  const contractAddress = deployment ?? ZERO_ADDRESS;
  const contractKnown = deployment !== undefined;

  // ---- off-chain reads: the projection, or the chain when no index exists ----
  const tally = useQuery({
    queryKey: ["tally"],
    queryFn: ({ signal }) => fetchTally(signal),
    ...(initialTally !== null ? { initialData: initialTally } : {}),
    refetchInterval: 5000,
  });

  const results = useQuery({
    queryKey: ["results"],
    queryFn: ({ signal }) => fetchResults(signal),
    ...(initialResults !== null ? { initialData: initialResults } : {}),
    refetchInterval: 10000,
  });

  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    ...(initialHealth !== null ? { initialData: initialHealth } : {}),
    refetchInterval: 10000,
  });

  // ---- on-chain reads: the source of truth for my own state ----
  const phase = useReadContract({
    address: contractAddress,
    abi: votingAbi,
    functionName: "phase",
    query: { enabled: contractKnown },
  });

  const hasVoted = useReadContract({
    address: contractAddress,
    abi: votingAbi,
    functionName: "hasVoted",
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: contractKnown && address !== undefined },
  });

  const votedFor = useReadContract({
    address: contractAddress,
    abi: votingAbi,
    functionName: "votedFor",
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: contractKnown && address !== undefined },
  });

  const stakeOf = useReadContract({
    address: contractAddress,
    abi: votingAbi,
    functionName: "stakeOf",
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: contractKnown && address !== undefined },
  });

  // `isWhitelisted` is a public mapping getter, so the UI can answer "may this
  // address vote?" from the chain itself. Without it the vote button was enabled
  // for any connected account and only the contract rejected the transaction,
  // which surfaced as a revert instead of a stated reason.
  const whitelisted = useReadContract({
    address: contractAddress,
    abi: votingAbi,
    functionName: "isWhitelisted",
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: contractKnown && address !== undefined },
  });

  // ---- writes ----
  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!receipt.isSuccess) {
      return;
    }

    // The transaction changed on-chain state, so every cached answer is stale.
    void queryClient.invalidateQueries();
  }, [receipt.isSuccess, queryClient]);

  const currentPhase = phase.data === undefined ? undefined : Number(phase.data);
  const votingOpen = currentPhase === VotingPhase.Voting;

  const myCandidateId = votedFor.data === undefined ? undefined : Number(votedFor.data);
  const myStake = stakeOf.data ?? 0n;
  // `?? 0n` above is only safe for arithmetic. Reporting the stake is a different
  // question: a failed `stakeOf` read used to fall through to "没有可取回的押金。",
  // a confident claim about the user's money derived from a request that never
  // completed. `sweepUnclaimed()` hands an unclaimed stake to the owner once the
  // grace period passes, so telling someone they have nothing to reclaim when the
  // balance is merely unknown can cost them the stake.
  const phaseStatus = readStatus(phase.data !== undefined, phase.isError);
  const stakeStatus = readStatus(stakeOf.data !== undefined, stakeOf.isError);
  const whitelistStatus = readStatus(whitelisted.data !== undefined, whitelisted.isError);
  const hasVotedValue = hasVoted.data === true;
  const isWhitelistedValue = whitelisted.data === true;

  const canRefund =
    mounted && isConnected && contractKnown && currentPhase === VotingPhase.Ended && myStake > 0n;

  // Mirrors ADR-0009: a disabled control must say why. The stake is the user's
  // own money and `sweepUnclaimed()` hands an unclaimed stake to the owner after
  // the grace period, so "the button is grey and silent" is the one outcome this
  // path must never produce.
  const refundReason = !contractKnown
    ? `当前链（${chainId}）没有已登记的合约地址，无法取回押金。`
    : !isConnected
      ? "请先连接钱包。"
      : phaseStatus !== "ready"
        ? phaseStatus === "failed"
          ? "读取合约阶段失败，无法判断能否取回押金；请检查 RPC 后重试。"
          : "正在读取合约状态…"
        : currentPhase === VotingPhase.Voting
          ? "投票还在进行中，结束后才能取回押金。"
          : stakeStatus !== "ready"
            ? stakeStatus === "failed"
              ? "读取押金余额失败，无法判断是否有可取回的押金；请检查 RPC 后重试。"
              : "正在读取押金余额…"
            : myStake === 0n
              ? "没有可取回的押金。"
              : undefined;

  const disabledReason = !contractKnown
    ? `当前链（${chainId}）没有已登记的合约地址，无法投票。`
    : !isConnected
      ? "请先连接钱包。"
      : phaseStatus !== "ready"
        ? phaseStatus === "failed"
          ? "读取合约阶段失败，无法判断能否投票；请检查 RPC 后重试。"
          : "正在读取合约状态…"
        : currentPhase === VotingPhase.Setup
          ? "投票尚未开始。"
          : currentPhase === VotingPhase.Ended
            ? "投票已结束，现在可以取回押金。"
            : hasVotedValue
              ? "每个地址只能投一票。"
              : whitelistStatus !== "ready"
                ? whitelistStatus === "failed"
                  ? "读取白名单状态失败，无法判断能否投票；请检查 RPC 后重试。"
                  : "正在读取白名单状态…"
                : whitelisted.data === false
                  ? "这个地址不在白名单里，合约会拒绝投票。"
                  : undefined;

  function vote(candidateId: number) {
    writeContract({
      address: contractAddress,
      abi: votingAbi,
      functionName: "vote",
      args: [BigInt(candidateId)],
      value: STAKE,
    });
  }

  function refund() {
    writeContract({ address: contractAddress, abi: votingAbi, functionName: "refund" });
  }

  async function syncNow() {
    await fetch("/api/index/sync", { method: "POST" });
    await queryClient.invalidateQueries();
  }

  const list = tally.data?.candidates ?? [];
  const totalVotes = tally.data?.total;
  const labels = tallyLabels({
    isPending: tally.isPending,
    isError: tally.isError,
    ...(tally.data?.source !== undefined ? { source: tally.data.source } : {}),
    ...(totalVotes !== undefined ? { total: totalVotes } : {}),
    candidateCount: list.length,
  });

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            去中心化投票 Demo
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            票数与事件由只读索引器投影到 MySQL；候选人元数据存放在 IPFS，链上只保存 CID。
            私钥只存在于你的钱包里。
          </p>
        </div>
        {mounted ? <WalletBar /> : <div className="h-9 w-32" aria-hidden />}
      </header>

      {initialError !== null && (
        <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          服务端有读取失败（下面能读到的数据仍会显示）：
          {initialError}
          <br />
          请确认 <code className="font-mono">web/.env</code> 里的{" "}
          <code className="font-mono">RPC_URL</code> 可达，且目标链上已部署合约、并已执行过{" "}
          <code className="font-mono">pnpm export-abi</code>。
        </section>
      )}

      {/* D1: honesty about what this design does NOT protect. */}
      <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h2 className="text-sm font-semibold text-amber-900">关于隐私：本 Demo 不保护投票隐私</h2>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          这是<strong>公开明票</strong>投票：你会投给谁、以及你投过票这件事，都写在链上并永久可查。
          合约用白名单而不是密码学手段来保证一人一票，合约里的 0.001 ETH 押金
          <strong>不是</strong>女巫攻击防护（它可全额退回，只是一次真实的外部调用），
          真正的准入门槛是管理员维护的白名单——这是有意的取舍，不是遗漏。
        </p>
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <Panel title="合约状态">
          <Row label="阶段">{phaseLabel(currentPhase)}</Row>
          <Row label="合约地址">
            <span className="font-mono text-xs">{contractKnown ? contractAddress : "未登记"}</span>
          </Row>
          <Row label="数据来源">{labels.source}</Row>
          <Row label="票数合计">{labels.total}</Row>
          <Row label="索引高度">
            {health.data === undefined
              ? "读取中…"
              : !health.data.indexConfigured
                ? "未启用"
                : `${health.data.lastIndexedBlock ?? "—"} / 链头 ${health.data.chainHead ?? "—"}`}
          </Row>
          <Row label="落后区块">{health.data?.lagBlocks ?? "—"}</Row>
          {health.data?.indexConfigured === true && health.data.indexerLoopEnabled === false && (
            <p className="mt-2 text-xs text-slate-500">
              后台索引循环已关闭（INDEXER_ENABLED=false），高度不会自行前进；用下面的按钮手动同步。
            </p>
          )}

          {health.data?.indexConfigured === true && (
            <button
              type="button"
              onClick={() => void syncNow()}
              className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              立即同步索引
            </button>
          )}
        </Panel>

        <Panel title="我的状态">
          <Row label="已投票">
            {!mounted ? "—" : hasVotedValue ? "是" : isConnected ? "否" : "未连接"}
          </Row>
          <Row label="投给">
            {myCandidateId === undefined || myCandidateId === 0 ? "—" : `候选人 #${myCandidateId}`}
          </Row>
          <Row label="押金">{mounted && isConnected ? `${formatEth(myStake)} ETH` : "—"}</Row>
          <Row label="白名单">
            {!mounted || !isConnected
              ? "—"
              : whitelisted.data === undefined
                ? "读取中…"
                : whitelisted.data
                  ? "是"
                  : "否"}
          </Row>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={refund}
              disabled={!canRefund}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
            >
              取回押金
            </button>
            {canRefund === false && mounted && refundReason !== undefined && (
              <span className="text-xs text-slate-400">{refundReason}</span>
            )}
          </div>

          {hash !== undefined && (
            <p className="mt-3 break-all font-mono text-[11px] text-slate-500">
              交易 {hash}
              {receipt.isPending && " · 等待确认…"}
              {receipt.isSuccess && " · 已确认"}
            </p>
          )}
          {writeError !== null && (
            <p className="mt-2 text-xs text-rose-600">{writeError.message.split("\n")[0]}</p>
          )}
        </Panel>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">候选人（{labels.candidates}）</h2>
          <ConsistencyBadge
            results={results.data}
            isLoading={results.isPending}
            isError={results.isError}
          />
        </div>

        {tally.isPending && <p className="mt-4 text-sm text-slate-500">正在加载候选人…</p>}

        {tally.isError && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            无法读取候选人列表。请检查 <code className="font-mono">web/.env</code> 的 RPC 配置。
          </div>
        )}

        {tally.isSuccess && list.length === 0 && (
          <p className="mt-4 text-sm text-slate-500">链上还没有候选人。</p>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              // Only reached when `list` is non-empty, which requires tally data,
              // so the total is genuinely known here.
              totalVotes={totalVotes ?? 0}
              canVote={
                votingOpen && isConnected && !hasVotedValue && contractKnown && isWhitelistedValue
              }
              isSubmitting={
                // `receipt.isLoading`, not `receipt.isPending`. wagmi disables the
                // receipt query when there is no hash (`enabled: Boolean(hash && …)`),
                // and a disabled TanStack query still reports `status: "pending"`. So
                // `receipt.isPending` was permanently true until the first transaction
                // was sent — every vote button read "提交中…" and, since the button is
                // disabled while submitting, stayed unclickable even with a wallet
                // connected. `isLoading` is `isPending && isFetching`, i.e. true only
                // while a receipt is genuinely in flight.
                isPending || receipt.isLoading
              }
              isMine={myCandidateId === candidate.id}
              {...(disabledReason !== undefined ? { disabledReason } : {})}
              onVote={vote}
            />
          ))}
        </div>
      </section>

      <footer className="mt-10 border-t border-slate-200 pt-5 text-xs text-slate-400">
        <p>
          已知中心化风险：管理员可维护白名单、可调用{" "}
          <code className="font-mono">sweepUnclaimed()</code>
          取走超过宽限期未被领回的押金；索引器（本 Next 应用内的只读层）是可重建的缓存，
          链上数据才是唯一真相。
        </p>
      </footer>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
      <dl className="mt-2 space-y-1.5 text-sm">{children}</dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{children}</dd>
    </div>
  );
}
