// SPDX-License-Identifier: MIT
/**
 * The sentences the ballot shows for a disabled control, per language.
 *
 * ---------------------------------------------------------------------------
 * Why the WORDS moved here but the ORDER did not
 * ---------------------------------------------------------------------------
 *
 * `ballot-reasons.ts` decides which of several causes applies, and the order of
 * those checks IS the specification: it follows the contract's own checks so the
 * sentence matches the revert the reader would otherwise get (ADR-0009), and each
 * branch names a distinct cause (ADR-0012). None of that is presentation.
 *
 * What is presentation is the wording. So the order and the predicates stay in
 * `ballot-reasons.ts` and only the strings live here. A translation can therefore
 * never change which reason a reader is given — the worst a bad translation can
 * do is say it badly, which is recoverable. Had the branches themselves moved
 * into the catalogue, a translator could reorder a reader's rights.
 *
 * ---------------------------------------------------------------------------
 * Why this is a typed interface rather than nested message keys
 * ---------------------------------------------------------------------------
 *
 * A lookup like `t("ballot.vote.phaseReadFailed")` returns `string | undefined`
 * the moment a key is misspelled, and the failure appears as an empty sentence on
 * screen. An interface makes every language prove it answers every question, at
 * compile time: adding a phrase to this file breaks `en.ts` and `zh.ts` until both
 * answer it.
 *
 * Placeholders use `{name}` and are filled by `interpolate`. See that function for
 * why an unfilled placeholder is left visible rather than blanked.
 */

export interface BallotPhrases {
  /** Shown for every control while any write for the page is outstanding. */
  busy: string;

  connectWallet: string;

  /** `{chainId}`, `{chainName}`, `{suffix}`. */
  wrongNetwork: string;
  /** The bare clause, for `closeAfterDeadline` and `withdraw`. */
  contractUnknownGeneric: string;
  /** The clause for the two vote paths, which adds the remedy. */
  contractUnknownCannotDetermine: string;
  /** The clause for `refund`, whose remedy is about the stake. */
  contractUnknownCannotRefund: string;

  readingContract: string;
  readingVoterState: string;
  readingStake: string;

  votePhaseReadFailed: string;
  voteVoterReadFailed: string;
  withdrawStatusReadFailed: string;
  refundPhaseReadFailed: string;
  refundStakeReadFailed: string;
  closeReadFailed: string;

  setup: string;
  reveal: string;
  deadlinePassed: string;
  ended: string;

  whitelistedButRefused: string;
  notWhitelisted: string;

  alreadyVoted: string;
  sameOption: string;
  hasNotVoted: string;

  withdrawInReveal: string;
  withdrawEnded: string;
  withdrawInSetup: string;

  refundBeforeEnd: string;
  refundNothing: string;

  closeEnded: string;
  closeInSetup: string;
  closeBeforeDeadline: string;

  /*
    ---------------------------------------------------------------------------
    The sentences in `ballot-labels.ts` — the page's STATEMENTS ABOUT ITS READS
    ---------------------------------------------------------------------------

    Separated from the disabled-control reasons above because they answer a
    different question. Those explain why a button is off; these say what a row
    actually reports, including "we could not find out". `ballot-labels.ts`'s own
    header records the defect family these exist for: a failed read rendering as
    a confident `0`, `否`, or `0 ETH`.

    Every one of these is wording. The status that selects between them is passed
    in, and the choice of branch is made in `ballot-labels.ts`, so a translation
    cannot turn "read failed" into "the answer is zero".
  */

  /** Read-state sentences, shared by many rows. */
  readFailed: string;
  reading: string;
  /**
   * "This feature is off in this deployment." One key rather than two: `lagText`
   * and `indexHeightText` both print it for an unconfigured index, and two names
   * for one sentence is the duplicated-derivation pattern `i18n.test.ts` refuses.
   */
  notAvailable: string;
  yes: string;
  no: string;
  notConnected: string;
  nothing: string;

  /** `{id}`. */
  candidateNumbered: string;

  /** One of the two provenance claims. See `tallySourceLabel` on why these are one spelling. */
  tallyFromIndex: string;
  tallyFromChain: string;

  /** `{attempts}`. */
  metadataGatewaysUnreachable: string;
  /** `{answered}`, `{attempts}`. */
  metadataNoUsableDocument: string;
  metadataNotACid: string;
  metadataUnexpectedError: string;
  metadataUnknown: string;
  metadataResolved: string;
  metadataInvalidCid: string;
  /** `{id}`. */
  optionNumbered: string;

