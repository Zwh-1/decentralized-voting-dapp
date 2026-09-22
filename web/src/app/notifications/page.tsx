// SPDX-License-Identifier: MIT
import { PageShell } from "@/components/PageShell";
import { getConfiguredTarget } from "@/lib/data";
import { translatorFor } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/server";

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
 *
 * The language is read on the server like the chain is: this file has no
 * `"use client"`, so `currentLocale()` (the same cookie the root layout reads)
 * decides what the frame says, and the translator travels down to both the shell
 * and the client list so the two cannot disagree.
 */
export default async function NotificationsPage() {
  const t = translatorFor(await currentLocale());
  const configuredTarget = getConfiguredTarget();

  return (
    <PageShell
      title={t.t("notifications.title")}
      subtitle={t.t("notifications.subtitle")}
      configuredTarget={configuredTarget}
      translator={t}
    >
      <NotificationsView />
    </PageShell>
  );
}
