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

| #   | 决策项     | 结论                                                                           |
| --- | ---------- | ------------------------------------------------------------------------------ |
| D1  | 投票隐私   | **明票上链**，在 README 显式声明「本 Demo 不含投票隐私」及原因                 |
| D2  | 链下存储   | **MySQL 保留**，承担事件索引与聚合查询；**IPFS 只存候选人元数据**，链上存 CID  |
| D3  | 交付边界   | **本地一条命令可复现 + Sepolia 真部署**（含 Etherscan 源码验证）；不做公网托管 |
| D4  | 合约工具链 | **Hardhat 3 + TypeScript**（用户明确拒绝 Foundry）                             |
| D5  | 重入防护   | **加投票质押 + 退还**，构造真实外部调用面，并写攻击合约做对照测试              |
| D6  | 后端职责   | **只读事件索引器**，后端不参与任何链上写入                                     |

---

## 3. 相对原始方案的修正清单

| #   | 原始方案                               | 问题                                                                    | 本方案的处理                                                                                                       |
| --- | -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| C1  | 简历「准确率达 99%」                   | 投票合约无天然的"准确率"定义，无法回答"分子分母是什么"                  | 替换为 §8 的 6 项可复现指标；其中「索引一致性偏差 0 条」是唯一可称为"准确率"的量，且定义为 `一致记录数 / 总记录数` |
| C2  | `vote()` 内加 `ReentrancyGuard`        | `vote()` 无外部调用 → 无重入面 → 面试官一问即崩                         | 引入质押/退还路径创造真实外部调用；防护采用 **CEI（主）+ `nonReentrant`（纵深）**，并用攻击合约证明防护生效        |
| C3  | 后端 JWT 鉴权 + 限流                   | 只读 API 没有写入面，JWT 是空转的复杂度                                 | **删除 JWT**；保留读接口限流。删除动作本身记入 §12 ADR 信号                                                        |
| C4  | 用 IPFS 做链下存储                     | IPFS 是内容寻址的不可变存储，无查询/聚合/事务/唯一约束，不能当数据库    | IPFS 仅存候选人宣言与头像；链上只存 CID；MySQL 保留索引职责（D2）                                                  |
| C5  | `address → candidate` 全部公开且不声明 | 投票隐私是投票类项目的核心难点，回避会被认为不懂行                      | 明确选择明票并**主动声明取舍**，同时说明若要隐私需引入何种机制（D1）                                               |
| C6  | 未提及事件重复消费与链重组             | 索引器最容易被追问且最容易出错的两点                                    | §5 用 `UNIQUE(tx_hash, log_index)` 幂等键 + 确认数 + 游标回退处理                                                  |
| C7  | 测试网部署放在第 4 周                  | Sepolia 需要 faucet 领测试 ETH，可能排队数天                            | M1 起即申领并储备测试 ETH（§9）                                                                                    |
| C8  | "测试覆盖率 > 95%" 但未指定工具        | `solidity-coverage` 的 peer 是 `hardhat: ^2.11.0`，**不兼容 Hardhat 3** | 使用 Hardhat 3 原生 `--coverage`（§8），不安装该插件                                                               |
| C9  | 用 `hardhat-gas-reporter`              | peer 为 `hardhat: ^2.16.0`，**不兼容 Hardhat 3**                        | 使用 Hardhat 3 原生 `--gas-stats`（§8）                                                                            |
| C10 | 未划分可独立交付的里程碑               | 一旦延期就交付不出任何完整成果                                          | §9 每个里程碑都是可独立演示、可写进简历的完整状态                                                                  |

---

## 4. 系统架构

