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

| 端点                       | 说明                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `GET /api/health`          | `{ chainHead, lastIndexedBlock, lagBlocks, indexConfigured, phase }` |
| `GET /api/candidates`      | 候选人列表 + 聚合票数 + 元数据 CID + `source`（`chain` / `index`）   |
| `GET /api/results`         | **同时返回链上 `results()` 与 MySQL 聚合结果，以及四值 `status`**    |
| `GET /api/voters/:address` | 该地址是否已投、投给谁、质押金额、是否已退还                         |
| `POST /api/index/sync`     | 推进索引一步（先修重组，再索引下一段已确认区块）                     |

**`/api/results` 的双源返回是本设计的关键设计**：它把"链上与链下是否一致"从一句口头承诺变成每次请求都可见的运行时事实，同时为 §8 的索引一致性指标提供了测量入口。

`status` 的四个取值及其含义：

| `status`      | 含义                                         | HTTP | CLI 退出码               |
| ------------- | -------------------------------------------- | ---- | ------------------------ |
| `consistent`  | 计入待确认票数后两侧完全吻合                 | 200  | 0                        |
| `divergent`   | 计入之后仍然不吻合——真故障                   | 500  | 1                        |
| `lagging`     | 未索引区间超过 5000 块，无法枚举因而无法归因 | 200  | 0，并打印 `INCONCLUSIVE` |
| `unavailable` | 未配置数据库，不存在可比对的第二个来源       | 200  | 0                        |

**为什么要做对账而不是直接比总数。** 索引器按设计不索引最近 `CONFIRMATIONS` 个区块，因此索引里的票数**本来就应该**少于链上当前票数。直接比较两个总数会把这一正确行为报成故障——本设计的第一版实现即如此：在默认 `CONFIRMATIONS=5` 下稳定误报"不一致"并退出 1。因此 `checkConsistency` 会拉取 `(cursor, head]` 区间内的日志、解码其中的 `VoteCast`，把票数加回索引一侧再比较；不吻合才算分歧。**只有 `divergent` 返回 HTTP 500 与退出码 1**，`lagging` 是"得不出结论"而非"通过"，故必须留下痕迹。

该判断只有一处实现（`web/src/lib/report.ts` 的 `checkConsistency`），`/api/results` 与 `check-consistency` 脚本共用，两者不可能给出不同结论。

**降级行为**：未配置 `DATABASE_URL` 时，`/api/results` 返回 `status: "unavailable"`、`indexed: null`、`indexedTotal: null`，且**不给出任何一致性判断**——此时并不存在可比对的第二个来源。它绝不谎称做过一次没做的比对，也不把"无从比对"表述成"一致"。

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
3. ~~**不做多轮次选举、提案制、委托投票**。~~
   **【已被校正 26 取代】** 本条原意是「只有一次性公投」。用户随后直接要求「用户可以新增修改删除自己的投票」，因此**「不做多轮次选举」这一句已被明确取代**——项目现在是多租户投票平台：任何人都能创建投票，每个投票有独立选项、白名单、票数与押金，投票人还可以改投与撤票。决策依据见 ADR-0023、ADR-0024。
   **仍然有效的是「提案制」与「委托投票」**：前者是治理流程，从未被要求；后者会直接破坏一人一票，而一人一票正是 ADR-0023 全力保全的东西，二者不可同时成立。
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

### 校正 9：Hardhat 3 不读取 `.env`，因此配置里显式加载它

原规格假定凭证可以放在 `contracts/.env`。实测这**不成立**：把 `SEPOLIA_RPC_URL` 写进 `contracts/.env` 而不导出为环境变量，脚本里 `process.env.SEPOLIA_RPC_URL` 为 `undefined`，Hardhat 直接报 `HHE7: Configuration Variable "SEPOLIA_RPC_URL" not found`——值就摆在文件里，却没有任何东西去读它。Hardhat 3 只从真实环境变量或 keystore 解析 Configuration Variable，CLI 也没有 `--env-file` 之类的选项。

这个陷阱的代价不是报错本身，而是**报错信息指向了错误的方向**：使用者会去检查自己填的值，而问题在于文件从未被读取。

修复：在 `hardhat.config.ts` 顶部用 Node 24 内置的 `process.loadEnvFile()` 显式加载 `contracts/.env`（存在才加载），不引入 `dotenv` 依赖。实测两条性质：

| 场景                                  | 结果                                              |
| ------------------------------------- | ------------------------------------------------- |
| 只写 `contracts/.env`，不导出环境变量 | 通过，解析到 chain id 11155111（修复前为 `HHE7`） |
| 同时导出 `SEPOLIA_RPC_URL` 且值不同   | 导出的值胜出，`process.env` 中为导出值而非文件值  |

第二条是关键的安全性质：`loadEnvFile` 与 `--env-file` 语义一致，不覆盖已存在的环境变量，因此临时覆盖仍然有效。

### 校正 10：索引必须从部署区块开始，否则在公共 RPC 上会永久卡死

原设计让索引器在游标为空时从区块 0 开始扫描。这在本地开发网上没问题，但在使用**裁剪过历史**的公共 RPC 时是致命的——Sepolia 公共端点最早只提供约 1,000,000 之后的区块。

实测（`https://ethereum-sepolia-rpc.publicnode.com`，直接调 `eth_getLogs`）：

| 区间                   | 结果                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `[0, 1999]`            | 通过，0 条日志                                                           |
| `[2000, 3999]`         | `pruned history unavailable: requested 2000, earliest available 1000000` |
| `[999999, 1001999]`    | 同上                                                                     |
| `[1000000, 1049999]`   | 通过                                                                     |
| `[11700000, 11740000]` | 通过                                                                     |

注意第一行：前 2000 个区块**能**通过，所以索引器会先推进游标到 1999，然后在 `[2000, 3999]` 上失败。而按本项目"RPC 失败不推进游标"的规则，此后的每一次重试都会重放同一个失败区间——**索引永久停在 1999，且 `START_BLOCK` 也救不了它**（该变量只在游标为空时生效，而此时游标已非空）。一个全新部署到 Sepolia 的合约会正好落进这个陷阱。

修复分三处：

1. `deploy.ts` 改用 `sendDeploymentTransaction`，等待收据，把 `blockNumber` 写进 `contracts/deployments/<chainId>.json`。
2. `export-abi.ts` 把 `blockNumber` 带进 `web/src/lib/contracts/deployments.ts`（该字段可选，旧记录缺失时为 `undefined`）。
3. `config.ts` 在 `START_BLOCK` 未设置时，默认取该链的部署区块。

实测该默认值：`CHAIN_ID=31337 → startBlock=1`（本地合约确实创建于区块 1，其收据是区块 1 唯一一笔 `to = null` 的交易）；模拟一条 `11155111` 记录（`blockNumber: 11742273`）后，`CHAIN_ID=11155111 → startBlock=11742273`，即**不会**再从 0 开始。本地全量重建索引的结果与基线逐位一致（404 行 / 200 票 / 游标 406 / tally 67,67,66）。

`START_BLOCK` 仍可覆盖，且**显式的 `0` 被当作有效值**而不是"未设置"（有单测固定这条语义）。

### 校正 11：写入路径的前端部分此前完全没有验证，而两个缺陷正长在那里

§15 原先只登记了类型检查、生产构建、服务端渲染与 API 实测响应——**没有一处运行浏览器**。补上这一面后立刻发现两个缺陷，它们都不改变任何接口、类型或构建产物，只改变"用户实际能不能完成这件事"：

**缺陷一：投票按钮永远点不动。** `isSubmitting={isPending || receipt.isPending}`。没有交易哈希时 wagmi 禁用收据查询（`enabled: Boolean(hash && …)`），而被禁用的 TanStack Query **仍然报告 `status: "pending"`**，所以 `receipt.isPending` 恒为 true。于是按钮标签恒为"提交中…"，且 `disabled={!canVote || isSubmitting}` 恒成立——**连上钱包也无法投票**，核心写入路径是死的，而所有既有验证都是绿的。

**缺陷二：未白名单账户也能点。** `canVote` 只检查阶段、连接状态与是否已投票，从不查白名单。按钮亮着，点下去必然被合约 revert 拒绝。合约其实**公开了** `mapping(address => bool) public isWhitelisted`，UI 完全可以自行判断。

修复：`isSubmitting` 改用 `receipt.isLoading`（`isPending && isFetching`，只在收据确实在请求中时为真）；`canVote` 加入读链的 `isWhitelisted` 并给出具体理由；"我的状态"面板新增"白名单"一行。

新增 `pnpm ui:drill` 把这一面固定下来。它用 DevTools Protocol 驱动 headless Chrome，**不引入任何浏览器自动化依赖**（Node 22+ 自带 `WebSocket`）；注入的 provider 把 `eth_sendTransaction` 转发给本地节点由解锁账户签名，全程不接触私钥。它断言 **UI 按钮的可用性与链上 `isWhitelisted && !hasVoted && phase == Voting` 逐一相符**，因此无论账户能否投票都是有效断言。

实测（两场景退出码均为 0）：

| 场景                             | 链上状态                             | 结果                                                                                                                          |
| -------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 未白名单账户（只读）             | `isWhitelisted=false hasVoted=false` | 3 个按钮全部禁用，理由"这个地址不在白名单里，合约会拒绝投票。"，"我的状态"白名单显示"否"                                      |
| 已白名单账户（`--vote`，快照内） | `isWhitelisted=true hasVoted=false`  | 3 个按钮全部可点；点击后交易到达"已确认"，卡片变为"你已投给该候选人"（交易 `0x14d9380e…`，区块 408，索引侧 tally 67→68 同步） |

演练跑在一次快照里，结束时回退。这次回退**顺带触发了一次真实的索引器重组自愈**：链头 408→406，游标与票数自动从 408/201 撤销回 406/200，两侧重新 `consistent`——此前该路径只有合成演练覆盖。

**同一轮补齐的第二条写入路径：退款。** 投票之外，唯一会动用户资金的路径是"取回押金"。它的按钮原先只在 `phase == Ended && myStake == 0` 这一种窄情况下给出理由；投票进行中而用户持有押金时，界面是一个灰掉且**沉默**的按钮。这条路径的沉默代价最高——`sweepUnclaimed()` 会把宽限期内无人认领的押金转给 owner，所以"按钮错误地禁用"直接等于用户丢钱。现在四种禁用原因都会写明。

`pnpm ui:drill --refund` 覆盖它，实测断言（`phase=2 stakeOf=1000000000000000`，17 项全过）：

| 阶段   | 断言                                                                                  |
| ------ | ------------------------------------------------------------------------------------- |
| 点击前 | 退款按钮**可点**，与链上 `phase == Ended && stakeOf > 0` 相符；押金行显示 `0.001 ETH` |
| 点击后 | 交易到达"已确认"；**重新从链上读回 `stakeOf == 0`**（不信任 UI 自报）                 |
| 结算后 | 按钮自行禁用且说明"没有可取回的押金。"；押金行回落 `0 ETH`                            |

该场景回退时，索引一次性撤销了**三类**投影行，这是比此前更强的自愈证据：实测 `votes 201→200`、`whitelist 201→200`、`refunds 1→0`、`phases 2→1`、`cursor 410→406`、`tally 68/67/66 → 67/67/66`，两侧重新 `consistent`。

已知边界：`endVoting` / `setWhitelist` 仍无浏览器端覆盖；注入的是模拟 provider，与真实钱包在账户切换、链切换、拒绝签名等交互上存在差异，这些路径未覆盖。

### 校正 12：CI 从未验证过本项目最核心的那个结论，而部署记录有两个互相不一致的写入方

本轮做的是第一次对 M0 交付物（CI）本身的审计，以及为它补上真正缺少的那一环。

**其一，CI 里没有任何一步碰链或索引器。** `web` 作业的注释声称它 "exercises the indexed path so the schema and the dual-source comparison are covered"，但把整个 workflow 搜一遍 `drain|check-consistency|seed|deploy|hardhat node` —— 零命中。该作业里唯一接触数据库的步骤只是把 schema 应用两遍。也就是说，"索引一致性偏差 0/200"这个头号结论**没有任何 CI 覆盖**，而绿色徽章会被读成它已被验证。修正分两步：把该注释改成准确的边界说明，并新增 `indexer-e2e` 作业真正覆盖它。

