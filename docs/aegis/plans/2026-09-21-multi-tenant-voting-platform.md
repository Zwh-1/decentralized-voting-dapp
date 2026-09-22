# 实施计划：从"一次性公投"改造为"用户自建投票平台"

> 本计划由 `writing-plans` 产出，落在 `docs/aegis/plans/`。
> 它不是完成授权，也不替代规格与基线；执行中的完成声明仍需证据。

## Goal

让任何人都能**自己发起一个投票**（自定标题、选项、截止时间），并对**自己投出的票**拥有完整的增删改：改投、撤票。改造后项目不再只有一条写死的三候选人公投，而是一个多租户投票平台。

用户在本会话确认的三项决策（`Requirement Ready Check` 的来源）：

| 决策     | 结论                                   |
| -------- | -------------------------------------- |
| 投票模型 | **C. 用户自建投票（多租户平台）**      |
| 修改范围 | **候选人可增删改**                     |
| 部署目标 | **重新部署到 Sepolia**（沿用既有流程） |

## Architecture

```
                    ┌────────────────────────────────────────┐
                    │  VotingFactory.sol（新）                │
                    │  createPoll(question, options[], endsAt)│
                    │  → 部署一个新的 Poll 合约（clone）      │
                    │  → 记录 polls[]，发 PollCreated        │
                    └───────────────┬────────────────────────┘
                                    │ 每个投票一个独立合约
                                    ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Poll.sol（由 Voting.sol 改造）                             │
   │  owner = 发起者                                             │
   │  question / options[] / endsAt                              │
   │  addOption / removeOption / updateOption   （发起者，开始前）│
   │  startPoll / endPoll                                        │
   │  vote(optionId)              押金，一人一票                  │
   │  changeVote(optionId)        改投（同一押金）                │
   │  withdrawVote()              撤票（退还押金）                │
   │  refund()                                                   │
   └────────────────────────────────────────────────────────────┘
                                    ▲
             写：用户钱包直连签名（后端仍不参与，D6/ADR-0001 不变）
                                    │
   ┌────────────────────────────────┴───────────────────────────┐
   │  web/ Next.js：投票列表页 → 单个投票页 → 我的投票页          │
   │  只读索引器：索引 Factory 与全部 Poll（多地址）              │
   └────────────────────────────────────────────────────────────┘
```

**关键架构决定（本计划主张，需在 ADR 中记录）**：多租户用**工厂 + 每投票一个合约**，而不是"一个合约里 `mapping(pollId => Poll)`"。理由是前者让"一人一票"的计数变成合约内的 `mapping`，替换掉了索引器去重逻辑；后者会把"同一地址在同一投票里的多张票"变成需要索引层聚合的语义，与"链上是唯一事实源"（ADR-0001）冲突。

## Tech Stack

不变：Solidity 0.8.37 + Hardhat 3.17 + viem + Next.js 16 + wagmi 3 + MySQL（可选索引）。OpenZeppelin 5.6.1（`Ownable`、`ReentrancyGuard`）；克隆用 OZ 的 `Clones`（EIP-1167）以省 gas。

## Baseline / Authority Refs

```text
BaselineUsageDraft:
- Required baseline refs: docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md §5（合约）、§6（索引器）、§11（非目标）、§12（ADR 信号）; docs/aegis/baseline/2026-09-20-initial-baseline.md §5.2（不变量：链上唯一事实源、后端不持私钥、幂等消费、一人一票、事件与游标同事务）
- Delivered context refs: 本会话读到的 Voting.sol / config.ts / decode.ts / page.tsx / schema.ts / ADR-0005 / ADR-0020 / ADR-0021
- Acknowledged before plan refs: ADR-0001（链上唯一事实源）、ADR-0005（押金构造重入面）、ADR-0009（按钮可用性来自链上）、ADR-0010（部署记录单一 schema）、ADR-0019（浏览器读部署配置的链）、ADR-0021（CID 由字节算出）
- Cited in plan refs: §5、§6、§11、§12、基线 §5.2 全部 5 条不变量、ADR-0001/0005/0009/0010/0019/0021
- Missing refs: 无（§11 非目标 3 需被本计划显式取代，见 Tasks 中的规格修订任务）
- Decision: continue
```

## Requirement Ready Check

