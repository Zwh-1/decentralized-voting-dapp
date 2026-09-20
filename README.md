# 去中心化投票 DApp

一个**两层**的链上投票应用：

- **合约层**（`contracts/`）——Hardhat 3 + Solidity 0.8.37 + OpenZeppelin 5.6.1。白名单准入、一人一票、押金托管与退回、阶段状态机；候选人文字信息只存 IPFS，链上只保存 CID。
- **Next.js 层**（`web/`）——同一进程里既有面向浏览器的投票界面，也有一个**只读事件索引器**：它把合约事件投影到 MySQL，并通过 Route Handler 暴露 REST 接口。页面同时展示链上与索引两侧的票数并**实时比对二者是否一致**。

> 这是一个**教学与作品集项目**，不是生产级投票系统。它的重点不在于"能投票"，而在于把链上状态、链下投影、前端展示之间的**一致性**做成可测量、可证伪的东西。请先读[设计取舍与已知局限](#设计取舍与已知局限)。

![投票界面](docs/screenshots/ballot.png)

> 截图取自**未连接钱包**状态（无头 Chrome 渲染，没有注入钱包扩展）。顶部是链上与索引两侧的实时一致性比对，下面每位候选人卡片显示票数。连接钱包后才会出现投票、退款与钱包地址这些交互控件——它们全部依赖钱包签名，因此在这个静态截图中必然缺席，而不是坏了。

---

## 目录

- [架构](#架构)
- [实测指标](#实测指标)
- [快速开始](#快速开始)
- [验证与复现](#验证与复现)
- [Sepolia 部署与验证（M4）](#sepolia-部署与验证m4)
- [设计取舍与已知局限](#设计取舍与已知局限)
- [安全说明](#安全说明)
- [仓库结构](#仓库结构)
- [参与贡献与安全](#参与贡献与安全)

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
2. **索引是可选依赖。** 索引有**两种**缺失方式，应用对两者的处理相同，因为两种情况下链都是事实源：不设 `DATABASE_URL`（从未配置），以及设了但数据库读不到（索引挂了）。两种情况所有读取都回退为直接读链，`source` 字段说明是哪一侧回答的，`/api/results` 会如实报告 `status: "unavailable"`，而不是给一个"没比对过却显示一致"的假结论。挂掉的索引不会被悄悄吞掉：`/api/health` 用 `indexError` 报出原因，`status` 变为 `degraded`。

---

## 实测指标

以下数字全部来自本仓库中可复现的命令，不是估计值。

| 编号 | 指标               | 实测结果                                                                                                                                                                                | 复现命令                         |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| M-1  | 合约覆盖率         | `Voting.sol` 行 **100.00%**、语句 **100.00%**                                                                                                                                           | `pnpm coverage`                  |
| M-2  | 越权与非法调用拦截 | 7 类路径全部 revert：非白名单、重复投票、阶段错误（4 种）、押金金额错误、未知候选人、零地址、非管理员                                                                                   | `pnpm test:contracts`            |
| M-3  | 重入攻击防护       | 四组对照矩阵全部符合预期（见下）                                                                                                                                                        | `pnpm test:contracts`            |
| M-4  | 长序列属性测试     | 1000 轮确定性随机投票 + 256 轮 fuzz，**0 反例**，且经变异测试证明可失败                                                                                                                 | `pnpm test:contracts`            |
| M-5  | Gas（中位数）      | `vote` **109,256**；`refund` **37,920**；部署 **1,249,757**；运行时代码 5,298 字节                                                                                                      | `pnpm gas`                       |
| M-6  | 链上/索引一致性    | **200 / 200 票，0 处偏差**（3 名候选人逐一比对）；`CONFIRMATIONS=5` 下索引合法落后至 197 票时**仍判定一致**（加回 3 票待确认）；同样的落后叠加删掉 1 行则**判定不一致**并定位到候选人 2 | `pnpm indexer:check-consistency` |
| M-6b | 索引幂等性         | 游标回退到 0 强制重放：404 行**全部命中重复，插入 0 行**，票数仍为 200（未翻倍）                                                                                                        | 见[验证与复现](#验证与复现)      |
| M-6c | 真实链重组         | `evm_revert` 让链头 407→406：索引报告 `rewound`、孤立事件行被删（201→200）、**票数仍为 200**                                                                                            | `pnpm indexer:reorg-drill`       |
| M-6d | 真实退款入库       | `0.001 ETH` 全额入库（`amount_wei` 逐位相同、无精度丢失）、**票数不变**、回退后索引撤销退款与阶段行                                                                                     | `pnpm indexer:refund-drill`      |
| M-6e | 浏览器端写入路径   | 注入钱包后驱动真实 DOM：未白名单账户按钮禁用并说明理由；**已白名单账户可点且确认上链**；**退款可点，链上 `stakeOf` 读回 0**；全程无"提交中…"假状态                                      | `pnpm ui:drill`                  |
| M-7  | Next.js 生产构建   | 构建成功，1 个页面 + 5 个动态 Route Handler 全部产出                                                                                                                                    | `pnpm build:web`                 |
| —    | 测试总数           | **130 个**（合约 41 Solidity + 8 TypeScript，索引器 81）                                                                                                                                | `pnpm test`                      |

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

连接串为 `mysql://voting:voting@127.0.0.1:3307/voting`（`web/.env.example` 里已经写好这一行，取消注释即可）。或者用你自己的 MySQL，手动建库：

```sql
CREATE DATABASE voting CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

> **这条 Docker 路径的实测程度**：`docker compose config` 校验通过（YAML、compose schema、`3307:3306` 端口映射与环境变量均正确），但**容器本身没有真正跑起来**——本机 Docker 引擎始终未就绪（API 持续返回 500）。因此本文档中所有 M-1…M-6b 的实测数据都是在**本机已装的 MySQL 8.4.4**（3306）上跑出来的，不是这个容器。用你自己的 MySQL 走的是同一条已验证路径。

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

### 冷克隆可复现性

下列 8 项已在一个**全新 `git clone`**（无 `.env`、无 `node_modules`、无本地链、无数据库）中逐项跑通，全部退出码为 0：

```bash
git clone <repo> && cd decentralized-voting-dapp
pnpm install --frozen-lockfile   # 53.8s
pnpm run typecheck
pnpm test                        # 合约 49 + 索引器 81，0 失败
pnpm coverage                    # Voting.sol 100.00 / 100.00
pnpm export-abi && git diff --exit-code -- web/src/lib/contracts
pnpm run build:web
pnpm run format:check
python <aegis>/scripts/aegis-workspace.py check --root .   # 设计规格、基线、ADR 的结构校验
```

这组命令**不需要**链、数据库、IPFS 网关或任何凭证。需要外部依赖的 M-5（gas）、M-6（一致性）与端到端演练在下面的小节里单独说明。

最后一项需要 `docs/aegis/plans/` 与 `docs/aegis/work/` 存在——它们是工作区结构的一部分，本身不含提交内容。git 无法跟踪空目录，因此这两个目录各有一个 `.gitkeep`；冷克隆缺少它们时校验会失败，而任何已经创建过它们的工作副本都会通过，这正是需要把它们纳入冷克隆清单的原因。

### 从零复现索引

`pnpm test` 里的索引器单测用的是**假对象**：它们固定的是判定逻辑，不是"索引真的能把一条链读成正确投影"。后者需要一次真实的重建。

下面这套流程在**一个全新的空数据库**上跑过（链复用已播种的本地节点）：

```bash
mysql -e "CREATE DATABASE voting CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
export DATABASE_URL='mysql://root:<pw>@127.0.0.1:3306/voting'
export RPC_URL='http://127.0.0.1:8545' CHAIN_ID=31337 CONFIRMATIONS=0

pnpm run indexer:migrate        # 建表，7 张
pnpm run indexer:drain          # 从部署区块扫到链头
pnpm run indexer:check-consistency
```

实测（空库 → 与文档基线逐项相同）：

| 步骤                | 结果                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `indexer:migrate`   | 7 张表；重复执行同样退出 0（幂等）                                                    |
| `indexer:drain`     | `totalEventRowsSeen: 404`、`inserted: 404`、`duplicatesIgnored: 0`                    |
| 投影结果            | `votes=200 whitelist=200 phases=1 cursor=406 tally=67/67/66`                          |
| `check-consistency` | `status: "consistent"`、`onChainTotal: 200`、`indexedTotal: 200`、`discrepancies: []` |
| 再 `drain` 一次     | `totalEventRowsSeen: 0`、`inserted: 0`——游标已到链头，重放不重复计数                  |

也就是说：**只给一个空数据库和一条可达的链，索引就能自行收敛到与链完全一致的状态**，不需要任何手工播种。

把游标强制归零可以验证幂等（M-6b）——全部 404 行重走一遍插入路径，总数不得移动：

```bash
mysql -u root -p voting -e "UPDATE sync_cursor SET last_block = 0;"
pnpm indexer:drain          # 期望：seen 404, inserted 0, duplicatesIgnored 404
pnpm indexer:check-consistency
```

### 完整端到端：全新链 + 全新库

上面那套复用的是已播种的链。把链也换成全新的一条，才是完整的复现——`seed-local.ts` 自己负责部署，因此一条命令就能造出整条链：

```bash
cd contracts && pnpm exec hardhat node --port 8546 &   # 另起一条链，不动正在用的那条
export LOCALHOST_RPC_URL='http://127.0.0.1:8546'       # Hardhat 的 localhost 网络与 seed 都认它
cd .. && pnpm run seed:local                           # 部署 + 200 票（约 10 秒）
```

实测结果与文档基线**逐项相同**：部署地址仍是确定性首地址 `0x5fbd…`、链头 `406`、tally `67/67/66`，随后空库 drain 仍是 `404/404/0`，一致性仍是 `200/200` 与 `[]`。这同时证明了 `seed-local.ts` 的完全确定性。

`LOCALHOST_RPC_URL` 的存在就是为了这个场景：`deploy:local` 原先硬编码 8545，任何一次完整演练都得先拆掉正在使用的那条链。

> **CI 覆盖这一步。** `.github/workflows/ci.yml` 的 `indexer-e2e` 作业在每次推送时重跑等价流程：起一个本地链、`pnpm seed:local`、建表、drain、比对一致性，并把游标归零强制重放一遍验证幂等（M-6b）。它用 `CONFIRMATIONS=0`，不给确认窗口留宽容——整条链对整份索引，落后不算通过。上面的手动流程用于在本机排查。

> 另一个边界：`web` 作业只把 schema 应用到真实的 MySQL 服务（并跑两遍证明幂等），**它本身不碰链**。端到端由 `indexer-e2e` 负责，两者的失败原因因此互不掩盖。

### 全部测试与覆盖率

```bash
pnpm typecheck            # Next.js 层类型检查
pnpm test                 # 合约 49 个 + 索引器 81 个
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
pnpm indexer:check-consistency                      # 期望 0 处偏差，退出码 0
```

也可直接看 API 的双侧比对结果：

```bash
curl http://127.0.0.1:3000/api/results
```

#### 为什么不能直接比较两个总数

索引器按设计**故意不索引最近的 `CONFIRMATIONS` 个区块**（默认 5，本地开发设 0），否则一次链重组就会把可能被回滚的数据永久写进库。因此索引里的票数**本来就应该少于链上当前的票数**——这是正确行为，不是偏差。

直接比较两个总数会把这种正确行为报成故障。这个项目的第一版就真踩了这个坑：在默认 `CONFIRMATIONS=5` 下，`check-consistency` 稳定地报"不一致"并退出 1，而数据库完全健康。这种告警的下场是被忽略——等真正的分歧出现时，没有人会再看它。

正确的问法是：**索引，加上它还不被允许读取的那段区块里的投票，是否等于链上的结果？**

为此检查器会拉取 `(cursor, head]` 区间内的日志，解码出其中的 `VoteCast`，把票数加回索引一侧再比较。这个判断只有一处实现（`web/src/lib/report.ts` 的 `checkConsistency`），`/api/results` 与 `check-consistency` 都调用它，所以界面和命令行不可能给出不同结论。

`status` 有四个取值：

| `status`      | 含义                                                       | `/api/results` | CLI 退出码               |
| ------------- | ---------------------------------------------------------- | -------------- | ------------------------ |
| `consistent`  | 计入待确认票数后两侧完全吻合                               | 200            | 0                        |
| `divergent`   | 计入之后**仍然**不吻合——真故障                             | 500            | 1                        |
| `lagging`     | 未索引区间大到无法枚举（超过 5000 块），无法归因           | 200            | 0，并打印 `INCONCLUSIVE` |
| `unavailable` | 索引不可用（未配置，或配置了但读不到），不存在可比较的索引 | 200            | 0                        |

只有 `divergent` 会返回 HTTP 500、退出码 1。`lagging` 不是"其实没问题"的委婉说法，而是"得不出结论"，所以它**不会**静默通过：CLI 会把 `INCONCLUSIVE` 写到 stderr。

> 退出码本身也是可依赖的：脚本用 `process.exitCode` 而不是 `process.exit()`。后者会立即终止进程，`finally` 里的 `pool.end()` 根本不会执行；Windows 上 libuv 随后在拆卸未关闭句柄时触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`，把一次正确的运行报成退出码 `0xC0000409`。对一个"契约就是退出码"的验证脚本，这是致命的。

#### 三种索引状态下的 API 实测

索引的两种缺失方式都会被实际跑过，而不是只写在文档里。下表是逐个端点的实测响应（本地链 406 块、200 票）：

| 端点                   | 索引正常                                                           | 索引**挂了**（`DATABASE_URL` 指向死端口）                                                  | 无索引（未设 `DATABASE_URL`）                                  |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `/api/health`          | 200，`status: "ok"`，`lastIndexedBlock: "406"`，`indexError: null` | 200，`status: "degraded"`，**`indexError: "connect ECONNREFUSED …"`**，`chainHead: "406"`  | 200，`status: "ok"`，`indexEnabled: false`，`indexError: null` |
| `/api/candidates`      | 200，`source: "index"`，tally 67/67/66                             | 200，**`source: "chain"`**，tally 67/67/66                                                 | 200，`source: "chain"`，tally 67/67/66                         |
| `/api/results`         | 200，`status: "consistent"`，200/200                               | 200，**`status: "unavailable"`**，`indexedTotal: null`                                     | 200，`status: "unavailable"`，`indexedTotal: null`             |
| `/api/voters/<addr>`   | 200，`source: "index"`，带 `voteTxHash`                            | 200，**`source: "chain"`**，`whitelisted`/`hasVoted`/`votedFor` 仍正确，`voteTxHash: null` | 200，`source: "chain"`，同上                                   |
| `POST /api/index/sync` | 200，`status: "idle"`                                              | 503 `sync_failed`（这是**写**索引，没有库就写不了）                                        | 200，`enabled: false`                                          |

两条要点：

- **`unavailable` 不等于"一致"。** 三种状态下 `discrepancies` 都是 `[]`，但只有索引正常时才给出 `consistent`。没有任何可以比较的东西时，这个接口不会宣称比过了。
- **挂了与没配走同一条路。** 只处理"没配"意味着一次数据库宕机会把链仍能回答的问题变成 503，页面还会告诉读者"服务端无法读取**链上**数据"——而链是好的。挂掉的索引通过 `indexError` 依然可见，所以这不是把故障藏起来。

#### M-6 的负向对照（这个检查确实会报警）

一个永远只说"一致"的检查器不是证据。因此这里刻意制造了一次分歧：从 `votes` 表删掉**一行**，然后观察两侧是否被发现。

```bash
mysql -u root -p voting -e "DELETE FROM votes ORDER BY id DESC LIMIT 1;"   # 199 行
pnpm indexer:check-consistency
# 退出码 1，且定位到具体候选人：
#   "status": "divergent", "onChainTotal": 200, "indexedTotal": 199
#   "discrepancies": [{ "candidateId": 2, "onChain": 67, "indexed": 66, "pending": 0 }]

curl -i http://127.0.0.1:3000/api/results      # 期望 HTTP 500 + 同一份差异

# 恢复：回退游标后重放，缺失的行会被重新插入
mysql -u root -p voting -e "UPDATE sync_cursor SET last_block = 0;"
pnpm indexer:drain
pnpm indexer:check-consistency                 # 回到 200/200，退出码 0
```

**这套对账逻辑真正被考验的地方，是它能否在"索引确实合法落后"时仍然抓住真故障。** 在 `CONFIRMATIONS=5`、链上 200 票、索引已追平安全头（401 块）因而只持有 197 票的情况下：

| 数据库状态                       | `unindexedBlocks` | 加回待确认票数 | `status`        | 退出码 |
| -------------------------------- | ----------------- | -------------- | --------------- | ------ |
| 健康（197 票）                   | 5                 | 3              | `consistent`    | 0      |
| 同样的落后 + 删掉 1 行（196 票） | 5                 | 3              | **`divergent`** | **1**  |

第二行是关键：故障没有被"还在确认窗口里"这块遮羞布盖过去。差异被定位到候选人 2，`pending: 1` 说明即使把那 1 票加回来也仍然对不上。

界面上这三种状态长这样（均为无头浏览器实拍）：

| 一致（正常）                                                                       | 一致（索引落后但已对账）                                                                                                          | 不一致（检查器报警）                                                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ![一致](docs/screenshots/ballot.png)<br>`链上与索引一致 · 200 / 200 票 · 0 处偏差` | ![落后但对账](docs/screenshots/consistency-reconciled-lag.png)<br>`链上与索引一致 · 200 / 197 票 · 0 处偏差（已计入 3 票待确认）` | ![不一致](docs/screenshots/ballot-inconsistent.png)<br>`链上 200 票 ≠ 索引 199 票 · 1 处偏差` |

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

### M-6c：真实链重组演练

重组回退原本只有单元测试，而单元测试跑在假对象上——假对象证明不了真实 RPC、真实游标行与真实 `DELETE` 对"分叉点在哪"的判断是一致的。这条演练用 Hardhat 的 `evm_snapshot` / `evm_revert` 让一个**真实节点**的链头后退，再检查索引是否自行修复：

```bash
pnpm indexer:reorg-drill     # 需要 hardhat node + 已排空的索引；先停掉应用
```

它只允许在 chainId 31337 上运行，并且每次自取快照——无论成功失败都会把链还原，因此可以反复跑。实测输出（干净状态，链头 406）：

| 阶段              | 链头 | 游标                | `whitelist_events`      | 票数                |
| ----------------- | ---- | ------------------- | ----------------------- | ------------------- |
| 开始              | 406  | 406                 | 200                     | 200                 |
| 发一笔真实交易后  | 407  | 407                 | **201**（新事件被索引） | 200                 |
| `evm_revert` 之后 | 406  | 407（游标领先于链） | 201                     | 200                 |
| 索引器修复之后    | 406  | **406**             | **200**（孤立行被丢弃） | **200**（未被误删） |

它断言三件事：链头退到游标**之后**时索引器确实报告了 `rewound`（`rewoundTo: 406, discardedFrom: 407`）；被孤立的 `WhitelistUpdated` 行确实被删掉（201 → 200）；而**票数必须原封不动**——回退只能丢弃被孤立的日志，绝不能丢掉仍然在链上的票。

> 两个实测踩到的坑，已写进脚本注释：`evm_snapshot` 返回的 id 是节点生命周期内递增的十六进制数（不是想当然的 `0x1`，传错只会安静地返回 `false`）；并且 `evm_revert` 返回 `true` 之后，`eth_blockNumber` **不会立刻**反映回退——只读一次就下结论，会误判成"重组从未发生"。

### M-6d：真实退款演练

`refunds` 是投影里唯一一张种子数据填不满的表——播种结束时选票仍停在 Voting 阶段，无法退款，所以它一直是 0 行。`Refunded` 的解码有单测、插入语句也出现在同步测试里，但两者用的都是合成日志：**从来没有一个真实的 wei 数额从合约走到 `DECIMAL(38,0)`**。

这个缺口值得补，因为精度丢失是**静默的**：行照样出现、接口照样返回，唯一的症状是数字不对。

```bash
pnpm indexer:refund-drill     # 需要 hardhat node + 刚播种并排空的索引；先停掉应用
```

`endVoting()` 不可逆，所以整个场景跑在一次快照里，结束时回退——失败时同样回退。实测：

| 阶段             | 阶段值     | `refunds` | `phase_events` | 票数                |
| ---------------- | ---------- | --------- | -------------- | ------------------- |
| 开始             | 1 投票     | 0         | 1              | 200                 |
| `endVoting()` 后 | 2 结束     | 0         | **2**          | 200                 |
| `refund()` 后    | 2 结束     | **1**     | 2              | **200**（未被改动） |
| `evm_revert` 后  | **1 投票** | **0**     | **1**          | 200                 |

它断言四件事：链上 `stakeOf` 为 `1000000000000000` wei，入库的 `amount_wei` **逐位相同**（精度丢失会正好在这里现形）；退款**不改变票数**（合约不会因退款递减 `voteCount`，索引自然也不能）；退款后两侧仍然一致；回退后索引把**退款行与阶段行一并撤销**。

两个演练都可重复运行，跑完状态与基线完全一致（票 200、白名单 200、退款 0、阶段事件 1、游标 406）。

### M-6e：浏览器端钱包交互演练

上面所有的验证都跑在**没有浏览器**的地方：类型检查、生产构建、服务端渲染、API 响应、索引器单测。而两个真实缺陷恰好长在这个没人看的面上。

```bash
pnpm ui:drill                            # 只读：连接钱包并断言 UI 与链一致
TEST_ACCOUNT=0x… pnpm ui:drill --vote    # 额外真实投一票（会改动链，建议在快照里跑）
TEST_ACCOUNT=0x… pnpm ui:drill --refund  # 额外真实取回押金（需 phase=Ended，同样建议在快照里跑）
```

它用 DevTools Protocol 驱动 headless Chrome，**不引入任何浏览器自动化依赖**（Node 22+ 自带 `WebSocket`）。注入的 EIP-1193 provider 把 `eth_sendTransaction` 转发给本地节点，由节点用自己的解锁账户签名，所以过程里不涉及任何私钥。

**它抓到的两个缺陷：**

1. **投票按钮永远点不动。** `isSubmitting={isPending || receipt.isPending}`：没有交易哈希时 wagmi 会禁用收据查询（`enabled: Boolean(hash && …)`），而被禁用的 TanStack 查询**仍然报告 `status: "pending"`**。于是 `receipt.isPending` 恒为 true，所有按钮显示"提交中…"，且因为提交中即禁用，**连上钱包也点不了**——前端核心写入路径是死的。类型检查、构建、SSR、接口测试全都看不见它。
2. **未白名单账户也能点投票。** `canVote` 只看阶段、连接状态和是否已投票，没查白名单。按钮亮着，点下去必然被合约拒绝。合约其实**公开了** `isWhitelisted` getter，UI 完全可以自己判断。

顺带修掉的第三处同族问题：**退款按钮在多数状态下不给任何理由**。它只在 `phase==Ended && myStake==0` 这一种窄情况下显示说明；投票进行中而用户有押金时，看到的是一个灰掉且沉默的按钮。这条路径的沉默代价特别高——合约有 `sweepUnclaimed()`，押金长期无人认领会转给 owner，所以"按钮错误地禁用"等于**用户丢钱**。现在四种禁用原因都会写明。

修复后实测（三种场景均 exit 0）：

| 场景                                     | 链上状态                               | UI 断言                                                                                                                      |
| ---------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 未白名单账户（只读）                     | `isWhitelisted=false hasVoted=false`   | 3 个按钮全部禁用，理由为"这个地址不在白名单里，合约会拒绝投票。"；"我的状态"白名单一项显示"否"                               |
| 已白名单账户（`--vote`，快照内）         | `isWhitelisted=true hasVoted=false`    | 3 个按钮**全部可点**；点击后交易到达"已确认"，卡片变为"你已投给该候选人"，其余按钮禁用并提示"每个地址只能投一票"             |
| 已投票且投票已结束（`--refund`，快照内） | `phase=Ended stakeOf=1000000000000000` | 退款按钮**可点**；点击后到达"已确认"，**从链上读回 `stakeOf=0`**，按钮随即禁用并显示"没有可取回的押金。"，押金行回落 `0 ETH` |

每个场景都断言：**没有任何按钮停留在"提交中…"**，且每个按钮的可用性与链上状态逐一相符——UI 与链不会各说各话。截图见 `docs/screenshots/ui-vote-confirmed.png` 与 `docs/screenshots/ui-refund-confirmed.png`。

演练跑在一次快照里，结束时回退；实测链头与索引都会自动回到基线（票 200、白名单 200、退款 0、阶段事件 1、游标 406、tally 67/67/66）。回退也**真实地触发了索引器的重组自愈**，且退款那次一次性撤销了**三类**投影行——实测 `votes 201→200`、`whitelist 201→200`、`refunds 1→0`、`phases 2→1`、`cursor 410→406`、`tally 68/67/66 → 67/67/66`。

已知边界：注入的是**模拟 provider**，它与真实钱包在账户切换、链切换、拒绝签名等交互上存在差异，这些路径未覆盖；`endVoting()` 与 `setWhitelist()` 仍只有合约测试覆盖，没有浏览器端演练。

### 其他接口

```bash
curl http://127.0.0.1:3000/api/health      # 索引高度、链头、落后区块数
curl http://127.0.0.1:3000/api/candidates  # 候选人及票数（含数据来源）
curl http://127.0.0.1:3000/api/voters/0x…  # 某地址的白名单/投票/退款状态
```

---

## Sepolia 部署与验证（M4）

### 前置条件

1. 一个有测试 ETH 的**专用**部署账户（不要用持有真实资产的私钥）。
2. 一个 Sepolia RPC 端点（公共端点即可，无需 API key）。
3. 一个免费的 Etherscan API key：<https://etherscan.io/myapikey>（仅验证需要）。

凭证不会入库。二选一：

```bash
# 方式一：加密存储（推荐）
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
npx hardhat keystore set ETHERSCAN_API_KEY

# 方式二：明文文件
cp contracts/.env.example contracts/.env   # 然后填写（.env 已被 gitignore）
```

> Hardhat 3 **自己不会**读 `.env`——只认环境变量和 keystore。因此 `contracts/hardhat.config.ts` 用 Node 内置的 `process.loadEnvFile()` 显式加载 `contracts/.env`（文件存在才加载，不引入 `dotenv` 依赖）。语义与 `--env-file` 一致：**已导出的环境变量优先于文件**，所以临时覆盖仍然有效。

### 部署

```bash
pnpm --filter @voting/contracts deploy:sepolia
```

脚本会打印网络、部署者、owner、合约地址与区块浏览器链接，并把记录写入 `contracts/deployments/11155111.json`。**若该链上已有不同地址的记录，它会明确告警**——那份记录是应用与验证脚本读取地址的来源，静默覆盖会让已建好的索引指向错误的合约。

随后发布地址与源码：

```bash
pnpm export-abi                                          # 写入 web/src/lib/contracts
pnpm --filter @voting/contracts verify:sepolia           # Etherscan 源码验证
```

`verify:sepolia` 的构造函数参数是从部署记录里读回来的，不是重新手打的——`Voting` 的构造函数接收初始 owner，参数写错会表现为"验证失败"，但真实原因是拼写；读回记录直接消除了这个失败模式。

### 让本地索引跟上 Sepolia

只需要改链相关的项，`DATABASE_URL` 保持你上面已经配好的那个值不变：

```bash
# web/.env
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
CHAIN_ID=11155111
CONFIRMATIONS=5
```

`CONFIRMATIONS` 在真实网络上**不要设成 0**：那会让索引在重组发生时已经写入了可能被回滚的区块。

**起始区块不用你操心**：留空 `START_BLOCK`，索引会从合约的部署区块开始——`deploy.ts` 把它记进 `contracts/deployments/<chainId>.json`，再由 `pnpm export-abi` 传进前端配置。这个默认值是必需的，不是优化：公共 RPC 会裁剪历史（Sepolia 只提供约 1,000,000 之后的区块），从 0 扫描不是慢，而是**跑到 2000 个区块后彻底失败**，且因为游标已经推进过去，每次重试都重放同一个失败区间。详见规格校正 10。

注意 `CHAIN_ID` 变了之后，合约地址也要跟着变——它会由 `pnpm export-abi` 从 `contracts/deployments/11155111.json` 重新写入 `web/src/lib/contracts/`。

> **换链必须换库，这一点比看上去更硬。** 索引的表结构里**根本没有 `chain_id`**：`sync_cursor` 是一张 `CHECK (id = 1)` 的单行表，五张投影表也都不带链标识。所以同一个库里只存在**一个**游标、一套投影。把同一份 `DATABASE_URL` 指向 Sepolia，Sepolia 的事件会**追加**到本地 31337 的行旁边（两条链的交易哈希不同，`UNIQUE(tx_hash, log_index)` 不会拦），于是 `candidate_tally` 把两条链的票加在一起；而那个唯一的游标会从 406 跳到 Sepolia 的区块高度量级，此后重组检测拿一个链的区块号去比另一条链的链头，结果没有意义。
>
> 本项目按**单链**设计（ADR-0001），这不是遗漏而是取舍：多链需要在每张表上引入 `chain_id` 并重建全部唯一键。在同一实例里同时索引两条链，不在本项目范围内——请为 Sepolia 另建一个数据库。

### 已验证到什么程度（诚实说明）

本机**没有** Sepolia 部署账户，也没有 Etherscan API key，因此逐项说明已实测与未实测的边界。这一节里的每一行都可以用公共、无需密钥的 Sepolia RPC 自行复现：

| 项                                                                                                                               | 状态                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 缺凭证时的报错（一次列出缺哪个变量与补救命令）                                                                                   | **已实测**                                                                        |
| 只设置部分凭证时只报告缺的那一个                                                                                                 | **已实测**                                                                        |
| `deploy:local` 全流程，含覆盖既有记录时的告警                                                                                    | **已实测**                                                                        |
| `deploy:sepolia` 指向**真实** Sepolia（实测时区块 11,742,273）：解析网络、由私钥推导部署账户、owner 默认取部署者、构造并广播交易 | **已实测**——最终失败于 `gas required exceeds allowance (0)`，即唯一缺口是测试 ETH |
| `verify:sepolia` **在完全没有 `SEPOLIA_PRIVATE_KEY` 的情况下**连上 Sepolia 并走到"该链无部署记录"守卫                            | **已实测**——源码验证不再需要部署者私钥（见下）                                    |
| 验证脚本缺 `ETHERSCAN_API_KEY`、或缺部署记录时按预期失败                                                                         | **已实测**                                                                        |
| 失败的部署不污染本地记录（`deployments/` 事后仍只有 `31337.json`）                                                               | **已实测**                                                                        |
| 真实的 Sepolia 部署交易                                                                                                          | **未实测**——需要一个有测试 ETH 的私钥                                             |
| 真实的 Etherscan 源码验证                                                                                                        | **未实测**——需要一个 Etherscan API key                                            |

上表最后两行是 D3 交付边界的唯一缺口：脚本与验证路径都已就绪并被推到各自凭证边界的前一步，但没有凭证时无法伪造一次真实部署。

> **验证为什么不需要私钥。** `verify:sepolia` 走的是单独的 `sepoliaReadOnly` 网络条目，它刻意不声明 `accounts`。这不是洁癖：Hardhat 会在脚本自身的守卫运行**之前**解析传入的网络，所以最初指向 `sepolia` 时，验证一个已经部署的公开合约竟然也强制要求部署者私钥——把密钥无谓地拖进 CI 和每一台做验证的机器。

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
- 它**可能落后**：默认保留 5 个确认区块（本地开发设为 0），因此最近几秒的投票可能尚未出现在索引结果里。前端不会把这报成故障——`/api/results` 会把那段未索引区块里的 `VoteCast` 解码出来加到索引一侧再比较，两侧对得上就仍显示"一致"，并注明`（已计入 N 票待确认）`；只有加回之后**仍然**对不上才报`不一致`。见 [M-6](#m-6链上索引一致性端到端)。
- 前端读链上**权威**数据（票数、我的状态），索引只用于列表与历史查询，因此界面不会因为索引落后而显示错误的票数。

### 6. IPFS 元数据依赖公共网关

公共网关不可靠：开发期间 `ipfs.io` 与 `dweb.link` 均返回过 HTTP 429。因此前端实现了**多网关轮询 + 单请求超时 + CID 格式本地校验**，并把"元数据不可用"作为一种正常状态渲染，降级显示候选人编号。

这个回退不是纸面设计，对着真实网关实测过（本机，2026-09-20）：

| 网关                   | 结果                                                                   |
| ---------------------- | ---------------------------------------------------------------------- |
| `dweb.link`            | **HTTP 000**（不可达）                                                 |
| `ipfs.io`              | **HTTP 000**（不可达）                                                 |
| `gateway.pinata.cloud` | **HTTP 200**，但正文是 `hello world`（`text/plain`），不是候选人元数据 |

也就是说默认顺序里的前两个在本机根本连不上，第三个才作答——**没有回退，候选人卡片会全部显示编号**。同一次实测得到 `{"status":"no-metadata","attempts":3,"answered":1}`：三个网关都试了，**只有一个真的作答**。失败状态因此按"失败的是谁"分开，不合并成一个计数：

- `invalid-cid`——本地就判为不可能解析，**一个请求都不发**（实测 0 ms）；
- `unreachable`——一个网关都没联系上（网络问题）；
- `no-metadata`——联系上了，但没有任何一个给出可用的元数据（内容问题）。

把后两者合并曾导致一个可达的网关被报成"不可达"。CID 校验接受 CIDv0（`Qm…`，46 字符）与任意 codec 的 CIDv1 base32 形式（`b` + 58 字符，共 59），包括 raw codec 的 `bafk…`；把"合法但少见"的 CID 报成"格式无效"，等于告诉用户数据坏了，而实际是校验太窄。

要把元数据真正固定下来，需要一个带密钥的 pinning 服务（Pinata / web3.storage 等）。设置 `NEXT_PUBLIC_IPFS_GATEWAY` 可指定专用网关。

> **尚未验证的边界**：成功路径（`status: "ok"`）**从未在真实网关上发生过**。播种数据里的 CID（`bafyseededcandidate0`）是伪造的，仓库里没有任何真实 CID 指向真实的候选人元数据 JSON，因此 `ok` 分支只有 stub 测试覆盖。要真正走通它，需要往链上放一个真实的 CID——那需要一个 pinning 服务。

### 7. 后台索引循环依赖长驻进程

`web/src/instrumentation.ts` 会在服务启动时拉起一个轮询循环。这在 `next dev` / `next start` 下有效，但在无服务器（serverless）部署中不会持续运行。因此索引的**可靠**入口是 `POST /api/index/sync` 和 `pnpm indexer:drain`——后台循环只是便利，不是设计所依赖的机制。

### 8. 已知的可改进点

- Hardhat 3 的不变量测试当前不可用（见 M-4）。若未来版本修复目标调用，应当用真正的 `invariant_*` 测试替换 1000 轮序列，并保留后者作为确定性回归。
- 浏览器端交互现在有自动化覆盖（`pnpm ui:drill`，见下节），但它**需要本机 Chrome 和一个运行中的 `hardhat node`**，因此不在 CI 里跑，属手动演练——和 `reorg-drill` / `refund-drill` 同一类。
- 覆盖的是**投票**与**取回押金**两条写入路径。`结束投票`、`白名单管理` 仍只有合约测试覆盖，没有浏览器端演练；且演练用的是模拟 provider，账户切换/链切换/拒绝签名等真实钱包交互未被覆盖。
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
│   │   ├── Voting.t.sol           # 39 个 Solidity 测试（含四组重入矩阵）
│   │   ├── VotingProperties.t.sol # 2 个：1000 轮属性测试与 fuzz（M-4）
│   │   └── test/                  # 仅测试用夹具，绝不部署
│   ├── test/Voting.ts             # 8 个 viem + node:test 消费方测试
│   ├── scripts/                   # deploy / seed-local / export-abi / verify
│   └── hardhat.config.ts
├── web/                           # Next.js 层：界面 + 只读索引器 + REST API
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx           # 服务端预取，首屏即有真实数据
│   │   │   └── api/               # 5 个 Route Handler（health/candidates/results/voters/sync）
│   │   ├── components/            # Ballot / CandidateCard / ConsistencyBadge / WalletBar / Providers
│   │   ├── lib/
│   │   │   ├── indexer/plan.ts    # 纯函数：分块与重组判定（可单测，无 IO）
│   │   │   ├── indexer/decode.ts  # 事件解码
│   │   │   ├── indexer/sync.ts    # 事务、游标、幂等
│   │   │   ├── db/schema.ts       # 投影表结构（SQL 常量）
│   │   │   ├── data.ts            # 链上/索引两侧的统一读取入口
│   │   │   └── contracts/         # ABI 与部署地址（由 export-abi 生成）
│   │   └── instrumentation.ts     # 启动后台索引循环
│   ├── scripts/                   # migrate / drain / check-consistency / reorg-drill / refund-drill
│   └── test/                      # 81 个单测，不需要链或数据库
├── docs/aegis/                    # 设计规格、基线、12 条 ADR、实测校正记录
├── docker-compose.yml             # 可复现的 MySQL（3307，避让本机 3306）
└── .github/workflows/ci.yml       # 5 条流水线
```

### 关于 `web/src/lib/contracts` 的生成文件

`voting-abi.ts`、`deployments.ts` 与 `index.ts` 由 `pnpm export-abi` 生成并**入库提交**，这样应用无需先编译合约即可类型检查与构建。CI 中的 `abi-drift` 作业会重新生成并要求 `git diff` 为空，因此这份副本不可能悄悄过期。

这个字节级守护有一个前提：**产物只能包含可由链复现的字段**。所以 `deployments.ts` 刻意不发布 `deployedAt`——它是时间戳，任何一次本地部署都会改变它，留在里面会让这个检查在语义毫无变化时报红。想验证这一点，跑一遍就能看到：全新链上 `pnpm seed:local && pnpm export-abi`，`web/src/lib/contracts/` 下**没有任何改动**（`deployments/31337.json` 会因时间戳变化，那是部署溯源，不进产物）。

之所以不单独建一个 `packages/shared` 包，是因为它的唯一内容是生成物；放进 `web/` 让仓库保持"合约层 + Next 层"两层的结构。

---

## 参与贡献与安全

- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 环境、命令、**五条不可破坏的不变量**，以及为什么 `hardhat.config.ts` 里"缺失"的 invariant 配置块不应该被"修复"。
- [`SECURITY.md`](SECURITY.md) —— 已声明的设计取舍（哪些不是漏洞）、已被测试覆盖的攻击面，以及漏洞报告方式。

---

## License

MIT