没有顺手塞一个无法运行的作业：GitHub Actions 在开发环境中跑不了，而 `deploy:local` 当时硬编码 8545，要在本机验证这套组合就得先拆掉那条被多项测量依赖的基线链。因此先解决第 5 条（端口可配置），使端到端流程能在**第二条链**上排练，再写作业。

**其二，`deployments/<chainId>.json` 被两个脚本写入，而两者 schema 不一致。** `seed-local.ts` 不写 `blockNumber`——正是校正 10 为"索引从部署区块开始"引入的字段。按 README 的快速开始只跑 `pnpm seed:local`，记录就会丢掉它，`export-abi` 随之生成 `blockNumber: undefined`，`resolveStartBlock` 回退到 `undefined`。406 块的本地链看不出任何异常，缺陷只在换到真实链（公共 RPC 裁剪历史）时才发作。同一文件上还有第二处不一致：两个脚本都写校验和格式的地址，而仓库提交的是小写。

**其三，`deployedAt` 混进了被字节级守护的产物。** `abi-drift` 用 `git diff --exit-code` 判定生成产物是否与提交一致，这要求产物可由可复现输入重建；而 `deployedAt` 是时间戳，任何一次本地播种都会改变它。一个会在语义无变化时报红的检查，最终会被当成噪音绕过。`git grep` 证实该字段在整个仓库中没有任何消费方。

三处修正合并为 ADR-0010。可执行的验证是一个哈希：全新链上 `seed:local && export-abi`，生成文件 SHA256 与"由已提交记录生成"的完全一致。

**新增能力**：`LOCALHOST_RPC_URL`（默认 8545）使本地链端口可配置，Hardhat 的 `localhost` 网络与 `seed-local.ts` 都认它。它的用途是让完整端到端流程能在第二条链上排练，而不必停掉正在使用的那条。

**新增 CI 作业 `indexer-e2e`**：起本地链、`seed:local`、建表、`drain`、比对一致性，并把游标归零强制重放验证幂等（M-6b），以 `CONFIRMATIONS=0` 运行——整条链对整份索引，落后不算通过。它与 `web` 作业的边界互不掩盖：`web` 只验证 schema 对真实 MySQL 有效且迁移幂等，不碰链。

实测（全新链 + 全新库，即该作业的等价序列）：`migrate` → 7 张表；`drain` → `seen 404 / inserted 404 / duplicatesIgnored 0`；`check-consistency` → `consistent`、`onChainTotal 200`、`indexedTotal 200`、`discrepancies []`；强制重放 → `seen 404 / inserted 0 / duplicatesIgnored 404`，投影仍为 `votes=200 cursor=406 tally=67,67,66`。同一流程在**另一条全新链**上复现出与基线逐项相同的投影，这也顺带证明了 `seed-local.ts` 完全确定性（同一地址、同一链头 406、同一 tally）。

CI 的"后台起节点 + 就绪轮询"机制在 `bash` 下单独实测通过：后台进程拿到 PID、轮询首次即就绪、`curl` JSON-RPC 读回链头、进程可终止、失败日志捕获 71 行。

顺带纠正四处测试计数错误：文档四处写"索引器 41 个单测"，实际是 **57**（41 是 Solidity 的数量，被抄到了索引器那一格）。逐文件核对：plan 18、decode 9、sync 9、report 10、client-api 7、config 4。

### 校正 13：索引只有一种"缺失"被处理，另一种让页面说了假话

本轮逐个端点实测了全部 5 条 REST 路由——此前只有 `/api/results` 与 `/api/health` 被真正执行过，`/api/candidates`、`/api/voters/[address]`、`/api/index/sync` 从未跑过。

**发现：`data.ts` 用 `state.pool === null` 作为唯一判据**，因此"索引未配置"落回链，而"索引配置了但读不到"不落回链、直接抛错。后果（全部实测）：

- `DATABASE_URL` 指向死端口时，**五条路由全部 503**，包括 `/api/candidates` 与 `/api/voters`——二者都有现成的链上回退路径，却在 `pool !== null` 时走不到。
- 页面（HTTP 200）显示 **"服务端无法读取链上数据：connect ECONNREFUSED 127.0.0.1:3399"**。**链完全健康**，失败的是 MySQL。这句话把读者的排查方向指向了错误的子系统。
- `page.tsx` 用一次 `Promise.all` 把三个读绑在一起，任一失败即全部丢弃，因此首屏连链上 tally 都没有——而那个 tally 一个 `eth_call` 就能拿到。
- `getVoter` 吞掉链读失败并填 `hasVoted: false`，把"未知"变成"没有人投过票"这一句肯定的假话。

**发现：`/api/voters` 的 `whitelisted` 在无索引时恒为 `null`**，尽管合约把 `mapping(address => bool) public isWhitelisted` 公开为 getter，一次廉价调用即可回答；ADR-0009 早已确立 UI 的白名单判断应读链而非读索引。

**修正**（ADR-0011）：

1. `ready()` 记录迁移失败而不再抛出；新增 `withIndex()`，把"索引读失败"与"索引未配置"归到同一条回退路径，`source` 字段说明实际由哪一侧作答。
2. `getResults()` 先读链（链失败仍向上抛，因为这个接口的意义就是比对），索引侧失败则返回 `unavailable` 与链上 tally——**没有比对过就不宣称结论**。
3. `getVoter()` 不再吞掉链读失败；`readOnChainVoter` 增加 `isWhitelisted`，因此 `whitelisted` 在两种模式下都由链回答（索引只再提供 `voteTxHash` 与退款历史，那是链不便廉价提供的东西）。
4. `HealthResponse` 新增 `indexError`：索引不可达时报出原因、`status` 变 `degraded`，但**不影响链上字段**。故障可见，不是被藏起来。
5. 删除死代码 `requirePool`（其报错文案写着 "this read must fall back to the chain"，而该路径恰恰不回退；它只在 null 检查之后被调用，永远不可能抛出）与无人调用的 `getPhase` / `readOnChainPhase`。

**修正后的实测**（三种状态逐一跑过，本地链 406 块、200 票）：

| 端点                   | 索引正常                               | 索引挂了                                                                   | 无索引                             |
| ---------------------- | -------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `/api/health`          | 200 `ok`，`indexError: null`           | 200 `degraded`，`indexError: "connect ECONNREFUSED …"`，`chainHead: "406"` | 200 `ok`，`indexConfigured: false` |
| `/api/candidates`      | 200 `source: "index"`                  | 200 `source: "chain"`，tally 67/67/66                                      | 200 `source: "chain"`              |
| `/api/results`         | 200 `consistent` 200/200               | 200 `unavailable`，`indexedTotal: null`                                    | 200 `unavailable`                  |
| `/api/voters/<addr>`   | 200 `source: "index"`，有 `voteTxHash` | 200 `source: "chain"`，`whitelisted: true`（此前为 `null`）                | 200 `source: "chain"`              |
| `POST /api/index/sync` | 200 `idle`                             | 503 `sync_failed`（写索引，无库不可写）                                    | 200 `enabled: false`               |

页面在索引挂掉时不再出现"服务端无法读取链上数据"，而是正常渲染链上 tally 与 `status: "unavailable"`。

新增 `web/test/data.test.ts`（9 个用例）钉住这些行为：索引挂掉时 tally 走链、`getResults` 不宣称结论、`getVoter` 保留链上答案、链不可达时**必须抛出**而不是返回 `hasVoted: false`、`getHealth` 报出 `indexError`。索引器单测因此从 57 增至 **66**，总数 **115**。

### 校正 14：IPFS 网关回退一次都没跑过；而它跑起来后会误报失败原因

`web/src/lib/ipfs.ts`（约 99 行）是整个 IPFS 层，它的存在理由就是"公共网关会限流，所以要逐个回退"。审计发现：

**没有测试文件。** 索引器原有 7 个测试文件覆盖 plan/decode/sync/report/config/client-api，唯独 `ipfs.ts` 没有。且播种数据里的 CID 是 `bafyseededcandidate0`——被 `isPlausibleCid` 在发出任何请求之前就判为非法，所以**回退循环、超时和 `unreachable` 三条路径从未执行过一次**，无论在测试里还是对着真实网关。

**修正 1：`isPlausibleCid` 只认 `bafy` 前缀，会误判合法 CID。** CIDv1 的 base32 形式是 `b` 前缀 + 58 个 base32 字符（共 59），其中第 2–4 位编码 codec：dag-pb/dag-json 是 `bafy`，**raw codec 是 `bafk`**。原检查 `/^bafy[a-z2-7]{55}$/` 会把 `bafk…` 判为非法，而调用方把"非法 CID"渲染成 **"CID 格式无效，无法解析"**——即告诉用户他们的数据是坏的，实际是检查本身太窄。改为 `/^b[a-z2-7]{58}$/`，并在注释里写明为何不锁死 codec 前缀。

**修正 2（对着真实网关跑出来的）：可达的网关被报成"不可达"。** 写探针直接调用真实模块访问真实网关，实测：

