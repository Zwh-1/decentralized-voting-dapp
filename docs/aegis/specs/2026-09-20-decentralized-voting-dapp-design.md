# 去中心化投票应用（Decentralized Voting DApp）设计规格

日期：`2026-09-20`
状态：`待用户评审`
仓库根：`D:\桌面\实习项目\decentralized-voting-dapp`
类型：Design Spec（greenfield-feature + security-permission + persistence-migration）

---

## 0. Aegis Visibility

本规格存在的理由：原始方案（一份外部生成的四周计划）包含若干**在面试中无法辩护**的技术主张，若直接照做，会把"关键词堆砌"固化进代码与简历。本规格的作用是把每个技术点绑定到**可复现的证据**，并在动手前删掉空转的设计面（JWT、无外部调用的 `ReentrancyGuard`、以 IPFS 替代数据库、无法定义分子的"99% 准确率"）。

---

## 1. TaskIntentDraft

- **目标**：交付一个可从零复现、可现场演示、每个技术主张都有测试证据的全栈 Web3 投票应用，并开源到 GitHub。
- **成功证据**：
  1. `npx hardhat test --coverage` 输出可读报告，语句/分支覆盖率 ≥ 95%；
  2. 重入攻击对照测试通过（攻击合约对一个无防护的对照合约成功、对本项目合约必然 revert）；
  3. 索引进度一致性检查报告「偏差 0 条」；
  4. 合约在 Sepolia 有公开地址且源码已在 Etherscan 验证；
  5. 全新环境按 README 可一条命令跑通全部测试。
- **停止条件**：允许 `完成` / `阻塞` / `需验证` / `超出范围` 四种结局。
- **非目标**：见 §11。
- **风险提示**：Hardhat 3 为完全重写版本，插件生态与既有教程不匹配（§10）。

### BaselineReadSetHint

工作区在本规格之前为空，**不存在任何既有 baseline 文档、ADR 或代码**。因此无历史基线可读，不存在实现漂移风险；本规格即首个权威来源，其后的基线快照见 `docs/aegis/baseline/`。

### BaselineUsageDraft

```text
BaselineUsageDraft:
- Required baseline refs: 无（greenfield，工作区为空）
- Delivered context refs: 无
- Acknowledged before plan refs: 无
- Cited in design refs: 无
- Missing refs: 无（非缺失，而是尚不存在）
- Decision: continue
```

### ImpactStatementDraft

- **受影响层**：链上合约、链下索引器、MySQL schema、REST API、前端 dApp、CI、部署与开源包装。
- **不变量（invariants）**：
  1. **链上是唯一事实源**；MySQL 必须可随时 `DROP` 并从事件完整重建。
  2. 后端**永不持有任何私钥**，投票写入只由用户钱包直连合约签名。
  3. 任何事件被重复消费都不得改变聚合结果（幂等）。
  4. 同一地址在整个选举生命周期内最多计票一次。
- **兼容边界**：测试网（Sepolia）与本地 Hardhat 网络必须使用**同一份**合约源码与同一份 ABI；不允许为本地演示留后门分支。

---

## 2. Requirement Ready Check

```text
Requirement Ready Check:
- Requirement source refs: 用户提供的四周开发方案（对话中粘贴）+ 本会话确认的 6 项决策
- Goals and scope refs: §1 TaskIntentDraft、§11 非目标
- User / scenario refs: 管理员（发起选举、设候选人、管白名单）、白名单选民（投票、退还质押）、任意访客（查看结果）
- Requirement item refs: §4 合约 / §5 索引器 / §6 API / §7 前端 / §8 指标
- Acceptance / verification criteria refs: §8 指标体系、§9 里程碑验收
- Open blocker questions: 无
- Decision: ready
```

### 已确认的决策（本会话产出，不再重新讨论）

| # | 决策项 | 结论 |
|---|---|---|
| D1 | 投票隐私 | **明票上链**，在 README 显式声明「本 Demo 不含投票隐私」及原因 |
| D2 | 链下存储 | **MySQL 保留**，承担事件索引与聚合查询；**IPFS 只存候选人元数据**，链上存 CID |
| D3 | 交付边界 | **本地一条命令可复现 + Sepolia 真部署**（含 Etherscan 源码验证）；不做公网托管 |
| D4 | 合约工具链 | **Hardhat 3 + TypeScript**（用户明确拒绝 Foundry） |
| D5 | 重入防护 | **加投票质押 + 退还**，构造真实外部调用面，并写攻击合约做对照测试 |
| D6 | 后端职责 | **只读事件索引器**，后端不参与任何链上写入 |