```text
Requirement Ready Check:
- Requirement source refs: 用户本会话的选择（模型 C / 候选人可增删改 / 重新部署 Sepolia）
- Goals and scope refs: 本计划 Goal；spec §1 与 §11 需同步修订
- User / scenario refs: 发起者（建投票、管选项）、投票人（投票/改投/撤票/退款）、任意访客（查看列表与结果）
- Requirement item refs: Tasks 1-8
- Acceptance / verification criteria refs: 每个 Task 的 Verification 段；平台级验收见 Task 8
- Open blocker questions: 无
- Decision: ready
```

## Change Necessity

```text
Change Necessity:
- User-visible need: 用户要能自建投票、并对自己的票增删改；当前合约一个地址只能投一次、候选人写死且 Setup 后不可改
- No-change / non-code option: 不可行。`hasVoted` 一次即真、`addCandidate` 带 `onlyPhase(Setup)`、没有改票/撤票入口——这些是合约层面的限制，前端绕不过去
- Why code change is necessary: 准入模型与生命周期都变了，必须改合约并重新部署（`addCandidate` 与阶段不可改，ADR-0021 已踩过）
- Minimum change boundary: contracts/contracts/{Poll,VotingFactory}.sol + 对应测试；web 的读模型（列表/单投票/我的投票）+ 索引器多地址支持 + 部署记录；文档（规格 §5/§6/§11/§12、README、ADR、基线漂移）
- Decision: code-change
```

## Compatibility Boundary

1. **旧地址 `0x564a8c64…` 上的那份公投在新版前端里不再可用**（ABI 不兼容）。前端只指向新部署；旧地址仅保留在 `deployments/11155111.json` 的历史里不可读——**本计划主张不保留向后兼容层**，理由见 Retirement。
2. `votingAbi` 是生成的（`pnpm export-abi`），契约变更必须走它，不允许手写 ABI。
3. `/api/*` 的响应形状尽量不变（`{source, total, candidates}`），但 `candidates` 的语义由"候选人"变为"选项"，且**新增 `pollId` 维度**：`/api/candidates` → `/api/polls/[id]/options`。
4. 数据库表需新增 `polls` / `options`（替代 `candidates`），`votes` 增加 `poll_id`。**换库或加迁移**：本计划选择**加迁移**（`migrate.ts` 已存在），因为清库会丢掉现有 200 票演示数据；但 Sepolia 库本轮反正要换合约，故 Sepolia 走清库（理由与 ADR-0021 那一轮相同：游标越过新区块区间）。

## TDD Route

```text
TDD Route:
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Strict signals: 触及合约、持久化、权限 —— 这些信号在 auto 下会要求 strict，但本会话未开启 auto，且用户未要求严格 TDD
- Light eligibility: 不适用（改动不小）
- TDD-fit exception: 不适用
- Test posture: post-change regression（沿用本仓库既有做法：Solidity 用 Hardhat 测试与属性测试，web 用 node:test 纯函数测试）
- Reason: 仓库既有测试风格是先写实现再补针对性回归与负向对照（见 §14 校正记录）
- Verification: 每个 Task 的 Verification 段给出确切命令与预期
```

## Files

**新建**

- `contracts/contracts/Poll.sol` — 单个投票（由 `Voting.sol` 改造）
- `contracts/contracts/VotingFactory.sol` — 工厂，部署并登记每个 Poll
- `contracts/test/Poll.ts`（viem 层）/ `contracts/contracts/Poll.t.sol`（Solidity 层）
- `contracts/contracts/PollProperties.t.sol` — 属性测试（改造自 `VotingProperties.t.sol`）
- `contracts/scripts/create-poll.ts` — 命令行建投票（便于本地与 Sepolia 演示）
- `web/src/components/PollList.tsx` / `PollCard.tsx` / `CreatePollForm.tsx` / `MyVotes.tsx`
- `web/test/write-failure.test.ts`（若新增错误类别，扩充 `describeWriteFailure` 的用例）

**修改**

- `contracts/contracts/Voting.sol` → 删除（由 `Poll.sol` 取代）
- `contracts/scripts/{deploy,seed-local,seed-sepolia,export-abi,preflight}.ts`
- `web/src/lib/{contracts/deployments,config,voting,ballot-labels,data,db/schema}.ts`
- `web/src/lib/indexer/{decode,sync}.ts` — 多地址（Factory + 各 Poll）
- `web/src/app/page.tsx` + 新增 `web/src/app/poll/[id]/page.tsx`、`web/src/app/my/page.tsx`
- `web/src/app/api/**` — 列表与单投票路由
- `README.md`、`docs/aegis/specs/…`（§5/§6/§11/§12 + 新校正）、`docs/aegis/baseline/…`（漂移行）、`docs/aegis/INDEX.md`、新 ADR

