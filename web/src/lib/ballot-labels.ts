// SPDX-License-Identifier: MIT
/**
 * Every sentence the ballot renders about a read it may not have completed.
 *
 * Pure, and separate from the component, because these are the strings that
 * decide whether the page is telling the truth. Each one takes the *status* of
 * the read it describes, not just its value, so "we could not find out" can never
 * be rendered as "the answer is zero" or as "loading" forever.
 *
 * The family of defects these exist for, in the order they were found:
 *
 *   * 数据来源 claimed `链上直读` for a query that had thrown, and 票数合计
 *     claimed `0` for a query that had never answered;
 *   * 押金 claimed `0 ETH` — a confident statement about the user's own money,
 *     which `sweepUnclaimed()` can hand to the owner — from a failed `stakeOf`;
 *   * 已投票 claimed `否` and 投给 claimed `—` from a `hasVoted`/`votedFor` read
 *     that had not completed, and 白名单 said 读取中… forever once it errored;
 *   * 阶段 said 未知 for all three of "unregistered chain", "read failed" and
 *     "still reading";
 *   * 索引高度 compared the index's cursor with the raw chain head while 落后区块
 *     counts from the *safe* head, so a correct `0` looked like five missing
 *     blocks. See ADR-0009, ADR-0012 and ADR-0019;
 *   * the write path rendered the wallet's own English refusal verbatim —
 *     `User rejected the request.` — which names neither the party that refused
 *     nor what became of the transaction. See ADR-0022.
 */
import type { HealthResponse, SyncResponse } from "./types";
import { isPlausibleCid, type MetadataResult } from "./ipfs";
import { formatEth, phaseLabel } from "./voting";

/**
 * Where a tally's numbers came from, in the words this app uses for it.
 *
 * The one spelling of this claim: `tallyLabels` renders it in the 数据来源 row,
 * and `ResultChart`'s caption and `aria-label` render the same words, because a
 * reader who compares the chart with the text is comparing one claim rather than
 * two. A second ternary somewhere else is how the chart and the numbers start
 * disagreeing about their own provenance.
 *
 * The parameter is written out rather than taking `TallyResponse["source"]` so
 * this module does not import the wire types just for one field name.
 */
export function tallySourceLabel(source: "chain" | "index"): string {
  return source === "index" ? "MySQL 索引" : "链上直读";
}

/**
 * The three labels in the 合约状态 panel that describe the tally read.
 *
 * "We could not find out" is a different claim from "the answer is zero", and the
 * page must not answer the second when it means the first.
 */
export function tallyLabels(query: {
  isPending: boolean;
  isError: boolean;
  source?: "chain" | "index";
  total?: number;
  candidateCount: number;
}): { source: string; total: string; candidates: string } {
  if (query.isError) {
    return { source: "读取失败", total: "—", candidates: "—" };
  }

  if (query.isPending || query.source === undefined) {
    return { source: "读取中…", total: "—", candidates: "—" };
  }

  return {
    source: tallySourceLabel(query.source),
    total: String(query.total ?? 0),
    candidates: String(query.candidateCount),
  };
}

/**
 * A single on-chain read has three outcomes, and the UI needs all three.
 *
 * `hasData` is checked first because a successful read of `0` is still a real
 * answer: `stakeOf` legitimately returns 0 for an address that never voted, and
 * that must stay distinguishable from a read that never completed.
 */
export function readStatus(hasData: boolean, isError: boolean): ReadState {
  if (hasData) {
    return "ready";
  }

  return isError ? "failed" : "loading";
}

export type ReadState = "ready" | "loading" | "failed";

/** One read, rendered as a sentence rather than as a number. */
export function readText<T>(
  state: ReadState,
  value: T | undefined,
  format: (value: T) => string,
): string {
  if (state === "ready" && value !== undefined) {
    return format(value);
  }

  return state === "failed" ? "读取失败" : "读取中…";
}

/**
 * The 阶段 row.
 *
 * Three inputs, not one: an unregistered chain (the read never ran), a failed
 * read, and a read still in flight are three different situations, and the row
 * used to print 未知 for all of them — including for a chain whose contract was
 * never even queried.
 */
export function phaseText(input: {
  contractKnown: boolean;
  status: ReadState;
  phase: number | undefined;
}): string {
  if (!input.contractKnown) {
    return "—";
  }

  if (input.status === "ready" && input.phase !== undefined) {
    return phaseLabel(input.phase);
  }

  return input.status === "failed" ? "读取失败" : "读取中…";
}

