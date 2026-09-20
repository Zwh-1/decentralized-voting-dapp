# ADR-0004 - IPFS 只承载候选人元数据，链上只保存 CID

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测公共网关 ipfs.io 与 dweb.link 返回 429，up.storacha.network TLS 被重置；web/src/lib/ipfs.ts 的 isPlausibleCid 与三态返回

## Context

候选人需要展示名称、口号与头像，且这些内容一旦登记就不应被任何一方单方面修改。写进合约 storage 代价高昂且放不下图片。

## Decision

元数据以 JSON 存放于 IPFS，链上 Candidate.metadataCID 只保存 CID；前端经 HTTPS 网关解析；索引器只索引 CID，不缓存元数据内容。

## Alternatives Considered

- 元数据存 MySQL：管理员可随时改库，与宣言不可篡改矛盾，且链上无法验证展示内容的真实性。
- 元数据全部上链：gas 成本高一个数量级，且无法承载图片。
- 元数据存链下 HTTP 服务：引入一个可随时下线的中心化依赖，比网关更脆弱。

## Consequences

- 正面：CID 与内容绑定，链上保证不变、IPFS 保证可取；索引器职责边界清晰。代价：公共网关不可靠（429 限流），本机无可用免费 pinning 服务；前端必须实现多网关轮询、超时与 CID 本地校验，并把元数据不可用作为正常状态降级渲染。仓库不含已 pin 的内容，seed-local 写入的是占位 CID。

## Compatibility Boundary

CID 是链上不可变数据，一旦写入不可替换；网关与 pinning 服务可整体替换，不影响链上契约。

## Retirement Impact

若将来改用自带 pinning 服务，只需设置 NEXT_PUBLIC_IPFS_GATEWAY；链上 CID 与解码逻辑不变。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线与风险 R4 已登记网关限流与 pinning 缺失，本 ADR 只记录取舍理由。

## Evidence References

- web/src/lib/ipfs.ts
- contracts/contracts/Voting.sol

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
