# 本轮优化改动基线记录

日期：`2026-09-21`
状态：`implementation drift recorded and resolved; three new ADRs accepted`
前一份：`baseline/2026-09-20-initial-baseline.md`

## 1. 用途

记录本轮「功能补齐 + 代码改进」审计中发现的基线偏离、已接受的决策、以及验证证据。本文件是**证据**而非权威（见 `BASELINE-GOVERNANCE.md` §7）；权威是 `adr/` 下的已接受 ADR 与 `specs/` 下的设计规格。

## 2. 本轮的核心发现：Implementation Drift（scope: both）

**现象。** `Poll` 与 `VotingFactory` 导出了 9 个写函数，其中 7 个在 `web/src` 中**调用点为零**：`setWhitelist`、`addOption`、`updateOption`、`removeOption`、`startPoll`、`endPoll`、`closeAfterDeadline`、`sweepUnclaimed`。

**后果（两条，均为「照常操作即触发」）。**

1. `Poll` 初始为 `Phase.Setup`，`vote` 在非 `Voting` 相位 revert。没有 `startPoll` 调用点 ⇒ 通过本应用创建的**每个投票都永久无法投票**。
2. 过截止时间但仍在 `Voting` 的投票，`vote` 与 `withdrawVote` 都被 `PollAlreadyEnded` 拒绝，而 `refund()` 要求 `Phase.Ended`。没有 `closeAfterDeadline` 调用点 ⇒ **每个投票人的押金被永久锁死**。

**归类。** 这是 `Implementation Drift`，不是 `Design Defect`：合约的设计与实现都是对的（`startPoll` 确实能把相位推到 `Voting`，`closeAfterDeadline` 确实能解锁押金），偏离在于应用层没有使用它们。规格也从未声称「界面会自动开始投票」——是应用停留在「只导出、不调用」的中间状态。

**修复。** 补齐全部调用点（`PollAdmin.tsx` 与 `PollBallot.tsx`），并新增 ADR-0026 把「导出即需有调用点或理由」固化为规则。详见 ADR-0026。

**为什么此前未被发现。** 类型检查、lint、单元测试、构建**没有一项**能连接「ABI 是一个数据对象」与「函数是否被调用」这两个事实。合约测试验证的是函数正确性，而此时缺陷在于函数未被调用。这类缺口在结构上对单元测试不可见。

## 3. 本轮接受的决策

| ADR                                                                         | 决策                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [ADR-0025](adr/ADR-0025-admission-mode-is-fixed-at-initialize.md)           | 准入方式（`openToAll`）在 `initialize` 时固定且无 setter；`voterState` 并列返回 `whitelisted` 与 `canVote` |
| [ADR-0026](adr/ADR-0026-every-exported-write-needs-a-caller-or-a-reason.md) | 每个已导出的写函数都必须有调用点，或一条刻意不调用的理由；无需许可的恢复函数不得放进权限门后               |
| [ADR-0027](adr/ADR-0027-eligibility-rules-live-in-pure-functions.md)        | 决定「能不能点」的规则住在纯函数里，组件只组装输入；分支顺序即规格                                         |

## 4. 契约变更（需重新部署）

| 面                          | 变更                                                         | 兼容性                         |
| --------------------------- | ------------------------------------------------------------ | ------------------------------ |
| `Poll.initialize`           | 增加第 6 个参数 `bool openToAll_`                            | **不兼容**：旧部署作废         |
| `Poll.openToAll`            | 新增 public 状态变量，仅 `initialize` 可写                   | 新增                           |
| `Poll.vote`                 | 准入检查改为 `if (!openToAll && !isWhitelisted[msg.sender])` | 行为扩展：开放投票接受任意地址 |
| `Poll.voterState`           | 返回值由 4 元组扩展为 5 元组，新增 `canVote`                 | **不兼容**：所有读取方已同步   |
| `VotingFactory.createPoll`  | 增加第 4 个参数 `bool openToAll`                             | **不兼容**                     |
| `VotingFactory.PollCreated` | 事件增加第 6 个字段 `bool openToAll`                         | **不兼容**：索引需重建         |

**处置。** 本地开发执行 `pnpm deploy:local && pnpm seed:local && pnpm export-abi`。Sepolia 上的既有部署视为作废，本轮未重新部署公共网络。

## 5. 非契约变更

| 面                                                     | 变更                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 新增 `web/src/components/PollAdmin.tsx`                | 发起人面板：`setWhitelist`（批量）/ 选项增删改 / `startPoll` / `endPoll` / `sweepUnclaimed` |
| 新增 `web/src/lib/admin-labels.ts`                     | `parseAddressList` 纯函数（任一地址非法即整体返回 `null`）                                  |
| 新增 `web/src/lib/ballot-reasons.ts`                   | 六个禁用理由的纯函数 + `BallotInputs`                                                       |
| 新增 `web/src/app/api/voters/[address]/polls/route.ts` | 「我参与过的投票」索引查询，无索引时返回 `404 index_unavailable`                            |
| 新增 `web/scripts/lib/cdp.ts`                          | 从 `ui-drill.ts` 抽出的 CDP 传输层（`ui-drill.ts` 1263 → ~1100 行）                         |
| 新增 `web/test/ballot-reasons.test.ts`                 | 36 个用例，含约 4000 组合的状态扫描                                                         |
| 修改 `web/src/lib/data.ts`                             | 新增 `getVotedPolls`；索引器驱动部分保留同文件并加显式分节说明                              |
| 修改 `web/src/components/MyVotes.tsx`                  | 优先用索引，无索引时回退到链上扫描                                                          |

