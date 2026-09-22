// SPDX-License-Identifier: MIT
import { MyVotes } from "@/components/MyVotes";
import { PageShell } from "@/components/PageShell";
import { getConfiguredTarget, getPolls } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import { translatorFor } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/server";

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
  const t = translatorFor(await currentLocale());
  const configuredTarget = getConfiguredTarget();

  let addresses: string[] | null = null;
  let listError: string | null = null;

  try {
    addresses = (await getPolls()).map((poll) => poll.address);
  } catch (error) {
    console.error("[my page] the poll list could not be read", error);
    listError = describeFailure(error, t.locale);
  }

  return (
    <PageShell
      title={t.t("my.title")}
      subtitle={t.t("my.subtitle")}
      configuredTarget={configuredTarget}
      translator={t}
    >
      {listError !== null && (
        <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-relaxed text-rose-700">
          {t.t("my.serverListFailed", { error: listError })}
          <br />
          {t.t("my.browserRetry")}
        </section>
      )}

      <MyVotes configuredTarget={configuredTarget} initialAddresses={addresses} />
    </PageShell>
  );
}