```
                           读（查 MySQL 缓存）                    getLogs 分块轮询
┌──────────────────────────────────────────────────┐  ─────────────────────────────▶  ┌──────────┐
│  web/  Next.js 层（单个进程）                      │  ◀─────────────────────────────  │  MySQL   │
│  ┌──────────────────┐    ┌────────────────────┐  │      幂等 upsert（可选依赖）      │  事件缓存 │
│  │ 投票界面          │◀───│ Route Handlers     │  │                                 └──────────┘
│  │ wagmi / viem     │    │ 只有 GET + SELECT   │  │
│  └────────┬─────────┘    └─────────▲──────────┘  │
│           │              ┌─────────┴──────────┐  │
│           │              │ 只读索引器          │  │
│           │              │ 游标/确认数/重组修复 │  │
└───────────┼──────────────┴─────────▲──────────┘──┘
            │  写：用户钱包直连合约签名（后端不参与）
            │  读：权威票数 / 我的状态（直接读链，不经索引）
            ▼
┌──────────────────────────┐      CID 解析      ┌──────────────┐
│  Voting.sol（Sepolia）    │  ───────────────▶  │  IPFS 网关    │  候选人宣言 / 头像
│  唯一事实源               │                    └──────────────┘
└──────────────────────────┘
```

**架构的核心不变量：链上是唯一事实源，MySQL 是可随时删除重建的只读投影。**

这条不变量一次性消除了原始方案里未被识别的双写一致性问题：不存在"链上成功、写库失败"需要补偿的窗口，因为后端从不写链。索引器只需保证「最终把全部事件读进来且不重复计数」，这被降级为一个**幂等+游标的单调推进问题**，可被精确测试。

### 仓库结构（pnpm workspace，两层）

```
decentralized-voting-dapp/
├─ contracts/          Hardhat 3 + TS：合约、Solidity 测试、部署脚本
├─ web/                Next.js 16 + TS：投票界面 + 只读索引器 + Route Handlers
│   ├─ src/lib/contracts/  ABI + 合约地址（由 export-abi 生成，防 ABI 漂移）
│   └─ scripts/            migrate / drain / check-consistency
├─ docker-compose.yml  MySQL 8 本地实例
├─ .github/workflows/  CI：合约测试与覆盖率 + ABI 漂移 + Next 层类型/单测/构建
└─ README.md           架构图、亮点、本地运行指南、截图
```

**为什么是两层而不是三层**：索引器与本应用共享同一个部署单元、同一次 `pnpm install`、同一份配置，它没有独立的生命周期，因此不值得单独成包。原本计划的 `packages/shared` 也一并取消——它的唯一内容是生成物，放进 `web/src/lib/contracts/` 即可让仓库保持"合约层 + Next 层"的结构，同时仍然只有一个 ABI 来源。

**ABI 单一来源的理由**：ABI 在合约测试、索引器解码、前端调用三处被消费，复制粘贴必然漂移（改合约忘改 ABI = 运行期静默失败）。生成物入库提交，CI 重新生成并要求 `git diff` 为空。

---

## 5. 链上合约设计（`contracts/contracts/Voting.sol`）

### 5.1 技术选型

| 项                      | 版本                                                           | 说明                                                                        |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Node.js                 | ≥ 22.13.0（宿主 24.14.0）                                      | Hardhat 3 要求                                                              |
| hardhat                 | 3.17.0                                                         | 完全重写版；ESM-first、`defineConfig`                                       |
| @openzeppelin/contracts | 5.6.1                                                          | `Ownable` 在 `access/`，`ReentrancyGuard` 已移至 `utils/`（5.0 起）         |
| TypeScript              | **~6.0.3**                                                     | 见 §14 校正 1：Hardhat 3 官方模板自行选择 `~6.0.3`，比原定 5.9.3 更可信     |
| Solidity                | 0.8.37                                                         | pin 精确版本，不用 `^`；M0 已实测该版本可正常下载与编译                     |
| forge-std               | `github:foundry-rs/forge-std#v1.16.2`                          | Solidity 测试的断言与 cheatcode 来源。**必须从 GitHub 安装**，见 §14 校正 3 |
| 配置格式                | `hardhat.config.ts` 用 `defineConfig`，项目 `"type": "module"` | Hardhat 3 强制 ESM 配置                                                     |

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

