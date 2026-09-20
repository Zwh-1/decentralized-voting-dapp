# ADR-0015 - `lagBlocks` 只在滞后量成立时给出数字

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测（未设 `DATABASE_URL`，链正常、`CONFIRMATIONS=5`）：`/api/health` 返回 `indexConfigured: false`、`lastIndexedBlock: null`、`chainHead: "406"`、**`lagBlocks: "402"`**。页面在 `索引高度 未启用` 旁边显示 **`落后区块 402`**。
- 实测（`DATABASE_URL=mysql://root:123456@127.0.0.1:3399/voting`，链正常）：`/api/health` 返回 `indexConfigured: true`、`lastIndexedBlock: null`、**`lagBlocks: "402"`**、`indexError: "connect ECONNREFUSED 127.0.0.1:3399"`、`status: "degraded"`。页面显示 `索引高度 — / 链头 406` 与 **`落后区块 402`**。
- 代码事实：`plan.ts:100` 的 `lagBlocks()` 把 `lastIndexedBlock === null` 当作 `-1n`，因此返回 `safeHead + 1`。`data.ts` 只在 `chainHead === null` 时改报 `null`。
- 代码事实：`lagBlocks` 的唯一消费者是 `data.ts` 的 `getHealth()`（`data.ts:294`）与页面的 `落后区块` 一行（`Ballot.tsx:332`）。`/api/results` 的一致性判定用的是 `check.unindexedBlocks`，**不读这个字段**。
- 边界：`lastIndexedBlock` 为 `null` 有两种互不相同的含义——"索引已建表但从未同步"（此时"从创世起全部未索引"是真实答案，滞后量应当照报）与"没有索引 / 游标读不出来"（此时滞后量不成立）。旧代码把两者都算成同一个数。

## Context

ADR-0011（索引缺失时回退到链）与 ADR-0014（失败不得渲染成具体值）都指向同一条规则：**不得为不存在的对象公布一个量**。本轮把"无索引"这一受支持配置真正渲染出来时，发现 `/api/health` 与页面在这一条上仍有漏项。

值得单独记录，是因为这里错得比前几次更隐蔽：报出的 `402` **不是随手编的数字**，它是 `safeHead + 1`，一个对"什么都没索引"而言正确的答案。缺陷不在算术，而在**问题与被问的对象不匹配**——读到的是一句关于索引的话，而当时根本没有索引。

两个后果：

| 情形                | 旧行为                                   | 为什么是错的                                                             |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| 未设 `DATABASE_URL` | `落后区块 402` 与 `索引高度 未启用` 并列 | "未启用"与"落后 402 块"同时成立是自相矛盾的；读者会以为有个索引在落后    |
| 数据库宕机          | `落后区块 402`                           | 游标**读取失败**，滞后量根本未知；而这是 ADR-0014 已经禁止过的那一类断言 |

第二条还带有误导性：数字看起来具体且合理（小于任何告警阈值），所以一次数据库宕机在页面上表现得像"索引稍慢"，而不是"读不出来"。在真实链上这个数字会变成数百万块——恰好是 `lagging` 一类告警会捕到、而本地 406 块的链永远捕不到的量级。

同时必须避免把这个问题修过头：**"索引已建表但从未同步"是一个真实的、值得显示的状态**，新部署的第一次 drain 之前就处于该状态，此时 `lastIndexedBlock: null` 是事实，滞后量必须照报。因此判定依据不能是"游标是不是 `null`"，只能是"游标**读到了没有**"。

## Decision

1. **`getHealth()` 单独记录"游标是否读到"这一事实**（局部变量 `cursorKnown`，初始 `false`，仅在 `readCursor()` 成功返回后置 `true`），而不是从 `lastIndexedBlock` 的值反推。`null` 是两种含义共用的值，无法承载这个区分。
2. **`lagBlocks` 在以下三种情形上报 `null`**：链读不到（原有行为）；`indexConfigured === false`，即没有索引可落后；`cursorKnown === false`，即索引存在但游标读不出来。其余情形照常计算，包括 `lastIndexedBlock === null` 的"已建表未同步"。
3. **`plan.ts` 的纯函数 `lagBlocks()` 语义不变。** 它回答的是"有多少个可安全索引的区块还没进索引"，`null` 游标在那里正确地等于"从创世起"。改动只发生在上报层：一个正确的函数被问了一个不适用于当前部署的问题。
4. **`types.ts` 的 `lagBlocks` 明确写出三种 `null` 情形**，并特别写明 `lastIndexedBlock: null` 与一个具体数字可以同时出现（已建表未同步），以免读者把它当成矛盾。
5. **界面不改。** 页面已经用 `?? "—"` 渲染，`null` 自然落到 `—`，与 `索引高度 未启用` 一致。

