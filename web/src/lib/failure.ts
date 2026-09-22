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

/** What can be safely learned from an arbitrary thrown value. */
interface FailureShape {
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
 */
function rpcFailure(call: string): string {
  return (
    `链上读取失败${call}：所有已配置的 RPC 端点都未响应（连接失败或请求超时）。` +
    "请检查 web/.env 里的 RPC_URL / RPC_URLS 是否可达；完整错误见服务端日志。"
  );
}

/**
 * The sentence to show for a failed dependency read.
 *
 * Guarantees, in order of how much they cost when broken: the result never
 * contains the configured endpoint or key; it names which dependency failed; and
 * a failure that came from a chain call says which JSON-RPC method it was.
 */
export function describeFailure(error: unknown): string {
  const shape = shapeOf(error);
  const call = shape.method === null ? "" : `（${shape.method} 调用）`;

  // Ordered by how specific the evidence is, not by how common the failure is. A
  // viem error is unambiguous (only viem's `BaseError` has `walk`), and the
  // database driver's `errno`/`sqlMessage` is checked *before* the message hints:
  // a refused connection reads `connect ECONNREFUSED 127.0.0.1:3306` whether it
  // came from MySQL or from `fetch`, so the text alone would send the operator to
  // `RPC_URL` while the database is what is down.
  if (shape.fromChainClient) {
    return rpcFailure(call);
  }

  if (shape.fromDatabase) {
    return "索引数据库（MySQL）不可读或不可写。请检查 web/.env 里的 DATABASE_URL，以及数据库是否在运行；完整错误见服务端日志。";
  }

  if (UNREACHABLE.test(shape.message)) {
    return rpcFailure(call);
  }

  const generic = `未预期的失败（${shape.name}）。完整错误见服务端日志。`;

  if (!shape.isError) {
    // A thrown non-Error has no message to classify, and `String(value)` would
    // only render as "undefined" or "[object Object]".
    return "未预期的失败。完整错误见服务端日志。";
  }

  const own = scrub(firstLine(shape.message));

  return own.length > 0 ? own : generic;
}
