// SPDX-License-Identifier: MIT
import { PageShell } from "@/components/PageShell";
import { getConfiguredTarget } from "@/lib/data";

import { NotificationsView } from "./view";

export const dynamic = "force-dynamic";

/**
 * 我的通知: what has happened in the polls this address follows.
 *
 * A Server Component whose only job is the frame. Everything about the subject of
 * this page — the subscribed address — lives in the browser's wallet, so the list
 * itself has to be read after mount, in `view.tsx`.
 *
 * What the server still contributes is `configuredTarget`: which chain and factory
 * this deployment reads. That is true of the deployment rather than of the reader,
 * and passing it in is what keeps the masthead's chain badge present here. A
 * not-connected reader on this page needs that badge as much as on any other —
 * arguably more, since the whole page is about a wallet, and "which chain is this
 * even talking to" is the first thing they should be able to check.
 */
export default function NotificationsPage() {
  const configuredTarget = getConfiguredTarget();

  return (
    <PageShell
      title="我的通知"
      subtitle="你订阅的投票在上次查看之后发生的事。通知由索引器记录的事件推导得出，不引入邮件或 webhook；订阅只保存在本站，且仅与你的钱包地址关联。"
      configuredTarget={configuredTarget}
    >
      <NotificationsView />
    </PageShell>
  );
}
