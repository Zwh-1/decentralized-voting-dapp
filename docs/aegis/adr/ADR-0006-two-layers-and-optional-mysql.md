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