  /** `{indexed}`, `{safeHead}`. */
  indexHeight: string;
  /** `{head}`, `{confirmations}`. */
  chainHeadWithPending: string;

  /** `{from}`, `{to}`, `{seen}`, `{inserted}`. */
  syncSynced: string;
  /** `{block}`. */
  syncRewound: string;
  /** `{block}`. */
  syncIdle: string;
  syncDone: string;
  syncDisabled: string;

  /** The wallet-facing write path. Each names the party and that party's exit. */
  writeUserRejected: string;
  writeAlreadyPending: string;
  writeWrongChain: string;
  writeInsufficientFunds: string;
  writeAlreadyKnown: string;
  writeReverted: string;
  writeUnclassified: string;
}

export const ZH_BALLOT_PHRASES: BallotPhrases = {
  busy: "上一笔交易还在确认中，请等它完成。",

  connectWallet: "请先连接钱包。",

  wrongNetwork: "当前链（{chainId}，{chainName}）没有已登记的工厂合约，{suffix}",
  contractUnknownGeneric: "无法确定投票合约。",
  contractUnknownCannotDetermine: "无法确定投票合约。请在钱包里切到本应用部署的那条链。",
  contractUnknownCannotRefund: "无法确定投票合约，也就无法取回押金。",

  readingContract: "正在读取合约状态…",
  readingVoterState: "正在读取你在本投票中的状态…",
  readingStake: "正在读取押金余额…",

  votePhaseReadFailed: "读取合约阶段失败，无法判断能否投票；请检查 RPC 后重试。",
  voteVoterReadFailed: "读取你在本投票中的状态失败，无法判断能否投票；请检查 RPC 后重试。",
  withdrawStatusReadFailed: "读取合约状态失败，无法判断能否撤票；请检查 RPC 后重试。",
  refundPhaseReadFailed: "读取合约阶段失败，无法判断能否取回押金；请检查 RPC 后重试。",
  refundStakeReadFailed: "读取押金余额失败，无法判断是否有可取回的押金；请检查 RPC 后重试。",
  closeReadFailed: "读取合约阶段失败，无法判断能否关闭；请检查 RPC 后重试。",

  setup: "投票尚未开始：发起人还没有调用 startPoll()，此刻合约不接受任何投票。",
  reveal:
    "投票窗口已关闭，现在处于揭示阶段：合约不再接受新的投票或改投，只能揭示此前提交的承诺。揭示期结束后未揭示的承诺视为弃权，押金仍可取回。",
  deadlinePassed:
    "已过截止时间，合约不再接受投票（也拒绝改投与撤票）。押金要等投票被正式关闭后才能取回。",
  ended: "投票已结束，合约不再接受投票与改投。若你还有押金，可以用「取回押金」拿回。",

  whitelistedButRefused:
    "这个地址虽然在本投票的白名单里，但合约当前不接受它投票；请确认阶段与截止时间。",
  notWhitelisted: "这个地址不在本投票的白名单里，合约会拒绝投票与改投。白名单由发起人维护。",

  alreadyVoted:
    "你已经投过票了，合约会以 AlreadyVoted 拒绝第二次投票。要换选项请用其他选项上的「改投」，要退出请用「撤票」。",
  sameOption: "你当前就投给了这个选项，合约会以 SameOption 拒绝「改投到同一个选项」。",
  hasNotVoted: "你目前在本投票中没有任何有效票，合约会以 HasNotVoted 拒绝撤票。",

  withdrawInReveal:
    "揭示阶段不能撤票：此时撤票等于放弃这一票。未揭示的承诺会在揭示期结束后自动视为弃权，押金仍可取回。",
  withdrawEnded: "投票已经结束，撤票只在投票进行中可用；押金请用「取回押金」拿回。",
  withdrawInSetup: "投票尚未开始。",

  refundBeforeEnd:
    "投票还没结束，押金现在不能取回；结束前想退出请用「撤票」（撤票会把押金当场退给你）。",
  refundNothing: "没有可取回的押金。",

  closeEnded: "投票已经正式关闭了。",
  closeInSetup: "投票还没开始，合约会以 InvalidPhase 拒绝 closeAfterDeadline()。",
  closeBeforeDeadline: "还没到截止时间，合约会以 DeadlineNotInFuture 拒绝 closeAfterDeadline()。",

  readFailed: "读取失败",
  reading: "读取中…",
  notAvailable: "未启用",
  yes: "是",
  no: "否",
  notConnected: "未连接",
  nothing: "—",

  candidateNumbered: "候选人 #{id}",

  tallyFromIndex: "MySQL 索引",
  tallyFromChain: "链上直读",

  metadataGatewaysUnreachable: "{attempts} 个网关均不可达，已降级显示编号",
  metadataNoUsableDocument:
    "网关可访问（{answered}/{attempts} 个已作答），但没有返回可用的选项元数据",
  metadataNotACid: "不是元数据 CID，显示原文",
  metadataUnexpectedError: "读取元数据时发生了未预期的错误",
  metadataUnknown: "元数据状态未知",
  metadataResolved: "已解析",
  metadataInvalidCid: "CID 格式无效，无法解析",
  optionNumbered: "选项 #{id}",

  indexHeight: "{indexed} / 安全头 {safeHead}",
  chainHeadWithPending: "{head}（最近 {confirmations} 块待确认）",

  syncSynced: "已索引区块 {from}–{to}，读取 {seen} 个事件，写入 {inserted} 行。",
  syncRewound: "检测到链重组，已回退到区块 {block}，被孤立的行已删除。",
  syncIdle: "索引已经追上安全头（{block}），没有新的可索引区块。",
  syncDone: "同步完成。",
  syncDisabled: "索引未启用，没有可同步的数据库。",

  writeUserRejected: "你在钱包里拒绝了这笔交易，链上没有任何变化。",
  writeAlreadyPending:
    "你的钱包里已经有一个待处理的请求，请先在上面那个弹窗里处理完，再重试；链上没有任何变化。",
  writeWrongChain:
    "钱包所在的网络与页面配置的网络不是同一条链，交易没有发出。请切换钱包网络后重试。",
  writeInsufficientFunds: "钱包余额不足以支付押金和网络费，交易没有发出，链上没有任何变化。",
  writeAlreadyKnown:
    "钱包或节点认为这笔交易已经提交过，链上可能已经有一笔相同的交易。请等它确认，或刷新页面查看状态，不要重复提交。",
  writeReverted: "合约回滚了这笔交易：链上状态没有改变（这笔交易若已被打包，网络费仍会消耗）。",
  writeUnclassified:
    "交易没有完成：钱包或节点返回了一个页面无法归类的错误。原始错误已输出到浏览器控制台。",
};

