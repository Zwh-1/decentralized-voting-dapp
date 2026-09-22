"use client";

import { useCandidateMetadata } from "@/hooks/useCandidateMetadata";
import { ShareBar } from "@/components/ui";
import { isRetryableMetadata } from "@/lib/ipfs";
import { isMetadataCid, optionMetadataLabel, optionName } from "@/lib/ballot-labels";
import { sharePercent } from "@/lib/presentation";
import { STAKE, formatEth } from "@/lib/voting";

/**
 * One option of one poll: its label, its tally, and the button that acts on it.
 *
 * The label resolution is the old `CandidateCard`'s logic, kept because the
 * question it answers did not change: the chain stores a metadata CID, the name
 * lives in an IPFS document, and the gateways are unreliable (ADR-0021). What did
 * change is what a failure *means*. The old ballot was seeded by a script, so a
 * malformed CID was a fault in the seed data; `CreatePollForm` now lets a reader
 * type the field, so a non-CID string is an ordinary thing a poll may contain —
 * it is shown as its own text rather than as an error about a document that was
 * never meant to exist. `optionMetadataLabel` and `optionName` own that rule.
 *
 * `action` is what makes the "one control, two chain calls" distinction visible:
 * the same button is 投票 before this address has a vote and 改投 after, which is
 * the operation the previous single-tenant contract could not express at all.
 */
export interface OptionRowProps {
  id: number;
  labelCid: string;
  voteCount: number;
  totalVotes: number;
  /** True when this option is the one the connected address currently backs. */
  isMine: boolean;
  action: "vote" | "change";
  /** Undefined when the action is available. */
  disabledReason: string | undefined;
  isSubmitting: boolean;
  onAct: (kind: "vote" | "change") => void;
}

function share(count: number, total: number): number {
  return sharePercent(count, total);
}

export function OptionRow({
  id,
  labelCid,
  voteCount,
  totalVotes,
  isMine,
  action,
  disabledReason,
  isSubmitting,
  onAct,
}: OptionRowProps) {
  const metadata = useCandidateMetadata(labelCid);

  const name = optionName(id, labelCid, metadata.data);
  const slogan = metadata.data?.status === "ok" ? metadata.data.metadata.slogan : undefined;
  const percent = share(voteCount, totalVotes);
  const enabled = disabledReason === undefined && !isSubmitting;

  return (
    <article
      data-option-mine={isMine ? "true" : "false"}
      className={`flex flex-col rounded-xl border bg-white p-5 shadow-sm transition ${
        isMine ? "border-emerald-400 ring-1 ring-emerald-200" : "border-slate-200"
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold text-slate-900">{name}</h3>
          {slogan !== undefined && <p className="mt-0.5 text-sm text-slate-500">{slogan}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
          #{id}
        </span>
      </header>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-semibold tabular-nums text-slate-900">{voteCount}</span>
          <span className="text-xs tabular-nums text-slate-500">{percent}%</span>
        </div>
        <div className="mt-2">
          <ShareBar percent={percent} tone={isMine ? "mine" : "live"} />
        </div>
      </div>

      <dl className="mt-4 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="shrink-0 text-slate-400">
            {isMetadataCid(labelCid) ? "元数据 CID" : "链上存的字符串"}
          </dt>
          <dd className="truncate font-mono text-slate-600" title={labelCid}>
            {labelCid}
          </dd>
        </div>
        {/*
          The metadata status row. The retry control is a sibling of the <dd>, not
          a child: the drill reads the <dd>'s text as this option's stated outcome,
          and a button inside it would append its own label to that sentence.
        */}
        <div className="flex gap-2">
          <dt className="shrink-0 text-slate-400">IPFS</dt>
          <dd className="text-slate-600">
            {optionMetadataLabel(labelCid, metadata.data, {
              isPending: metadata.isPending,
              isError: metadata.isError,
            })}
          </dd>
          {/*
            Offered only where another attempt could produce a different answer. A
            malformed CID is decided by the shape check before any request, and a
            resolved document is content addressed and can never come back
            different, so neither gets a retry (ADR-0018).
          */}
          {isRetryableMetadata(metadata.data) && (
            <button
              type="button"
              data-metadata-retry="true"
              onClick={() => void metadata.refetch()}
              disabled={metadata.isFetching}
              className="shrink-0 self-start rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {metadata.isFetching ? "重试中…" : "重试"}
            </button>
          )}
        </div>
      </dl>

      <div className="mt-5">
        <button
          type="button"
          data-option-action={action}
          data-option-id={id}
          onClick={() => onAct(action)}
          disabled={!enabled}
          title={disabledReason}
          className={`w-full rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${
            isMine
              ? "border border-emerald-300 bg-emerald-50 text-emerald-800 disabled:opacity-100"
              : "bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300"
          }`}
        >
          {isSubmitting
            ? "提交中…"
            : isMine
              ? "你当前投给了这个选项"
              : action === "change"
                ? "改投到这个选项"
                : `投一票（${formatEth(STAKE)} ETH 押金）`}
        </button>
        {disabledReason !== undefined && !isSubmitting && (
          <p className="mt-2 text-xs text-slate-500">{disabledReason}</p>
        )}
      </div>
    </article>
  );
}
