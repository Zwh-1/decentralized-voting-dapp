// SPDX-License-Identifier: MIT
/**
 * The message catalogue.
 *
 * ---------------------------------------------------------------------------
 * Why `zh.ts` is the shape authority and English must satisfy it
 * ---------------------------------------------------------------------------
 *
 * `ZH_MESSAGES` defines the key set; `Messages` is derived from it; `EN_MESSAGES`
 * is checked against `Messages` by the compiler. So adding a key to the Chinese
 * catalogue is a build error until English answers it, and a key that exists in
 * English but nowhere else cannot be written at all.
 *
 * The alternative — two independent objects plus a test that compares their keys —
 * is the "same rule written in two places" pattern this repository has already
 * been burned by three times (see the plan's batch-one notes). A test can be
 * skipped, run against a stale build, or simply not written for the next key. The
 * compiler cannot.
 *
 * Chinese is the authority because it is the default language and the one every
 * existing assertion is written against. The English file is an addition to it,
 * never a parallel original.
 *
 * ---------------------------------------------------------------------------
 * What belongs here and what does not
 * ---------------------------------------------------------------------------
 *
 * Application chrome: titles, navigation, button labels, table headings. NOT the
 * ballot's rule sentences, which need their own shape and live in
 * `ballot-phrases.ts`; and NOT proper nouns, contract identifiers or error names
 * (`AlreadyVoted`, `startPoll()`), which are quoted as-is in both languages
 * because a reader looks them up in their wallet.
 */

export const ZH_MESSAGES = {
  "app.title": "去中心化投票",
  "app.description":
    "链上投票 dApp：候选人元数据存 IPFS，票数与事件由只读索引器投影到 MySQL，前端实时比对链上与索引两侧是否一致。",

  "nav.polls": "全部投票",
  "nav.myVotes": "我的投票",
  "nav.audit": "审计视图",

  "common.loading": "读取中…",
  "common.retry": "重试",
  "common.previous": "上一页",
  "common.next": "下一页",
  "common.pageOf": "第 {page} / {pageCount} 页",
  "common.back": "返回",

  "language.label": "语言",
  "language.zh": "中文",
  "language.en": "English",
  "language.switchTo": "切换到{language}",

  "list.title": "去中心化投票平台",
  "list.empty": "还没有任何投票。",
  "list.noMatch": "没有匹配的投票",
  "list.searchPlaceholder": "搜索问题或发起人地址",
  "list.matchedOf": "匹配 {matched} / {total} 个投票",
  "list.showing": "显示第 {from}–{to} 个，共 {total} 个",
  "list.sortLabel": "排序",
  "list.sort.newest": "最新截止",
  "list.sort.oldest": "最早截止",
  "list.sort.mostVoted": "票数最多",
  "list.sort.question": "按问题",
  "list.scanTruncated": "链上共有 {total} 个投票，本页只扫描了最新的 {limit} 个。",

  "poll.notFound": "找不到这个投票",
  "poll.unavailable": "无法从链上读取这个投票",
  "poll.question": "问题",
  "poll.creator": "发起人",
  "poll.endsAt": "截止时间",
  "poll.phase": "阶段",
  "poll.totalVotes": "票数合计",
  "poll.turnout": "投票率",
  "poll.turnoutUnknown": "—",

  "audit.title": "审计视图",
  "audit.subtitle":
    "索引器记录过的全部事件，跨所有投票。按事件类型、投票合约或地址过滤。此页读取的是索引，不是链上实时状态——索引与链上是否一致请看每个投票页的一致性标记。",
  "audit.allKinds": "全部",
  "audit.noIndexTitle": "这个部署没有可用的索引",
  "audit.empty": "索引里没有符合当前过滤条件的事件。",
  "audit.kind": "类型",
  "audit.poll": "投票",
  "audit.actor": "地址",
  "audit.detail": "详情",
  "audit.block": "区块",
  "audit.tx": "交易",
} as const;

/**
 * The key set, derived from the Chinese catalogue.
 *
 * `readonly` because a catalogue is not a place to mutate at runtime, and the
 * mapped type is what makes a missing English key a compile error rather than an
 * empty label on screen.
 */
export type Messages = { readonly [K in keyof typeof ZH_MESSAGES]: string };

/** A key in the catalogue. */
export type MessageKey = keyof Messages;

export const EN_MESSAGES = {
  "app.title": "Decentralized Voting",
  "app.description":
    "An on-chain voting dApp: candidate metadata lives on IPFS, votes and events are projected into MySQL by a read-only indexer, and the front end compares the chain and the index against each other.",

  "nav.polls": "All polls",
  "nav.myVotes": "My votes",
  "nav.audit": "Audit view",

  "common.loading": "Reading…",
  "common.retry": "Retry",
  "common.previous": "Previous",
  "common.next": "Next",
  "common.pageOf": "Page {page} of {pageCount}",
  "common.back": "Back",

  "language.label": "Language",
  "language.zh": "中文",
  "language.en": "English",
  "language.switchTo": "Switch to {language}",

  "list.title": "Decentralized voting platform",
  "list.empty": "There are no polls yet.",
  "list.noMatch": "No polls match",
  "list.searchPlaceholder": "Search the question or the creator's address",
  "list.matchedOf": "{matched} of {total} polls match",
  "list.showing": "Showing {from}–{to} of {total}",
  "list.sortLabel": "Sort",
  "list.sort.newest": "Latest deadline",
  "list.sort.oldest": "Earliest deadline",
  "list.sort.mostVoted": "Most voted",
  "list.sort.question": "By question",
  "list.scanTruncated":
    "There are {total} polls on chain; this page scanned only the newest {limit}.",

  "poll.notFound": "This poll was not found",
  "poll.unavailable": "This poll could not be read from the chain",
  "poll.question": "Question",
  "poll.creator": "Creator",
  "poll.endsAt": "Deadline",
  "poll.phase": "Phase",
  "poll.totalVotes": "Total votes",
  "poll.turnout": "Turnout",
  "poll.turnoutUnknown": "—",

  "audit.title": "Audit view",
  "audit.subtitle":
    "Every event the indexer recorded, across all polls. Filter by event kind, poll contract or address. This page reads the INDEX, not live chain state — for whether the index matches the chain, see the consistency marker on each poll page.",
  "audit.allKinds": "All",
  "audit.noIndexTitle": "This deployment has no usable index",
  "audit.empty": "The index holds no events matching these filters.",
  "audit.kind": "Kind",
  "audit.poll": "Poll",
  "audit.actor": "Address",
  "audit.detail": "Detail",
  "audit.block": "Block",
  "audit.tx": "Transaction",
} satisfies Messages;
