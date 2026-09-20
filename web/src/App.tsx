import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { CandidateCard } from "./components/CandidateCard.js";
import { ConsistencyBadge } from "./components/ConsistencyBadge.js";
import { WalletBar } from "./components/WalletBar.js";
import { fetchCandidates, fetchHealth, fetchResults } from "./lib/api.js";
import {
  formatEth,
  phaseLabel,
  STAKE,
  votingAbi,
  votingAddressFor,
  VotingPhase,
} from "./lib/voting.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function App() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const deployment = votingAddressFor(chainId);
  const contractAddress = deployment ?? ZERO_ADDRESS;
  const contractKnown = deployment !== undefined;

  // ---- off-chain reads (the indexed projection) ----
  const candidates = useQuery({
    queryKey: ["candidates"],
    queryFn: ({ signal }) => fetchCandidates(signal),
    refetchInterval: 5000,
  });

  const results = useQuery({
    queryKey: ["results"],
    queryFn: ({ signal }) => fetchResults(signal),
    refetchInterval: 10000,
  });

  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 10000,
  });

  // ---- on-chain reads (the source of truth) ----
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

  // ---- writes ----
  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (receipt.isSuccess) {
      void candidates.refetch();
      void results.refetch();
      void hasVoted.refetch();
      void votedFor.refetch();
      void stakeOf.refetch();
    }
    // `refetch` identities are stable in react-query; re-running on every render
    // would refetch in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  const currentPhase = phase.data === undefined ? undefined : Number(phase.data);
  const votingOpen = currentPhase === VotingPhase.Voting;

  const myCandidateId = votedFor.data === undefined ? undefined : Number(votedFor.data);
  const myStake = stakeOf.data ?? 0n;
  const hasVotedValue = hasVoted.data === true;

  // A refund is only possible once the ballot has ended and there is something
  // left to return.
  const canRefund =
    isConnected && contractKnown && currentPhase === VotingPhase.Ended && myStake > 0n;

  const disabledReason = !contractKnown
    ? `当前链（${chainId}）没有已登记的合约地址，无法投票。`
    : !isConnected
      ? "请先连接钱包。"
      : currentPhase === undefined
        ? "正在读取合约状态…"
        : currentPhase === VotingPhase.Setup
          ? "投票尚未开始。"
          : currentPhase === VotingPhase.Ended
            ? "投票已结束，现在可以取回押金。"
            : hasVotedValue
              ? "每个地址只能投一票。"
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
    writeContract({
      address: contractAddress,
      abi: votingAbi,
      functionName: "refund",
    });
  }

  const list = candidates.data?.candidates ?? [];
  const totalVotes = candidates.data?.total ?? 0;

  return (
    <div className="mx-auto max-w-5xl px-5 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            去中心化投票 Demo
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            票数与事件通过只读索引器投影到 MySQL；候选人元数据存放在 IPFS，链上只保存 CID。
            私钥只存在于你的钱包里。
          </p>
        </div>
        <WalletBar />
      </header>

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
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">合约状态</h2>
          <dl className="mt-2 space-y-1.5 text-sm">
            <Row label="阶段">{phaseLabel(currentPhase)}</Row>
            <Row label="合约地址">
              <span className="font-mono text-xs">
                {contractKnown ? contractAddress : "未登记"}
              </span>
            </Row>
            <Row label="票数合计（索引）">{totalVotes}</Row>
            <Row label="索引高度">
              {health.data === undefined
                ? "—"
                : `${health.data.lastIndexedBlock ?? "—"} / 链头 ${health.data.chainHead ?? "—"}`}
            </Row>
            <Row label="落后区块">{health.data?.lagBlocks ?? "—"}</Row>
          </dl>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">我的状态</h2>
          <dl className="mt-2 space-y-1.5 text-sm">
            <Row label="已投票">{hasVotedValue ? "是" : isConnected ? "否" : "未连接"}</Row>
            <Row label="投给">
              {myCandidateId === undefined || myCandidateId === 0
                ? "—"
                : `候选人 #${myCandidateId}`}
            </Row>
            <Row label="押金">{isConnected ? `${formatEth(myStake)} ETH` : "—"}</Row>
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={refund}
              disabled={!canRefund}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
            >
              取回押金
            </button>
            {isConnected && currentPhase === VotingPhase.Ended && myStake === 0n && (
              <span className="text-xs text-slate-400">没有可取回的押金</span>
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
        </div>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">候选人（{list.length}）</h2>
          <ConsistencyBadge
            results={results.data}
            isLoading={results.isPending}
            isError={results.isError}
          />
        </div>

        {candidates.isPending && <p className="mt-4 text-sm text-slate-500">正在加载候选人…</p>}

        {candidates.isError && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            索引 API 不可达。请确认索引器已启动（
            <code className="font-mono">pnpm --filter @voting/indexer start</code>）。
          </div>
        )}

        {candidates.isSuccess && list.length === 0 && (
          <p className="mt-4 text-sm text-slate-500">链上还没有候选人。</p>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              totalVotes={totalVotes}
              canVote={votingOpen && isConnected && !hasVotedValue && contractKnown}
              isSubmitting={isPending || receipt.isPending}
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
          取走超过宽限期未被领回的押金；索引器是可重建的缓存，链上数据才是唯一真相。
        </p>
      </footer>
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