| 函数                                           | 权限        | 前置条件                                    | 说明                                   |
| ---------------------------------------------- | ----------- | ------------------------------------------- | -------------------------------------- |
| `addCandidate(string metadataCID)`             | `onlyOwner` | `phase == Setup`                            | 追加候选人，发 `CandidateAdded`        |
| `setWhitelist(address[] voters, bool allowed)` | `onlyOwner` | `phase != Ended`                            | 批量增删白名单，发 `WhitelistUpdated`  |
| `startVoting()`                                | `onlyOwner` | `phase == Setup` 且 `candidateCount > 0`    | 迁移到 `Voting`，发 `PhaseChanged`     |
| `endVoting()`                                  | `onlyOwner` | `phase == Voting`                           | 迁移到 `Ended`，发 `PhaseChanged`      |
| `vote(uint256 candidateId)`                    | 白名单      | `Voting` 阶段、未投过、`msg.value == STAKE` | `nonReentrant`，发 `VoteCast`          |
| `refund()`                                     | 质押人      | `phase == Ended`、`stakeOf[msg.sender] > 0` | `nonReentrant`，发 `Refunded`          |
| `results()`                                    | 只读        | —                                           | 返回候选人票数，供前端与索引一致性比对 |

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

## 6. 链下索引器设计（现位于 `web/src/lib/indexer/`）

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

### 6.3 REST API（Next.js Route Handlers）

| 端点                       | 说明                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `GET /api/health`          | `{ chainHead, lastIndexedBlock, lagBlocks, indexEnabled, phase }`          |
| `GET /api/candidates`      | 候选人列表 + 聚合票数 + 元数据 CID + `source`（`chain` / `index`）         |
| `GET /api/results`         | **同时返回链上 `results()` 与 MySQL 聚合结果，以及 `consistent: boolean`** |
| `GET /api/voters/:address` | 该地址是否已投、投给谁、质押金额、是否已退还                               |
| `POST /api/index/sync`     | 推进索引一步（先修重组，再索引下一段已确认区块）                           |

**`/api/results` 的双源返回是本设计的关键设计**：它把"链上与链下是否一致"从一句口头承诺变成每次请求都可见的运行时事实，同时为 §8 的索引一致性指标提供了测量入口。不一致时该端点返回 **HTTP 500** 与逐候选人差异，避免调用方把错误数据当成可用结果。

**降级行为**：未配置 `DATABASE_URL` 时，`/api/results` 返回 `mode: "chain-only"`、`indexed: null`，并**仍然**断言 `consistent: true`——因为此时并不存在可比对的第二个来源。它绝不谎称做过一次没做的比对。

**鉴权策略**：全部端点为只读，**不引入 JWT**（原始方案的 JWT 是为写入面准备的，本项目写入面在链上、由钱包签名）。读接口的防刷由部署层承担，应用内不再引第三方限流中间件。

---

## 7. IPFS 的职责与前端设计

### 7.1 IPFS 边界

- 候选人元数据 `{ name, slogan, avatar }` 以 JSON 形式 pin 到 IPFS，返回 CID；
- 链上 `Candidate.metadataCID` 只存该 CID；
- 前端通过 HTTPS 网关解析 CID，**并带本地兜底**：网关失败时降级显示候选人 `id` 与 CID 前缀，不阻塞投票流程。

**为什么这样切分**：CID 与内容绑定，元数据一旦上链即不可篡改，正好与链上地址互补；而票数聚合、唯一性约束、条件查询这些 IPFS 不具备的能力（无查询、无事务、无唯一约束、不可变 → 改一个错别字就要换 CID 并更新链上指针）留在 MySQL。

**实测约束**：本机对 `ipfs.io` 与 `dweb.link` 的请求均返回 429（限流），`up.storacha.network` TLS 连接被重置。因此 pinning 服务的选择需在 M0 实测后确定，且前端必须有网关失败兜底。

### 7.2 Next.js 层（`web/`）

