// SPDX-License-Identifier: MIT
/**
 * One sentence per dependency failure — and never the environment behind it.
 *
 * A thrown viem error carries the request it failed on, verbatim: the endpoint
 * **including its `apiKey`**, the JSON-RPC body and the library version. That text
 * reached the browser through three doors at once — the `message` field of all
 * five `/api/*` routes, `/api/health`'s `indexError`, and the server-rendered
 * banner on the page — so anyone who could open the page could read the
 * operator's RPC endpoint and key by clicking 立即同步索引:
 *
 *     sync iteration failed; retrying {
 *       err: 'The request took too long to respond.\n' +
 *         'URL: https://ethereum-sepolia-rpc.publicnode.com/?apiKey=WP46…\n' +
 *         'Request body: {"method":"eth_blockNumber"}\n' +
 *         'Version: viem@2.56.8'
 *     }
 *
 * Meanwhile `/api/health`'s own comment says the outage "is still visible", and
 * ADR-0012 says a failure must name the party that failed. Both are satisfied by
 * naming the dependency and the variable that configures it; neither needs the
 * endpoint, the key, or a stack of English library text in front of the reader.
 * This is ADR-0016's rule ("give the shape, never the value") applied to error
 * reporting, and the raw error goes to the server log instead.
 *
 * Failures raised by this project's own code are passed through: their messages
 * are deliberate, name the variable at fault, and never echo a value (see
 * `config.ts`), so replacing them would lose the operator's only clue.
 */

import { DEFAULT_LOCALE, translatorFor, type Locale } from "./i18n";

/**
 * What can be safely learned from an arbitrary thrown value.
 *
 * Exported because it is also what `data.ts` STORES. The index-failure record
 * lives for the life of the process and is written once, before any reader
 * exists, so it cannot hold a rendered sentence — that would freeze whichever
 * language was active at the moment of the failure and then serve it to
 * everyone. The shape is stored and rendered per request instead.
 */
export interface FailureShape {
  name: string;
  message: string;
  /** False for a thrown non-Error (a string, an object, a driver's plain value). */
  isError: boolean;
  /** A viem error: it embeds the request URL, body and library version. */
  fromChainClient: boolean;
  /** A MySQL/driver error: it may embed the connection URI and SQL text. */
  fromDatabase: boolean;
  /** The JSON-RPC method that failed, when the error names one. */
  method: string | null;
}

/**
 * Phrases that mean the endpoint could not be reached or did not answer in time.
 *
 * Deliberately narrow. "ECONNREFUSED" is *not* here even though it is the most
 * common refusal: it reads the same whether the database or the RPC node refused,
 * so classifying on that word alone would send the operator to `RPC_URL` while
 * MySQL is what is down. The two drivers each say which they are in a way that
 * cannot be confused — viem's `walk`, and MySQL's `errno`/`sqlMessage` — so the
 * text is only consulted for failures that carry neither.
 */
const UNREACHABLE =
  /took too long|timed out|timeout|fetch failed|http request failed|socket hang up|rate limit|too many requests/i;

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const field = (value as Record<string, unknown>)[key];

  return typeof field === "string" && field.length > 0 ? field : null;
}

function shapeOf(error: unknown): FailureShape {
  if (!(error instanceof Error)) {
    return {
      name: typeof error,
      message: String(error),
      isError: false,
      fromChainClient: false,
      fromDatabase: false,
      method: null,
    };
  }

  const sqlDetail =
    stringField(error, "sqlMessage") ?? stringField(error, "sqlState") ?? stringField(error, "sql");
  const code = stringField(error, "code");
  const errno = (error as { errno?: unknown }).errno;
  const body = /"method"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/.exec(error.message)?.[1] ?? null;

  return {
    name: error.name,
    message: error.message,
    isError: true,
    // Every viem error extends `BaseError`, whose distinguishing method is
    // `walk()`. Checking the shape rather than the class keeps this module
    // dependency-free and survives viem's class renames.
    fromChainClient: typeof (error as { walk?: unknown }).walk === "function",
    fromDatabase:
      sqlDetail !== null || (code !== null && /^ER_/.test(code)) || typeof errno === "number",
    method: body,
  };
}

/** Removes anything that looks like an endpoint or a key, as a safety net. */
function scrub(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "<已隐去的 URL>")
    .replace(/(api[-_]?key=)[^\s&]+/gi, "$1<已隐去>");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";

  return line.trim().slice(0, 300);
}

