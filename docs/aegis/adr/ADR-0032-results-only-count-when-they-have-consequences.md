# ADR-0032 - 投票结果只有在链上有后果时才算结果

Status: `accepted`
Date: `2026-09-22`
Amends: `docs/aegis/adr/ADR-0030-voting-mechanisms-are-configurable-at-creation.md`（把 quorum/timelock 纳入创建时配置）
Related: `docs/aegis/adr/ADR-0029-rules-commitment-makes-edits-visible.md`（分母冻结与规则承诺同源）

## Source Evidence

- `contracts/contracts/Poll.sol`：`endPoll()` 现状只改 `phase`，`results()` 返回一组数字后无人使用
- `README.md` §0：项目自述「任何人都能创建投票，因此投票本身不可信」，并指出正解是给工厂加准入（本 ADR 只处理执行侧，准入见 ADR-0033）
- 现状依据：改动前合约**没有** threshold、quorum、timelock 或任何外部调用，投票结果对链上状态零影响

## Context

当前 `endPoll` 之后，一个投票的全部后果就是 `results()` 里的几个数字。这使得这个项目是一个**民意调查工具**，而不是治理系统：任何人都可以发起投票、任何结果都可以被参与者或创建者无视，且链上不存在"通过了"这个概念。

要补上闭环，有四个问题必须给出确定答案，而每一个都有一个看起来合理、实际上错误的默认选择：

1. **quorum（最低参与门槛）的分母是什么？**
2. **分母在什么时候确定？**
3. **时间锁是在防谁？**
4. **执行失败了怎么办？**

第 1 个问题若答"已投票数"，则 quorum **必然达成**——分子分母是同一个数，这个检查等于没写，但它会通过所有测试，因为"quorum 达成"永远是预期结果。

第 2 个问题若答"读取时现算"，则创建者可以在投票中途往白名单里加人把分母做大（让 quorum 达不成），或删人把分母做小（让 quorum 达成）。**中途改变分母与中途改变结果等价**，而它看起来只是"管理白名单"。

第 3 个问题若答错，时间锁会变成纯粹的用户体验损失：一个只有创建者能执行、且随时可执行的锁，什么也没锁住。

第 4 个问题的错误答案最危险：若执行失败就回滚投票状态，则一次可被外部条件触发的失败（比如目标合约正好在那天暂停）可以让一个已经通过的投票**凭空作废**，而投票人无法预知或阻止。

## Decision

**一、quorum 的分母是"总分配票权"，在 `startPoll()` 时冻结。**

- 等权机制下，总分配票权 == 合格主体数；加权机制下，它是权重表之和。
- 用权重而非人数，是因为加权投票下"多少票权参与"才是问题的实质，且这个数字与 Task 9 的投票率**共享唯一来源**。两个功能各算一次是"同一条规则写两处"的又一例。
- 冻结发生在 `startPoll`，之后 `setWhitelist` / `setWeights` 在 `Voting` 期本就不允许调用，因此冻结值不会与实际状态矛盾。`Reveal` 期同样不允许改。

**二、quorum 用基点（bps）表示，不用浮点。**

`quorumBps` 取值 0–10000，`0` 表示不要求 quorum。判定为 `tally * 10000 >= frozenTotalPower * quorumBps`。用整数比较而非除法，避免向下取整让一个刚好达标的投票被判为未达标。

**三、时间锁保护的是"投票人"，不是创建者。**

`timelockSeconds` 从 `queueExecution` 那一刻起算。`execute()` 任何人可调。这样设计的目的：让投票人在结果公布后、执行发生前有一段**可观测的窗口**，窗口内他们可以看到"即将执行什么"，并（若创建者愿意）由创建者取消。一个只有创建者能执行的时间锁不保护任何人。

**四、执行失败标记为 `failed` 并允许重试，永不回滚投票状态。**

`execute()` 用低级 `call` 而非 `revert` 传播失败：失败记录在 `ExecutionFailed` 事件与 `executionState` 上，`phase` 与计票结果保持不变。理由：投票已经发生且不可撤销，把一次外部调用的失败解释成"投票没通过"是伪造历史。重试允许任意人调用，与 `execute` 同样的权限。

**五、执行目标必须受控，否则 `execute()` 就是后门。**

一个可以调用任意地址任意函数、且由投票结果触发的合约，等于把创建者能发起任意调用的能力交给了"投票通过"这个条件——而创建者控制着谁能投票。因此：

- 目标调用只允许 `target == address(this)`（poll 自己）或 `target` 在创建时给定的白名单中；
- 白名单在 `initialize` 固定，空表示只允许自调用；
- 自调用场景覆盖最常见也最有用的情形：通过投票执行 poll 自身的受限管理动作。

**这是一个刻意的窄口径。** 它使这个功能在"治理一个外部合约"的方向上不可用，换来的是"不存在一个由投票触发、可指向任意地址的调用器"。要放开必须先扩展白名单机制并重新评估——而不是先把口子开着。

## Alternatives Considered

- **引入 OpenZeppelin `Governor`**：用户已明确选择渐进式改造（保留 `Poll` 而非重写为 Governor）。Governor 的 `propose/targets/values/calldatas` 模型意味着一次投票只能对应一次提案，而本项目的一次投票是一个多选项问卷，两者的语义不匹配。把问卷硬塞进 Governor 需要在外面再包一层，得两个系统而不是一个。
- **quorum 分母用"已投票数"**：见 Context 第 1 点，这个检查会恒为真。
- **quorum 分母在读取时现算**：见 Context 第 2 点，等于允许中途改变判定标准。
- **执行失败即回滚**：见 Context 第 4 点，让已通过的投票可被外部条件作废。
- **允许 `target` 为任意地址**：把"投票通过"变成一个任意调用触发器。若确实需要治理外部合约，正确做法是显式实现、并为它单独设计准入，而不是让一个通用调用器默认存在。
- **时间锁由创建者独占执行**：不保护任何人，只是把执行延迟了一段无人能用的时间。

