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
  /*
    ---------------------------------------------------------------------------
    The rest of 审计视图: the fail-closed sentences, the filter control and the
    paging. The table's own headings above are reused as-is.
    ---------------------------------------------------------------------------
  */
  "audit.readFailed": "读取审计事件时发生未预期的错误。完整错误见服务端日志。",
  "audit.indexRequired":
    "审计事件来自 MySQL 索引，而当前部署没有配置 {databaseUrl}，所以无法列出历史事件。这不代表「没有活动」——链上的事件仍然在发生，只是这里读不到。",
  "audit.indexHowTo":
    "配置 {databaseUrl} 后运行 {commands} 即可建立索引；每个投票页的活动记录也会随之出现。",
  "audit.filterLabel": "按事件类型过滤",
  "audit.summary": "共 {count} 条事件，涉及 {polls} 个投票{kind}。",
  "audit.summaryKind": "，类型：{kind}",
  "audit.emptyDetail": "过滤条件与索引自身都是可读的，所以这是「没有匹配」而不是「读不到」。",
  "audit.pagination": "审计分页",
  "audit.backToPolls": "← 全部投票",

  "notifications.title": "我的通知",
  "notifications.subtitle":
    "你订阅的投票在上次查看之后发生的事。通知由索引器记录的事件推导得出，不引入邮件或 webhook；订阅只保存在本站，且仅与你的钱包地址关联。",
  "notifications.readFailedHttp": "读取失败（HTTP {status}）。",
  "notifications.readFailedUnexpected": "读取通知时发生未预期的错误。完整错误见浏览器控制台。",
  "notifications.connectFirst":
    "通知按钱包地址归属，所以需要先连接钱包。连接后这一页会列出你订阅的投票的新动态。",
  "notifications.indexRequired":
    "通知由索引器记录的事件推导，而当前部署没有配置 {databaseUrl}，所以无法列出任何动态。这不代表「没有新动态」——链上事件仍然在发生，只是这里读不到。",
  "notifications.summary": "未读 {count} 条，涉及 {polls} 个投票{truncated}。",
  "notifications.summaryTruncated": "（本页只列出最新的 {limit} 条）",
  "notifications.markAllRead": "全部标记为已读",
  "notifications.emptyTitle": "没有未读动态",
  "notifications.emptyDescription":
    "索引可读，且你订阅的投票在上次查看之后没有新事件。这是一种确定的状态，不是读取失败。还没有订阅？在任意投票页点「订阅这个投票」，之后它的投票、改投、撤票、退款与阶段变更都会出现在这里。",
  "notifications.markThisRead": "这个投票标记为已读",
  "notifications.block": "区块 {block}",
  "notifications.auditLine": "{audit} 会列出全部事件（跨所有投票），这里只列出你订阅的部分。",

  "home.subtitle":
    "任何人都可以发起投票；每个投票是独立合约，发起人管理它。你可以投票、改投、撤票并取回押金。选项元数据存放在 IPFS，链上只保存 CID；所有写入都由你自己的钱包签名。",
  "home.listFailedTitle": "无法从链上读取投票列表",
  "home.listFailedDetail":
    "请确认 {envFile} 里的 {rpcUrl} 可达、{chainId} 上有已部署的工厂合约，并已执行过 {exportAbi}。连接钱包后，下面的列表会直接向你的钱包所在网络重新读取一次。",
  "home.auditLine":
    "需要核对链上事件与索引记录？打开 {audit}，可按事件类型、投票合约或地址过滤。该页读取索引，不读取链上实时状态。",
  "home.notificationsLine":
    "只想看你订阅的投票？打开 {notifications}，它按连接的钱包地址列出你订阅的投票在上次查看之后的新事件；不订阅则没有内容可列。",

  "my.title": "我的投票",
  "my.subtitle":
    "列出你这个地址发起的投票，以及你当前持有票的投票。两个列表都直接读链：链上记录了谁创建了哪个投票，而「我投过哪些」只能逐个投票读 voterState，因此有扫描上限。",
  "my.serverListFailed": "服务端读取投票列表失败：{error}",
  "my.browserRetry": "下面的列表仍会尝试由你的浏览器直接读取工厂合约。",

  "shell.brand": "去中心化投票平台",
  "shell.footerHeading": "使用前请知悉",
  "shell.footerWhitelist":
    "每个投票的发起人可以维护自己的白名单，也可以在宽限期后调用 {call} 取走无人领回的押金。",
  "shell.footerIndex": "索引器（本应用内的只读层）是可重建的缓存，",
  "shell.footerIndexEmphasis": "链上数据才是唯一真相",
  "shell.footerIndexTail": "，索引不可用时页面会直接读链。",
  "shell.footerWallet": "任何写入都由你自己的钱包签名，后端不持私钥。",

  /*
    ---------------------------------------------------------------------------
    The result chart.
    ---------------------------------------------------------------------------

    `chart.caption` names the source with a `{source}` placeholder, and that value
    is `tallySourceLabel`'s — the same single spelling the textual tally uses. So
    the chart cannot describe its own provenance differently from the numbers
    beside it; see `ballot-labels.ts`.

    The 票 unit is part of the template rather than of the number, because English
    needs "8 votes" where Chinese needs "8 票" — the same reason `activity.total`
    spells its own.
  */
  "chart.title": "结果图表",
  "chart.caption": "数据来源 {source} · 合计 {total} 票",
  "chart.barValue": "{votes} 票 · {percent}%",
  "chart.noVotes": "还没有票——这个投票目前一票都没有。",
  "chart.ariaNoOptions": "结果图表：这个投票还没有选项，没有可以展示的结果。数据来源：{source}。",
  "chart.ariaNoVotes": "结果图表：{message}数据来源：{source}。",
  "chart.ariaItem": "{label} {votes} 票（{percent}%）",
  "chart.ariaBars": "结果图表：{items}。合计 {total} 票，数据来源：{source}。",

  /*
    ---------------------------------------------------------------------------
    One option card.
    ---------------------------------------------------------------------------

    `option.metadataCid` and `option.rawString` are the two names of the same row:
    what the chain stores is a CID for some polls and a plain string for others,
    and the label says which one the reader is looking at.
  */
  "option.metadataCid": "元数据 CID",
  "option.rawString": "链上存的字符串",
  "option.retrying": "重试中…",
  "option.mine": "你当前投给了这个选项",
  "option.changeHere": "改投到这个选项",
  "option.voteWithStake": "投一票（{amount} ETH 押金）",

  /*
    ---------------------------------------------------------------------------
    The /poll/<address> page's own frame.
    ---------------------------------------------------------------------------

    That page used to take its title and subtitle from inline literals while the
    ballots inside it were already translated. They belong with the rest of the
    page chrome rather than under `poll.*`, which owns the poll DETAIL FIELDS
    (问题/发起人/截止时间) that the list card and the ballot's stat row both render.
  */
  "pollPage.invalidTitle": "无效的投票地址",
  "pollPage.invalidSubtitle": "投票页的地址必须是 20 字节的十六进制合约地址。",
  "pollPage.invalidDetail":
    "路径里的 {segment} 必须是投票合约的地址 （{prefix} 加 40 位十六进制），收到的是 {received}。",
  "pollPage.backToPolls": "← 回到全部投票",
  "pollPage.fallbackTitle": "投票",
  "pollPage.subtitle":
    "投票、改投、撤票都由你的钱包签名。按钮是否可用完全来自链上状态，包括白名单、阶段与截止时间。",
  "pollPage.serverReadFailed": "服务端无法读取这个投票（{address}）：{error}",
  "pollPage.browserRetry":
    "下面仍会尝试用你的浏览器直接读取同一个合约；如果链上确实没有这个地址，各项会显示读取失败。",

  /*
    ===========================================================================
    The CREATION / ADMIN surface
    ===========================================================================

    ---------------------------------------------------------------------------
    Why `create.mechanism*` is a set of FRAGMENTS rather than finished sentences
    ---------------------------------------------------------------------------

    `describeMechanisms` returns one line built by joining five clauses with
    ` · `, and the reader's question is "what will this poll do" — a question
    whose answer is a list. The English clauses are not word-for-word images of
    the Chinese ones ("多选，每票最多 2 项" is "Multi-select, up to 2 per ballot"),
    so a single template with a placeholder would have to be written to fit one
    grammar and would read as broken in the other. Each clause therefore owns its
    own key, and `templates.ts` joins them in the same order in both languages:
    one decision per key, one place for the separator.

    `mechanism.multiSelect` takes `{count}` — the cap that will ACTUALLY be
    submitted, which `buildPollConfig` clamps to the number of options, never the
    cap the template stored. `web/test/templates.test.ts` pins that distinction.

    ---------------------------------------------------------------------------
    Why the admin panel's disabled-control reasons live here
    ---------------------------------------------------------------------------

    They are the same kind of sentence as the ballot's, but they are built from
    `PollAdmin`'s own reads — the contract's phase, the deadline, the option
    count — rather than from the five predicates in `ballot-reasons.ts`, so they
    are assembled by the component and belong in the catalogue.

    The contract's own error names (`InvalidPhase`, `TooFewOptions`,
    `PollAlreadyEnded`, `GracePeriodNotElapsed`) are quoted verbatim in BOTH
    languages, exactly as `ballot-phrases.ts` quotes `AlreadyVoted`: a reader
    looks them up in their wallet, and renaming one severs the only link between
    the sentence and the revert that actually happened.

    ---------------------------------------------------------------------------
    What is deliberately NOT here
    ---------------------------------------------------------------------------

    Template NAMES and template DESCRIPTIONS. They are keys of `PollTemplate`,
    which is a data shape rather than a message: the descriptions are long prose
    that explains a mechanism, so they sit beside the config they describe in
    `templates.ts` rather than being split from it across two files that would
    then have to be kept in step by hand. Draft values (`question`, `options`,
    `deadline`, `templateId` chosen by a reader) are their data and are never
    translated at all.
  */
  "admin.heading": "发起人管理",
  "admin.onlyYou": "仅你可见",
  "admin.intro":
    "你创建了这个投票，所以只有你能维护白名单、改动选项、开始与结束投票。这些调用都由你的钱包签名；面板的显示与否只是界面决定，真正的权限检查在合约的",
  "admin.introTail": "里。",
  "admin.lifecycle": "生命周期",
  "admin.startPoll": "开始投票",
  "admin.endPoll": "提前结束投票",
  "admin.closeNote1": "若截止时间已过而投票仍显示「投票中」，任何人都可以调用",
  "admin.closeNote2": "正式关闭它——在那之前，连你自己的押金也取不回来。",
  "admin.whitelist": "白名单",
  "admin.whitelistHint":
    "每行一个地址，或用逗号分隔。合约按批次写入，重复地址会被幂等地设为同一状态。",
  "admin.whitelistField": "白名单地址",
  "admin.addressesFound": "识别到 {count} 个地址",
  "admin.addressesList": "：{list}",
  "admin.addressesEnd": "。",
  "admin.addToWhitelist": "加入白名单",
  "admin.removeFromWhitelist": "移出白名单",
  "admin.options": "选项管理",
  "admin.optionCount": "当前 {count} 个",
  "admin.optionLabel": "#{id}",
  "admin.optionEditField": "选项 {id} 的新内容",
  "admin.save": "保存",
  "admin.cancel": "取消",
  "admin.rename": "改名",
  "admin.delete": "删除",
  "admin.removeRenumber": "删除中间选项会让它后面的选项编号整体前移；投票开始后无法再改动。",
  "admin.newOptionPlaceholder": "新的选项文字或 CID",
  "admin.newOptionLabel": "新选项",
  "admin.addOption": "增加选项",
  "admin.sweepTitle": "无人认领的押金",
  "admin.sweepIntro":
    "宽限期（7 天）过后，仍未被投票人取回的押金可以由你取走。这是本项目已声明的中心化风险：押金是投票人的钱，取走前请确认宽限期确实已过。",
  "admin.totalStaked": "合约当前记在账上的押金合计：",
  "admin.sweepToPlaceholder": "接收地址 0x…",
  "admin.sweepToLabel": "扫款接收地址",
  "admin.useMyAddress": "填入我的地址",
  "admin.sweep": "取走无人认领的押金",

  "admin.reason.connectFirst": "请先连接钱包：这些调用都由你的钱包签名。",
  "admin.reason.readFailed": "读取合约状态失败，无法判断可以做什么；请检查 RPC 后重试。",
  "admin.reason.reading": "正在读取合约状态…",
  "admin.reason.noFactoryReason":
    "当前链（{chainId}，{chainName}）没有已登记的工厂合约，无法确定投票合约。请在钱包里切到本应用部署的那条链。",
  "admin.reason.closeNoFactory": "当前链（{chainId}，{chainName}）没有已登记的工厂合约。",
  "admin.reason.closeReadFailed": "读取合约阶段失败，无法判断能否关闭；请检查 RPC 后重试。",
  "admin.reason.closeEnded": "投票已经正式关闭了。",
  "admin.reason.closeInSetup": "投票还没开始，合约会以 InvalidPhase 拒绝 closeAfterDeadline()。",
  "admin.reason.closeBeforeDeadline":
    "还没到截止时间，合约会以 DeadlineNotInFuture 拒绝 closeAfterDeadline()。",
  "admin.reason.startOnlyWhileSetup":
    "投票已经开始过了，合约会以 InvalidPhase 拒绝再次调用 startPoll()。",
  "admin.reason.startTooFewOptions": "至少要有 {min} 个选项才能开始，合约会以 TooFewOptions 拒绝。",
  "admin.reason.startPastDeadline":
    "截止时间已经过去了，合约会以 PollAlreadyEnded 拒绝开始；请重新建一个投票。",
  "admin.reason.endNotStarted": "投票还没开始，合约会以 InvalidPhase 拒绝 endPoll()。",
  "admin.reason.endAlreadyEnded": "投票已经结束了，合约会以 InvalidPhase 拒绝 endPoll()。",
  "admin.reason.whitelistAfterEnd": "投票已经结束，合约会以 InvalidPhase 拒绝改动白名单。",
  "admin.reason.whitelistEmpty": "请先填写地址：每行一个，或用逗号分隔。",
  "admin.reason.whitelistMalformed":
    "有地址不是 20 字节的十六进制格式（0x 加 40 位），整批都不会提交。",
  "admin.reason.whitelistTooMany": "一次最多提交 {limit} 个地址，收到 {count} 个；请分批。",
  "admin.reason.optionsLocked":
    "选项只能在投票开始前改动；一旦开始，合约会以 InvalidPhase 拒绝所有选项写入。",
  "admin.reason.removeTooFew": "只剩 {count} 个选项，合约会以 TooFewOptions 拒绝删除。",
  "admin.reason.sweepNotEnded": "投票还没结束，合约会以 InvalidPhase 拒绝 sweepUnclaimed()。",
  "admin.reason.sweepNoCloseTime": "合约还没有记录关闭时间，无法判断宽限期是否已过。",
  "admin.reason.sweepGracePeriod":
    "宽限期还没结束，合约会以 GracePeriodNotElapsed 拒绝；可领取时间是 {time}。",
  "admin.reason.sweepNoRecipient": "请填写接收地址。",
  "admin.reason.sweepBadRecipient": "接收地址必须是 20 字节的十六进制地址。",

  "create.heading": "发起新投票",
  "create.subtitleExpanded": "交易由你自己的钱包签名，后端不持私钥。",
  "create.subtitleCollapsed": "任何人都能创建投票；发起人负责它的白名单与结束。",
  "create.intro":
    "交易由你自己的钱包签名，后端不持私钥；合约会把发起人记成你的地址，之后只有你能维护这个投票的白名单。",
  "create.draftRestored":
    "已从本机浏览器恢复上次未提交的草稿（只存在这台设备上，不会上传）。提交成功后会自动清除。",
  "create.templateLabel": "投票类型（模板）",
  "create.questionLabel": "问题",
  "create.questionPlaceholder": "例如：社区资金应该先资助哪个提案？",
  "create.optionsLabel": "选项（至少 {min} 个；可以填元数据 CID，也可以直接填文字）",
  "create.optionPlaceholderFirst": "bafkrei… 或 直接写选项文字",
  "create.optionPlaceholderNumbered": "选项 {number}",
  "create.removeOption": "删除",
  "create.addOption": "+ 增加一个选项",
  "create.deadlineLabel": "截止时间",
  "create.deadlineHint": "按你本机时区解释，上链时换算成 Unix 时间戳。",
  "create.admissionLegend": "谁可以投票",
  "create.admissionOpen": "所有人可投",
  "create.admissionOpenHint": "——任何地址都能投，无需你事先添加。",
  "create.admissionWhitelist": "仅白名单",
  "create.admissionWhitelistHint":
    "——创建后你要在投票页的管理面板里逐个添加地址，否则没有人能投票。",
  "create.admissionFixed": "这个选择在创建时写入合约，",
  "create.admissionFixedEmphasis": "之后无法更改",
  "create.admissionFixedTail": "（合约没有对应的修改函数）。要换一种准入方式，只能另建一个投票。",
  "create.cidSummary1": "这 {total} 个选项里，有 {cids} 个会被登记为",
  "create.cidEmphasis": "元数据 CID",
  "create.cidSummary2":
    "（打开投票的人会按 CID 去 IPFS 网关取文档）；另外 {raw} 个不是 CID 形状，会被",
  "create.cidRawEmphasis": "原样存成选项文字",
  "create.cidSummary3": "，没有文档可取。合约不做这个检查，字符串是永久写入的，创建后不可修改。",
  "create.submit": "创建投票",
  "create.draftSaved": "草稿已保存在本机浏览器，刷新后可以继续。",
  "create.draftUnsaved1": "当前浏览器不允许本地存储（无痕模式或存储已禁用），草稿",
  "create.draftUnsavedEmphasis": "不会",
  "create.draftUnsaved2": "被保留，刷新后需要重新填写。",
  "create.clearDraft": "清除草稿",
  "create.created": " · 已确认，新投票已出现在下面的列表里",
  "create.connectForCreator": "连接钱包后这里会显示发起人地址。",

  "create.reason.noFactory":
    "当前链（{chainId}，{chainName}）没有已登记的工厂合约，无法创建投票。请在钱包里切到本应用部署的那条链。",
  "create.reason.connectFirst":
    "请先连接钱包：创建投票要由你的钱包签名，合约会把发起人记成这个地址。",
  "create.reason.emptyQuestion": "请填写投票的问题：合约会以 EmptyQuestion 拒绝空问题。",
  "create.reason.tooFewOptions":
    "至少需要 {min} 个选项：合约会以 TooFewOptions 拒绝少于 {min} 个选项的投票。",
  "create.reason.noDeadline": "请选择截止时间：合约会以 DeadlineNotInFuture 拒绝空或无效的时间。",
  "create.reason.deadlinePast":
    "截止时间必须在未来：合约会以 DeadlineNotInFuture 拒绝已经过去的时间。",

  "subscribe.connectFirst":
    "连接钱包后可以订阅这个投票，它的投票、改投、撤票、退款与阶段变更会出现在",
  "subscribe.notifications": "我的通知",
  "subscribe.connectLast": "。订阅只是一行本站记录，不需要签名，也不上链。",
  "subscribe.reading": "正在读取订阅状态…",
  "subscribe.noIndex1": "这个部署没有配置索引（",
  "subscribe.noIndex2": "），所以无法保存订阅。这不是「订阅失败」——是这里根本没有地方记录它。",
  "subscribe.readFailed": "读取订阅状态失败，因此无法确定当前是否已订阅。完整错误见浏览器控制台。",
  "subscribe.subscribe": "订阅这个投票",
  "subscribe.unsubscribe": "取消订阅这个投票",
  "subscribe.note": "订阅只是本站的一行记录，不上链、不需要签名。",

  "template.defaultsLabel": "默认",
  "template.switchConfirm": "切换到「{name}」会替换当前的机制配置，已填写的字段保留。继续吗？",

  "mechanism.single": "单选，每票一个选项",
  "mechanism.multiSelect": "多选，每票最多 {count} 项",
  "mechanism.weighted": "按地址权重计票",
  "mechanism.oneVoteEach": "一人一票",
  "mechanism.notCommitReveal": "不隐藏选择（非 commit-reveal）",
  "mechanism.delegable": "可委托票权",
  "mechanism.notDelegable": "不可委托",
  "mechanism.openToAll": "所有人可投",
  "mechanism.whitelistOnly": "仅白名单可投",
  "mechanism.unknown": "未知",

  "mechanism.problem.multiSelect":
    "多选模板要求每票至少能选 2 项，当前上限不足 2，合约会拒绝创建。",
  "mechanism.problem.weighted":
    "加权投票要求先建白名单：开放给所有人时没有确定的票权集合，合约会拒绝创建。请把「谁可以投票」改回「仅白名单」，或换一个模板。",
  "mechanism.problem.commitRevealWindow":
    "选择隐藏（commit-reveal）时必须给出揭示窗口，当前为 0，合约会拒绝创建。",
  "mechanism.problem.commitRevealDelegation": "隐藏选择目前不能与委托投票组合，合约会拒绝创建。",

  /*
    ---------------------------------------------------------------------------
    The execution panel
    ---------------------------------------------------------------------------

    Already English in both languages before this change: it is a creator's
    governance tool, and these six labels were written in English in the JSX.
    They are catalogue entries now so the panel can be translated at all, and the
    Chinese is the same English rather than a fresh translation — rewriting them
    would be a copy change wearing an extraction's clothes.

    `execution.submitting` is NOT that category. It replaces a literal
    `Submitting…`, which is what this panel used to render where every other
    panel in the app renders 提交中…; the existing `common.busy` is the one
    spelling of that state.
  */
  "execution.title": "结果执行",
  "execution.description":
    "A passed vote can authorise exactly one on-chain action. It waits out the timelock first, so voters can see what is about to happen.",
  "execution.outcome": "结果",
  "execution.explanation": "说明",
  "execution.quorum": "法定人数",
  "execution.turnout": "出席率",
  "execution.quorumMet": " — quorum met",
  "execution.belowQuorum": " — below quorum",
  "execution.queue": "队列",
  "execution.nothingQueued": "Nothing queued yet.",
  "execution.onlyPassed": "Only a passed vote can be queued.",
  "execution.target": "目标",
  "execution.status": "状态",
  "execution.waiting": "Waiting out the timelock — {seconds}s remaining.",
  "execution.ready": "Ready to execute now.",
  "execution.done": "Executed.",
  "execution.failed": "The last attempt reverted",
  "execution.failedTail": ". The vote is unchanged and this can be retried.",
  "execution.calldata": "调用数据",
  "execution.allowedTargets": "允许的目标",
  "execution.selfOnly": "This poll itself only.",
  "execution.queueAction": "Queue an action",
  "execution.execute": "Execute",
  "execution.cancel": "Cancel",

  "common.busy": "提交中…",

  /*
    ===========================================================================
    The library-level label tables — the last Chinese that leaked into English
    ===========================================================================

    ---------------------------------------------------------------------------
    What these are, and why they were the last leak
    ---------------------------------------------------------------------------

    Every surface above renders through a component, and every component reads
    its words from a translator. The keys below do not: they are emitted by pure
    `lib/` modules — `health-report.ts`, `audit.ts`, `trust.ts`, `failure.ts`,
    `poll-report.ts`, `data.ts` — which build sentences as RETURN VALUES, not as
    JSX. A component that renders such a value cannot translate it after the
    fact: by the time it has the string, the language decision has already been
    made. So an English reader was shown 状态, 正常 and 规则与创建时一致 inside an
    otherwise entirely English page, and no amount of catalogue work above could
    have reached them.

    ---------------------------------------------------------------------------
    Why these are catalogue keys rather than a table per module
    ---------------------------------------------------------------------------

    The alternative — a second `Record<Locale, string>` beside each module, the
    shape `voting.ts` uses for `CHAIN_NAMES` and `PHASE_LABELS` — was rejected
    here for one reason: `i18n.test.ts` walks `ZH_MESSAGES` and fails when two
    names hold the same Chinese string. A per-module table would sit outside that
    check, so the reuse below (是/否/读取失败/读取中… are already answered by
    `ballotPhrasesFor(locale)`) would have to be re-established by hand in each
    table, and the four modules would drift. As catalogue keys they are covered
    by the completeness check, the placeholder declaration and the duplication
    check at once.

    `voting.ts` and `health-report.ts` were both left on their own locale tables
    deliberately: the first is already correct and named in ADR-0040, and the
    second is one panel's own coherent vocabulary, where a single table makes
    "did every row get translated" answerable at a glance. Moving either would be
    churn rather than a fix.

    ---------------------------------------------------------------------------
    Why `audit.kind.*` points at `poll.phase` for one of its six entries
    ---------------------------------------------------------------------------

    阶段 is the same word the poll detail row renders for the same concept.
    A `audit.kind.phase` holding it would be a second Chinese spelling of one
    sentence, which `i18n.test.ts` refuses, so the lookup reuses `poll.phase`.
  */
  "audit.kind.cast": "投票",
  "audit.kind.changed": "改投",
  "audit.kind.withdrawn": "撤票",
  "audit.kind.refunded": "退款",
  "audit.kind.whitelist": "白名单",

  /*
    The rules-fingerprint verdict: three sentences about whether a poll's rules
    still match the promise it was created with.

    Kept out of the two `*Panel.tsx` components for the reason `trust.ts` gives
    in its own header — the wording IS the feature. A `changed` verdict asserted
    as reassurance about wrongdoing would be a false accusation, and an
    `unknown` rendered as reassurance is the exact false assurance the check
    exists to prevent. Both are text, and text that decides a reader's judgement
    of someone else's honesty belongs in the tested module rather than in JSX.

    `—` is written here for the same reason it appears verbatim in the ballot
    phrases: it is a value a reader copies off the page, and the difference
    between `—` and `-` is the difference between a copy and a retype.
  */
  "trust.rulesUnchangedTitle": "规则与创建时一致",
  "trust.rulesUnchangedDetail":
    "把当前链上的问题、选项、截止时间、准入方式与白名单重新做了一次指纹计算，结果与创建时写入的承诺相同：这些内容自创建以来没有被改动过。任何人都可以独立重算并得到相同结果。",
  "trust.rulesChangedTitle": "规则在创建后有过改动",
  "trust.rulesChangedDetail":
    "当前链上状态的指纹与创建时写入的承诺不同，说明问题、选项、截止时间、准入方式或白名单在创建之后被改过至少一次。这不一定有问题——发起人在投票开始前增删选项、维护白名单本来就是正常流程——但你应该知道这件事，而不是只能相信页面。改动只可能发生在投票开始之前，因为选项在开始后会被冻结。",
  "trust.rulesUnknownTitle": "无法比对规则指纹",
  "trust.rulesUnknownDetail":
    "没能同时读到创建时的承诺与当前状态，所以无法判断规则是否被改动过。这不代表规则没问题，也不代表有问题——只是这一次没有验证成功。可以重试，或直接在区块浏览器上调用 rulesHash() 与 currentRulesHash() 自行比对。",

  /*
    The dependency-failure sentences.

    ---------------------------------------------------------------------------
    What reaches a READER and what reaches the LOG
    ---------------------------------------------------------------------------

    `describeFailure` is unusual: its result is BOTH a page banner (the five
    `/api/*` routes return it as `message`, and three Server Components render it
    into `serverReadFailed` / `listFailedDetail` slots) AND the string that
    `/api/health` reports as `indexError`. It is never only a log line — the raw
    throwable is what goes to the log, and `describeFailure` is precisely the
    scrubbed replacement for it. So all four sentences below are translated.

    What is NOT translated, and must not be: the redaction placeholders. `<已隐去的
    URL>` and `<已隐去>` replace text that was ALREADY removed, and they stand in the
    sentence where the operator expects to see the thing they must go and read in
    the log. An English reader meeting "<URL redacted>" in a Chinese log line, or
    a Chinese operator meeting it in an English one, gains nothing and loses the
    one marker they were told to search for. They are also part of the security
    guarantee rather than of the copy: `failure.test.ts` asserts that no endpoint
    survives by looking for exactly these.
  */
  "failure.rpcUnreachable":
    "链上读取失败{call}：所有已配置的 RPC 端点都未响应（连接失败或请求超时）。请检查 web/.env 里的 RPC_URL / RPC_URLS 是否可达；完整错误见服务端日志。",
  "failure.databaseUnreachable":
    "索引数据库（MySQL）不可读或不可写。请检查 web/.env 里的 DATABASE_URL，以及数据库是否在运行；完整错误见服务端日志。",
  /** `{name}`. The thrown value's own class name, e.g. `TypeError`. */
  "failure.unexpectedNamed": "未预期的失败（{name}）。完整错误见服务端日志。",
  "failure.unexpected": "未预期的失败。完整错误见服务端日志。",
  /**
   * `{method}`. The parenthetical after 链上读取失败, naming the JSON-RPC call.
   *
   * A fragment rather than a finished sentence, because `describeFailure` splices
   * it into the middle of `failure.rpcUnreachable` where Chinese and English need
   * different punctuation: Chinese uses full-width brackets around the whole
   * clause, English a comma before it. A single template covering both would have
   * to be written to one grammar and would read as broken in the other.
   */
  "failure.callSuffix": "（{method} 调用）",

  /*
    The CSV export's own header block.

    Two of the five metadata ROW labels reuse an existing key rather than being
    written again: 问题 is `poll.question` and 阶段 is `poll.phase`, which are the
    exact words the poll page and the list card already render for the same two
    fields. The tally's column headings do not overlap with anything above and
    are named here.

    `{count}` is a UNIT, not a number: Chinese writes "5 个区块" and English "5
    blocks", so the unit travels inside the template rather than beside a bare
    figure that would read as "个区块 5" once translated.
  */
  "export.pollAddress": "投票合约",
  "export.totalVotes": "票数合计",
  "export.optionId": "选项 ID",
  "export.option": "选项",
  "export.votes": "票数",
  /** A column heading, so the `%` is part of it rather than of the value. */
  "export.sharePercent": "占比%",

  /*
    The two whitelist actions, as recorded in the index's activity feed.

    `加入白名单` and `移出白名单` are ALSO the `admin.addToWhitelist` /
    `admin.removeFromWhitelist` button captions. They are deliberately NOT reused:
    the button is an instruction a creator is about to carry out, while these are
    the past-tense record of an event that already happened, and the two surfaces
    will diverge the first time either is reworded. They are byte-identical
    today, which is why `i18n.test.ts`'s duplication check must be told about
    them — see the allowance table there.
  */
  "whitelist.added": "加入白名单",
  "whitelist.removed": "移出白名单",

  /**
   * The word in front of a refund amount in the activity feed's detail column.
   *
   * A fragment rather than a template, because the amount is formatted by
   * `formatWei` (arbitrary-precision integer arithmetic, not wording) and joined
   * to a literal `ETH`. Passing the finished figure as `{amount}` would put a
   * formatted number through a string template for no gain, and `interpolate`
   * does not accept a bigint in the first place.
   */
  "activity.refundedPrefix": "退回",
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
  "audit.readFailed":
    "An unexpected error occurred while reading the audit events. The full error is in the server log.",
  "audit.indexRequired":
    "Audit events come from the MySQL index and this deployment has no {databaseUrl} configured, so the history cannot be listed. This does not mean “nothing happened” — the events are still being mined, they simply cannot be read here.",
  "audit.indexHowTo":
    "Configure {databaseUrl} and run {commands} to build the index; each poll page's activity record appears with it.",
  "audit.filterLabel": "Filter by event kind",
  "audit.summary": "{count} events across {polls} polls{kind}.",
  "audit.summaryKind": ", kind: {kind}",
  "audit.emptyDetail":
    "The filters and the index itself were both readable, so this is “nothing matched” rather than “nothing could be read”.",
  "audit.pagination": "Audit pages",
  "audit.backToPolls": "← All polls",

  "notifications.title": "My notifications",
  "notifications.subtitle":
    "What has happened in the polls you follow since you last looked. Notifications are derived from the events the indexer recorded — no email and no webhook — and your subscriptions are kept in this site alone, tied only to your wallet address.",
  "notifications.readFailedHttp": "The read failed (HTTP {status}).",
  "notifications.readFailedUnexpected":
    "An unexpected error occurred while reading the notifications. The full error is in the browser console.",
  "notifications.connectFirst":
    "Notifications belong to a wallet address, so a wallet has to be connected first. Once it is, this page lists what is new in the polls you follow.",
  "notifications.indexRequired":
    "Notifications are derived from the events the indexer recorded and this deployment has no {databaseUrl} configured, so nothing can be listed here. This does not mean “nothing is new” — on-chain events are still happening, they simply cannot be read here.",
  "notifications.summary": "{count} unread across {polls} polls{truncated}.",
  "notifications.summaryTruncated": " (this page lists only the newest {limit})",
  "notifications.markAllRead": "Mark all as read",
  "notifications.emptyTitle": "Nothing unread",
  "notifications.emptyDescription":
    "The index is readable and the polls you follow have had no new events since you last looked. That is a definite state, not a failed read. Not subscribed yet? Press “Subscribe to this poll” on any poll page and its votes, vote changes, withdrawals, refunds and phase changes will all appear here.",
  "notifications.markThisRead": "Mark this poll as read",
  "notifications.block": "block {block}",
  "notifications.auditLine":
    "The {audit} lists every event (across all polls); this lists only the part you subscribe to.",

  "home.subtitle":
    "Anyone can start a poll; each poll is its own contract, managed by whoever created it. You can vote, change your vote, withdraw it and reclaim your deposit. Option metadata lives on IPFS and the chain stores only the CID; every write is signed by your own wallet.",
  "home.listFailedTitle": "The poll list could not be read from the chain",
  "home.listFailedDetail":
    "Check that {rpcUrl} in {envFile} is reachable, that {chainId} has a deployed factory contract, and that {exportAbi} has been run. Once a wallet is connected, the list below re-reads it straight from your wallet's network.",
  "home.auditLine":
    "Need to check on-chain events against the index? Open the {audit}, where you can filter by event kind, poll contract or address. That page reads the index, not live chain state.",
  "home.notificationsLine":
    "Only want the polls you follow? Open {notifications}, which lists what is new since you last looked in the polls you subscribe to, keyed to the connected wallet address; with no subscription there is nothing to list.",

  "my.title": "My votes",
  "my.subtitle":
    "The polls this address created, and the polls it currently holds a vote in. Both lists read the chain directly: the chain records who created which poll, while “which polls have I voted in” can only be answered by reading voterState poll by poll, hence the scan cap.",
  "my.serverListFailed": "The server could not read the poll list: {error}",
  "my.browserRetry":
    "The list below still tries to read the factory contract straight from your browser.",

  "shell.brand": "Decentralized voting platform",
  "shell.footerHeading": "Before you use this",
  "shell.footerWhitelist":
    "Each poll's creator maintains its own allowlist, and may call {call} after the grace period to take the deposits nobody reclaimed.",
  "shell.footerIndex": "The indexer (this app's read-only layer) is a rebuildable cache, ",
  "shell.footerIndexEmphasis": "the chain is the only source of truth",
  "shell.footerIndexTail":
    ", and the page reads the chain directly whenever the index is unavailable.",
  "shell.footerWallet":
    "Every write is signed by your own wallet; the backend holds no private key.",

  "chart.title": "Result chart",
  "chart.caption": "Source {source} · {total} votes",
  "chart.barValue": "{votes} votes · {percent}%",
  "chart.noVotes": "No votes yet — nobody has voted in this poll so far.",
  "chart.ariaNoOptions":
    "Result chart: this poll has no options yet, so there is no result to show. Source: {source}.",
  "chart.ariaNoVotes": "Result chart: {message} Source: {source}.",
  "chart.ariaItem": "{label} {votes} votes ({percent}%)",
  "chart.ariaBars": "Result chart: {items}. {total} votes in total, source: {source}.",

  "option.metadataCid": "Metadata CID",
  "option.rawString": "String stored on chain",
  "option.retrying": "Retrying…",
  "option.mine": "This is your current choice",
  "option.changeHere": "Change your vote to this option",
  "option.voteWithStake": "Cast a vote ({amount} ETH deposit)",

  "pollPage.invalidTitle": "Invalid poll address",
  "pollPage.invalidSubtitle":
    "A poll page's address has to be a 20 byte hexadecimal contract address.",
  "pollPage.invalidDetail":
    "The path's {segment} must be a poll contract's address ({prefix} plus 40 hex digits); the value received was {received}.",
  "pollPage.backToPolls": "← Back to all polls",
  "pollPage.fallbackTitle": "Poll",
  "pollPage.subtitle":
    "Voting, changing your vote and withdrawing are all signed by your wallet. Whether a button is available comes entirely from on-chain state: the allowlist, the phase and the deadline.",
  "pollPage.serverReadFailed": "The server could not read this poll ({address}): {error}",
  "pollPage.browserRetry":
    "Everything below still tries to read the same contract straight from your browser; if the address really is not on chain, the rows will show a failed read.",

  "admin.heading": "Creator admin",
  "admin.onlyYou": "Visible to you only",
  "admin.intro":
    "You created this poll, so you alone maintain its allowlist, edit its options and start and end the voting. Every one of these calls is signed by your wallet; whether this panel is shown is only a presentation decision, and the real permission check is the contract's",
  "admin.introTail": ".",
  "admin.lifecycle": "Lifecycle",
  "admin.startPoll": "Start voting",
  "admin.endPoll": "End voting early",
  "admin.closeNote1":
    "If the deadline has passed while the poll still reads Voting, anyone can call",
  "admin.closeNote2":
    "to close it formally — until that happens, even your own deposit cannot be taken back.",
  "admin.whitelist": "Allowlist",
  "admin.whitelistHint":
    "One address per line, or separated by commas. The contract writes them in batches, and a repeated address is idempotently set to the same state.",
  "admin.whitelistField": "Allowlist addresses",
  "admin.addressesFound": "{count} address(es) recognised",
  "admin.addressesList": ": {list}",
  "admin.addressesEnd": ".",
  "admin.addToWhitelist": "Add to the allowlist",
  "admin.removeFromWhitelist": "Remove from the allowlist",
  "admin.options": "Edit options",
  "admin.optionCount": "{count} currently",
  "admin.optionLabel": "#{id}",
  "admin.optionEditField": "New content for option {id}",
  "admin.save": "Save",
  "admin.cancel": "Cancel",
  "admin.rename": "Rename",
  "admin.delete": "Delete",
  "admin.removeRenumber":
    "Deleting an option in the middle moves every option after it down one number, and none of this can be changed once voting has started.",
  "admin.newOptionPlaceholder": "New option text or CID",
  "admin.newOptionLabel": "New option",
  "admin.addOption": "Add an option",
  "admin.sweepTitle": "Unclaimed deposits",
  "admin.sweepIntro":
    "Once the grace period (7 days) has passed, deposits that voters have still not reclaimed may be taken by you. This is a declared centralisation risk of this project: the deposits are the voters' money, so confirm the grace period really has elapsed before taking them.",
  "admin.totalStaked": "Total deposits the contract currently carries:",
  "admin.sweepToPlaceholder": "Recipient address 0x…",
  "admin.sweepToLabel": "Sweep recipient address",
  "admin.useMyAddress": "Fill in my address",
  "admin.sweep": "Take the unclaimed deposits",

  "admin.reason.connectFirst": "Connect a wallet first: these calls are signed by your wallet.",
  "admin.reason.readFailed":
    "Could not read contract state, so it is not possible to tell what can be done. Check the RPC and retry.",
  "admin.reason.reading": "Reading contract state…",
  "admin.reason.noFactoryReason":
    "The current chain ({chainId}, {chainName}) has no registered factory contract, so the poll contract cannot be determined. Switch your wallet to the chain this app is deployed on.",
  "admin.reason.closeNoFactory":
    "The current chain ({chainId}, {chainName}) has no registered factory contract.",
  "admin.reason.closeReadFailed":
    "Could not read the contract phase, so it is not possible to tell whether the poll can be closed. Check the RPC and retry.",
  "admin.reason.closeEnded": "The poll is already formally closed.",
  "admin.reason.closeInSetup":
    "Voting has not started, and the contract will refuse closeAfterDeadline() with InvalidPhase.",
  "admin.reason.closeBeforeDeadline":
    "The deadline has not passed, and the contract will refuse closeAfterDeadline() with DeadlineNotInFuture.",
  "admin.reason.startOnlyWhileSetup":
    "Voting has already started, and the contract will refuse a second startPoll() with InvalidPhase.",
  "admin.reason.startTooFewOptions":
    "At least {min} options are needed to start, and the contract will refuse with TooFewOptions.",
  "admin.reason.startPastDeadline":
    "The deadline has already passed, and the contract will refuse the start with PollAlreadyEnded; create a new poll instead.",
  "admin.reason.endNotStarted":
    "Voting has not started, and the contract will refuse endPoll() with InvalidPhase.",
  "admin.reason.endAlreadyEnded":
    "Voting has already ended, and the contract will refuse endPoll() with InvalidPhase.",
  "admin.reason.whitelistAfterEnd":
    "Voting has ended, and the contract will refuse an allowlist change with InvalidPhase.",
  "admin.reason.whitelistEmpty": "Fill in addresses first: one per line, or separated by commas.",
  "admin.reason.whitelistMalformed":
    "One of the entries is not a 20-byte hexadecimal address (0x plus 40 digits), so none of the batch will be submitted.",
  "admin.reason.whitelistTooMany":
    "At most {limit} addresses can be submitted at once and {count} were given; split them into batches.",
  "admin.reason.optionsLocked":
    "Options can only be changed before voting starts; once it has started the contract refuses every option write with InvalidPhase.",
  "admin.reason.removeTooFew":
    "Only {count} options are left, and the contract will refuse the deletion with TooFewOptions.",
  "admin.reason.sweepNotEnded":
    "Voting has not ended, and the contract will refuse sweepUnclaimed() with InvalidPhase.",
  "admin.reason.sweepNoCloseTime":
    "The contract has not recorded a closing time yet, so it is not possible to tell whether the grace period has elapsed.",
  "admin.reason.sweepGracePeriod":
    "The grace period has not elapsed, and the contract will refuse with GracePeriodNotElapsed; the deposits become claimable at {time}.",
  "admin.reason.sweepNoRecipient": "Fill in a recipient address.",
  "admin.reason.sweepBadRecipient": "The recipient must be a 20-byte hexadecimal address.",

  "create.heading": "Start a new poll",
  "create.subtitleExpanded":
    "The transaction is signed by your own wallet; the backend holds no key.",
  "create.subtitleCollapsed":
    "Anyone can create a poll; the creator owns its allowlist and its ending.",
  "create.intro":
    "The transaction is signed by your own wallet and the backend holds no private key; the contract records you as the creator, and only you can maintain this poll's allowlist afterwards.",
  "create.draftRestored":
    "A draft you had not submitted was restored from this browser (it exists only on this device and is never uploaded). It is cleared automatically once the submission succeeds.",
  "create.templateLabel": "Poll type (template)",
  "create.questionLabel": "Question",
  "create.questionPlaceholder":
    "For example: which proposal should the community fund support first?",
  "create.optionsLabel":
    "Options (at least {min}; you can give a metadata CID or type the text directly)",
  "create.optionPlaceholderFirst": "bafkrei… or the option text directly",
  "create.optionPlaceholderNumbered": "Option {number}",
  "create.removeOption": "Delete",
  "create.addOption": "+ Add an option",
  "create.deadlineLabel": "Deadline",
  "create.deadlineHint":
    "Read in this machine's timezone and converted to a Unix timestamp when it goes on chain.",
  "create.admissionLegend": "Who may vote",
  "create.admissionOpen": "Everyone",
  "create.admissionOpenHint": "— any address can vote, with nothing to add in advance.",
  "create.admissionWhitelist": "Allowlist only",
  "create.admissionWhitelistHint":
    "— after creating it you add addresses one by one in the poll page's admin panel, and until you do nobody can vote.",
  "create.admissionFixed": "This choice is written into the contract at creation and ",
  "create.admissionFixedEmphasis": "cannot be changed afterwards",
  "create.admissionFixedTail":
    " (the contract has no function for it). To use a different admission mode, create another poll.",
  "create.cidSummary1": "Of these {total} options, {cids} will be registered as ",
  "create.cidEmphasis": "metadata CIDs",
  "create.cidSummary2":
    " (whoever opens the poll fetches the document from an IPFS gateway by CID); the other {raw} are not CID-shaped and will be ",
  "create.cidRawEmphasis": "stored verbatim as the option text",
  "create.cidSummary3":
    ", with no document to fetch. The contract does not check this, the string is written permanently, and it cannot be changed after creation.",
  "create.submit": "Create the poll",
  "create.draftSaved": "The draft is saved in this browser and can be resumed after a refresh.",
  "create.draftUnsaved1":
    "This browser does not allow local storage (private mode, or storage disabled), so the draft will ",
  "create.draftUnsavedEmphasis": "not",
  "create.draftUnsaved2": " be kept and will have to be retyped after a refresh.",
  "create.clearDraft": "Clear the draft",
  "create.created": " · confirmed; the new poll is in the list below",
  "create.connectForCreator": "Connect a wallet and the creator's address will appear here.",

  "create.reason.noFactory":
    "The current chain ({chainId}, {chainName}) has no registered factory contract, so a poll cannot be created. Switch your wallet to the chain this app is deployed on.",
  "create.reason.connectFirst":
    "Connect a wallet first: creating a poll has to be signed by your wallet, and the contract records that address as the creator.",
  "create.reason.emptyQuestion":
    "Fill in the poll's question: the contract refuses an empty question with EmptyQuestion.",
  "create.reason.tooFewOptions":
    "At least {min} options are needed: the contract refuses a poll with fewer than {min} options with TooFewOptions.",
  "create.reason.noDeadline":
    "Pick a deadline: the contract refuses an empty or unparseable one with DeadlineNotInFuture.",
  "create.reason.deadlinePast":
    "The deadline has to be in the future: the contract refuses a time already past with DeadlineNotInFuture.",

  "subscribe.connectFirst":
    "Connect a wallet to subscribe to this poll; its votes, vote changes, withdrawals, refunds and phase changes will appear under",
  "subscribe.notifications": "My notifications",
  "subscribe.connectLast":
    ". A subscription is one row on this site; it needs no signature and never goes on chain.",
  "subscribe.reading": "Reading the subscription state…",
  "subscribe.noIndex1": "This deployment has no index configured (",
  "subscribe.noIndex2":
    "), so a subscription cannot be saved. This is not “the subscription failed” — there is simply nowhere here to record it.",
  "subscribe.readFailed":
    "Reading the subscription state failed, so whether you are currently subscribed cannot be determined. The full error is in the browser console.",
  "subscribe.subscribe": "Subscribe to this poll",
  "subscribe.unsubscribe": "Unsubscribe from this poll",
  "subscribe.note":
    "A subscription is one row on this site; it never goes on chain and needs no signature.",

  "template.defaultsLabel": "Default",
  "template.switchConfirm":
    "Switching to “{name}” replaces the current mechanism config; the fields you have filled in are kept. Continue?",

  "mechanism.single": "Single choice, one option per ballot",
  "mechanism.multiSelect": "Multi-select, up to {count} per ballot",
  "mechanism.weighted": "Counted by address weight",
  "mechanism.oneVoteEach": "One vote each",
  "mechanism.notCommitReveal": "Choices are not hidden (no commit-reveal)",
  "mechanism.delegable": "Voting power can be delegated",
  "mechanism.notDelegable": "No delegation",
  "mechanism.openToAll": "Open to everyone",
  "mechanism.whitelistOnly": "Allowlist only",
  "mechanism.unknown": "Unknown",

  "mechanism.problem.multiSelect":
    "The multi-select template needs at least 2 selections per ballot and the current cap is below 2, so the contract will refuse to create this poll.",
  "mechanism.problem.weighted":
    "Weighted voting needs an allowlist first: with the poll open to everyone there is no defined set of voting power, so the contract will refuse to create it. Set “Who may vote” back to “Allowlist only”, or pick another template.",
  "mechanism.problem.commitRevealWindow":
    "Hiding choices (commit-reveal) requires a reveal window and the current one is 0, so the contract will refuse to create this poll.",
  "mechanism.problem.commitRevealDelegation":
    "Hidden choices cannot be combined with delegated voting yet, so the contract will refuse to create this poll.",

  "execution.title": "Result execution",
  "execution.description":
    "A passed vote can authorise exactly one on-chain action. It waits out the timelock first, so voters can see what is about to happen.",
  "execution.outcome": "Outcome",
  "execution.explanation": "Explanation",
  "execution.quorum": "Quorum",
  "execution.turnout": "Turnout",
  "execution.quorumMet": " — quorum met",
  "execution.belowQuorum": " — below quorum",
  "execution.queue": "Queue",
  "execution.nothingQueued": "Nothing queued yet.",
  "execution.onlyPassed": "Only a passed vote can be queued.",
  "execution.target": "Target",
  "execution.status": "Status",
  "execution.waiting": "Waiting out the timelock — {seconds}s remaining.",
  "execution.ready": "Ready to execute now.",
  "execution.done": "Executed.",
  "execution.failed": "The last attempt reverted",
  "execution.failedTail": ". The vote is unchanged and this can be retried.",
  "execution.calldata": "Call data",
  "execution.allowedTargets": "Allowed targets",
  "execution.selfOnly": "This poll itself only.",
  "execution.queueAction": "Queue an action",
  "execution.execute": "Execute",
  "execution.cancel": "Cancel",

  "common.busy": "Submitting…",

  "audit.kind.cast": "Vote",
  "audit.kind.changed": "Change",
  "audit.kind.withdrawn": "Withdrawal",
  "audit.kind.refunded": "Refund",
  "audit.kind.whitelist": "Allowlist",

  "trust.rulesUnchangedTitle": "The rules match what was committed at creation",
  "trust.rulesUnchangedDetail":
    "The question, the options, the deadline, the admission mode and the allowlist as they stand on chain were run through the fingerprint calculation again, and the result is the same as the commitment written at creation: none of that content has been changed since. Anyone can recompute it independently and get the same answer.",
  "trust.rulesChangedTitle": "The rules have been changed since creation",
  "trust.rulesChangedDetail":
    "The fingerprint of the current on-chain state differs from the commitment written at creation, so the question, the options, the deadline, the admission mode or the allowlist has been edited at least once since. That is not necessarily a problem — a creator adding or removing options and maintaining the allowlist before voting opens is the intended workflow — but you should know it rather than have to take the page's word for it. A change can only have happened before voting started, because the options are frozen once it does.",
  "trust.rulesUnknownTitle": "The rules fingerprints cannot be compared",
  "trust.rulesUnknownDetail":
    "The commitment written at creation and the current state could not both be read, so whether the rules have been changed cannot be determined. This does not mean the rules are fine, and it does not mean they are not — it means this particular check did not succeed. You can retry, or call rulesHash() and currentRulesHash() yourself in a block explorer and compare them directly.",

  "failure.rpcUnreachable":
    "The on-chain read failed{call}: every configured RPC endpoint was unresponsive (the connection failed or the request timed out). Check that RPC_URL / RPC_URLS in web/.env are reachable; the full error is in the server log.",
  "failure.databaseUnreachable":
    "The index database (MySQL) is unreadable or unwritable. Check DATABASE_URL in web/.env and whether the database is running; the full error is in the server log.",
  "failure.unexpectedNamed": "An unexpected failure ({name}). The full error is in the server log.",
  "failure.unexpected": "An unexpected failure. The full error is in the server log.",
  "failure.callSuffix": " (the {method} call)",

  "export.pollAddress": "Poll contract",
  "export.totalVotes": "Total votes",
  "export.optionId": "Option ID",
  "export.option": "Option",
  "export.votes": "Votes",
  "export.sharePercent": "Share %",

  "whitelist.added": "Added to the allowlist",
  "whitelist.removed": "Removed from the allowlist",

  "activity.refundedPrefix": "Refunded",
} satisfies Messages;