| CID                                                                                       | 结果                                                                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o`（真实存在，内容是 `hello world` 纯文本） | 修改前 `{"status":"unreachable","attempts":3}`；修改后 `{"status":"no-metadata","attempts":3,"answered":1}` |
| 同为上者，耗时                                                                            | 12,591 ms（两个网关各耗尽 6 s 超时）                                                                        |
| `bafyseededcandidate0`（格式非法）                                                        | `{"status":"invalid-cid"}`，**0 ms**，未发出任何请求                                                        |

逐个网关实测本机可达性：`dweb.link` **HTTP 000**、`ipfs.io` **HTTP 000**、`gateway.pinata.cloud` **HTTP 200**（正文 `hello world`，`content-type: text/plain`）。也就是说默认顺序里前两个在本机根本不可达，第三个作答了——**回退不是理论**。

但这也暴露了原实现的错报：`attempts` 把"没联系上""非 2xx""2xx 但正文不是元数据"三种情况合并，于是 pinata 明明回答了 200，UI 却会渲染 **"3 个网关均不可达"**。这与本轮一直在修的是同一类问题：**对失败原因的错误归因**，而这次是真实网络给出的证据。修复方式是把"是否真的作答"单独计数，并新增 `no-metadata` 状态：

```ts
| { status: "ok"; metadata }
| { status: "invalid-cid" }
| { status: "unreachable"; attempts }                 // 一个都没联系上
| { status: "no-metadata"; attempts; answered }       // 联系上了，但没给出可用元数据
```

UI 相应分成两句：不可达时说"3 个网关均不可达"，可达但内容不可用时说"网关可访问（1/3 个已作答），但没有返回可用的候选人元数据"。这恰好把模块自己注释里的原则（"格式错误的 CID 和不可达的网关是不同的问题，不该在用户看来一样"）向下再落实一层。

**修正 3：新增 `web/test/ipfs.test.ts`，15 个用例。** 覆盖 CID 校验（含 `bafk` raw 形式必须被接受，以及 7 种必须被拒绝的形式且**不得发出请求**）、回退顺序、非 2xx、网络异常、2xx 但正文非元数据、全部耗尽、`no-metadata` 与 `unreachable` 的区分、只保留文档化字段、以及确实传递了 abort signal。

**边界（仍然没做到的事）**：回退逻辑现在有了单测，也对着真实网关跑过，但**成功路径（`status: "ok"`）从未在真实网关上发生过**——播种数据里的 CID 是伪造的，仓库里没有任何一个真实 CID 指向真实的候选人元数据 JSON。所以 `ok` 分支只有 stub 测试覆盖。这一点在 README 里如实写明，不当作已验证。

索引器单测 66 → **81**，总数 **115** → **130**。

### 校正 15：`/api/health` 的 `indexEnabled` 名不副实，且"后台循环是否在跑"无处可查

在本轮用 `INDEXER_ENABLED=false` 启动应用、随后读 `/api/health` 时，得到 `"indexEnabled": true`。据此差点做出"索引循环在运行、快照内的链变更可能已写入库"的错误判断——而循环当时是关着的（库后来确认为 `votes=200 refunds=0 cursor=406`，未被污染）。

原因是那个字段名与实际计算不符：

```ts
export function isIndexEnabled(config: ServerConfig): boolean {
  return config.databaseUrl !== null; // 有没有配置库，而不是循环有没有开
}
```

也就是说它回答的是"**是否存在一个索引**"，却叫 `indexEnabled`；而真正控制后台循环的 `config.indexerEnabled`（`INDEXER_ENABLED` 环境变量）**在健康响应里根本没有出现**。读者能看到索引高度，却无法知道它会不会自行前进。

UI 侧的措辞暴露了同一个歧义：那一行的标签是"索引高度"，`indexEnabled` 为假时显示"未启用"。按"是否存在索引"来读是自洽的，按字段名来读就是错的。

**修正**：把字段改名为 `indexConfigured`（与其计算一致），并新增 `indexerLoopEnabled`（取自 `config.indexerEnabled`），使两种状态都可报告。UI 相应改用 `indexConfigured`，并在 `indexerLoopEnabled === false` 时明确提示：

> 后台索引循环已关闭（INDEXER_ENABLED=false），高度不会自行前进；用下面的按钮手动同步。

否则读者会看着"落后区块"不断增大而无从判断原因。两种配置均实测：

| 启动方式                | `/api/health`                                                           |
| ----------------------- | ----------------------------------------------------------------------- |
| `INDEXER_ENABLED=false` | `indexConfigured: true`、`indexerLoopEnabled: false`，页面显示上述提示  |
| 默认                    | `indexConfigured: true`、`indexerLoopEnabled: true`，页面不显示提示     |
| 未设 `DATABASE_URL`     | `indexConfigured: false`、`indexerLoopEnabled: false`，页面显示"未启用" |

`indexerLoopEnabled` 上报的是**有效状态**（`indexConfigured && INDEXER_ENABLED`），而不是原始的配置开关：后者默认为真，在没有索引可推进时仍会报出"循环开着"，等于宣称一个并不存在的索引器——与本节要修的毛病同源。三个组合（默认 / `INDEXER_ENABLED=false` / 未设 `DATABASE_URL`）均实测。新增两个 `data.test.ts` 用例分别钉住"有索引但循环关闭"与"无索引绝不宣称循环在跑"。索引器单测 81 → **83**，总数 **130** → **132**。

顺带按实测更正三处陈旧的演练断言计数：ADR-0009 与本文档 §15 原写"7 / 11 / 17"，在快照内重测后为**只读 12、`--vote` 16、`--refund` 18**（校正 20 起三场景各再添一条控制台断言，计数为 13 / 17 / 19，见该条）。本轮还向演练新增了一条断言（要求每个候选人卡片以已知措辞说明其元数据状态）；新增时用错了分母（拿按按钮文字过滤出的数量作基数，而该文字随阶段变化），被断言自己在 `--refund` 场景下抓出并修正——改为与卡片数比较。

### 校正 16：链不可达时首屏报出四个未经证实的具体值，且失败的押金读取给出确定结论

校正 13/14 处理的是索引侧与 IPFS 侧的"未知被当成具体值"。本轮把**链侧**的渲染路径真正跑了一遍（此前只在 API 层验证过），发现同一条规则在读取失败这一侧完全没落实。实测方式：把 `RPC_URL` 指向死端口 `127.0.0.1:8599`，用浏览器打开页面。

修复前服务端首屏渲染出：

| 行            | 渲染值     | 真实情况                   |
| ------------- | ---------- | -------------------------- |
| `数据来源`    | `链上直读` | 链读全部失败，什么都没读到 |
| `票数合计`    | `0`        | 未知                       |
| `候选人（N）` | `0`        | 未知                       |
| `索引高度`    | `未启用`   | 索引其实配置好了且可读     |

四处都是把三种状态压成两种：`tally.data?.total ?? 0`、`source === "index" ? … : "链上直读"`、`list.length`（`list` 来自 `?? []`）、`health.data === undefined || !indexConfigured ? "未启用"`。

最严重的一处在**退款按钮**上：`const myStake = stakeOf.data ?? 0n;` 之后，理由分支链落到 `myStake === 0n ? "没有可取回的押金。"`。当 `stakeOf` **读取失败**时 `data` 为 `undefined`，页面于是给出一个关于用户资金的确定结论——而 `sweepUnclaimed()` 会在 30 天宽限期后把未领回的押金交给 owner。按钮正确地禁用了，但理由在撒谎，而 ADR-0009 的规矩正是"禁用的控件必须说明理由"。

**修正**：抽出两个具名纯函数并单测（`web/test/ballot-labels.test.ts`，9 例）——

- `readStatus(hasData, isError)`：`ready` / `loading` / `failed`，**先判 `hasData`**，因为读到 `0` 是真实答案（`stakeOf` 对未投票地址合法返回 0），必须与"没读到"区分；
- `tallyLabels({isPending, isError, source?, total?, candidateCount})`：统一产出三行的文案，失败与未知一律 `—`。

修复后同一状态实测：`数据来源 => 读取中…`、`票数合计 => —`、`候选人（—）`、`索引高度 => 读取中…`；水合后 `数据来源 => MySQL 索引`、`票数合计 => 200`、`索引高度 => 406 / 链头 —`（索引可读，链头未知则如实为 `—`）。

同时发现预取把三项独立读取当成一个整体：`page.tsx` 的 `Promise.all` 配单块 `try/catch`，而链不可达时 `getTally()`（有索引时走索引）与 `getHealth()` 实际**成功**，只有 `getResults()`（必须与链比对）抛错——两个成功结果被一并丢弃，首屏退化成设计想避免的占位符。改为 `Promise.allSettled`，保留成功项，并把失败**归因到产生它的那次读取**；横幅改为"服务端有读取失败（下面能读到的数据仍会显示）：链与索引的一致性比对：…"。修复后该状态的首屏已实测含 `MySQL 索引` 与 `票数合计 200`。

最后一项是验证强度问题：`CHUNK_BLOCKS` 默认为 2000，大于 406 块的播种链，因此 CI 的 `indexer-e2e` 每次 drain 只有一个分块，`drain.ts` 的分块循环**从未真正迭代**过。本轮清空投影后以 `CHUNK_BLOCKS=1` 完整重建（实测 `rounds: 406`、`inserted: 404`、`duplicatesIgnored: 0`），结果与单轮 drain 的 3/200/0/200/1、游标 406、tally 67/67/66 **逐位一致**；`CHUNK_BLOCKS=7` 时 58 轮，同样一致。CI 的该 job 现设为 `7`，使分块边界在流水线里被真实穿过。见 ADR-0014。

索引器单测 83 → **92**，总数 132 → **141**。

### 校正 17：重组演练在应用运行时误报"回退路径坏了"

本轮在收尾复测中跑 `pnpm indexer:reorg-drill`，得到自相矛盾的输出：`"status": "success"` 的交易、`"rewound": false`，外加 `error: "the indexer never reported a rewind after the head moved backwards"`，退出码 1。而同一脚本在同一台机器上此前多次通过。

实测定位：`before` 为 head 406 / cursor 406；快照后一笔真实交易落到 407（游标随之 407、白名单 201）；`evm_revert` 把链头退回 406，`cursorBeforeRepair` 仍为 407——到这里一切正常。问题在于**应用的后台索引循环仍在运行**（`INDEXER_ENABLED` 默认真，两秒轮询一次）：它在演练读到 `cursorBeforeRepair: 407` 之后、演练自己调用 `drainToIdle()` 之前把重组修好了，于是演练看到"什么都没发生"。脚本注释与 README 都写了"先停掉应用"，但**忘记停时的失败模式没有被识别**，报错把原因归给了索引器。

停掉应用后同一命令立刻恢复 `rewound: true, rewoundTo: 406, discardedFrom: 407`、白名单 201 → 200、票数 200，退出码 0——确认**不是回归**，而是竞态。

**修正**：在 `drainToIdle()` 前后各读一次游标，识别"别的索引器抢先修复"这一情形并单独报出，明确写出该结论**不代表回退路径有问题**。竞态有两个落点（修复前 / 修复后），因此两处都要判：

- `rewound === undefined` 之前：若游标已 ≤ 回退后的链头，说明已被他人修好；
- `rewound === undefined` 之后：再观察一次，若游标已回落且链头仍 ≤ 回退后的链头，同样判定为他人抢先。

实测：应用运行时连续**三次**都给出新诊断（`another indexer already repaired this reorg: the cursor is back at 406 while this drill expected to observe it at 407`）；停掉应用后演练通过，新检查无误报。README 的 M-6c 一节同时补上"忘记停会怎样、以及为什么那不是回退路径的问题"。

这条与 ADR-0012 同源，但对象从**产品**扩大到**验证脚本**：一个验证脚本若无法区分"性质不成立"与"别人先满足了它"，就会产出假失败——而假失败会把读者送到错误的代码位置。

### 校正 18：`lagBlocks` 在没有索引可落后时也报出数字

校正 16/17 修的是渲染层与验证脚本。本轮把"无索引"这一受支持配置**真正渲染出来**（此前只在 API 层量过），发现 `/api/health` 与页面在"不得为不存在的对象公布一个量"这条上还有漏项。

实测（未设 `DATABASE_URL`，链正常）：`indexConfigured: false`、`lastIndexedBlock: null`、`chainHead: "406"`，而 **`lagBlocks: "402"`**；页面在 `索引高度 未启用` 旁边显示 **`落后区块 402`**。同一形态也出现在数据库宕机时（`DATABASE_URL` 指向死端口）：`indexError: "connect ECONNREFUSED 127.0.0.1:3399"`、`status: "degraded"`，而 `lagBlocks` 仍是 `"402"`。

根因是 `plan.ts` 的 `lagBlocks()` 把 `lastIndexedBlock === null` 当作 `-1n`，返回 `safeHead + 1`。这个值对"什么都没索引"而言是**正确的**——缺陷不在算术，而在**问题与被问的对象不匹配**：读到的是一句关于索引的话，而当时根本没有索引。第二种情形的误导性更强：游标读取**失败**、滞后量根本未知，却报出一个具体且偏小的数字，在真实链上会变成数百万块，页面上表现为"索引只是有点慢"而不是"读不出来"。

**修正**：`getHealth()` 单独记录"游标读到了没有"（`cursorKnown`，仅 `readCursor()` 成功才置真），而不从 `lastIndexedBlock` 的值反推——`null` 是两种含义共用的值。`lagBlocks` 在三种情形上报 `null`：链读不到；`indexConfigured === false`（没有索引可落后）；游标读不出来。纯函数语义**不变**。

必须修对方向的一格是"索引已建表但从未同步"（新部署的第一次 drain 之前）：那里 `lastIndexedBlock: null` 是**事实**而不是事实的缺席，区块 0…406 确实一块都没索引，数字必须照报。四种状态全部实测：

| 情形                      | `indexConfigured` | `lastIndexedBlock` | `lagBlocks` | 页面 `落后区块`              |
| ------------------------- | ----------------- | ------------------ | ----------- | ---------------------------- |
| 索引正常、已同步          | `true`            | `"406"`            | `"0"`       | `0`                          |
| 索引已建表但从未同步      | `true`            | `null`             | `"407"`     | `407`（真实数值，保留）      |
| 未设 `DATABASE_URL`       | `false`           | `null`             | `null`      | `—`                          |
| `DATABASE_URL` 指向死端口 | `true`            | `null`             | `null`      | `—`（`indexError` 说明原因） |
| RPC 不可达                | `true`            | `"406"`            | `null`      | `—`                          |

`lagBlocks` 不参与 `/api/results` 的一致性判定（那用未索引区间的对账结果 `check.unindexedBlocks`），因此不改变任何判定。索引器单测 92 → **95**（3 例新测试，其中一例专门断言"已建表未同步"的数字**不得**被吞掉），总数 141 → **144**。见 ADR-0015。

> 附带记录：本轮曾想借"有索引但从未同步"的状态验证该分支，第一次实验被污染——另一个仍在运行的实例（`INDEXER_ENABLED=true`）把游标重新推回了 406。停掉它、确认四个端口都无监听后重做，才得到上表第二行。这与 README 对 `drain` 的告警同源。

### 校正 19：部署前预检只数"变量在不在"，而真实的失败是"填了但不能用"

校正 18 修的是索引侧的公布语义。本轮准备 D3（Sepolia 真机部署）时拿到了一份真实的 `contracts/.env`：`SEPOLIA_PRIVATE_KEY` 为空，而 `VOTING_OWNER` 里是一个 66 字符的 `0x`+64 位十六进制值——**私钥的形状，不是地址的形状**。

实测（修复前，`deploy:local`）：退出码 1，输出 `InvalidAddressError: Address "0x7077…" is invalid.`，**该值被原样打进终端**，堆栈指向 viem 的 `encodeAddress`；报错全文**没有出现 `VOTING_OWNER`**。单独实测 viem 的消息形状：221 字符，**含值、不含变量名**。

两个网络路径都放过了这个值：`deploy:local` 提前返回、什么都不检查；`deploy:sepolia` 只数两个必需变量在不在。于是"填了但不能用"这一状态从未被任何检查覆盖，而它恰好是手编 `.env` 最常到达的状态。

**修正**：把预检抽成 `contracts/scripts/preflight.ts`，导出纯函数 `configurationProblems(networkName, env)` 使其可被单测；检查的是**可用**而非**存在**——RPC 端点须为 http(s) URL、私钥须为 `0x`+64 位十六进制、`VOTING_OWNER`（若设置）须为 `0x`+40 位十六进制；报告**只给形状不给值**（"this value is 66 characters"）；凭证按是否本地网络把关，而 `VOTING_OWNER` 作为部署输入在**任何**网络都校验；keystore 提示只给真正的秘密（把地址指向 `keystore set` 会加密一个公开值，且 `deploy.ts` 读的是 `process.env`，反而取不到）。

**实施中我自己写错的一版**：最初把 `VOTING_OWNER` 的校验也挂在"是否本地网络"上，结果 `deploy:local` 依旧把值送给 viem 并回显——跑真实路径才发现。契约是"部署输入在任何网络都生效"，现由一条专门的测试钉住。

实测（修复后）：`deploy:sepolia` 报 `needs 2 configuration fixes`，同时指名 `SEPOLIA_PRIVATE_KEY`（未设置）与 `VOTING_OWNER`（66 字符），全文不含该值；`deploy:local` 报 `needs 1 configuration fix` 且不再到达 viem；`VOTING_OWNER` 未设置时 `deploy:local` 正常部署（`0xccf176…`、区块 407、owner 默认部署者），随后已把链与部署记录还原。合约侧 nodejs 单测 8 → **23**（15 例新测试，其中一例专门断言值及其前 4 位都不得出现在报告里），合约总数 49 → **64**，全项目 144 → **159**。见 ADR-0016。

另一个本轮的环境结论与代码无关：本机到 `api.etherscan.io` 不通（DNS 可解析、TCP 超时，HTTP 000），而同一时刻 Sepolia 的 RPC 端点可达；因此 D3 的**部署**不受影响，**源码验证**需要一个通路（并且 Node 默认不读 `HTTPS_PROXY`，实测需 `NODE_USE_ENV_PROXY=1`）。已记入 README。

### 校正 20：一致性检查把健康的索引误报为 `divergent`（它会比较三个不同的瞬间）

校正 19 修的是部署前的输入校验。本轮为了补上另一个盲区——浏览器演练**看不到控制台**——给演练加了一条"页面不得抛出异常、不得记录 error/warning"的断言，它当场就失败了：

```
[log/error] network: Failed to load resource: the server responded with a status of 500  (/api/results)
```

原有的 16 条 DOM 断言**全部通过**。按 ADR-0008，`/api/results` 只在 `divergent` 时返回 500，于是这成了一次"报警器误报"。

**受控复现**（白名单一笔、投票一笔，同时以 15ms 间隔轮询）：49 个非 200 响应，内容完全相同：

```json
{
  "status": 500,
  "verdict": "divergent",
  "discrepancies": [{ "candidateId": 1, "onChain": 68, "indexed": 67, "pending": 0 }],
  "onChainTotal": 201,
  "indexedTotal": 200,
  "unindexedBlocks": 0,
  "pendingVotes": 0,
  "lastIndexedBlock": "407"
}
```

`unindexedBlocks: 0` 是破案的关键：检查**以为索引已经追上**，所以那笔它没看见的票既不在 `indexed` 里，也没有资格被"待补区间"补回来。持续约 1.5 秒——不是一闪而过，而是缓存期内每个请求都算出同一个错误结论。

**根因一**：`head` 取自 `client.getBlockNumber()`，而 viem 默认把它**缓存 4000ms**。实测同一客户端在挖出新块前后各读一次：`406 → 406`（`STALE by 1`），而 `cacheTime: 0` 的客户端为 `407 → 408`。`results()` 走 `eth_call`、永远新鲜，于是链上已经 201 票而 `head` 还停在上一块。

**根因二**：`indexed` 与 `cursor` 是两条独立语句。索引器（两秒一轮）可以在两者之间提交，那一批的票同样"两侧都不计"。`persistBatch` 本就同事务写入事件与游标，所以一个快照内的两者必然一致——缺的是**让检查去读那个快照**。

**根因三**：链侧自身也可能不在同一高度——`results()` 读 `latest` 而日志枚举到较早高度时，两者对同一笔票的归属会不一致。

**修正**：`buildChainClient` 以 `cacheTime: 0` 创建客户端；新增 `readIndexSnapshot(pool)`，用一个连接、一个事务同时读出票数与游标；`readOnChainTally` 接受可选 `blockNumber`，把链上票数与日志枚举钉在同一高度；并把读取顺序写进代码——先索引快照，再读链（因此 `head ≥ cursor`，因为索引器只能消费已存在的区块）。

**实测（修复后，同一探针、同一场景）**：非 200 响应 **49 → 0**；`--refund` 场景 19/19 断言、控制台 0 条消息；正常态 `check-consistency` 仍为 `consistent`、200/200，`discrepancies: []`。新增 5 个单测，其中一个假 pool 专门把"索引器在两次读之间提交"建模出来，并同时钉住"分开读就会不一致"这一动机。

顺带记录的另一个观测：这个缺陷能存活至今有具体原因——一致性检查此前只在**链安静时**被跑过（CI 的 `indexer-e2e` 是先 `drain` 再比对）。浏览器演练是第一个"一边改链一边比对"的东西，而它此前看不见控制台。

索引器单测 95 → **100**，全项目 159 → **164**；演练断言计数按实测更正为**只读 13、`--vote` 17、`--refund` 19**（校正 21 起为 15 / 19 / 21，见该条）。见 ADR-0017。

### 校正 21：一句正确的论证被用在了错误的作用域上（缓存按查询，而不是按结果）

校正 12 给 `ipfs.ts` 建立了四种结果与各自措辞（ADR-0012）。本轮检查的是这些结果**如何被缓存**——发现注释与配置说的不是同一件事：

```ts
// Metadata is content addressed, so a successful result can never change.
staleTime: Number.POSITIVE_INFINITY,
```

"内容寻址所以成功的结果永不改变"是对的。但 `fetchCandidateMetadata` **从不 reject**——它把每一种失败都 resolve 成 `MetadataResult` 的一个成员（这正是 ADR-0012 的设计）。于是 TanStack Query 把失败当作**成功的数据**，`staleTime: Infinity` 就施加到了失败上：一次被限流的网关会把"网关可访问，但没有返回可用的候选人元数据"这句关于**候选人数据**的结论，钉死在整个会话里。而 `CandidateCard` 只有文字、**没有任何重试入口**——挂载、窗口聚焦、网络重连都不会触发重新获取，桌面端唯一能做的事是刷新整个页面。

**实测（本机）**：`ipfs.io` 与 `dweb.link` 的 443 端口均不可达，`gateway.pinata.cloud` 可达；模块自己的注释还记录了开发期间两个网关返回过 HTTP 429。也就是说"下一次尝试可能不同"正是这类失败的常态。

**修正**：把判定提成两个纯函数，且共用**唯一**一个分类来源——

| 结果          | 再试能否不同                                     | `metadataStaleTime` |
| ------------- | ------------------------------------------------ | ------------------- |
| `ok`          | 不能                                             | `Infinity`          |
| `invalid-cid` | **不能**（CID 形状是字符串自身的性质，本地判定） | `Infinity`          |
| `unreachable` | 能                                               | 30 秒               |
| `no-metadata` | 能                                               | 30 秒               |
| 尚未取到      | —                                                | `0`                 |

`useCandidateMetadata` 改用函数形式的 `staleTime`（已确认安装的 `@tanstack/query-core@5.103.1` 支持 `StaleTimeFunction`），卡片只为**可重试**的失败渲染"重试"按钮。`isRetryableMetadata` 用穷尽 `switch` + `never`，因此新增 `MetadataResult` 成员而不做这个决定会让构建失败。

**一个连带的正确性细节**：重试按钮是 `<dd>` 的**兄弟节点**而非子节点。演练断言读的是 `<dd>` 的文本作为卡片"陈述的结论"；按钮若在其中，按钮文案会混进那句话，使既有措辞断言随按钮状态（`重试` / `重试中…`）漂移。

**实测（`pnpm ui:drill`，三场景，均在快照内跑完回退）**：只读 **15**、`--vote` **19**、`--refund` **21** 项断言全部通过，退出码 0，控制台消息数均为 0。新增的 2 条断言是："不能改变的结论不得提供重试"；"提供重试的只能是网络造成的失败"。

**顺带修正一条措辞声称过多的断言。** 第 12 轮加的控制台断言写的是"页面没有抛异常、没有记录 info 以上的日志"，但它实际只在**演练注入了 provider** 的配置下测过。一次性 CDP 探针（不注入 provider）测得：25 秒内 **16 条 error 级日志**，全部与 IPFS 无关——页面每约 4 秒轮询一次 `http://127.0.0.1:8545/`，被 Chrome 以 `Permission was denied for this request to access the 'loopback' address space` 拒绝（无头模式直接拒绝、不弹窗）。原因是 wagmi 的 transport 在没有注入钱包时回退到 HTTP。**这不是应用逻辑的缺陷**（部署到公共 RPC 的实例不会出现），而是那条断言的作用域问题，因此改措辞而不是改断言：断言文本改为 `with the injected wallet, the page raised no exception and logged nothing above info level`。作为已实测、未处置的发现记录在此：无钱包访客是否应该轮询 RPC，是产品决定，留待下一轮。

