"use client";

import { useAccount, useChainId, useConfig, useReadContracts } from "wagmi";

import { useTranslator } from "@/components/LocaleProvider";
import { useMounted } from "@/hooks/useMounted";
import type { Translator } from "@/lib/i18n";
import { rulesCheck as compareRules, rulesSummary } from "@/lib/trust";
import { pollAbi, resolveChainTarget, shortenAddress, type ChainTarget } from "@/lib/voting";

/**
 * The rules check: whether this poll's rules still match what it promised.
 *
 * ---------------------------------------------------------------------------
 * Why this reads the chain instead of an API route
 * ---------------------------------------------------------------------------
 *
 * `rulesHash` and `currentRulesHash()` are two contract calls, so a reader's own
 * browser can perform the comparison directly against the chain the poll lives
 * on — no index, no server, nothing this deployment could get wrong or lie about.
 * That matters more here than anywhere else in the app: a "the rules are intact"
 * badge served by the same party that could have changed the rules is worth
 * nothing, and the whole point of the panel is that the reader does not have to
 * take this page's word for anything.
 *
 * The two reads go out in one batch so they describe the SAME block. Reading them
 * separately could straddle a block boundary and compare a commitment against a
 * state from a different moment — a torn read that would show a spurious
 * "changed" (ADR-0017).
 *
 * ---------------------------------------------------------------------------
 * What it deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * It does not say the poll is trustworthy, and it does not say a change was
 * wrongdoing. See `rulesSummary` — the wording is the feature, and it lives in a
 * pure module with its own tests.
 */
