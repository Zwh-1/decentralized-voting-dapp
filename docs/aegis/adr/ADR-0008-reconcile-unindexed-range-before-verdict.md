# ADR-0008 - 一致性检查必须先对账未索引区间，再判定分歧

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- Design Spec §15「M-6 的第三个缺陷：这个检查器在默认配置下会稳定误报」与「同一轮排查里发现的退出码缺陷」；实测：`CONFIRMATIONS=5`、链头 406 / 安全头 401 下，索引健康地停在 401（197 票），旧实现稳定输出 `"consistent": false`、退出码 1；修复后同一状态输出 `status: "consistent"`、`pendingVotesAddedBack: 3`、退出码 0，而叠加删除 1 行后输出 `status: "divergent"`、退出码 1
- 退出码缺陷：`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`，使正确运行报成 `0xC0000409`

## Context

索引器按设计不索引最近 `CONFIRMATIONS` 个区块（ADR-0001 要求索引正确性可独立验证，重组不得留下永久错误数据）。因此索引里的票数**本来就应该**少于链上当前票数。第一版 `/api/results` 与 `check-consistency` 直接比较两个总数，于是把这一正确行为报成故障：在默认 `CONFIRMATIONS=5` 下它们**永远**报不一致。

这不是"检查器过于严格"，而是问错了问题——它拿"链上此刻的状态"去比"索引被允许知道的状态"。后果是这个检查器提供的信号为零，且真实分歧与正常落后在输出上完全无法区分。一个在所有情况下都报警的警报等价于没有警报，而本项目把 M-6 当作索引正确性的主要证据。

## Decision

判定逻辑统一收敛到 `web/src/lib/report.ts` 的 `checkConsistency`，由 `/api/results` 与 `check-consistency` 脚本共用（两者不可能给出不同结论）。它先拉取 `(cursor, head]` 区间内的日志，用既有的 `decodeLogs` 解码其中的 `VoteCast`，把票数加回索引一侧，**再做比较**。

判定结果由二值 `consistent: boolean` + `mode` 改为四值 `status`：

| `status`      | 含义                                         | HTTP | CLI 退出码               |
| ------------- | -------------------------------------------- | ---- | ------------------------ |
| `consistent`  | 计入待确认票数后两侧完全吻合                 | 200  | 0                        |
| `divergent`   | 计入之后仍然不吻合——真故障                   | 500  | 1                        |
| `lagging`     | 未索引区间超过 5000 块，无法枚举因而无法归因 | 200  | 0，并打印 `INCONCLUSIVE` |
| `unavailable` | 未配置数据库，不存在可比对的第二个来源       | 200  | 0                        |

配套决定：

1. **只有 `divergent` 产生失败信号**（HTTP 500 / 退出码 1）。把正常落后报成 HTTP 500 会让监控长期处于告警状态。
2. **`lagging` 不等于通过**，它必须留下痕迹（stderr 的 `INCONCLUSIVE`），因为"未验证"不得伪装成"已验证"。
3. **`unavailable` 不再断言任何一致性**。旧实现在无数据库时返回 `consistent: true`，把"无从比对"表述成了"一致"。
4. **`pendingVotes` / `unindexedBlocks` 进入响应体**，让 197 与 200 为何算一致成为可读事实，而不是需要推断的东西。
5. **脚本以 `process.exitCode` 退出，不再调用 `process.exit()`**。后者立即终止进程，`finally` 中的 `pool.end()` 不会执行，Windows 上 libuv 会因未关闭句柄触发断言，使正确的运行报成 `0xC0000409`；对"契约就是退出码"的验证脚本这是致命的。资源创建**之前**的预检仍可用 `process.exit()`。

## Alternatives Considered

- **保留直接比较，把阈值放宽或按 `lagBlocks` 分级**：只是把误报调小，没有消除"拿两个不同问题作比较"这一根本错误，仍无法区分真实分歧。
- **要求使用者把 `CONFIRMATIONS` 设为 0 才能得到有效判定**：等于让默认配置下的检查失效，且本地为 0、生产为 5 会让两处行为不一致。
- **把未索引区间的日志重新完整索引一遍再比较**：代价与收益不成比例；只需统计票数增量即可完成归因，无需写库。
- **保留 `consistent: boolean` 并另加 `reconciled: boolean`**：两个布尔量的组合难以正确使用（4 种组合中有 1 种无意义），四值枚举把非法状态排除在类型之外。

## Consequences

- 正面：M-6 在默认配置下才真正具备判别力；实测证实**真实故障不会被"还在确认窗口内"掩盖**（同样 `unindexedBlocks: 5` 下，健康→`consistent`、删 1 行→`divergent`）。代价：每次 `/api/results` 多一次 `getLogs`（区间通常仅 `CONFIRMATIONS` 个区块），并引入 5000 块的对账上限——超过上限只能返回 `lagging`。
- 正面：退出码重新可信。代价：脚本不再能在资源打开后立即中止，必须走完 `finally`。
- 已知边界：`lagging` 在本项目的本地环境中不可达（链长仅 406 块），因此该分支只有单元测试覆盖，没有端到端实测。

## Compatibility Boundary

`ResultsResponse` 的字段变更是一次**破坏性 API 变更**：`consistent` 与 `mode` 被移除。仓库内所有消费方（`client-api.ts`、`ConsistencyBadge.tsx`、`check-consistency.ts`、`client-api.test.ts`）已同步更新，并新增 `web/test/report.test.ts` 固定判定语义。

## Retirement Impact

若将来索引器改为跟踪链头（`CONFIRMATIONS=0`）或引入可读取历史状态的归档节点，对账逻辑的收益会下降；但只要保留确认窗口，本决策即为其必要配套，不得单独移除。归档节点路径若实现，应删除 `getLogs` 对账而改为按 cursor 高度读链上历史状态，并保留四值 `status` 语义。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §5.2 第 1 条登记了"MySQL 可选、缺失时报告 `mode: "chain-only"`"这一降级行为；本次变更把该表述更正为 `status: "unavailable"`，并新增落后对账语义，基线漂移表已补记一行。

## Evidence References

- web/src/lib/report.ts
- web/src/lib/types.ts
- web/src/app/api/results/route.ts
- web/scripts/check-consistency.ts
- web/test/report.test.ts
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