**删除（Retirement）**

- `contracts/contracts/test/{CEIOnlyRefund,GuardOnlyRefund,VulnerableRefund,RefundAttacker,EthRejectingVoter}.sol` 中仅服务于旧写入路径的夹具，逐一判定保留/删除
- `web/src/components/Ballot.tsx` / `CandidateCard.tsx` 拆解为投票列表与单投票页

## Existence Check

```text
Existence Check:
- Proposed new surface: VotingFactory 合约 + 每投票一个 Poll 合约（克隆）
- Existing owner / reuse candidate: 现有的单个 Voting 合约（单租户）
- Why existing surface is insufficient: 单合约无法表达"N 个互不相干的投票各有自己的选项与生命周期"；塞进一个合约需要 `mapping(pollId => …)`，会把"一人一票"从合约内 `mapping` 降级为索引层聚合，违反 ADR-0001（链上唯一事实源）与基线 §5.2 的"一人一票"不变量
- Creation proof: 只有工厂能让"任何人建投票"在不给后端私钥的前提下成立（D6/ADR-0001 的边界）；且每个投票的 owner 是发起者，权限天然隔离
- Entropy / retirement impact: 新增一个 owner（Factory）；旧 `Voting.sol` 与其单租户假设**整体退役**，不保留兼容层
- Decision: add-with-proof
```

## Architecture Integrity Lens

```text
Architecture Integrity Lens:
- Invariant: 链上是唯一事实源；一人一票；后端不持私钥；事件幂等；游标与事件同事务（基线 §5.2 全部 5 条）
- Canonical owner / contract: Poll 合约是"这个投票的票数"的唯一 owner；Factory 只负责创建与登记，绝不记账
- Responsibility overlap: 索引器只做只读投影，不得成为任何计数的权威；`candidate_tally` 视图由 `votes` 聚合而来，改表后必须保持"派生而非权威"
- Higher-level simplification: 用"工厂 + 每投票一个合约"把多租户压力留给部署结构，而不是让索引层承担聚合语义
- Retirement / falsifier: 若"一人一票"无法在索引层被验证为与链上一致（即 M-6 一致性检查对多投票失效），则本架构主张被证伪，须回到单租户
- Verdict: proceed
```

## Plan Pressure Test

```text
Plan Pressure Test:
- Owner / contract / retirement: Factory 与 Poll 的 owner 边界清晰；旧 Voting.sol 与单租户假设整体退役
- Architecture integrity / higher-level path: 已选工厂路径；未把聚合推给索引层
- Verification scope: 合约层（Hardhat + 属性测试）、索引层（多地址同步 + 一致性）、浏览器层（ui:drill 四种角色）
- Task executability: 每个 Task 给出确切文件、命令与预期输出
- Pressure result: proceed
```

## Execution Readiness View

```text
Execution Readiness View:
- Intent Lock: 用户自建投票 + 对票增删改 + 候选人可增删改；Sepolia 重新部署
- Scope Fence: 不做投票隐私、不做 Gas 代付、不做 Token 门控、不做 The Graph、不做公网托管（spec §11 除第 3 条外全部保留）
- Baseline Lock: 基线 §5.2 五条不变量逐条不得破坏；spec §11 非目标 3 由本计划显式取代并写入规格
- Approved Behavior: 见 Tasks 1-8 的验收
- Owner / Contract Constraints: 后端仍不持私钥（D6）；链上仍是唯一事实源（ADR-0001）
- Compatibility Boundary: 如上一节；旧 ABI 不兼容，不保留兼容层
- Retirement Boundary: 旧 Voting.sol、单租户前端、candidates 表在 Task 6/7 中退役
- Task Batches: 批一 = Task 1-3（合约 + 测试）；批二 = Task 4-6（索引与数据层）；批三 = Task 7-8（前端与验收）
- Test Obligations: 每批结束跑 `pnpm test` + `pnpm typecheck` + `pnpm format:check`；批三另跑 `pnpm ui:drill`（含 `--reject`）
- Review Gates: 批一结束做一次合约边界复核（重入面、押金守恒、权限）；批三结束做一次全链路演练
- Drift / Rewind Rules: 若批二发现多投票语义与"一人一票"冲突，回退到批一并重新评估工厂路径
- Evidence Required Before Completion: 合约测试全绿、属性测试 1000 轮通过、Sepolia 部署记录与源码验证、ui:drill 四种角色全通过、`indexer:check-consistency` 为 consistent
- Advisory Boundary: method-pack execution guidance only; not GateDecision, PolicySnapshot, or completion authority
```

