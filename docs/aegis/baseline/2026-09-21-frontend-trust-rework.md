# 基线记录：前端重设计与信任改造（2026-09-21）

本轮针对用户提出的两点——「前端并不好看」与「功能没有落实到现实意义」——执行三批改造。

## 改造前的可测量状态

| 项目       | 改造前                         | 改造后              |
| ---------- | ------------------------------ | ------------------- |
| 合约测试   | 157（98 solidity / 59 nodejs） | **177（114 / 63）** |
| Web 测试   | 260                            | **327**             |
| 类型检查   | 通过                           | 通过                |
| 格式检查   | 通过                           | 通过                |
| 构建       | 通过                           | 通过                |
| 浏览器演练 | 通过                           | 通过（含新增断言）  |

## 诊断到的问题

### 一、视觉层

1. **同一个概念有四处独立配色**。阶段 → 颜色的映射分别写在 `PollCard`、`PollBallot`、`ConsistencyBadge` 与页面里，同一个「投票中」在不同位置颜色不同。
2. **「已过截止但尚未关闭」被显示成「已结束」**。这是**事实错误**而非美观问题：该状态下 `closeAfterDeadline()` 仍可被任何人调用，用户看到的却是一个已结束的投票。
3. **没有空态与骨架屏**。索引未就绪时页面显示空白，与"确实没有投票"无法区分。
4. **创建表单始终展开**，占据首屏大量空间，而它多数时候并不需要被使用。

### 二、功能层

5. **结果只能看，不能带走**。没有导出，第三方无法在自己的工具里复核。
6. **活动时间线完全缺失**。链上有事件，页面上看不到发生过什么。
7. **`changeVote` 在事件索引里产生重复行**。改投时 `cast` 与 `changed` 两条事件指向同一次行为，时间线会显示成两次操作。

### 三、信任层

8. **规则是否被改过无法低成本判断**。选项与白名单在 `Phase.Setup` 可改，但改过与没改过从外部看起来一样。
9. **押金风险在界面上不存在**。`sweepUnclaimed()` 允许发起人在宽限期后取走无人认领的押金——这是对投票人最要命的一条规则，却从未出现在页面上。

## 三批改动与证据

### A 批：视觉系统

- 新增 `web/src/lib/presentation.ts`：`Tone` 与 `phaseTone()` 成为"链上状态 → 观感"的**唯一所有者**（ADR-0028）。`web/test/presentation.test.ts` 14 个用例。
- 新增 `web/src/components/ui.tsx`：`Card` / `Stat` / `Badge` / `EmptyState` / `Skeleton` / `ShareBar` 等基础件。
- `PageShell` 重写为深色报头 + 浅色内容列；`PollCard` / `PollBallot` / `MyVotes` / `HealthPanel` / `Countdown` 等全部改用共享观感层。
- 创建表单改为可折叠（用 `hidden` 而非卸载，已输入内容不丢失）。
- **回归**：重写 `PageShell` 时漏掉 `<WalletSlot>`，导致连接钱包整条链路失效。由 `ui-drill` 的 `the wallet connected` 捕获。这是"演练断言独立于实现"的价值所在。

### B 批：现实投票机制

- 新增 `web/src/lib/poll-report.ts`：活动排序、改投回声消除、CSV/JSON 导出、投票率。`web/test/poll-report.test.ts` 28 个用例。
- 新增两条 API：`/api/polls/[address]/activity` 与 `/api/polls/[address]/export?format=csv|json`。
- 新增 `PollActivity` 与 `ResultExport` 组件。
- **CSV 注入防护**：`csvCell` 对以 `= + - @ Tab CR` 开头的字段加前导 `'`，防止导出文件在表格软件里被当作公式执行。
- **改投回声**：`withoutChangeEcho()` 消除 `cast` + `changed` 的重复。**实测 412 → 409 条**，恰好移除 3 条回声，而区块 413 的真实首次投票保留了 `cast`。
- **404 不等于空列表**：索引不可用时 `/activity` 返回 404，页面必须显示「这个部署没有可用的索引」而非「还没有任何活动」。「读不到」与「没发生」是两件事。

### C 批：规则承诺（信任层）

- 合约新增 `rulesHash`（`initialize` 写入一次，永不改变）与 `currentRulesHash()`（对当前状态重算）。
- 两者比对即可回答"规则有没有被改过"。16 个 `test_RulesHash_*` 合约用例。
- 新增 `web/src/lib/trust.ts` + 14 个用例；新增 `TrustPanel.tsx`（`RulesCheck` 与 `StakeRisk`），**在浏览器里直接读链**，不经过本部署的服务器。
- 新增 `contracts/scripts/verify-rules-hash.ts`，在真实链上核对。
- 详见 ADR-0029。

## 真实链上的验证结果

本地链（31337）重新部署并播种，索引清空后重建：

| 对象                            | 地址                                         | `rulesHash` vs `currentRulesHash()` | 页面结论                 |
| ------------------------------- | -------------------------------------------- | ----------------------------------- | ------------------------ |
| 投票 1（创建后加白名单 200 人） | `0x9f1ac54BEF0DD2f6f3462EA0fa94fC62300d3a8e` | 不同                                | `changed` — 与链上一致   |
| 投票 2（创建后未改白名单）      | `0xbf9fBFf01664500A33080Da5d437028b07DFcC55` | **完全相同**                        | `unchanged` — 与链上一致 |

- 索引一致性：`onChainTotal 200 / indexedTotal 200`，`status: consistent`。
- 导出：CSV 200 票 = 68+68+64，CRLF 换行，`attachment` 响应头正确。
- 活动时间线：409 条，倒序，`阶段 0 → 1` 等细节正确渲染。
- 三种写入路径（投票 / 改投 / 拒绝）演练全部通过。

## 关键验证方式：演练与页面"独立算一次"

规则面板的演练断言**不是**拿页面文案去比页面自己的属性——那样一个"永远显示 unchanged"的组件也会通过。演练自己从链上读两个指纹、自己得出结论，再要求页面得出同一个结论：

```
chain verdict  =changed
page  verdict  =changed    OK  the page's verdict matches the one computed from the chain
```

## 已知限制

- `rulesHash` 回答的是"有没有改"，不是"改成了什么"。要还原具体改动仍需回溯事件。
- `currentRulesHash()` 随白名单规模增长为 O(n log n)。它是 `view`，不耗交易 gas，但白名单极大时链下读取会变慢。
- 因 ABI 变更（`rulesHash` / `currentRulesHash` 新增），Sepolia 尚未重新部署；本轮验证全部在本地链完成。
- 合约新增 `_whitelistKeys` 存储，每个不同地址多占两个 slot。