| 项                    | 版本    |
| --------------------- | ------- |
| Next.js               | 16.3.5  |
| React                 | 19.3.0  |
| wagmi                 | 3.7.7   |
| viem                  | 2.56.8  |
| @tanstack/react-query | 5.103.1 |
| TailwindCSS           | 4.3.3   |
| mysql2                | 3.24.4  |

**选 Next.js 而非 Vite SPA 的理由**：本项目虽然不需要 SEO，但需要**一个服务端的、只读的数据投影层**。把索引器与 REST 接口放进同一个 Next 应用，让页面首屏可以由 Server Component 直接读取真实数据（首屏即有一致性结论，而不是先闪一个 loading），同时索引逻辑与 UI 共享同一份 ABI 与配置，省掉了一个部署单元、一份配置和一次跨进程契约。代价是钱包状态存在客户端边界，这一点用 `useMounted()` 在挂载后再渲染钱包相关 UI 来处理，避免 hydration 不一致。

页面与状态：

1. **连接钱包**（MetaMask）：未安装、未连接、链 ID 错误（提示并一键切换 Sepolia）三种状态。
2. **投票主页**：候选人卡片（头像/宣言）、实时票数进度条、当前阶段标识。
3. **投票操作**：显示质押金额与 Gas 预估；交易状态机 `idle → 签名中 → pending → confirming → confirmed → 失败(原因)`。
4. **退款**：仅在 `Ended` 阶段且存在未退还质押时可见。
5. **管理员后台**：`addCandidate`、`setWhitelist`、`startVoting`、`endVoting`；非管理员地址访问时只读并说明原因。

**读路径的取舍**：**票数与"我是否已投票"这类不能出错的读，一律直接读链**；索引只用于列表、历史与聚合查询。由此产生的"索引可能落后链上若干区块"由页面显式的索引高度提示（`已索引至 #block / 链上 #block`）来消解——这比假装数据永远最新更诚实，也比让用户因为索引落后而看到错误票数更安全。

---

## 8. 指标体系（替代"准确率达 99%"）

所有指标必须能在本地一条命令复现。**gas 必须在非 coverage 模式下测量**——Hardhat 文档明确 `--coverage` 会放大字节码与 gas 消耗，用覆盖率模式下的 gas 数字会得到错误结论。

| #   | 指标           | 命令 / 方式                                                                                                                                 | 目标                                                                         |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| M-1 | 合约测试覆盖率 | `npx hardhat test --coverage`（终端报告 + `coverage/lcov.info` + `coverage/html/index.html`）                                               | **行覆盖率与语句覆盖率** ≥ 95%（见 §14 校正 2：Hardhat 3 不产出分支覆盖率）  |
| M-2 | 授权拦截完整性 | Solidity 测试，`expectRevert` 断言自定义 error                                                                                              | 非白名单、重复投票、阶段错误、金额不符、非管理员 → 全部 revert，0 例外       |
| M-3 | 重入攻击对照   | 攻击合约对 `VulnerableRefund` 成功、对 `Voting` revert                                                                                      | 两条断言均通过（§5.5）                                                       |
| M-4 | 长序列属性测试 | `VotingProperties.t.sol`：1000 轮确定性投票序列，每轮后断言全部不变量（见 §14 校正 7：Hardhat 3 的 invariant 运行器不调用任何目标，不可用） | 反例 0 个，且经变异测试证明该测试能失败                                      |
| M-5 | Gas 成本       | `npx hardhat test --gas-stats --gas-stats-json gas-stats.json`                                                                              | 记录 `vote` / `refund` 的 min/avg/median/max，写入 README                    |
| M-6 | 索引一致性     | 灌入 200 票后请求 `/api/results`，比对 `onChain` 与 `indexed`                                                                               | **偏差 0 条**；此即唯一可称为"准确率"的量：`一致记录数 / 总记录数 = 200/200` |

