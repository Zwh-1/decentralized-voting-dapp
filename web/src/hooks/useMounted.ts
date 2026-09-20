"use client";

import { useEffect, useState } from "react";

/**
 * True only after the first client render.
 *
 * Wallet state lives in the browser (localStorage, injected provider), so the
 * server cannot know it. Rendering wallet-dependent UI only after mount keeps
 * the server HTML and the first client render identical, which is what avoids a
 * hydration mismatch.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted;
}
