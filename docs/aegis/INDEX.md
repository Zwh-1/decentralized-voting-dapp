# Aegis Workspace Index

This index tracks files created under this project's `docs/aegis/` workspace.
Entries are workspace records, not authoritative runtime decisions.

| Date       | Kind     | Path                                                                                     | Title                                                                             |
| ---------- | -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 2026-09-20 | spec     | docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md                          | Decentralized Voting DApp 设计规格                                                |
| 2026-09-20 | baseline | docs/aegis/baseline/2026-09-20-initial-baseline.md                                       | Initial dual-baseline snapshot                                                    |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0001-chain-is-the-only-source-of-truth.md                             | ADR-0001 - 链上是唯一事实源，链下只做只读投影                                     |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0002-hardhat-3-over-hardhat-2.md                                      | ADR-0002 - 采用 Hardhat 3，而不是 Hardhat 2，并接受原生能力替代插件               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0003-public-ballots-no-vote-privacy.md                                | ADR-0003 - 明票上链，并在 README 与 UI 中主动声明没有投票隐私                     |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0004-ipfs-for-metadata-only.md                                        | ADR-0004 - IPFS 只承载候选人元数据，链上只保存 CID                                |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0005-stake-creates-a-real-reentrancy-surface.md                       | ADR-0005 - 以质押/退还构造真实重入面，并明确否认它是女巫防护                      |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0006-two-layers-and-optional-mysql.md                                 | ADR-0006 - 收缩为合约层 + Next.js 两层，并把 MySQL 降级为可选依赖                 |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0007-property-tests-instead-of-the-invariant-runner.md                | ADR-0007 - 用确定性属性测试替代 Hardhat 3 不可用的 invariant 运行器               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0008-reconcile-unindexed-range-before-verdict.md                      | ADR-0008 - 一致性检查必须先对账未索引区间，再判定分歧                             |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0009-ui-eligibility-from-chain-not-query-status.md                    | ADR-0009 - 投票按钮可用性由链上状态推导，进行态不得取自被禁用的查询               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0010-one-record-one-schema-no-volatile-fields-in-guarded-artifacts.md | ADR-0010 - 部署记录只有一个写入 schema，被字节级守护的产物只含可复现字段          |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md            | ADR-0011 - 索引的两种缺失走同一条回退路径，且不得用默认值代替"未知"               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md                         | ADR-0012 - 失败状态必须指出失败的是谁，且不得用单一计数合并不同成因               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0013-health-fields-name-what-they-compute.md                          | ADR-0013 - 观测字段必须与该字段真正计算的东西同名，\"存在\"与\"正在运行\"分开报告 |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md                    | ADR-0014 - 读取失败不得渲染成具体值，页面预取的三项读取各自结算                   |
