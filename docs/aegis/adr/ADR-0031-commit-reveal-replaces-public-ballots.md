# ADR-0031 - 以 commit-reveal 取代"明票上链"，并明确它隐藏的是什么、不隐藏的是什么

Status: `accepted`
Date: `2026-09-22`
Supersedes: `ADR-0003`

## Source Evidence

- 用户在本会话中对"投票隐私怎么处理"一题选择了 **commit-reveal 两阶段投票**
- 被取代：[ADR-0003](ADR-0003-public-ballots-no-vote-privacy.md)「明票上链，并在 README 与 UI 中主动声明没有投票隐私」
- 现状依据：`contracts/contracts/Poll.sol` 的 `VoteCast(address indexed voter, uint256 indexed optionId, uint256 newCount)` 明文携带选项；`votedFor` 为 public mapping
- 相关：`docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md` Task 4

## Context

ADR-0003 当初**考虑过并拒绝了** commit-reveal，给出的两条理由是：

1. 「只解决截止前泄露，揭示期后仍公开」
2. 「引入『不揭示』的惩罚设计」

这两条都不是错误的观察——它们是**准确的代价描述**。ADR-0003 的选择是"把复杂度预算花在可测量的一致性上"，在那个时点（单租户公投、隐私不在需求内）是自洽的。

现在决策反转，理由不是"当初判断错了"，而是**需求边界变了**：本项目的投票模型已经扩展为多机制平台，而隐私在多机制下不只是一种体验，它直接改变投票结果的可信度——在公开明票下，投票过程中任何参与者都能看到实时票数并据此调整自己的行为（跟票、策略性投票、对未决者的施压），这使得"票数"不再是独立选择的聚合。commit-reveal 消除的正是**投票过程中**的这种影响。

## Decision

新增一种可选的投票机制：**commit-reveal 两阶段投票**。它在创建时选定，与既有明票机制并存。

### 它隐藏什么

在**投票进行期间**，任何选项的票数都不会因为你 commit 而改变。`commit(commitment)` 只写入一个哈希，链上无法从它反推选项。因此：

- 投票期间，没有人（包括创建者、包括本项目的索引器）能从链上得知某地址投了什么；
- 投票期间，票数不会泄露，因此不存在"看着实时票数决定自己怎么投"的空间。

### 它不隐藏什么

**这一节是本 ADR 最重要的部分。**

- **揭示之后，一切照旧公开。** `reveal(optionIds, salt)` 会把明文写进事件，与明票机制下完全一样。commit-reveal 不提供"永久隐私"。
- **"某地址是否已 commit"是公开的。** `commit` 本身是一笔链上交易，它证明这个地址参与了，只是不证明投了什么。对"参与者身份"需要保密的场景，本机制**不够**。
- **不防串谋，不防胁迫。** 投票期间不可见，但揭示后可见；一个能在投票前胁迫你的人，可以在揭示后核查你是否照做。
- **因此本项目仍然不能用于任何需要真实选举级别隐私的场景。** README 中原有的"不要用于真实选举"警告**继续保留**，不得因为本 ADR 而删除。

### 对 ADR-0003 两条拒绝理由的逐条处置

| ADR-0003 的顾虑    | 本 ADR 的处置                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 揭示期后仍公开     | **接受，并明说**。commit-reveal 的价值定位是"投票过程中不泄露"而非"永久隐私"。页面与 README 必须按这个措辞描述，不得含糊成"隐私投票" |
| "不揭示"的惩罚设计 | **不引入惩罚**。未揭示者视为**弃权**：其票不计入任何选项，押金仍可通过既有的 `refund` 全额取回。见下"为什么不用惩罚"                 |

### 为什么不用惩罚

一个"不揭示就罚没押金"的设计会造出一个更糟的问题：**它可以被用来冻结整个投票**。任何人只要提交一个 commit 然后不揭示，就会触发争议；若规则是"未揭示阻塞结束"，则一个地址可以零成本地让整场投票无法收尾。

因此本 ADR 拒绝"未揭示阻塞结束"。未揭示只是一种弃权，与"从没参与过"在**计票结果**上等价，但在**报告上不等价**——见下。

### 未揭示必须与"没参与"分开报告

