# decentralized-voting-dapp 初始基线

日期：`2026-09-20`
状态：`initial dual-baseline snapshot`

## 1. 用途

本基线在项目尚无任何代码时建立，用于：

- 固化本会话已获用户确认的 6 项产品与架构决策（D1-D6），使后续实现可做 `Baseline Role Alignment` 检查；
- 记录不变量与兼容边界，供 M1-M4 每个里程碑结束时比对；
- 明确标注**尚不存在的权威面**，避免把"计划中的东西"当作"已存在的事实"。

## 2. 工作区结构

```text
decentralized-voting-dapp/
├─ docs/aegis/         本工作区（README.md / INDEX.md / BASELINE-GOVERNANCE.md / specs/ / baseline/）
└─ (其余目录尚未创建：contracts/ indexer/ web/ packages/shared/ .github/)
```

当前唯一的权威文档是 `docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md`。

## 3. 当前权威面

| 面                    | 状态                                                     |
| --------------------- | -------------------------------------------------------- |
| Design Spec           | 已存在（待用户评审）                                     |
| AGENTS.md / 贡献指南  | 不存在                                                   |
| ADR                   | 不存在（§12 仅登记了 5 条 ADR 信号，尚未创建已接受决策） |
| 代码与测试            | 不存在                                                   |
| README（面向 GitHub） | 不存在                                                   |
| CI                    | 不存在                                                   |

**权威缺口**：尚无 ADR 目录与 accepted 决策；尚无面向开源的 README。

## 4. Product / Requirement Baseline

### 4.1 Current Truth

- **需求来源**：用户提供的一份四周开发方案（对话粘贴）+ 本会话确认的 6 项决策。
- **目标状态**：一个可从零复现、可现场演示、每个技术主张都有测试证据的全栈 Web3 投票应用，开源至 GitHub。
- **角色与场景**：
  - 管理员：设置候选人、维护白名单、开启/结束投票、宽限期后清扫未领取质押；
  - 白名单选民：质押并投票，选举结束后退还质押；
  - 任意访客：查看候选人与实时结果。
- **确认的产品决策（D1-D6）**：
  | #   | 决策                                                                             |
  | --- | -------------------------------------------------------------------------------- |
  | D1  | 明票上链，README 显式声明不含投票隐私及其理由                                    |
  | D2  | MySQL 保留作事件索引与聚合；IPFS 仅存候选人元数据，链上存 CID                    |
  | D3  | 交付边界＝本地一条命令可复现 + Sepolia 真部署（含 Etherscan 验证）；不做公网托管 |
  | D4  | 合约工具链＝Hardhat 3 + TypeScript（明确拒绝 Foundry）                           |
  | D5  | 加投票质押 + 退还，构造真实外部调用面，并写攻击对照测试                          |
  | D6  | 后端＝只读事件索引器，永不持有私钥                                               |
- **验收与证据期望**：6 项指标 M-1 … M-6（见 Spec §8），全部可在本地一条命令复现。
- **已确认的成功证据**：覆盖率 ≥95%、重入攻击对照测试通过、索引一致性偏差 0 条、Sepolia 已验证合约、全新环境按 README 一条命令跑通。

### 4.2 Non-negotiables

1. 每个技术主张必须绑定可复现证据；不允许出现无法定义分子分母的指标（如"准确率 99%"）。
2. 删除空转设计面（无外部调用的守卫、只读 API 的 JWT）。
3. 不得把质押宣称为女巫防护——女巫防护来自管理员白名单。
4. 测试网与本地必须使用同一份合约源码与同一份 ABI。

### 4.3 Product Non-goals

投票隐私、Gas 代付/账户抽象、多轮次选举与委托投票、Token 门控、The Graph/subgraph、公网托管、移动端适配与国际化。

## 5. Architecture / Runtime Boundary Baseline

### 5.1 Current Truth

- **事实源边界**：链上合约为唯一事实源；MySQL 是可随时删除并重建的只读投影。
- **依赖方向**：`web/` → 链（写，经钱包）与 `indexer/` API（读）；`indexer/` → 链（只读 getLogs）与 MySQL；`packages/shared` 提供 ABI/地址/事件类型的单一来源。后端不反向影响链状态。
- **合约工具链**：Hardhat 3.17.0（ESM、`defineConfig`）、Solidity 0.8.37、OZ 5.6.1、TypeScript 5.9.3、Node ≥22.13.0。
- **链下工具链**：Express 5.2.1、mysql2 3.24.4、viem 2.56.8、zod 4.6.5、pino 10.3.1。
- **前端工具链**：Vite 8.3.0、React 19.3.0、wagmi 3.7.7、viem 2.56.8、TailwindCSS 4.3.3。

