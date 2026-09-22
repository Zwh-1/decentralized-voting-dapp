# ADR-0027 - 决定「能不能点」的规则住在纯函数里，组件只负责组装输入

- 状态：已接受
- 日期：2026-09-21
- 相关：ADR-0009、ADR-0012、ADR-0026

## 背景

`PollBallot.tsx` 有七个可能被禁用的控件：每个选项上的「投票」或「改投」、整体「撤票」、「取回押金」，以及新增的「关闭投票」与发起人面板中的六个。每个被禁用的控件都要给出一句中文理由（ADR-0012），而这些理由的判断条件彼此重叠——「投票」和「改投」共享大部分前置条件，「撤票」和「取回押金」共享相位判断。

这些判断原先写成 `PollBallot.tsx` 内部的闭包：`sharedBlock()`、`voteReason()`、`changeReason()`、`withdrawReason()`、`refundReason()`、`closeReason()`。它们能正确工作，但**只能被无头浏览器验证**。而 `ui-drill` 一次运行要启动 Chrome、连接 CDP、等待页面稳定，代价是数十秒——于是没人会为「某个分支的措辞」去跑它，这些分支实际上处于未验证状态。

具体代价在这次审计中显现为两个真实缺陷：

1. `changeReason` 通过**比较 `voteReason()` 返回的字符串与一个字面量**来判断「是否已投票」：

   ```ts
   const reason = sharedBlock();
   if (reason !== undefined) return reason;
   if (reason === "你已经投过票了……") return undefined; // 依赖措辞
   ```

   这句话一旦被改写，`改投` 就会开始把「你已经投过票了」当成自己不可用的理由——**而所有测试仍然通过**，因为没有任何测试读这句话。

2. 这些闭包捕获了组件作用域里的十几个值（`canVote`、`whitelisted`、`phase`、`deadlinePassed`…）。要测试其中任何一个分支，都必须先构造出一个能渲染的 React 树与 wagmi provider。

## 决策

**一、判断规则抽到 `web/src/lib/ballot-reasons.ts`，作为纯函数导出。**

```ts
export interface BallotInputs {
  /* 组件读到的全部原始事实 */
}

export function sharedBlock(input: BallotInputs): string | undefined;
export function voteReason(input: BallotInputs): string | undefined;
export function changeReason(input: BallotInputs, optionId: number): string | undefined;
export function withdrawReason(input: BallotInputs): string | undefined;
export function refundReason(input: BallotInputs): string | undefined;
export function closeReason(input: BallotInputs): string | undefined;
```

组件侧只剩一件事：把读到的值组装成一个 `BallotInputs` 对象。

**二、不用「返回一句话再比较这句话」来传递状态。**

`voteReason` 与 `changeReason` 的差异被提取为一个真正被共享的内部函数 `checkUntilAdmission`，它返回句子或 `undefined`，而不是让调用方去匹配字符串。要求「是否已投票」时，直接读 `input.marked`。

**三、分支顺序即规格。**

每个函数内部的 `if` 顺序严格照抄合约 `vote` / `changeVote` / `withdrawVote` 的检查顺序。理由：读者看到的句子应当与「他若真的发出这笔交易会收到的 revert」一致。一个既已结束、又未准入的投票，报「已结束」是对的，报「未准入」是把读者引向一个无关的方向。

## 理由

**为什么必须是纯函数，而不是「抽成自定义 hook」。**

本仓库的测试基础设施是 `node --test --import tsx`，它**无法导入任何拉进 React 或 wagmi 的模块**（`ERR_MODULE_NOT_FOUND`）。自定义 hook 仍然要 import `wagmi`，因此仍然测不了。纯函数是唯一能被这套基础设施覆盖的形态。

这是本次决策中最关键的一点：它不是「纯函数更好」这种一般性偏好，而是**在这套具体工具链下，纯函数是唯一可测的形态**。同样的约束此前已经决定了 `admin-labels.ts` 的存在（ADR-0026）。

