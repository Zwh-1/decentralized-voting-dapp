// SPDX-License-Identifier: MIT
import { MyVotes } from "@/components/MyVotes";
import { PageShell } from "@/components/PageShell";
import { getConfiguredTarget, getPolls } from "@/lib/data";
import { describeFailure } from "@/lib/failure";

export const dynamic = "force-dynamic";

/**
 * 我的投票: what this address created, and what it has a vote in.
 *
 * Both lists need the connected address, which the server cannot know — it lives
 * in the browser's wallet — so this page's own work is only the part that does not
 * need it: the list of poll addresses the scan will run against, so the client
 * does not have to fetch the factory's array before it can start.
 *
 * A server-side failure here is not fatal to the page. The client re-reads
 * `allPolls()` from the browser anyway, so the honest thing is to report the
 * server's failure and let the browser try, rather than render a page that claims
 * there is nothing to show.
 */
export default async function MyPolls() {
  const configuredTarget = getConfiguredTarget();

  let addresses: string[] | null = null;
  let listError: string | null = null;

  try {
    addresses = (await getPolls()).map((poll) => poll.address);
  } catch (error) {
    console.error("[my page] the poll list could not be read", error);
    listError = describeFailure(error);
  }

  return (
    <PageShell
      title="我的投票"
      subtitle="列出你这个地址发起的投票，以及你当前持有票的投票。两个列表都直接读链：链上记录了谁创建了哪个投票，而「我投过哪些」只能逐个投票读 voterState，因此有扫描上限。"
      configuredTarget={configuredTarget}
    >
      {listError !== null && (
        <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-relaxed text-rose-700">
          服务端读取投票列表失败：{listError}
          <br />
          下面的列表仍会尝试由你的浏览器直接读取工厂合约。
        </section>
      )}

      <MyVotes configuredTarget={configuredTarget} initialAddresses={addresses} />
    </PageShell>
  );
}