## Consequences

**正面**

- "投票通过"成为链上可查询、有后果的状态：`outcome` 是可读的三值判断，而不是读者自己对数字的解释。
- 执行前的窗口是真实的：投票人能在执行发生前看到 `queued` 的内容。
- 失败可重试，因此一个暂时性外部故障不会毁掉一次已经完成的投票。
- quorum 分母与投票率共享单一来源，两处不会各自漂移。

**代价（必须如实记录）**

- **`execute()` 的实际用途很窄**：受限于目标白名单，它主要能执行 poll 自身的管理动作。这是刻意的，但必须说清楚——一个期望"用它去调用任意合约"的使用者会失望，且这个失望应当在文档里而不是在运行时发现。
- **`Reveal` 期的 quorum 判定是不完整的**：揭示窗口未结束时，未揭示的承诺可能还会变成票。因此 `outcome` 在 `Reveal` 期返回 `Pending` 而非任何终值——一个在揭示期报 `QuorumNotMet` 的界面会催促投票人放弃，而他们还有时间揭示。
- **白名单与权重在投票开始后不可改**，因此"临时补一个人进来"需要新开一个投票。这是冻结分母的直接代价，也是它存在的理由。
- **新增三个事件与两个存储变量**，索引与 ABI 均需同步（ABI 不兼容，同 ADR-0031 的处置）。

## Compatibility Boundary

- **ABI 不兼容**：`PollConfig` 新增 `quorumBps` 与 `timelockSeconds`；新增 `queueExecution` / `execute` / `cancelExecution` 写路径与 `outcome` 读路径；新增 `PollOutcome` 枚举。
- **`PollOutcome` 是新的枚举，必须与 `Phase` 一样从 Solidity 源生成 TS 镜像**——`Phase` 的手写镜像已经因此错过一次（ADR-0031 的 Implementation Record），不能重犯。
- 既有明票、多选、加权、委托、commit-reveal 的行为**不变**；`quorumBps == 0` 且 `timelockSeconds == 0` 时执行路径为新功能而非既有行为。
- 旧部署作废，不保留兼容层。处置沿用既有流程。

## Retirement Impact

- `endPoll()` 的语义从"唯一的结果动作"降级为"关闭投票阶段"。注释与前端文案必须同步，否则会留下"结束即出结果"的暗示。
- README 中「投票结果不可执行」相关的表述（若有）必须改为"结果可执行，但目标受限"。
- 不退役任何既有机制。

## Baseline Sync

- Needed: needed
- Target: `docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md` §11（非目标）
- Action: amend
- Reason: §11 将"链上治理执行"列为非目标。本 ADR 实现其受限子集（受限目标 + 受限动作），因此需改为"不做通用治理执行器与任意目标调用；提供受限的、目标可枚举的执行闭环"，并写明"受限"具体到哪里。

## Evidence References

- `contracts/contracts/Poll.sol`（`endPoll`、`results`、`setWhitelist`、`setWeights`）
- `contracts/contracts/PollMechanisms.sol`（`PollConfig` 与校验顺序）
- `docs/aegis/adr/ADR-0029-rules-commitment-makes-edits-visible.md`
- `docs/aegis/adr/ADR-0030-voting-mechanisms-are-configurable-at-creation.md`
- `docs/aegis/adr/ADR-0031-commit-reveal-replaces-public-ballots.md`（`PollPhase` 镜像失效的教训）
- `docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md` Task 5、Task 6

## Implementation Record

### 本 ADR 的第四点曾被实现成它的反面，由测试纠正

`execute()` 的第一版在失败路径上 `revert ExecutionFailedOnChain(reason)`。这与上面第四点**直接矛盾**，而且矛盾的方式值得记录，因为它不是笔误：

写第一版时把"把失败告诉调用方"和"把失败记录下来"当成了同一件事。它们不是。`revert` 会回滚整个交易，**包括这一分支刚刚写下的 `lastError`**。于是那次 `revert` 的净效果是：调用方看到了原因，链上什么也没留下，`execution.done` 也不需要清——因为整个状态都退回去了。

抓到它的是一条本来为别的东西写的断言：`test_Execute_FailureLeavesTheVoteIntactAndTheQueueRetryable` 在失败后检查 `lastError.length > 0`，得到 `0 <= 0`。如果当时只断言"调用方收到 revert"，这个缺陷会原样通过——因为从调用方视角看，行为完全正确。

**修正后 `execute()` 在失败路径上不 `revert`，正常返回。** 代价被明确写下并写进事件注释：调用方**必须**读 `ExecutionFailed` 事件或 `execution().lastError`，不能依赖交易状态判断执行是否成功。这是这个设计的真实成本，不是可以省略的细节。

### 关于"分母冻结"与白名单可编辑的关系

实现时先写下的测试断言"投票期改白名单必须 revert"，跑出来发现 `setWhitelist` 在 `Voting` 期**本来就不 revert**（只拒绝 `Ended`）。查证后确认这是既有设计：ADR-0029 的规则哈希专门用来让创建后的白名单改动**可见**，若改动本身就该被禁止，那个哈希就没有存在意义。

因此测试改写成断言真正成立的那件事——**改动被允许，但不会移动分数线**。冻结的是分母，不是名单。中途加入的人可以投票，且 `frozenEligiblePower` 不变，所以"五成出席"这句话的含义在投票开始后就固定了。这两条断言（"改白名单被拒绝" vs "改白名单不影响分母"）看起来相近，实际只有第二条为真。

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
