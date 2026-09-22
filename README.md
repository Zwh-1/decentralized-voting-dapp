# 去中心化投票平台 DApp

一个**两层**的多租户链上投票平台：

- **合约层**（`contracts/`）——Hardhat 3 + Solidity 0.8.37 + OpenZeppelin 5.6.1。`VotingFactory` 让**任何人都能创建自己的投票**（EIP-1167 克隆，每份投票一份独立合约）；每份投票自带白名单准入、**可改投可撤票**的一人一票、押金托管与退回、阶段状态机、以及创建者专属的选项增删改（仅在设置阶段）。选项文字信息只存 IPFS，链上只保存 CID。
- **Next.js 层**（`web/`）——同一进程里既有面向浏览器的投票界面（投票列表、创建投票、单投票投票页、我的投票），也有一个**只读事件索引器**：它把工厂与所有投票合约的事件投影到 MySQL，并通过 Route Handler 暴露 REST 接口。页面同时展示链上与索引两侧的票数并**实时比对二者是否一致**。

> 这是一个**教学与作品集项目**，不是生产级投票系统。它的重点不在于"能投票"，而在于把链上状态、链下投影、前端展示之间的**一致性**做成可测量、可证伪的东西。请先读[设计取舍与已知局限](#设计取舍与已知局限)。

![投票界面](docs/screenshots/ballot.png)

> 截图取自**未连接钱包**状态（无头 Chrome 渲染，没有注入钱包扩展）。顶部是链上与索引两侧的实时一致性比对，下面是选项卡片与票数。连接钱包后才会出现投票、改投、撤票、退款与钱包地址这些交互控件——它们全部依赖钱包签名，因此在这个静态截图中必然缺席，而不是坏了。

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
        F["VotingFactory.sol<br/>地址登记簿 · 不持有票数与以太"]
        V["Poll.sol（每投票一份克隆）<br/>白名单 · 一人一票可改投可撤票 · 0.001 ETH 押金"]
        F -- "createPoll()<br/>EIP-1167 clone" --> V
    end

    subgraph ipfs["IPFS"]
        M["选项元数据 JSON"]
    end

    subgraph app["Next.js 层（单个进程，可随时丢弃重建）"]
        direction TB
        I["只读索引器<br/>跟随工厂 + 所有投票<br/>游标 + 确认数 + 重组修复"]
        DB[("MySQL（可选）<br/>UNIQUE(tx_hash, log_index)")]
        API["Route Handlers<br/>只有 GET，只有 SELECT"]
        UI["投票界面<br/>列表 / 创建 / 投票 / 我的投票<br/>wagmi + 双侧比对徽章"]
        I -- "一个事务内<br/>写事件 + 推进游标" --> DB
        DB --> API
        API --> UI
    end

    F -- "PollCreated" --> I
    V -- "VoteCast / VoteChanged / VoteWithdrawn<br/>OptionAdded / PhaseChanged / Refunded" --> I
    F -- "直接读链<br/>有哪些投票" --> UI
    V -- "直接读链<br/>阶段 / 我的投票与押金 / 白名单" --> UI
    UI -- "createPoll() / vote() / changeVote()<br/>withdrawVote() / refund()" --> F
    UI -- "读取 CID" --> M
    V -. "链上只保存 CID" .-> M
```

两层职责：

| 层         | 负责                                                                             | 不负责                                 |
| ---------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| 合约层     | 投票创建与隔离、白名单准入、一人一票（可改投可撤票）、押金托管与退回、阶段状态机 | 选项文字信息（只在链上存 CID）         |
| Next.js 层 | 展示双侧数据与一致性、发起创建/投票/改投/撤票/退款；只读投影链上事件为缓存       | 持有私钥、发起任何写操作、成为真相来源 |

> **为什么是「每投票一份合约」而不是「一张合约里按 `pollId` 分表」**：后者为了回答「这个投票现在几票」，必须在链上额外维护一个增量计数器，而它与 `votedFor` 是两份可能互相矛盾的数据；一旦矛盾，链上便不再具备独立重算票数的能力，「票数等于投票人数」这个恒等式就离开了链——而留下它正是本项目的全部意义。详见 ADR-0023。改投与撤票为什么要发各自的事件、当前票为什么必须由事件流推导，见 ADR-0024。

两条关键设计线：

1. **MySQL 里的一切都能从链上事件重放重建。** 删库不会丢任何信息，这使索引器的正确性可以被独立验证，而不是被信任。
2. **索引是可选依赖。** 索引有**两种**缺失方式，应用对两者的处理相同，因为两种情况下链都是事实源：不设 `DATABASE_URL`（从未配置），以及设了但数据库读不到（索引挂了）。两种情况所有读取都回退为直接读链，`source` 字段说明是哪一侧回答的，`/api/polls/<poll>/results` 会如实报告 `status: "unavailable"`，而不是给一个"没比对过却显示一致"的假结论。挂掉的索引不会被悄悄吞掉：`/api/health` 用 `indexError` 报出原因，`status` 变为 `degraded`。

### 你可以用它做什么

| 能力               | 谁可以     | 约束                                                                                  |
| ------------------ | ---------- | ------------------------------------------------------------------------------------- |
| 创建投票           | **任何人** | 至少 2 个选项，截止时间必须在未来；创建时选择**准入方式**（见下）                     |
| 增 / 改 / 删选项   | 创建者     | **仅设置阶段**；删除后不得少于 2 个选项；有票的选项不可删                             |
| 维护白名单         | 创建者     | 任何阶段都可以；**对"所有人可投"的投票无效**（无副作用，也不报错）                    |
| 开始 / 结束投票    | 创建者     | —                                                                                     |
| 到点后关闭         | **任何人** | 超过 `endsAt` 后任何人都能调用 `closeAfterDeadline()`，投票不会因创建者失联而永远卡住 |
| 投票 / 改投        | 按准入方式 | 需质押 `STAKE`（0.001 ETH）；改投**不额外收费**，且**不检查白名单**                   |
| 撤票               | 同上       | 清空投票并当场退还押金                                                                |
| 取回押金           | 同上       | 投票结束后（含宽限期内）                                                              |
| 清扫无人认领的押金 | 创建者     | **仅在 7 天宽限期之后**                                                               |

#### 准入方式：创建时二选一，之后不可更改

| 方式           | 谁能投票           | 界面显示                                     |
| -------------- | ------------------ | -------------------------------------------- |
| **所有人可投** | 任何连接钱包的地址 | 「准入方式：所有人可投」，**无**「白名单」行 |
| **仅白名单**   | 创建者添加过的地址 | 「白名单：是 / 否」，**无**「准入方式」行    |

**为什么不能事后切换。** 若创建者能在投票进行中翻转这个开关，他就能在看到实时票数后决定「现在只让白名单投票」，把已经不利于他的那批人排除掉；或者反过来，在需要凑人数时才放开门槛。两种情况下，票数都不再是「一个固定规则下的人群的选择」，而是一个可被创建者按结果调节的量。因此 `openToAll` 在 `initialize` 时写死，**没有 setter**，与问题、选项、截止时间同为投票身份的一部分。见 [ADR-0025](docs/aegis/adr/ADR-0025-admission-mode-is-fixed-at-initialize.md)。

**为什么「白名单」行对被准入者也显示。** `canVote` 与 `whitelisted` 是两个不同的事实：在「所有人可投」的投票上，`whitelisted` 对**每个**地址都是 `false`（没有名单这回事），因此若用 `whitelisted` 判断能否投票，会向每个读者谎称「你不在白名单里」。反过来，在被单独批准的场景下，读者需要看到「白名单：是」才能区分「这个投票对所有人开放」与「我被专门加进去了」——后者意味着他的资格是**可以被撤销**的。两个字段都在 `voterState` 中返回，界面按投票类型选择显示哪一个。

**改投为什么不检查白名单。** 合约的 `changeVote` 与 `withdrawVote` 都**没有**准入检查：一个投过票之后被移出白名单的地址，仍然可以改投或撤回自己的票。界面据此只在**未持有票**时才施加准入检查——否则会禁用一笔链上明明会接受的交易。

**改投与撤票为什么是两件不同的事**：`changeVote` 保留押金、只改指向；`withdrawVote` 清空你的投票**并**退还押金。前者是"我改主意了"，后者是"我退出这次投票"。两者发出**不同的事件**（`VoteChanged` / `VoteWithdrawn`），因此索引能判断"这个地址最后一次动作是什么"。见 [ADR-0024](docs/aegis/adr/ADR-0024-a-vote-change-is-its-own-event.md)。

三条关键设计线：

1. **一人一票仍然由链强制，而不是由索引推断。** `Poll.votedFor` 是链上 mapping，改投只是改写同一个槽位。索引的当前票数由事件流**推导**（`current_votes` 视图取每个地址的最后一条事件），而不是自己维护一个计数器——否则就会存在两份可能互相矛盾的真相。见 [ADR-0023](docs/aegis/adr/ADR-0023-one-poll-per-contract-through-a-factory.md)。
2. **每个投票彼此隔离。** 每份投票是独立合约，有自己的票数、押金、白名单与创建者。工厂本身**不持有任何票数，也不持有任何以太**。
3. **前端从不持有私钥。** 创建投票、投票、改投、撤票、退款全部由用户自己的钱包签名；后端只有 GET 与 SELECT。

---

## 实测指标

以下数字全部来自本仓库中可复现的命令，不是估计值。

| 编号 | 指标               | 实测结果                                                                                                                                                                                                                                                                                                                                                                                                                                | 复现命令                                               |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| M-1  | 合约覆盖率         | `Voting.sol` 行 **100.00%**、语句 **100.00%**（覆盖率数字对应改造前的单合约；工厂/`Poll` 的覆盖率见下方说明）                                                                                                                                                                                                                                                                                                                           | `pnpm coverage`                                        |
| M-2  | 越权与非法调用拦截 | 全部路径 revert：非白名单、重复投票、改投到自己已选的选项、未投票却撤票、阶段错误（4 种）、押金金额错误、未知选项、零地址、非创建者改选项、选项少于 2 个、删除仍有票的选项、截止时间不在未来、重复 `initialize`                                                                                                                                                                                                                         | `pnpm test:contracts`                                  |
| M-3  | 重入攻击防护       | 四组对照矩阵全部符合预期（见下）                                                                                                                                                                                                                                                                                                                                                                                                        | `pnpm test:contracts`                                  |
| M-4  | 长序列属性测试     | 40 名选民 × 3 个选项 × **1000 轮**确定性交错 投/改投/撤票，每轮复查 4 条不变式，**0 反例**；并断言四类结果（成功投票、成功改投、成功撤票、被拒绝）各自都真实发生过，且经变异测试证明可失败                                                                                                                                                                                                                                              | `pnpm test:contracts`                                  |
| M-5  | Gas（中位数）      | `vote` **109,256**；`refund` **37,920**；部署 **1,249,757**；运行时代码 5,298 字节（数字对应改造前的单合约，尚未在工厂/`Poll` 上重测）                                                                                                                                                                                                                                                                                                  | `pnpm gas`                                             |
| M-6  | 链上/索引一致性    | **200 / 200 票，0 处偏差**（逐选项比对）；`CONFIRMATIONS=5` 下索引合法落后至 197 票时**仍判定一致**（加回 3 票待确认）；同样的落后叠加删掉 1 行则**判定不一致**并定位到具体选项。现在**逐个投票**检查，任一投票不一致即退出码 1                                                                                                                                                                                                         | `pnpm indexer:check-consistency`                       |
| M-6b | 索引幂等性         | 游标回退到 0 强制重放：事件行**全部命中重复，插入 0 行**，票数不变（未翻倍）                                                                                                                                                                                                                                                                                                                                                            | 见[验证与复现](#验证与复现)                            |
| M-6c | 真实链重组         | `evm_revert` 让链头回退：索引报告 `rewound`、孤立事件行被删、**票数不变**                                                                                                                                                                                                                                                                                                                                                               | `pnpm indexer:reorg-drill`                             |
| M-6d | 真实退款入库       | `0.001 ETH` 全额入库（`amount_wei` 逐位相同、无精度丢失）、**票数不变**、回退后索引撤销退款与阶段行                                                                                                                                                                                                                                                                                                                                     | `pnpm indexer:refund-drill`                            |
| M-6e | 浏览器端写入路径   | 注入钱包后驱动真实 DOM，**按四种投票人状态分派断言**（未白名单 / 已白名单未投票 / 已投票 / 已投票后改投），实测 **18 / 23 / 22 / 23** 项全通过：按钮可用性逐一与链上 `voterState` 相符；**真实投票、真实改投、真实退款都回读链上确认**；改投后**链上 `currentOptionId` 等于所点按钮的 `data-option-id`，且押金未变**；全程无"提交中…"假状态。`--reject` 场景把钱包的拒绝（EIP-1193 `4001`）渲染成一句中文，并**回读链上确认什么都没变** | `pnpm ui:drill [--vote\|--change\|--refund\|--reject]` |
| M-6f | 分块大小无关性     | `CHUNK_BLOCKS` = 1 / 7 / 2000 三种取值完整重建，投影逐位相同                                                                                                                                                                                                                                                                                                                                                                            | 见[分块大小不影响结果](#m-6b-附加分块大小不影响结果)   |
| M-6g | 浏览器端链身份     | `CHAIN_ID=11155111` 且无钱包：`阶段` **投票中**（不再是 `未知`）、`合约地址` 指向**部署配置的工厂**（不再是本地合约）、控制台 **0 条消息**；屏蔽浏览器所用 RPC 后 `阶段` **读取失败**，服务端读到的各行不变                                                                                                                                                                                                                             | 见 [M-6g](#m-6g浏览器读的是部署配置的那条链)           |
| M-6h | 选项元数据         | 三份文档 pin 到公共 IPFS：服务返回的 CID 与本地计算**逐字符相同**，网关回读逐字节一致；真实浏览器三张选项卡片全部 `已解析`，控制台 **0 条消息**                                                                                                                                                                                                                                                                                         | `pnpm pin:metadata` + `pnpm ui:drill`                  |
| M-7  | Next.js 生产构建   | 构建成功，投票列表 / 单投票 / 我的投票 页面与全部动态 Route Handler 均产出                                                                                                                                                                                                                                                                                                                                                              | `pnpm build:web`                                       |
| —    | 测试总数           | **274 个**（合约 41 Solidity + 60 TypeScript，web 173）——**改造后的数字见下方"多租户改造"小节**，此处保留改造前的基线以便对照                                                                                                                                                                                                                                                                                                           | `pnpm test`                                            |

### 多租户改造（校正 26）实测

| 指标                 | 实测结果                                                                                                                                                                                 | 复现命令                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 合约测试             | **157 通过**（94 Solidity + 63 nodejs），0 失败                                                                                                                                          | `pnpm test:contracts`                  |
| 工厂隔离             | 12 条测试：两投票**不共享**票数与押金、各有**各自 admin**、克隆二次初始化被拒、实现合约不被工厂登记                                                                                      | `pnpm test:contracts`                  |
| 准入方式             | 新增 `openToAll` 相关用例：开放投票接受任意地址且 `canVote=true`／`whitelisted=false`；该值仅在 `initialize` 可写、无 setter；白名单投票的行为未被放宽；工厂把该标志透传到投票合约与事件 | `pnpm test:contracts`                  |
| 投/改投/撤票属性测试 | 40 选民 × 3 选项 × **1000 轮**交错，每轮复查 4 条不变式，0 反例；并断言"成功投票/改投/撤票/被拒绝"四类结果**各自都发生过**                                                               | `pnpm test:contracts`                  |
| 负向对照（合约）     | 注释掉 `changeVote` 中旧选项的递减 → 如期失败：`the tally must equal the number of current voters: 9 != 8` 等四类断言                                                                    | 手动变异后 `pnpm test:contracts`       |
| **视图对真实 MySQL** | `current_votes` / `option_tally` 在**真实 MySQL 8** 上 **17/17 通过**；确认行确实落库（`votes` 46 → `current_votes` 28，即视图真的在折叠每人多条事件）                                   | `DATABASE_URL=… pnpm run test:indexer` |
| **负向对照（视图）** | 把 `current_votes` 改成返回**每条**事件（28 → 46 行）→ 同一批测试**失败 9 条**（改投、撤票、排序、聚合全部命中）。证明这批测试真的在读真视图，而不是复述一个同源的 TS 模型               | 手动变异后同上                         |
| web 测试             | **260 通过**，0 失败                                                                                                                                                                     | `pnpm test:indexer`                    |
| 禁用理由（纯函数）   | 36 个用例覆盖六个禁用控件的理由判断，含一个遍历约 **4000 种状态组合**的扫描，断言"控件被禁用时理由永远非空"；并锁定"开放投票不得因 `whitelisted` 为假而拒绝投票人"这一回归               | `pnpm test:indexer`                    |
| Sepolia 部署         | 工厂 `0x95D0D46d1DDc774B27Ee7f00e599Bf34938df2Ed`、实现 `0xDcd4cB2d5fDF6A489Fc1A19B6204Eea030bc17eC`；直读链上确认 `pollCount()=1` 且各字段正确                                          | `pnpm deploy:sepolia`                  |
| Etherscan 源码验证   | **未完成**——不是代码问题：本机 DNS 把 `api.etherscan.io` 解析到 `157.240.1.9` 且 TCP 443 不可达（同一时刻 Sepolia RPC 正常）。换一台网络可用的机器重跑 `pnpm verify:sepolia` 即可补齐    | `pnpm verify:sepolia`                  |

### M-3：四组重入对照矩阵

单个 `nonReentrant` 修饰符无法证明"CEI 本身是否足够"，因为守卫会先于 CEI 生效、把 CEI 的贡献遮住。因此用四个变体各去掉一层，让每层防御都被单独观测：

| 变体               | CEI 检查-生效-交互 | 重入守卫 | 攻击结果                     | 说明了什么                 |
| ------------------ | ------------------ | -------- | ---------------------------- | -------------------------- |
| `VulnerableRefund` | ✗                  | ✗        | **攻击成功**，3 份押金被抽干 | 漏洞真实存在，攻击载荷有效 |
| `CEIOnlyRefund`    | ✓                  | ✗        | 攻击失败                     | **CEI 单独就足以防护**     |
| `GuardOnlyRefund`  | ✗                  | ✓        | 攻击失败                     | 守卫能独立生效             |
| `Poll`（生产）     | ✓                  | ✓        | 攻击失败，账目一致           | 纵深防御，两层都在         |

第一行是负向对照：如果脆弱变体没被攻破，说明攻击脚本根本没生效，后面三行的"防御成功"就没有意义。

### M-4：为什么不是 `invariant` 测试

Hardhat 3.17.0 的不变量运行器**会求值** `invariant_*` 函数，但**不会调用任何目标合约函数**。因此任何依赖 ghost 计数器的不变量都会以零计数通过——"1000 轮 0 反例"会是一份空转的假证据。

判定过程（实测，非推断）：

1. 按官方约定编写 `invariant_*` 并部署独立 handler，显示 `(runs: 1000)` 且全部通过；
2. 注入一个已确认会让 3 个普通测试失败的变异（注释掉 `hasVoted[msg.sender] = true`），不变量**仍然通过** → 说明没有任何一次投票被尝试过；3. 排除"handler 位于 `.t.sol` 中所以不被选为目标"：改用普通源文件，结果不变；
3. 排除 target 选择机制问题：试过 `targetContract(address(handler))`、也试过把驱动函数直接放在测试合约自身（官方示例形态），结果均不变；
4. 写入必假的不变量 `assertEq(1, 2)`，它**失败**了 → 证明运行器确实在求值不变量，问题只在于目标集合为空；
5. 查阅 `@nomicfoundation/edr@0.20.0` 的 `InvariantConfigArgs` 类型，其中**不存在任何 target/contract 字段**，与观测一致。

**处理**：删除那两个文件。一份静默空转的测试比没有测试更危险，因为它会伪装成证据。

**替代方案**：`PollProperties.t.sol` 用 `keccak256(seed, round)` 驱动 **1000 轮**确定性操作（40 名选民 × 3 个选项，完全可复现），**每一轮之后**都断言全部不变量，并额外断言"这 1000 轮确实产生了工作"——即成功投票、成功改投、成功撤票、被拒绝四类结果**各自都发生过**。该方案**同样通过负向对照**：注释掉 `changeVote` 里旧选项的递减后，它以 `the tally must equal the number of current voters: 9 != 8` 等四类错误失败。

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

**选项元数据（链上只有 CID，文档在 IPFS）。** 选项文字不上链，链上存的是它们的 CID；`contracts/metadata/manifest.json` 记录的就是那三个 CID，而它们是 `pnpm pin:metadata` 把文档 pin 到 IPFS 之后**从服务返回的** CID——不是手写的。该脚本需要 pinning 凭证，放在 `contracts/.env`（git-ignored），两种形态任选其一：

```bash
# contracts/.env
PINATA_JWT=eyJ…
# 或
PINATA_API_KEY=…
PINATA_SECRET_KEY=…

pnpm pin:metadata   # 上传 → 核对服务返回的 CID 与本地计算是同一个块 → 网关回读比对 → 写 manifest
```

它**不会**把核对不过的 CID 写进 manifest：服务端改了字节、重新序列化了 JSON、包了一层目录、或用了本仓库没有建模的导入配置，都会在这里失败，而不是变成链上一个谁也取不到的字符串。重复执行是幂等的（已记录且确实可取回的文档不再上传）。CI 不跑这一步，因为它需要网络与凭证。

**浏览器侧的网关**：`NEXT_PUBLIC_IPFS_GATEWAY` 是**最先尝试**的网关（默认列表里的两个在部分网络下完全不可达，实测见 §[6](#6-ipfs-元数据依赖公共网关)）。它是构建期内联的，改了要重新构建；值必须以 `/` 结尾，否则拼出来的是 `…/ipfsbafk…`，每个候选人都 404。

### 4. 跑起来（三个终端）

```bash
# 终端 1：本地链
pnpm --filter @voting/contracts exec hardhat node

# 终端 2：部署工厂 + 创建两个投票（投票 1 播种 200 名选民，投票 2 播种 5 名以示互不干扰）
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
pnpm test                        # 合约 157 + web 260，0 失败
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
pnpm test                 # 合约 157 个 + web 260 个
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

#### 一次比对必须是一个瞬间（ADR-0017）

`divergent` 是这套检查唯一的报警信号（HTTP 500、`check-consistency` 退出码 1）。一个会**误报**的报警器比没有报警器更糟：读者会学会忽略它，而真正的不一致就藏在那次忽略里。

这个误报真实发生过，而且是靠浏览器演练新加的"控制台不得有 error/warning"断言发现的：`--vote` 场景下 `/api/results` 返回 500，`verdict: "divergent"`、`onChainTotal 201 / indexedTotal 200`，而 **`unindexedBlocks: 0`、`pendingVotes: 0`**——检查以为索引已经追上，所以那笔它没看见的票既不在索引里，也没资格被"待补区间"补回来。

三处读取各自独立地把健康的索引指认为故障：

| 读取                       | 为什么会偏                                                | 实测                                                                   |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `head`（`getBlockNumber`） | viem 默认缓存 4000ms，而 `results()` 走 `eth_call` 不缓存 | 同一客户端挖块前后 `406 → 406`（STALE）；`cacheTime: 0` 为 `407 → 408` |
| `indexed` 与 `cursor`      | 两条独立语句，两秒一次的索引循环可在其中间提交            | 49 个非 200 响应，持续约 1.5 秒（缓存期内结论不变）                    |
| 链上票数 与 日志枚举       | 一个读 `latest`、一个枚举到较早高度，同一笔票归属不一致   | 修复前 `checkConsistency` 的顺序即为问题本身                           |

修复后，检查比较的是**一个瞬间**：先取索引的一个快照（`indexed` 与 `cursor` 同一事务，因为 `persistBatch` 本就同事务写入两者），再读链（因此 `head ≥ cursor`），链侧两项钉在同一高度。同一探针下非 200 响应 **49 → 0**。

#### 三种索引状态下的 API 实测

索引的两种缺失方式都会被实际跑过，而不是只写在文档里。下表是逐个端点的实测响应（本地链 406 块、200 票；**端点为多租户改造后的路径**，票数取自那一轮实测）：

| 端点                              | 索引正常                                                                                                              | 索引**挂了**（`DATABASE_URL` 指向死端口）                                                                    | 无索引（未设 `DATABASE_URL`）                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `/api/health`                     | 200，`status: "ok"`，`indexConfigured: true`，`indexerLoopEnabled: true`，`lastIndexedBlock: "406"`，`lagBlocks: "0"` | 200，`status: "degraded"`，**`indexError: "connect ECONNREFUSED …"`**，`chainHead: "406"`，`lagBlocks: null` | 200，`status: "ok"`，`indexConfigured: false`，`indexerLoopEnabled: false`，`indexError: null`，`lagBlocks: null` |
| `/api/polls`                      | 200，`count: 2`，两个投票（200 票与 5 票）                                                                            | 200，**同样返回 2 个投票**——投票列表读的是工厂，与索引无关                                                   | 200，同上                                                                                                         |
| `/api/polls/<poll>`               | 200，`poll` + `tally`（`source: "index"`，67/67/66）                                                                  | 200，`tally.source: "chain"`，票数不变                                                                       | 200，`tally.source: "chain"`，票数不变                                                                            |
| `/api/polls/<poll>/tally`         | 200，`source: "index"`，tally 67/67/66                                                                                | 200，**`source: "chain"`**，tally 67/67/66                                                                   | 200，`source: "chain"`，tally 67/67/66                                                                            |
| `/api/polls/<poll>/results`       | 200，`status: "consistent"`，200/200                                                                                  | 200，**`status: "unavailable"`**，`indexedTotal: null`                                                       | 200，`status: "unavailable"`，`indexedTotal: null`                                                                |
| `/api/polls/<poll>/voters/<addr>` | 200，`source: "index"`，带 `history` 与 `voteTxHash`                                                                  | 200，**`source: "chain"`**，`whitelisted`/`hasVoted`/`votedFor` 仍正确，`history: []`                        | 200，`source: "chain"`，同上                                                                                      |
| `POST /api/index/sync`            | 200，`status: "idle"`                                                                                                 | 503 `sync_failed`（这是**写**索引，没有库就写不了）                                                          | 200，`enabled: false`                                                                                             |

三条要点：

- **`unavailable` 不等于"一致"。** 三种状态下 `discrepancies` 都是 `[]`，但只有索引正常时才给出 `consistent`。没有任何可以比较的东西时，这个接口不会宣称比过了。
- **挂了与没配走同一条路。** 只处理"没配"意味着一次数据库宕机会把链仍能回答的问题变成 503，页面还会告诉读者"服务端无法读取**链上**数据"——而链是好的。挂掉的索引通过 `indexError` 依然可见，所以这不是把故障藏起来。
- **"存在索引"与"索引在自行前进"是两件事**，所以是 `indexConfigured` 与 `indexerLoopEnabled` 两个字段：前者问的是 `DATABASE_URL !== null`，后者问的是**有没有一个循环会去推进它**，因此等于"存在索引 **且** `INDEXER_ENABLED` 不为 `false`"。三个组合都实测过：

  | 情形                    | `indexConfigured` | `indexerLoopEnabled` | 含义                                                                                                                                                                  |
  | ----------------------- | ----------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 默认                    | `true`            | `true`               | 索引存在且自行前进                                                                                                                                                    |
  | `INDEXER_ENABLED=false` | `true`            | `false`              | 索引存在，但只能手动推进；页面写明这一点，`POST /api/index/sync` 照常有效（它把关的是有没有库，不是循环开没开），实测返回 `{"enabled":true,"status":"idle"}` HTTP 200 |
  | 未设 `DATABASE_URL`     | `false`           | `false`              | 没有索引，也就谈不上有循环在推进它                                                                                                                                    |

  最后一行是有意为之：`INDEXER_ENABLED` 默认为真，若直接上报这个原始开关，就会在**没有任何索引可供推进**时报出"循环开着"，等于宣称一个并不存在的索引器。因此该字段上报的是有效状态，而不是那个原始配置项。

- **`lagBlocks` 只在问题成立时给出数字。** "落后多少块"在这几种情形下都不是可以回答的问题，于是上报 `null`，页面显示 `—`：链读不到；**没有索引**（也就没有索引可落后）；**索引存在但游标读不出来**。后两种此前都会报出**同一个数字** —— `safeHead + 1`，也就是"什么都没索引"的答案 —— 于是无索引的部署和数据库宕机的部署各自公布了一个对两者都不成立的滞后量。四种状态都实测过：

  | 情形                                     | `indexConfigured` | `lastIndexedBlock` | `lagBlocks` | 页面 `落后区块`              |
  | ---------------------------------------- | ----------------- | ------------------ | ----------- | ---------------------------- |
  | 索引正常、已同步                         | `true`            | `"406"`            | `"0"`       | `0`                          |
  | 索引已建表但**从未同步**（新部署的起点） | `true`            | `null`             | `"407"`     | `407`（真实数值，保留）      |
  | 未设 `DATABASE_URL`                      | `false`           | `null`             | `null`      | `—`                          |
  | `DATABASE_URL` 指向死端口                | `true`            | `null`             | `null`      | `—`（`indexError` 说明原因） |
  | RPC 不可达                               | `true`            | `"406"`            | `null`      | `—`                          |

  第二行是这个规则里最容易写错的一格：`lastIndexedBlock: null` 在那里是**事实**而不是事实的缺席——区块 0…406 确实一块都没索引——所以数字必须照报。若因为"游标为空"就一律上报 `null`，就会把真实待办量藏起来。`lagBlocks` 不参与 `/api/results` 的一致性判定（那用的是未索引区间的对账结果），所以这一改动不影响任何判定。

#### M-6 的负向对照（这个检查确实会报警）

一个永远只说"一致"的检查器不是证据。因此这里刻意制造了一次分歧：从 `votes` 表删掉**一行**，然后观察两侧是否被发现。

```bash
mysql -u root -p voting -e "DELETE FROM votes ORDER BY id DESC LIMIT 1;"   # 199 行
pnpm indexer:check-consistency
# 退出码 1，且定位到具体投票与具体选项：
#   "status": "divergent", "divergentPolls": 1
#   "polls": [{ "poll": "0x…", "onChainTotal": 200, "indexedTotal": 199,
#               "discrepancies": [{ "optionId": 2, "onChain": 67, "indexed": 66, "pending": 0 }] }]

curl -i http://127.0.0.1:3000/api/polls/<poll>/results   # 期望 HTTP 500 + 同一份差异

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

第二行是关键：故障没有被"还在确认窗口里"这块遮羞布盖过去。差异被定位到具体投票的选项 2，`pending: 1` 说明即使把那 1 票加回来也仍然对不上。

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

### M-6b 附加：分块大小不影响结果

`CHUNK_BLOCKS` 默认为 2000，而播种链只有 406 块——也就是说 `drain.ts` 的分块循环**一直是单轮**，其边界行为只有针对假链的单测。清空投影表后以不同分块大小完整重建，三种取值的结果逐位相同：

| `CHUNK_BLOCKS` | 轮数 | 事件行 | 插入 | 重复 | 投影（polls / options / votes / whitelist / phase / 游标） | tally        |
| -------------- | ---- | ------ | ---- | ---- | ---------------------------------------------------------- | ------------ |
| `1`            | 406  | 404    | 404  | 0    | 3 / 200 / 200 / 1 / 406                                    | 67 / 67 / 66 |
| `7`            | 58   | 404    | 404  | 0    | 同上                                                       | 同上         |
| `2000`（默认） | 1    | 404    | 404  | 0    | 同上                                                       | 同上         |

`CHUNK_BLOCKS=1` 让每个区块各成一个分块，是边界覆盖最强的情形（每个事件的起止都落在分块边缘）。三种取值下 `pnpm indexer:check-consistency` 均为 `consistent`、200/200。CI 的 `indexer-e2e` 作业把 `CHUNK_BLOCKS` 设为 `7`，因此分块边界在每次推送时都被真实穿过，而不是只由单测断言。

```bash
mysql -u root -p voting -e "DELETE FROM votes; DELETE FROM refunds; DELETE FROM whitelist_events;
  DELETE FROM phase_events; DELETE FROM options; DELETE FROM polls; UPDATE sync_cursor SET last_block = 0;"
CHUNK_BLOCKS=1 pnpm indexer:drain   # 完整重建
pnpm indexer:check-consistency      # 必须是 consistent
```

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

> **忘了停应用会怎样**：应用的后台循环每两秒轮询一次，它会在演练自己动手之前把重组修好，演练于是观察不到 `rewound`。这**不是**回退路径坏了，但脚本原先只会报"the indexer never reported a rewind"，把读者引向 `planReorgRewind` 找一个并不存在的 bug。现在脚本会在修复前后各读一次游标，识别出这种情况并直接说明是**另一个索引器**抢先修复、以及该怎么处理（`another indexer already repaired this reorg … Stop it (or set INDEXER_ENABLED=false) and re-run`）。实测：应用运行时连续三次都给出这条诊断，停掉后演练立即恢复 `rewound: true`。

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
TEST_ACCOUNT=0x… pnpm ui:drill:change    # 额外真实改投（**需要一个已经投过票的账户**）
TEST_ACCOUNT=0x… pnpm ui:drill --refund  # 额外真实取回押金（需 phase=Ended，同样建议在快照里跑）
TEST_ACCOUNT=0x… pnpm ui:drill --reject  # 钱包拒绝签名：断言页面说的是中文且链上没变（**不发交易**，可对已部署链跑）
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

### 多租户改造后的重测（四种投票人状态，均在本地区块链 31337 实测）

改造后界面从"一张选票"变成"投票列表 + 单个投票页"，`ui:drill` 也随之按**投票人状态**分派断言。此前它只按"能不能投票"二分，而现在"已投票"是一个**有内容的**状态而非单纯的禁用：账户可以改投、可以撤票，UI 必须区分"我当前投给了这个选项"和"我可以改投到这个选项"。

| 场景                          | 链上 `voterState`                 | 实测断言数 | 关键断言（全部通过）                                                                                                                     |
| ----------------------------- | --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 未白名单（只读）              | `whitelisted=false optionId=0`    | **18**     | 3 个按钮禁用且**各自说明理由**；`白名单` 行 = 否                                                                                         |
| 已白名单、未投票（`--vote`）  | `whitelisted=true optionId=0`     | **23**     | 3 个 `投一票` 全部可点；点击后上链确认，**`data-option-mine="true"` 恰好 1 个**，另两个变为 `改投到这个选项`                             |
| 已投票（只读）                | `whitelisted=true optionId=1`     | **22**     | `myOptions=1` **且与链上 `currentOptionId` 相等**；`改投` 恰好出现在另外 **2** 个选项上，且**不再有** `投一票`                           |
| 已投票（`--change` 真实改投） | `whitelisted=true optionId=1 → 2` | **23**     | 点击后**链上读回 `currentOptionId=2`**（与所点按钮的 `data-option-id` 一致）；**押金未变**（改投是移动而非第二次投票）；页面标记随之移动 |

四种状态全部 exit 0，控制台消息数均为 **0**。

`--change` 是本轮新增的模式，覆盖的正是这次改造**新增的能力**。它刻意**不**断言界面文案，而是断言组件自己的契约（`data-option-action` / `data-option-id` / `data-option-mine`）：

- 旧断言写的是"卡片变为 `你已投给该候选人`"。多租户改造后这句话**在代码里已经不存在**了——于是一条**永远不可能通过**的断言变成了"永远不成立"，它既不会因为界面正确而通过，也不会因为界面坏掉而报警，只是一直静静地失败。这类断言比没有断言更糟：它看起来还在保护什么。
- 同理，"我的状态"面板的结束边界此前写死为 `候选人（`，改造后标题变成 `选项（`。找不到边界时切片会一路延伸到页面末尾，于是 `白名单` 那一行的断言开始在**整页文本**里搜索并继续通过。现在两处都改为读组件的属性/按前缀识别标题，并**额外断言"边界确实被找到了"**，让这类静默失效变成响亮失败。

**顺带修掉的一个真实缺陷**：`changeVote` 在同一笔交易里同时发出 `VoteChanged` 与 `VoteCast`（后者把新的票数再报一次，供只看 tally 的消费者使用）。索引忠实记录了两行，于是一个只点了一次"改投"的地址，历史里会显示"投给选项 2"紧跟在"改投到选项 2"之后——读起来像是投了两次。现在来源交易与 `VoteChanged` 相同的 `VoteCast` 会被合并掉（这正是 ADR-0024 所说的"回声"），而**独立交易里的 `VoteCast`**（撤票后重新投票）仍然保留。两个方向都有测试：`does not list a change twice…` 与它的负向对照 `still lists a standalone cast that happens to follow a change`。

每个场景都断言：**没有任何按钮停留在"提交中…"**，且每个按钮的可用性与链上状态逐一相符——UI 与链不会各说各话。截图见 `docs/screenshots/ui-vote-confirmed.png` 与 `docs/screenshots/ui-refund-confirmed.png`。

**演练还看浏览器的控制台**：`Runtime.exceptionThrown`、`Runtime.consoleAPICalled` 与 `Log.entryAdded`（后者包含浏览器层面的失败请求，前两者看不到）。新增的断言是"页面不得抛出异常、不得记录 error/warning"，information 级别不算失败。这条断言不是形式主义——它加上去的当次运行就失败了，并因此找出了上面那条 `divergent` 误报（见 [M-6 的"一次比对必须是一个瞬间"](#一次比对必须是一个瞬间adr-0017)）。另一个由它发现的小缺陷：应用此前**没有图标**，浏览器每次访问都请求 `/favicon.ico` 并得到 404；现已补上 `web/src/app/icon.svg`。

三种场景在 ADR-0018 那一轮实测过：只读 **15** 项断言、`--vote` **19** 项、`--refund` **19 → 21** 项，退出码均为 0，且三者控制台消息数均为 **0**。

本轮之后，**只读场景**在 Chain 11155111 上重新实测为 **17** 项（`pnpm ui:drill`，真实 Chrome 驱动真实页面）：新增两条双向断言——"被称为格式无效 ⟺ 不是可解析形状"（它读每张卡片的 `元数据 CID`，因此能抓住"合法的 CID 被报成格式无效"与"伪造的 CID 被放过"两个方向）与"显示文档姓名 ⟺ 已解析"（`已解析` 只证明文档到了，不证明它被渲染；卡片在非 `ok` 时回退成 `候选人 #N`，只有标题能区分这两件事）。同时把"连上钱包立刻读一次页面"改为"等到**整页**不再有 `读取中…`"：此前它读得太早，三张卡片都还是 `读取中…`，于是所有关于元数据的断言**全部通过却什么也没证明**；只等元数据时，`白名单` 与 `押金` 两行又仍在读取中，两条既有断言当场失败——等一行等于等错了对象（见 [ADR-0021](docs/aegis/adr/ADR-0021-a-cid-is-computed-from-the-document-it-names.md)）。`--vote` / `--refund` 本轮**未重跑**（需要一个本地节点与第二套索引），它们是同一块断言，推算为 21/23，**未经实测**。

> **上句已被本轮取代**：多租户改造后，四种投票人状态都在本地区块链 31337 上**重新实测**（见上一节的表：18 / 23 / 22 / 23 项断言，全部 exit 0）。`--vote` 与 `--refund` 不再是"推算"，`--change` 是新增的第三块写入路径。改造前的 15/19/21 是单合约选票的数字，保留在此仅供对照。
>
> **准入方式改造后的追加实测**：`ui-drill` 新增两条关于"我的状态"面板的断言，并按投票类型与账户状态**分别验证**——
>
> | 场景                         | 「准入方式」行 | 「白名单」行 | 结果     |
> | ---------------------------- | -------------- | ------------ | -------- |
> | 开放投票（`openToAll=true`） | `所有人可投`   | **不存在**   | 全部通过 |
> | 白名单投票 + 已准入账户      | **不存在**     | `是`         | 全部通过 |
> | 白名单投票 + 未准入账户      | **不存在**     | `否`         | 全部通过 |
>
> 这三条都不是"顺手加的检查"，而是**由 drill 当场发现的真实缺陷**驱动的：改造后开放投票一度向**每个**读者显示"你不在白名单里"（界面误用 `whitelisted` 而非 `canVote`），而已准入的白名单读者则**看不到**「白名单」行、因而无法区分"对所有人开放"与"我被单独批准"。`--vote` / `--change` / `--reject` 三条写入路径也已在准入方式改造后重新实测通过。

演练跑在一次快照里，结束时回退；实测链头与索引都会自动回到基线（票 200、白名单 200、退款 0、阶段事件 1、游标 406、tally 67/67/66）。回退也**真实地触发了索引器的重组自愈**，且退款那次一次性撤销了**三类**投影行——实测 `votes 201→200`、`whitelist 201→200`、`refunds 1→0`、`phases 2→1`、`cursor 410→406`、`tally 68/67/66 → 67/67/66`。

已知边界：注入的是**模拟 provider**，它与真实钱包在账户切换、链切换等交互上存在差异，这些路径未覆盖。`--change` 之外的两个合约写入路径（`endPoll()` / `closeAfterDeadline()` 与 `setWhitelist()`）仍只有合约测试覆盖，没有浏览器端演练；`--change` 需要一个已有投票的账户，`--vote` 需要一个未投票的账户，脚本在前提不满足时会**明确失败并说明原因**，而不是静默跳过。

**`--reject`：钱包拒绝这笔交易。** 读者在真实钱包里点了「拒绝」之后，页面原本渲染的是 viem 透传的英文原文 `User rejected the request.`——既没说清是谁拒绝的，也没说链上有没有变化（实测此刻 `isWhitelisted=true`、`hasVoted=false`、`stakeOf=0`，合约、白名单、阶段、金额**全都是对的**，只有签名被拒了）。现在这一行是一句中文陈述句，并且**这句话本身被断言过**：

```bash
TEST_ACCOUNT=0x… pnpm --filter @voting/web ui-drill --reject
```

注入的 provider 在 `eth_sendTransaction` 上抛 EIP-1193 `4001`，与真实钱包拒绝同一形状。**它不广播任何交易**，所以与 `--vote` / `--refund` 不同，可以对着已部署的链跑——本轮就是对着 Sepolia 11155111 跑的。8 条断言（只读 17 条之外）实测全通过、退出码 0、浏览器控制台 **0 条消息**：

| 断言                   | 实测                                                       |
| ---------------------- | ---------------------------------------------------------- |
| 可点的投票按钮被点击   | `clicked`                                                  |
| 错误行存在             | `你在钱包里拒绝了这笔交易，链上没有任何变化。`             |
| 成因被识别             | `data-write-error="classified"`                            |
| 正文无英文             | 该句零 ASCII 字母                                          |
| 拒绝来自钱包           | `walletMethods = eth_chainId, eth_sendTransaction:refused` |
| 不是"提交中…"          | 通过                                                       |
| **"链上没有变化"为真** | 点击前后 `hasVoted=false` / `stakeOf=0 wei` **逐位相同**   |
| 控制台                 | 0 条（被识别的成因不打印，只有**未识别**的才打印原文）     |

截图：`docs/screenshots/ui-write-error-rejected.png`。仍未覆盖的是"在真实 MetaMask 里点拒绝"的完整链路（真实钱包在拒绝前还会自己做一次估算与 UI 确认），以及其余五类成因（`-32002`、链不匹配、余额不足、`already known`、合约回滚）——它们目前**只有单测覆盖**。见 [ADR-0022](docs/aegis/adr/ADR-0022-a-wallet-refusal-is-a-sentence-not-a-stack-trace.md)。

### M-6g：浏览器读的是部署配置的那条链

`ui:drill` 的**只读**运行现在可以指向任何链（只有 `--vote` / `--refund` 仍限定本地，因为它们会发真实交易），本轮就用它在 Chain 11155111 上完成了浏览器侧的元数据验证。但"页面认错链"这个面仍然要靠下文的一次性探针：探针读的是 `合约地址` 一行，而演练的断言里没有这一行。

```bash
pnpm --filter @voting/web build && pnpm --filter @voting/web start -p 3100
# 另开一个终端，用 CDP 打开页面并读回面板文本与控制台消息（见下）
```

修复前后（`web/.env` 指向 Sepolia，无钱包连接）：

| 行         | 修复前                            | 修复后                         |
| ---------- | --------------------------------- | ------------------------------ |
| 阶段       | `未知`（读数发往没人监听的 8545） | `投票中`（Sepolia 上真实阶段） |
| 合约地址   | `0x5fbdb2…`（本地 Hardhat）       | `0x4bb0fd…`（Sepolia 部署）    |
| 索引高度   | `11748968 / 链头 11748973`        | `11749047 / 安全头 11749047`   |
| 链头       | 与上一行重复                      | `11749052（最近 5 块待确认）`  |
| 落后区块   | `0`（与上面两行看似矛盾）         | `0`（与安全头口径一致）        |
| 已投票     | `否`（读取失败时也这么写）        | `未连接`                       |
| 押金       | `0 ETH`（读取失败时也这么写）     | `—`                            |
| 白名单     | `读取中…`（失败后永久停在此）     | `—`                            |
| 控制台消息 | 0 条                              | 0 条（无水合不一致）           |

随后用 CDP 的 `Network.setBlockedURLs` 屏蔽浏览器实际使用的 RPC 端点再加载一次：`阶段` 变为 **`读取失败`**，而服务端读到的那几行（`数据来源 / 票数合计 / 索引高度 / 链头`）原样保留——失败被归因到产生它的那次读取，而不是摊到整页。这条负向对照是必要的：只测成功路径无法区分"修好了"与"把错误藏起来了"。

> 上表里的 `0x4bb0fd…` 是那一轮的部署地址。该合约已在本轮被 `0x564a8c64a3f5a05c5a93a9050192cf293b1ea0b6` 取代（[ADR-0021](docs/aegis/adr/ADR-0021-a-cid-is-computed-from-the-document-it-names.md)）：它上面那三个候选人 CID 从来不是 CID，而 `addCandidate` 只在 Setup 阶段可调用，因此换掉它们只能靠重新部署。

同一探针还测出浏览器侧的 RPC 需要可配置：viem 为 Sepolia 内置的 `11155111.rpc.thirdweb.com` 一次加载出现 **8~12 条 `ERR_CONNECTION_CLOSED`**，`阶段` 有时停在 `读取中…`。因此新增 `NEXT_PUBLIC_SEPOLIA_RPC_URL`（与既有的 `NEXT_PUBLIC_LOCAL_RPC_URL` 对称），设成服务端同一个主机（不带 apiKey——这个值会随客户端包发出去）后控制台回到 0 条。

**已知边界（诚实说明）**：`钱包连在错链上` 这条分支（红色告警横幅 + "切到 <配置链>"按钮）**没有用真实钱包验证过**，只有单测覆盖；探针不注入 provider，因此覆盖不到它。

### 失败文案里有什么，以及没有什么

修好"同步按钮不再沉默"之后，它报出的第一句话就是一个真实的上游故障——而那句话里带着**服务端 RPC 端点与它的 apiKey**：

```
同步失败：The request took too long to respond. URL: https://ethereum-sepolia-rpc.publicnode.com/?apiKey=WP46… Request body: {"method":"eth_blockNumber"} Details: The request timed out. Version: viem@2.56.8
```

任何能打开页面的人点一下这个按钮就能读到它；同一串文本也出现在五条 `/api/*` 的 `message`、`/api/health` 的 `indexError` 与服务端渲染的失败横幅里（全部未认证），而它**本来**就写在服务端日志里。现在这几处共用 `web/src/lib/failure.ts` 的 `describeFailure()`：给出一句分类过的中文，指名失败的依赖、配置它的变量与失败的调用名，**不含端点、apiKey、请求体与库版本**；原始错误完整写入服务端日志。

| 出口                       | 现在返回的 `message`                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/index/sync`     | `RPC 端点无响应（eth_blockNumber 调用）：请求超时或连接失败。请检查 web/.env 里的 RPC_URL 是否可达，或换一个端点；完整错误见服务端日志。` |
| `/api/candidates` 等读接口 | `RPC 端点无响应（eth_call 调用）：…`                                                                                                      |
| `/api/health` 的数据库故障 | `索引数据库（MySQL）不可读或不可写。请检查 web/.env 里的 DATABASE_URL，以及数据库是否在运行；完整错误见服务端日志。`                      |

实测（一次性实例，`RPC_URL` 与 `DATABASE_URL` 都指向死端口）：三个出口如上；页面 HTML 中 `apiKey`、`WP46…`、`viem@` 均不存在；完整错误（含 URL、请求体与堆栈）全部落在服务端日志里。分类**不按错误文本**判定依赖——数据库与 RPC 的连接拒绝写法完全相同，只按 `ECONNREFUSED` 分类会把 MySQL 的故障指向 `RPC_URL`；见规格校正 23 与 ADR-0020。

写入路径（投票/取款）的失败文案走的是另一条路：钱包错误只出现在 DOM 里，由 `ballot-labels.ts` 的 `describeWriteFailure()` 分类，见上文 [M-6e 的 `--reject`](#m-6e浏览器端钱包交互演练) 与 [ADR-0022](docs/aegis/adr/ADR-0022-a-wallet-refusal-is-a-sentence-not-a-stack-trace.md)。两者共用同一条纪律（指名失败方、不给读者看原文），但不共用代码：一个的出口是 `/api/*` 的 JSON，证据是驱动的 `walk()`/`errno`；另一个的出口是页面，证据是 EIP-1193 的码。

### 其他接口

```bash
curl http://127.0.0.1:3000/api/health                          # 索引高度、链头、落后区块数、投票数
curl http://127.0.0.1:3000/api/polls                           # 所有投票（读工厂，与索引无关）
curl http://127.0.0.1:3000/api/polls/0x…                       # 单个投票：事实 + 票数
curl http://127.0.0.1:3000/api/polls/0x…/results               # 该投票的链/索引双侧比对
curl http://127.0.0.1:3000/api/polls/0x…/voters/0x…            # 某地址在该投票的白名单/当前票/押金/历史
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

> **如果 `verify:sepolia` 报连接超时。** 这可能是网络问题，而不是配置问题：本机（中国电信线路）实测 `api.etherscan.io` 的 DNS 能解析、TCP 连接却超时（HTTP 000），同一时刻 Sepolia 的 RPC 端点返回 302/200。区分方法：`curl -sS -o NUL -w '%{http_code}' https://api.etherscan.io/`，超时即为此症。此时需要一个能到达 Etherscan 的通路（本地代理），并注意 **Node 默认不读 `HTTPS_PROXY`**——实测：只设 `HTTPS_PROXY` 时 Node 直连成功，加上 `NODE_USE_ENV_PROXY=1` 才会走代理并如预期失败。因此：
>
> ```bash
> NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
>   pnpm --filter @voting/contracts verify:sepolia
> ```
>
> 部署本身不需要 Etherscan，只需 `SEPOLIA_RPC_URL` 与 `SEPOLIA_PRIVATE_KEY`。

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

本机现在**有** Sepolia 部署账户与 Etherscan API key（都在 `contracts/.env`，git-ignored，从不入库），因此逐项说明已实测与未实测的边界。除源码验证那一行外，下表每一行都可以用公共、无需密钥的 Sepolia RPC 自行复现：

| 项                                                                                                                               | 状态                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺凭证时的报错（一次列出缺哪个变量与补救命令）                                                                                   | **已实测**                                                                                                                                                                                                                                                       |
| 只设置部分凭证时只报告缺的那一个                                                                                                 | **已实测**                                                                                                                                                                                                                                                       |
| `deploy:local` 全流程，含覆盖既有记录时的告警                                                                                    | **已实测**                                                                                                                                                                                                                                                       |
| `deploy:sepolia` 指向**真实** Sepolia（实测时区块 11,742,273）：解析网络、由私钥推导部署账户、owner 默认取部署者、构造并广播交易 | **已实测**——最终失败于 `gas required exceeds allowance (0)`，即唯一缺口是测试 ETH                                                                                                                                                                                |
| `verify:sepolia` **在完全没有 `SEPOLIA_PRIVATE_KEY` 的情况下**连上 Sepolia 并走到"该链无部署记录"守卫                            | **已实测**——源码验证不再需要部署者私钥（见下）                                                                                                                                                                                                                   |
| 验证脚本缺 `ETHERSCAN_API_KEY`、或缺部署记录时按预期失败                                                                         | **已实测**                                                                                                                                                                                                                                                       |
| 失败的部署不污染本地记录（`deployments/` 事后仍只有 `31337.json`）                                                               | **已实测**                                                                                                                                                                                                                                                       |
| 真实的 Sepolia 部署交易                                                                                                          | **已实测**——`0x564a8c64a3f5a05c5a93a9050192cf293b1ea0b6`（区块 11,749,344；此前一次为 `0x4bb0fd8c…503e`）。随后 `addCandidate` ×3 与 `startVoting` 在区块 11,749,345–11,749,348 成功，`/api/health` 为 `status=ok`/`lagBlocks=0`，`/api/results` 为 `consistent` |
| 真实的 Etherscan 源码验证                                                                                                        | **已实测失败，且原因不是凭证**——`verify:sepolia` 对 Etherscan 与 Blockscout 都返回 `HHE80001`（消息为空）；单独探测 `api.etherscan.io` 与 `eth-sepolia.blockscout.com` 均**连接超时**（约 20 s）。脚本走到了"提交"那一步，缺的是这台机器到验证后端的路由         |

上表最后两行曾是 D3 交付边界的唯一缺口。**部署那一行本轮关闭了**：真实的交易已在 Sepolia 上确认（并因此发现链上那三个 CID 从来不是 CID，见 [ADR-0021](docs/aegis/adr/ADR-0021-a-cid-is-computed-from-the-document-it-names.md)）。**源码验证那一行仍然关不上**，但缺口从"没有凭证"变成了"这台机器到两个验证后端都没有路由"——这是环境事实而非脚本缺陷，换一台能访问 Etherscan 的机器即可复现。

> **验证为什么不需要私钥。** `verify:sepolia` 走的是单独的 `sepoliaReadOnly` 网络条目，它刻意不声明 `accounts`。这不是洁癖：Hardhat 会在脚本自身的守卫运行**之前**解析传入的网络，所以最初指向 `sepolia` 时，验证一个已经部署的公开合约竟然也强制要求部署者私钥——把密钥无谓地拖进 CI 和每一台做验证的机器。

---

## 设计取舍与已知局限

这一节是刻意保留的。一个 demo 如果隐藏自己的信任模型，比没有信任模型更糟。

### 0. 任何人都能创建投票，因此"投票"本身不可信

这是多租户平台**固有**的性质，不是缺陷：`VotingFactory.createPoll` 是**无权限**的，任何人都能创建任意数量的投票，题目任填、选项任填、白名单由创建者自定。

因此本项目**不能**用来证明"某次投票是权威的"。它能证明的是：**一旦某次投票存在，它的计票过程是可独立验证的**——票数由合约的 `results()` 给出，索引只是投影，两侧不一致会被测出来。谁有资格发起投票是一个**组织问题**，链不做判断。

若要限制创建权，正解是给工厂加一层准入（例如仅白名单地址可 `createPoll`）。当前刻意不加：用户的要求是"任何人都能新增自己的投票"。

### 0b. 旧合约的选票数据在新前端中不可读

旧的单租户合约 `0x564a8c64a3f5a05c5a93a9050192cf293b1ea0b6` 已被工厂 `0x95D0D46d1DDc774B27Ee7f00e599Bf34938df2Ed` 取代。旧合约上的选票**不会**出现在新界面上，因为它的 ABI 与事件与新的 `Poll` 不同。

这是有意接受的代价：该合约是单人租户、没有外部消费者，为它保留兼容层会让 `decode.ts`、`data.ts`、`ui:drill` 长期分叉。参见 [ADR-0023](docs/aegis/adr/ADR-0023-one-poll-per-contract-through-a-factory.md)。

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
- 它**可能落后**：默认保留 5 个确认区块（本地开发设为 0），因此最近几秒的投票可能尚未出现在索引结果里。前端不会把这报成故障——`/api/polls/<poll>/results` 会把那段未索引区块里的事件解码出来加到索引一侧再比较，两侧对得上就仍显示"一致"，并注明`（已计入 N 票待确认）`；只有加回之后**仍然**对不上才报`不一致`。见 [M-6](#m-6链上索引一致性端到端)。
- 前端读**两侧**并说明来源：票数与选项列表来自索引器（`source: "index"`，`合约状态` 面板的 `数据来源` 一行写明），"我是否已投票/我投给了谁/我的押金/我是否在白名单"以及阶段一律直接读链，索引落后多少由 `索引高度 / 落后区块` 两行与一致性徽章上的`（已计入 N 票待确认）`共同说明。`/api/polls/<poll>/tally` 在**索引不可用**时才直读链上并把 `source` 改成 `"chain"`——两种情况页面都标注了来源，不存在"没标注的口径"。

### 6. IPFS 元数据依赖公共网关

公共网关不可靠：开发期间 `ipfs.io` 与 `dweb.link` 均返回过 HTTP 429。因此前端实现了**多网关轮询 + 单请求超时 + CID 格式本地校验**，并把"元数据不可用"作为一种正常状态渲染，降级显示候选人编号。

这个回退不是纸面设计，对着真实网关实测过（本机，2026-09-20）：

| 网关                   | 结果                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `dweb.link`            | **HTTP 000**（不可达）                                                                   |
| `ipfs.io`              | **HTTP 000**（不可达）                                                                   |
| `gateway.pinata.cloud` | **HTTP 200**，往返 **3.6–7.2 s**（同一份 180 字节文档重复四次：7.2 / 3.7 / 7.0 / 3.7 s） |
| `dweb.link`            | **不可达**（网络层失败，约 11 s 后放弃）                                                 |
| `ipfs.io`              | **不可达**（同上）                                                                       |
| `w3s.link`             | **不可达**（同上）                                                                       |
| `4everland.io`         | **不可达**（同上）                                                                       |

也就是说默认顺序里的前两个在本机根本连不上，只有元数据实际 pin 到的那个才作答。**单请求超时因此是 15 s，不是 6 s**：一个比最慢真实应答更短的超时不是安全阈值，而是一台误报机器——用 6 s 的预算取那三条真实 CID 时，三张卡片里有**两张**得到"3 个网关均不可达"，而那个网关当时正在正常作答。代价写在明处：三个网关全无应答时要 45 s（3 × 15 s）才说出这句话，期间只显示 `读取中…`。失败状态因此按"失败的是谁"分开，不合并成一个计数：

- `invalid-cid`——本地就判为不可能解析，**一个请求都不发**（实测 0 ms）；
- `unreachable`——一个网关都没联系上（网络问题）；
- `no-metadata`——联系上了，但没有任何一个给出可用的元数据（内容问题）。

把后两者合并曾导致一个可达的网关被报成"不可达"。CID 校验接受 CIDv0（`Qm…`，46 字符）与任意 codec 的 CIDv1 base32 形式（`b` + 58 字符，共 59），包括 raw codec 的 `bafk…`；把"合法但少见"的 CID 报成"格式无效"，等于告诉用户数据坏了，而实际是校验太窄。

**CID 从哪来。** 链上只存 CID，"这个字符串指向内容"因此必须由工具证明，而不是由人保证——手写的 CID 与算出来的 CID 在类型上是同一个 `string`，类型检查、构建、单测、SSR 都对它无话可说（这正是 `bafyseededcandidate0` 能一路活到链上的原因）。`pnpm pin:metadata` 上传 `contracts/metadata/` 里的原始字节，要求服务返回的 CID 与本地计算属于**同一个块**，再从公共网关回读并逐字节比对，通过之后才写 `metadata/manifest.json`；播种脚本消费 manifest 前会重新算一遍。实测三条文档的返回值与本地计算逐字符相同：

| 文档             | 服务返回 = 本地计算                                           |
| ---------------- | ------------------------------------------------------------- |
| candidate-1.json | `bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a` |
| candidate-2.json | `bafkreiezmqiiomytpzj5bhprhqepa5ijenxdwtapomhubszecnc2jlx57y` |
| candidate-3.json | `bafkreicnafrpxomcyqhmba7n22yd662kik5bon4nldeusvep72i2luomnu` |

> 文件名仍是 `candidate-*.json`，而这个项目现在说的是"选项"。**故意不改名**：这些文件的 CID 取自**内容**，改名会让 `manifest.json` 里那三个已经上链的 CID 与实际文档对不上——除非重新 pin 并重新部署合约。为一个词的一致性付这个代价不值得，因此这里保留旧文件名并说明原因，而不是留下一个看起来像笔误的名字。

同一份字节的另一种编码（dag-pb CIDv1）是**合法但没人 pin 过**的块，实测取回 `{"status":"unreachable","attempts":3}`（36.2 s 内三个网关都没作答）——所以链上写哪个编码不是风格问题，写错就是谁也取不到。同一轮实测还发现 Pinata 的 `cidVersion: 1` 返回的是 **raw leaves**（`bafk…`）而不是 dag-pb，这也正是当初把 `isPlausibleCid` 放宽到不限 codec 的价值所在。见 [ADR-0021](docs/aegis/adr/ADR-0021-a-cid-is-computed-from-the-document-it-names.md)。

**成功路径已实测**（此前登记为未验证边界，现已关闭）：`pnpm ui:drill` 在 Chain 11155111 上用真实 Chrome 驱动真实页面，三张卡片全部 `已解析`，标题是文档里的 `林澈 / 周予安 / 苏芷宁`，浏览器控制台 **0 条消息**；Node 侧直连同一网关的三次取回为 4140 / 5889 / 6756 ms。

**失败不会被永久缓存**：`ok` 与 `invalid-cid` 永久缓存（前者的内容由 CID 唯一确定，后者由 `isPlausibleCid` 在发请求前本地判定），而 `unreachable` 与 `no-metadata` 在 30 秒后过期，并且卡片上会给出"重试"按钮——因为公共网关的限流是这类失败的常态，而一次限流不该变成关于候选人数据的永久结论（ADR-0018）。

**pinning 本身也会过期，而没有任何测试能发现。** manifest 里的"确实已 pin"只在执行 `pnpm pin:metadata` 的那一次被证明，而 CI 不会 pin（它需要网络与凭证）。一个后来消失的 pin——服务端回收、配额用尽、账号变动——不会被任何测试发现，只会在读者那里表现为"网关可访问（1/3 个已作答），但没有返回可用的候选人元数据"。这条边界留在明处，而不是靠"我们 pin 过"这句话遮住。

**仍然未验证的边界（诚实说明）**：瞬态失败分支的"重试"按钮**仍未在浏览器中渲染过**——链上现在全是真实可解析的 CID，没有卡片进入失败分支；上一轮试过用 CDP 把文档里的占位 CID 换成合规形状的 CID，**未能改变客户端实际使用的 CID**（标签仍是 `CID 格式无效，无法解析`），所以那条模拟路径不成立。要关闭它，需要一次**真实**的失败，例如一个把网关全部屏蔽掉的演练场景。

### 7. 后台索引循环依赖长驻进程

`web/src/instrumentation.ts` 会在服务启动时拉起一个轮询循环。这在 `next dev` / `next start` 下有效，但在无服务器（serverless）部署中不会持续运行。因此索引的**可靠**入口是 `POST /api/index/sync` 和 `pnpm indexer:drain`——后台循环只是便利，不是设计所依赖的机制。

### 8. 已知的可改进点

- Hardhat 3 的不变量测试当前不可用（见 M-4）。若未来版本修复目标调用，应当用真正的 `invariant_*` 测试替换 1000 轮序列，并保留后者作为确定性回归。
- 浏览器端交互现在有自动化覆盖（`pnpm ui:drill`，见下节），但它**需要本机 Chrome**，带 `--vote` / `--change` / `--reject` 时还需要一个运行中的 `hardhat node`（只读运行与 `--reject` 可以指向任何链，本轮就是用它验的 Sepolia），因此不在 CI 里跑，属手动演练——和 `reorg-drill` / `refund-drill` 同一类。
- 覆盖的是**投票**、**改投**、**取回押金**、**钱包拒绝**与**到点关闭**四条写入路径（`--reject` 不广播交易）。`结束投票`、`白名单管理`、`清扫押金` 仍只有合约测试覆盖，没有浏览器端演练；且演练用的是模拟 provider，账户切换/链切换等真实钱包交互未被覆盖。
- ~~`sweepUnclaimed()` 断言 `totalStaked == 0` 后转出全部余额（见 §3）。该不变量在正常路径下成立，但任何绕过 `totalStaked` 的资金流入（例如 `selfdestruct` 强制转入）都会让"转出全额"变成隐患。本轮未收紧实现，仅在代码中标注了这一依赖。~~ **已收紧（2026-09-22）**：改为只转出 `totalStaked` 记账金额，而不是 `address(this).balance`。强制转入的 ether 现在会被**滞留**在合约里，而不会被当成无人认领的押金付给创建者。见 §3 与 `test_SweepUnclaimed_IgnoresForcedEther`。
- `Poll.Option.labelCID` 字段名有误（它是内容标识符，不是标签）。改名会波及 ABI 与索引表，价值低于代价，故保留。
- `/api/health` 提供了 `lagBlocks` 与 `indexError` 等完整诊断字段，但界面上没有展示入口。
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
│   │   ├── VotingFactory.sol      # 生产合约：克隆工厂，本身不持有票数与以太
│   │   ├── Poll.sol               # 生产合约：一份投票一份克隆（投票/改投/撤票 + 选项增删改）
│   │   ├── VotingFactory.t.sol    # 12 个：创建、隔离、各自 admin、二次初始化被拒
│   │   ├── Poll.t.sol             # Solidity 测试（含四组重入矩阵）
│   │   ├── PollProperties.t.sol   # 2 个：1000 轮属性测试与 fuzz（M-4）
│   │   └── test/                  # 仅测试用夹具，绝不部署
│   ├── metadata/                  # 选项文档 + manifest.json（记录 pin 之后服务返回的 CID）
│   ├── test/Voting.ts             # 15 个 viem + node:test 消费方测试
│   ├── test/cid.ts                # 19 个：CID 计算与解析（含公开已知向量）
│   ├── test/metadata.ts           # 13 个：文档 ↔ manifest ↔ CID 自检
│   ├── test/preflight.ts          # 部署前配置校验（含“不得回显值”）
│   ├── scripts/                   # deploy / create-poll / seed-local / pin-metadata /
│   │                              #   cid / metadata / export-abi / verify / preflight
│   └── hardhat.config.ts
├── web/                           # Next.js 层：界面 + 只读索引器 + REST API
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx           # 投票列表（服务端预取，首屏即有真实数据）
│   │   │   ├── poll/[address]/    # 单个投票：选项、改投、撤票、取回押金
│   │   │   ├── my/                # 我的投票：我创建的 + 我投过的
│   │   │   └── api/               # Route Handler（polls/* 与 health/sync）
│   │   ├── components/            # PollList / PollCard / CreatePollForm / PollBallot /
│   │   │                          #   PollAdmin / OptionRow / MyVotes / ConsistencyBadge /
│   │   │                          #   WalletBar / Providers
│   │   ├── lib/
│   │   │   ├── indexer/plan.ts    # 纯函数：分块与重组判定（可单测，无 IO）
│   │   │   ├── indexer/decode.ts  # 事件解码（工厂 + 所有投票）
│   │   │   ├── indexer/sync.ts    # 事务、游标、幂等、多地址与同轮发现新投票
│   │   │   ├── ballot-reasons.ts  # 纯函数：六个禁用控件的理由（ADR-0027）
│   │   │   ├── admin-labels.ts    # 纯函数：批量地址解析（ADR-0026）
│   │   │   ├── report.ts         # 链/索引比对与判定（同一瞬间，ADR-0017）
│   │   │   ├── db/schema.ts       # 投影表结构 + current_votes / option_tally 视图
│   │   │   ├── data.ts            # 链上/索引两侧的统一读取入口
│   │   │   └── contracts/         # ABI 与部署地址（由 export-abi 生成）
│   │   └── instrumentation.ts     # 启动后台索引循环
│   ├── scripts/
│   │   ├── lib/cdp.ts             # 从 ui-drill 抽出的 CDP 传输层
│   │   └── …                      # migrate / drain / check-consistency / reorg-drill /
│   │                              #   refund-drill / ui-drill
│   └── test/                      # 260 个单测，不需要链或数据库
├── docs/aegis/                    # 设计规格、基线、24 条 ADR、实测校正记录
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
