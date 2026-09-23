# Aegis Workspace Index

This index tracks files created under this project's `docs/aegis/` workspace.
Entries are workspace records, not authoritative runtime decisions.

| Date       | Kind     | Path                                                                                     | Title                                                                                             |
| ---------- | -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 2026-09-20 | spec     | docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md                          | Decentralized Voting DApp 设计规格                                                                |
| 2026-09-20 | baseline | docs/aegis/baseline/2026-09-20-initial-baseline.md                                       | Initial dual-baseline snapshot                                                                    |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0001-chain-is-the-only-source-of-truth.md                             | ADR-0001 - 链上是唯一事实源，链下只做只读投影                                                     |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0002-hardhat-3-over-hardhat-2.md                                      | ADR-0002 - 采用 Hardhat 3，而不是 Hardhat 2，并接受原生能力替代插件                               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0003-public-ballots-no-vote-privacy.md                                | ADR-0003 - 明票上链，并在 README 与 UI 中主动声明没有投票隐私                                     |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0004-ipfs-for-metadata-only.md                                        | ADR-0004 - IPFS 只承载候选人元数据，链上只保存 CID                                                |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0005-stake-creates-a-real-reentrancy-surface.md                       | ADR-0005 - 以质押/退还构造真实重入面，并明确否认它是女巫防护                                      |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0006-two-layers-and-optional-mysql.md                                 | ADR-0006 - 收缩为合约层 + Next.js 两层，并把 MySQL 降级为可选依赖                                 |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0007-property-tests-instead-of-the-invariant-runner.md                | ADR-0007 - 用确定性属性测试替代 Hardhat 3 不可用的 invariant 运行器                               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0008-reconcile-unindexed-range-before-verdict.md                      | ADR-0008 - 一致性检查必须先对账未索引区间，再判定分歧                                             |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0009-ui-eligibility-from-chain-not-query-status.md                    | ADR-0009 - 投票按钮可用性由链上状态推导，进行态不得取自被禁用的查询                               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0010-one-record-one-schema-no-volatile-fields-in-guarded-artifacts.md | ADR-0010 - 部署记录只有一个写入 schema，被字节级守护的产物只含可复现字段                          |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md            | ADR-0011 - 索引的两种缺失走同一条回退路径，且不得用默认值代替"未知"                               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md                         | ADR-0012 - 失败状态必须指出失败的是谁，且不得用单一计数合并不同成因                               |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0013-health-fields-name-what-they-compute.md                          | ADR-0013 - 观测字段必须与该字段真正计算的东西同名，\"存在\"与\"正在运行\"分开报告                 |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md                    | ADR-0014 - 读取失败不得渲染成具体值，页面预取的三项读取各自结算                                   |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0015-lag-is-null-when-there-is-no-index-to-be-behind.md               | ADR-0015 - `lagBlocks` 只在滞后量成立时给出数字                                                   |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0016-deploy-preflight-checks-usability-and-never-echoes-a-value.md    | ADR-0016 - 部署前检查的是"可用"而不只是"存在"，且绝不回显值                                       |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0017-the-consistency-check-compares-one-instant.md                    | ADR-0017 - 一致性检查必须比较同一个瞬间（封存快照、单一高度、不缓存的高度）                       |
| 2026-09-20 | adr      | docs/aegis/adr/ADR-0018-cache-and-retry-are-decided-per-result.md                        | ADR-0018 - 缓存与重试按结果区分，而不是按查询区分（本地结论 vs 网络结论）                         |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0019-the-browser-reads-the-chain-the-deployment-is-configured-for.md  | ADR-0019 - 浏览器端的链身份来自部署配置，而不是钱包的默认链                                       |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0020-failure-reports-give-the-shape-never-the-environment.md          | ADR-0020 - 失败报告只给形状，不回显配置；原始错误只写服务端日志                                   |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0021-a-cid-is-computed-from-the-document-it-names.md                  | ADR-0021 - CID 必须由它所命名的那份字节算出，绝不手写                                             |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0022-a-wallet-refusal-is-a-sentence-not-a-stack-trace.md              | ADR-0022 - 钱包的拒绝必须说成一句中文，且必须以"链上有没有变化"收尾                               |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0023-one-poll-per-contract-through-a-factory.md                       | ADR-0023 - 一人一票的约束必须留在链上：工厂 + 每投票一份合约，取代规格非目标 3                    |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0024-a-vote-change-is-its-own-event.md                                | ADR-0024 - 改投与撤票各自独立成事件，当前票只能由事件流推导                                       |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0025-admission-mode-is-fixed-at-initialize.md                         | ADR-0025 - 准入方式在 initialize 固定；canVote 与 whitelisted 必须是两个事实                      |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0026-every-exported-write-needs-a-caller-or-a-reason.md               | ADR-0026 - 每个已导出的写函数都必须有调用点，或一条刻意不调用的理由                               |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0027-eligibility-rules-live-in-pure-functions.md                      | ADR-0027 - 决定"能不能点"的规则住在纯函数里，组件只负责组装输入                                   |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0028-state-to-appearance-has-one-owner.md                             | ADR-0028 - 链上状态到观感的映射只有一个所有者；"已过截止但未关闭"必须与"已结束"区分               |
| 2026-09-21 | plan     | docs/aegis/plans/2026-09-21-frontend-and-trust-rework.md                                 | 计划：前端重设计、现实投票机制、结果可被第三方验证                                                |
| 2026-09-21 | adr      | docs/aegis/adr/ADR-0029-rules-commitment-makes-edits-visible.md                          | ADR-0029 - 规则承诺：创建时写入指纹，任何人可重算比对，使"规则有没有被改"可验证                   |
| 2026-09-21 | baseline | docs/aegis/baseline/2026-09-21-frontend-trust-rework.md                                  | 基线记录：三批改造（视觉重设计 / 现实投票机制 / 规则承诺）及其验证证据                            |
| 2026-09-21 | plan     | docs/aegis/plans/2026-09-21-multi-tenant-voting-platform.md                              | 实施计划：从"一次性公投"改造为"用户自建投票平台"                                                  |
| 2026-09-21 | baseline | docs/aegis/baseline/2026-09-21-optimization-pass.md                                      | 基线记录：功能补齐与代码改进审计；7 个写函数零调用点的 Implementation Drift                       |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0030-voting-mechanisms-are-configurable-at-creation.md                | ADR-0030 - 投票机制在 initialize 时固定，组合合法性由纯函数 owner 判定                            |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0031-commit-reveal-replaces-public-ballots.md                         | ADR-0031 - 以 commit-reveal 取代"明票上链"（取代 ADR-0003）                                       |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0034-one-vote-one-person-is-redefined-per-mechanism.md                | ADR-0034 - "一人一票"重述为"每个合格主体的票权至多计一次"                                         |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0035-delegation-is-single-level-and-revocable.md                      | ADR-0035 - 委托是单层的、可撤回的、且不改变票权归属                                               |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0032-results-only-count-when-they-have-consequences.md                | ADR-0032 - 投票结果只有在链上有后果时才算结果（quorum/时间锁/受限执行）                           |
| 2026-09-22 | plan     | docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md                      | 实施计划：投票机制深化与平台能力补齐（多选/加权/委托/隐私 + 治理 + 数据接口 + 前端体验）          |
| 2026-09-22 | work     | docs/aegis/work/2026-09-22-close-known-gaps/10-intent.md                                 | 关闭已登记的未完成项（P0/P1/P2） intent                                                           |
| 2026-09-22 | work     | docs/aegis/work/2026-09-22-close-known-gaps/20-checkpoint.md                             | 关闭已登记的未完成项（P0/P1/P2） checkpoint                                                       |
| 2026-09-22 | work     | docs/aegis/work/2026-09-22-close-known-gaps/90-evidence.md                               | 关闭已登记的未完成项（P0/P1/P2） evidence                                                         |
| 2026-09-22 | work     | docs/aegis/work/2026-09-22-close-known-gaps/99-reflection.md                             | 关闭已登记的未完成项（P0/P1/P2） reflection                                                       |
| 2026-09-22 | artifact | docs/aegis/work/2026-09-22-close-known-gaps/task-intent-draft.json                       | 关闭已登记的未完成项（P0/P1/P2） task intent draft                                                |
| 2026-09-22 | artifact | docs/aegis/work/2026-09-22-close-known-gaps/baseline-read-set-hint.json                  | 关闭已登记的未完成项（P0/P1/P2） baseline read-set hint                                           |
| 2026-09-22 | artifact | docs/aegis/work/2026-09-22-close-known-gaps/baseline-usage-draft.json                    | 关闭已登记的未完成项（P0/P1/P2） baseline usage draft                                             |
| 2026-09-22 | artifact | docs/aegis/work/2026-09-22-close-known-gaps/impact-statement-draft.json                  | 关闭已登记的未完成项（P0/P1/P2） impact statement draft                                           |
| 2026-09-22 | artifact | docs/aegis/work/2026-09-22-close-known-gaps/todo-checkpoint-draft.json                   | 关闭已登记的未完成项（P0/P1/P2） todo checkpoint draft                                            |
| 2026-09-22 | artifact | docs/aegis/work/2026-09-22-close-known-gaps/drift-check-draft.json                       | 关闭已登记的未完成项（P0/P1/P2） drift check draft                                                |
| 2026-09-22 | artifact | docs/aegis/work/2026-09-22-close-known-gaps/resume-state-hint.json                       | 2026-09-22-close-known-gaps resume state hint                                                     |
| 2026-09-22 | spec     | docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md            | 容器化、CI/CD 与可观测性设计规格                                                                  |
| 2026-09-22 | plan     | docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md                   | 实施计划：容器化、CI/CD 与可观测性                                                                |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0045-one-image-carries-three-process-roles.md                         | ADR-0045 - 一个镜像承载 web / migrate / indexer 三个角色，角色差异只由 compose 的 command 表达    |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0046-images-are-rebuilt-per-environment.md                            | ADR-0046 - 镜像按环境重建（NEXT_PUBLIC_* 在构建期内联），tag 用 git sha；不做运行时注入           |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0047-observability-never-sits-in-the-startup-path.md                  | ADR-0047 - 监控栈用 compose profile 隔离，不参与应用启动路径                                      |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0048-unreadable-lag-is-absent-not-zero.md                             | ADR-0048 - 新暴露面（/api/metrics 的契约）与告警层沿用 ADR-0015：不可读的滞后量是 absent 而不是 0 |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0049-migrations-are-expand-contract-and-rollback-excludes-schema.md   | ADR-0049 - schema 迁移采用 expand-contract，回滚不含 schema                                       |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0050-deployments-pin-an-immutable-tag.md                              | ADR-0050 - 部署只用不可变 tag（sha-<12hex>），禁用 latest                                         |
| 2026-09-22 | adr      | docs/aegis/adr/ADR-0051-deployment-logic-lives-in-repo-scripts.md                        | ADR-0051 - 部署逻辑入库为 ops/deploy/*.sh 脚本，而不是内联进 GitHub Actions YAML                  |
| 2026-09-22 | baseline | docs/aegis/baseline/2026-09-22-containerization-and-delivery.md                          | Third-stage effect baseline: containerization, CI/CD and observability                            |
| 2026-09-22 | work     | docs/aegis/work/2026-09-22-delivery-evidence/90-evidence.md                              | Third-stage delivery evidence index (screenshots and command output)                              |
