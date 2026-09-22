// SPDX-License-Identifier: MIT
import Link from "next/link";

import { PageShell } from "@/components/PageShell";
import { ExecutionPanel } from "@/components/ExecutionPanel";
import { PollActivity } from "@/components/PollActivity";
import { SubscribeButton } from "@/components/SubscribeButton";
import { PollAdmin } from "@/components/PollAdmin";
import { PollBallot } from "@/components/PollBallot";
import { ResultExport } from "@/components/ResultExport";
import { RulesCheck, StakeRisk } from "@/components/TrustPanel";
import { getConfiguredTarget, getPoll } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import { translatorFor } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/server";
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
  const t = translatorFor(await currentLocale());
  const { id } = await params;
  const configuredTarget = getConfiguredTarget();

  if (!ADDRESS_PATTERN.test(id)) {
    return (
      <PageShell
        title={t.t("pollPage.invalidTitle")}
        subtitle={t.t("pollPage.invalidSubtitle")}
        configuredTarget={configuredTarget}
        translator={t}
      >
        <section className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {t.t("pollPage.invalidDetail", {
            // The route segment itself is quoted, never translated: it is the path
            // an operator types, and the address is echoed back so the reader can
            // see exactly what arrived.
            segment: (<code className="font-mono">/poll/[id]</code>) as unknown as string,
            prefix: (<code className="font-mono">0x</code>) as unknown as string,
            received: (<code className="font-mono">{id.slice(0, 64)}</code>) as unknown as string,
          })}
          <br />
          <Link href="/" className="mt-3 inline-block underline">
            {t.t("pollPage.backToPolls")}
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
    pollError = describeFailure(error, t.locale);
  }

  return (
    <PageShell
      title={poll?.question ?? t.t("pollPage.fallbackTitle")}
      subtitle={t.t("pollPage.subtitle")}
      configuredTarget={configuredTarget}
      translator={t}
    >
      <p className="mt-4 text-xs text-slate-400">
        <Link href="/" className="underline">
          {t.t("pollPage.backToPolls")}
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
          {t.t("pollPage.serverReadFailed", { address, error: pollError })}
          <br />
          {t.t("pollPage.browserRetry")}
        </section>
      )}

      <PollBallot
        address={address}
        initial={poll}
        configuredTarget={configuredTarget}
        initialError={pollError}
      />

      {/*
        The two checks a reader can perform without trusting this deployment: did
        the rules change since creation, and what happens to the stake. Both read
        the chain directly from the browser, so neither depends on this server
        being honest about the answer.
      */}
      <div className="mt-6 space-y-6">
        <RulesCheck address={address} configuredTarget={configuredTarget} />
        <StakeRisk address={address} configuredTarget={configuredTarget} />
      </div>

      {/*
        What the vote DECIDED, and what is queued because of it. Placed directly
        under the ballot because it is the answer to the question the ballot asks,
        and above the audit tooling because "did this pass, and did anything
        happen" is what most readers came for.

        The outcome is deliberately NOT passed down from `poll`: this page is a
        server render, so its copy of the verdict is frozen at request time and a
        reader who arrives before the poll closes and stays past the deadline
        would be shown a stale verdict next to live queue state. The panel reads
        `outcome()` from the chain in the browser instead, which is the same rule
        every other control on this page follows (ADR-0009).

        It draws nothing at all for a poll that has not passed and has nothing
        queued, so a visitor sees no trace of governance machinery they cannot use.
      */}
      {poll !== null && ADDRESS_PATTERN.test(poll.creator) && (
        <div className="mt-6">
          <ExecutionPanel
            address={address}
            configuredTarget={configuredTarget}
            creator={poll.creator as `0x${string}`}
          />
        </div>
      )}

      {/*
        Both of these are about checking the result rather than casting one, so
        they sit below the ballot: a reader who came to vote should not have to
        scroll past audit tooling to find the buttons.
      */}
      <div className="mt-6 space-y-6">
        <ResultExport address={address} />
        <PollActivity address={address} />

        {/*
          Below the activity feed, because that is the same information on demand:
          a reader who has just looked at what has happened is the one most likely
          to want to be told next time.
        */}
        <SubscribeButton address={address} />
      </div>

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