**仍未关闭的边界（诚实说明）**：重试按钮本身**仍未在浏览器中渲染过**。把文档里的占位 CID 替换成合规形状 CID 的探针**未能改变客户端实际使用的 CID**（标签仍为 `CID 格式无效，无法解析`），因此瞬态失败分支的重试按钮目前只有单测覆盖。同理，`status: "ok"` 也仍未在真实网关上发生过（见 §6）。

索引器单测 100 → **106**，全项目 164 → **170**。见 ADR-0018。

### 校正 22：页面认错了链——浏览器根本不知道部署配置的是哪条链

校正 16 把"读取失败不得渲染成具体值"落实到了 `合约状态` 面板与服务端预取（ADR-0014），校正 21 修的是缓存与重试的作用域。本轮把同一条渲染路径放到**唯一没被跑过的配置**下：`CHAIN_ID` **不是**客户端 wagmi 配置里的第一条链。这一跑，页面直接把链认错了。

**实测**（`web/.env` 指向 Sepolia，`next start -p 3100`，不连接钱包）：

| 行       | 页面显示                       | 服务端读的是                   |
| -------- | ------------------------------ | ------------------------------ |
| 合约地址 | `0x5fbdb2315…`（本地 Hardhat） | `0x4bb0fd8c1…`（Sepolia 部署） |
| 阶段     | `未知`（且永久保持）           | Sepolia 上真实阶段为 `Voting`  |

两句话就能讲完根因：

1. wagmi 在**没有连接钱包**时把 `useChainId()` 取为客户端配置的**第一条链**（本地 Hardhat 31337），与 `CHAIN_ID` 无关；
2. `CHAIN_ID` 与 `VOTING_ADDRESS` 是**服务端**环境变量，而 Next.js 只把 `NEXT_PUBLIC_*` 内联进客户端包——浏览器**没有任何途径**知道这次部署指向哪条链。

于是合约地址取自本地部署记录，`phase()` / `hasVoted` / `stakeOf` / `isWhitelisted` 四个读数被发往 `http://127.0.0.1:8545`（`lib/wagmi.ts` 为 31337 配的 transport，而该端口上什么都没有）。`阶段` 因此永远停在 `未知`，投票按钮也永远不可能可用——**前端核心读路径是死的**，而类型检查、构建、SSR、API 测试、`ui:drill` 全部通过：`ui:drill` 只在 31337 上运行（它会发真实交易），本地开发时两者的取值恰好相同。