---

## 3. 相对原始方案的修正清单

| # | 原始方案 | 问题 | 本方案的处理 |
|---|---|---|---|
| C1 | 简历「准确率达 99%」 | 投票合约无天然的"准确率"定义，无法回答"分子分母是什么" | 替换为 §8 的 6 项可复现指标；其中「索引一致性偏差 0 条」是唯一可称为"准确率"的量，且定义为 `一致记录数 / 总记录数` |
| C2 | `vote()` 内加 `ReentrancyGuard` | `vote()` 无外部调用 → 无重入面 → 面试官一问即崩 | 引入质押/退还路径创造真实外部调用；防护采用 **CEI（主）+ `nonReentrant`（纵深）**，并用攻击合约证明防护生效 |
| C3 | 后端 JWT 鉴权 + 限流 | 只读 API 没有写入面，JWT 是空转的复杂度 | **删除 JWT**；保留读接口限流。删除动作本身记入 §12 ADR 信号 |
| C4 | 用 IPFS 做链下存储 | IPFS 是内容寻址的不可变存储，无查询/聚合/事务/唯一约束，不能当数据库 | IPFS 仅存候选人宣言与头像；链上只存 CID；MySQL 保留索引职责（D2） |
| C5 | `address → candidate` 全部公开且不声明 | 投票隐私是投票类项目的核心难点，回避会被认为不懂行 | 明确选择明票并**主动声明取舍**，同时说明若要隐私需引入何种机制（D1） |
| C6 | 未提及事件重复消费与链重组 | 索引器最容易被追问且最容易出错的两点 | §5 用 `UNIQUE(tx_hash, log_index)` 幂等键 + 确认数 + 游标回退处理 |
| C7 | 测试网部署放在第 4 周 | Sepolia 需要 faucet 领测试 ETH，可能排队数天 | M1 起即申领并储备测试 ETH（§9） |
| C8 | "测试覆盖率 > 95%" 但未指定工具 | `solidity-coverage` 的 peer 是 `hardhat: ^2.11.0`，**不兼容 Hardhat 3** | 使用 Hardhat 3 原生 `--coverage`（§8），不安装该插件 |
| C9 | 用 `hardhat-gas-reporter` | peer 为 `hardhat: ^2.16.0`，**不兼容 Hardhat 3** | 使用 Hardhat 3 原生 `--gas-stats`（§8） |
| C10 | 未划分可独立交付的里程碑 | 一旦延期就交付不出任何完整成果 | §9 每个里程碑都是可独立演示、可写进简历的完整状态 |

---

## 4. 系统架构

```
                        读（查 MySQL 缓存）                getLogs 分块轮询
┌────────────────┐  ─────────────────────────▶  ┌──────────────────────┐  ──────────────▶  ┌──────────┐
│  web/ 前端      │                              │  indexer/ 只读服务    │  ◀──────────────  │  MySQL   │
│  Vite+React 19 │                              │  索引器 + REST API    │   幂等 upsert      │  事件缓存 │
│  wagmi/viem    │  ◀── 链上结果（用于比对） ────  └──────────────────────┘                    └──────────┘
└───────┬────────┘
        │  写：用户钱包直连合约签名（后端不参与）
        ▼
┌──────────────────────────┐      CID 解析      ┌──────────────┐
│  Voting.sol（Sepolia）    │  ───────────────▶  │  IPFS 网关    │  候选人宣言 / 头像
│  唯一事实源               │                    └──────────────┘
└──────────────────────────┘
```

**架构的核心不变量：链上是唯一事实源，MySQL 是可随时删除重建的只读投影。**

这条不变量一次性消除了原始方案里未被识别的双写一致性问题：不存在"链上成功、写库失败"需要补偿的窗口，因为后端从不写链。索引器只需保证「最终把全部事件读进来且不重复计数」，这被降级为一个**幂等+游标的单调推进问题**，可被精确测试。

### 仓库结构（pnpm workspace）

```
decentralized-voting-dapp/
├─ contracts/          Hardhat 3 + TS：合约、Solidity 测试、部署脚本
├─ indexer/            Node + TS：事件索引器、REST API、MySQL 迁移脚本
├─ web/                Vite + React 19 + wagmi：前端 dApp
├─ packages/shared/    ABI + 合约地址 + 事件类型（单一来源，防 ABI 漂移）
├─ docker-compose.yml  MySQL 8 本地实例
├─ .github/workflows/  CI：合约测试 + 覆盖率 + 索引器测试
└─ README.md           架构图、亮点、本地运行指南、截图
```

