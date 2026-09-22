# ADR-0034 - "一人一票"在可配置机制下重述为"每个合格主体的票权至多计一次"

Status: `accepted`
Date: `2026-09-22`
Amends: `CONTRIBUTING.md` 第 4 条不变量；`docs/aegis/baseline/2026-09-20-initial-baseline.md` §5.2

## Source Evidence

- `CONTRIBUTING.md:15`：「如果一项改动需要违反其中之一，那它需要先改 ADR，而不是先改代码」
- 基线 §5.2 第 4 条：「一人一票 —— 白名单地址只能成功投票一次」
- 现状依据：`Poll.sol:254` 的 `mapping(address => uint256) public votedFor`，其标量结构是"一个地址一个选项"这一语义的物理实现
- 相关：`docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md` Task 2、Task 3

## Context

第 4 条不变量是这份代码库里被守护得最严密的一条：它有 40 名选民 × 3 个选项 × 1000 轮的确定性属性测试逐轮复查，且该测试**经过负向对照**（注释掉 `changeVote` 中旧选项的递减后，它以 `the tally must equal the number of current voters: 9 != 8` 失败）。ADR-0023 甚至为了保住它而否决了"一个合约里按 `pollId` 分表"的设计，理由是那样会让"一人一票"从合约内的 `mapping` 降级为只有索引层能聚合的语义。

现在要加入的三种机制，各自都在**不同的意义上**挑战这句话的字面表述：

| 机制     | 对"一人一票"字面的挑战                                     |
| -------- | ---------------------------------------------------------- |
| 多选     | 一个地址一次投**多个**选项，"一票"不再指向单个选项         |
| 加权投票 | 不同地址的票**价值不同**，"一票"不再是等价的单位           |
| 委托投票 | 一个地址可以**行使**另一个地址的票，"谁投的"与"算谁的"分离 |

如果不在动手前把这条不变量说清楚，会出现两种坏结局：

1. **静默放宽**：实现里悄悄不再检查"这个主体是否已经计过票"，属性测试被削弱到不再能失败——正是 `baseline §7` 记录的那类"看起来还在保护什么"的失效断言。
2. **字面坚持**：为了守住原措辞而拒绝这三种机制，等于让一条为"单一机制"写的不变量永久锁死整个产品的演进。

两种都要避免，所以需要一次**显式重述**，而不是一次隐式豁免。

## Decision

第 4 条不变量重述为：

> **在给定机制配置下，每个合格主体的票权至多被计入一次。**

原措辞「白名单地址只能成功投票一次」作为**单选 + 等权 + 无委托**这一默认机制下的特例继续成立，且它仍然是默认配置下的验收标准。

### 逐机制的形式化表述

设 `eligible(subject)` 表示主体在该 poll 下具备投票资格，`counted(subject)` 表示其票权已被计入 `results()`。

**单选（默认，沿用现有语义）**

```
∀ voter : counted(voter) ≤ 1
且 counted(voter) = 1 → votedFor(voter) ≠ 0
```

即：原不变量原样保留，不改一个字符。

**多选**

一次投票提交一个**选项集合** `S`（`|S| ≥ 1`，上限由创建时固定）。不变量的对象从"选项"变为"集合"：

```
∀ voter : 该 voter 至多有一个有效的集合 S 处于计票状态
且 ∀ o ∈ S : voteCount[o] ≥ 1
```

关键：**"一票"仍是一次投票行为**。多选放宽的是"这一票包含什么"，不是"能投几次"。因此一个地址**不能**投两次单选、也**不能**重复提交集合——重复提交必须走 `changeVote` 语义（替换整个集合），而不是累加。

**加权**

每个主体有一个创建时快照固定的权重 `w(voter) ≥ 0`。不变量针对**票权总量**：

```
∀ voter : counted(voter) ≤ w(voter)
```

即：权重放宽的是"一票值多少"，不是"能投几次"。一个权重为 5 的主体，其票权最多贡献 5，且**只能被计入一次**（不得通过改投在不同选项上各计一次）。

**委托**

`delegatedTo(a) = b` 表示 a 把**行使权**交给 b，但：

```
∀ a : 若 delegatedTo(a) ≠ 0，则 counted(a) = 0
     （a 的票权由 b 代为行使，且 a 自身不得再直接投票）
∀ b : b 所行使的票权 = w(b) + Σ{ w(a) : delegatedTo(a) = b }
     且该总量至多被计入一次
```