## Plan-Time Complexity Check

```text
Plan-Time Complexity Check:
- Target files: contracts/contracts/Poll.sol（新，约 260 行）、VotingFactory.sol（新，约 120 行）、web/src/lib/data.ts（现约 400 行）、Ballot.tsx（现 586 行）
- Existing size / shape signals: Ballot.tsx 已 586 行、承担列表+状态+写入三条职责；data.ts 承载全部读模型
- Owner fit: Poll 是票数 owner，Factory 是创建 owner，二者不应合并
- Add-in-place risk: 把多投票塞进 Ballot.tsx 会使其超过 900 行且混入路由语义
- Better file boundary: 拆为 PollList / PollCard / CreatePollForm / MyVotes 四个组件 + `poll/[id]/page.tsx` 路由
- Recommendation: split task（Task 7 明确拆组件，不在 Ballot.tsx 上加）
```

---

## Tasks

### Task 1：`Poll.sol` —— 单投票合约（含改投与撤票）

**Files**

- 新建 `contracts/contracts/Poll.sol`
- 新建 `contracts/contracts/Poll.t.sol`
- 删除 `contracts/contracts/Voting.sol`（在本 Task 末尾，测试全绿之后）

**Why**：这是"改投/撤票"的唯一落点。没有它，前端无法提供增删改。

**Change Necessity**：`hasVoted` 是布尔，一次即真；`vote()` 没有反向操作。要支持改投必须把"这个地址当前投给谁"变成**可覆盖的状态**并保持计数守恒。

**Impact / Compatibility**：ABI 全新；旧 ABI 不兼容。

**关键设计（执行者必须照此实现）**

```solidity
// 每人同一时刻至多一张有效票；改投 = 先减旧选项、再加新选项，押金不变
mapping(address => uint256) public votedFor;   // 0 = 未投票
mapping(address => uint256) public stakeOf;
mapping(uint256 => uint256) public voteCount;  // optionId => 票数

function vote(uint256 optionId) external payable;      // 首次投票，要求 !hasVoted
function changeVote(uint256 optionId) external;        // 改投，押金不变，要求 hasVoted
function withdrawVote() external nonReentrant;         // 撤票，退还押金，要求 hasVoted
```

**必须保持的不变量（写成属性测试）**

1. 对任意选项，`voteCount[o] == 索引器按"最后一条 VoteCast/换票事件"聚合出的票数`
2. 任意时刻 `sum(voteCount) == 有效票数 == totalStaked / STAKE`
3. 一个地址最多一票：任何调用序列后 `votedFor[msg.sender] != 0` 蕴含 `stakeOf[msg.sender] == STAKE`
4. 押金守恒：`address(this).balance >= totalStaked`（`refund` 之后仍成立）

**Steps**

1. 由 `Voting.sol` 复制出 `Poll.sol`，改 struct：`Candidate` → `Option { id, labelCID }`（CID 仍走 IPFS，ADR-0004/0021 不变）；新增 `question`、`endsAt`、`creator`。
2. 实现 `vote / changeVote / withdrawVote`，`changeVote` 与 `withdrawVote` 均 `nonReentrant`（`withdrawVote` 有外部调用，是真重入面）。
3. 事件：`VoteCast(voter, optionId, newCount)`、`VoteChanged(voter, fromOptionId, toOptionId)`、`VoteWithdrawn(voter, amount)`。**换票必须发 `VoteChanged` 而不是两条 `VoteCast`**，否则索引层无法用"最后一条"判定，见 Task 5。
4. 把 `Voting.t.sol` 复制为 `Poll.t.sol`，逐个改名为 `Poll` 的语义，并**新增**：改投、撤票、改投到同一选项、撤票后重新投票、他人不能替你撤票。
5. 属性测试：把 `VotingProperties.t.sol` 改造为 40 选民 × 3 选项 × 1000 轮，每轮随机执行 vote/changeVote/withdrawVote，每轮后断言上面 4 条不变量。**负向对照必做**：注入"改投时忘记减掉旧选项"的变异，属性测试必须以票数不守恒失败。

