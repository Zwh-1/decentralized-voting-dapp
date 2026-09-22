// SPDX-License-Identifier: MIT
/**
 * Reading the reader's language on the server.
 *
 * A cookie travelled with the request, so the server can render the right
 * language on the FIRST paint instead of shipping the default and correcting it
 * in the browser. That matters for `<html lang>`, for the poll list, and for the
 * audit feed — all of which are rendered on the server and would otherwise flash
 * the wrong language on every navigation.
 *
 * The parsing itself lives in `localeFromCookieHeader`, a pure function, so the
 * cookie grammar can be tested without a request. This wrapper only supplies the
 * header.
 */
import { headers } from "next/headers";

import { localeFromCookieHeader, type Locale } from "./locales";

/** The language for the current request. */
export async function currentLocale(): Promise<Locale> {
  const incoming = await headers();

  return localeFromCookieHeader(incoming.get("cookie"));
}
