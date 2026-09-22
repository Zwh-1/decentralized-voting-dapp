// SPDX-License-Identifier: MIT
import Link from "next/link";

import { CreatePollForm } from "@/components/CreatePollForm";
import { PageShell } from "@/components/PageShell";
import { PollList } from "@/components/PollList";
import { getConfiguredTarget, getPolls } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import type { PollSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The poll list: every poll the factory has created.
 *
 * A server component that prefetches the list so the first paint already shows
 * real polls instead of a loading state, and hands it to a client component that
 * re-reads the same function from the browser afterwards. Both halves matter:
 * the prefetch is what makes the page useful before any JavaScript runs, and the
 * client read is what makes it correct a second later.
 *
 * The read is `getPolls()`, which goes to the CHAIN — the factory's `allPolls()`
 * plus one summary per poll. That is the requirement "the app must never depend
 * on MySQL to render" taken literally: this page has no index dependency to fall
 * back from, because it never had one.
 *
 * The failure handling is per-poll, not per-page. `getPolls()` already omits
 * nothing and returns what it could read, so this page distinguishes the two
 * cases that matter and says which one happened:
 *
 *   * the factory itself could not be read — there is no list at all, and the
 *     page says so rather than rendering "no polls exist", which would be a
 *     confident answer to a question that was never answered (ADR-0012);
 *   * a single poll's details could not be read — the poll is still listed, from
 *     the address the factory returned, with its failed read named on the card.
 */
export default async function Home() {
  const configuredTarget = getConfiguredTarget();

  let polls: PollSummary[] | null = null;
  let listError: string | null = null;

  try {
    polls = await getPolls();
  } catch (error) {
    // Logged with the raw error and reported with the classified sentence: the
    // raw one embeds the RPC endpoint and its apiKey (ADR-0020), and this string
    // is server-rendered into a page anyone can load.
    console.error("[page] the poll list could not be read", error);
    listError = describeFailure(error);
  }

  const addresses = polls === null ? null : polls.map((poll) => poll.address);

  return (
    <PageShell
      title="去中心化投票平台"
      subtitle="任何人都可以发起投票；每个投票是独立合约，发起人管理它。你可以投票、改投、撤票并取回押金。选项元数据存放在 IPFS，链上只保存 CID；所有写入都由你自己的钱包签名。"
      configuredTarget={configuredTarget}
    >
      {listError !== null && (
        <section className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-5">
          <h2 className="text-sm font-medium text-rose-800">无法从链上读取投票列表</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-rose-700">{listError}</p>
          <p className="mt-2 text-xs leading-relaxed text-rose-700">
            请确认 <code className="font-mono">web/.env</code> 里的{" "}
            <code className="font-mono">RPC_URL</code> 可达、
            <code className="font-mono">CHAIN_ID</code> 上有已部署的工厂合约，并已执行过{" "}
            <code className="font-mono">pnpm export-abi</code>。
            连接钱包后，下面的列表会直接向你的钱包所在网络重新读取一次。
          </p>
        </section>
      )}

      {/*
        The create form is collapsed by default. It is the tallest thing on the
        page and most readers arriving at a voting site are looking for a poll to
        vote in, not to start one — so the list gets the space and creating is one
        click away. It is still rendered on this page rather than moved behind a
        route, because creating a poll and seeing the list are the same task.
      */}
      <CreatePollForm configuredTarget={configuredTarget} />

      <PollList
        initialPolls={polls}
        initialAddresses={addresses}
        configuredTarget={configuredTarget}
      />

      {/*
        The audit view is linked from here rather than added to the navigation.

        It is a reviewer's tool, not a reader's: it lists raw indexer events across
        every poll. Putting it beside "create" would suggest it is part of the
        normal voting loop, and a reader who opened it looking for a poll would
        find a table of log rows instead. It is reachable, and it states what it
        reads, which is the part that matters.
      */}
      <p className="mt-8 text-xs text-slate-500">
        需要核对链上事件与索引记录？打开{" "}
        <Link href="/audit" className="underline">
          审计视图
        </Link>
        ，可按事件类型、投票合约或地址过滤。该页读取索引，不读取链上实时状态。
      </p>

      {/*
        Beside the audit link rather than in the masthead: both are secondary to
        voting, and a reader who wants one of them is the reader who will read a
        second sentence. The distinction worth stating is that audit is about the
        deployment and notifications are about one wallet — otherwise "audit" and
        "notifications" both look like "things that happened".
      */}
      <p className="mt-2 text-xs text-slate-500">
        只想看你订阅的投票？打开{" "}
        <Link href="/notifications" className="underline">
          我的通知
        </Link>
        ，它按连接的钱包地址列出你订阅的投票在上次查看之后的新事件；不订阅则没有内容可列。
      </p>
    </PageShell>
  );
}
