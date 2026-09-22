"use client";

import { WalletBar } from "@/components/WalletBar";
import { useMounted } from "@/hooks/useMounted";
import type { ChainTarget } from "@/lib/voting";

/**
 * The wallet control, mounted correctly from a Server Component.
 *
 * This exists because `WalletBar` has no `"use client"` of its own: until the
 * multi-poll rewrite it was only ever rendered from inside `Ballot.tsx`, which is
 * a client component, so the directive was never needed. The new pages are Server
 * Components — deliberately, because they must render with no database and no
 * browser — and rendering `WalletBar` directly from one throws
 * `useConnection is on the client`. Marking *this* file client keeps the fix
 * inside the components the rewrite owns rather than editing a file another
 * worker is responsible for.
 *
 * The mounted gate is the same rule the old `Ballot.tsx` applied: the wallet lives
 * in the browser, so the server cannot know whether one is connected. Rendering
 * the real control only after mount keeps the server HTML and the browser's first
 * render identical (no hydration mismatch), and the placeholder holds the same
 * height so the header does not shift when it swaps in.
 */
export function WalletSlot({ configuredTarget }: { configuredTarget: ChainTarget | null }) {
  const mounted = useMounted();

  if (!mounted) {
    return <div className="h-9 w-32" aria-hidden />;
  }

  return <WalletBar configuredTarget={configuredTarget} />;
}
