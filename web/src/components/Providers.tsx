"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { LocaleProvider } from "@/components/LocaleProvider";
import type { Locale } from "@/lib/i18n";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * Client-side providers.
 *
 * The QueryClient is created inside state so it survives re-renders without
 * being shared across requests on the server, which is what makes the cache
 * per-browser rather than per-process.
 *
 * `initialLocale` is threaded through from the root layout rather than read again
 * here, so the first client render agrees with the HTML the server produced.
 * LocaleProvider wraps the wagmi tree because the language applies to everything,
 * including the wallet UI's own labels.
 */
export function Providers({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <LocaleProvider initialLocale={initialLocale}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    </LocaleProvider>
  );
}