**为什么 `changeReason` 需要单独考虑准入检查——一个真实的规则差异。**

把规则抽出来后，第一个测试就抓到了一个规格问题：`changeReason` 复用了 `sharedBlock`，因此会因 `!canVote` 而拒绝。但合约里 **`changeVote` 根本没有白名单检查**：

```solidity
function changeVote(uint256 optionId) external nonReentrant {
    if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
    if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);
    uint256 previous = votedFor[msg.sender];
    if (previous == 0) revert HasNotVoted(msg.sender);
    ...
}
```

也就是说，一个**投过票之后被移出白名单**的地址，仍然可以改投。前端若按 `canVote` 禁用「改投」，就会拒绝一笔链上会接受的交易。

修正后的规则是条件式的，且理由写在了代码里：

```ts
// 已持有票的地址跳过准入检查——合约不查，界面也不能查；
// 未持有票的地址本就会因 HasNotVoted 失败，此时报准入才是对的。
const blocked = checkUntilAdmission(input) ?? (input.marked ? undefined : admissionBlock(input));
```

这个差异**无法通过阅读代码发现**，只能通过「把规则写成可枚举的输入、然后遍历它」发现。

**为什么值得写一个遍历状态空间的扫描测试。**

因为「某个组合下理由为空」是这类代码最难手查的缺陷：一个被禁用却不解释自己的按钮，在人工点检时很容易被当成「正常地不能点」而划过去。而一旦规则是纯函数，遍历所有组合只要几毫秒：

```ts
for (const phase of phases)
  for (const phaseState of statuses)
    ...
      assert.notEqual(reason, "", "a reason is never empty when present");
```

本仓库的 `ballot-reasons.test.ts` 用这个扫描覆盖了约 4000 种组合，并断言扫描确实执行了足够多次（`checked > 1000`），以防循环条件被改坏后测试静默退化成一个空断言。

## 代价

- **多一层间接**:组件里不再能直接看到判断逻辑，读代码需要跳转到 `ballot-reasons.ts`。这是刻意的交换：判断逻辑的读者现在可以**运行**它，而不只是阅读它。
- **`BallotInputs` 必须随组件读取的内容同步更新**：新增一个判断条件时，要同时在接口、组件的组装处、以及测试的默认值里各加一处。类型检查会强制前两处，第三处由 `inputs()` 工厂函数的默认值承担。
- **`data.ts` 的同类重构被有意放弃**：原计划把索引器的驱动部分拆成 `lib/indexer/runner.ts`。实际拆分会与 `data.ts` 形成循环——`syncOnce` 与 `startSyncLoop` 需要同一个懒构建的单例（连接池、链客户端、校验过的配置），而该单例缓存在 `globalThis` 上以防 Next.js 热重载泄漏连接池。因此保留了同文件，改为用显式的小节标题划出边界，并在注释中说明「读路径从不调用写路径，写路径从不决定答案来自哪里」。**拆文件不是目的，边界可见才是。**

## 验证

- `web/test/ballot-reasons.test.ts`：36 个用例。覆盖两种准入模式下每个函数的关键分支、上述 `changeVote` 无白名单检查的差异、`myStake === undefined` 不得当作 `0`（否则会把「读不到押金」说成「你没有押金」）、以及遍历约 4000 种组合的非空理由扫描。测试中 `PollPhase` 的数值**内联而非导入**：枚举编号若改变，这些用例应当失败，而不是被静默地指向另一个相位。
- `web/src/components/PollBallot.tsx`：不再包含任何判断闭包，只剩 `const reasons: BallotInputs = {...}` 与六处调用。
- `web/scripts/ui-drill.ts`：在真实浏览器中断言被禁用控件的理由文本（`a disabled refund button states why`、`a disabled account is told why`），与单元测试形成互补——前者证明组件确实把理由渲染到了页面上，后者证明理由本身是对的。