关键：委托线性化后仍然是"每个主体至多计一次"——**只是行使者变了**。这正是不变量重述而非废弃的实质：它约束的是**主体**，而不是**调用者**。

### 三个必须由实现保证的推论

1. **不得存在"既委托又自投"的双计路径。** `delegate` 后直接 `vote` 必须 revert。
2. **不得存在"多选集合累加"的双计路径。** 重复 `vote` 必须 revert；改选必须走替换语义。
3. **计票必须仍然由合约的 `mapping` 决定，而不是由索引聚合决定。** ADR-0023 的论证在这里**完全继续有效**：无论机制怎么配置，"每个主体计一次"必须能在合约内被独立验证，否则 `results()` 就不再能作为与索引比对的基准（ADR-0001）。

## Alternatives Considered

- **保留原措辞，通过"机制配置属于不同 poll"来规避**：不成立。多选与加权发生在**同一个 poll 内**，"这个 poll 里一个地址计几次"必须回答。
- **把不变量弱化为"不重复计票"**：过于宽泛，会放过"多选集合被累加"这类真实缺陷，使属性测试失去判别力。
- **放弃属性测试，改用普通单元测试**：被否决。M-4 的证据价值正来自 1000 轮交错操作，`baseline §7` 也证明普通测试看不见这类问题。
- **干脆实现成 Governor，复用其既有投票模块**：被否决，理由见计划 §9「Higher-level simplification」——会引入第二个"谁拥有票数"的 owner。

## Consequences

**正面**

- 三种新机制各自有了可被测试判定的不变量形式，而不是"大概没问题"。
- 原不变量作为默认机制的特例**原样保留**，因此既有的 1000 轮属性测试仍然是有效的回归证据，不需要重写。
- 明确了"约束主体而非调用者"，这直接排除了实现中最容易出现的两类双计缺陷（推论 1、2）。

**代价**

- 属性测试必须从"单一机制"扩展为**机制矩阵**（40 选民 × 3 选项 × 1000 轮 × 多种机制配置），运行时间上升。
- 需要一组新的负向对照：每种机制各注入一个"双计"变异，确认测试会失败。**没有这一步，扩展后的属性测试就只是一组新的绿灯**。
- "合格主体"的定义依赖机制（白名单规模 / 权重表），因此它必须与 Task 9 的"合格选民数"共用同一来源，否则会出两份口径。

## Compatibility Boundary

- 本 ADR **不改变默认机制下任何合约行为**：单选、等权、无委托时的计票与现有实现完全一致。
- 因此 `CONTRIBUTING.md` 第 4 条对**默认配置**的约束力度不变——它只是不再声称自己是全部的表述。
- 已部署合约不受影响（它们都是单选机制）。

## Retirement Impact

- `CONTRIBUTING.md` 第 4 条的措辞需修订，并在修订处链接本 ADR（说明"为什么这句被改写了"比新措辞本身更重要）。
- 基线 §5.2 第 4 条需登记重述，方式为**追加修订说明**而非覆盖原文——原文反映了当时的真实约定，是历史证据。
- 现有 `PollProperties.t.sol` 的属性测试**不退役**，它成为机制矩阵中"单选"那一格。

## Baseline Sync

- Needed: needed
- Target: `docs/aegis/baseline/2026-09-20-initial-baseline.md` §5.2；`CONTRIBUTING.md`
- Action: amend (append revision note, do not overwrite)
- Reason: 第 4 条是五条不变量中最容易被"简化"掉的一条（`baseline/2026-09-21-optimization-pass.md` §9 已把它列为优先比对项）。重述必须留下痕迹，否则下一次基线比对会把重述误判为漂移。

## Evidence References

- `CONTRIBUTING.md`
- `docs/aegis/baseline/2026-09-20-initial-baseline.md` §5.2
- `docs/aegis/baseline/2026-09-21-optimization-pass.md` §7、§9
- `contracts/contracts/PollProperties.t.sol`
- `contracts/contracts/Poll.sol`（`votedFor`、`voteCount`）
- `docs/aegis/adr/ADR-0023-one-poll-per-contract-through-a-factory.md`
- `docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md`

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