**关于简历表述的建议**：把"准确率达 99%"替换为可直接复现的描述，例如「合约测试覆盖率 96%、1000 轮不变量测试 0 反例、索引器与链上状态一致性偏差 0/200」。带具体分母的数字才经得起追问；而"99%"既无法定义分子，也无法现场复现。

---

## 9. 里程碑（每个均可独立演示与独立写进简历）

| 里程碑                | 内容                                                                                                                                                                    | 验收（可演示的状态）                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **M0** 骨架与 CI      | pnpm workspace、`contracts/`（Hardhat 3 ESM 配置）、`docker-compose.yml`（MySQL 8）、GitHub Actions 跑合约测试；**申领 Sepolia 测试 ETH 并开始储备**；确定 pinning 服务 | 全新 clone 后一条命令跑通空测试套件                                            |
| **M1** 合约与测试     | `Voting.sol`、`VulnerableRefund.sol`（仅测试）、`RefundAttacker.sol`、完整测试套件、部署脚本                                                                            | `--coverage` 报告 ≥95%；M-2/M-3/M-4 全绿；**此里程碑已足以支撑简历的合约部分** |
| **M2** 索引器与 API   | schema 迁移、游标索引器、REST API、`/api/results` 双源比对                                                                                                              | M-6 偏差 0/200；断点续跑与重组回退有测试覆盖                                   |
| **M3** 前端与联调     | 钱包连接、投票、退款、管理员后台、索引高度提示                                                                                                                          | 端到端手动走通一遍；产出截图与 GIF                                             |
| **M4** 部署与开源包装 | Sepolia 部署 + Etherscan 验证、README（架构图/亮点/本地运行指南/指标表）、MIT 协议、Conventional Commits                                                                | 有公开合约地址与可访问的仓库                                                   |

**排期风险与降级策略**：4 周 × 3-4 h/天 ≈ 80-110 小时，此范围偏紧。若时间不足，**优先保证 M1 完整**——合约与测试是简历主张的核心，且它是唯一无需任何外部依赖（faucet、数据库、网关）即可完整交付的部分。M3/M4 可延后而不损害 M1 的价值。

---

## 10. 风险登记

| #   | 风险                                                                          | 影响 | 应对                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Hardhat 3 是完全重写版，绝大多数既有教程与 LLM 记忆基于 Hardhat 2，照抄会失败 | 高   | 只依据官方 Hardhat 3 文档；已知 `solidity-coverage`、`hardhat-gas-reporter` **不可用**（peer 为 `^2.x`），改用原生 `--coverage` 与 `--gas-stats`；ESM 配置、`defineConfig`、显式网络连接均为新 API |
| R2  | 插件生态缺口（如需要额外的检查/报告插件）                                     | 中   | 优先用原生能力；确需插件时先核对 peer 范围是否含 `^3`                                                                                                                                              |
| R3  | Sepolia faucet 领币可能排队或限流                                             | 中   | M0 即开始申领储备；本地 Hardhat 网络始终是主开发环境，部署只是最后一步                                                                                                                             |
| R4  | IPFS 网关限流（实测 429），pinning 服务可用性待定（Storacha TLS 不通）        | 中   | M0 实测候选服务；前端强制网关失败兜底，不阻塞投票主流程                                                                                                                                            |
| R5  | TypeScript 7.0.2 与 typed-lint/框架插件的兼容性未知                           | 中   | 固定 6.0.3（§5.1）                                                                                                                                                                                 |
| R6  | wagmi 3.x + React 19 + Next.js 16 + Tailwind 4 是较新组合，文档可能滞后       | 中   | 已在本机实测通过类型检查、生产构建与全部 API 路由；必要时降级到更成熟的组合版本                                                                                                                    |
| R7  | 质押资金未领取时永久锁定                                                      | 低   | `sweepUnclaimed()` + 30 天宽限期（§5.6），并在 README 列为已知中心化风险                                                                                                                           |
| R8  | 时间预算紧张                                                                  | 高   | 里程碑可独立交付（§9）；M1 为不可妥协的核心                                                                                                                                                        |

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

