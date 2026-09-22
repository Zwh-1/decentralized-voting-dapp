// SPDX-License-Identifier: MIT
import Link from "next/link";

import { PageShell } from "@/components/PageShell";
import { PollAdmin } from "@/components/PollAdmin";
import { PollBallot } from "@/components/PollBallot";
import { getConfiguredTarget, getPoll } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import type { PollSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * One poll, at `/poll/<address>`.
 *
 * The route segment is the poll's own address rather than an index into the
 * factory's array. That is the whole point of the factory-per-poll shape: the
 * address is the identifier, it is stable, and it is the same value on every
 * chain this project deploys to — so a link to a poll does not depend on this
 * app's index, on the factory's ordering, or on anything this server holds.
 *
 * A server component, so the poll's question and deadline are in the first paint.
 * Everything the buttons depend on is read in the browser from the poll's own
 * contract (ADR-0009): with a wallet connected, eligibility has to come from the
 * chain the transaction would be signed on, and this server's chain may not be
 * that one (ADR-0019).
 */
export default async function PollPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const configuredTarget = getConfiguredTarget();

  if (!ADDRESS_PATTERN.test(id)) {
    return (
      <PageShell
        title="无效的投票地址"
        subtitle="投票页的地址必须是 20 字节的十六进制合约地址。"
        configuredTarget={configuredTarget}
      >
        <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          路径里的 <code className="font-mono">/poll/[id]</code> 必须是投票合约的地址 （
          <code className="font-mono">0x</code> 加 40 位十六进制），收到的是{" "}
          <code className="font-mono">{id.slice(0, 64)}</code>。
          <br />
          <Link href="/" className="mt-3 inline-block underline">
            ← 回到全部投票
          </Link>
        </section>
      </PageShell>
    );
  }

  const address = id as `0x${string}`;

  let poll: PollSummary | null = null;
  let pollError: string | null = null;

  try {
    poll = await getPoll(address);
  } catch (error) {
    console.error("[poll page] the poll could not be read", error);
    pollError = describeFailure(error);
  }

  return (
    <PageShell
      title={poll?.question ?? "投票"}
      subtitle="投票、改投、撤票都由你的钱包签名。按钮是否可用完全来自链上状态，包括白名单、阶段与截止时间。"
      configuredTarget={configuredTarget}
    >
      <p className="mt-4 text-xs text-slate-400">
        <Link href="/" className="underline">
          ← 全部投票
        </Link>
      </p>

      {/*
        The poll's own read failed. The ballot is still rendered rather than
        replaced by an error page: the browser reads the same contract directly,
        so a server-side RPC outage does not mean the reader cannot vote — it
        means this page cannot state the question before JavaScript runs. Saying
        that is more useful than a page that refuses to load.
      */}
      {pollError !== null && (
        <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-relaxed text-rose-700">
          服务端无法读取这个投票（{address}）：{pollError}
          <br />
          下面仍会尝试用你的浏览器直接读取同一个合约；如果链上确实没有这个地址，各项会显示读取失败。
        </section>
      )}

      <PollBallot
        address={address}
        initial={poll}
        configuredTarget={configuredTarget}
        initialError={pollError}
      />

      {/*
        The creator-only panel, rendered after the ballot. It draws nothing unless
        the connected address IS the poll's creator, so a visitor sees no trace of
        it — but it must be mounted for the creator, because without it the poll
        can never leave `Phase.Setup` and nobody can ever vote in it.
      */}
      <PollAdmin address={address} configuredTarget={configuredTarget} />
    </PageShell>
  );
}
