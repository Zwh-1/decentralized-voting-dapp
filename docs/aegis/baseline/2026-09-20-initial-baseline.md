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

| 日期       | 取代上文                                     | 原陈述                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 取代为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-20 | §2、§5.1、§6（第 98-101 行）                 | 四层结构：`contracts/` + `indexer/` + `packages/shared/` + `web/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 两层结构：`contracts/` + `web/`。索引器并入 `web/src/lib/indexer/`，ABI 生成到 `web/src/lib/contracts/`，`packages/shared` 与独立 `indexer/` 包已删除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-20 | §5.1（第 76 行）                             | 合约工具链 TypeScript `5.9.3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | TypeScript `6.0.3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-09-20 | §5.1（第 77 行）                             | 链下工具链：Express 5.2.1、zod 4.6.5、pino 10.3.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Next.js 16.3.5 的 Route Handlers；mysql2 3.24.4 与 viem 2.56.8 保留；Express、zod、pino 与 express-rate-limit 均已移除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-09-20 | §5.1（第 78 行）、§6（第 101 行）            | 前端工具链：Vite 8.3.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Next.js 16.3.5（React 19.3.0、wagmi 3.7.7、viem 2.56.8、TailwindCSS 4.3.3 保留）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-09-20 | §5.2 第 1 条、§9 末条                        | MySQL 是必需依赖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | MySQL 是**可选**依赖：无 `DATABASE_URL` 时全部读取回退为直接读链，`/api/results` 报告 `status: "unavailable"`，但删库重建与非必需性不变量不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-09-20 | §6.3（第 322、328 行）                       | `/api/results` 返回 `consistent: boolean` 与 `mode`；无数据库时仍断言 `consistent: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 改为四值 `status`（`consistent` / `divergent` / `lagging` / `unavailable`）；判定前先把未索引区间 `(cursor, head]` 内的 `VoteCast` 加回索引一侧再比较；只有 `divergent` 返回 HTTP 500 与退出码 1；`unavailable` 不再断言任何一致性。见 ADR-0008                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-09-20 | §3（第 30 行）、§6（第 96-101 行）           | ADR 不存在；所有者为"尚未创建"的空壳                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §12 的 ADR 信号已落地为 9 条 accepted ADR（`docs/aegis/adr/ADR-0001` … `ADR-0009`）；§6 的每个所有者面均已存在并指向具体文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-09-20 | §6.2（第 292-315 行）                        | 游标为空时从区块 0 开始扫描                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 默认从**合约部署区块**开始：`deploy.ts` 把 `blockNumber` 记入 `contracts/deployments/<chainId>.json`，`export-abi` 带入前端注册表，`config.ts` 在没有 `START_BLOCK` 时取它。公共 RPC 裁剪历史，从 0 扫描会在 2000 个区块后永久卡死。见规格校正 10                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-09-20 | §4.3 M-3（前端）                             | 只做类型检查、生产构建、SSR 与 API 实测，未做浏览器端交互验证，投票按钮的可用性只检查阶段/连接/是否已投票                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 补上浏览器端演练 `pnpm ui:drill`，覆盖**投票**与**取回押金**两条写入路径：以链上 `isWhitelisted`/`stakeOf` 推导按钮可用性并给出理由，"进行态"改用 `receipt.isLoading`（`isPending` 对被禁用的查询恒为真，曾使按钮永远不可点）。见 ADR-0009 与规格校正 11                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-09-20 | §4.3 M-6（一致性）                           | "偏差 0/200"只在本机手动流程中验证过，CI 里没有任何步骤触碰链或索引器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 新增 `indexer-e2e` 作业：起本地链、`seed:local`、建表、drain、比对一致性，并强制游标归零重放验证幂等（M-6b），以 `CONFIRMATIONS=0` 运行。同时把 `web` 作业误导性的注释改为准确边界。见 ADR-0010 与规格校正 12                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-09-20 | §14 校正 10（部署记录）                      | `blockNumber` 只由 `deploy.ts` 写入；`seed-local.ts` 写同一文件却不写该字段，地址大小写也与提交版本不同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 两个写入方统一 schema 与地址大小写（小写）；`seed-local.ts` 改用 `sendDeploymentTransaction` 取得创建区块。此前按 README 只跑 `seed:local` 会静默抹掉 `blockNumber`，使索引回退到区块 0。见 ADR-0010 与规格校正 12                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-09-20 | §4.3 M-0（abi-drift）                        | 被字节级 diff 守护的生成产物里含不可复现字段 `deployedAt`（无任何消费方），本地播种后必然产生无语义漂移                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `export-abi` 不再发布该字段（JSON 记录中保留作溯源）。守护的有效性现在等价于"产物与提交一致"，验证方式为哈希不变。见 ADR-0010 与规格校正 12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-09-20 | §15（测试计数）                              | 文档四处称索引器 41 个单测                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 实为 **57**（41 是 Solidity 数量）。逐文件：plan 18 / decode 9 / sync 9 / report 10 / client-api 7 / config 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-09-20 | §4.3 M-6 与 §14 校正 13（索引可选）          | API 实测此前只覆盖 `/api/results` 与 `/api/health`；"索引可选"这一承诺只在"未设置 `DATABASE_URL`"一种状态下验证过，而 `data.ts` 只以 `pool === null` 作判据，因此"配置了但读不到"会走到完全不同的分支                                                                                                                                                                                                                                                                                                                                                                                                                            | 逐个实测全部 5 条路由 × 三种索引状态（正常／不可达／未配置）。修正：索引读失败与未配置归入同一条链回退路径，`/api/health` 新增 `indexError` 使故障仍可见，`getVoter` 不再以 `hasVoted: false` 兜底链读失败，`whitelisted` 两种模式下均由链回答；删除死代码 `requirePool`/`getPhase`。新增 `web/test/data.test.ts` 9 例，索引器单测 57 → 66，总数 106 → 115。见 ADR-0011 与规格校正 13                                                                                                                                                                                                                                                                   |
| 2026-09-20 | §4.3 M-3 与 §14 校正 14（IPFS 元数据）       | `web/src/lib/ipfs.ts` 没有任何测试文件；播种 CID 被 `isPlausibleCid` 在发请求前判为非法，因此网关回退、超时、`unreachable` 三条路径从未执行过。`isPlausibleCid` 只认 `bafy` 前缀，会把 `bafk…`（raw codec）这类合法 CIDv1 误报为"CID 格式无效"                                                                                                                                                                                                                                                                                                                                                                                   | 放宽为 `/^b[a-z2-7]{58}$/`。写探针调用真实模块访问真实网关：真实 CID 实测 `dweb.link`/`ipfs.io` HTTP 000、`pinata` HTTP 200，证明回退必要；同时暴露 pinata 已作答 200 却被报成"3 个网关均不可达"，新增 `no-metadata` 状态与 `answered` 计数把"没联系上"与"联系上了但内容不可用"分开，UI 相应分两句。新增 `web/test/ipfs.test.ts` 15 例。索引器单测 66 → 81，总数 115 → 130。**边界：`ok` 分支仍只有 stub 覆盖，仓库内无任何真实 CID 指向真实候选人元数据**                                                                                                                                                                                              |
| 2026-09-20 | §4.3 M-7 与 §14 校正 15（健康字段）          | `/api/health` 的 `indexEnabled` 实际计算的是 `databaseUrl !== null`（是否存在索引），却按"索引已启用"命名；真正控制后台循环的 `INDEXER_ENABLED` 在响应里没有任何字段，于是"高度会不会自行前进"无从得知。实测：以 `INDEXER_ENABLED=false` 启动仍返回 `indexEnabled: true`，差点据此误判库被写入                                                                                                                                                                                                                                                                                                                                   | 字段改名 `indexConfigured`，新增 `indexerLoopEnabled`，两者分开报告；UI 在循环关闭时明确提示高度不会自行前进及如何手动同步。两种配置均实测（`false`/`false` 与 `true`/`true`），新增 1 个用例钉住二者的区分。索引器单测 81 → 83，总数 130 → 132（无索引态最初误报 `indexerLoopEnabled: true`，据此把该字段收紧为有效状态）。另按实测更正演练断言计数 7/11/17 → 12/16/18，并新增一条"每张卡片以已知措辞说明元数据状态"的断言。见 ADR-0013                                                                                                                                                                                                                |
| 2026-09-20 | §4.3 M-6e 与 §14 校正 16（链不可达时的首屏） | 把 `RPC_URL` 指向死端口后在浏览器打开页面，服务端首屏报出四个未经证实的具体值：`数据来源 链上直读`（其实什么都没读到）、`票数合计 0` 与 `候选人（0）`（其实未知）、`索引高度 未启用`（索引其实可读）。更严重的是 `stakeOf` 读取**失败**时 `myStake` 落到 `0n`，退款按钮用"没有可取回的押金。"这一关于用户资金的确定结论解释自己的禁用——而 `sweepUnclaimed()` 会在 30 天宽限期后把未领回的押金交给 owner。另：`page.tsx` 的 `Promise.all` 在 `getResults()` 失败时把 `getTally()`/`getHealth()` 两个**成功**结果一并丢弃，首屏退化成占位符。另：`CHUNK_BLOCKS` 默认 2000 大于 406 块的链，`drain.ts` 的分块循环在 CI 中从未迭代   | 抽出 `readStatus()`（三态，先判 `hasData`，因为读到 0 是真实答案）与 `tallyLabels()` 并单测 9 例；失败与未知一律渲染 `—`，"读取中"与"读取失败"分开；禁用理由与禁用原因一致。`page.tsx` 改用 `Promise.allSettled` 保留成功项并按项归因，横幅改为"服务端有读取失败（下面能读到的数据仍会显示）"。CI 的 `indexer-e2e` 把 `CHUNK_BLOCKS` 设为 7，使分块边界被真实穿过。实测 `CHUNK_BLOCKS` = 1 / 7 / 2000 三种取值下投影逐位一致（1 时为 406 轮、插入 404、重复 0），正常态首屏无变化（`MySQL 索引`/`200`/`406 / 链头 406`/`落后区块 0`）。索引器单测 83 → 92，总数 132 → 141。见 ADR-0014                                                                  |
| 2026-09-20 | §4.3 M-6c 与 §14 校正 17（演练假失败）       | 收尾复测跑 `pnpm indexer:reorg-drill` 得到自相矛盾的输出：交易 `"status": "success"` 但 `"rewound": false`，外加 `"the indexer never reported a rewind after the head moved backwards"`，退出码 1——而该脚本此前多次通过。定位为竞态：应用的后台索引循环（两秒轮询）在演练读到 `cursorBeforeRepair: 407` 之后、演练自己 `drainToIdle()` 之前把重组修好了，演练于是观察不到 `rewound`。停止应用后立刻恢复 `rewound: true`、`rewoundTo: 406`、`discardedFrom: 407`，确认不是回归。脚本与 README 都写了"先停掉应用"，但**忘记停时的失败模式没有被识别**，报错把原因归给了索引器，会把读者引向 `planReorgRewind` 找一个并不存在的 bug | 在 `drainToIdle()` 前后各读一次游标，覆盖竞态的两个落点，识别"别的索引器抢先修复"并单独报出，明确写出该结论不代表回退路径有问题。实测：应用运行时连续三次给出新诊断，停掉应用后演练通过且新检查无误报。README 补上"忘记停会怎样"。见 Spec §14 校正 17                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-20 | §4.3 M-6a 与 §14 校正 18（`lagBlocks` 语义） | 把"无索引"这一受支持配置真正渲染出来（此前只在 API 层量过）：未设 `DATABASE_URL` 时 `/api/health` 返回 `indexConfigured: false`、`lastIndexedBlock: null`、`chainHead: "406"`，而 **`lagBlocks: "402"`**，页面在 `索引高度 未启用` 旁显示 **`落后区块 402`**；数据库指向死端口时同样报 `"402"`，尽管游标**读取失败**、滞后量根本未知。根因是 `plan.ts` 把 `null` 游标当作 `-1n` 返回 `safeHead + 1`——该值对"什么都没索引"是正确的，缺陷在于问了一个不适用于**无索引部署**的问题；在真实链上这个数字会达数百万块，表现为"索引只是有点慢"而非"读不出来"                                                                            | `getHealth()` 单独记录"游标读到了没有"（`cursorKnown`，仅 `readCursor()` 成功才置真），不从 `lastIndexedBlock` 的值反推；`lagBlocks` 在链读不到 / 无索引 / 游标读不出三种情形上报 `null`，纯函数语义不变。四种状态全部实测：已同步 `"0"`、**已建表未同步 `"407"`（真实数值必须保留）**、无索引 `null`、库不可达 `null`、链不可达 `null`。`lagBlocks` 不参与 `/api/results` 判定，故不影响任何判定。新增 3 例单测，索引器单测 92 → 95，总数 141 → 144。见 ADR-0015                                                                                                                                                                                       |
| 2026-09-20 | §4.3 M-4 与 §14 校正 19（部署前预检）        | 拿到真实的 `contracts/.env` 后跑 `deploy:local`：退出码 1，输出 `InvalidAddressError: Address "0x7077…" is invalid.`，**该值被原样打进终端**，堆栈指向 viem 的 `encodeAddress`，而报错全文**没有出现 `VOTING_OWNER`**——它那 66 字符的内容是私钥的形状而不是地址的形状。`VOTING_OWNER` 从未被任何检查覆盖：`deploy:local` 提前返回什么都不查，`deploy:sepolia` 只数两个必需变量在不在，`deploy.ts` 把它直接断言为地址类型后交给构造函数。于是"填了但不能用"（手编 `.env` 最常到达的状态）在两个网络路径上都逃过检查，并让一次"贴错字段"的失误升级为一次泄露                                                                       | 抽出 `contracts/scripts/preflight.ts`，导出纯函数 `configurationProblems(networkName, env)` 使其可单测；检查**可用**而非**存在**（RPC 须为 http(s) URL、私钥须为 `0x`+64 位十六进制、`VOTING_OWNER` 须为 `0x`+40 位十六进制）；报告**只给形状不给值**；凭证按网络把关而部署输入在任何网络都校验（我最初把 `VOTING_OWNER` 一起挂在"是否本地"上，`deploy:local` 依旧泄露，由真实路径暴露）；keystore 提示只给秘密。实测：`deploy:sepolia` 同时指名两个问题且不含该值，`deploy:local` 在到达 viem 之前拒绝，`VOTING_OWNER` 未设置时正常部署（`0xccf176…`、区块 407，随后还原链与记录）。合约 nodejs 单测 8 → 23，合约 49 → 64，总数 144 → 159。见 ADR-0016 |