`packages/shared` 的存在理由：ABI 在 `contracts/`、`indexer/`、`web/` 三处被消费，复制粘贴必然漂移（改合约忘改 ABI = 运行期静默失败）。单一来源是这里唯一值得的额外复杂度。

---

## 5. 链上合约设计（`contracts/contracts/Voting.sol`）

### 5.1 技术选型

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.13.0（宿主 24.14.0） | Hardhat 3 要求 |
| hardhat | 3.17.0 | 完全重写版；ESM-first、`defineConfig` |
| @openzeppelin/contracts | 5.6.1 | `Ownable` 在 `access/`，`ReentrancyGuard` 已移至 `utils/`（5.0 起） |
| TypeScript | **~6.0.3** | 见 §14 校正 1：Hardhat 3 官方模板自行选择 `~6.0.3`，比原定 5.9.3 更可信 |
| Solidity | 0.8.37 | pin 精确版本，不用 `^`；M0 已实测该版本可正常下载与编译 |
| forge-std | `github:foundry-rs/forge-std#v1.16.2` | Solidity 测试的断言与 cheatcode 来源。**必须从 GitHub 安装**，见 §14 校正 3 |
| 配置格式 | `hardhat.config.ts` 用 `defineConfig`，项目 `"type": "module"` | Hardhat 3 强制 ESM 配置 |

### 5.2 状态与数据结构

```solidity
enum Phase { Setup, Voting, Ended }

struct Candidate {
    uint256 id;
    string  metadataCID;   // IPFS CID，指向 {name, slogan, avatar}
    uint256 voteCount;
}

Phase   public phase;               // 状态机，取代「开始时间/结束时间」两个时间戳
uint256 public constant STAKE = 0.001 ether;
uint256 public candidateCount;
mapping(uint256 => Candidate) public candidates;
mapping(address => bool) public isWhitelisted;
mapping(address => bool) public hasVoted;
mapping(address => uint256) public stakeOf;   // 尚未退还的质押
```

**为什么用状态机而不是两个时间戳**：时间戳方案下「投票中」是两个不等式的组合，`vote()` 需要重复判断时间边界，且无法表达「管理员提前结束」；状态机把合法性收敛到单点 `require(phase == Phase.Voting)`，绕过面更小，且阶段迁移本身可被事件审计。

### 5.3 接口

| 函数 | 权限 | 前置条件 | 说明 |
|---|---|---|---|
| `addCandidate(string metadataCID)` | `onlyOwner` | `phase == Setup` | 追加候选人，发 `CandidateAdded` |
| `setWhitelist(address[] voters, bool allowed)` | `onlyOwner` | `phase != Ended` | 批量增删白名单，发 `WhitelistUpdated` |
| `startVoting()` | `onlyOwner` | `phase == Setup` 且 `candidateCount > 0` | 迁移到 `Voting`，发 `PhaseChanged` |
| `endVoting()` | `onlyOwner` | `phase == Voting` | 迁移到 `Ended`，发 `PhaseChanged` |
| `vote(uint256 candidateId)` | 白名单 | `Voting` 阶段、未投过、`msg.value == STAKE` | `nonReentrant`，发 `VoteCast` |
| `refund()` | 质押人 | `phase == Ended`、`stakeOf[msg.sender] > 0` | `nonReentrant`，发 `Refunded` |
| `results()` | 只读 | — | 返回候选人票数，供前端与索引一致性比对 |

### 5.4 事件（索引器的唯一输入）

```solidity
event CandidateAdded(uint256 indexed id, string metadataCID);
event WhitelistUpdated(address indexed voter, bool allowed);
event PhaseChanged(Phase indexed from, Phase indexed to);
event VoteCast(address indexed voter, uint256 indexed candidateId, uint256 newCount);
event Refunded(address indexed voter, uint256 amount);
```

事件的 `indexed` 选择是刻意的：`voter` 与 `candidateId` 被索引，使索引器可以按地址或候选人做过滤查询；`newCount` 不索引，作为该票生效后的即时快照，便于比对链上与链下状态是否收敛。

### 5.5 重入防护：为什么它在这里是真实的

`refund()` 含真实外部调用：

