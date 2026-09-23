# ADR-0006 - 收缩为合约层 + Next.js 两层，并把 MySQL 降级为可选依赖

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 提交 1a8f0a5；重构后重测 M-1 覆盖率 100%/100%、85 个测试通过、M-6 200/200 偏差 0、M-6b 重放 404 行插入 0 行、无数据库时 /api/results 返回 mode: chain-only

## Context

原设计切成四个包：合约、独立 Express 索引器服务、只放生成物的 packages/shared、Vite SPA 前端。实施后确认目标结构应为两层。重新审视发现两处真实浪费：索引器没有独立生命周期（与前端共享同一次 install、同一份配置、同一套 ABI，却要单独部署与维护跨进程契约），而 packages/shared 的唯一内容是生成物，用包边界换取了并不存在的独立性。同时四层结构使首次本地运行需要四个终端。

## Decision

仓库收缩为 contracts/ 与 web/ 两层。索引器移入 web/src/lib/indexer/，由 instrumentation.ts 的后台循环与 POST /api/index/sync、pnpm indexer:drain 驱动；Express 被 5 个 Route Handler 取代；ABI 生成到 web/src/lib/contracts/ 并由 CI 做漂移检查；MySQL 降级为可选依赖，无 DATABASE_URL 时所有读取回退为直接读链且 /api/results 报告 mode: chain-only；票数与是否已投票直接读链，索引只服务列表与历史。

## Alternatives Considered

- 保留 Vite SPA 并在旁边新增 Next 应用：两个前端并存无收益，且会把 ABI 与配置的来源重新变成两份。
- 保留三层，只把 Vite 换成 Next：索引器仍需独立部署，不满足“合约层加 Next 层”的目标结构。
- 继续强制要求 MySQL，缺库即报错：让只想看本地链的人必须先装数据库，与一条命令可复现的交付目标冲突。

## Consequences

- 正面：本地启动从四个终端降到三个；首屏由 Server Component 直接读取真实数据，带一致性结论而非 loading；索引与 UI 共享同一份 ABI 与配置。代价：钱包状态在客户端，需要 useMounted 避免 hydration 不一致；后台索引循环依赖长驻进程，在无服务器部署中不会持续运行，因此可靠入口是 API 与 CLI；索引器不再可独立伸缩。

## Compatibility Boundary

indexer 与 packages/shared 两个包整体移除，是破坏性变更，旧实现在提交 926c1de 保留。生成物路径由 packages/shared 改为 web/src/lib/contracts，CI 漂移检查同步改向。

## Retirement Impact

indexer/ 18 个文件、packages/ 5 个文件、Vite 版 web/ 6 个文件共 29 个文件已删除。跨进程 HTTP 契约与 Vite 构建配置整体退役，无兼容层保留。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: update baseline
- Reason: 基线 §2/§5.1/§6/§9 描述的是四层结构与强制 MySQL，与当前架构不符，必须在基线修订表中登记为已被取代。

## Evidence References

- web/src/lib/data.ts
- web/src/lib/report.ts

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.

## Amendment - 2026-09-22 - 生产拓扑收窄：web 侧 INDEXER_ENABLED=false，索引器成为独立容器（见 ADR-0045）

- Status: amended

### Source Evidence

- `docker-compose.yml`：`migrate` / `indexer` / `web` 三个服务都显式设 `INDEXER_ENABLED: "false"`；`web` 服务的注释写明「Indexing belongs to the indexer service. Two drains on one cursor is a race, and the loser's work is silently discarded.」
- `docker-compose.yml` 的 `indexer` 服务：`command: ["/app/ops/indexer/entrypoint.sh"]`、`restart: unless-stopped`、`depends_on` 为 `mysql: service_healthy` 与 `migrate: service_completed_successfully`；注释写明「Its own service rather than the app's in-process loop: two processes draining the same cursor would race, and the loop inside the server is a development convenience that does not survive a restart.」
- `docker-compose.prod.yml`：`web-blue` 与 `web-green` 都显式设 `INDEXER_ENABLED: "false"`，注释写明「the indexer is a single cursor over one chain, and three processes advancing it independently would interleave writes and corrupt the index. In production exactly one `indexer` service owns that cursor.」
- 实测（计划 §14.8 验证表）：`docker compose config --quiet` 退出码 **0**；四服务清单与依赖条件（`service_healthy` / `service_completed_successfully`）符合预期
- 实测（计划 §14.11）：叠加 `docker-compose.prod.yml` 后 `docker compose -f … -f … config --quiet` 退出码 **0**；生产服务清单为 `mysql, migrate, web-blue, web-green, nginx, indexer`，单槽 `web` 被 profile 正确停用
- 规格 §3.1 与 §9.4 已登记这条口径：`voting_indexer_loop_enabled` 在容器化后 web 侧恒为 0，指标本身正确，但需要文档解释拓扑，否则读者会以为「索引循环坏了」
- 边界：容器**从未真正起来过**（Docker 引擎本阶段不可用），因此「索引器确实在推进游标」只有配置层面的依据；计划 §14.8 把「indexer 循环是否在跑而不退出」明确列为未验证

### Change Summary

生产拓扑收窄：web 侧 INDEXER_ENABLED=false，索引器成为独立容器（见 ADR-0045）

### Compatibility Boundary

开发路径完全不变：`instrumentation.ts` 的后台循环代码一个字未改，`pnpm dev`、`pnpm indexer:drain`、`pnpm indexer:migrate` 与 `POST /api/index/sync` 的语义均不受影响。变化只发生在容器拓扑：容器内 `INDEXER_ENABLED` 一律为 `false`，因此 `/api/health` 的 `indexerLoopEnabled` 在容器内为 `false`。这是一个**可观察**的变化，规格 §9.4 已经登记了它的口径，指标 `voting_indexer_loop_enabled` 会显示 0。ADR-0006 原有的其余边界（无 `DATABASE_URL` 时全部读取回退为直接读链、`/api/results` 报告 `mode: chain-only`）不变。

### Retirement Impact

进程内后台循环在容器拓扑下已不再承担实际驱动作用，退化为**开发便利**。若将来确认无人依赖它（本地开发也改用 `pnpm indexer:drain` 或独立 worker），应整体退役，而不是保留一个在容器里恒为 `false` 的开关——那会让「索引器为什么不动」这个问题多一个需要排除的假设。若将来引入第二个索引器实例或分片索引，`indexer` 服务的单实例假设（单一游标）必须先改，否则交错写入会污染投影；ADR-0001 关于「索引是可重建投影」的结论在那时是恢复路径，而不是并发许可。

### Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: ADR-0006 原基线同步记的是「基线 §2/§5.1/§6/§9 描述的是四层结构与强制 MySQL，必须在基线修订表中登记为已被取代」。本次收窄的是**索引器的驱动方式**：ADR-0006 决定它由 `instrumentation.ts` 的后台循环驱动，本阶段决定生产里该循环关闭、索引器成为独立容器。既有基线里没有任何条目描述容器拓扑，因此由本阶段的新基线快照登记这一收窄，并同时登记「容器从未真正起来过」这一未验证边界。

### Evidence References

- docker-compose.yml
- docker-compose.prod.yml
- ops/indexer/entrypoint.sh
- web/src/instrumentation.ts
- docs/aegis/adr/ADR-0045-one-image-carries-three-process-roles.md
- docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md

### Boundary

This amendment is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