## Alternatives Considered

- **把 `lagBlocks()` 纯函数的 `null` 游标改为返回 `null`。** 会破坏一个正确的语义，并让"已建表未同步"这一真实待办量消失——正是第 3 条要避免的。
- **游标为 `null` 时一律上报 `null`。** 修掉了两个错误情形，但同时藏起新部署的真实滞后量；本 ADR 的边界表第二行就是钉住这一点的。
- **无索引时上报 `0`。** "没有索引"与"索引完全跟上了"用同一个数字表示，是更坏的混淆。
- **保留数字，只改页面的行标签为"未索引区块"。** 只在界面上绕开，`/api/health` 这个给机器读的接口仍然自相矛盾（`indexConfigured: false` 配一个具体滞后量）。
- **用 `indexError !== null` 代替 `cursorKnown`。** `indexError` 可能由后台循环早先的失败留下，而本次游标读取是成功的；那时滞后量是已知的，报 `null` 会变成少报。判定必须针对这一次读取。
- **让 `/api/health` 返回 `status: "lagging"`。** `HealthResponse.status` 只有 `ok` / `degraded` 两值，而 `lagging` 是 `/api/results` 的 `ConsistencyStatus`（ADR-0008）。两套状态机不应合并。

## Consequences

- 正面：`/api/health` 在无索引与索引不可达两种情形下自洽（`indexConfigured: false` / `indexError` 配 `lagBlocks: null`），页面不再在 `索引高度 未启用` 旁显示一个滞后量。
- 正面：一次数据库宕机不再被渲染成一个偏小的滞后数字（在真实链上会达数百万块），因而不会被读成"索引只是有点慢"。
- 正面："已建表但从未同步"这一真实状态的滞后量被保住，未因修错方向而丢失。
- 正面：字段语义由 3 个新单测钉住（共 14 例），覆盖四种状态，其中一例专门断言数字**不得**被吞掉。
- 代价：`lagBlocks` 的 `null` 现在有四种成因，读者必须结合 `indexConfigured` / `indexError` / `chainHead` 才能确定是哪一种；这一成本通过类型注释与 README 的状态表缓解。
- 代价：`getHealth()` 多一个局部变量与一条注释解释为什么不从值反推。
- 索引器单测 92 → **95**，总数 141 → **144**。

## Compatibility Boundary

`/api/health` 的字段集合与 HTTP 状态码不变；只有 `lagBlocks` 在两种此前会给出数字的情形下改为 `null`。这**是**一个可观察的行为变化，任何据此判断"索引是否落后"的调用方都必须同时检查 `indexConfigured`；对"索引正常且已同步"的部署（本项目的默认与 CI 路径）返回值完全不变（实测仍为 `"0"`）。`lagBlocks()` 纯函数、`/api/results`、`/api/candidates`、`/api/voters/*` 与页面其余部分均不受影响。

## Retirement Impact

若将来 `/api/health` 拆分为"链健康"与"索引健康"两个端点，第 2 条的三种情形应分别落到各自的端点里，而不是继续共用一个字段。若引入多链支持（ADR-0001 明确当前为单链），`indexConfigured` 成为逐链属性，`cursorKnown` 也必须逐链记录——单链假设是该字段成立的前提。若将来把 `lagBlocks` 换成足以承载"不适用/未知/具体值"三态的类型，第 2 条的 `null` 应迁移到该类型的一个显式成员，而不是继续靠 `null` 承担四种成因。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-6a/M-6b 只登记了"索引正常"与"游标回退重放"两种状态下的对账，§14 校正 13/15 记录的是索引**缺失**与健康字段命名，均未把 `lagBlocks` 在无索引/不可达时的语义列为被验证对象。漂移表已补记一行。

## Evidence References

- web/src/lib/data.ts
- web/src/lib/indexer/plan.ts
- web/src/lib/types.ts
- web/test/data.test.ts
- web/test/plan.test.ts
- web/src/components/Ballot.tsx
- docs/aegis/adr/ADR-0001-chain-is-the-only-source-of-truth.md
- docs/aegis/adr/ADR-0008-reconcile-unindexed-range-before-verdict.md
- docs/aegis/adr/ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md
- docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