```solidity
(bool ok, ) = payable(msg.sender).call{value: amount}("");
require(ok, "refund failed");
```

**两层防护**：
1. **CEI（主）**：`stakeOf[msg.sender] = 0;` 在 `call` **之前**执行；
2. **`nonReentrant`（纵深）**：即使未来有人重排语句，攻击仍然失败。

**测试如何证明防护有效**（这是"重入攻击防护"这一简历主张的证据）：

- 测试夹具 `contracts/test/VulnerableRefund.sol`（**仅测试用，绝不进入部署路径**）：逻辑相同但**既不做 CEI 也不加守卫**；
- 攻击合约 `RefundAttacker.sol`：在 `receive()` 中重入 `refund()`；
- 断言 1：对 `VulnerableRefund` 发起攻击 → 攻击者取回**超过单份质押**的金额（攻击成功，证明攻击手法有效）；
- 断言 2：对 `Voting` 发起同样攻击 → 整个交易 revert，且合约余额与 `stakeOf` 不变（证明防护有效）。

**诚实说明（写进 README）**：CEI 单独就足以阻止该重入，`nonReentrant` 属纵深防御。这个区分比"盲目加守卫"更能说明理解原理。

### 5.6 质押机制的真实作用与已知代价

- **它不是女巫防护**。质押在选举结束后全额退还，攻击者零净成本；真正的女巫防护是**管理员白名单**。
- 它的正当作用是：**创造真实的外部调用面**，使重入防护可被攻击测试验证（对应简历主张）。
- **已知代价**：未主动调用 `refund()` 的选民，其质押将永久锁定在合约中。处理方式：`endVoting()` 后设 30 天宽限期，之后 `onlyOwner` 的 `sweepUnclaimed()` 可将余额转入指定的金库地址，并发出 `UnclaimedSwept` 事件。该函数是额外的中心化权限点，将在 README 的「已知中心化风险」一节明确列出。

### 5.7 访问控制与校验顺序

- 继承 OZ `Ownable`；部署者即管理员。
- 全部状态变更函数遵循 **Checks → Effects → Interactions**，状态更新先于事件发出。
- `vote()` 的校验顺序（顺序固定，便于测试断言具体 revert 原因）：阶段 → 白名单 → 未投票 → 候选人存在 → 质押金额精确匹配。
- 自定义 error（而非字符串 require）以省 gas 并让测试可精确断言 `expectRevert`。

---

## 6. 链下索引器设计（`indexer/`）

### 6.1 MySQL schema

```sql
CREATE TABLE candidates (
  id            INT UNSIGNED     NOT NULL PRIMARY KEY,
  metadata_cid  VARCHAR(128)     NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_candidates_log (tx_hash, log_index)
) ENGINE=InnoDB;

CREATE TABLE votes (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  voter         CHAR(42)         NOT NULL,
  candidate_id  INT UNSIGNED     NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_votes_log (tx_hash, log_index),   -- 幂等键
  KEY idx_votes_candidate (candidate_id),
  KEY idx_votes_voter (voter)
) ENGINE=InnoDB;

CREATE TABLE refunds (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  voter         CHAR(42)         NOT NULL,
  amount_wei    DECIMAL(38,0)    NOT NULL,
  block_number  BIGINT UNSIGNED  NOT NULL,
  tx_hash       CHAR(66)         NOT NULL,
  log_index     INT UNSIGNED     NOT NULL,
  UNIQUE KEY uk_refunds_log (tx_hash, log_index)  -- 幂等键
) ENGINE=InnoDB;

CREATE TABLE sync_cursor (
  id          TINYINT          NOT NULL PRIMARY KEY DEFAULT 1,
  last_block  BIGINT UNSIGNED  NOT NULL,
  updated_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
```

**`UNIQUE(tx_hash, log_index)` 是整个索引器正确性的支点**：链上同一事件在重放、重启补历史、RPC 重复返回时都携带相同的 `(tx_hash, log_index)`，因此写入用 `INSERT ... ON DUPLICATE KEY UPDATE id = id`（空更新）即可实现幂等，无需应用层去重逻辑。

### 6.2 同步协议

