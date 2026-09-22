// SPDX-License-Identifier: MIT
import { PollListView } from "@/components/PollListView";
import type { ChainTarget } from "@/lib/voting";
import type { PollSummary } from "@/lib/types";

export interface PollListProps {
  /** Read on the server, so the first paint already lists the real polls. */
  initialPolls: PollSummary[] | null;
  /**
   * The factory's poll addresses, as the server read them.
   *
   * Typed as plain strings, not as the `` `0x${string}` `` brand `ChainTarget`
   * uses: these cross the server/client boundary as serialised JSON, and a branded
   * type that survives serialisation only by asserting it back is a claim the
   * compiler cannot check. They are validated where they are used — wagmi's own
   * read functions reject a malformed address — so the assertion below is the
   * narrow one, at the boundary, rather than a lie at the type level.
   */
  initialAddresses: string[] | null;
  /**
   * The chain and factory this deployment is configured for, or null when the
   * server's own configuration could not be read.
   *
   * Passed down rather than left to the client to guess, for ADR-0019's reason:
   * `process.env.CHAIN_ID` is server-only, and `useChainId()` answers with the
   * first chain in the browser's own wagmi config when no wallet is connected.
   */
  configuredTarget: ChainTarget | null;
}

/**
 * The poll list, as the pages mount it.
 *
 * ---------------------------------------------------------------------------
 * Why this is a Server Component wrapper and not the list itself
 * ---------------------------------------------------------------------------
 *
 * This file has no `"use client"`, and that is the whole point of it existing.
 * `app/page.tsx` renders `<PollList />` from a Server Component, and a
 * `"use client"` module may only export Client Components — so the moment the
 * list's markup needed `useTranslator()` (a client hook), the module could not
 * stay both things at once.
 *
 * There were three ways out, and this is the one that costs a reader nothing:
 *
 *   * make THIS file client, which would drag the page's own server-rendered
 *     list shell into the client bundle and give up the first paint that lists
 *     real polls before any JavaScript runs;
 *   * read the locale here on the server and pass a translator down as a prop,
 *     which works, but makes the translator part of a prop signature that has
 *     nothing to do with it and puts the language in two owners;
 *   * split the component, which is this.
 *
 * The wrapper is a pass-through: it owns no state, no reads and no strings. It
 * exists so the module path `app/page.tsx` and the tests already use keeps
 * rendering on the server, and so the list's own `data-*` hooks are produced by
 * exactly one component.
 */
export function PollList({ initialPolls, initialAddresses, configuredTarget }: PollListProps) {
  return (
    <PollListView
      initialPolls={initialPolls}
      initialAddresses={initialAddresses}
      configuredTarget={configuredTarget}
    />
  );
}