**Verification**

```bash
cd decentralized-voting-dapp
pnpm --filter @voting/contracts test:solidity      # Solidity 测试全绿，含属性测试
pnpm --filter @voting/contracts gas                # 记录 vote/changeVote/withdrawVote 的 gas
```

预期：`test_ChangeVote_*`、`test_WithdrawVote_*`、`test_ThousandRoundRandomSequenceKeepsInvariants` 全通过；变异实验必须在 README/ADR 中记录实测失败信息。

---

### Task 2：`VotingFactory.sol` —— 建投票

**Files**

- 新建 `contracts/contracts/VotingFactory.sol`
- 新建 `contracts/test/factory.ts`

**Change Necessity**：没有工厂，任何人建投票就需要我们代部署（后端持私钥），违反 D6。

**Steps**

1. 用 OZ `Clones` 部署 `Poll` 的最小代理；`Poll` 改造为 `initialize(...)` 模式（构造函数只锁实现合约），并加 `initialized` 守卫防重复初始化（**这是克隆模式的经典漏洞，必须有测试**）。
2. `createPoll(string question, string[] optionCIDs, uint256 endsAt) returns (address poll)`，要求 `optionCIDs.length >= 2`、`endsAt > block.timestamp`。
3. `polls[]` 与 `pollCount`；事件 `PollCreated(address indexed poll, address indexed creator, string question, uint256 endsAt)`。
4. 测试：克隆隔离（两个投票的票数互不影响）、重复 `initialize` 必须 revert、选项数 < 2 必须 revert、`endsAt` 过期必须 revert。

**Verification**

```bash
pnpm --filter @voting/contracts test
```

预期：工厂测试全绿，且"两个投票互不影响"有显式断言。

---

### Task 3：部署脚手架与 Sepolia 重部署

**Files**：`contracts/scripts/{deploy,export-abi,preflight,create-poll}.ts`、`contracts/scripts/seed-sepolia.ts`

**Steps**

1. `deploy.ts` 改为部署 `VotingFactory`，部署记录写入 `deployments/<chainId>.json`，**沿用 ADR-0010 的单一 schema**（新增 `factory` 字段，`voting` 字段退役）。
2. `export-abi.ts` 生成 `factoryAbi` + `pollAbi`（两个 ABI，不是一个）。
3. `create-poll.ts`：用部署者密钥建一个演示投票（3 个选项，CID 取自 `metadata/manifest.json`，复用 `seedableCids()` 的校验）。
4. `preflight.ts` 增加"工厂地址可用"的检查（ADR-0016：检查可用性，不回显值）。
5. 执行 Sepolia 重部署，并 `verify:sepolia` 做源码验证。

**Verification**

```bash
pnpm deploy:sepolia && pnpm verify:sepolia && pnpm export-abi
```

预期：新地址出现在 `deployments/11155111.json`；Etherscan 上源码已验证；`web/src/lib/contracts/deployments.ts` 由 `export-abi` 重新生成。

---

### Task 4：配置与部署注册表

**Files**：`web/src/lib/{config,contracts/deployments,voting}.ts`、`web/.env.example`

**Steps**

1. `ServerConfig.votingAddress` → `factoryAddress`；保留 `VOTING_ADDRESS` 作为**废弃别名**并在 README 注明退役时点（或直接删除，二选一并写进 ADR——**本计划主张直接删除**，因为没有任何外部消费者）。
2. `deployments.ts` 的 `Deployment` 增加 `factory`，`voting` 字段删除。
3. `voting.ts` 的 `resolveChainTarget` 改为返回 `{ chainId, factoryAddress }`。

**Verification**

```bash
pnpm typecheck && pnpm --filter @voting/web test
```

---

### Task 5：索引器支持多地址与换票语义

**Files**：`web/src/lib/indexer/{decode,sync}.ts`、`web/src/lib/db/schema.ts`、`web/src/lib/indexer/plan.ts`

**这是全计划最容易出错的一步，也是"链上是唯一事实源"能否守住的判定点。**

**Steps**

