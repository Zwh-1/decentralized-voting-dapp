# ADR-0001 - 链上是唯一事实源，链下只做只读投影

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- M-6 一致性 200/200 偏差 0；M-6b 重放 404 行插入 0 行；web/src/app/api 下无非 SELECT 语句

## Context

双写（链上写一笔、库里写一笔）会引入无法消除的链上成功-写库失败窗口，且要求后端持有私钥。

## Decision

合约是唯一事实源；链下索引器只读、不持有私钥、可重建。链上写入只由用户钱包签名。

## Alternatives Considered

- 后端代发交易（Gas 代付/账户抽象）：中心化点从合约转移到运维，且需要 nonce 管理与重试。
- 前端直连链、不要索引器：候选人列表与历史查询在链上昂贵或做不到，且失去 TS+MySQL 的支撑点。
- The Graph / subgraph：把最有技术含量的部分外包，且无法展示事务、游标与重组处理。

## Consequences

- 正面：不存在需要补偿的中间态；索引正确性可被独立验证；数据库可删除重建。代价：链下无业务写入，后端证据是只读服务与投影而非并发写；索引必然落后，需显式暴露 lagBlocks。

## Compatibility Boundary

链上地址与 ABI 是应用与索引的共同契约；索引可在任意时刻从创世块重建，因此不构成兼容负担。

## Retirement Impact

删除 JWT 与写入 API 后，后端不再有鉴权面，也无遗留写入路径需要退役。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: update baseline
- Reason: 基线 §2/§6 描述的写入 API 与 JWT 已不存在，需在基线的修订表中登记为已被取代。

## Evidence References

- web/src/lib/indexer/sync.ts
- web/src/app/api/results/route.ts

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