export interface MyStatusLabels {
  hasVoted: string;
  votedFor: string;
  stake: string;
  whitelisted: string;
}

/**
 * The four rows of 我的状态.
 *
 * Every row is derived from its own read's status, so a row can only show a
 * concrete value when that value was actually read. 已投票 and 投给 were the last
 * two rows still answering `否` / `—` from a request that had not completed, and
 * 押金 was still answering `0 ETH` through `stakeOf.data ?? 0n`.
 */
export function myStatusLabels(input: {
  mounted: boolean;
  isConnected: boolean;
  contractKnown: boolean;
  hasVoted: { status: ReadState; value: boolean | undefined };
  votedFor: { status: ReadState; value: number | undefined };
  stake: { status: ReadState; value: bigint | undefined };
  whitelisted: { status: ReadState; value: boolean | undefined };
}): MyStatusLabels {
  const blank: MyStatusLabels = { hasVoted: "—", votedFor: "—", stake: "—", whitelisted: "—" };

  if (!input.mounted) {
    return blank;
  }

  if (!input.isConnected) {
    // Not an absence of an answer: there is no address to ask about.
    return { ...blank, hasVoted: "未连接" };
  }

  if (!input.contractKnown) {
    return blank;
  }

  return {
    hasVoted: readText(input.hasVoted.status, input.hasVoted.value, (voted) =>
      voted ? "是" : "否",
    ),
    votedFor: readText(input.votedFor.status, input.votedFor.value, (id) =>
      id === 0 ? "—" : `候选人 #${id}`,
    ),
    stake: readText(input.stake.status, input.stake.value, (wei) => `${formatEth(wei)} ETH`),
    whitelisted: readText(input.whitelisted.status, input.whitelisted.value, (allowed) =>
      allowed ? "是" : "否",
    ),
  };
}

/**
 * What an option's stored string actually is.
 *
 * `Poll` stores a plain `string` per option (`labelCID`, and the factory's
 * parameter is named `optionCIDs`), so **nothing on chain requires it to be a
 * CID**. `CreatePollForm` offers a free-text field, which makes that gap
 * reachable by an ordinary user rather than only by a script: whatever is typed
 * is written into the poll's storage permanently.
 *
 * The reading rule was already decided and is deliberately not reinvented here
 * (ADR-0021, and the same reasoning `CandidateCard` used for the old ballot):
 * the string is treated as a metadata CID exactly when it parses as one, and the
 * raw string is shown otherwise. Calling every non-CID "malformed" would be the
 * wrong sentence — a poll may legitimately have been created over plain text, and
 * `ipfs.ts` refuses a non-CID *shape* before making any request, so a gateway is
 * never asked about one.
 */
export function isMetadataCid(value: string): boolean {
  return isPlausibleCid(value);
}

/**
 * The line a card or option shows about its metadata.
 *
 * Pure and total: every branch names a distinct cause (ADR-0012), the fallback
 * is a sentence rather than an empty string, and the pending case is only
 * reachable while a CID-shaped string is genuinely being fetched. A raw string
 * never renders "读取中…" — it has no document to wait for.
 */
export function optionMetadataLabel(
  cid: string,
  result: MetadataResult | undefined,
  query: { isPending: boolean; isError: boolean },
): string {
  if (!isMetadataCid(cid)) {
    return "不是元数据 CID，显示原文";
  }

  if (result === undefined) {
    if (query.isError) {
      return "读取元数据时发生了未预期的错误";
    }

    return query.isPending ? "读取中…" : "元数据状态未知";
  }

  switch (result.status) {
    case "ok":
      return "已解析";
    case "invalid-cid":
      // Unreachable for a string that passed the shape check, and kept so the
      // union stays exhaustively handled if the two ever disagree.
      return "CID 格式无效，无法解析";
    case "unreachable":
      return `${result.attempts} 个网关均不可达，已降级显示编号`;
    case "no-metadata":
      return `网关可访问（${result.answered}/${result.attempts} 个已作答），但没有返回可用的选项元数据`;
    default: {
      const exhaustive: never = result;

      return exhaustive;
    }
  }
}

/**
 * The name to render for an option.
 *
 * A non-CID string IS the label — that is the whole point of showing it raw
 * rather than numbering the option, which would hide the only human-readable
 * thing the poll has.
 */
export function optionName(id: number, cid: string, result: MetadataResult | undefined): string {
  if (!isMetadataCid(cid)) {
    return cid;
  }

  return result?.status === "ok" ? result.metadata.name : `选项 #${id}`;
}