**修正**：让浏览器从服务端渲染取得链身份，而不是自己猜。

- `data.ts: getConfiguredTarget()` → `page.tsx` → `Ballot` 的 `configuredTarget` 属性。这是浏览器唯一能得知部署链的途径。
- 新增纯函数 `resolveChainTarget()`：**连接了钱包时以钱包所在链为准**（交易要由那个钱包在那条链上签名），**没有钱包时以配置的链为准**（票数与一致性比对就是从那来的）。地址始终与链 id 成对取自同一份部署记录。
- 链 id 按调用传给每个 `useReadContract`，并且先经 `config.chains.find` 收窄——未登记的链 id 会让 wagmi 抛 `ChainNotConfiguredError`，这类"本构建不认识这条链"被单独报告为"没有可用的合约地址"，与"该链上没有部署"区分开（ADR-0012）。
- 钱包链与配置链不一致时给出红色说明与一键切换。此前只有链名未知时才出现切换按钮，而"Sepolia 对本地链"这种最常见的错配恰恰是已知链名。

**顺带修掉的四处同族缺陷**（全部在同一个面板上）：

| 位置                 | 修复前                                              | 修复后                                                 |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `押金`               | 读取失败时显示 `0 ETH`                              | `读取失败` / `读取中…` / `—` 各自成立                  |
| `已投票`             | 读取失败时显示 `否`                                 | `读取失败`；未连接时说 `未连接`                        |
| `白名单`             | 读取失败后永久停在 `读取中…`                        | `读取失败`                                             |
| `索引高度` vs `链头` | 游标与**原始链头**并列，`落后区块 0` 看起来自相矛盾 | 改为 `游标 / 安全头`，原始链头单独成行并注明待确认块数 |

`押金` 那一行的代价是用户的资金：`sweepUnclaimed()` 会把宽限期内无人领回的押金转给 owner，因此"因为读失败而告诉用户没有押金可取"可能直接让用户丢钱。这也是为什么这三行分别读**自己那次读取**的状态，而不是共用一个 `isError`。

**负向对照（必要）**：用 CDP 的 `Network.setBlockedURLs` 屏蔽浏览器实际使用的 RPC 再加载，`阶段` 变为 **`读取失败`**，而服务端读到的那几行（`数据来源 / 票数合计 / 索引高度 / 链头`）原样保留。只测成功路径无法区分"修好了"与"把错误藏起来了"。

**同一探针的另一个发现**：viem 为 Sepolia 内置的 `11155111.rpc.thirdweb.com` 一次加载出现 **8~12 条 `ERR_CONNECTION_CLOSED`**，`阶段` 有时停在 `读取中…`。浏览器侧此前**没有**任何可配置的 Sepolia RPC 入口（`NEXT_PUBLIC_LOCAL_RPC_URL` 只覆盖 31337），因此新增 `NEXT_PUBLIC_SEPOLIA_RPC_URL`，与既有的那个对称。

**修复后实测**（同上探针）：`阶段 => 投票中`、`合约地址 => 0x4bb0fd…`、`索引高度 => 11749047 / 安全头 11749047`、`链头 => 11749052（最近 5 块待确认）`、`落后区块 => 0`，浏览器控制台 **0 条消息**（即无水合不一致）。`立即同步索引` 点击后显示本次同步做了什么（`已索引区块 11749067–11749067，读取 0 个事件，写入 0 行。`）并自行恢复可用；此前它把 503 与成功渲染成同一件事。

**仍未关闭的边界（诚实说明）**：`钱包连在错链上` 这条分支（告警横幅 + 切换按钮）**没有用真实钱包验证过**，只有单测覆盖；探针不注入 provider，覆盖不到它。

**两处规格正文与实现不符，按本文件的惯例只在此登记、不改正文**（§14 的历次校正都是这样做的）：

1. §3 架构图与 §7.2 写的"读：权威票数 / 我的状态（直接读链，不经索引）"比实现强。实现是：**票数与候选人列表来自索引（`source: "index"`，`数据来源` 一行写明）**，只有在索引不可用时才直读链上并把 `source` 改成 `"chain"`；阶段、我的投票与押金、白名单才是一律直读链。校正 13 建立的"两种缺失走同一条回退路径 + 标注来源"就是这个设计，因此正文那句话应当按实现读。README 里对应的一句已改为如实描述，并保留了"索引落后多少由哪几行说明"。
2. §7.2 写的"链 ID 错误（提示并一键切换 Sepolia）"把目标链硬编码成了 Sepolia。实现切换的是**应用配置的那条链**（`CHAIN_ID`），因为同一份代码在本地链与 Sepolia 上都要能用；硬编码会让本地演示场景下"一键切换"把钱包切到一条与部署无关的链。

web 单测 106 → **146**（`ballot-labels.test.ts` 12 → 41，新增 `chain-target.test.ts` 7，`config.test.ts` 修正 1 个已失效的夹具并新增 1 个）；同期的合约侧 TypeScript 测试由 23 增至 28（部署预检），全项目 170 → **215**。见 ADR-0019。

其中 `config.test.ts` 那个夹具值得单记一笔：名为"没有部署记录的链"的用例拿 `11155111` 当输入，Sepolia 部署记录一出现，它就不再测它声称的东西（实际返回部署区块）。这与"测试比它声称的少"是同一类问题，因此改用一个真的没有记录的链 id（`5`），并补了一条"有记录的链必须用记录里的区块"作为反向断言。

### 校正 23：修好"不再沉默"之后，报出来的那句话本身把 RPC 端点与 apiKey 送到了浏览器上

校正 22 让 `立即同步索引` 报告结果（此前 503 与成功在界面上完全相同）。它随即报出了一个**真实的上游故障**，而那句话是：

```
同步失败：The request took too long to respond. URL: https://ethereum-sepolia-rpc.publicnode.com/?apiKey=WP46… Request body: {"method":"eth_blockNumber"} Details: The request timed out. Version: viem@2.56.8
```

一行里同时有**服务端 RPC 端点**、它的 **apiKey**、请求体与库版本。任何能打开页面的人点一下这个按钮就能读到它们。

**先确认这是不是"真故障被误报"**：不是。直接测该端点的 `eth_blockNumber`，三次分别 1.72s / 0.40s / 0.41s——上游是**间歇性**超时；服务端的索引循环也在日志里重试过（`backoff 4000 → 8000`），恢复后 `indexError` 回到 `null`，索引一直在前进（实测高度 11749123 → 11749137 → 11749189）。所以问题不是"索引坏了"，而是**索引把自己为什么卡住的全部环境细节公布到了浏览器上**。

**这不是一处笔误，是七处出口。** 同一个 `error.message` 出现在五条 Route Handler 的 `message` 字段、`/api/health` 的 `indexError`、以及服务端渲染进页面的失败横幅里；它们**全部未认证**。而那份文本**本来就**在服务端日志里（`sync iteration failed; retrying { err: '…URL: …?apiKey=…' }`），浏览器那一份只是重复，且是有害的重复。

**修正**：新增纯函数 `describeFailure(error)`，作为所有失败文案的唯一来源；它返回一句分类过的中文，指名失败的依赖与配置它的变量（`RPC_URL` / `DATABASE_URL`），并保留"哪个调用失败"（`eth_blockNumber` / `eth_call`），原始错误改由各自 catch 处的 `console.error` 记录（`recordIndexFailure` 只在分类结果变化时记一次，因为索引是被持续轮询的）。

分类的可靠性边界是本轮最值得记的一点：**不能按错误文本判定依赖**。mysql2 的连接失败是 `Error("connect ECONNREFUSED 127.0.0.1:3306")` 加上 `code`/`errno`/`syscall`/`port`，而这句话去掉那些字段后与 RPC 的拒绝**无法区分**——只按 `ECONNREFUSED` 分类会把 MySQL 的故障指向 `RPC_URL`，让运维去查一个健康的组件。因此顺序是：viem 的 `walk()` → MySQL 的 `errno`/`sqlMessage`/`ER_*` → 无歧义的文本线索（超时、`fetch failed`…）→ 原样透传。`ECONNREFUSED` 被刻意排除在文本线索之外。测试里那个假的"死掉的连接池"也因此补上了 mysql2 真实会带的字段——不带这些字段的夹具在测一个 MySQL 从不产生的形状。

**实测（一次性实例：`RPC_URL=http://127.0.0.1:8599`、`DATABASE_URL` 指向死端口、`INDEXER_ENABLED=false`，端口 3101）**：

