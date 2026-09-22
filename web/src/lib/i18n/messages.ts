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
  "common.refreshing": "刷新中…",
  "common.refreshingShort": "刷新中",
  "common.expand": "展开",
  "common.collapse": "收起",
  "common.connecting": "连接中…",
  "common.notRead": "未读到",

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
  "list.heading": "全部投票",
  "list.headingCount": "全部投票（{count}）",
  "list.searchLabel": "搜索投票",
  "list.searchInputPlaceholder": "搜索问题、发起人或合约地址…",
  "list.searchClear": "清除",
  "list.searchClearLabel": "清除搜索",
  "list.searchNoMatch": "没有匹配「{query}」的投票",
  "list.pageLabel": "投票列表分页",
  "list.unlistableTitle": "无法列出投票",
  "list.noFactory": "当前链（{chainId}，{chainName}）没有已登记的工厂地址，无法列出投票。",
  "list.factoryReadFailed":
    "读取工厂的投票列表失败：链上调用没有成功。请检查钱包所在网络的 RPC 后重试。",
  "list.factoryPending": "正在读取链上投票列表…",
  "list.connectedCount": "（{count}）",
  "list.emptyTitle": "还没有任何投票",
  "list.emptyDescription":
    "工厂合约还没有创建过投票。用页面顶部的「发起新投票」建第一个——创建者可以在开始前调整选项与白名单。",
  "list.noMatchDescription":
    "没有投票符合「{query}」。搜索会匹配问题、发起人地址与合约地址的开头部分。",
  "myVotes.createdTitle": "我发起的投票",
  "myVotes.createdDescription":
    "来自工厂的 {call}，因此这份列表是完整的：链上记录了谁创建了哪个投票。",
  "myVotes.connectFirst": "请先连接钱包。",
  "myVotes.noFactory":
    "当前链（{chainId}，{chainName}）没有已登记的工厂合约，无法列出你发起的投票。",
  "myVotes.createdReadFailed": "读取 pollsByCreator 失败：链上调用没有成功。请检查 RPC 后重试。",
  "myVotes.createdEmptyTitle": "你还没有发起过投票",
  "myVotes.createdEmptyDescription":
    "在「全部投票」页可以发起新投票；创建者会成为该投票的合约所有者，负责它的白名单与结束。",
  "myVotes.createdNote": "由你发起",
  "myVotes.votedTitle": "我投过的投票",
  "myVotes.votedFromIndex":
    "来自本应用的只读索引（{view} 视图，由链上事件推导）。链上没有「某人投过哪些投票」的反查接口，所以这个问题只有索引能在一次查询里答完；只有当前确实持有一票的投票会出现，已经撤票的不会。",
  "myVotes.votedFromChain":
    "没有可用的索引，所以这份列表是逐个投票读 {call} 得到的：只有当前确实持有一票的投票会出现， 已经撤票的不会。链上共有多少投票就要读多少次，因此下面只扫描最新的一部分。",
  "myVotes.scanTruncated":
    "链上共有 {total} 个投票，本页只扫描了最新的 {limit} 个（逐票读取的代价随投票数线性增长，全部扫描会让页面变慢）。更早的投票可能里也有你投过的，本页不会显示；可以直接在{link}里查看。",
  "myVotes.listAllPolls": "全部投票",
  "myVotes.noPollsTitle": "工厂还没有创建过任何投票",
  "myVotes.noPollsDescription": "链上一个投票都没有，所以这里没有什么可以列举。",
  "myVotes.queryingIndex": "正在向索引查询你持有的票…",
  "myVotes.indexFailed": "索引查询失败，改为逐个读取链上状态。",
  "myVotes.scanning": "正在逐个读取 {count} 个投票…（读到的第一个结果就会出现在这里）",
  "myVotes.scanFailed": "逐个读取投票状态时链上调用失败。请检查 RPC 后重试。",
  "myVotes.holdNoneIndexed": "你目前没有在任何投票里持有一票。",
  "myVotes.holdNoneNothingScanned": "没有可扫描的投票。",
  "myVotes.holdNoneScanned": "你在扫描到的投票里目前没有持有任何一票。",
  "myVotes.line": "我投过 · {phase}",
  "myVotes.lineWithVotes": "我投过 · {phase} · {votes} 票",
  "myVotes.lineReading": "我投过 · 阶段读取中…",
  "myVotes.currentAddress": "当前地址 {address}，读取的是{chainName}（{chainId}）。",

  "poll.notFound": "找不到这个投票",
  "poll.unavailable": "无法从链上读取这个投票",
  "poll.question": "问题",
  "poll.creator": "发起人",
  "poll.endsAt": "截止时间",
  "poll.phase": "阶段",
  "poll.totalVotes": "票数合计",
  "poll.turnout": "投票率",
  "poll.turnoutUnknown": "—",
  "poll.creatorInline": "发起人",
  "poll.votedSoFar": "已投 {count} 票",
  "poll.optionCount": "{count} 个选项",
  "poll.statOptionCount": "选项数",
  "poll.statTotalVotes": "当前票数",
  "poll.statStake": "投票押金",
  "poll.stakeRefundable": "可退回",
  "poll.goVote": "去投票 →",
  "poll.viewDetail": "查看详情 →",
  "poll.cardReadFailed": "这个投票的链上信息读取失败",
  "poll.cardReadFailedDetail":
    "这个地址来自工厂的 {call}，所以投票确实存在，失败的是它的详情读取。",
  "poll.retryAfterNetworkCheck": "请检查钱包所在网络的 RPC 后重试。",
  "poll.retryAfterRpcCheck": "请检查 RPC 后重试。",
  "poll.stillOpen": "仍然打开这个投票 →",

  /*
    The poll-detail ballot's own chrome.

    ---------------------------------------------------------------------------
    Why these are chrome and not `BallotPhrases`
    ---------------------------------------------------------------------------

    `ballot-phrases.ts` owns the sentences that explain WHY a control is
    disabled — the clauses `ballot-reasons.ts` selects between, which follow the
    contract's own check order and which a translation must never be able to
    reorder. What is here instead is the fixed furniture around them: the row
    labels of 我的状态, the stat labels, and the button captions.

    ---------------------------------------------------------------------------
    Why the stat labels reuse the `poll.*` keys rather than restating them
    ---------------------------------------------------------------------------

    阶段 and 票数合计 are the same two words the list card and the poll page
    already render, and `i18n.test.ts` fails when one sentence appears under two
    names. A `ballot.statPhase` holding 阶段 would be exactly that second name,
    so the ballot reads `poll.phase` and `poll.totalVotes` instead: one spelling
    of a label, whichever surface renders it.

    选项数 is deliberately NOT one of those. The card's `poll.statOptionCount`
    reads 选项数 for a COUNT, while the ballot's row of the same name is a
    static descriptor beside the actual number, so the two are different strings
    that merely happen to share two characters today. They stay separate keys.
  */
  "ballot.serverReadFailedTitle": "服务端读取这个投票时失败了",
  "ballot.serverReadFailedDetail": "下面能读到的数据仍会显示：{error}",
  "ballot.questionReadFailed": "读取问题失败",
  "ballot.readingPoll": "正在读取投票…",
  "ballot.statOptionCount": "选项数",
  /** The one stat whose value is the reader's own money; see `myStatusLabels`. */
  "ballot.statStake": "押金",
  "ballot.contract": "合约",
  "ballot.deadlineReadFailed": "截止时间读取失败",
  "ballot.readingDeadline": "正在读取截止时间…",
  "ballot.deadlinePassed": "已过截止时间（{time}）",
  "ballot.deadline": "截止 {time}",
  "ballot.pastDeadlineOpenPhase":
    "已过截止时间，但合约仍处于「投票中」：投票、改投、撤票都会被合约拒绝，而押金要等投票正式关闭后才能取回。这个关闭调用",
  "ballot.pastDeadlineOpenPhaseEmphasis": "不需要权限",
  "ballot.pastDeadlineOpenPhaseTail": "，任何人都可以发起——包括你。",
  "ballot.closePoll": "关闭这个投票（任何人都可以）",
  "ballot.myStatus": "我的状态",
  "ballot.canVote": "可投票",
  "ballot.admissionMode": "准入方式",
  "ballot.openToAll": "所有人可投",
  "ballot.whitelist": "白名单",
  "ballot.hasVoted": "已投票",
  "ballot.votedFor": "投给",
  "ballot.withdrawVote": "撤票（退回押金）",
  "ballot.reclaimStake": "取回押金",
  "ballot.transaction": "交易",
  "ballot.awaitingConfirmation": " · 等待确认…",
  "ballot.confirmed": " · 已确认",
  "ballot.options": "选项",
  /** `{count}`. The parenthesised count after the 选项 heading. */
  "ballot.optionsCount": "（{count}）",
  "ballot.readingOptions": "正在读取选项…",
  "ballot.optionsReadFailed": "读取选项列表失败：链上调用没有成功。请检查 RPC 后重试。",
  "ballot.noOptions": "这个投票还没有任何选项。",

  "countdown.deadline": "截止 {time}",
  "countdown.closedAt": "已于 {time} 截止（已关闭）",
  "countdown.remaining": "还剩 {remaining}（截止 {absolute}）",
  "countdown.lessThanMinute": "不到 1 分钟",
  "countdown.daysHours": "{days} 天 {hours} 小时",
  "countdown.hoursMinutes": "{hours} 小时 {minutes} 分钟",
  "countdown.minutes": "{minutes} 分钟",

  "consistency.loading": "正在比对链上与索引结果…",
  "consistency.unreachable": "无法比对（索引 API 不可达）",
  "consistency.unavailable": "未启用索引 · 数字直接来自链上",
  "consistency.lagging": "索引落后 {blocks} 个区块 · 链上 {onChain} 票，暂不比对",
  "consistency.divergent": "链上 {onChain} 票 ≠ 索引 {indexed} 票 · {count} 处偏差",
  "consistency.consistent": "链上与索引一致 · {onChain} / {indexed} 票 · 0 处偏差",
  "consistency.consistentPending": "（已计入 {count} 票待确认）",
  "consistency.unknownStatus": "无法比对（未知状态：{status}）",

  "wallet.pointsTo": "本应用指向 {chainName}",
  "wallet.notConnected": "本应用指向 {chainName}",
  "wallet.connect": "连接钱包",
  "wallet.disconnect": "断开",
  "wallet.switchTo": "切到{chainName}",

  "health.toggle": "运行状态（索引高度 / 落后区块 / 错误）",
  "health.unreachable": "无法读取 /api/health，因此这里没有可展示的状态。",

  "trust.comparing": "正在比对规则指纹…",
  "trust.readingFingerprint": "正在读取链上的规则指纹…",
  "trust.fingerprintCommitted": "创建时的承诺",
  "trust.fingerprintCurrent": "当前状态重算",
  "trust.howComputedTitle": "这个指纹是怎么算出来的",
  "trust.howComputed":
    "创建时，合约把发起人地址、问题、截止时间、准入方式、选项列表（含每个选项的固定 ID 与链上字符串）以及白名单，连同合约自身地址与链 ID 一起做哈希，结果写进 {rulesHash}，此后永不改动。{currentRulesHash} 用同样的方式对当前状态重算一次。两者相同，说明这些内容自创建以来没有变过；不同，说明其中某一项在创建后被改过。",
  "trust.howComputedEmphasis": "当前",
  "trust.whitelistSorted":
    "白名单在计入哈希前会先排序，所以「先加谁后加谁」不会影响结果；票数不在哈希范围内——投票不是规则，否则每一个有票的投票都会显示成「被改过」。",
  "trust.stakeTitle": "押金的去向",
  "trust.stakeIntro":
    "投票时押金锁在合约里。投票结束后你可以随时取回；但如果一直不取，发起人有权在规定期限之后取走无人领回的押金。",
  "trust.stakeLocked": "当前锁在合约里的押金",
  "trust.stakeGracePeriod": "取回押金的期限（合约常量）",
  "trust.stakeGraceDays": "{days} 天",
  "trust.stakeProgress": "进度",
  "trust.stakeNotEnded": "投票尚未结束，期限还没开始计算",
  "trust.stakeEnded": "投票已结束，期限正在计算",
  "trust.stakeSweeper": "有权取走的人",
  "trust.whyRuleTitle": "为什么会有这条规则",
  "trust.whyRule":
    "押金的作用是让「一人一票」有成本，从而抑制重复投票。投票结束后合约会进入「已结束」阶段，此时每个人都可以调用 {refund} 取回自己的押金。若某个地址长期不取，合约允许发起人在上述期限之后调用 {sweep} 把剩余部分取走——这是为了不让资金永久锁死。这条规则写在合约里且不可更改，时间长度可以直接调用 {gracePeriod} 核对。你随时可以取回，不取才会失去。",

  "activity.heading": "活动记录",
  "activity.subheading": "这个投票的每一笔投票、改投、撤票、退款与白名单变更，按区块倒序",
  "activity.kind.cast": "投票",
  "activity.kind.changed": "改投",
  "activity.kind.withdrawn": "撤票",
  "activity.kind.refunded": "退款",
  "activity.kind.whitelist": "白名单",
  "activity.kind.phase": "阶段",
  "activity.option": "选项 #{id}",
  "activity.blockTitle": "区块高度",
  "activity.readFailedTitle": "读取活动记录失败",
  "activity.readFailedDetail": "索引查询没有成功。记录本身在链上是存在的，这里读不到不代表没有。",
  "activity.noIndexTitle": "这个部署没有可用的索引",
  "activity.noIndexDetail":
    "活动记录需要在索引里按投票查询；链上没有「某个投票的全部事件」这种接口。记录在链上仍然存在，这里只是列不出来——所以这里不会显示成「没有活动」。",
  "activity.noIndexEmphasis": "记录在链上仍然存在",
  "activity.emptyTitle": "还没有任何活动",
  "activity.emptyDescription": "这个投票创建之后还没有人投票、改投或撤票，白名单也没有变动过。",
  "activity.total": "共 {count} 条记录，最新的在最上面。",

  "export.title": "导出结果",
  "export.description":
    "数字直接读自合约，与页面上显示的是同一次读取。导出的文件不依赖本页，可以离线核对；合约地址与截止时间也一并写进文件，便于日后比对。",
  "export.downloadCsv": "下载 CSV",
  "export.downloadJson": "下载 JSON",
  "export.copied": "已复制",
  "export.copyLink": "复制 JSON 链接",
  "export.howToVerifyTitle": "如何独立核对这份结果",
  "export.verifyContract1": "· 用区块浏览器打开合约 ",
  "export.verifyContract2": "，直接调用 {results}，得到的票数应当与导出的文件逐项相同。",
  "export.verifyActivity":
    "· 活动记录里每一行都带区块高度与交易哈希，可以在区块浏览器上逐条查证——票数不是「统计出来的」，是这些交易累加出来的。",
  "export.verifyIndex":
    "· 导出的 JSON 里也附带了当时索引的比对结果。索引是可重建的缓存，它若与链上不一致，链上的数字才是准的。",

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
  "common.refreshing": "Refreshing…",
  "common.refreshingShort": "Refreshing",
  "common.expand": "Show",
  "common.collapse": "Hide",
  "common.connecting": "Connecting…",
  "common.notRead": "Not read",

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
  "list.heading": "All polls",
  "list.headingCount": "All polls ({count})",
  "list.searchLabel": "Search polls",
  "list.searchInputPlaceholder": "Search the question, the creator or the contract address…",
  "list.searchClear": "Clear",
  "list.searchClearLabel": "Clear the search",
  "list.searchNoMatch": "No polls match “{query}”",
  "list.pageLabel": "Poll list pages",
  "list.unlistableTitle": "The polls could not be listed",
  "list.noFactory":
    "The current chain ({chainId}, {chainName}) has no registered factory address, so the polls cannot be listed.",
  "list.factoryReadFailed":
    "Reading the factory's poll list failed: the on-chain call did not succeed. Check the RPC of the network your wallet is on and retry.",
  "list.factoryPending": "Reading the on-chain poll list…",
  "list.connectedCount": " ({count})",
  "list.emptyTitle": "There are no polls yet",
  "list.emptyDescription":
    "The factory contract has not created a poll yet. Use “Start a new poll” at the top of the page to create the first one — a creator can adjust the options and the whitelist before it starts.",
  "list.noMatchDescription":
    "No poll matches “{query}”. The search matches the beginning of the question, the creator's address and the contract address.",
  "myVotes.createdTitle": "Polls I created",
  "myVotes.createdDescription":
    "From the factory's {call}, so this list is complete: the chain records who created which poll.",
  "myVotes.connectFirst": "Connect a wallet first.",
  "myVotes.noFactory":
    "The current chain ({chainId}, {chainName}) has no registered factory contract, so the polls you created cannot be listed.",
  "myVotes.createdReadFailed":
    "Reading pollsByCreator failed: the on-chain call did not succeed. Check the RPC and retry.",
  "myVotes.createdEmptyTitle": "You have not created a poll yet",
  "myVotes.createdEmptyDescription":
    "You can create one on the “All polls” page; the creator becomes that poll's contract owner, responsible for its whitelist and for ending it.",
  "myVotes.createdNote": "Created by you",
  "myVotes.votedTitle": "Polls I voted in",
  "myVotes.votedFromIndex":
    "From this app's read-only index (the {view} view, derived from on-chain events). The chain has no reverse lookup for “which polls has an address voted in”, so one query can only answer it from the index; only polls where you currently hold a vote appear, and withdrawn votes do not.",
  "myVotes.votedFromChain":
    "No index is available, so this list was built by reading {call} for each poll: only polls where you currently hold a vote appear, and withdrawn votes do not. That is one read per poll on chain, so only the newest part is scanned below.",
  "myVotes.scanTruncated":
    "There are {total} polls on chain; this page scanned only the newest {limit} (reading one poll at a time grows linearly with the number of polls, and scanning all of them would make the page slow). Older polls may hold votes of yours too and this page will not show them; you can look for them under {link}.",
  "myVotes.listAllPolls": "All polls",
  "myVotes.noPollsTitle": "The factory has not created any polls yet",
  "myVotes.noPollsDescription":
    "There is not a single poll on chain, so there is nothing to list here.",
  "myVotes.queryingIndex": "Asking the index which votes you hold…",
  "myVotes.indexFailed": "The index query failed; reading on-chain state poll by poll instead.",
  "myVotes.scanning": "Reading {count} polls one by one… (the first result to arrive appears here)",
  "myVotes.scanFailed":
    "The on-chain call failed while reading poll state one by one. Check the RPC and retry.",
  "myVotes.holdNoneIndexed": "You do not currently hold a vote in any poll.",
  "myVotes.holdNoneNothingScanned": "There are no polls to scan.",
  "myVotes.holdNoneScanned":
    "You do not currently hold a vote in any of the polls that were scanned.",
  "myVotes.line": "Voted · {phase}",
  "myVotes.lineWithVotes": "Voted · {phase} · {votes} votes",
  "myVotes.lineReading": "Voted · reading the phase…",
  "myVotes.currentAddress": "Current address {address}, reading {chainName} ({chainId}).",

  "poll.notFound": "This poll was not found",
  "poll.unavailable": "This poll could not be read from the chain",
  "poll.question": "Question",
  "poll.creator": "Creator",
  "poll.endsAt": "Deadline",
  "poll.phase": "Phase",
  "poll.totalVotes": "Total votes",
  "poll.turnout": "Turnout",
  "poll.turnoutUnknown": "—",
  "poll.creatorInline": "Creator",
  "poll.votedSoFar": "{count} votes cast",
  "poll.optionCount": "{count} options",
  "poll.statOptionCount": "Options",
  "poll.statTotalVotes": "Current votes",
  "poll.statStake": "Voting deposit",
  "poll.stakeRefundable": "Refundable",
  "poll.goVote": "Vote →",
  "poll.viewDetail": "View details →",
  "poll.cardReadFailed": "This poll's on-chain data could not be read",
  "poll.cardReadFailedDetail":
    "This address came from the factory's {call}, so the poll does exist; what failed is the read of its details.",
  "poll.retryAfterNetworkCheck": "Check the RPC of the network your wallet is on and retry.",
  "poll.retryAfterRpcCheck": "Check the RPC and retry.",
  "poll.stillOpen": "Open this poll anyway →",

  "ballot.serverReadFailedTitle": "The server failed to read this poll",
  "ballot.serverReadFailedDetail": "Whatever can still be read is shown below: {error}",
  "ballot.questionReadFailed": "Reading the question failed",
  "ballot.readingPoll": "Reading the poll…",
  "ballot.statOptionCount": "Option count",
  "ballot.statStake": "Deposit",
  "ballot.contract": "Contract",
  "ballot.deadlineReadFailed": "Reading the deadline failed",
  "ballot.readingDeadline": "Reading the deadline…",
  "ballot.deadlinePassed": "Deadline passed ({time})",
  "ballot.deadline": "Deadline {time}",
  "ballot.pastDeadlineOpenPhase":
    "The deadline has passed, but the contract is still in the Voting phase: the contract will refuse votes, vote changes and withdrawals, and the deposit can only be reclaimed once the poll is formally closed. This close call ",
  "ballot.pastDeadlineOpenPhaseEmphasis": "requires no permission",
  "ballot.pastDeadlineOpenPhaseTail": ", so anyone can make it — including you.",
  "ballot.closePoll": "Close this poll (anyone can)",
  "ballot.myStatus": "My status",
  "ballot.canVote": "Can vote",
  "ballot.admissionMode": "Admission",
  "ballot.openToAll": "Open to everyone",
  "ballot.whitelist": "Whitelist",
  "ballot.hasVoted": "Has voted",
  "ballot.votedFor": "Voted for",
  "ballot.withdrawVote": "Withdraw vote (returns the deposit)",
  "ballot.reclaimStake": "Reclaim deposit",
  "ballot.transaction": "Transaction",
  "ballot.awaitingConfirmation": " · awaiting confirmation…",
  "ballot.confirmed": " · confirmed",
  "ballot.options": "Options",
  "ballot.optionsCount": " ({count})",
  "ballot.readingOptions": "Reading the options…",
  "ballot.optionsReadFailed":
    "Reading the option list failed: the on-chain call did not succeed. Check the RPC and retry.",
  "ballot.noOptions": "This poll has no options yet.",

  "countdown.deadline": "Deadline {time}",
  "countdown.closedAt": "Closed at {time} (closed)",
  "countdown.remaining": "{remaining} left (deadline {absolute})",
  "countdown.lessThanMinute": "Less than 1 minute",
  "countdown.daysHours": "{days} d {hours} h",
  "countdown.hoursMinutes": "{hours} h {minutes} min",
  "countdown.minutes": "{minutes} min",

  "consistency.loading": "Comparing the chain against the index…",
  "consistency.unreachable": "Cannot compare (the index API is unreachable)",
  "consistency.unavailable": "Index not enabled · the figures come straight from the chain",
  "consistency.lagging":
    "The index is {blocks} blocks behind · {onChain} votes on chain, not compared yet",
  "consistency.divergent":
    "{onChain} votes on chain ≠ {indexed} in the index · {count} discrepancies",
  "consistency.consistent": "Chain and index agree · {onChain} / {indexed} votes · 0 discrepancies",
  "consistency.consistentPending": " ({count} votes counted but unconfirmed)",
  "consistency.unknownStatus": "Cannot compare (unrecognised status: {status})",

  "wallet.pointsTo": "This app points at {chainName}",
  "wallet.notConnected": "This app points at {chainName}",
  "wallet.connect": "Connect wallet",
  "wallet.disconnect": "Disconnect",
  "wallet.switchTo": "Switch to {chainName}",

  "health.toggle": "Status (index height / blocks behind / errors)",
  "health.unreachable": "/api/health could not be read, so there is no status to show here.",

  "trust.comparing": "Comparing the rules fingerprint…",
  "trust.readingFingerprint": "Reading the on-chain rules fingerprint…",
  "trust.fingerprintCommitted": "Committed at creation",
  "trust.fingerprintCurrent": "Recomputed from current state",
  "trust.howComputedTitle": "How this fingerprint is computed",
  "trust.howComputed":
    "At creation the contract hashes the creator's address, the question, the deadline, the admission mode, the option list (each option's fixed ID and its on-chain string) and the whitelist, together with the contract's own address and the chain ID, and writes the result into {rulesHash}, where it never changes again. {currentRulesHash} recomputes the same value from the CURRENT state. If the two agree, none of that content has changed since creation; if they differ, one of those items was edited after creation.",
  "trust.howComputedEmphasis": "current",
  "trust.whitelistSorted":
    "The whitelist is sorted before it enters the hash, so the order addresses were added in does not affect the result; the tally is not part of the hash — votes are not rules, and if they were, every poll with a vote would show as “changed”.",
  "trust.stakeTitle": "Where the deposit goes",
  "trust.stakeIntro":
    "Your deposit is locked in the contract while you vote. Once voting ends you can take it back at any time; but if you never do, the creator is entitled to take the deposits nobody reclaimed after the stated period.",
  "trust.stakeLocked": "Deposits currently locked in the contract",
  "trust.stakeGracePeriod": "Period to reclaim a deposit (a contract constant)",
  "trust.stakeGraceDays": "{days} days",
  "trust.stakeProgress": "Progress",
  "trust.stakeNotEnded": "Voting has not ended, so the period has not started",
  "trust.stakeEnded": "Voting has ended, so the period is running",
  "trust.stakeSweeper": "Who may take it",
  "trust.whyRuleTitle": "Why this rule exists",
  "trust.whyRule":
    "The deposit exists to give “one person, one vote” a cost, which discourages repeat voting. Once voting ends the contract enters the Ended phase, and at that point anyone can call {refund} to take their deposit back. If an address leaves theirs for a long time, the contract lets the creator call {sweep} after the period above to take what remains — so that funds are not locked up forever. This rule is written in the contract and cannot be changed, and the length of the period can be checked by calling {gracePeriod} directly. You can always take yours back; only leaving it costs you.",

  "activity.heading": "Activity",
  "activity.subheading":
    "Every vote, vote change, withdrawal, refund and whitelist change in this poll, newest block first",
  "activity.kind.cast": "Vote",
  "activity.kind.changed": "Change",
  "activity.kind.withdrawn": "Withdrawal",
  "activity.kind.refunded": "Refund",
  "activity.kind.whitelist": "Whitelist",
  "activity.kind.phase": "Phase",
  "activity.option": "Option #{id}",
  "activity.blockTitle": "Block height",
  "activity.readFailedTitle": "Reading the activity failed",
  "activity.readFailedDetail":
    "The index query did not succeed. The records themselves exist on chain; not being readable here does not mean they are not there.",
  "activity.noIndexTitle": "This deployment has no usable index",
  "activity.noIndexDetail":
    "Activity has to be queried per poll from the index, and the chain has no “all events of one poll” interface. The records still exist on chain, they simply cannot be listed here — which is why this is not shown as “no activity”.",
  "activity.noIndexEmphasis": "The records still exist on chain",
  "activity.emptyTitle": "There is no activity yet",
  "activity.emptyDescription":
    "Nobody has voted, changed a vote or withdrawn since this poll was created, and the whitelist has not changed either.",
  "activity.total": "{count} records, newest first.",

  "export.title": "Export the result",
  "export.description":
    "The figures are read straight from the contract, in the same read the page displays. The exported file does not depend on this page and can be checked offline; the contract address and the deadline are written into the file as well, for later comparison.",
  "export.downloadCsv": "Download CSV",
  "export.downloadJson": "Download JSON",
  "export.copied": "Copied",
  "export.copyLink": "Copy the JSON link",
  "export.howToVerifyTitle": "How to verify this result independently",
  "export.verifyContract1": "· Open the contract in a block explorer at ",
  "export.verifyContract2":
    ", call {results} directly, and the tally you get should match the exported file row for row.",
  "export.verifyActivity":
    "· Every row of the activity record carries its block height and transaction hash and can be checked one by one in a block explorer — the tally is not “computed”, it is these transactions added up.",
  "export.verifyIndex":
    "· The exported JSON also carries the index comparison as it stood at the time. The index is a rebuildable cache: if it disagrees with the chain, the chain's figure is the correct one.",

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
