# ADR-0035 - 委托是单层的、可撤回的、且不改变票权归属

Status: `accepted`
Date: `2026-09-22`
Amends: `docs/aegis/adr/ADR-0034-one-vote-one-person-is-redefined-per-mechanism.md`（细化其"委托"一行）

## Source Evidence

- `contracts/contracts/PollMechanisms.sol`：`PollConfig.delegable`，以及 `validate()` 中「委托与 commit-reveal 互斥」的理由串
- `docs/aegis/adr/ADR-0030-voting-mechanisms-are-configurable-at-creation.md`：四种机制 16 组合的枚举，其中委托 + commit-reveal 被明确拒绝
- `contracts/contracts/Poll.sol`：`votedFor` 由标量改为集合（ADR-0034 的落地），使"一票多选项"成为可能
- 现状依据：改动前合约**没有任何**委托概念，"谁投的"与"算谁的"恒等

## Context

ADR-0034 把"一人一票"重述为"每个合格主体的票权至多被计入一次"，并把委托列为三种挑战之一：**"谁投的"与"算谁的"分离**。该 ADR 确定了"至多一次"这个**上界**，但没有回答委托本身的三个设计问题，而每一个都有会实际出错的默认答案：

1. **能不能链式委托？** 即 A 委托 B、B 委托 C，C 的票算几份？
2. **委托人自己还能不能投？** 如果能，它的票权会被计入几次？
3. **撤回投票时，被委托的票权去哪？**

第 1 个问题如果答"能"，合约就必须在一个它无法设界的图上做环检测：委托关系是用户随时可改的，环的长度没有上界，因此 `vote` 的 gas 会取决于用户看不见的委托深度。这不是"实现麻烦"，而是"调用成本不可预测"——一次投票要花多少 gas 会随着别人怎么委托而变化。

第 2 个问题如果答"能"，一个地址的票权会同时通过自己和受委托人两条路径进入计票，直接违反 ADR-0034 的"至多一次"。

第 3 个问题如果答错，就会出现一个不易察觉的**静默剥夺**：受委托人撤回自己的票时，如果被委托的票权没被还回去，那些委托人既不能自己投（它们已经是用委托人了，合约会拒），也没有人再能替它们投。票权凭空消失，而链上没有任何一笔交易报错。

## Decision

**一、委托是单层的：受委托人不得再委托。**

拒绝发生在**关系的右侧**——被指定的受委托人如果**自己**已经委托出去了，就拒绝。检查"某人是否有委托人"是错的，那会禁止多个主体指定同一个受委托人，而这恰恰是委托机制存在的意义（有负向对照测试 `test_Delegate_ManySubjectsMayNameTheSameDelegate` 钉住这一点）。

**二、委托人在投票期可以随时指定或撤回委托，但已投票者必须先撤票。**

`delegate(to)` 在 `phase == Voting` 可用，`to == address(0)` 表示撤回。已经投过票的地址不能委托（`DelegatorHasVoted`）——它的票已在计票中，此时交出权限要么导致重复计票，要么静默抹掉它。要求先 `withdrawVote` 是让这一步成为一个**有可见效果的动作**。

**三、被委托的一票是不可分割的：受委托人一次投出的集合同时代表所有委托人。**

合约不发逐个委托人列举的事件——mapping 不可遍历，而要求受委托人传入一份合约无法验证的名单等于把事实的准确性外包给调用方。相反，`Delegated` 事件记录了**谁把票给了谁**，`VoteRecorded` 的 `power` 字段记录了**这一票实际计了多少**。两者合起来就是完整账目，不需要合约维护一份没有其他用途的可枚举集合。

**四、票权归属不因委托而改变，只改变行使者。**

用 `_delegatedSurplus` 存"来自委托人的**增量**"，而不是存"该地址控制的总量"。理由是加权投票下创建者可以在 Setup 阶段重置权重：若把总量缓存在这里，一次 `setWeights` 之后这个缓存就会与 `weightOf` 矛盾，而矛盾会以"计票与 `weightOf` 对不上"的形式暴露。只存增量意味着"这个地址自己的权重是多少"永远只有一个 owner——权重表。