| 出口                              | 结果                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/index/sync`            | 503 `{"error":"sync_failed","message":"RPC 端点无响应（eth_blockNumber 调用）：请求超时或连接失败。请检查 web/.env 里的 RPC_URL 是否可达，或换一个端点；完整错误见服务端日志。"}` |
| `/api/candidates`、`/api/results` | 503，指名 `eth_call`                                                                                                                                                              |
| `/api/health`                     | `indexError` 为数据库那一句（数据库确实是失败的那一侧）                                                                                                                           |
| 页面 HTML                         | `apiKey`、`WP46…`、`viem@` **均不存在**；横幅为"票数：RPC 端点无响应（eth_call 调用）：…"                                                                                         |
| 服务端日志                        | 三者的完整错误（URL、请求体、堆栈、`[index] read failed Error: connect ECONNREFUSED 127.0.0.1:3399`）都在                                                                         |

**边界（诚实说明）**：`ECONNREFUSED` 退出文本线索后，一个**不带驱动标记**的裸 `Error("connect ECONNREFUSED …")` 会原样透传（并抹掉其中的 URL），即显示为一句未分类的英文。这是刻意的取舍：宁可少分类，不可分错类。

web 单测 146 → **157**（新增 `failure.test.ts` 11 例，夹具用 viem 自己的 `TimeoutError`/`HttpRequestError`；`data.test.ts` 的数据库假对象补上真实字段，3 条依赖原始文本的断言按新契约更新），全项目 215 → **226**。见 ADR-0020。

### 校正 24：链上那三个 CID 从来不是 CID——一个没人验证过的字符串被当成了内容地址

链上（Sepolia `0x4bb0fd8c…503e`）的三个候选人 CID 是 `bafyseededcandidate0` / `bafyseededcandidate1` / `bafyseededcandidate2`。运行中的页面照实渲染：第一张卡片 `元数据 CID = bafyseededcandidate0`，`IPFS = CID 格式无效，无法解析`。**那句话是对的**——错的是上游，而项目里没有任何东西负责上游。

**这个缺陷为什么无法在界面层修。** `addCandidate` 带 `onlyPhase(Phase.Setup)`（`Voting.sol:88`），合约进入 Voting 之后这串字符串在同一地址上**不可替换、不可删除**。ADR-0004 的 Compatibility Boundary 写的是"链上只存 CID、内容在 IPFS"，但没有任何代码保证那个 CID 指向任何东西：CID 是一个**断言**，而断言与它所声称的字节之间，此前没有任何连接。类型系统、构建、单测、SSR、演练都对它无话可说，因为手写的 CID 与算出来的 CID 在类型上是同一个 `string`。

**先钉死编码器本身。** 新增 `contracts/scripts/cid.ts`（零依赖，只用 `node:crypto`）：sha2-256 多哈希、CIDv0 base58btc、CIDv1 base32lower、raw codec、dag-pb + UnixFS 单块 protobuf。判据是外部的，不是自己对自己的：`hello world\n`（12 字节）算出 `QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o`，与公开已知向量逐字符相同；其 CIDv1 `bafybeicg2rebjoofv4kbyovkw7af3rpiitvnl6i7ckcywaq6xjcxnc2mby` 从 `gateway.pinata.cloud` 取回正是那 12 字节（HTTP 200）。

**为什么必须"先 pin、再拿服务返回的 CID"，而不是"先算、再写链上"。** CID 由**字节 + 导入配置**共同决定。同一份字节在 dag-pb 与 raw 两种导入下是两个不同的块，而只有一个真的存在于网络上——实测：candidate-1 的 dag-pb CIDv1 `bafybeicsozbs4b4qfcshiqyxw7ghv7hexrcfvnpki57jieidh7yfavmsrm` 是合法 CID，但没有服务 pin 过它，模块取回得到 `{"status":"unreachable","attempts":3}`（36.2 s 内三个网关都没作答）。实测还发现 Pinata 的 `cidVersion: 1` 返回的是 **raw leaves**（`bafkrei…`）而不是 dag-pb——这个事实无法靠猜，猜错的代价是一个永久无法解析的链上字符串。

**成品**：`contracts/metadata/candidate-{1,2,3}.json`（林澈 / 周予安 / 苏芷宁）→ `pnpm pin:metadata` 上传原始字节 → 服务返回的 CID 与本地计算必须属于**同一个块**（`sameBlock`；CIDv0 与 dag-pb CIDv1 是同一个块的两种编码，比较字符串会把正确的 CID 判成不匹配）→ 从公共网关回读并逐字节比对 → 才写 `metadata/manifest.json`。三条实测**逐字符相同**：

| 文档             | 服务返回 = 本地计算                                           |
| ---------------- | ------------------------------------------------------------- |
| candidate-1.json | `bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a` |
| candidate-2.json | `bafkreiezmqiiomytpzj5bhprhqepa5ijenxdwtapomhubszecnc2jlx57y` |
| candidate-3.json | `bafkreicnafrpxomcyqhmba7n22yd662kik5bon4nldeusvep72i2luomnu` |

播种脚本不再接受手写 CID：默认取 manifest，`seedableCids()` 在使用前逐条重算并核对"这个 CID 就是这些字节"；`SEED_CANDIDATES` 覆盖仍保留（紧急入口），但逐条校验形状并在运行时声明"未与任何文档核对"。凭证只从 `contracts/.env` 读，**从不回显任何值**——半个凭证按"半个"报告（ADR-0016/0020 的措辞纪律）。

**顺带发现：一个比最慢真实应答更短的超时就是一台误报机器。** 本机对真实网关的实测（180 字节文档）：`gateway.pinata.cloud` 四次重复取回 **7.2 / 3.7 / 7.0 / 3.7 s**；`dweb.link`、`ipfs.io`、`w3s.link`、`4everland.io` 全部在网络层失败（约 11–12 s）。模块原先的 6 s 预算取三条真实 CID 时，三张卡片里有**两张**得到 `{"status":"unreachable","attempts":3}`——一个当时正在正常作答的网关被报成"不可达"，且用的正是真故障的措辞。因此单请求超时改为 **15 s**（代价：三个网关全无应答时最坏 45 s 才说出口，原先 18 s；期间只显示 `读取中…`），并把配置的网关与默认列表去重，`NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/`（**末尾斜杠是必需的**，模块拼的是 `${gateway}${cid}`）。

**重新部署与重建索引。** 新合约 `0x564a8c64a3f5a05c5a93a9050192cf293b1ea0b6`：`addCandidate` ×3 与 `startVoting` 在区块 11,749,345–11,749,348 成功。索引库**必须清空**，而且理由比"换了地址"更具体：重建前投影里仍是 `bafyseededcandidate0/1/2`，而 `sync_cursor.last_block = 11749347` 已经**越过**新合约的事件区间——不清空它，新合约的 `CandidateAdded` 永远不会被索引，`/api/candidates` 会回答"没有候选人"。

**实测（修复后）**：

| 观测点                                               | 结果                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 模块 + 真实网关 + 真实 CID（Node）                   | `{"status":"ok"}` ×3，耗时 4140 / 5889 / 6756 ms，姓名 林澈 / 周予安 / 苏芷宁                             |
| `pnpm ui:drill`（只读，Chain 11155111，真实 Chrome） | `metadata 已解析 / 已解析 / 已解析`、`names 林澈 / 周予安 / 苏芷宁`、控制台 **0 条消息**、17 条断言全通过 |
| `/api/health`、`/api/results`                        | `status=ok`、`lagBlocks=0`、`consistent`；索引侧与链侧都给出那三个真实 CID                                |

这是 `ok` 分支第一次在真实网关上发生，README §6 的两条"成功路径从未在真实网关上发生过"因此关闭。

**顺带发现：演练读得太早，断言全部通过却零证据。** 改动前 `ui-drill` 在钱包连上后**立即**读一次页面，那时三张卡片都还是 `读取中…`——所有关于元数据的断言都通过，而它们声称检查的结果**还没有发生**。只等元数据之后，`白名单` 与 `押金` 两行仍停在 `读取中…`，两条既有断言当场失败：等一行等于等错了对象。现在等到**整页**不再有 `读取中…`，并且新增两条双向断言——"被称为格式无效 ⟺ 不是可解析形状"与"显示文档姓名 ⟺ 已解析"（读每张卡片的 `元数据 CID` 与标题）。后者的第一版在姓名读成空串时**空洞通过**（`["","",""]` 与 `已解析` 并列仍算通过），已改为"空串不算显示姓名"。

**边界（诚实说明）**：`manifest.json` 的"确实已 pin"只在执行 `pnpm pin:metadata` 的那一次被证明；CI 不会 pin，因此一个后来消失的 pin 不会被任何测试发现。`--vote` / `--refund` 两个演练场景本轮**未重跑**（需要一个本地节点与第二套索引）；它们是同一块断言，推算 +2，但未经本轮实测。新断言的否方向（未解析时显示编号）与"重试"按钮仍**未在浏览器中渲染过**——链上现在全是真实可解析的 CID。

contracts 单测 28 → **60**（新增 `test/cid.ts` 19、`test/metadata.ts` 13），web 单测 157 → **161**（`gatewaysFor` 去重 4 例），全项目 226 → **262**。见 ADR-0021。

### 校正 25：写入路径把钱包的英文拒绝原样印在页面上，且不说链上有没有变化

读者在真实钱包里点「拒绝」后，页面在**我的状态**面板下渲染出一行英文：`User rejected the request.` 这是 `Ballot.tsx` 里 `writeError.message.split("\n")[0]` 的唯一产物，也是整页最后一处未经分类的英文——读路径此前已被 ADR-0009/0012/0014/0019/0020 逐行整治，**写路径只有这一行代码，从没有 ADR 提到过它**。

**这句话错了两件事。** 第一，`User rejected the request.` 是钱包的措辞、viem 的原文、英文，读者会以为程序坏了。第二件更贵：它没有回答"链上到底有没有变化"。拒绝签名与交易失败在链上的后果完全不同——前者什么都没发生、可以立刻重试，后者可能已经花掉 gas——**读者的下一个动作取决于这个区别**，而这句原文恰恰不说。实测（拒绝的同一时刻直读链）：`isWhitelisted=true`、`hasVoted=false`、`stakeOf=0 wei`、`totalStaked=0`、三候选人 `0/0/0`；同时 `eth_estimateGas(vote(1), 0.001 ETH)` 返回 `149049` 未 revert，即合约、白名单、阶段、金额当时**全都是对的**。

**为什么不能统一成一句"交易失败"。** 钱包能返回的成因彼此无关，其中 `already known`（节点认为这笔交易已提交过）是唯一一类**不能**说"链上没有任何变化"的——节点手里可能真的有一笔相同交易；链不匹配则重试一万次都不会成功。把它们合并，句子就必然在某一类情况下为假。

**做法**：新增纯函数 `describeWriteFailure(error)`，返回 `{ text, classified }`。分类读的是错误链上的**标记**而不是文本——走完 `cause` 链（上限 10 层、自引用安全）收集每一层的 `code`/`name`/消息，因为 viem 把钱包的 `ProviderRpcError` 埋在一到两层 `BaseError` 之下，只读 `error.message` 的分类器看不见 `4001`。六类各有一句中文，并用"链上有没有变化"收尾：拒绝（无变化）、已有待处理请求（无变化）、链不匹配（交易没有发出）、余额不足（交易没有发出）、`already known`（**可能已有相同交易，不要重复提交**）、合约回滚（状态没有改变，但若已打包网络费仍会消耗——回滚可能发生在估算阶段，也可能发生在打包之后，两句话都说才不会有假）。**不认识的成因不猜**：渲染一句"页面无法归类"+提示去看浏览器控制台，原始错误由组件在 `useEffect` 里 `console.error` 一次。

**实测（`pnpm ui:drill --reject`，真实 Chrome + 注入钱包，Sepolia 11155111，账户 `0x409da005…9589`）**：注入的 provider 在 `eth_sendTransaction` 上抛 `code 4001`，与真实钱包拒绝同一形状。新增 8 条断言全部通过、退出码 0：

| 断言                                 | 实测                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| 一个可点的投票按钮确实被点击         | `clicked`                                                  |
| 错误行存在                           | `你在钱包里拒绝了这笔交易，链上没有任何变化。`             |
| 成因被识别（非"无法归类"）           | `data-write-error="classified"`                            |
| 正文不含任何 ASCII 字母              | 通过（该句零 `[A-Za-z]`）                                  |
| 拒绝发生在钱包，且在页面请求签名之后 | `walletMethods = eth_chainId, eth_sendTransaction:refused` |
| 没有被说成"提交中…"                  | 通过                                                       |
| **"链上没有任何变化"为真**           | 点击前后 `hasVoted=false` / `stakeOf=0 wei` **逐位相同**   |
| 浏览器控制台                         | **0 条消息**（被识别的成因不打印，只有未识别才打印）       |

`--reject` **不广播任何交易**，因此与 `--vote`/`--refund` 不同，可以对着已部署的链跑；这也让"链上没有任何变化"第一次被**断言**过，而不只是被写下来。截图：`docs/screenshots/ui-write-error-rejected.png`。

**边界（诚实说明）**：`--reject` 复现的是 provider 拒绝签名这一形状，不是"在真实 MetaMask 里点拒绝"的完整链路（真实钱包在拒绝前还会自己做一次估算与 UI 确认；演练里估算转发到节点）。另外五类（`-32002`、链不匹配、余额不足、`already known`、合约回滚）**只有单测覆盖，没有在真实钱包上触发过**。**相邻缺口未修、仅登记**：写入路径没有"钱包在别的链上就不发交易"的前置守卫，`writeContract` 仍会把带押金的交易发往该链上并不存在合约的那个地址（ADR-0019 解决的是"读哪条链"）。

web 单测 161 → **173**（`ballot-labels.test.ts` 新增 12 例），`ui:drill` 只读场景 17 条断言 + `--reject` 8 条 = 25 条。见 ADR-0022。

### 校正 26：项目只有一次固定公投，没有任何「用户自己的投票」——而规格的非目标 3 明确写过「不做多轮次选举」

用户的原话是：「项目目前只存在投票，并且所有投票都是固定的，我需要用户可以新增修改删除自己的投票等，让项目具有实际作用。」

在这之前，整个项目是**一份合约、一次选举、三个写死的候选人**：`Voting.sol` 在构造函数里接收候选人 CID 数组，`mapping(address => bool) hasVoted` 让一票成为终局。这个形状能演示「链上唯一事实源 + 只读索引器」，但它没有任何**实际作用**：没有人能用它发起自己的投票，也没有人能改掉自己投错的一票。规格 §11 非目标 3 更是把「不做多轮次选举」写成了明确排除项，所以这次改动**首先是一次对已记录非目标的取代**，而不是一次普通的功能追加。

**做法**：改为工厂 + 每投票一份合约（`VotingFactory` + `Poll`，EIP-1167 克隆），并让投票人在一次投票内可以**投票 / 改投 / 撤票**。任何人都能创建投票，创建者拥有该投票的选项管理权（仅在 `Setup` 阶段）。决策依据与备选方案见 ADR-0023；改投与撤票的事件语义、以及「当前票只能由事件流推导」的约束见 ADR-0024。

**为什么不是「一张合约里用 `pollId` 分表」**——这是本次唯一的架构级选择，理由只有一条但足够决定性：分表方案为了能回答「这个投票现在几票」，必须在链上额外维护一个增量计数器 `voteCount[pollId][optionId]`，而它与 `votedFor` 是两份可以互相矛盾的数据。一旦矛盾，**链上不再具备独立重算的能力**，于是「票数等于投票人数」这个恒等式就离开了链——而留下它正是本项目的全部意义（ADR-0001）。工厂方案让每份 `Poll` 的 `results()` 继续作为该投票票数的权威答案，索引器仍是它的纯投影，ADR-0017 的一致性检查因此依然成立。

**同时被保留的不变量**（§5.2 全部未破）：链上仍是唯一事实源；后端仍不持有任何私钥（创建投票、投票、改投、撤票全部由用户钱包签名）；事件消费仍幂等（`UNIQUE(tx_hash, log_index)` + `INSERT IGNORE`）；游标与事件仍在同一事务内提交。

**一次必须说明的回归**：旧的单租户 ABI 不提供兼容层。旧合约 `0x564a8c64…` 上的选票数据在新前端中**不可读**。这是有意接受的代价——该合约是单人租户、没有外部消费者，兼容层会让 `decode.ts`、`data.ts`、`ui:drill` 长期分叉。已向用户披露。

## 15. 实测结果

| 指标          | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 覆盖率    | `contracts/Voting.sol` 行覆盖率 **100.00%**，语句覆盖率 **100.00%**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M-2 授权拦截  | 非白名单、重复投票、阶段错误（4 种）、质押金额错误、未知候选人、零地址、非管理员 → 全部 revert，无例外                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M-3 重入对照  | 四组矩阵全部按预期（见校正 8）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| M-4 属性测试  | 1000 轮确定性投票序列 + 256 轮 fuzz，0 反例；且经变异测试证明可失败（见校正 7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| M-5 Gas       | `vote` 中位 **109,256**（min 109,256 / avg 119,250 / max 143,456）；`refund` **37,920**；部署 **1,249,757**；运行时代码 5,298 字节                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M-6 一致性    | 链上 **200** 票 == 索引 **200** 票，3 名候选人逐一比对，**0 处偏差**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M-6 落后对账  | `CONFIRMATIONS=5`、链上 200 / 索引 197（`unindexedBlocks 5`、`pendingVotesAddedBack 3`）→ 判定 `consistent`；**同样的落后叠加删掉 1 行**（索引 196）→ 判定 `divergent`、退出码 1，差异指向 `candidateId 2`（`pending: 1`）。**故障没有被"还在确认窗口内"掩盖过去**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M-6 负向对照  | 从 `votes` 删除 1 行后：`status: "divergent"`、200 vs 199、定位到 `candidateId 2`（67 vs 66、`pending: 0`）、CLI 退出码 1、HTTP 500                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M-6b 幂等性   | 游标回退到 0 强制重放：**404 行全部命中重复，插入 0 行**，票数仍为 200（未翻倍）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M-6c 重组     | `evm_revert` 把真实链头 407→406：索引报告 `rewound`（`rewoundTo 406, discardedFrom 407`）、孤立事件行 201→200、票数保持 200                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M-6d 退款     | 真实退款 0.001 ETH：入库 `amount_wei` 与链上 `stakeOf` 逐位相同（`DECIMAL(38,0)` 无精度丢失）、票数保持 200、回退后索引撤销退款行与阶段行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M-6e 浏览器   | 注入 EIP-1193 provider 后驱动真实 DOM：未白名单账户投票按钮**全部禁用**且给出理由；已白名单账户按钮**全部可点**，点击后到达"已确认"、卡片变为"你已投给该候选人"；`--refund` 场景退款按钮可点、点击后**从链上读回 `stakeOf=0`**、按钮随即禁用；三场景均断言 DOM 中**不存在**"提交中…"。`pnpm ui:drill` 退出码 0（只读 **17** 项断言；本轮未重跑 `--vote`/`--refund`，两者按同一块断言推算为 21/23，**未经本轮实测**）。演练现在先等到**整页**不再有 `读取中…` 再读取（此前它读得太早，元数据断言全部通过却零证据——见校正 24），并断言每张卡片渲染的是文档里的姓名；只读场景在 Chain 11155111 上实测 `已解析 / 已解析 / 已解析`、`names 林澈 / 周予安 / 苏芷宁`、控制台 **0 条消息**，且三场景的浏览器控制台均无 error/warning——这条断言加上去的当次运行就抓到了 `/api/results` 的间歇 500（见 ADR-0017）；其措辞已在 ADR-0018 收紧为它真正验证的配置（注入 provider），且三场景的浏览器控制台均无 error/warning——这条断言加上去的当次运行就抓到了 `/api/results` 的间歇 500，见 ADR-0017 |
| M-6g 链身份   | `CHAIN_ID=11155111` 且无钱包（一次性 CDP 探针，不注入 provider）：`阶段` **投票中**（不再是 `未知`）、`合约地址` **0x4bb0fd…**（不再是本地合约）、`索引高度 11749047 / 安全头 11749047`、`链头 11749052（最近 5 块待确认）`、`落后区块 0`、控制台 **0 条消息**；用 `Network.setBlockedURLs` 屏蔽浏览器所用 RPC 后 `阶段` **读取失败**，而服务端读到的 `数据来源 / 票数合计 / 索引高度 / 链头` 全部保留。见校正 22（ADR-0019）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M-6e 写入失败 | `pnpm ui:drill --reject`（真实 Chrome + 注入钱包，Sepolia 11155111，账户 `0x409da005…9589`）：注入 provider 在 `eth_sendTransaction` 上抛 EIP-1193 `4001`，页面渲染 `你在钱包里拒绝了这笔交易，链上没有任何变化。`，`data-write-error="classified"`，正文零 ASCII 字母，`walletMethods=eth_chainId, eth_sendTransaction:refused`；点击前后链上 `hasVoted=false`/`stakeOf=0 wei` 逐位相同，浏览器控制台 0 条消息。7 条断言全通过、退出码 0，截图 `docs/screenshots/ui-write-error-rejected.png`。见校正 25、ADR-0022                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M-7 构建      | Next.js 生产构建成功：1 个页面 + 5 个动态 Route Handler 全部产出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M4 部署边界   | 部署脚本指向**真实** Sepolia（实测区块 11,742,273）：解析网络、由私钥推导部署账户、owner 默认取部署者、构造并广播交易 → 失败于 `gas required exceeds allowance (0)`，**唯一缺口是测试 ETH**；`verify:sepolia` 在**无** `SEPOLIA_PRIVATE_KEY` 时仍连上 Sepolia 并走到"该链无部署记录"守卫。失败的部署不写入 `deployments/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 测试总数      | Solidity 41 个 + TypeScript(viem) 60 个 + web 单测 173 个 = **274 个，全部通过**（web 161 → 173 为本轮新增，合约侧本轮未改动）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### M-6 的 API 层观测（实测响应）