1. schema：新增 `polls(id, creator, question, ends_at, created_block, tx_hash, log_index)`；`options(poll_id, option_id, label_cid, block_number, tx_hash, log_index)`；`votes` 增加 `poll_id`，并把 `UNIQUE` 幂等键保持为 `(tx_hash, log_index)`。
2. **换票语义**：`votes` 表存的是**事件流**（append-only）；"当前票"由视图 `current_votes` 计算——对每个 `(poll_id, voter)` 取"最后一条有效事件"，其中 `VoteWithdrawn` 表示该人当前无票。`candidate_tally` 视图改为基于 `current_votes`。这样"一人一票"是**推导出来的**，不是索引器自己记的账。
3. 多地址同步：`sync.ts` 从"一个地址"改为"Factory + 已发现的 Poll 地址集合"；新 Poll 由 `PollCreated` 事件发现，**必须在同一事务内**把新地址加入下一次 `getLogs` 的目标集合（否则新投票的事件会永久漏掉——这正是 ADR-0021 那一轮"游标越过事件区间"的同类风险）。
4. 单测：`decode.ts` 新增 `PollCreated` / `VoteChanged` / `VoteWithdrawn` 解码用例；`sync.ts` 新增"新投票被同一轮发现并纳入"的用例，与"换票后视图只算最后一票"的用例。

**Verification**

```bash
pnpm --filter @voting/web test
pnpm indexer:migrate && pnpm indexer:drain && pnpm indexer:check-consistency
```

预期：`check-consistency` 输出 `consistent`；多投票下 M-6 一致性检查仍为 0 偏差。

---

### Task 6：数据层与 API

**Files**：`web/src/lib/data.ts`、`web/src/app/api/**`

**Steps**

1. `getTally/getResults` 改为按 `pollId` 维度：`getPolls()`、`getPoll(id)`、`getPollTally(id)`。
2. 新增路由：`GET /api/polls`、`GET /api/polls/[id]`、`GET /api/polls/[id]/results`、`GET /api/polls/[id]/voters/[address]`；旧路由 `/api/candidates`、`/api/results` 退役（删除）。
3. 每个路由的失败文案继续走 `describeFailure`（ADR-0020）；剔除任何回显环境值的路径。
4. 单测：沿用 `data.test.ts` 的假对象模式，新增"索引不可用时回退直读链"在多投票下的用例（ADR-0011 的规则必须仍然成立）。

**Verification**

```bash
pnpm --filter @voting/web test && pnpm typecheck
curl http://127.0.0.1:3100/api/polls
```

---

### Task 7：前端 —— 列表页 / 单投票页 / 我的投票

**Files**：新建 `web/src/components/{PollList,PollCard,CreatePollForm,MyVotes}.tsx`、`web/src/app/poll/[id]/page.tsx`、`web/src/app/my/page.tsx`；改造 `web/src/app/page.tsx`；`Ballot.tsx` / `CandidateCard.tsx` 退役

**Steps**

1. **列表页**：所有投票的卡片（问题、选项数、票数、截止时间、状态）。
2. **建投票表单**：问题 + ≥2 个选项 + 截止时间；CID 生成与上传沿用 `pin:metadata` 的流程（前端只提交 CID，字节由 CLI 固定——**本计划不引入浏览器上传**，那会需要 pinning 凭证进前端，违反 ADR-0016/0020 的凭证纪律）。
3. **单投票页**：投票 / **改投** / **撤票** 三个按钮；可用性判断继续按 ADR-0009 从链上状态推导，理由逐条不同（"你已投给该选项，可改投到其他选项"/"可撤回并取回押金"）。
4. **我的投票页**：列出我发起过与我投过的投票。
5. 所有写入失败文案走 `describeWriteFailure`（ADR-0022）；新增"改投成功""撤票成功"的乐观态与回滚。

**Verification**

```bash
pnpm --filter @voting/web build
TEST_ACCOUNT=0x… pnpm ui:drill          # 只读
TEST_ACCOUNT=0x… pnpm ui:drill --reject # 钱包拒绝
```

---

### Task 8：ui:drill 扩展与全链路验收

**Steps**

1. `ui:drill` 新增四种角色断言：发起者（建投票后列表出现）、投票人（投→改投→撤票，每次回读链上确认计数守恒）、非白名单、错链。
2. **负向对照**：注入"改投时忘了减旧选项"的前端 bug（或在合约上做变异），确认演练会失败——只测成功路径不算证据（沿用 §14 校正 7 的做法）。
3. Sepolia 端到端：建一个新投票 → 投 → 改投 → 撤票 → 退款，全程用真实钱包签名。