### 5.2 Architecture Non-negotiables

1. **链上是唯一事实源**；MySQL 必须可 `DROP` 后从事件完整重建。
2. **后端永不持有任何私钥**；链上写入只由用户钱包签名。
3. **事件消费幂等**：任何重复消费不得改变聚合结果。
4. **同一地址最多计票一次**。
5. 事件插入与游标推进必须同一事务提交。

### 5.3 Architecture Non-goals

不引入消息队列、不引入 Redis、不做多链支持、不做合约可升级代理（immutable 部署）、不做后端写入 API。

## 6. Ownership / Contract Snapshot

| 面                    | 当前所有者                       | 状态                |
| --------------------- | -------------------------------- | ------------------- |
| 投票权限与计票        | `contracts/contracts/Voting.sol` | 尚未创建（Spec §5） |
| 候选人元数据          | IPFS（CID 上链）                 | 服务待 M0 实测选择  |
| 事件索引与聚合        | `indexer/`（MySQL）              | 尚未创建（Spec §6） |
| 只读查询接口          | `indexer/` REST API              | 尚未创建            |
| ABI / 地址 / 事件类型 | `packages/shared`                | 尚未创建            |
| 用户交互与交易状态    | `web/`                           | 尚未创建            |

**边界缺口**：`sweepUnclaimed()` 是计划中的额外中心化权限点，需在 README 的「已知中心化风险」中暴露（Spec §5.6）。

## 7. 当前状态与风险

- **当前阶段**：设计已完成并写入 Spec，等待用户评审；尚无任何代码。
- **主要风险**：Hardhat 3 是完全重写版（插件生态与既有教程不匹配）；Sepolia faucet 领币可能排队；IPFS 网关实测限流 429 且 Storacha TLS 不通；4 周排期偏紧。
- **缺失证据**：所有 M-1 … M-6 指标均尚无测量结果。

## 8. 对齐用途

- 读 **Product / Requirement Baseline**：当需要判断某项工作是否仍服务于已确认的产品决策（D1-D6）或已滑入非目标时。
- 读 **Architecture / Runtime Boundary Baseline**：当改动触及事实源边界、依赖方向、幂等性、隐私或权限时。
- 报告 `scope: both`：当改动同时改变产品行为与架构边界时（例如未来若要引入投票隐私，将同时改变 D1 与事实源边界）。

## 9. 兼容边界

- 在 M1 完成前，不允许任何代码假定 ABI 已固定；ABI 的单一来源是 `packages/shared`。
- 不允许为本地演示在合约中留后门分支（例如仅在本地生效的白名单绕过）。
- 不随意升级固定版本；升级任一固定版本需重新验证 M-1 … M-6。

---

## 10. 基线修订（superseding amendments）

本节由实施过程追加。**上文正文保持原样**，因为它是"无代码时"的时间点快照，改写它会让基线失去作为历史记录的价值；下表逐条取代受影响的陈述。

