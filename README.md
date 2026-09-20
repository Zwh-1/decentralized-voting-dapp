# 去中心化投票 DApp

一个**两层**的链上投票应用：

- **合约层**（`contracts/`）——Hardhat 3 + Solidity 0.8.37 + OpenZeppelin 5.6.1。白名单准入、一人一票、押金托管与退回、阶段状态机；候选人文字信息只存 IPFS，链上只保存 CID。
- **Next.js 层**（`web/`）——同一进程里既有面向浏览器的投票界面，也有一个**只读事件索引器**：它把合约事件投影到 MySQL，并通过 Route Handler 暴露 REST 接口。页面同时展示链上与索引两侧的票数并**实时比对二者是否一致**。

> 这是一个**教学与作品集项目**，不是生产级投票系统。它的重点不在于"能投票"，而在于把链上状态、链下投影、前端展示之间的**一致性**做成可测量、可证伪的东西。请先读[设计取舍与已知局限](#设计取舍与已知局限)。

---

## 目录

- [架构](#架构)
- [实测指标](#实测指标)
- [快速开始](#快速开始)
- [验证与复现](#验证与复现)
- [设计取舍与已知局限](#设计取舍与已知局限)
- [安全说明](#安全说明)
- [仓库结构](#仓库结构)

---

## 架构

```mermaid
flowchart LR
    subgraph chain["链上（唯一真相来源）"]
        V["Voting.sol<br/>白名单 · 一人一票 · 0.001 ETH 押金"]
    end

    subgraph ipfs["IPFS"]
        M["候选人元数据 JSON"]
    end

    subgraph app["Next.js 层（单个进程，可随时丢弃重建）"]
        direction TB
        I["只读索引器<br/>游标 + 确认数 + 重组修复<br/>（instrumentation 后台循环 / POST 触发）"]
        DB[("MySQL（可选）<br/>UNIQUE(tx_hash, log_index)")]
        API["Route Handlers<br/>只有 GET，只有 SELECT"]
        UI["投票界面<br/>wagmi + 双侧比对徽章"]
        I -- "一个事务内<br/>写事件 + 推进游标" --> DB
        DB --> API
        API --> UI
    end

    V -- "CandidateAdded / VoteCast<br/>Refunded / PhaseChanged" --> I
    V -- "直接读链<br/>权威票数 / 我的状态" --> UI
    UI -- "vote() / refund()" --> V
    UI -- "读取 CID" --> M
    V -. "链上只保存 CID" .-> M
```

两层职责：

| 层         | 负责                                                        | 不负责                                 |
| ---------- | ----------------------------------------------------------- | -------------------------------------- |
| 合约层     | 白名单准入、一人一票、押金托管与退回、阶段状态机            | 候选人文字信息（只在链上存 CID）       |
| Next.js 层 | 展示双侧数据与一致性、发起投票/退款；只读投影链上事件为缓存 | 持有私钥、发起任何写操作、成为真相来源 |

两条关键设计线：

1. **MySQL 里的一切都能从链上事件重放重建。** 删库不会丢任何信息，这使索引器的正确性可以被独立验证，而不是被信任。
2. **索引是可选依赖。** 不设 `DATABASE_URL` 时，应用照常工作：所有读取回退为直接读链，`/api/results` 会如实报告 `mode: "chain-only"`，而不是给一个"没比对过却显示一致"的假结论。

---

## 实测指标

以下数字全部来自本仓库中可复现的命令，不是估计值。

| 编号 | 指标               | 实测结果                                                                                              | 复现命令                         |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| M-1  | 合约覆盖率         | `Voting.sol` 行 **100.00%**、语句 **100.00%**                                                         | `pnpm coverage`                  |
| M-2  | 越权与非法调用拦截 | 7 类路径全部 revert：非白名单、重复投票、阶段错误（4 种）、押金金额错误、未知候选人、零地址、非管理员 | `pnpm test:contracts`            |
| M-3  | 重入攻击防护       | 四组对照矩阵全部符合预期（见下）                                                                      | `pnpm test:contracts`            |
| M-4  | 长序列属性测试     | 1000 轮确定性随机投票 + 256 轮 fuzz，**0 反例**，且经变异测试证明可失败                               | `pnpm test:contracts`            |
| M-5  | Gas（中位数）      | `vote` **109,256**；`refund` **37,920**；部署 **1,249,757**；运行时代码 5,298 字节                    | `pnpm gas`                       |
| M-6  | 链上/索引一致性    | **200 / 200 票，0 处偏差**（3 名候选人逐一比对）                                                      | `pnpm indexer:check-consistency` |
| M-6b | 索引幂等性         | 游标回退到 0 强制重放：404 行**全部命中重复，插入 0 行**，票数仍为 200（未翻倍）                      | 见[验证与复现](#验证与复现)      |
| M-7  | Next.js 生产构建   | 构建成功，1 个页面 + 5 个动态 Route Handler 全部产出                                                  | `pnpm build:web`                 |
| —    | 测试总数           | **85 个**（合约 41 Solidity + 8 TypeScript，索引器 36）                                               | `pnpm test`                      |

### M-3：四组重入对照矩阵

单个 `nonReentrant` 修饰符无法证明"CEI 本身是否足够"，因为守卫会先于 CEI 生效、把 CEI 的贡献遮住。因此用四个变体各去掉一层，让每层防御都被单独观测：

| 变体               | CEI 检查-生效-交互 | 重入守卫 | 攻击结果                     | 说明了什么                 |
| ------------------ | ------------------ | -------- | ---------------------------- | -------------------------- |
| `VulnerableRefund` | ✗                  | ✗        | **攻击成功**，3 份押金被抽干 | 漏洞真实存在，攻击载荷有效 |
| `CEIOnlyRefund`    | ✓                  | ✗        | 攻击失败                     | **CEI 单独就足以防护**     |
| `GuardOnlyRefund`  | ✗                  | ✓        | 攻击失败                     | 守卫能独立生效             |
| `Voting`（生产）   | ✓                  | ✓        | 攻击失败，账目一致           | 纵深防御，两层都在         |

第一行是负向对照：如果脆弱变体没被攻破，说明攻击脚本根本没生效，后面三行的"防御成功"就没有意义。

### M-4：为什么不是 `invariant` 测试

Hardhat 3.17.0 的不变量运行器**会求值** `invariant_*` 函数，但**不会调用任何目标合约函数**。因此任何依赖 ghost 计数器的不变量都会以零计数通过——"1000 轮 0 反例"会是一份空转的假证据。

判定过程（实测，非推断）：

1. 按官方约定编写 `invariant_*` 并部署独立 handler，显示 `(runs: 1000)` 且全部通过；
2. 注入一个已确认会让 3 个普通测试失败的变异（注释掉 `hasVoted[msg.sender] = true`），不变量**仍然通过** → 说明没有任何一次投票被尝试过；
3. 排除"handler 位于 `.t.sol` 中所以不被选为目标"：改用普通源文件，结果不变；
4. 排除 target 选择机制问题：试过 `targetContract(address(handler))`、也试过把驱动函数直接放在测试合约自身（官方示例形态），结果均不变；
5. 写入必假的不变量 `assertEq(1, 2)`，它**失败**了 → 证明运行器确实在求值不变量，问题只在于目标集合为空；
6. 查阅 `@nomicfoundation/edr@0.20.0` 的 `InvariantConfigArgs` 类型，其中**不存在任何 target/contract 字段**，与观测一致。

**处理**：删除那两个文件。一份静默空转的测试比没有测试更危险，因为它会伪装成证据。

**替代方案**：`VotingProperties.t.sol` 用 `keccak256(seed, round)` 驱动 **1000 轮**确定性投票（40 名选民 × 3 名候选人，完全可复现），**每一轮之后**都断言全部不变量，并额外断言"这 1000 轮确实产生了工作"。该方案**同样通过负向对照**：注入同一个变异后，它以 `votes can never exceed the whitelist size: 41 > 40` 失败。

所以这个项目里"测试通过"的含义是**先证明测试能失败**。

---

## 快速开始

### 前置条件

- Node.js **≥ 22.13**（开发与验证使用 24.x）
- pnpm **11.x**（`packageManager` 已固定为 `pnpm@11.25.0`，`corepack enable` 即可）
- MySQL 8.x（**可选**：不装也能跑，只是没有索引与一致性比对）
- Docker（可选，仅用于一键起 MySQL）

### 1. 安装

```bash
pnpm install
```

> `forge-std` 以 git 依赖引入（`github:foundry-rs/forge-std#v1.16.2`）。弱网环境下这一步可能因 GitHub 连接重置而失败，重试即可。

### 2. 起数据库（可选）

用 Docker（推荐，避让本机 3306 冲突）：

```bash
docker compose up -d mysql
```

连接串为 `mysql://voting:voting@127.0.0.1:3307/voting`。或者用你自己的 MySQL，手动建库：

```sql
CREATE DATABASE voting CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. 配置应用

```bash
cp web/.env.example web/.env
# 编辑 web/.env：至少确认 RPC_URL；要用索引就填 DATABASE_URL
```

不填 `DATABASE_URL` 时应用仍可完整运行，只是没有索引层。

### 4. 跑起来（三个终端）

```bash
# 终端 1：本地链
pnpm --filter @voting/contracts exec hardhat node

# 终端 2：部署 + 播种 200 名选民并投票（可选，但界面才有数据可看）
pnpm seed:local
pnpm export-abi        # 把新地址发布到 web/src/lib/contracts

# 终端 3：应用（界面 + API + 索引器，默认 http://127.0.0.1:3000）
pnpm web:dev
```

打开 <http://127.0.0.1:3000>，在钱包里添加本地网络（RPC `http://127.0.0.1:8545`，Chain ID `31337`），导入 Hardhat 输出的任意测试账户即可投票。

> 端口被占用时：`pnpm web:dev -- --port 3100`。
>
> 配了 `DATABASE_URL` 时，应用启动后会自动在后台持续索引（见 `web/src/instrumentation.ts`），无需再单独起索引进程。若不想用后台循环，设 `INDEXER_ENABLED=false`，改用 `pnpm indexer:drain` 或 `POST /api/index/sync` 手动推进。

---

## 验证与复现

### 全部测试与覆盖率

```bash
pnpm typecheck            # Next.js 层类型检查
pnpm test                 # 合约 49 个 + 索引器 36 个
pnpm coverage             # Voting.sol 行/语句覆盖率
pnpm gas                  # gas 统计表
pnpm build:web            # Next.js 生产构建
```

### M-6：链上/索引一致性（端到端）

```bash
pnpm --filter @voting/contracts exec hardhat node   # 终端 1
pnpm seed:local                                     # 终端 2：部署 + 200 票
pnpm export-abi
pnpm indexer:migrate
pnpm indexer:drain
pnpm indexer:check-consistency                      # 期望 0 处偏差，不一致时退出码非 0
```

也可直接看 API 的双侧比对结果：

```bash
curl http://127.0.0.1:3000/api/results
```

不一致时该接口返回 **HTTP 500** 并给出逐候选人的差异，避免调用方把错误数据当作可用结果。

### M-6b：幂等性（重放不重复计数）

这是整个索引器最关键的一条性质。把游标回退到 0，强制重新拉取整段已索引范围：

```bash
mysql -u root -p voting -e "UPDATE sync_cursor SET last_block = 0;"
pnpm indexer:drain
# 期望输出：totalEventRowsSeen = 404, inserted = 0, duplicatesIgnored = 404
pnpm indexer:check-consistency
# 票数必须仍是 200。如果变成 400，说明 UNIQUE(tx_hash, log_index) 失效了。
```

> 测量前请先停掉应用（或设 `INDEXER_ENABLED=false`）：否则后台循环会抢先把游标推回链头，`drain` 就只能看到 `rounds: 0`。

### 其他接口

```bash
curl http://127.0.0.1:3000/api/health      # 索引高度、链头、落后区块数
curl http://127.0.0.1:3000/api/candidates  # 候选人及票数（含数据来源）
curl http://127.0.0.1:3000/api/voters/0x…  # 某地址的白名单/投票/退款状态
```

---

## 设计取舍与已知局限

这一节是刻意保留的。一个 demo 如果隐藏自己的信任模型，比没有信任模型更糟。

### 1. 没有投票隐私（重要）

这是**公开明票**投票。你投给谁、以及你是否投过票，都写在链上且永久可查。本 Demo 在密码学层面**不提供任何**投票隐私。

如果要真正的隐私投票，需要零知识证明（如 MACI、Semaphore）或承诺-揭示两阶段方案，那是另一个量级的复杂度，本项目明确不做。

### 2. 0.001 ETH 押金不是女巫攻击防护

押金可全额退回，所以它**不构成**任何经济门槛——攻击者投 N 票的成本只是 gas。它存在的理由是：**制造一次真实的外部调用**，从而让重入攻击面真实存在，才能写出有意义的 CEI + `nonReentrant` 纵深防御与四组对照测试。

真正的准入门槛是**管理员维护的白名单**，这是中心化的，且被明确接受。

### 3. `sweepUnclaimed()` 是额外的中心化风险

投票结束 30 天后，管理员可以调用 `sweepUnclaimed()` 把无人领回的押金全部转走。这意味着一个拖延的投票者可能损失押金。已实现并在测试中覆盖，但它确实是一项管理员特权，如实记录于此。

### 4. 白名单是中心化的

管理员可以随时增删白名单（投票结束前）。没有链上治理、没有多签、没有时间锁。

### 5. 索引器是缓存，不是真相来源

- 它是**只读**的：`web/src/app/api/**/route.ts` 里每个处理器都只有 GET（同步接口是 POST，且只写本地缓存，不碰链），每条 SQL 都是 SELECT，进程不持有任何私钥。
- 它是**可重建**的：删库后重放全部事件即可恢复。
- 它**可能落后**：默认保留 5 个确认区块（本地开发设为 0），因此最近几秒的投票可能尚未出现在索引结果里。前端的 `/api/results` 会因此显示不一致——这是设计上的诚实表现，而不是 bug。
- 前端读链上**权威**数据（票数、我的状态），索引只用于列表与历史查询，因此界面不会因为索引落后而显示错误的票数。

### 6. IPFS 元数据依赖公共网关

公共网关不可靠：开发期间 `ipfs.io` 与 `dweb.link` 均返回过 HTTP 429。因此前端实现了**多网关轮询 + 单请求超时 + CID 格式本地校验**，并把"元数据不可用"作为一种正常状态渲染，降级显示候选人编号。

要把元数据真正固定下来，需要一个带密钥的 pinning 服务（Pinata / web3.storage 等）。设置 `NEXT_PUBLIC_IPFS_GATEWAY` 可指定专用网关。

### 7. 后台索引循环依赖长驻进程

`web/src/instrumentation.ts` 会在服务启动时拉起一个轮询循环。这在 `next dev` / `next start` 下有效，但在无服务器（serverless）部署中不会持续运行。因此索引的**可靠**入口是 `POST /api/index/sync` 和 `pnpm indexer:drain`——后台循环只是便利，不是设计所依赖的机制。

### 8. 已知的可改进点

- Hardhat 3 的不变量测试当前不可用（见 M-4）。若未来版本修复目标调用，应当用真正的 `invariant_*` 测试替换 1000 轮序列，并保留后者作为确定性回归。
- 前端未做浏览器端交互自动化测试（本环境无浏览器自动化能力），已完成的验证是类型检查、生产构建、服务端渲染与全部 API 路由的实测响应。
- 合约未审计。**不要用于任何真实选举。**

---

## 安全说明

- `.env` 与 `.env.*` 已被 `.gitignore` 排除，只有 `.env.example` 入库。
- 仓库不包含任何私钥、助记词或 API 密钥。
- Sepolia 部署使用 Hardhat 的 Configuration Variables（环境变量或 `hardhat keystore set`），凭证不落盘入库。
- 部署到真实网络前，请先确认 `docs/aegis/specs/` 中的设计规格与本节列的局限你都接受。

---

## 仓库结构

```
.
├── contracts/                     # 合约层：Hardhat 3 + Solidity 0.8.37 + OpenZeppelin 5.6.1
│   ├── contracts/
│   │   ├── Voting.sol             # 生产合约
│   │   ├── Voting.t.sol           # 41 个 Solidity 测试（含四组重入矩阵）
│   │   ├── VotingProperties.t.sol # 1000 轮属性测试（M-4）
│   │   └── test/                  # 仅测试用夹具，绝不部署
│   ├── test/Voting.ts             # 8 个 viem + node:test 消费方测试
│   ├── scripts/                   # deploy / seed-local / export-abi
│   └── hardhat.config.ts
├── web/                           # Next.js 层：界面 + 只读索引器 + REST API
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx           # 服务端预取，首屏即有真实数据
│   │   │   └── api/               # 5 个 Route Handler（health/candidates/results/voters/sync）
│   │   ├── components/            # Ballot / CandidateCard / ConsistencyBadge / WalletBar
│   │   ├── lib/
│   │   │   ├── indexer/plan.ts    # 纯函数：分块与重组判定（可单测，无 IO）
│   │   │   ├── indexer/decode.ts  # 事件解码
│   │   │   ├── indexer/sync.ts    # 事务、游标、幂等
│   │   │   ├── db/schema.ts       # 投影表结构（SQL 常量）
│   │   │   ├── data.ts            # 链上/索引两侧的统一读取入口
│   │   │   └── contracts/         # ABI 与部署地址（由 export-abi 生成）
│   │   └── instrumentation.ts     # 启动后台索引循环
│   ├── scripts/                   # migrate / drain / check-consistency
│   └── test/                      # 36 个单测，不需要链或数据库
├── docs/aegis/                    # 设计规格、基线、实测校正记录
├── docker-compose.yml             # 可复现的 MySQL（3307，避让本机 3306）
└── .github/workflows/ci.yml       # 4 条流水线
```

### 关于 `web/src/lib/contracts` 的生成文件

`voting-abi.ts`、`deployments.ts` 与 `index.ts` 由 `pnpm export-abi` 生成并**入库提交**，这样应用无需先编译合约即可类型检查与构建。CI 中的 `abi-drift` 作业会重新生成并要求 `git diff` 为空，因此这份副本不可能悄悄过期。

之所以不单独建一个 `packages/shared` 包，是因为它的唯一内容是生成物；放进 `web/` 让仓库保持"合约层 + Next 层"两层的结构。

---

## License

MIT
