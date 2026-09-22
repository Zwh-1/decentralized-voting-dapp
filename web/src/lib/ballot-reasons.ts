// SPDX-License-Identifier: MIT
/**
 * Why each control on the ballot is or is not available.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module rather than five closures inside the component
 * ---------------------------------------------------------------------------
 *
 * These functions decide what the reader is told about their own money. Every
 * branch names a distinct cause (ADR-0012), the order follows the contract's own
 * checks so the sentence matches the revert the reader would otherwise get
 * (ADR-0009), and no branch ever invents a cause for an error it did not
 * recognise (ADR-0020) — those are correctness rules, not presentation.
 *
 * They used to live inside `PollBallot.tsx`, where the only way to test them was
 * a browser drill: the component imports wagmi, React and a query client, so
 * nothing about it can be driven from `node --test`. Extracting them makes each
 * rule a plain function call, and `ballot-reasons.test.ts` now asserts them
 * directly instead of through a headless Chrome.
 *
 * The shape is deliberate: one `BallotInputs` value in, one sentence out. No
 * closures over hook results, no ordering hidden in a component body — the order
 * IS the specification, and it is now visible and testable in one file.
 */
import { chainName, PollPhase } from "./voting";
import type { ReadState } from "./ballot-labels";

/** Everything the reason functions need. All of it comes from chain reads. */
export interface BallotInputs {
  /** False when the connected chain has no registered factory. */
  contractKnown: boolean;
  /** The chain the page is asking, for the "wrong network" sentence. */
  subjectChainId: number;
  isConnected: boolean;
  /** True while any write for this page is outstanding. */
  txBusy: boolean;

  phaseState: ReadState;
  voterState: ReadState;

  /** 0 Setup, 1 Voting, 2 Ended. Undefined while unread. */
  phase: number | undefined;
  /** True when the poll's own `endsAt` has passed, per the browser clock. */
  deadlinePassed: boolean;

  /** The contract's own admission decision: `openToAll || isWhitelisted`. */
  canVote: boolean;
  /** The raw whitelist answer, used only to explain a refusal precisely. */
  whitelisted: boolean;
  /** True when the address currently backs an option. */
  marked: boolean;
  /** The option the address currently backs; 0 when it backs none. */
  myOptionId: number;
  /** The stake held for the address, in wei. */
  myStake: bigint | undefined;
}

/** The sentence for a write that has to wait; shared by every control. */
export const BUSY_REASON = "上一笔交易还在确认中，请等它完成。";

/** `Phase.Ended`, or a `Voting` poll whose deadline has passed. */
function votingClosed(input: BallotInputs): boolean {
  return (
    input.phase === PollPhase.Ended || (input.phase === PollPhase.Voting && input.deadlinePassed)
  );
}

function isSetup(input: BallotInputs): boolean {
  return input.phase === PollPhase.Setup;
}

/** The "wrong chain / no factory" sentence. Named once so it cannot drift. */
function unknownContract(input: BallotInputs, suffix: string): string {
  return `当前链（${input.subjectChainId}，${chainName(input.subjectChainId)}）没有已登记的工厂合约，${suffix}`;
}

/** Reads a status as a sentence, for the two states neither ready nor failed. */
function statusSentence(state: ReadState, failedText: string, loadingText: string): string {
  return state === "failed" ? failedText : loadingText;
}

/**
 * Everything that blocks BOTH 投票 and 改投, in the contract's own check order.
 *
 * Split out from `voteReason` because the two entry points differ in exactly one
 * condition — whether a vote already exists. The earlier version decided that by
 * comparing `voteReason`'s sentence against a literal, which worked right up
 * until the sentence was edited, at which point 改投 would have silently started
 * reporting "you have already voted" as its reason for being disabled. A shared
 * function returning a sentence cannot drift that way, and the shared part is now
 * literally shared.
 *
 * The order is the contract's: `vote` and `changeVote` both check the phase, then
 * the deadline, then admission. Reporting a different order would tell a reader
 * the wrong reason about a poll that is, say, both closed and not admitted.
 */
export function sharedBlock(input: BallotInputs): string | undefined {
  return checkUntilAdmission(input) ?? admissionBlock(input);
}