/**
 * English.
 *
 * `satisfies BallotPhrases` rather than `: BallotPhrases` on purpose: it proves at
 * compile time that every phrase is answered, while keeping the literal types so a
 * typo in a placeholder name is still visible.
 *
 * Contract error names (`AlreadyVoted`, `SameOption`, `HasNotVoted`,
 * `InvalidPhase`, `DeadlineNotInFuture`) and entry points (`startPoll()`,
 * `closeAfterDeadline()`) are NOT translated. They are the identifiers a reader
 * will see in their wallet's error and look up, and renaming them in the UI would
 * sever the one link between this sentence and the thing that actually happened.
 */
export const EN_BALLOT_PHRASES = {
  busy: "The previous transaction is still confirming. Wait for it to finish.",

  connectWallet: "Connect a wallet first.",

  wrongNetwork:
    "The current chain ({chainId}, {chainName}) has no registered factory contract, so {suffix}",
  contractUnknownGeneric: "the poll contract cannot be determined.",
  contractUnknownCannotDetermine:
    "the poll contract cannot be determined. Switch your wallet to the chain this app is deployed on.",
  contractUnknownCannotRefund:
    "the poll contract cannot be determined, so the stake cannot be reclaimed.",

  readingContract: "Reading contract state…",
  readingVoterState: "Reading your state in this poll…",
  readingStake: "Reading the stake balance…",

  votePhaseReadFailed:
    "Could not read the contract phase, so it is not possible to tell whether voting is open. Check the RPC and try again.",
  voteVoterReadFailed:
    "Could not read your state in this poll, so it is not possible to tell whether you can vote. Check the RPC and try again.",
  withdrawStatusReadFailed:
    "Could not read contract state, so it is not possible to tell whether the vote can be withdrawn. Check the RPC and try again.",
  refundPhaseReadFailed:
    "Could not read the contract phase, so it is not possible to tell whether the stake can be reclaimed. Check the RPC and try again.",
  refundStakeReadFailed:
    "Could not read the stake balance, so it is not possible to tell whether there is a stake to reclaim. Check the RPC and try again.",
  closeReadFailed:
    "Could not read the contract phase, so it is not possible to tell whether the poll can be closed. Check the RPC and try again.",

  setup:
    "Voting has not started: the creator has not called startPoll() yet, so the contract accepts no votes.",
  reveal:
    "The voting window is closed and the reveal phase is open: the contract accepts no new votes or vote changes, only reveals of commitments already made. Commitments left unrevealed after the reveal window count as abstentions, and the stake is still reclaimable.",
  deadlinePassed:
    "The deadline has passed, so the contract accepts no votes (and refuses vote changes and withdrawals). The stake becomes reclaimable once the poll is formally closed.",
  ended:
    "Voting has ended, so the contract accepts no votes or vote changes. If you still have a stake, reclaim it with Reclaim stake.",

  whitelistedButRefused:
    "This address is on the poll's allowlist, but the contract does not currently accept a vote from it. Check the phase and the deadline.",
  notWhitelisted:
    "This address is not on the poll's allowlist, so the contract will refuse voting and vote changes. The creator maintains the allowlist.",

  alreadyVoted:
    "You have already voted, and the contract will refuse a second vote with AlreadyVoted. To pick a different option use Change vote on that option; to leave the poll use Withdraw vote.",
  sameOption: "This is already your choice, and the contract will refuse a change with SameOption.",
  hasNotVoted:
    "You hold no counted vote in this poll, and the contract will refuse the withdrawal with HasNotVoted.",

  withdrawInReveal:
    "Withdrawing is not possible during the reveal phase: doing so here would mean abandoning the vote. Commitments left unrevealed count as abstentions once the reveal window ends, and the stake is still reclaimable.",
  withdrawEnded:
    "Voting has ended. Withdrawing only works while voting is open; reclaim the stake with Reclaim stake instead.",
  withdrawInSetup: "Voting has not started.",

  refundBeforeEnd:
    "Voting has not ended, so the stake cannot be reclaimed yet. To leave before the end, use Withdraw vote, which returns the stake immediately.",
  refundNothing: "There is no stake to reclaim.",

  closeEnded: "The poll is already formally closed.",
  closeInSetup:
    "Voting has not started, and the contract will refuse closeAfterDeadline() with InvalidPhase.",
  closeBeforeDeadline:
    "The deadline has not passed, and the contract will refuse closeAfterDeadline() with DeadlineNotInFuture.",

  readFailed: "Read failed",
  reading: "Reading…",
  notAvailable: "Not enabled",
  yes: "Yes",
  no: "No",
  notConnected: "Not connected",
  nothing: "—",

  candidateNumbered: "Candidate #{id}",

  // Both are proper nouns describing where the numbers came from; `MySQL` stays
  // as-is in both languages for the same reason `IPFS` does.
  tallyFromIndex: "MySQL index",
  tallyFromChain: "Read from chain",

  metadataGatewaysUnreachable:
    "All {attempts} gateways were unreachable; falling back to the number",
  metadataNoUsableDocument:
    "The gateways answered ({answered}/{attempts} responded), but none returned usable option metadata",
  metadataNotACid: "Not a metadata CID, so the raw text is shown",
  metadataUnexpectedError: "An unexpected error occurred while reading the metadata",
  metadataUnknown: "The metadata state is unknown",
  metadataResolved: "Resolved",
  metadataInvalidCid: "The CID is malformed and cannot be resolved",
  optionNumbered: "Option #{id}",

  indexHeight: "{indexed} / safe head {safeHead}",
  chainHeadWithPending: "{head} (the last {confirmations} block(s) awaiting confirmation)",

  syncSynced: "Indexed blocks {from}–{to}: {seen} event(s) read, {inserted} row(s) written.",
  syncRewound:
    "A chain reorganisation was detected; rolled back to block {block} and deleted the orphaned rows.",
  syncIdle: "The index has caught up to the safe head ({block}); there are no new blocks to index.",
  syncDone: "Sync complete.",
  syncDisabled: "The index is not enabled, so there is no database to sync.",

  writeUserRejected: "You rejected this transaction in your wallet. Nothing changed on chain.",
  writeAlreadyPending:
    "Your wallet already has a pending request. Handle it in the popup first, then try again; nothing changed on chain.",
  writeWrongChain:
    "The wallet is on a different chain from the one this page is configured for, so the transaction was not sent. Switch the wallet's network and try again.",
  writeInsufficientFunds:
    "The wallet balance cannot cover the stake and the network fee, so the transaction was not sent and nothing changed on chain.",
  writeAlreadyKnown:
    "The wallet or node considers this transaction already submitted; an identical one may already be on chain. Wait for it to confirm, or refresh to check its status, rather than submitting again.",
  writeReverted:
    "The contract reverted this transaction, so no on-chain state changed. (If it was mined, the network fee is still spent.)",
  writeUnclassified:
    "The transaction did not complete: the wallet or node returned an error this page cannot classify. The raw error was written to the browser console.",
} satisfies BallotPhrases;