export function RulesCheck({
  address,
  configuredTarget,
}: {
  address: `0x${string}`;
  configuredTarget: ChainTarget | null;
}) {
  const translator = useTranslator();
  const mounted = useMounted();
  const config = useConfig();
  const { isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  // The poll only exists at this address on the chain it was deployed to, so the
  // read is pinned to that chain rather than the wallet's (ADR-0019).
  const readChain = targetChain === undefined ? {} : { chainId: targetChain.id };

  const reads = useReadContracts({
    contracts: [
      { address, abi: pollAbi, functionName: "rulesHash" as const },
      { address, abi: pollAbi, functionName: "currentRulesHash" as const },
    ],
    ...readChain,
  });

  const committed = hexOrNull(reads.data?.[0]?.result);
  const current = hexOrNull(reads.data?.[1]?.result);

  const check = compareRules({ committed, current });
  const summary = rulesSummary(check);

  return (
    <section
      className={`rounded-xl border p-5 shadow-sm ${
        summary.tone === "ok"
          ? "border-emerald-200 bg-emerald-50/40"
          : summary.tone === "warn"
            ? "border-amber-200 bg-amber-50/40"
            : "border-slate-200 bg-white"
      }`}
      data-testid="rules-check"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2
          className={`text-sm font-semibold ${
            summary.tone === "ok"
              ? "text-emerald-900"
              : summary.tone === "warn"
                ? "text-amber-900"
                : "text-slate-900"
          }`}
        >
          {!mounted ? translator.t("trust.comparing") : summary.title}
        </h2>
        {/*
          The verdict as a machine-readable attribute, so the browser drill can
          check it against the contract's own answer rather than against the
          sentence — which would let a wrong verdict pass by having the right
          wording.
        */}
        <span
          data-rules-verdict={mounted ? check.verdict : "pending"}
          className="shrink-0 rounded-full bg-white/70 px-2.5 py-1 font-mono text-[11px] text-slate-500 ring-1 ring-slate-200"
        >
          {mounted ? check.verdict : "pending"}
        </span>
      </div>

      <p
        className={`mt-1.5 text-xs leading-relaxed ${
          summary.tone === "ok"
            ? "text-emerald-800"
            : summary.tone === "warn"
              ? "text-amber-800"
              : "text-slate-500"
        }`}
      >
        {mounted ? summary.detail : translator.t("trust.readingFingerprint")}
      </p>

      {mounted && (
        <dl className="mt-4 space-y-1.5 text-xs">
          <Fingerprint
            id="committed"
            label={translator.t("trust.fingerprintCommitted")}
            value={check.committed}
            translator={translator}
          />
          <Fingerprint
            id="current"
            label={translator.t("trust.fingerprintCurrent")}
            value={check.current}
            translator={translator}
          />
        </dl>
      )}

      {mounted && reads.isError && (
        <button
          type="button"
          onClick={() => void reads.refetch()}
          data-rules-retry
          className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          {translator.t("common.retry")}
        </button>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
          {translator.t("trust.howComputedTitle")}
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          {translator.t("trust.howComputed", {
            rulesHash: (
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                rulesHash
              </code>
            ) as unknown as string,
            currentRulesHash: (
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                currentRulesHash()
              </code>
            ) as unknown as string,
            // `interpolate` leaves an unfilled placeholder visible, so the
            // emphasis is passed as a value rather than written into the
            // template as markup.
            current: translator.t("trust.howComputedEmphasis"),
          })}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          {translator.t("trust.whitelistSorted")}
        </p>
      </details>
    </section>
  );
}

/**
 * One fingerprint, shown in full so a reader can copy and compare it.
 *
 * `id` is a stable machine-readable name for the row, separate from the
 * translated `label` beside it: the browser drill selects on it, and a selector
 * that changes with the reader's language is a selector that breaks for the
 * readers the translation exists for.
 */
function Fingerprint({
  id,
  label,
  value,
  translator,
}: {
  id: string;
  label: string;
  value: string | null;
  translator: Translator;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd
        className={
          value === null ? "text-slate-400" : "break-all font-mono text-[11px] text-slate-700"
        }
        // A STABLE id, not the translated label.
        //
        // This attribute exists so the browser drill can find the value, and a
        // test hook must not be coupled to copy: keyed on `label`, switching the
        // reader's language changes the attribute and the drill's selector finds
        // nothing. It would fail loudly rather than silently — the drill compares
        // the missing value against the chain's hash — but a test that breaks
        // when someone reads in English is a test that gets deleted rather than
        // fixed. The id is now part of the component's contract, like
        // `data-testid` above, and the label beside it stays translatable.
        data-fingerprint={id}
      >
        {value ?? translator.t("common.notRead")}
      </dd>
    </div>
  );
}

/** A `0x…` string as read, or null when the read did not produce one. */
function hexOrNull(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("0x") ? value : null;
}

/**
 * The stake the creator may take, and when they may take it.
 *
 * ---------------------------------------------------------------------------
 * Why this is on the page at all
 * ---------------------------------------------------------------------------
 *
 * `sweepUnclaimed()` lets a creator take every stake not reclaimed within the
 * grace period after closing. That is the single most consequential rule in this
 * project for a voter — it is the one that can cost them money — and before this
 * panel it appeared nowhere in the interface. A voter had no way to learn that
 * their deposit had a deadline attached.
 *
 * `REFUND_GRACE_PERIOD` is read from the contract rather than hardcoded here, so
 * the number on screen is the number the contract will actually enforce. A UI
 * constant that disagreed with the deployed one would be a polite fiction.
 */
export function StakeRisk({
  address,
  configuredTarget,
}: {
  address: `0x${string}`;
  configuredTarget: ChainTarget | null;
}) {
  const translator = useTranslator();
  const mounted = useMounted();
  const config = useConfig();
  const { isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  const readChain = targetChain === undefined ? {} : { chainId: targetChain.id };

  const reads = useReadContracts({
    contracts: [
      { address, abi: pollAbi, functionName: "totalStaked" as const },
      { address, abi: pollAbi, functionName: "REFUND_GRACE_PERIOD" as const },
      { address, abi: pollAbi, functionName: "votingEndedAt" as const },
      { address, abi: pollAbi, functionName: "creator" as const },
    ],
    ...readChain,
  });

  const totalStaked = bigintOrNull(reads.data?.[0]?.result);
  const gracePeriod = bigintOrNull(reads.data?.[1]?.result);
  const votingEndedAt = bigintOrNull(reads.data?.[2]?.result);
  const creator = typeof reads.data?.[3]?.result === "string" ? reads.data[3].result : null;

  // Nothing staked means nothing can be taken, so the panel says nothing. A
  // warning about a risk of zero is noise, and noise is what teaches people to
  // skip warnings.
  if (mounted && totalStaked === 0n) {
    return null;
  }

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid="stake-risk"
    >
      <h2 className="text-sm font-semibold text-slate-900">{translator.t("trust.stakeTitle")}</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        {translator.t("trust.stakeIntro")}
      </p>

      <dl className="mt-4 space-y-1.5 text-xs">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-slate-500">{translator.t("trust.stakeLocked")}</dt>
          <dd className="font-medium tabular-nums text-slate-900" data-stake-total>
            {totalStaked === null
              ? translator.t("common.loading")
              : `${formatEth(totalStaked)} ETH`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-slate-500">{translator.t("trust.stakeGracePeriod")}</dt>
          <dd className="font-medium text-slate-900">
            {gracePeriod === null
              ? translator.t("common.loading")
              : translator.t("trust.stakeGraceDays", {
                  days: (Number(gracePeriod) / 86400).toString(),
                })}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-slate-500">{translator.t("trust.stakeProgress")}</dt>
          <dd className="text-slate-600">
            {votingEndedAt === null || votingEndedAt === 0n
              ? translator.t("trust.stakeNotEnded")
              : translator.t("trust.stakeEnded")}
          </dd>
        </div>
        {creator !== null && (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-slate-500">{translator.t("trust.stakeSweeper")}</dt>
            <dd className="font-mono text-[11px] text-slate-700" title={creator}>
              {shortenAddress(creator as `0x${string}`)}
            </dd>
          </div>
        )}
      </dl>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
          {translator.t("trust.whyRuleTitle")}
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          {translator.t("trust.whyRule", {
            refund: (
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                refund()
              </code>
            ) as unknown as string,
            sweep: (
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                sweepUnclaimed()
              </code>
            ) as unknown as string,
            gracePeriod: (
              <code className="font-mono text-[11px]">REFUND_GRACE_PERIOD()</code>
            ) as unknown as string,
          })}
        </p>
      </details>
    </section>
  );
}

function bigintOrNull(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null;
}

/** Wei as ETH, without losing precision on the way. */
function formatEth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");

  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
