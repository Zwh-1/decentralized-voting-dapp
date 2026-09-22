import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/Providers";
import { currentLocale } from "@/lib/i18n/server";
import { htmlLang } from "@/lib/i18n/locales";
import { messagesFor } from "@/lib/i18n";

import "./globals.css";

/**
 * The document metadata follows the reader's language.
 *
 * It is generated per request rather than exported as a constant, because a
 * constant would freeze whichever language was compiled in — and the whole point
 * of reading the cookie on the server is that the HTML that leaves the server is
 * already in the right one.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await currentLocale();
  const messages = messagesFor(locale);

  return {
    title: messages["app.title"],
    description: messages["app.description"],
    // Safari reads this rather than the manifest when a reader adds the page to
    // their home screen. Both are set from the same two messages, so the app's
    // name cannot differ depending on which browser installed it.
    applicationName: messages["app.title"],
    manifest: "/manifest.json",
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await currentLocale();

  return (
    // `lang` is the reason the cookie is read here rather than in the browser: a
    // screen reader, a search engine and the browser's own font and hyphenation
    // choices all read this attribute from the HTML, without running any script.
    <html lang={htmlLang(locale)}>
      <body>
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