```
CONFIRMATIONS = 5            // 只处理 head-5 之前的日志，规避链重组
CHUNK_BLOCKS  = 2_000        // 单次 getLogs 的最大区块跨度

loop:
  head  = provider.getBlockNumber()
  safe  = head - CONFIRMATIONS
  from  = cursor.last_block + 1
  to    = min(safe, from + CHUNK_BLOCKS - 1)
  if from > safe: sleep(POLL_INTERVAL); continue

  logs = getLogs({ address, fromBlock: from, toBlock: to, topics: ALL_EVENTS })

  BEGIN TRANSACTION
    幂等插入 candidates / votes / refunds
    UPDATE sync_cursor SET last_block = to      // 与插入同事务
  COMMIT
```

- **崩溃一致性**：事件插入与游标推进在同一事务内提交。不存在"事件已入库但游标未推进"（导致重复消费，被幂等键吃掉）或"游标已推进但事件未入库"（导致永久丢事件）的中间态。
- **失败与重试**：RPC 报错时**不推进游标**，指数退避（1s → 2s → 4s，上限 30s）。
- **链重组处理**：启动时若发现 `head < cursor.last_block`（链发生回退），则把游标回退到 `head - CONFIRMATIONS`，并删除 `block_number > head - CONFIRMATIONS` 的 votes / refunds / candidates 记录，然后重新向前索引。由于只处理 5 确认后的区块，该路径在实践中极少触发，但**必须有代码路径**，否则一次重组会留下永久性错误数据。
- **可观测性**：`GET /api/health` 返回 `chainHead`、`indexedBlock`、`lagBlocks`；`lagBlocks` 持续增长即为索引器停摆的告警信号。

### 6.3 REST API（Express 5 + zod 校验）

| 端点 | 说明 |
|---|---|
| `GET /api/health` | `{ chainHead, indexedBlock, lagBlocks, phase }` |
| `GET /api/candidates` | 候选人列表 + MySQL 聚合票数 + 元数据 CID |
| `GET /api/results` | **同时返回链上 `results()` 与 MySQL 聚合结果，以及 `consistent: boolean`** |
| `GET /api/voters/:address` | 该地址是否已投、质押金额、是否已退还 |

**`/api/results` 的双源返回是本设计的关键设计**：它把"链上与链下是否一致"从一句口头承诺变成每次请求都可见的运行时事实，同时为 §8 的索引一致性指标提供了测量入口。

**鉴权策略**：全部端点为只读，**不引入 JWT**（原始方案的 JWT 是为写入面准备的，本项目写入面在链上、由钱包签名）。仅使用 `express-rate-limit` 做读接口防刷。

---

## 7. IPFS 的职责与前端设计

### 7.1 IPFS 边界

- 候选人元数据 `{ name, slogan, avatar }` 以 JSON 形式 pin 到 IPFS，返回 CID；
- 链上 `Candidate.metadataCID` 只存该 CID；
- 前端通过 HTTPS 网关解析 CID，**并带本地兜底**：网关失败时降级显示候选人 `id` 与 CID 前缀，不阻塞投票流程。

**为什么这样切分**：CID 与内容绑定，元数据一旦上链即不可篡改，正好与链上地址互补；而票数聚合、唯一性约束、条件查询这些 IPFS 不具备的能力（无查询、无事务、无唯一约束、不可变 → 改一个错别字就要换 CID 并更新链上指针）留在 MySQL。

**实测约束**：本机对 `ipfs.io` 与 `dweb.link` 的请求均返回 429（限流），`up.storacha.network` TLS 连接被重置。因此 pinning 服务的选择需在 M0 实测后确定，且前端必须有网关失败兜底。

### 7.2 前端（`web/`）

| 项 | 版本 |
|---|---|
| Vite | 8.3.0 |
| React | 19.3.0 |
| wagmi | 3.7.7 |
| viem | 2.56.8 |
| @tanstack/react-query | 5.103.1 |
| TailwindCSS | 4.3.3 |

**选 Vite 而非 Next.js 的理由**：本项目是纯客户端 dApp，没有需要 SSR 的内容；Next.js 的服务端渲染与钱包连接存在天然的客户端边界摩擦，对 Demo 只增加复杂度而不带来收益。

页面与状态：

1. **连接钱包**（MetaMask）：未安装、未连接、链 ID 错误（提示并一键切换 Sepolia）三种状态。
2. **投票主页**：候选人卡片（头像/宣言）、实时票数进度条、当前阶段标识。
3. **投票操作**：显示质押金额与 Gas 预估；交易状态机 `idle → 签名中 → pending → confirming → confirmed → 失败(原因)`。
4. **退款**：仅在 `Ended` 阶段且存在未退还质押时可见。
5. **管理员后台**：`addCandidate`、`setWhitelist`、`startVoting`、`endVoting`；非管理员地址访问时只读并说明原因。

