# ADR-0014 - 读取失败不得渲染成具体值，页面预取的三项读取各自结算

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测（`RPC_URL` 指向死端口 `127.0.0.1:8599`，浏览器打开页面）：修复前服务端首屏渲染出 **`数据来源 链上直读`**、**`票数合计 0`**、**`候选人（0）`**、**`索引高度 未启用`**。这四项在当时都没有任何依据：链读全部失败，而索引其实是配置好的且可读。
- 代码事实：`Ballot.tsx` 用 `tally.data?.total ?? 0`、`{tally.data?.source === "index" ? "MySQL 索引" : "链上直读"}`、`list.length`（`list = tally.data?.candidates ?? []`）与 `health.data === undefined || !health.data.indexConfigured ? "未启用"` 渲染这四行。每一处都把三种状态压成两种。
- 代码事实：`const myStake = stakeOf.data ?? 0n;` 之后，`refundReason` 的分支链落到 `myStake === 0n ? "没有可取回的押金。" : undefined`。`stakeOf` 读取**失败**时 `data` 为 `undefined`，于是页面给出一个关于用户资金的确定结论。合约的 `sweepUnclaimed()` 在 `REFUND_GRACE_PERIOD`（30 天）后会把未领回的押金交给 owner。
- 实测（水合后的 DOM，链不可达）：`数据来源 => "MySQL 索引"`、`票数合计 => "200"`、`索引高度 => "406 / 链头 —"`、`落后区块 => "—"`。也就是说客户端拿到的答案是**真实的**（`/api/candidates` 由索引作答），而服务端首屏当时把这些真实数据丢掉了。
- 代码事实：`page.tsx` 用 `Promise.all([getTally(), getResults(), getHealth()])` 配单个 `try/catch`。链不可达时 `getTally()`（有索引时走索引）与 `getHealth()` 实际**成功**，只有 `getResults()`（必须与链比对）抛错——单块 catch 把前两个结果一并丢弃，首屏于是显示占位符。
- 实测（`CHUNK_BLOCKS=1`，清空投影后完整重建）：`rounds: 406`、`totalEventRowsSeen: 404`、`inserted: 404`、`duplicatesIgnored: 0`，结果与 `CHUNK_BLOCKS=2000`（单轮）产生 3/200/0/200/1、游标 406、tally 67/67/66 **逐位一致**。
- 代码事实：`CHUNK_BLOCKS` 默认 2000，大于 406 块的播种链，因此 CI 的 `indexer-e2e` 每次 drain 都只有一个分块，`drain.ts` 的分块循环**从未真正迭代**过。

## Context

本项目在 ADR-0011 已经确立"不得用默认值代替未知"，但那一条是针对**索引**的两种缺失写的。本轮把链侧渲染路径实际跑了一遍（此前只在 API 层验证过），发现同一条规则在**读取失败**这一侧完全没有落实，而且分布在一个用户会据此做决定的界面上。

三类后果，严重程度不同：

| 位置                       | 修复前的断言         | 真实情况       | 后果                                                |
| -------------------------- | -------------------- | -------------- | --------------------------------------------------- |
| `数据来源`                 | "链上直读"           | 什么都没读到   | 读者以为链是好的                                    |
| `票数合计` / `候选人（N）` | "0"                  | 未知           | 把"不知道"当成"没有"                                |
| `索引高度`                 | "未启用"             | 索引存在且可读 | 掩盖了一个可用的子系统                              |
| `refundReason`             | "没有可取回的押金。" | 押金余额未知   | **用户可能因此不去领回押金，宽限期后被 owner 取走** |

最后一行是把这条规则从"界面诚实"提升为"资金安全"的原因。它也确实是最难自查的：按钮正确地禁用了（未知时不敢放开），但禁用理由对用户撒了谎——而 ADR-0009 立下的规矩恰恰是"禁用的控件必须说明理由"。理由错了，比没有理由更糟。

第二类问题是预取的三项读取被当成一个整体。设计目标是"首屏就有真实数据"，而 `Promise.all` 在任一失败时把其余成功结果全部丢弃，使首屏在该故障下**恰好**退化成设计想避免的占位符状态。

第三类问题不是缺陷而是验证强度：分块循环在真实链上从未迭代过，其边界行为只有针对假链的单测。"从未执行过的路径"在本项目里已经三次成为缺陷藏身处（`ipfs.ts` 的回退、指数回退、以及本条）。

## Decision