**Verification**

```bash
pnpm test && pnpm typecheck && pnpm format:check && pnpm build
pnpm indexer:check-consistency
TEST_ACCOUNT=0x… pnpm ui:drill --reject
```

---

## Risks

| #   | 风险                                                 | 处置                                                             |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| R1  | 克隆合约的 `initialize` 可被重复调用（经典漏洞）     | Task 2 的显式测试；未通过不得进入 Task 3                         |
| R2  | 多地址索引漏事件（新投票的早期事件落在已扫过的区间） | Task 5 第 3 步：同事务纳入目标集合 + 单测                        |
| R3  | "一人一票"从合约状态退化为索引聚合，违反 ADR-0001    | Task 5 第 2 步用视图推导，并把该一致性纳入 M-6 检查              |
| R4  | 换票用两条 `VoteCast` 表达，索引无法判定"最后一票"   | Task 1 第 3 步强制 `VoteChanged` 事件                            |
| R5  | 前端组件膨胀（Ballot.tsx 已 586 行）                 | Task 7 明确拆四个组件，不在原文件上加                            |
| R6  | 旧 Sepolia 地址上的公投数据作废                      | 事前告知；`deployments` 保留历史记录但不提供读写                 |
| R7  | 押金与退款在多投票下的资金守恒                       | Task 1 属性测试第 4 条；`sweepUnclaimed` 语义改为按 Poll 计      |
| R8  | 规格 §11 非目标 3 被违反（"不做多轮次选举"）         | 必须显式修订规格并记 ADR，不得静默违反（BASELINE-GOVERNANCE §3） |

## Retirement

- **旧 `Voting.sol` 与单租户前端整体退役**，不保留兼容层。理由：保留双 ABI 会让 `decode.ts`、`data.ts`、`ui:drill` 全部变成两套分支，而没有任何外部消费者——这正是 `anti-entropy-governance` 要求避免的"compat-only carrier"。
- `candidates` 表由 `options` 取代；Sepolia 索引库清空重建（理由同 ADR-0021：游标已越过新区块区间）。本地库走迁移以保留 200 票演示数据。
- `VOTING_ADDRESS` 环境变量退役（无外部消费者）。
- `Ballot.tsx` / `CandidateCard.tsx` 删除；`ballot-labels.ts` 的读状态函数保留（仍被新组件使用），`syncSummary` 等保留。

## Baseline Sync Signals

- 基线 §5.2 五条不变量**逐条**在本计划中都有对应保护，执行完成需在漂移表登记实测结论。
- 规格 §11 非目标 3 必须被显式取代（写入 §14 新校正 + §3 修正清单）。
- 需新 ADR 至少两条：**ADR-0023**（工厂 + 每投票一合约，替代单租户）、**ADR-0024**（换票/撤票的事件语义与"当前票"由视图推导）。
- 基线 §9「不允许为本地演示在合约中留后门分支」在本计划中**未被触碰**，且不得为演示放宽白名单或押金。

## Execution Route

```text
Execution Route:
- Decision: inline
- Evidence: Task 1-8 共享同一批文件（contracts/contracts/Poll.sol 与 web/src/lib/data.ts 被多任务修改），且合约改动必须先落地才能定索引语义，独立任务之间的边界不足以支撑并行；批一内部严格串行
- Fallback: 若批二中 Task 5 与 Task 6 的文件冲突被证明可隔离，可改为 subagent-driven
- User confirmation required: no
```

## Open Questions（执行前需用户确认，但已给出推荐）

1. **押金是否保留**：保留（D5/ADR-0005 的重入面依赖它，且 `refund` 是唯一的真实外部调用）。若你希望"建投票也要押金"以防垃圾投票，需新增一项，本计划未含。
2. **截止时间是硬性的吗**：本计划按 `endsAt` 硬性截止（到点即不可投），并保留 owner 的 `endPoll` 提前结束。
3. **是否要"任何人可投"选项**：本计划保留白名单作为可选门控（发起者可选择开放投票或白名单投票）——这是 C 模型下最自然的设计，但会额外增加一个 `visibility` 字段；**若你认为不必要，可在 Task 1 前告知，我按"始终白名单"实现**。