/** Decimal strings from the API, or null when the value is not one. */
function decimal(value: string | null): bigint | null {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * The 索引高度 row.
 *
 * Compares like with like: the index is only allowed to read up to
 * `chainHead − CONFIRMATIONS`, so that is the height it can have reached. The row
 * used to print the raw chain head next to the index's cursor, which made a
 * correct `落后区块 0` read as a contradiction — measured on Sepolia as
 * `11748968 / 链头 11748973` with `落后区块 0`, five blocks apparently missing.
 * The raw head has its own row now, and it says what the difference is.
 */
export function indexHeightText(health: HealthResponse | undefined): string {
  if (health === undefined) {
    return "读取中…";
  }

  if (!health.indexConfigured) {
    return "未启用";
  }

  const head = decimal(health.chainHead);
  const safe = head === null ? null : head - BigInt(health.confirmations);

  return `${health.lastIndexedBlock ?? "—"} / 安全头 ${
    safe === null || safe < 0n ? "—" : safe.toString()
  }`;
}

/** The 链头 row: the raw head, and the blocks still inside the confirmation window. */
export function chainHeadText(health: HealthResponse | undefined): string {
  if (health === undefined) {
    return "读取中…";
  }

  if (health.chainHead === null) {
    return "—";
  }

  return health.confirmations > 0
    ? `${health.chainHead}（最近 ${health.confirmations} 块待确认）`
    : health.chainHead;
}

/** The 落后区块 row. Never a number when there is no index to be behind. */
export function lagText(health: HealthResponse | undefined): string {
  if (health === undefined) {
    return "读取中…";
  }

  return health.indexConfigured ? (health.lagBlocks ?? "—") : "未启用";
}

/**
 * What one manual sync did.
 *
 * The button used to fire the request and discard the answer, so a 503 from the
 * sync route looked exactly like a successful pass. Each outcome the route can
 * return now has its own sentence, including the one where there is no database.
 */
export function syncSummary(result: SyncResponse): string {
  if (!result.enabled) {
    return result.reason ?? "索引未启用，没有可同步的数据库。";
  }

  switch (result.status) {
    case "synced":
      return `已索引区块 ${result.fromBlock ?? "—"}–${result.toBlock ?? "—"}，读取 ${
        result.seen ?? 0
      } 个事件，写入 ${result.inserted ?? 0} 行。`;
    case "rewound":
      return `检测到链重组，已回退到区块 ${result.toBlock ?? "—"}，被孤立的行已删除。`;
    case "idle":
      return `索引已经追上安全头（${result.lastIndexedBlock ?? "—"}），没有新的可索引区块。`;
    default:
      return "同步完成。";
  }
}

/** What an arbitrary thrown write error looks like to a classifier. */
interface WriteErrorShape {
  /** Every EIP-1193 / JSON-RPC code in the error's cause chain. */
  codes: number[];
  /** Every `name` in the chain, e.g. `UserRejectedRequestError`. */
  names: string[];
  /** Every message-ish string in the chain, joined. */
  message: string;
}

/**
 * Reads the error's *markers*, never just its text.
 *
 * viem wraps: the thing that actually happened (a `ProviderRpcError` with
 * `code: 4001`) sits in `cause`, under one or two `BaseError`s whose own
 * `message` is a paragraph of English. So the chain is walked, bounded at 10
 * links and cycle-safe, collecting codes, names and text from every level.
 *
 * Shape-based rather than `instanceof`, for `failure.ts`'s reason: it keeps this
 * module free of a viem import and survives viem's class renames.
 */
function writeErrorShape(error: unknown): WriteErrorShape {
  const codes: number[] = [];
  const names: string[] = [];
  const texts: string[] = [];
  const seen = new Set<unknown>();

  let node: unknown = error;
  let depth = 0;

  while (typeof node === "object" && node !== null && depth < 10 && !seen.has(node)) {
    seen.add(node);
    const record = node as Record<string, unknown>;

    const code = record.code;
    if (typeof code === "number") {
      codes.push(code);
    } else if (typeof code === "string" && /^-?\d+$/.test(code)) {
      codes.push(Number(code));
    }

    if (typeof record.name === "string") {
      names.push(record.name);
    }

    for (const key of ["shortMessage", "details", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        texts.push(value);
      }
    }

    node = record.cause;
    depth += 1;
  }

  if (!(error instanceof Error) && texts.length === 0) {
    // A thrown non-Error (a string, a plain object) has no chain to walk.
    texts.push(String(error));
  }

  return { codes, names, message: texts.join("\n") };
}

/** A sentence for the reader, and whether the cause was actually identified. */
export interface WriteFailure {
  /** The sentence to render. Never the wallet's or viem's own English. */
  text: string;
  /**
   * False when no branch matched. The caller is expected to put the raw error
   * somewhere retrievable (the browser console) rather than on the page.
   */
  classified: boolean;
}

/** `EIP-1193`'s "the user rejected the request". Returned by every major wallet. */
const USER_REJECTED = 4001;
/** `EIP-1193`'s "a request of this kind is already pending". */
const REQUEST_ALREADY_PENDING = -32002;

/**
 * The sentence for a failed vote or refund — the wallet-facing write path.
 *
 * Before this existed the panel rendered `writeError.message.split("\n")[0]`,
 * which is viem's text: the reported case was a wallet refusal rendering as
 * `User rejected the request.` — English, and silent about the fact that
 * rejecting a signature changes nothing on chain. ADR-0012 requires a failure to
 * name the party that failed; here that party is the wallet, and "nothing was
 * sent" is the fact the reader needs.
 *
 * Each branch names one party and that party's exit: nothing was sent (refused,
 * pending, wrong chain, unaffordable) versus the chain did something and undid it
 * (a revert). Everything else stays unclassified and goes to the console, because
 * a sentence invented for an unrecognised error is a claim with no evidence
 * behind it — the same rule as ADR-0012 and ADR-0020.
 *
 * Deliberately *not* in `failure.ts`: that module owns the sentences for
 * server-side dependency failures (RPC, MySQL) and its evidence is the driver's
 * own markers. This one is about the reader's own wallet, is rendered in the DOM,
 * and its evidence is EIP-1193 codes.
 */
export function describeWriteFailure(error: unknown): WriteFailure {
  const shape = writeErrorShape(error);
  const text = shape.message;

  if (
    shape.codes.includes(USER_REJECTED) ||
    shape.names.some((name) => /UserRejected|UserDenied/i.test(name)) ||
    /user (rejected|denied)|denied (transaction|message) signature|rejected the request/i.test(text)
  ) {
    return { text: "你在钱包里拒绝了这笔交易，链上没有任何变化。", classified: true };
  }

  if (
    shape.codes.includes(REQUEST_ALREADY_PENDING) ||
    /request.*already pending|already pending/i.test(text)
  ) {
    return {
      text: "你的钱包里已经有一个待处理的请求，请先在上面那个弹窗里处理完，再重试；链上没有任何变化。",
      classified: true,
    };
  }

  if (
    shape.names.some((name) =>
      /ChainMismatch|SwitchChain|ChainNotConfigured|ChainDisconnected/i.test(name),
    ) ||
    shape.codes.includes(4902) ||
    /chain mismatch|does not match the (target|current) chain|unrecognized chain/i.test(text)
  ) {
    return {
      text: "钱包所在的网络与页面配置的网络不是同一条链，交易没有发出。请切换钱包网络后重试。",
      classified: true,
    };
  }

  if (
    /insufficient funds|exceeds the balance|insufficient balance/i.test(text) ||
    (shape.codes.includes(-32000) && /funds|balance/i.test(text))
  ) {
    return {
      text: "钱包余额不足以支付押金和网络费，交易没有发出，链上没有任何变化。",
      classified: true,
    };
  }

  if (
    /replacement transaction underpriced|nonce too low|already known|transaction already imported|already known transaction/i.test(
      text,
    )
  ) {
    // The one class where something *may* have reached the chain: "already known"
    // means the node has this transaction, so the reader must not be told that
    // nothing happened.
    return {
      text: "钱包或节点认为这笔交易已经提交过，链上可能已经有一笔相同的交易。请等它确认，或刷新页面查看状态，不要重复提交。",
      classified: true,
    };
  }

  if (
    shape.names.some((name) => /ContractFunction|ExecutionReverted|Reverted/i.test(name)) ||
    /execution reverted|reverted with|reverted:|\bVM Exception\b/i.test(text)
  ) {
    return {
      text: "合约回滚了这笔交易：链上状态没有改变（这笔交易若已被打包，网络费仍会消耗）。",
      classified: true,
    };
  }

  return {
    text: "交易没有完成：钱包或节点返回了一个页面无法归类的错误。原始错误已输出到浏览器控制台。",
    classified: false,
  };
}