/**
 * The checks every write path makes, up to but not including admission.
 *
 * `withdrawReason` and `refundReason` deliberately do not use this: their
 * sentences differ per control, so they repeat the same ordered checks with their
 * own wording. What they must not do is reorder them, and they do not.
 */
function checkUntilAdmission(input: BallotInputs): string | undefined {
  if (!input.contractKnown) {
    return unknownContract(input, "无法确定投票合约。请在钱包里切到本应用部署的那条链。");
  }

  if (!input.isConnected) {
    return "请先连接钱包。";
  }

  if (input.txBusy) {
    return BUSY_REASON;
  }

  if (input.phaseState !== "ready") {
    return statusSentence(
      input.phaseState,
      "读取合约阶段失败，无法判断能否投票；请检查 RPC 后重试。",
      "正在读取合约状态…",
    );
  }

  if (isSetup(input)) {
    return "投票尚未开始：发起人还没有调用 startPoll()，此刻合约不接受任何投票。";
  }

  if (votingClosed(input)) {
    // Distinguishes the two ways a poll can be closed, because the remedy
    // differs: an Ended poll already lets the stake out, a past-deadline one
    // needs `closeAfterDeadline()` first.
    return input.deadlinePassed && input.phase === PollPhase.Voting
      ? "已过截止时间，合约不再接受投票（也拒绝改投与撤票）。押金要等投票被正式关闭后才能取回。"
      : "投票已结束，合约不再接受投票与改投。若你还有押金，可以用「取回押金」拿回。";
  }

  if (input.voterState !== "ready") {
    return statusSentence(
      input.voterState,
      "读取你在本投票中的状态失败，无法判断能否投票；请检查 RPC 后重试。",
      "正在读取你在本投票中的状态…",
    );
  }

  return undefined;
}

/**
 * The admission gate, which only `vote` has.
 *
 * `changeVote` and `withdrawVote` carry NO whitelist check in the contract — a
 * reader whose entry was revoked mid-ballot can still move or release a vote they
 * already hold, and they must not be told otherwise. `canVote` is therefore
 * applied by `voteReason`/`changeReason` only when the call actually checks it:
 * see `changeReason`, which skips this gate exactly when the reader already
 * holds a vote.
 */
function admissionBlock(input: BallotInputs): string | undefined {
  if (!input.canVote) {
    // `canVote` is `openToAll || whitelisted`, so on an open poll this branch is
    // unreachable for every address. A reader who reaches it is genuinely on a
    // whitelisted poll, and the sentence says which of the two sub-cases applies.
    return input.whitelisted
      ? "这个地址虽然在本投票的白名单里，但合约当前不接受它投票；请确认阶段与截止时间。"
      : "这个地址不在本投票的白名单里，合约会拒绝投票与改投。白名单由发起人维护。";
  }

  return undefined;
}

/** Why 投票 is unavailable. */
export function voteReason(input: BallotInputs): string | undefined {
  const blocked = sharedBlock(input);

  if (blocked !== undefined) {
    return blocked;
  }

  if (input.marked) {
    // Not a dead end: the same address can move its vote, which is the operation
    // the old single-tenant contract could not express at all.
    return "你已经投过票了，合约会以 AlreadyVoted 拒绝第二次投票。要换选项请用其他选项上的「改投」，要退出请用「撤票」。";
  }

  return undefined;
}

/**
 * Why 改投 is unavailable on this particular option.
 *
 * The admission gate is applied only when the reader does NOT already hold a
 * vote. That is not a shortcut: `changeVote` has no whitelist check at all, so
 * an address that voted and was then removed from the list can still change its
 * vote, and blocking the button would refuse a call the chain would accept. In
 * the other direction, an unmarked address reaching this function is being
 * offered a change it cannot make (`HasNotVoted`), so the admission sentence is
 * the right one to show.
 */