```json
{
  "status": "consistent",
  "onChainTotal": 200,
  "indexedTotal": 197,
  "discrepancies": [],
  "pendingVotes": 3,
  "unindexedBlocks": 5,
  "onChain": { "source": "chain", "total": 200, "candidates": [ … ] },
  "indexed": { "source": "index", "total": 197, "candidates": [ … ] },
  "lastIndexedBlock": "401"
}
```

上例是 `CONFIRMATIONS=5` 下的真实响应：索引只持有 197 票（`lastIndexedBlock 401`），但 `(401, 406]` 区间内的 3 条 `VoteCast` 被解码并加回索引一侧，因此判定 `consistent`。`pendingVotes` 把这个加回量显式暴露出来，读者不必猜"197 与 200 为何算一致"。

`/api/health` 同时报告 `lastIndexedBlock` / `chainHead` / `lagBlocks`；实测本地环境为 `406 / 406 / 0`。

### M-6 的负向对照，以及它暴露出的一个真实缺陷

只观测到"一致"的一致性检查器不是证据——这与校正 7 里空转的不变量测试属于同一类错误。因此补做了负向对照：删掉 `votes` 表的**一行**，观察两侧是否被发现。

结果符合预期：CLI 退出码 1，`status: "divergent"`，200 vs 199，并精确定位到 `candidateId 2`（链上 67 / 索引 66 / `pending: 0`）；`/api/results` 返回 HTTP 500 与同一份差异。

但这次对照同时暴露了一个**界面缺陷**：`/api/results` 在不一致时返回 500，而浏览器端的 `fetchResults` 走的是一个"任何非 2xx 即抛错"的通用助手，于是它**丢掉了 500 里那份完全有效的差异负载**，react-query 将请求标记为失败，界面显示的是：

> 无法比对（索引 API 不可达）

而事实恰恰相反——比对成功了，并且发现了不一致。这个文案会把排查者引向网络故障，而真实原因是数据分歧。修复方式是让 `fetchResults` 把"能解析成结果体的 500"当作数据返回（500 状态码保留，因为它对监控告警有用），其余情况仍抛错；并补了 7 个回归测试固定这一行为。修复后界面正确显示：

> 链上 200 票 ≠ 索引 199 票 · 1 处偏差

这条记录的意义在于：**正是负向对照把缺陷逼出来的**——只测 happy path 时，这个缺陷完全不可见。

### M-6 的第三个缺陷：这个检查器在默认配置下会稳定误报

负向对照证明了检查器**会**报警。但它还没有证明报警是**对的**——顺着这条线追下去，发现了比界面文案更严重的问题。

README 里有一句断言：索引按设计会落后，所以 `/api/results` "会因此显示不一致——这是设计上的诚实表现，而不是 bug"。这句话读起来很合理，于是对它做了实测：把 `CONFIRMATIONS` 设回默认的 5（链头 406、安全头 401），重建索引后运行检查器。

结果是**稳定误报**：退出码 1，`"consistent": false`，`onChainTotal` 200、`indexedTotal` 197。而数据库完全健康——索引精确地停在它被允许读取的最后一个区块 401，这正是 `CONFIRMATIONS=5` 的定义。

**所以缺陷不是"检查器太严格"，而是它问错了问题。** 它拿"链上此刻的状态"去比"索引被允许知道的状态"，而这两者本来就应当不同。后果是：在默认配置下这个检查器**永远**报故障，它提供的信号因此为零；更糟的是，真正的分歧出现时，它和现在长得一模一样。一个在所有情况下都报警的警报，等价于没有警报。

修复方式不是放宽阈值，而是**把差集解释清楚**：拉取 `(cursor, head]` 区间内的日志，解码其中的 `VoteCast`，把票数加回索引一侧再比较。这样问的才是唯一值得问的问题——"索引，加上它还不被允许看到的东西，是否等于链上的结果？"

修复后的判别力实测（两种情况具有**完全相同**的合法落后）：

| 数据库状态                       | `unindexedBlocks` | `pendingVotesAddedBack` | `status`     | 退出码 |
| -------------------------------- | ----------------- | ----------------------- | ------------ | ------ |
| 健康（197 票）                   | 5                 | 3                       | `consistent` | 0      |
| 同样的落后 + 删掉 1 行（196 票） | 5                 | 3                       | `divergent`  | 1      |

第二行才是这次修复真正的验收标准：**真实故障没有被"还在确认窗口内"掩盖过去**，它仍被抓到并定位到 `candidateId 2`（`pending: 1`，即把待确认的那 1 票加回来也仍然对不上）。

### 同一轮排查里发现的退出码缺陷

追查上面这条误报时，`check-consistency` 的退出码显示为 `0xC0000409`，可它打印的判定其实完全正确。原因就写在 stderr 里：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

脚本当时用 `process.exit()` 退出。它**立即终止进程，`finally` 块不会执行**，于是 `pool.end()` 从未被调用；Windows 上 libuv 在拆卸仍未关闭的句柄时触发断言，把一次正确的运行报成了崩溃。

对一个"契约就是退出码"的验证脚本，这让退出码 0 和 1 同时失去意义。修复是改用 `process.exitCode`，让 Node 在 `finally` 跑完之后自然退出；两个演练脚本末尾同样的写法一并改掉。修复后连续三次运行 `check-consistency` 均稳定退出 0，且 stderr 不再出现断言。资源创建**之前**的预检仍保留 `process.exit()`——那里没有句柄可竞争。

### M4 的部署边界，以及在边界处发现的验证脚本缺陷

D3 要求"Sepolia 真部署（含 Etherscan 源码验证）"。本机没有任何 Sepolia 凭证，因此这里能做的最强验证是**把部署路径推到凭证边界的前一步**，让唯一剩下的缺口尽可能小且明确。

做法是：无需密钥的公共 Sepolia RPC（`https://ethereum-sepolia-rpc.publicnode.com`，实测 `eth_chainId` 返回 11155111）+ 一个公开已知、余额确为 0 的 Hardhat 测试账户作为部署者。结果：