**读路径的取舍**：列表与票数走 MySQL（快），由此产生的"可能落后链上若干区块"由页面显式的索引高度提示（`已索引至 #block / 链上 #block`）来消解——这比假装数据永远最新更诚实。

---

## 8. 指标体系（替代"准确率达 99%"）

所有指标必须能在本地一条命令复现。**gas 必须在非 coverage 模式下测量**——Hardhat 文档明确 `--coverage` 会放大字节码与 gas 消耗，用覆盖率模式下的 gas 数字会得到错误结论。

| # | 指标 | 命令 / 方式 | 目标 |
|---|---|---|---|
| M-1 | 合约测试覆盖率 | `npx hardhat test --coverage`（终端报告 + `coverage/lcov.info` + `coverage/html/index.html`） | **行覆盖率与语句覆盖率** ≥ 95%（见 §14 校正 2：Hardhat 3 不产出分支覆盖率） |
| M-2 | 授权拦截完整性 | Solidity 测试，`expectRevert` 断言自定义 error | 非白名单、重复投票、阶段错误、金额不符、非管理员 → 全部 revert，0 例外 |
| M-3 | 重入攻击对照 | 攻击合约对 `VulnerableRefund` 成功、对 `Voting` revert | 两条断言均通过（§5.5） |
| M-4 | 不变量（fuzz / invariant） | 随机 1000 次投票后断言 `Σ voteCount == VoteCast 事件数 == hasVoted 为真的地址数` | 反例 0 个 |
| M-5 | Gas 成本 | `npx hardhat test --gas-stats --gas-stats-json gas-stats.json` | 记录 `vote` / `refund` 的 min/avg/median/max，写入 README |
| M-6 | 索引一致性 | 灌入 200 票后请求 `/api/results`，比对 `onChain` 与 `indexed` | **偏差 0 条**；此即唯一可称为"准确率"的量：`一致记录数 / 总记录数 = 200/200` |

**关于简历表述的建议**：把"准确率达 99%"替换为可直接复现的描述，例如「合约测试覆盖率 96%、1000 轮不变量测试 0 反例、索引器与链上状态一致性偏差 0/200」。带具体分母的数字才经得起追问；而"99%"既无法定义分子，也无法现场复现。

---

## 9. 里程碑（每个均可独立演示与独立写进简历）

| 里程碑 | 内容 | 验收（可演示的状态） |
|---|---|---|
| **M0** 骨架与 CI | pnpm workspace、`contracts/`（Hardhat 3 ESM 配置）、`docker-compose.yml`（MySQL 8）、GitHub Actions 跑合约测试；**申领 Sepolia 测试 ETH 并开始储备**；确定 pinning 服务 | 全新 clone 后一条命令跑通空测试套件 |
| **M1** 合约与测试 | `Voting.sol`、`VulnerableRefund.sol`（仅测试）、`RefundAttacker.sol`、完整测试套件、部署脚本 | `--coverage` 报告 ≥95%；M-2/M-3/M-4 全绿；**此里程碑已足以支撑简历的合约部分** |
| **M2** 索引器与 API | schema 迁移、游标索引器、REST API、`/api/results` 双源比对 | M-6 偏差 0/200；断点续跑与重组回退有测试覆盖 |
| **M3** 前端与联调 | 钱包连接、投票、退款、管理员后台、索引高度提示 | 端到端手动走通一遍；产出截图与 GIF |
| **M4** 部署与开源包装 | Sepolia 部署 + Etherscan 验证、README（架构图/亮点/本地运行指南/指标表）、MIT 协议、Conventional Commits | 有公开合约地址与可访问的仓库 |

**排期风险与降级策略**：4 周 × 3-4 h/天 ≈ 80-110 小时，此范围偏紧。若时间不足，**优先保证 M1 完整**——合约与测试是简历主张的核心，且它是唯一无需任何外部依赖（faucet、数据库、网关）即可完整交付的部分。M3/M4 可延后而不损害 M1 的价值。

---