1. **凡是由读取驱动的用户可见断言，读取必须是三态**：`ready` / `loading` / `failed`。抽出 `readStatus(hasData, isError)` 统一判定，**先判 `hasData`**——读到 `0` 是一个真实答案（`stakeOf` 对未投票地址合法地返回 0），必须与读取未完成区分开。
2. **失败与未知一律渲染为"—"，加载中渲染为"读取中…"，失败渲染为"读取失败"。** 不得出现由 `?? 0` / `?? []` / `list.length` / 布尔兜底派生出的具体值或具体缺失断言。
3. **"禁用的控件必须说明理由"扩展为：理由必须与禁用原因一致。** 当禁用是因为**读取失败**时，理由必须说读取失败，不得说成"没有可取回的押金"这类关于世界的事实。
4. **服务端的多项预取各自结算。** `page.tsx` 改用 `Promise.allSettled`，保留成功的项，并把每个失败**归因到产生它的那次读取**（延续 ADR-0012）。横幅相应改为"服务端有读取失败（下面能读到的数据仍会显示）"，不再把任何一项失败都说成"无法读取链上数据"。
5. **纯逻辑抽成具名导出并单测。** `tallyLabels()` 与 `readStatus()` 从组件中导出，`web/test/ballot-labels.test.ts` 覆盖九种组合，使这条规则不再只由人工浏览器验证守护。
6. **让分块循环在 CI 里真的迭代。** `indexer-e2e` 的 `CHUNK_BLOCKS` 设为 `7`（小于 406 块的链），于是每次 drain 迭代 58 轮，分块边界在真实链上被反复穿过。

## Alternatives Considered

- **只用 `?? 0` 但把文案改成"约 0"。** 不解决问题：读者仍然读到一个数字，而数字是错的。
- **读取失败时整块隐藏面板。** 会同时隐藏掉本来可用的项（`票数合计` 在有索引时是真实的），等于用更大的信息损失换取诚实。
- **`refundReason` 在未知时返回 `undefined`（即按钮禁用且无理由）。** 直接违反 ADR-0009。
- **`refundReason` 在未知时统一说"正在读取押金余额…"。** 比原来好，但在链真的挂掉时会让用户永远等一个不会到来的答案；三态可以区分，就没有理由不分。
- **保留 `Promise.all`，改为在 `getResults()` 内部吞掉错误。** 会把一次"无法比对"伪装成一次"比对结果为空"，正是 ADR-0011 第 3 条禁止的事。
- **让 `page.tsx` 串行 `await` 三次读取。** 同样会保留成功结果，但失去并发；三项读取彼此独立，并发结算没有代价。
- **把 CI 的 `CHUNK_BLOCKS` 设为 1。** 会迭代 406 轮，边界覆盖最强，但 CI 时间与 RPC 调用量都放大一个量级；`7` 已经足以穿过所有分块边界形态，收益不及成本。

## Consequences

- 正面：链不可达时页面不再报出任何未经证实的具体值；首屏保留成功的读取，恢复"首屏就有真实数据"的设计意图。
- 正面：失败的押金读取不再告诉用户"没有可取回的押金"，消除了一个可能造成资金损失的误导。
- 正面：分块循环与其边界在 CI 中被真实执行，`CHUNK_BLOCKS` 的影响第一次有了实测证据（1 / 7 / 2000 三种取值下投影逐位一致）。
- 正面：规则由九条单测守护，不再依赖人工浏览器验证。
- 代价：`Ballot.tsx` 多两个具名导出与一个三态判定；`page.tsx` 多一层 `allSettled` 的归因代码。
- 代价：横幅文案从一句确定的话变成一句承认部分失败的话；读者需要多读几个字才能知道是哪一项失败。
- 索引器单测 83 → 92，总数 132 → **141**。
- CI 的 `indexer-e2e` 每次 drain 从 1 轮变为 58 轮，作业时间增加数秒。

## Compatibility Boundary

本条不改变任何接口的响应形状：`/api/*` 的字段与状态码不变。改动限于 `page.tsx` 的预取策略、`Ballot.tsx` 的渲染文案，以及 `.github/workflows/ci.yml` 中 `indexer-e2e` 的一个环境变量。`tallyLabels()` 与 `readStatus()` 是新增的具名导出，供测试使用；`BallotProps.initialError` 的**类型不变**（仍为 `string | null`），但语义从"服务端完全无法读取链上数据"变为"服务端有若干项读取失败，已按项归因"——两者都是给人读的字符串。可见的界面变化：故障态下的四行文案、横幅措辞，以及正常态下**无任何变化**（已实测：`MySQL 索引` / `200` / `406 / 链头 406` / `落后区块 0`，无横幅）。

## Retirement Impact

若将来这些读取改为由客户端单独发起（不再预取），第 4 条随之失效，但第 1、2、3 条必须保留——三态判定与理由一致性是渲染层的要求，与读取发生在哪里无关。若智管理的合约增加更多"用户资金"读数（如待领奖励），第 3 条应扩展到它们，而不是只覆盖押金。若将来引入支持分支覆盖的工具，第 6 条的 CI 取值应重新评估——用分块数换取覆盖率的意义会下降。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-6e 只登记了"注入钱包后驱动真实 DOM"的正常路径，从未把"链不可达时的首屏"列为被验证对象；M-6a/M-6b 也只覆盖正常链上的索引一致性，未涉及 `CHUNK_BLOCKS` 的影响。漂移表已补记一行。

## Evidence References

- web/src/components/Ballot.tsx
- web/src/app/page.tsx
- web/test/ballot-labels.test.ts
- .github/workflows/ci.yml
- web/src/lib/indexer/plan.ts
- web/scripts/drain.ts
- docs/aegis/adr/ADR-0009-ui-eligibility-from-chain-not-query-status.md
- docs/aegis/adr/ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