```
Network:  sepolia
Deployer: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8
Owner:    0x70997970c51812dc3a010c7d01b50e0d17dc79c8 (defaults to the deployer)
TransactionExecutionError: Execution reverted with reason: gas required exceeds allowance (0).
```

这证明了对真实 Sepolia 而言，**除"账户有钱"以外的每一环都已工作**：网络解析、私钥 → 账户推导、owner 默认值、交易构造与广播尝试。失败的部署也没有写入 `contracts/deployments/`（事后该目录仍只有 `31337.json`），因此一次失败的尝试不会污染本地记录。

**顺带发现的缺陷：源码验证竟然要求部署者私钥。** `verify:sepolia` 原本走 `sepolia` 网络，而该条目声明了 `accounts: [configVariable("SEPOLIA_PRIVATE_KEY")]`。Hardhat 会在脚本自身的守卫运行**之前**解析传入的网络，于是验证一个**已经部署的公开合约**也强制要求私钥存在，报 `HHE7: Configuration Variable "SEPOLIA_PRIVATE_KEY" not found`——而验证只发布源码，从不签名。

修复：新增不带 `accounts` 的 `sepoliaReadOnly` 网络条目，并让 `verify:sepolia` 指向它。实测在完全没有 `SEPOLIA_PRIVATE_KEY` 的情况下，验证脚本成功连上 Sepolia、取到 chain 11155111，并走到它自己的"该链无部署记录"守卫；而 `deploy:sepolia` 仍然正确要求私钥。这条解耦不是洁癖：它决定了做验证的机器（包括 CI）是否必须持有部署密钥。

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

**保留下来的东西（有意为之）**：`plan.ts` 的纯函数式分块/重组判定、`decode.ts` 的事件解码、`sync.ts` 的事务+游标+幂等写入，以及它们的单测（移植时 36 个，现仍为 36 个；索引器单测总数从 36 增至 57，新增的是 `config` 4、`report` 10、`client-api` 7）——这些逻辑与 HTTP 框架无关，是被移植而非重写的。M-1…M-6b 的全部实测值在重构后重新跑过并且不变。

**新增的验证**：M-7（Next 生产构建）、全部 5 个 API 路由的实测响应（含 400 / 404 / 503 分支）、以及"无 `DATABASE_URL` 时降级为 `status: "unavailable"`"这一路径。

**被删除的代码**：`indexer/src/api/server.ts` 的 Express 接线（其 `compareTally` / `readIndexedTally` 逻辑保留在 `web/src/lib/report.ts`）、Vite 配置与 `index.html`、`packages/shared` 包本身。旧实现完整保留在 git 历史（提交 `926c1de`）中。

---

## 17. 多租户改造的实测记录（校正 26 的证据）

### 合约层

| 指标             | 实测                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 合约测试总数     | **145 通过**（86 Solidity + 59 nodejs），0 失败                                                                                                                                                                                                                         |
| 工厂测试         | 12 条：创建、事件、任何人可创建、**两投票不共享票数与押金**、**各自 admin**、克隆二次初始化被拒、`allPolls` 有序、克隆全生命周期                                                                                                                                        |
| 属性测试         | 40 选民 × 3 选项 × **1000 轮**交错 投/改投/撤票，每轮复查 4 条不变式，0 反例；并断言四类结果各自都发生过                                                                                                                                                                |
| 负向对照（合约） | 注释掉 `changeVote` 中旧选项递减 → 如期失败：`the tally must equal the number of current voters: 9 != 8`、`ten changes still amount to exactly one vote: 11 != 1`、`sum(voteCount) must equal the number of voters: 2 != 1`、`every vote left the first option: 1 != 0` |

### 链下投影：`current_votes` / `option_tally` 必须对**真实 MySQL** 验证

索引的"当前票"由一个视图推导（取每个 `(poll_address, voter)` 的最后一条事件）。这类逻辑有一个特殊风险：**用 TypeScript 模型或 mock 写的测试会无条件同意自己的实现**——它们验证的是"我对 SQL 的理解"，而不是 SQL 引擎的实际行为。相关 `NOT EXISTS` 关联子查询尤其如此。

因此 `web/test/derivation.test.ts` 在 `DATABASE_URL` 存在时会走**真实数据库**：用真实 `migrate()` 建表，把同样的行灌进真库，再走真实的 `current_votes` / `option_tally` 视图读取并比对。

实测（本机 MySQL 8，`voting_derivation_check` 独立库）：**17 / 17 通过**。确认行确实落库：`polls` 21、`options` 58、`votes` 46、`current_votes` **28**、`option_tally` 58。`current_votes`(28) < `votes`(46) 本身即是"视图真的在折叠每个投票人的多条事件"的直接证据。

**负向对照（关键）**：把 `current_votes` 改为返回**每一条**事件而不是最后一条（`current_votes` 行数 28 → 46），重跑同一批测试：

```
✖ takes a change as the current vote, not the original cast
✖ leaves a withdrawn voter with no current option, present and null
✖ re-votes after withdrawing
✖ orders by (block_number, log_index), not by log_index alone
✖ moves the vote, rather than counting both, after a change
✖ drops the vote entirely after a withdrawal
✖ does not treat a withdrawal as a vote for option 0
✖ counts only the last event when a voter changes twice
✖ counts a full voter population correctly across a mixed event stream
tests 17 | pass 8 | fail 9
```

9 条如期失败。这证明这批测试**确实在读真实视图**，而不是在复述一个与视图同源的 TS 模型——后者会在视图被改坏时依然全绿。恢复视图（重跑 `migrate`）后回到 17/17。

**同一改动的另一项端到端实测**：对一个**在同一区块区间内被创建并投票**的投票，`syncOnce` 一次 pass 完成索引（`seen:5 inserted:5 pollsDiscovered:1`），且 `option_tally` 正确显示"旧选项 0 票、新选项 1 票"——即同轮发现新投票与改投语义同时成立。

### 必须记录的一项环境限制

**`verify:sepolia` 在本机无法成功**，原因不是代码：`api.etherscan.io` 被 DNS 解析到 `157.240.1.9`（一个与 Etherscan 无关的地址），且 `TCP 443` 不可达（实测 `TcpTestSucceeded=False`）。同一时刻 Sepolia RPC 正常（`eth_blockNumber` 可读）。因此**合约源码未在 Etherscan 上验证**，而这是在本次改造中新部署的地址：

- 工厂 `0x95D0D46d1DDc774B27Ee7f00e599Bf34938df2Ed`
- `Poll` 实现 `0xDcd4cB2d5fDF6A489Fc1A19B6204Eea030bc17eC`

部署本身已通过直读链上确认（`pollCount()=1`、`allPolls()` 返回该投票、`question`/`optionCount`/`phase`/`endsAt`/白名单逐项读回正确）。**验证源码是可发布性而不是正确性**，因此这条限制不影响功能声明，但必须写明而不是省略——`README` 与 `pnpm verify:sepolia` 的输出在任何网络可用的机器上重跑即可补齐。

### 端到端实测：从浏览器点击到索引一致

单元测试与属性测试都不经过浏览器。为此在本地链（31337）上跑了完整回路，每一步都实测：

| 步骤                              | 实测结果                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed:local`（工厂 + 两个投票）   | 投票 1 有 200 票 / 3 选项，投票 2 有 5 票 / 2 选项                                                                                                                                                                      |
| `indexer:drain`                   | 一轮 `rounds:1` 索引 **421** 行事件                                                                                                                                                                                     |
| `check-consistency`（**逐投票**） | `status=consistent`、`divergentPolls=0`，**两个投票各自一致**：200/200 与 5/5                                                                                                                                           |
| 负向对照                          | 只删投票 2 的 **1** 行投票 → 输出 `status=divergent`、`divergentPolls=1`，**点名投票 2**、`onChainTotal=5 vs indexedTotal=4`、定位到 `optionId:1`，**exit 1**；投票 1 **仍报 consistent**（证明逐投票隔离）             |
| 重放自愈                          | 游标归零后重放：看到 **421** 行，只插入缺失的 **6** 行，**415** 行判为重复而忽略（幂等在大规模上成立），一致性恢复                                                                                                      |
| 浏览器真实投票（`--vote`）        | 未投票账户 3 个按钮全可点 → 点击 → 交易确认 → `data-option-mine` **恰为 1 个**，另两个变为"改投到这个选项"                                                                                                              |
| 浏览器真实改投（`--change`）      | 链上 `currentOptionId` **1 → 2**（与所点按钮的 `data-option-id` 一致）；**押金两次读数完全相同**（`1e15` wei）                                                                                                          |
| 索引折叠改投                      | `onChainTotal` 与 `indexedTotal` 均为 **202**（不是 203），选项 1 减 1、选项 2 加 1——改投是**移动**而非第二票                                                                                                           |
| 索引库不可用时的降级              | `status=degraded`、`indexError` 指向 `DATABASE_URL`；`/api/polls` **仍列出两个投票**；tally **回落到 `source=chain`** 且数值相同；`results` 报 **`unavailable`（不是 `consistent`）**，`lagBlocks` 为 null 而非编造数字 |

### 本轮在演练中发现并修掉的缺陷

**第三个缺陷：`seed-local.ts` 用本机时钟计算截止时间。** 本地链被 `refund-drill` 用 `evm_increaseTime` 推进 30 天以触达 Ended 阶段后，链上时间戳比本机墙钟**超前约 30 天**。而 `seed-local.ts` 当时算的是 `endsAt = Date.now() + 30 天`——在链看来这个截止时间**已经过期**，`createPoll` 以 `DeadlineNotInFuture` 拒绝，脚本以一条 `unrecognized custom error (return data: 0xcdaf63ec…)` 结束。

这条报错本身几乎无法诊断：日志只给一串十六进制。把它与编译产物中的自定义错误逐一比对才定位到 `0xcdaf63ec = DeadlineNotInFuture(uint256)`，参数解码为 `1792592263`，而当时链上区块时间戳是 `1792593725`——**晚了 25 分钟**。

修法是改读链上的 `latest.timestamp`（`create-poll.ts` 本来就是这么写的，两个脚本此前不一致）。这是"看起来正确、只在特定时钟偏移下失效"的典型：在一条时间戳与本机同步的链上，它永远对。因此专门构造失败条件验证——把链推进 30 天后再跑 `seed:local`：

| 公式                   | 链超前 30 天时算出的 `endsAt`    | 结果                        |
| ---------------------- | -------------------------------- | --------------------------- |
| 旧：`墙钟 + 30 天`     | `1792593854`（**早于**链时间戳） | `DeadlineNotInFuture` 回滚  |
| 新：`链时间戳 + 30 天` | `1795186277`（晚于链时间戳）     | 部署成功，距链 **30.00 天** |

修复后在同一条超前 30 天的链上 `seed:local` 成功：工厂部署、投票 1 创建并接受 **200** 票、投票 2 创建并接受 **5** 票，`endsAt` 经链上读回距链时间戳 **30.00 天**。

改造把断言从"一票制"搬到"多租户"时，**有两条断言静默失效**——它们不再可能通过，却也不会因为界面出错而报警：

1. 改投后的断言写死了旧文案 `你已投给该候选人`，而该字符串在改造后**已不存在于代码中**。
2. "我的状态"面板的结束边界写死了旧标题 `候选人（`，改造后变为 `选项（`；找不到边界时切片延伸到页面末尾，`白名单` 那一行的断言开始在**整页文本**里搜索。

两条都已改为读组件自身的契约（`data-option-mine` / `data-option-action`）与按前缀识别标题，并**额外断言边界确实被找到**。这是"断言看起来还在、实际已经不成立"的典型样本：比没有断言更危险，因为它提供虚假的保护感。

另外修掉一个真实缺陷：`changeVote` 在同一笔交易里同时发出 `VoteChanged` 与 `VoteCast`（后者重报新票数，供只看 tally 的消费者使用）。索引如实记录两行，于是只点了一次"改投"的地址，历史里显示"投给选项 2"紧跟在"改投到选项 2"之后，读起来像投了两次。现在**来源交易与 `VoteChanged` 相同的 `VoteCast`** 会被合并（ADR-0024 所说的"回声"），而独立交易中的 `VoteCast`（撤票后重新投票）仍保留；两个方向都有测试。