**`data.ts` 拆分为何被放弃。** 原计划抽出 `lib/indexer/runner.ts`。实际拆分会与 `data.ts` 形成循环：`syncOnce` 与 `startSyncLoop` 需要同一个懒构建的 `globalThis` 单例（连接池 / 链客户端 / 校验过的配置）。改为保留同文件并划出可见边界。**拆文件不是目的，边界可见才是。**

## 6. 验证证据

全部命令在本轮末尾执行，均为**通过**：

| 命令                                   | 结果                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm --filter @voting/contracts test` | **157 passing**（94 solidity + 63 nodejs），本轮前为 145                 |
| `pnpm --filter @voting/web test`       | **260 passing**，本轮前为 210                                            |
| `pnpm typecheck`                       | 通过，无输出                                                             |
| `pnpm format:check`                    | `All matched files use Prettier code style!`                             |
| `pnpm build:web`                       | 成功，`/api/voters/[address]/polls` 已注册                               |
| `pnpm indexer:check-consistency`       | `status: consistent`，`divergentPolls: 0`（链上 200 = 索引 200）         |
| `pnpm indexer:reorg-drill`             | 通过：真实回滚被检出，孤儿事件被丢弃，票数存活                           |
| `pnpm indexer:refund-drill`            | 通过：真实退款以精确 wei 落入 `DECIMAL(38,0)`，票数未受扰动              |
| `pnpm ui:drill`（开放投票）            | 全部通过：`openToAll=true`，显示「准入方式：所有人可投」，无「白名单」行 |
| `pnpm ui:drill`（白名单投票 / 已准入） | 全部通过：显示「白名单：是」，无「准入方式」行                           |
| `pnpm ui:drill`（白名单投票 / 未准入） | 全部通过：显示「白名单：否」                                             |
| `pnpm ui:drill --vote`                 | 全部通过：真实签名交易确认，票被标记，押金 0.001 ETH                     |
| `pnpm ui:drill --change`               | 全部通过：改投到新选项，押金未被二次扣除                                 |
| `pnpm ui:drill --reject`               | 全部通过：`4001` 渲染为中文句子，链上无变化                              |

## 7. 本轮中被测试抓住的真实缺陷

以下四条都不是「测试通过后补的说明」，而是**由新写的测试或 drill 当场发现并修复**的，记录在此以证明这些验证确实有效：

1. **开放投票上误报「不在白名单」。** 界面用 `whitelisted` 而非 `canVote` 判断能否投票，导致开放投票（`whitelisted` 对所有地址为 `false`）向每个读者宣称「你不在白名单里」。由 `ui-drill` 在开放投票上运行时报出。已加回归测试 `never refuses an open poll's voter for being off the list`。
2. **`changeVote` 被错误地施加白名单检查。** 合约的 `changeVote` **没有**准入检查，被移出白名单的投票人仍可改投；前端按 `canVote` 禁用按钮会拒绝一笔链上会接受的交易。由 `ballot-reasons.test.ts` 的首个用例发现。
3. **「白名单」行对已准入者不显示。** 该行原先只在 `!canVote` 时渲染，导致被准入的读者看不到自己「是」，也无法区分「对所有人开放」与「我被单独批准」。由 `ui-drill` 在已准入账户上运行时报出。
4. **`refund-drill` 的票数对比口径不一致。** 该 drill 用 `SUM(vote_count)`（**所有投票**）与 `readOnChainTally`（**单个投票**）比较，种子造出第二个投票后必然失败（205 vs 200），并把责任错误地指向索引器。已改为按本次投票过滤。

另有一条**非缺陷**的排查：`refund-drill` 报出 `chain 200, index 205` 时，一度怀疑索引器漏算。实际是上述口径问题——索引数据本身正确（67+67+66 = 200）。

## 8. 已知未处理项

以下是本轮**有意**未处理的项目，记录以免被误认为遗漏：

1. **`sweepUnclaimed` 的资金假设。** 它断言 `totalStaked == 0` 后转账全部余额。该不变量在正常路径下成立，但若未来引入任何不进 `totalStaked` 的资金流入（例如直接 `selfdestruct` 转入），转账全额会失效。本轮仅在代码注释中标注了这一依赖，未收紧实现。
2. **`Poll.Option.labelCID` 的重命名。** 该字段是内容标识符而非标签，名字有误。改名会波及 ABI 与索引表，价值低于代价。
3. **`/api/health` 未在界面中呈现。** 该端点完整可用（`lagBlocks`、`indexError` 等），但前端没有展示入口。
4. **`web/.env.sepolia.bak` / `.env.tmpbak`** 等残留文件未清理。
5. **公共网络（Sepolia）未重新部署。** 如 §4 所述，新 ABI 需要重新部署，本轮只在本地链验证。

## 9. 后续建立基线时的比对建议

下次建立快照时，建议优先比对：

- ADR-0025 的「`canVote` 与 `whitelisted` 不得折叠」是否仍被界面遵守（这是最容易被「简化」掉的一条）；
- ADR-0026 的写函数清单是否仍与 `web/src` 的实际调用点一致（新增写函数时最容易复发）；
- ADR-0027 的 `ballot-reasons.ts` 是否仍为纯函数、且未被重新塞回组件（一旦塞回，上述 36 个用例将整体失效）。