**五、`controlledPowerOf` 永不报 0 给一个仍然控制着票权的地址。**

投票后 `vote` **不清空** `_delegatedSurplus`，因为撤回时必须靠它把票权还回去；`controlledPowerOf` 改为优先返回已计入的 `votingPowerOf`，因此不会重复上报。语义上：投票后"这个地址控制多少票权"仍是同一个数——撤回会把这份权力原地还回来。报 0 会告诉受委托人"撤回不损失什么"，而这是假的。

## Alternatives Considered

- **允许链式委托并做环检测**：被否决。环检测需要在写入路径上遍历一个用户可随时修改、长度无上界的图，`vote` 的 gas 会随他人行为变化。代价不是性能，是**可预测性**。
- **允许委托人为自己投票，计票时去重**：被否决。计票去重需要合约记住"哪些主体已经通过别人计过票"，这正是 ADR-0034 拒绝的"把聚合搬离链上"；而且"票投出去了但没算"对投票人不可见，是 ADR-0011 禁止的谎报。
- **撤回时把票权清零（"撤回即放弃"）**：被否决。这是一个静默剥夺：委托人不报错、受委托人不报错，票权消失。ADR-0011 的同类问题在这里以最坏的形式出现——不是显示了错的状态，而是状态本身错了。
- **用 `delegateCountOf != 0` 判定链式**：这是**本次实现中真实写错并已被测试抓住**的版本。它把"有委托人的人"误判为"自己也是委托人"，导致第二个主体指定同一受委托人时被拒。修正为依据 `delegatedTo[to] != 0`。留下记录是因为这个错误恰好**通过**了朴素的链式测试，只有负向对照能发现。
- **把委托做成 ERC20 委托（如 Compound 风格）**：被否决。那需要把票权做成可转移的余额，而本项目已决定权重是创建时固定的表（ADR-0030），不是代币。

## Consequences

- `Poll.sol` 新增 `delegatedTo`、`delegateCountOf`、`_delegatedSurplus`，以及 `delegate()`、`controlledPowerOf()`、`VoteDelegated` 事件与 9 个错误类型。
- `voterState` 结构体新增 `delegatedTo` / `delegatorCount` / `controlledPower` / `delegating` 四个字段。这是**纯增**，既有字段的位置不变，因此不构成破坏性 ABI 变更。
- **"一人一票"在委托下的确切含义**：一个主体至多被计入一次，无论这次计票是由它自己完成还是由它的受委托人完成。`test_Delegate_DelegatingSubjectCannotAlsoVote` 与 `test_Delegate_RepresentsEveryoneInTheTally` 分别钉住这个上界的两侧。
- 委托与 commit-reveal 仍然互斥（ADR-0030）：commit-reveal 的承诺绑定 `voter` 以抗抢跑，而委托下"行使者"与"主体"不同，绑定对象产生歧义。本 ADR 不解除该限制。
- 前端需要 `DelegationPanel`（显示"你代表 N 人"／"你已把票委托给 X"）。已列入计划 Task 11-13 的前端批次。

## Baseline Sync

- Target: `docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md` §11（非目标）
- Action: `amend`
- Reason: §11 原有的"不做委托投票"一句已在 ADR-0030 的机制化改造中失效。本 ADR 进一步确定其实现边界，§11 应把该项写成"委托为创建时可选机制，单层、可撤回、与 commit-reveal 互斥"，而不是保留一条与代码不符的排除项。

- Target: `README.md`「设计取舍与已知局限」
- Action: `append`
- Reason: 委托引入一个新的信任问题——受委托人一次行使多人的票权，这使"少数地址决定结果"成为可能，即使每人一票的字面规则未被破坏。这是使用方必须知道的性质，应与其他中心化风险并列披露。