这是 ADR-0011（两种缺失走同一条回退路径，且不得用默认值代替"未知"）与 ADR-0014（读取失败不得渲染成具体值）在同一问题上的直接推论：

- `committed` 是一个**独立状态**，不是 `hasVoted` 的中间值；
- 把"已 commit 未 reveal"渲染成"没投票"，与把"读取失败"渲染成"没有票"是同一类错误；
- 因此索引新增 `committed` 状态，UI 必须能分别回答"这个地址没参与"与"这个地址参与了但没揭示"。

## Alternatives Considered

- **维持 ADR-0003（明票）**：被用户显式否决。保留它作为**可选机制**（而非唯一机制）是本决策的一部分——明票仍是默认，因为它更简单、更省 gas、且没有揭示窗口这个失败面。
- **Semaphore / 零知识匿名投票**：提供真正的匿名性（连"谁参与了"都可隐藏），但需要电路编译、证明生成与可信设置。工作量超过本项目全部链上部分，明确不在范围内。
- **MACI 抗串谋**：需要协调者与密钥服务器，中心化假设比本项目现有的"白名单中心化"更难解释。不在范围内。
- **加密上链 + 阈值解密**：需要门限密钥方，引入一个全新的信任方。不在范围内。

## Consequences

**正面**

- 投票过程中的票数与个人选择不再可见，消除了跟票与实时施压。
- 与既有明票机制并存，创建者可依场景选择；不需要牺牲既有的简单路径。
- `commit` 的哈希绑定 `voter` 与 poll 地址后，抢跑重放不可行。

**代价（必须如实记录）**

- **投票从一步变两步**：commit 与 reveal 是两笔交易，用户需要两次签名，且必须自己保管 salt——丢失 salt 等于放弃这一票。前端必须提供 salt 的本地保存与导出，并在 UI 中明说这一点。
- **gas 增加**：每个投票人两笔交易而非一笔。
- **新增一个失败面**：揭示窗口。若用户忘记揭示，其票作废（押金不受损）。
- **索引与 UI 复杂度上升**：新增 `committed` 状态与揭示窗口的倒计时、理由文案。
- **`Phase` 枚举扩展**：改变 `phase_events.to_phase` 的取值域，索引库需重建（理由同 ADR-0021：游标已越过相关区块区间）。

## Compatibility Boundary

- **ABI 不兼容**：新增 `commit` / `reveal` 写路径；`Phase` 枚举扩展；`voterState` 返回值再次扩展。
- 既有明票投票的行为**不变**（`commit` 路径仅在创建时选定了该机制时才可用）。
- 旧部署作废，不保留兼容层。处置沿用 ADR-0023 那一轮：`pnpm deploy:local && pnpm seed:local && pnpm export-abi`，Sepolia 索引库清空重建。

## Retirement Impact

- **ADR-0003 被本 ADR 取代**（`Status: superseded`）。README 中「没有投票隐私（重要）」一节必须改写为"明票是默认机制；可选 commit-reveal 在投票期间隐藏选择，但揭示后公开"。
- 若 ADR-0003 的措辞仍在 UI 中以常驻提示形式存在，该提示必须同步更新——**一个宣称"本项目没有投票隐私"的横幅，在用户选了 commit-reveal 之后就是假话**。
- 不退役明票路径本身：它仍是默认机制，且是 commit-reveal 的对照基线。

## Baseline Sync

- Needed: needed
- Target: `docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md` §11（非目标）
- Action: amend
- Reason: 规格 §11 将"投票隐私"列为非目标。本 ADR 只实现其一个受限子集（投票过程中不可见），因此 §11 需改为"不做零知识匿名与抗串谋；commit-reveal 作为可选机制提供"，而不是整条删除——把边界写准比写宽更重要。
- Also: `CONTRIBUTING.md` 与 README 的隐私声明需同步。

## Evidence References

- `contracts/contracts/Poll.sol`（现有 `VoteCast` 明文事件与 public `votedFor`）
- `docs/aegis/adr/ADR-0003-public-ballots-no-vote-privacy.md`（被取代）
- `docs/aegis/adr/ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md`
- `docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md`
- `docs/aegis/adr/ADR-0021-a-cid-is-computed-from-the-document-it-names.md`
- `docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md`

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
