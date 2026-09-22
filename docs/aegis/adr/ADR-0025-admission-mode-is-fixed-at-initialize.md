# ADR-0025 - 准入方式在 initialize 时固定，且 `canVote` 与 `whitelisted` 必须是两个事实

- 状态：已接受
- 日期：2026-09-21
- 相关：ADR-0001、ADR-0009、ADR-0012、ADR-0023

## 背景

ADR-0023 之后每次投票都是独立合约，白名单由发起人用 `setWhitelist` 维护。这带来一个没人预料到的后果：**通过本应用创建的投票永远无法投票。**

原因不是合约有问题，而是应用只导出了写函数、从未调用它们。`setWhitelist`、`startPoll`、`endPoll` 等都在 ABI 里，但 `web/src` 里没有任何调用点。`Poll` 初始处于 `Phase.Setup`，而 `vote` 的第一道检查就是 `phase != Phase.Voting` 时 revert——所以每个在界面上创建的投票都永久停在 Setup，一个票都投不出去。同样地，过了截止时间但仍在 `Voting` 的投票无法被任何人关闭（`endPoll` 也没人调），而 `refund()` 要求 `Phase.Ended`，于是每个投票人的押金都被永久锁死。

这是「功能缺口」而非「逻辑错误」，因此单元测试完全看不到：合约的每个函数都正确，只是没有任何人调用其中一个子集。

在补齐这些调用点时，产生了一个必须先决定的问题：**投票是否一定要先建白名单？**

原设计隐含假设「是」——`vote` 只检查 `!isWhitelisted[msg.sender]`。但这个假设在真实使用中很糟：一个公开征求意见的投票，发起人必须先知道所有参与者的地址。这在演示与多数实际场景里都不成立。

## 决策

**一、`Poll` 增加 `openToAll`，在 `initialize` 时固定，且不提供 setter。**

```solidity
bool public openToAll;   // 仅在 initialize 写入

function vote(uint256 optionId) external payable nonReentrant {
    if (phase != Phase.Voting) revert InvalidPhase(Phase.Voting, phase);
    if (block.timestamp >= endsAt && votingEndedAt == 0) revert PollAlreadyEnded(endsAt);
    if (!openToAll && !isWhitelisted[msg.sender]) revert NotWhitelisted(msg.sender);
    ...
}
```

`!openToAll &&` 短路在前，开放投票比白名单投票每次投票少一次 SLOAD。

**二、`voterState` 扩展为五元组，`canVote` 与 `whitelisted` 并列返回。**

```solidity
function voterState(address voter)
    external view
    returns (bool whitelisted, uint256 currentOptionId, uint256 stake, bool marked, bool canVote);
```

其中 `canVote = openToAll || whitelisted`。

**三、前端「我的状态」面板按准入方式显示不同的一行，二者互斥。**

- 开放投票 → 「准入方式：所有人可投」，**不显示**「白名单」行；
- 白名单投票 → 「白名单：是/否」，**不显示**「准入方式」行。

并且「白名单」行对该投票的**每个**地址都显示其真实成员关系，无论其是否被准入。

## 理由

**`openToAll` 为什么不能在创建后修改。**

如果发起人能在投票进行中翻转这个开关，他就能在看到实时票数之后决定「现在只让白名单投票」，把已经不利于他的那批人排除掉——或者反过来，在需要凑人数时才放开门槛。无论哪种，票数都不再是「一个固定规则下的人群的选择」，而是一个可以被发起人按结果调节的量。把准入方式钉死在 `initialize`，使它成为投票身份的一部分（与问题、选项、截止时间同等），与 ADR-0023「投票地址即身份」是同一个立场。

这也让链上状态是自洽的：任何时候读 `openToAll` 都得到同一个值，索引器与前端都不需要处理「准入方式变了」这个事件——因为不存在。

**`canVote` 与 `whitelisted` 为什么必须是两个字段。**

它们回答两个不同的问题，且在两种投票上恰好会给出相反的误导：

- **开放投票上**，`whitelisted` 对**每个人**都是 `false`（没人被加进过一个不存在的名单）。若界面用 `whitelisted` 判断能否投票，会告诉每一个读者「你不在白名单里」——而此刻他明明可以投。这正是本次改动引入、并被 `ui-drill` 当场抓到的假失败。
- **白名单投票上**，被准入的读者 `canVote` 为 `true`，若只显示 `canVote`，他无法区分「这个投票对所有人开放」与「我被单独批准了」。这两种情况对读者的含义完全不同：后者意味着名单可能会变，他的资格是可以被撤销的。

因此两个字段都必须暴露，且界面必须**按投票类型选择显示哪一个**，而不是把二者折叠成一个布尔量。折叠会必然在某一类投票上说错话。

**「白名单」行为什么对被准入者也要显示。**

一个曾经投票、随后被移出名单的地址，`canVote` 变成 `false`。他需要看到「白名单：否」才能理解为什么「投票」按钮突然不能用了。如果这一行只在 `!canVote` 时显示，那么他第一次看到的正好是这个「否」——信息是对的，但读者失去了「我原本在名单上」这个上下文。始终显示成员关系，使状态变化可读。

## 代价

- **需要重新部署**：`initialize` 的签名与 `PollCreated` 事件的字段都变了，已部署的工厂与投票合约与新 ABI 不兼容。本地开发需 `pnpm deploy:local && pnpm seed:local && pnpm export-abi`；Sepolia 上的旧部署视为作废。
- **`setWhitelist` 在开放投票上成为「无害但存在」的函数**：调用它不会 revert，也不影响任何人的投票资格（`vote` 短路后根本不读 `isWhitelisted`）。保留而非禁止，是因为禁止需要额外的相位判断与一个新的 revert 原因，而收益仅是「阻止一个无效果的调用」。已在 `Poll.sol` 的注释中显式说明这一点，避免后来者误以为它有效。
- **`voterState` 的返回变宽**：所有读取方（`web/src/lib/chain.ts`、drill、测试）都必须同步更新为五元组。本仓库中已全部更新，且 `drill` 改为直接断言 `voterState[4]`，不再自行推导准入规则——这样即使规则再次变化，断言仍然对着合约的权威答案。

## 验证

- `contracts/contracts/Poll.t.sol`：`test_OpenPoll_*` 系列断言开放投票接受任意地址、`canVote` 为 `true` 且 `whitelisted` 为 `false`；`test_OpenToAll_IsRecordedAndNotSettable` 断言该值只能在 `initialize` 设定；`test_WhitelistPoll_StillRejectsAnUnlistedAddress` 确认白名单投票的行为未被放宽。
- `contracts/contracts/VotingFactory.t.sol`：`test_CreatePoll_CarriesTheAdmissionModeToThePoll` 与 `test_CreatePoll_EmitsTheAdmissionMode` 断言工厂把该标志透传给投票合约，并出现在事件里。
- `web/test/ballot-reasons.test.ts`：`never refuses an open poll's voter for being off the list` 直接锁定「开放投票不得因 `whitelisted` 为假而拒绝投票人」这一条——即上面那个假失败的回归测试。
- `web/scripts/ui-drill.ts`：断言在开放投票上「准入方式」行存在且「白名单」行**不存在**，在白名单投票上反之，且「白名单」行的值等于链上 `isWhitelisted`。此断言在两种投票上各跑一次，并在「已准入」「未准入」两种账户上分别验证。
- `contracts/scripts/seed-local.ts`：本地种子现在造两个投票，一个开放、一个白名单，使两条准入路径在一条全新链上都可被触达。
