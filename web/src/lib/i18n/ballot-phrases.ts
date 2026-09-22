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
} satisfies BallotPhrases;