| 日期       | 取代上文                           | 原陈述                                                                                   | 取代为                                                                                                                                                                                                                                            |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-20 | §2、§5.1、§6（第 98-101 行）       | 四层结构：`contracts/` + `indexer/` + `packages/shared/` + `web/`                        | 两层结构：`contracts/` + `web/`。索引器并入 `web/src/lib/indexer/`，ABI 生成到 `web/src/lib/contracts/`，`packages/shared` 与独立 `indexer/` 包已删除                                                                                             |
| 2026-09-20 | §5.1（第 76 行）                   | 合约工具链 TypeScript `5.9.3`                                                            | TypeScript `6.0.3`                                                                                                                                                                                                                                |
| 2026-09-20 | §5.1（第 77 行）                   | 链下工具链：Express 5.2.1、zod 4.6.5、pino 10.3.1                                        | Next.js 16.3.5 的 Route Handlers；mysql2 3.24.4 与 viem 2.56.8 保留；Express、zod、pino 与 express-rate-limit 均已移除                                                                                                                            |
| 2026-09-20 | §5.1（第 78 行）、§6（第 101 行）  | 前端工具链：Vite 8.3.0                                                                   | Next.js 16.3.5（React 19.3.0、wagmi 3.7.7、viem 2.56.8、TailwindCSS 4.3.3 保留）                                                                                                                                                                  |
| 2026-09-20 | §5.2 第 1 条、§9 末条              | MySQL 是必需依赖                                                                         | MySQL 是**可选**依赖：无 `DATABASE_URL` 时全部读取回退为直接读链，`/api/results` 报告 `status: "unavailable"`，但删库重建与非必需性不变量不变                                                                                                     |
| 2026-09-20 | §6.3（第 322、328 行）             | `/api/results` 返回 `consistent: boolean` 与 `mode`；无数据库时仍断言 `consistent: true` | 改为四值 `status`（`consistent` / `divergent` / `lagging` / `unavailable`）；判定前先把未索引区间 `(cursor, head]` 内的 `VoteCast` 加回索引一侧再比较；只有 `divergent` 返回 HTTP 500 与退出码 1；`unavailable` 不再断言任何一致性。见 ADR-0008   |
| 2026-09-20 | §3（第 30 行）、§6（第 96-101 行） | ADR 不存在；所有者为"尚未创建"的空壳                                                     | §12 的 ADR 信号已落地为 8 条 accepted ADR（`docs/aegis/adr/ADR-0001` … `ADR-0008`）；§6 的每个所有者面均已存在并指向具体文件                                                                                                                      |
| 2026-09-20 | §6.2（第 292-315 行）              | 游标为空时从区块 0 开始扫描                                                              | 默认从**合约部署区块**开始：`deploy.ts` 把 `blockNumber` 记入 `contracts/deployments/<chainId>.json`，`export-abi` 带入前端注册表，`config.ts` 在没有 `START_BLOCK` 时取它。公共 RPC 裁剪历史，从 0 扫描会在 2000 个区块后永久卡死。见规格校正 10 |

**未受影响的 Non-negotiables**：§4.2 全部 4 条、§5.2 全部 5 条（链上唯一事实源、后端不持私钥、幂等消费、一人一票、事件与游标同事务）在重构后**逐条重新验证通过**（见 Spec §15 的 M-1 … M-6b）。

**指标编号变化**：新增 M-7（Next.js 生产构建）。M-6b（索引幂等性）在实施中被补充定义并实测。

**权威面状态更新**（取代 §3）：

| 面                    | 状态                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| Design Spec           | 已存在，已按实施校正（§14）与重构记录（§16）更新                                   |
| ADR                   | 已存在：8 条 accepted ADR（`docs/aegis/adr/`），经 `aegis-workspace.py check` 通过 |
| 代码与测试            | 已存在：106 个测试全部通过                                                         |
| README（面向 GitHub） | 已存在                                                                             |
| CI                    | 已存在：4 条流水线（contracts / abi-drift / web / format）                         |

**权威缺口已收口**：ADR 目录已创建，§12 登记的 ADR 信号已全部落地为 accepted 决策，编号与主题对应如下。此前记录的"已由代码固化但未写成 ADR"的基线漂移随之关闭。

| Spec §12 信号          | 对应 ADR                                                     |
| ---------------------- | ------------------------------------------------------------ |
| ADR-1 链上唯一事实源   | `ADR-0001-chain-is-the-only-source-of-truth.md`              |
| ADR-2 Hardhat 3 而非 2 | `ADR-0002-hardhat-3-over-hardhat-2.md`                       |
| ADR-3 明票上链         | `ADR-0003-public-ballots-no-vote-privacy.md`                 |
| ADR-4 IPFS 仅存元数据  | `ADR-0004-ipfs-for-metadata-only.md`                         |
| ADR-5 质押构造重入面   | `ADR-0005-stake-creates-a-real-reentrancy-surface.md`        |
| —（重构新增）          | `ADR-0006-two-layers-and-optional-mysql.md`                  |
| —（M-4 方法新增）      | `ADR-0007-property-tests-instead-of-the-invariant-runner.md` |
| —（M-6 判定新增）      | `ADR-0008-reconcile-unindexed-range-before-verdict.md`       |

注意 Spec §12 原表把"两层结构"记为 ADR-2 的主题之一，实际落地时它独立为 `ADR-0006`，而 `ADR-0002` 保持为"Hardhat 3 vs Hardhat 2"。上表为准。