/**
 * The sentence shown when a chain read fails.
 *
 * Written once and used by both branches that can produce it — a viem error and
 * an unreachable-looking message — because the two must not drift apart: they
 * describe the same condition, and a reader comparing them would see a difference
 * that means nothing.
 *
 * It names BOTH variables now. With `RPC_URLS` configured, any number of
 * endpoints may have been tried and failed, and a message pointing only at
 * `RPC_URL` would send the operator to edit the one endpoint that was probably
 * working. "Every configured endpoint" is the accurate description of what was
 * attempted, and it is true whether one endpoint is configured or five.
 *
 * `{call}` names the JSON-RPC method when the error carried one, and is the empty
 * string otherwise — it is a value, never a sentence, so it is passed through
 * `interpolate` rather than concatenated. Concatenating it is what used to make
 * the two branches possible to get wrong in different ways.
 */
function rpcFailure(call: string, locale: Locale): string {
  return translatorFor(locale).t("failure.rpcUnreachable", { call });
}

/**
 * The sentence to show for a failed dependency read.
 *
 * Guarantees, in order of how much they cost when broken: the result never
 * contains the configured endpoint or key; it names which dependency failed; and
 * a failure that came from a chain call says which JSON-RPC method it was.
 *
 * ---------------------------------------------------------------------------
 * Why this takes a language, and why the LOG does not
 * ---------------------------------------------------------------------------
 *
 * This function is easy to mistake for a logging helper, and it is the opposite
 * of one. The RAW throwable is what goes to the server log (`data.ts` does
 * exactly that, on the line above where it stores this function's result). What
 * this returns is the scrubbed REPLACEMENT for it, and that value has readers:
 * nine `/api/*` routes return it as `message`, `/api/health` publishes it as
 * `indexError` and the health panel renders it, and `/`, `/my` and
 * `/poll/<address>` render it into their server-read failure banners. So every
 * sentence below is translated.
 *
 * The two redaction placeholders are NOT. `<已隐去的 URL>` and `<已隐去>` stand
 * where text was already removed, and they are the marker an operator is told to
 * search for in the log — translating them would mean an English reader searching
 * for a string that the Chinese log line never contained. They are also part of
 * the security guarantee rather than of the copy: `failure.test.ts` asserts that
 * no endpoint survives by looking for exactly these, in both languages.
 */
/**
 * Classifies a failure without rendering it, so the caller can render it later.
 *
 * Named separately from `describeFailure` for the process-level record described
 * on `FailureShape` above: a caller that must remember a failure across requests
 * stores this value and calls `renderFailure` when it finally knows the reader's
 * language.
 */
export function classifyFailure(error: unknown): FailureShape {
  return shapeOf(error);
}

/** Renders a previously classified failure in the reader's language. */
export function renderFailure(shape: FailureShape, locale: Locale = DEFAULT_LOCALE): string {
  const t = translatorFor(locale);
  // The parenthetical names the JSON-RPC method that failed. It is a SENTENCE
  // FRAGMENT built around a value, so it has to be translated too: leaving it
  // Chinese while the sentence around it is English is the half-translated
  // output this whole change exists to remove. The method name itself
  // (`eth_blockNumber`) is data and stays verbatim.
  const call = shape.method === null ? "" : t.t("failure.callSuffix", { method: shape.method });

  // Ordered by how specific the evidence is, not by how common the failure is. A
  // viem error is unambiguous (only viem's `BaseError` has `walk`), and the
  // database driver's `errno`/`sqlMessage` is checked *before* the message hints:
  // a refused connection reads `connect ECONNREFUSED 127.0.0.1:3306` whether it
  // came from MySQL or from `fetch`, so the text alone would send the operator to
  // `RPC_URL` while the database is what is down.
  if (shape.fromChainClient) {
    return rpcFailure(call, locale);
  }

  if (shape.fromDatabase) {
    return t.t("failure.databaseUnreachable");
  }

  if (UNREACHABLE.test(shape.message)) {
    return rpcFailure(call, locale);
  }

  if (!shape.isError) {
    // A thrown non-Error has no message to classify, and `String(value)` would
    // only render as "undefined" or "[object Object]".
    return t.t("failure.unexpected");
  }

  const own = scrub(firstLine(shape.message));

  return own.length > 0 ? own : t.t("failure.unexpectedNamed", { name: shape.name });
}

export function describeFailure(error: unknown, locale: Locale = DEFAULT_LOCALE): string {
  return renderFailure(shapeOf(error), locale);
}