export function changeReason(input: BallotInputs, optionId: number): string | undefined {
  const blocked = checkUntilAdmission(input) ?? (input.marked ? undefined : admissionBlock(input));

  if (blocked !== undefined) {
    return blocked;
  }

  if (optionId === input.myOptionId) {
    // The contract reverts with `SameOption` here, so offering the button would
    // offer a transaction guaranteed to fail — and that failure would arrive as a
    // wallet prompt the reader has no reason to expect.
    return "你当前就投给了这个选项，合约会以 SameOption 拒绝「改投到同一个选项」。";
  }

  return undefined;
}

/** Why 撤票 is unavailable. */
export function withdrawReason(input: BallotInputs): string | undefined {
  if (!input.contractKnown) {
    return unknownContract(input, "无法确定投票合约。");
  }

  if (!input.isConnected) {
    return "请先连接钱包。";
  }

  if (input.txBusy) {
    return BUSY_REASON;
  }

  if (input.phaseState !== "ready" || input.voterState !== "ready") {
    return input.phaseState === "failed" || input.voterState === "failed"
      ? "读取合约状态失败，无法判断能否撤票；请检查 RPC 后重试。"
      : "正在读取合约状态…";
  }

  if (votingClosed(input)) {
    return "投票已经结束，撤票只在投票进行中可用；押金请用「取回押金」拿回。";
  }

  if (isSetup(input)) {
    return "投票尚未开始。";
  }

  if (!input.marked) {
    // The contract reverts with `HasNotVoted`. Saying which of "never voted" and
    // "already withdrawn" applies is not possible from `voterState` alone, and
    // guessing would be worse than saying the fact that is checkable.
    return "你目前在本投票中没有任何有效票，合约会以 HasNotVoted 拒绝撤票。";
  }

  return undefined;
}

/** Why 取回押金 is unavailable. */
export function refundReason(input: BallotInputs): string | undefined {
  if (!input.contractKnown) {
    return unknownContract(input, "无法确定投票合约，也就无法取回押金。");
  }

  if (!input.isConnected) {
    return "请先连接钱包。";
  }

  if (input.txBusy) {
    return BUSY_REASON;
  }

  if (!votingClosed(input)) {
    return input.phaseState !== "ready"
      ? statusSentence(
          input.phaseState,
          "读取合约阶段失败，无法判断能否取回押金；请检查 RPC 后重试。",
          "正在读取合约状态…",
        )
      : "投票还没结束，押金现在不能取回；结束前想退出请用「撤票」（撤票会把押金当场退给你）。";
  }

  if (input.voterState !== "ready") {
    return statusSentence(
      input.voterState,
      "读取押金余额失败，无法判断是否有可取回的押金；请检查 RPC 后重试。",
      "正在读取押金余额…",
    );
  }

  if (input.myStake === undefined || input.myStake === 0n) {
    return "没有可取回的押金。";
  }

  return undefined;
}

/**
 * Why `closeAfterDeadline` is unavailable.
 *
 * This call is PERMISSIONLESS, so nothing here asks who the reader is, whether a
 * wallet is connected, or whether a transaction is already in flight on their
 * behalf. Those are the checks every other reason function makes, and omitting
 * them is the point: this button exists precisely so that a poll whose creator
 * walked away can still be closed by whoever notices.
 *
 * The only conditions are the contract's own: the phase must be Voting and the
 * deadline must have passed. Without this button the stake of every voter in such
 * a poll is unreachable — `refund()` requires `Phase.Ended`, and nothing else can
 * move the poll out of `Voting`.
 */
export function closeReason(input: BallotInputs): string | undefined {
  if (!input.contractKnown) {
    return unknownContract(input, "无法确定投票合约。");
  }

  if (input.phaseState !== "ready") {
    return statusSentence(
      input.phaseState,
      "读取合约阶段失败，无法判断能否关闭；请检查 RPC 后重试。",
      "正在读取合约状态…",
    );
  }

  if (input.phase === PollPhase.Ended) {
    return "投票已经正式关闭了。";
  }

  if (isSetup(input)) {
    return "投票还没开始，合约会以 InvalidPhase 拒绝 closeAfterDeadline()。";
  }

  if (!input.deadlinePassed) {
    return "还没到截止时间，合约会以 DeadlineNotInFuture 拒绝 closeAfterDeadline()。";
  }

  return undefined;
}