| ADR   | 主题                                      | 真实备选                                                      | 待验证问题                                               |
| ----- | ----------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| ADR-1 | 链上唯一事实源 + 只读事件索引器，取代双写 | 后端代发交易（Gas 代付）；前端直连链无索引器                  | 删除 JWT 与写入 API 后，简历的"后端开发"分量是否仍成立？ |
| ADR-2 | 采用 Hardhat 3 而非 Hardhat 2             | Hardhat 2.29.1 + `solidity-coverage` + `hardhat-gas-reporter` | Hardhat 3 的插件缺口在 M2/M3 是否会成为阻塞？            |
| ADR-3 | 明票上链，主动声明隐私取舍                | commit-reveal 两阶段；Merkle + nullifier 匿名投票             | 面试中"为什么不做隐私"的回答是否充分？                   |
| ADR-4 | IPFS 仅承载候选人元数据                   | 元数据存 MySQL；元数据全部上链                                | 网关限流（429）是否影响演示可靠性？                      |
| ADR-5 | 引入质押/退还以构造真实重入面             | 不引入质押，改简历表述；仅写独立的重入演示合约                | 质押带来的资金锁定与额外权限点是否值得？                 |

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

### 校正 7：Hardhat 3.17.0 的 invariant 运行器不调用任何 target，M-4 因此改用可自证的方案

**这是本项目最重要的一次实测校正。** 原规格把 M-4 的 1000 轮证据寄托在 `test.solidity.invariant.runs: 1000` 上。实测结论是：**运行器会求值 `invariant_*` 函数，但不会调用任何目标合约函数**，因此任何依赖 ghost 计数器的不变量都会以零计数通过——即"1000 轮 0 反例"是一份空转的假证据。

判定过程（全部为实测，非推断）：

1. 按官方约定写了 `invariant_*` 函数并按 Foundry 惯例部署了独立 handler 合约，输出显示 `(runs: 1000)` 且全部通过；
2. **负向对照**：注释掉 `Voting.vote` 中的 `hasVoted[msg.sender] = true`（该变异经确认会让 3 个普通测试失败），invariant **仍然全部通过**——证明没有任何一次投票被尝试过；
3. 为排除"handler 定义在 `.t.sol` 测试文件里所以不被选为目标"的可能，把 handler 移到普通源文件 `test/VotingHandler.sol`（有 artifact），结果不变；
4. 为排除 target 选择机制的问题，尝试 `targetContract(address(handler))`、以及把驱动函数直接放在测试合约自身（官方示例的形态），结果均不变；
5. **决定性探测**：写入一个必假的不变量 `assertEq(1, 2)`，它**失败**了——证明运行器确实在求值不变量，问题只在于 target 集合为空；
6. 查 `@nomicfoundation/edr@0.20.0` 的 `InvariantConfigArgs` 类型定义，其中**不存在任何 target/contract 相关字段**（仅 `runs`/`depth`/`failOnRevert`/`callOverride`/`dictionaryWeight`/`includeStorage`/`includePushBytes`/`failurePersistDir`/`timeout`），与观测一致。

**处理**：删除 `VotingInvariant.t.sol` 与 `test/VotingHandler.sol`。一份静默空转的测试比没有测试更危险，因为它会伪装成证据。

**替代方案**（`contracts/contracts/VotingProperties.t.sol`）：确定性伪随机驱动 **1000 轮**投票（40 名选民 × 3 名候选人，序列由 `keccak256(seed, round)` 生成，完全可复现），在**每一轮之后**断言全部不变量，并额外断言"这 1000 轮确实产生了工作"（`accepted + rejected == 1000`、`accepted == 40`、`marked == accepted`）。

**该替代方案同样经过负向对照**：注入同一个 `hasVoted` 变异后，它以 `votes can never exceed the whitelist size: 41 > 40` 失败。因此 M-4 的证据是可证伪的，而不是空转的。

**面试价值**：这条记录本身就是"你怎么知道测试真的在测东西"的答案——先证明测试能失败，再报告它通过了。

