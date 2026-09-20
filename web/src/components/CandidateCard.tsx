import type { ApiCandidate } from "../lib/types";
import { useCandidateMetadata } from "../hooks/useCandidateMetadata";

interface Props {
  candidate: ApiCandidate;
  totalVotes: number;
  canVote: boolean;
  isSubmitting: boolean;
  isMine: boolean;
  disabledReason?: string;
  onVote: (id: number) => void;
}

function share(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

export function CandidateCard({
  candidate,
  totalVotes,
  canVote,
  isSubmitting,
  isMine,
  disabledReason,
  onVote,
}: Props) {
  const metadata = useCandidateMetadata(candidate.metadataCid);

  const name =
    metadata.data?.status === "ok" ? metadata.data.metadata.name : `候选人 #${candidate.id}`;

  const slogan = metadata.data?.status === "ok" ? metadata.data.metadata.slogan : undefined;

  const percent = share(candidate.voteCount, totalVotes);

  return (
    <article
      className={`flex flex-col rounded-xl border bg-white p-5 shadow-sm transition ${
        isMine ? "border-emerald-400 ring-1 ring-emerald-200" : "border-slate-200"
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-900">{name}</h3>
          {slogan !== undefined && <p className="mt-0.5 text-sm text-slate-500">{slogan}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
          #{candidate.id}
        </span>
      </header>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-semibold tabular-nums text-slate-900">
            {candidate.voteCount}
          </span>
          <span className="text-xs tabular-nums text-slate-500">{percent}%</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-slate-900 transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <dl className="mt-4 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="shrink-0 text-slate-400">元数据 CID</dt>
          <dd className="truncate font-mono text-slate-600" title={candidate.metadataCid}>
            {candidate.metadataCid}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-slate-400">IPFS</dt>
          <dd className="text-slate-600">
            {metadata.isPending && "读取中…"}
            {metadata.data?.status === "ok" && `已解析`}
            {metadata.data?.status === "invalid-cid" && "CID 格式无效，无法解析"}
            {metadata.data?.status === "unreachable" &&
              `${metadata.data.attempts} 个网关均不可达，已降级显示编号`}
          </dd>
        </div>
      </dl>

      <div className="mt-5">
        <button
          type="button"
          onClick={() => onVote(candidate.id)}
          disabled={!canVote || isSubmitting}
          title={disabledReason}
          className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isMine ? "你已投给该候选人" : isSubmitting ? "提交中…" : "投一票（0.001 ETH 押金）"}
        </button>
        {!canVote && disabledReason !== undefined && (
          <p className="mt-2 text-xs text-slate-500">{disabledReason}</p>
        )}
      </div>
    </article>
  );
}