**未受影响的 Non-negotiables**：§4.2 全部 4 条、§5.2 全部 5 条（链上唯一事实源、后端不持私钥、幂等消费、一人一票、事件与游标同事务）在重构后**逐条重新验证通过**（见 Spec §15 的 M-1 … M-6b）。

**指标编号变化**：新增 M-7（Next.js 生产构建）。M-6b（索引幂等性）在实施中被补充定义并实测。

**权威面状态更新**（取代 §3）：

| 面                    | 状态                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| Design Spec           | 已存在，已按实施校正（§14）与重构记录（§16）更新                                    |
| ADR                   | 已存在：10 条 accepted ADR（`docs/aegis/adr/`），经 `aegis-workspace.py check` 通过 |
| 代码与测试            | 已存在：159 个测试全部通过                                                          |
| README（面向 GitHub） | 已存在                                                                              |
| CI                    | 已存在：5 条流水线（contracts / abi-drift / web / indexer-e2e / format）            |

**权威缺口已收口**：ADR 目录已创建，§12 登记的 ADR 信号已全部落地为 accepted 决策，编号与主题对应如下。此前记录的"已由代码固化但未写成 ADR"的基线漂移随之关闭。

| Spec §12 信号             | 对应 ADR                                                                    |
| ------------------------- | --------------------------------------------------------------------------- |
| ADR-1 链上唯一事实源      | `ADR-0001-chain-is-the-only-source-of-truth.md`                             |
| ADR-2 Hardhat 3 而非 2    | `ADR-0002-hardhat-3-over-hardhat-2.md`                                      |
| ADR-3 明票上链            | `ADR-0003-public-ballots-no-vote-privacy.md`                                |
| ADR-4 IPFS 仅存元数据     | `ADR-0004-ipfs-for-metadata-only.md`                                        |
| ADR-5 质押构造重入面      | `ADR-0005-stake-creates-a-real-reentrancy-surface.md`                       |
| —（重构新增）             | `ADR-0006-two-layers-and-optional-mysql.md`                                 |
| —（M-4 方法新增）         | `ADR-0007-property-tests-instead-of-the-invariant-runner.md`                |
| —（M-6 判定新增）         | `ADR-0008-reconcile-unindexed-range-before-verdict.md`                      |
| —（M-3 前端新增）         | `ADR-0009-ui-eligibility-from-chain-not-query-status.md`                    |
| —（M-6 覆盖与产物新增）   | `ADR-0010-one-record-one-schema-no-volatile-fields-in-guarded-artifacts.md` |
| —（M-6 索引可选新增）     | `ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md`            |
| —（M-3 IPFS 失败态新增）  | `ADR-0012-failure-states-name-the-failing-party.md`                         |
| —（M-7 健康字段新增）     | `ADR-0013-health-fields-name-what-they-compute.md`                          |
| —（M-6e 故障态新增）      | `ADR-0014-three-state-reads-and-independent-prefetch.md`                    |
| —（M-6a 滞后量语义新增）  | `ADR-0015-lag-is-null-when-there-is-no-index-to-be-behind.md`               |
| —（M-4 部署输入校验新增） | `ADR-0016-deploy-preflight-checks-usability-and-never-echoes-a-value.md`    |

注意 Spec §12 原表把"两层结构"记为 ADR-2 的主题之一，实际落地时它独立为 `ADR-0006`，而 `ADR-0002` 保持为"Hardhat 3 vs Hardhat 2"。上表为准。