### 校正 8：重入对照从三组扩展为四组

原规格 §5.5 断言"CEI 单独就足以阻止该重入，`nonReentrant` 属纵深防御"，并只计划了两个对照（脆弱合约 + 生产合约）。但生产合约中 `nonReentrant` 会先于 CEI 生效，导致**守卫的贡献不可观测**——该断言无法被证明。

因此扩展为四组合约矩阵，每一层都被独立验证：

| 变体               | CEI | 守卫 | 攻击结果 | 断言                                   |
| ------------------ | --- | ---- | -------- | -------------------------------------- |
| `VulnerableRefund` | ✗   | ✗    | 攻击成功 | 攻击者取回 3×STAKE，合约余额归零       |
| `CEIOnlyRefund`    | ✓   | ✗    | 攻击失败 | 攻击者只取回 1×STAKE，受害者余额完好   |
| `GuardOnlyRefund`  | ✗   | ✓    | 攻击失败 | 攻击者只取回 1×STAKE，且重入尝试被记录 |
| `Voting`（生产）   | ✓   | ✓    | 攻击失败 | 攻击者只取回 1×STAKE，账目一致         |

四个变体全部为测试夹具（`contracts/contracts/test/`），通过 `coverage.skipFiles` 排除在覆盖率分母之外，绝不进入部署路径。

## 15. 实测结果

| 指标         | 结果                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| M-1 覆盖率   | `contracts/Voting.sol` 行覆盖率 **100.00%**，语句覆盖率 **100.00%**                                                                |
| M-2 授权拦截 | 非白名单、重复投票、阶段错误（4 种）、质押金额错误、未知候选人、零地址、非管理员 → 全部 revert，无例外                             |
| M-3 重入对照 | 四组矩阵全部按预期（见校正 8）                                                                                                     |
| M-4 属性测试 | 1000 轮确定性投票序列 + 256 轮 fuzz，0 反例；且经变异测试证明可失败（见校正 7）                                                    |
| M-5 Gas      | `vote` 中位 **109,256**（min 109,256 / avg 119,250 / max 143,456）；`refund` **37,920**；部署 **1,249,757**；运行时代码 5,298 字节 |
| M-6 一致性   | 链上 **200** 票 == 索引 **200** 票，3 名候选人逐一比对，**0 处偏差**                                                               |
| M-6 负向对照 | 从 `votes` 删除 1 行后：`consistent: false`、200 vs 199、定位到 `candidateId 2`（67 vs 66）、CLI 退出码 1、HTTP 500                |
| M-6b 幂等性  | 游标回退到 0 强制重放：**404 行全部命中重复，插入 0 行**，票数仍为 200（未翻倍）                                                   |
| M-7 构建     | Next.js 生产构建成功：1 个页面 + 5 个动态 Route Handler 全部产出                                                                   |
| 测试总数     | Solidity 41 个 + TypeScript(viem) 8 个 + 索引器单测 41 个 = **90 个，全部通过**                                                    |

### M-6 的 API 层观测（实测响应）

```json
{
  "consistent": true,
  "mode": "dual-source",
  "onChainTotal": 200,
  "indexedTotal": 200,
  "discrepancies": [],
  "onChain": { "source": "chain", "total": 200, "candidates": [ … ] },
  "indexed": { "source": "index", "total": 200, "candidates": [ … ] }
}
```

`/api/health` 同时报告 `lastIndexedBlock` / `chainHead` / `lagBlocks`；实测本地环境为 `406 / 406 / 0`。

### M-6 的负向对照，以及它暴露出的一个真实缺陷

只观测到"一致"的一致性检查器不是证据——这与校正 7 里空转的不变量测试属于同一类错误。因此补做了负向对照：删掉 `votes` 表的**一行**，观察两侧是否被发现。

结果符合预期：CLI 退出码 1，`consistent: false`，200 vs 199，并精确定位到 `candidateId 2`（链上 67 / 索引 66）；`/api/results` 返回 HTTP 500 与同一份差异。

