# ADR-0030 - 投票机制在 initialize 时固定，且组合合法性由一个纯函数 owner 判定

Status: `accepted`
Date: `2026-09-22`

## Source Evidence

- 沿用 [ADR-0025](ADR-0025-admission-mode-is-fixed-at-initialize.md) 对 `openToAll` 的论证
- 现状依据：`Poll.sol:325-365` 的 `initialize` 是唯一的创建期写入口；`Poll.sol:249` 的 `openToAll` 无 setter
- 相关：`docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md` Task 1

## Context

本计划要让一个投票在创建时选择：是否多选、是否加权、是否允许委托、是否 commit-reveal。四种机制按存在与否计共有 16 种组合。

两个问题必须回答：

1. **这些选择能不能在投票进行中修改？**
2. **16 种组合里，哪些是语义上成立的？** 这个判断由谁负责？

第 1 个问题已有先例答案。ADR-0025 为 `openToAll` 论证过：若创建者能在看到实时票数后翻转准入开关，他就能排除已经不利于他的那批人，或反过来在需要凑人数时放开门槛——票数于是不再是"一个固定规则下的人群的选择"，而是一个可被创建者按结果调节的量。**同一论证逐字适用于投票机制本身，而且更强**：把"单选"改成"加权"，不只是换人群，而是换计票的含义。

第 2 个问题的危险在于"看起来都行"。例如"委托 + 加权"意味着受委托人在行使一组权重不等的票权，这在语义上成立但需要明确权重如何归属；而"commit-reveal + 多选"需要承诺覆盖整个集合而非单个选项——成立，但承诺的编码必须不同。把它们散落在投票主路径里判断，会让每加一种机制都要改 `vote()`。

## Decision

### 一、机制在 `initialize` 时固定，无 setter

`PollConfig` 作为 `initialize` 的参数一次性写入，此后不可更改。理由与 ADR-0025 完全相同，且不因机制更多而放宽。

唯一允许事后变化的是**与计票语义无关**的管理项（例如白名单成员、揭示窗口内不涉及计票的元数据），且每一项都必须在实现中单独论证。

### 二、组合合法性由一个纯函数 owner 判定

新建 `contracts/contracts/PollMechanisms.sol`，导出：

```solidity
function validate(PollConfig calldata config) pure returns (bool ok, string memory reason)
```

`Poll.initialize` 与 `VotingFactory.createPoll` 都调用它；前端有一份同构的 `web/src/lib/mechanisms.ts`，供 UI 在提交前判定。

**为什么必须是独立的 owner 而不是塞进 `Poll`**：

- 校验是**纯函数、无状态、无权限**，与计票状态没有耦合；
- 每新增一种机制需要改的是"合法组合表"，而不是投票主路径；
- 它可以被 Solidity 测试直接穷举（16 种组合全覆盖），而 `Poll` 的测试要搭全套状态才能测一个组合；
- 前端需要同一套规则。把规则放在一个两侧同构的位置，才有可能写"两侧判定一致"的断言——这笔一致性护栏是必要的，因为两侧规则不一致会让界面亮着按钮而链上 revert（`baseline §7` 第 2 条记录的正是这类缺陷）。

### 三、明确拒绝的组合

`validate` 不是"全部放行后各自处理"。以下组合被**显式拒绝**（`ok = false` 并给出 reason）：

| 组合                       | 为何拒绝                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 加权 + 无权重表            | 权重来源缺失，计票无法定义。加权机制要求 `weights` 非空且与准入名单一致                                                                                |
| 加权 + 开放准入            | "所有人可投"下无法为未知地址预设权重，快照权重表对未列出的地址无定义。加权投票必须走白名单准入                                                         |
| 多选 + 上限小于 1          | 等价于无法投票                                                                                                                                         |
| 多选 + 上限等于 1          | 不是错误但与单选重复，属于两套语义表达同一件事——**拒绝**，避免出现两条应当等价却可能分叉的路径                                                         |
| commit-reveal + 无揭示窗口 | 没有窗口就没有揭示期，所有票都会弃权                                                                                                                   |
| 委托 + commit-reveal       | 承诺绑定 `voter`（见 ADR-0031 的防抢跑要求），而委托下"行使者"与"主体"不同，承诺的绑定对象产生歧义。**本版本拒绝该组合**，理由记录在此以备将来重新评估 |

最后一条是本 ADR 中唯一一处**因语义歧义而非实现难度**被拒绝的组合。它值得明说，因为这是"渐进式扩展"必须承认的边界：承认一个组合暂时说不清楚，好过让它以某种未定义的方式跑起来。

## Alternatives Considered

- **机制可在投票中修改**：被 ADR-0025 的论证否决（创建者按结果调节规则）。
- **不做组合校验，让各机制各自处理**：会让 16 种组合的语义散落在多处，且无法穷举测试。
- **用一个 uint256 位图表示机制，省 gas**：位图节省存储（多个 `bool` 被打包进同一 slot，Solidity 本身已做），但可读性代价更高；本项目的首要目标是"可被读懂的合约"，因此采用具名结构体字段。gas 在部署与创建路径，不在每次投票路径。
- **全部组合都支持**：见上表，其中"多选上限=1"与"加权+开放"是真实的语义空洞，不是实现困难。

## Consequences

**正面**

- 机制选择与"规则不可事后更改"这条既有纪律一致，不引入新的信任假设。
- 组合校验可被穷举测试，且能被前端复用。
- 拒绝的组合是**记录在案的**，而不是运行时的意外 revert——读者能从 ADR 而不是从一条 revert 信息里得知边界。

**代价**

- `initialize` 的参数从 5 个变为一个结构体，是一次破坏性 ABI 变更。
- 前端需要维护一份同构规则，并且这份同构必须被测试守护（否则它会静默漂移）。
- 被拒组合意味着用户在 UI 上无法选择某些看似自然的搭配（尤其"加权 + 所有人可投"），必须在界面上给出理由而不只是禁用（沿用 ADR-0027：禁用必须带理由）。

## Compatibility Boundary

- **ABI 不兼容**：`Poll.initialize` 与 `VotingFactory.createPoll` 都改为接收结构体；`PollConfig` 成为 ABI 的一部分。
- 默认配置（单选、等权、无委托、明票）在行为上等价于当前实现，是既有测试的回归基准。
- 旧部署作废，不保留兼容层（与 ADR-0023、ADR-0025 那一轮一致）。

## Retirement Impact

- `Poll.initialize` 现有的 5 位置参数签名退役。
- `VotingFactory.createPoll` 现有的 4 位置参数签名退役。
- 无外部消费者，因此不保留兼容包装。

## Baseline Sync

- Needed: needed
- Target: `docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md` §5（合约接口）
- Action: amend
- Reason: §5.3（接口）需登记 `PollConfig` 与 `PollMechanisms.validate`；§12（ADR 信号）需追加本 ADR。

## Evidence References

- `contracts/contracts/Poll.sol`（`initialize`、`openToAll`）
- `docs/aegis/adr/ADR-0025-admission-mode-is-fixed-at-initialize.md`
- `docs/aegis/adr/ADR-0027-eligibility-rules-live-in-pure-functions.md`
- `docs/aegis/baseline/2026-09-21-optimization-pass.md` §7
- `docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md`

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
