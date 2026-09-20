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

| 启动方式                | `/api/health`                                                          |
| ----------------------- | ---------------------------------------------------------------------- |
| `INDEXER_ENABLED=false` | `indexConfigured: true`、`indexerLoopEnabled: false`，页面显示上述提示 |
| 默认                    | `indexConfigured: true`、`indexerLoopEnabled: true`，页面不显示提示    |

新增一个 `data.test.ts` 用例专门钉住二者的区分。索引器单测 81 → **82**，总数 **130** → **131**。

顺带按实测更正三处陈旧的演练断言计数：ADR-0009 与本文档 §15 原写"7 / 11 / 17"，在快照内重测后为**只读 12、`--vote` 16、`--refund` 18**。本轮还向演练新增了一条断言（要求每个候选人卡片以已知措辞说明其元数据状态）；新增时用错了分母（拿按按钮文字过滤出的数量作基数，而该文字随阶段变化），被断言自己在 `--refund` 场景下抓出并修正——改为与卡片数比较。

## 15. 实测结果

| 指标         | 结果                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 覆盖率   | `contracts/Voting.sol` 行覆盖率 **100.00%**，语句覆盖率 **100.00%**                                                                                                                                                                                                                                                                                                          |
| M-2 授权拦截 | 非白名单、重复投票、阶段错误（4 种）、质押金额错误、未知候选人、零地址、非管理员 → 全部 revert，无例外                                                                                                                                                                                                                                                                       |
| M-3 重入对照 | 四组矩阵全部按预期（见校正 8）                                                                                                                                                                                                                                                                                                                                               |
| M-4 属性测试 | 1000 轮确定性投票序列 + 256 轮 fuzz，0 反例；且经变异测试证明可失败（见校正 7）                                                                                                                                                                                                                                                                                              |
| M-5 Gas      | `vote` 中位 **109,256**（min 109,256 / avg 119,250 / max 143,456）；`refund` **37,920**；部署 **1,249,757**；运行时代码 5,298 字节                                                                                                                                                                                                                                           |
| M-6 一致性   | 链上 **200** 票 == 索引 **200** 票，3 名候选人逐一比对，**0 处偏差**                                                                                                                                                                                                                                                                                                         |
| M-6 落后对账 | `CONFIRMATIONS=5`、链上 200 / 索引 197（`unindexedBlocks 5`、`pendingVotesAddedBack 3`）→ 判定 `consistent`；**同样的落后叠加删掉 1 行**（索引 196）→ 判定 `divergent`、退出码 1，差异指向 `candidateId 2`（`pending: 1`）。**故障没有被"还在确认窗口内"掩盖过去**                                                                                                           |
| M-6 负向对照 | 从 `votes` 删除 1 行后：`status: "divergent"`、200 vs 199、定位到 `candidateId 2`（67 vs 66、`pending: 0`）、CLI 退出码 1、HTTP 500                                                                                                                                                                                                                                          |
| M-6b 幂等性  | 游标回退到 0 强制重放：**404 行全部命中重复，插入 0 行**，票数仍为 200（未翻倍）                                                                                                                                                                                                                                                                                             |
| M-6c 重组    | `evm_revert` 把真实链头 407→406：索引报告 `rewound`（`rewoundTo 406, discardedFrom 407`）、孤立事件行 201→200、票数保持 200                                                                                                                                                                                                                                                  |
| M-6d 退款    | 真实退款 0.001 ETH：入库 `amount_wei` 与链上 `stakeOf` 逐位相同（`DECIMAL(38,0)` 无精度丢失）、票数保持 200、回退后索引撤销退款行与阶段行                                                                                                                                                                                                                                    |
| M-6e 浏览器  | 注入 EIP-1193 provider 后驱动真实 DOM：未白名单账户投票按钮**全部禁用**且给出理由；已白名单账户按钮**全部可点**，点击后到达"已确认"、卡片变为"你已投给该候选人"；`--refund` 场景退款按钮可点、点击后**从链上读回 `stakeOf=0`**、按钮随即禁用；三场景均断言 DOM 中**不存在**"提交中…"。`pnpm ui:drill` 退出码 0（只读 12、`--vote` 16、`--refund` 18 项断言，均在快照内实测） |
| M-7 构建     | Next.js 生产构建成功：1 个页面 + 5 个动态 Route Handler 全部产出                                                                                                                                                                                                                                                                                                             |
| M4 部署边界  | 部署脚本指向**真实** Sepolia（实测区块 11,742,273）：解析网络、由私钥推导部署账户、owner 默认取部署者、构造并广播交易 → 失败于 `gas required exceeds allowance (0)`，**唯一缺口是测试 ETH**；`verify:sepolia` 在**无** `SEPOLIA_PRIVATE_KEY` 时仍连上 Sepolia 并走到"该链无部署记录"守卫。失败的部署不写入 `deployments/`                                                    |
| 测试总数     | Solidity 41 个 + TypeScript(viem) 8 个 + 索引器单测 82 个 = **131 个，全部通过**                                                                                                                                                                                                                                                                                             |

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
