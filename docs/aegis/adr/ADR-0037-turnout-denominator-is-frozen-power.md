# ADR-0037 - 投票率的分母是创建时冻结的票权，不是当前的地址数

Status: `accepted`
Date: `2026-09-22`
Extends: `docs/aegis/adr/ADR-0027-eligibility-rules-live-in-pure-functions.md`

## Source Evidence

- `contracts/contracts/Poll.sol`：`frozenEligiblePower()`（分母）与新增的 `whitelistedCount()`（活地址数）
- `contracts/contracts/PollEligibility.t.sol`：11 个测试，其中 `test_TurnoutUsesTheFrozenDenominatorRatherThanTheLiveCount`
- `web/src/lib/poll-report.ts`：`turnout()` 的文档改写
- `web/src/lib/chain.ts`：`readOnChainEligibility()` 一次读回两个量
- `web/src/app/api/polls/[address]/export/route.ts`：导出同时给出 `eligibleVoters` 与 `eligiblePower`
- 现状依据：计划 Task 9 第 1 步原文要求用 `whitelistedCount` **替换**硬编码的 `eligible = null`

## Context

Task 9 要求补上"投票率（合格选民数）"。落地时发现这里有两个不同的量，而计划里只写了一个名字：

| 量                      | 含义                           | 会不会变                 |
| ----------------------- | ------------------------------ | ------------------------ |
| `whitelistedCount()`    | 当前白名单里的**地址个数**     | 会，投票期创建者仍可增删 |
| `frozenEligiblePower()` | 进入投票期那一刻的**票权总和** | 不会，冻结               |

如果按计划字面实现——用 `whitelistedCount` 当分母——会出两个错，且第二个是实质性的：

1. **分母会漂移**。投票期白名单可以增删（ADR-0027 的准入规则允许），于是同一次投票在两次访问之间投票率会变，而票数没变。"投票率 40% → 45%"却没有任何新票，这是 ADR-0011 禁止的状态谎报。
2. **加权投票下投票率会超过 100%**。`whitelistedCount` 数的是**人**，分子 `totalVotes` 累加的是**票权**。一个白名单里有 2 个地址、权重各 100 的投票，两人都投满后分子是 200、分母是 2，投票率 10000%。这不是显示 bug，是把两个不同量纲的数相除了。

反过来，只用 `frozenEligiblePower` 也不够：它在**非加权**投票上等于地址数，看不出"白名单里现在有几个人"，而创建者在 Setup 阶段需要这个信息。

## Decision

**一、投票率、quorum 判定、导出的分母一律用 `frozenEligiblePower()`。**

它是唯一在投票期不变的量，因此是唯一能让"投票率"这个词有意义的分母。这条不区分是否加权：非加权投票上 `setWeights` 未调用，`frozenEligiblePower == whitelistedCount`，所以统一用它不会牺牲任何东西。

**二、`whitelistedCount()` 作为**活**地址数单独暴露，且明确标注它不能当分母。**

它的用途是 Setup 阶段的"我已经加了 12 个人"和审计视图的交叉核对。合约里它的文档与 `frozenEligiblePower` 并列书写，写明两者区别以及为什么投票率必须用后者——因为这两个量在非加权投票上**数值恰好相等**，所以任何把分母写错的地方在测试里都不会失败，只会在生产环境的加权投票上爆掉。文档是这里唯一的防线。

**三、API 与导出同时给出两个量，且用两个不同的名字。**

- `eligibleVoters` = `whitelistedCount()`（地址数）
- `eligiblePower` = `frozenEligiblePower()`（票权，投票率的分母）

`eligiblePower` 为 0 时返回 `null` 而不是 0。因为"分母是 0"和"这个部署读不到分母"在下游是两种处理：前者投票率未定义，后者应该显示"—"。用 0 会把两者混成一个。

**四、`turnout()` 的文档改写为明确说明 `eligible` 是票权而不是人数。**

原文档写的"合格选民数"是错的措辞，会引导下一个维护者把 `whitelistedCount` 传进来。参数名保留 `eligible` 是因为它在 4 处被调用，但这个参数的**含义**被写死在文档里。

## Alternatives Considered

- **按计划字面用 `whitelistedCount` 当分母**：即 Task 9 的原文。被否决，理由见 Context 第 2 点——加权投票下投票率超过 100%，且这是**静默**的，非加权投票的测试全绿。
- **两个量都算出来，取较大的当分母**：被否决。"取较大"让投票率永远不会超过 100%，代价是它变成了一个既不是人数也不是票权的第三个数，且随白名单变动而变。用一个看起来正确的数掩盖一个错误的定义，比报错更坏。
- **投票期冻结白名单，让 `whitelistedCount` 也不再变**：被否决。这会把一个统计口径问题升级成准入规则的变更（ADR-0033 明确准入是创建者的开关），且会取消"投票期追加白名单"这个已有用途。
- **不暴露 `whitelistedCount`，`eligibleVoters` 一律返回 `null`**：被否决。Setup 阶段确实需要它，且它是审计时"合约说 12 人、索引说 11 人"这类核对里的必要一方。
- **只暴露 `frozenEligiblePower`，把地址数在链下数**：被否决。链下数需要遍历白名单，而白名单在合约里是 mapping（不可遍历），链下无从数起。

## Consequences

- `Poll.sol` 新增 `whitelistedCount() external view returns (uint256)`，实现为遍历 `_whitelistKeys` 并计数 `isWhitelisted`。这是**纯增**，不改变任何既有函数的语义。
- `whitelistedCount()` 会随白名单大小线性消耗 gas 读取。它只被读取路径使用（Setup 页面、导出、审计），不进入任何写入路径。
- `getEligibility()` 实现为**一次**读回两个量（`readOnChainEligibility`），而不是两个函数两次调用——两次调用之间白名单可能被改动，于是 `eligibleVoters` 与 `eligiblePower` 会来自两个不同的瞬间。ADR-0017 的"比较同一瞬间"在这里以读的形式出现。
- 导出 JSON 的 `totals` 从 `{ votes, eligible }` 变为 `{ votes, eligibleVoters, eligiblePower, turnoutPercent }`。这是**破坏性**字段变更；`eligible` 被移除以避免留下一个含义模糊的旧名字，且该导出目前没有被任何自动化消费者（只在浏览器里下载）。
- 计划 Task 9 的第 1 步据此更正：`whitelistedCount` 是**新增**而非**替换**，`frozenEligiblePower`（批次 2 引入）才是分母。

## Baseline Sync

- Target: `docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md` Task 9
- Action: `amend`
- Reason: 原文的"用 `whitelistedCount` 替换硬编码 `eligible = null`"在加权投票下会算出超过 100% 的投票率。需改为"`whitelistedCount` 作为活地址数新增，投票率分母用 `frozenEligiblePower`"。

- Target: `docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md` §6（数据与接口）
- Action: `amend`
- Reason: §6 的统计口径一节只提了"投票率"。需写明两个分母各自的含义，以及为什么只有一个是可用的。