但这次对照同时暴露了一个**界面缺陷**：`/api/results` 在不一致时返回 500，而浏览器端的 `fetchResults` 走的是一个"任何非 2xx 即抛错"的通用助手，于是它**丢掉了 500 里那份完全有效的差异负载**，react-query 将请求标记为失败，界面显示的是：

> 无法比对（索引 API 不可达）

而事实恰恰相反——比对成功了，并且发现了不一致。这个文案会把排查者引向网络故障，而真实原因是数据分歧。修复方式是让 `fetchResults` 把"能解析成结果体的 500"当作数据返回（500 状态码保留，因为它对监控告警有用），其余情况仍抛错；并补了 5 个回归测试固定这一行为。修复后界面正确显示：

> 链上 200 票 ≠ 索引 199 票 · 1 处偏差

这条记录的意义在于：**正是负向对照把缺陷逼出来的**——只测happy path 时，这个缺陷完全不可见。

### 一个值得记录的观测

重置游标后，**应用进程内的后台索引循环会抢先把游标推回链头**（`web/src/instrumentation.ts` 生效，实测 `drain` 因此看到 `rounds: 0`）。这不是缺陷，但它意味着：**测量幂等性时必须先停掉应用**，否则测到的是后台循环的重放而不是 `drain` 的重放。这条已写入 README 的复现步骤。

### 遗留的复现风险

- **GitHub 连通性**：`forge-std` 的 git 依赖在弱网下可能安装失败（校正 3）。
- **工具链版本漂移**：`hardhat`, `next`, `viem`, `@nomicfoundation/*` 均以精确版本固定；任一升级需重跑 M-1 … M-7。
- **Hardhat invariant 测试不可用**：若未来版本修复了 target 调用，应考虑用真正的 invariant 测试替换 `VotingProperties.t.sol` 的 1000 轮序列（保留后者作为确定性回归）。升级 Hardhat 后必须重跑校正 7 中的必假不变量探测。

---

## 16. 架构重构记录：三层 → 两层

**触发**：实施 M3 后确认目标结构应为「合约层 + Next 层」。

**变更**：

| 之前                                                                | 之后                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `contracts/` + `indexer/` + `packages/shared/` + `web/`（Vite SPA） | `contracts/` + `web/`（Next.js 16）                                                      |
| 索引器 = 独立 Express 进程，`:3001`                                 | 索引器 = Next 应用内的 `src/lib/indexer/`，由 Route Handler 与 `instrumentation.ts` 驱动 |
| API = Express 5 + `express-rate-limit` + zod                        | API = 5 个 Route Handler                                                                 |
| ABI 生成到 `packages/shared/src/`                                   | ABI 生成到 `web/src/lib/contracts/`                                                      |
| MySQL 是必需依赖                                                    | MySQL 是**可选**依赖：无 `DATABASE_URL` 时全部读取回退为直接读链                         |
| 前端读票数走索引                                                    | 票数与我的状态直接读链，索引只用于列表与历史                                             |

**保留下来的东西（有意为之）**：`plan.ts` 的纯函数式分块/重组判定、`decode.ts` 的事件解码、`sync.ts` 的事务+游标+幂等写入，以及它们的单测（移植时 36 个，现为 41 个）——这些逻辑与 HTTP 框架无关，是被移植而非重写的。M-1…M-6b 的全部实测值在重构后重新跑过并且不变。

**新增的验证**：M-7（Next 生产构建）、全部 5 个 API 路由的实测响应（含 400 / 404 / 503 分支）、以及"无 `DATABASE_URL` 时降级为 `chain-only`"这一路径。

**被删除的代码**：`indexer/src/api/server.ts` 的 Express 接线（其 `compareTally` / `readIndexedTally` 逻辑保留在 `web/src/lib/report.ts`）、Vite 配置与 `index.html`、`packages/shared` 包本身。旧实现完整保留在 git 历史（提交 `926c1de`）中。
