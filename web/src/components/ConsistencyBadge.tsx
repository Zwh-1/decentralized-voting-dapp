import type { ReactNode } from "react";

import type { Translator } from "../lib/i18n";
import type { ResultsResponse } from "../lib/types";

interface Props {
  results: ResultsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  /**
   * The active translator, passed in rather than read from a hook.
   *
   * This file has no `"use client"` and must not gain one: the point of the
   * badge is that it renders as part of the server's answer, and the consistency
   * verdict is one of the few claims a reader is meant to be able to check
   * without trusting anything client-side. `useTranslator()` is a client hook, so
   * the translator travels from whoever mounts this — a Client Component that
   * already resolved it — as an ordinary prop.
   *
   * Required rather than defaulted to `translatorFor()`: a default would silently
   * pin this badge to Chinese for every caller that forgot it, which is exactly
   * the half-translated page this change exists to remove.
   */
  translator: Translator;
}

/**
 * Renders the on-chain versus indexed comparison.
 *
 * The point of showing this in the UI is that it is checkable: the badge is
 * green only when the contract's own `results()` agrees with the indexer for
 * every candidate, and it names the candidates that disagree when it does not.
 *
 * `lagging` gets its own wording rather than borrowing the failure one. The
 * indexer holds back recent blocks on purpose, so a red "不一致" during normal
 * confirmation lag would be wrong twice over: it would describe correct
 * behaviour as a fault, and it would make a real divergence look like the same
 * thing.
 */
export function ConsistencyBadge({ results, isLoading, isError, translator }: Props) {
  if (isLoading) {
    return <Badge tone="neutral">{translator.t("consistency.loading")}</Badge>;
  }

  if (isError || results === undefined) {
    return <Badge tone="warn">{translator.t("consistency.unreachable")}</Badge>;
  }

  switch (results.status) {
    case "unavailable":
      return <Badge tone="neutral">{translator.t("consistency.unavailable")}</Badge>;

    case "lagging":
      return (
        <Badge tone="warn">
          {translator.t("consistency.lagging", {
            // `indexedTotal` and `unindexedBlocks` are nullable on the wire
            // while `status` is a string, so a malformed payload can reach these
            // lines. `String(null)` would put a literal "null" on screen inside
            // a sentence that reads as finished; the catalogue's own
            // "unavailable" wording is the honest rendering of that case.
            blocks: results.unindexedBlocks ?? "—",
            onChain: results.onChainTotal,
          })}
        </Badge>
      );

    case "divergent":
      return (
        <Badge tone="bad">
          {translator.t("consistency.divergent", {
            onChain: results.onChainTotal,
            indexed: results.indexedTotal ?? "—",
            count: results.discrepancies.length,
          })}
        </Badge>
      );

    case "consistent":
      return (
        <Badge tone="ok">
          {translator.t("consistency.consistent", {
            onChain: results.onChainTotal,
            indexed: results.indexedTotal ?? "—",
          })}
          {results.pendingVotes > 0
            ? translator.t("consistency.consistentPending", { count: results.pendingVotes })
            : ""}
        </Badge>
      );

    default:
      // An unrecognised status means this bundle is older than the API it is
      // talking to. Naming that beats rendering nothing at all.
      return (
        <Badge tone="warn">
          {translator.t("consistency.unknownStatus", { status: String(results.status) })}
        </Badge>
      );
  }
}

function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "neutral";
  children: ReactNode;
}) {
  const tones = {
    ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    warn: "bg-amber-50 text-amber-700 ring-amber-200",
    bad: "bg-rose-50 text-rose-700 ring-rose-200",
    neutral: "bg-slate-50 text-slate-600 ring-slate-200",
  } as const;

  const dots = {
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    bad: "bg-rose-500",
    neutral: "bg-slate-400",
  } as const;

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ${tones[tone]}`}
    >
      {/*
        The dot repeats what the colour already says, for readers who cannot use
        the colour — and it is the only part of this badge that survives being
        read by someone with a red/green deficiency, since 一致 and 不一致 are the
        same shape and differ only in hue.
      */}
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dots[tone]}`} />
      {children}
    </span>
  );
}