## 10. 风险登记

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | Hardhat 3 是完全重写版，绝大多数既有教程与 LLM 记忆基于 Hardhat 2，照抄会失败 | 高 | 只依据官方 Hardhat 3 文档；已知 `solidity-coverage`、`hardhat-gas-reporter` **不可用**（peer 为 `^2.x`），改用原生 `--coverage` 与 `--gas-stats`；ESM 配置、`defineConfig`、显式网络连接均为新 API |
| R2 | 插件生态缺口（如需要额外的检查/报告插件） | 中 | 优先用原生能力；确需插件时先核对 peer 范围是否含 `^3` |
| R3 | Sepolia faucet 领币可能排队或限流 | 中 | M0 即开始申领储备；本地 Hardhat 网络始终是主开发环境，部署只是最后一步 |
| R4 | IPFS 网关限流（实测 429），pinning 服务可用性待定（Storacha TLS 不通） | 中 | M0 实测候选服务；前端强制网关失败兜底，不阻塞投票主流程 |
| R5 | TypeScript 7.0.2 与 typed-lint/框架插件的兼容性未知 | 中 | 固定 5.9.3（§5.1） |
| R6 | wagmi 3.x + React 19 + Vite 8 + Tailwind 4 是较新组合，文档可能滞后 | 中 | 前端问题不阻塞合约与索引器交付；必要时降级到更成熟的组合版本 |
| R7 | 质押资金未领取时永久锁定 | 低 | `sweepUnclaimed()` + 30 天宽限期（§5.6），并在 README 列为已知中心化风险 |
| R8 | 时间预算紧张 | 高 | 里程碑可独立交付（§9）；M1 为不可妥协的核心 |

---

## 11. 非目标（明确排除，防止范围蔓延）

1. **不做投票隐私**（commit-reveal / 零知识 / MACI）。明票上链，在 README 显式声明取舍与理由（D1）。
2. **不做 Gas 代付 / 账户抽象**。后端永不持有私钥（不变量 2）。
3. **不做多轮次选举、提案制、委托投票**。
4. **不做 Token 门控**（ERC-20 持仓快照 / Merkle 空投白名单）。白名单用管理员 `mapping` 手工维护。
5. **不做 The Graph / subgraph**。刻意自建 TS + MySQL 索引器——这是简历中 TS 与 MySQL 主张的支撑点。
6. **不做公网托管部署**。交付边界止于「本地可复现 + Sepolia 合约已验证」（D3）。
7. **不做移动端适配与国际化**。

---

## 12. ADR 信号（留待实现后回填，此刻不创建已接受的架构记忆）

| ADR | 主题 | 真实备选 | 待验证问题 |
|---|---|---|---|
| ADR-1 | 链上唯一事实源 + 只读事件索引器，取代双写 | 后端代发交易（Gas 代付）；前端直连链无索引器 | 删除 JWT 与写入 API 后，简历的"后端开发"分量是否仍成立？ |
| ADR-2 | 采用 Hardhat 3 而非 Hardhat 2 | Hardhat 2.29.1 + `solidity-coverage` + `hardhat-gas-reporter` | Hardhat 3 的插件缺口在 M2/M3 是否会成为阻塞？ |
| ADR-3 | 明票上链，主动声明隐私取舍 | commit-reveal 两阶段；Merkle + nullifier 匿名投票 | 面试中"为什么不做隐私"的回答是否充分？ |
| ADR-4 | IPFS 仅承载候选人元数据 | 元数据存 MySQL；元数据全部上链 | 网关限流（429）是否影响演示可靠性？ |
| ADR-5 | 引入质押/退还以构造真实重入面 | 不引入质押，改简历表述；仅写独立的重入演示合约 | 质押带来的资金锁定与额外权限点是否值得？ |

---

## 13. Spec Self-Review

- **占位符扫描**：无 TBD / TODO。§7.1 的 pinning 服务与 §10 R4 是**带验证动作的待测项**（M0 实测），非占位符。
- **内部一致性**：D1-D6 与 §3 修正清单、§5 合约、§6 索引器、§11 非目标逐条对应；§5.6 已修正"质押防女巫"这一错误主张；§8 明确 gas 不得在 coverage 模式下测量。
- **范围检查**：单一实现计划可覆盖，但跨度较大；里程碑已按可独立交付切分（§9）。
- **歧义检查**：「准确率」只剩 M-6 一个精确定义（`一致记录数 / 总记录数`），其余改为覆盖率/反例数/gas 这类无歧义量。
- **边界检查**：不变量（§1）、非目标（§11）、兼容边界（测试网与本地同源码同 ABI）、ADR 信号（§12）均已显式标注。

---

## 14. M0 实测校正记录

以下为 M0 实际执行中发现与本规格不符的事实，均已原地修正（不另开文档）。每条都附实测证据。

