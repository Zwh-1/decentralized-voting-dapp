# ADR-0013 - 观测字段必须与该字段真正计算的东西同名，"存在"与"正在运行"分开报告

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测（以 `INDEXER_ENABLED=false` 启动 `next start`，随后读 `/api/health`）：返回 `{"status":"ok","indexEnabled":true,"lastIndexedBlock":"406","chainHead":"406","lagBlocks":"0"}`。后台循环处于关闭状态，而字段报 `true`。
- 实测（同一次运行，直接查库）：`votes=200 whitelist=200 refunds=0 last_block=406 tally=200`——库确实未被改动。也就是说错误的字段值差一点导致一个关于数据的错误结论，只是恰好被独立查询纠正。
- 代码事实：`web/src/lib/config.ts` 的 `isIndexEnabled(config)` 实现为 `return config.databaseUrl !== null;`，即"是否配置了数据库"，而非"索引是否在运行"。`data.ts` 将其结果放进 `HealthResponse.indexEnabled`。
- 代码事实：真正控制后台循环的 `config.indexerEnabled`（来自 `INDEXER_ENABLED` 环境变量，`config.ts:131`）在 `HealthResponse` 中**没有任何字段**。`data.ts:446` 的循环守卫读取它，但该状态不外露。
- 代码事实（UI）：`Ballot.tsx` 用 `indexEnabled` 决定"索引高度"一行显示高度还是"未启用"，并据此决定是否显示"立即同步索引"按钮。按"是否存在索引"读是自洽的，按字段名读则不是。
- 实测（修复后两种配置）：`INDEXER_ENABLED=false` → `indexConfigured: true`、`indexerLoopEnabled: false`，页面显示"后台索引循环已关闭…"；默认 → `indexConfigured: true`、`indexerLoopEnabled: true`，页面不显示该提示。
- 新增 `data.test.ts` 用例断言 `indexConfigured === true` 与 `indexerLoopEnabled === false` 可同时成立。

## Context

本项目的一个端到端健康接口需要同时回答两个不同的问题：

| 问题                 | 真实来源                | 用途                                                   |
| -------------------- | ----------------------- | ------------------------------------------------------ |
| 是否存在一个索引？   | `DATABASE_URL !== null` | 决定"数据来源"是否可能为索引，决定是否提供手动同步入口 |
| 索引会不会自行前进？ | `INDEXER_ENABLED`       | 决定"落后区块"是否会自己回落，决定是否必须手动同步     |

原实现只报告了第一个，却把字段命名为第二个的意思。这不是纯粹的措辞问题：`INDEXER_ENABLED=false` 是一个被文档鼓励的部署方式（README 建议在不想用后台循环时改用手动推进），在这种配置下 `lagBlocks` 会单向增长，而接口没有任何字段能解释原因。

命名的代价在本轮被具体测量到：读到 `indexEnabled: true` 后，需要额外一次数据库查询才能排除"循环写入污染了投影"这一可能。一个观测字段若需要旁证才能解释，它就没有在履行观测的职责。

这与 ADR-0012 是同一族问题的另一面：ADR-0012 要求**失败**被归因到正确的一方，本条要求**状态**被归因到正确的一方，且字段名与其计算一致。

## Decision

1. **字段与其计算同名。** `HealthResponse.indexEnabled` 改名为 `indexConfigured`，与 `isIndexEnabled` 真正的计算（`databaseUrl !== null`）一致。
2. **"存在"与"正在运行"分开报告。** 新增 `HealthResponse.indexerLoopEnabled: boolean`，取自 `config.indexerEnabled`。两者可以任意组合，且都由接口回答。
3. **不可自行前进的状态要在界面上说出来。** 当 `indexConfigured === true` 且 `indexerLoopEnabled === false` 时，UI 在索引高度旁明确提示循环已关闭、高度不会自行前进、可用按钮手动同步。只报告数字而不解释它为何不动，等同于让读者自己猜。
4. **`indexError` 保持独立。** 它回答第三个问题（索引是否可读），三者互不替代：可以存在且正在运行但读不到，也可以存在且可读但循环关闭。

## Alternatives Considered

- **保持 `indexEnabled` 字段名不变，只新增 `indexerLoopEnabled`。** 破坏性更小，但把一个已知会误导的名字留在公开响应里。名字的成本由每一个未来的读者支付，而改名只付一次。
- **保持 `indexEnabled` 的字段名，改 `isIndexEnabled` 的实现为 `databaseUrl !== null && config.indexerEnabled`。** 会让字段名更接近字面含义，但随后 UI 会在"循环关闭但索引可用"时显示"未启用"，从而掩盖一个仍然可用、只是不自动推进的索引——把一处误导换成另一处。
- **把后台循环的开关也做进 UI 的开关（可在线启停）。** 需要运行时可变配置与并发控制，当前配置在进程启动时读取一次。超出范围。
- **只在 README 里写明 `indexEnabled` 的真实含义。** 文档无法阻止误读，且本轮已经证明误读会立刻发生——它发生在写下这句话的人身上。
- **让 `/api/health` 返回嵌套对象（`index: { configured, loopEnabled, readable }`）。** 结构更清晰，但会改变响应的形状而不只是字段名，且现有唯一消费者需要整体重写；收益与三个扁平布尔相同。

## Consequences

- 正面：无法再从一个字段推断出错误的循环状态。两种状态各自可查、可测。
- 正面：`INDEXER_ENABLED=false` 的部署方式不再有沉默的悬念——界面直接说明高度不会自行前进及如何手动推进。
- 正面：`config.indexerEnabled` 从"只被内部守卫读取"变为对外可观测，使该项配置可被验证。
- 代价：`HealthResponse.indexEnabled` 被移除，属破坏性变更。仓库内唯一消费者是同一个 `web/` 应用（`Ballot.tsx` 两处）与其测试，已同步。
- 代价：响应多一个字段；UI 多一个条件提示。
- 索引器单测 81 → 82，总数 130 → 131。

## Compatibility Boundary

`GET /api/health` 移除 `indexEnabled`，新增 `indexConfigured` 与 `indexerLoopEnabled`。取值语义随之明确：`indexConfigured === databaseUrl !== null`（与旧 `indexEnabled` 完全相同的计算），`indexerLoopEnabled === INDEXER_ENABLED !== "false"`。任何按旧字段名读取的消费者需要改名；按旧语义读取的消费者行为不变。其余字段（`status`、`chainHead`、`lastIndexedBlock`、`lagBlocks`、`indexError`）不变。UI 的可见变化只有一处：循环关闭时新增一段说明文字。这些都不是对外发布的包。

## Retirement Impact

若将来后台循环被移除、或改为由外部调度器驱动，`indexerLoopEnabled` 应改为报告调度器是否在运行，而不是删除——"数字会不会自己动"这个问题不会消失。若配置变为运行时可改，第 3 条的提示需要随之变为可交互，但"必须解释数字为何不动"这一要求保留。若将来健康检查改为嵌套结构，第 1、2 条的实质（存在与运行分开、名与计算一致）必须保留。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-7 只登记了"Next.js 生产构建"，健康接口的字段语义从未作为被验证对象；`INDEXER_ENABLED` 这一配置项也从未被测过。漂移表已补记一行。本轮同时按实测更正了基线所引规模数字之外的演练断言计数（ADR-0009 记录的 7 / 11 / 17 实为 12 / 16 / 18）。

## Evidence References

- web/src/lib/types.ts
- web/src/lib/data.ts
- web/src/lib/config.ts
- web/src/components/Ballot.tsx
- web/test/data.test.ts
- web/scripts/ui-drill.ts
- README.md
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