### 校正 1：TypeScript 版本 5.9.3 → ~6.0.3

`hardhat --init --template minimal` 官方脚手架自行安装的是 `typescript@~6.0.3`。这是 Hardhat 官方对自身工具链的实证选择，比我原先"避开 TS 7 就退到 5.9.3"的推测更可信。原判断（避开 TS 7 原生编译器重写）仍成立，只是安全落点从 5.9.3 前移到 6.0.3。

证据：`npx hardhat@3.17.0 --init --template minimal` 输出 `npm install --save-dev "hardhat@^3.17.0" "@types/node@^22.8.5" "typescript@~6.0.3"`。

### 校正 2：覆盖率指标不含分支覆盖率

实测 `hardhat test --coverage` 的报告表头为 `File Path | Line % | Statement % | Uncovered Lines`——**Hardhat 3 内置覆盖率只产出行覆盖率与语句覆盖率，没有分支覆盖率**。原规格写的"语句与分支覆盖率 ≥95%"是无法测量的目标。M-1 已改为"行覆盖率与语句覆盖率 ≥95%"。

证据：M0 冒烟运行输出 `contracts\Smoke.sol | 100.00 | 100.00`，并生成 `coverage/lcov.info` 与 `coverage/html/index.html`。

### 校正 3：forge-std 必须从 GitHub 安装

npm 上的 `forge-std@1.1.2` 是**非官方分发**（`package.json.description` 自述 "Unofficial NPM distribution of Forge Standard Library"，`repository.url` 指向 `github.com/shunkakinoki/contracts`），且文件位于包根目录而非 `src/`，导致 Hardhat 的 `exports` 解析报错：

```
Error HHE902: There was an error while resolving the import "forge-std/Test.sol"
The file "src/Test.sol" doesn't exist within the package.
```

官方文档规定从 GitHub 安装。改用 `github:foundry-rs/forge-std#v1.16.2` 后解析正常。

**副作用（已列入风险）**：该依赖需要访问 GitHub。本机实测出现 `ECONNRESET` 重试两次后成功，安装耗时 1 分 41 秒。因此 `pnpm install` 在弱网环境下可能失败，README 需注明重试。

### 校正 4：pnpm 11 的构建脚本白名单字段是 `allowBuilds`

pnpm 11 默认阻止依赖的生命周期脚本，`esbuild`（Hardhat 工具链的传递依赖）因此未执行 postinstall，导致 `pnpm install` 以 exit 1 失败（`ERR_PNPM_IGNORED_BUILDS`）。pnpm 会自动在 `pnpm-workspace.yaml` 写入占位符：

```yaml
allowBuilds:
  esbuild: set this to true or false
```

填为 `true` 后安装正常。注意字段名是 `allowBuilds`（映射），不是旧版的 `onlyBuiltDependencies`（列表）。

### 校正 5：Solidity 测试与夹具的目录约定

官方约定为：`test/` 目录下的 `.sol` 文件，或 `contracts/` 目录下以 `.t.sol` 结尾的文件，都被视为 Solidity 测试文件。本规格据此固定：

- `contracts/contracts/*.t.sol` —— Solidity 测试（forge-std `Test` 基类，支持 fuzz 与 invariant）；
- `contracts/contracts/test/` —— 仅测试用的夹具合约（`VulnerableRefund.sol`、`RefundAttacker.sol`），通过 `coverage.skipFiles: ["**/test/**", "**/*.t.sol"]` 排除在覆盖率分母之外；
- `contracts/test/*.ts` —— `node:test` + viem 的 TypeScript 测试。

**Solidity 测试跟随官方教程放在 `contracts/` 内**，而非 `test/solidity/`，以规避 `paths.tests.solidity` 的额外配置风险。

### 校正 6：Solidity 0.8.37 确认可用

原规格 pin 的 `0.8.37` 可用（M0 编译实测：`Compiled 2 Solidity files with solc 0.8.37`），无需回退到模板默认的 0.8.34。

### 遗留的复现风险

- **GitHub 连通性**：`forge-std` 的 git 依赖在弱网下可能安装失败（校正 3）。
- **工具链版本漂移**：`hardhat`, `viem`, `@nomicfoundation/*` 均以精确版本固定；任一升级需重跑 M-1 … M-6。
- **`test.solidity.invariant.runs` 设为 1000**：M-4 的 1000 轮证据来自该配置，属实测运行时间与证据强度的折中（每次运行最多 100 次调用）。
