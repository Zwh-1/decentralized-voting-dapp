# ADR-0033 - 创建准入是一个开关，不是一个门槛

Status: `accepted`
Date: `2026-09-22`
Related: `docs/aegis/adr/ADR-0025-admission-mode-is-fixed-at-initialize.md`（投票人准入，本 ADR 处理创建者准入）
Related: `docs/aegis/adr/ADR-0032-results-only-count-when-they-have-consequences.md`

## Source Evidence

- `README.md` §0：项目自述「任何人都能创建投票，因此投票本身不可信」，并指出正解是给工厂加一层准入
- `contracts/contracts/VotingFactory.sol`：现状**没有 owner、没有任何准入检查**，`createPoll` 对任何调用者开放
- 现状依据：`VotingFactory` 不继承 `Ownable`，其构造仅部署实现合约

## Context

这个项目最根本的可信度问题不是投票本身，而是**投票的来源**：任何人都能部署一次投票，因此"链上有这个投票"不构成任何背书。README 已经承认这一点。

但把准入做成**必选**会造成另一个问题：这个项目的全部演示、全部既有测试、全部本地演练都建立在"任何人都能开一个投票"之上。让准入默认开启等于让这些路径全部失效，而它们正是回归基线。

所以真正的问题不是"要不要准入"，而是三个不会自己回答的问题：

1. **默认是开还是关？**
2. **开关打开时，既有测试与既有部署会发生什么？**
3. **谁来决定名单？**

第 3 个问题有一个看起来省事但错误的答案：**让创建者自己维护名单**。若名单由某个创建者管理，那"创建准入"就退化成"换一个人拥有创建权"，而这个人本身没有任何来源上的正当性。

第 1 个问题若答"默认开启"，则一次升级会让所有既有部署的 `createPoll` 开始 revert——一次静默的、破坏性的行为变更，而它伪装成"加了个功能"。

第 2 个问题若被忽略，就没有任何东西能证明"默认关闭时行为未变"。而这类"我加了个开关，旧行为不变"的声明，恰恰是回归测试最该钉住的。

## Decision

**一、默认关闭，且关闭时不增加任何检查。**

`creatorAllowlistEnabled` 初始为 `false`。关闭时 `createPoll` 的准入分支完全不执行，因此既有行为逐字节不变。这不是"为了兼容而妥协"，而是**让这次改动的效果可以被证伪**：默认关闭时必须能证明既有测试全部保持通过，否则就不是"没变"。

**二、开启后由工厂 owner 管理名单，且 owner 的角色被明确写下来。**

工厂新增 `Ownable`，部署者是 owner。这与 `Poll` 的 `Ownable` 同源（部署者即管理员），不是新引入的信任方——本地演示与 Sepolia 部署的 owner 都是同一个部署地址。

**这不解决"谁来信任名单"的问题，只是把它变成一个可见的、有明确归属的问题。** 一个隐藏的中心化比一个写在合约里、带事件、可以被质询的中心化更糟。本 ADR 选择后者。

**三、名单是加法集合，不是替换列表。**

`setCreatorAllowed(address[], bool)` 与 `Poll.setWhitelist` 同形。理由相同：批量替换会让"谁在名单里"变成一次调用的副作用，而增量授权让每次变更都有一个事件。

**四、准入只作用于 `createPoll`，不追溯既有投票。**

一个被移出名单的地址，它此前创建的投票**不受影响**：那些投票已经有自己的白名单、自己的押金、自己的结果。追溯性地让既有投票失效等于让一次管理动作销毁他人资产。

**五、准入状态与名单必须可从链上读到，并进入前端的分支。**

前端在准入开启而当前地址不在名单时，必须**不显示创建表单**（或显示原因），而不是让用户填完表单后被 revert。这与 ADR-0012 是同一条规则：一个启用的按钮，其交易必须能成功。

## Alternatives Considered

- **默认开启准入**：见 Context 第 1 点。一次升级静默破坏既有部署。
- **让创建者管理名单**：见 Context 第 3 点。只是换个人拥有创建权，且那个人是谁取决于谁先部署，没有来源上的正当性。
- **用 ERC20 持仓作为创建门槛**：引入一个代币，而本项目已经明确拒绝把权重做成 ERC20（ADR-0030 的讨论）。用代币做准入门槛需要先有代币经济，那超出了本项目范围。
- **不做准入，只在 README 里写清楚**：现状已经如此，而 README §0 已经承认这是缺陷。保持不变等于把已知问题写下来当解决方案。
- **做成不可逆开关（开启后永不可关）**：会让一次误操作永久锁死创建能力。名单可变、开关可逆，代价是 owner 能随时关闭准入——这个代价被明确记录，而不是被隐藏。

## Consequences

**正面**

- 项目可以从"任何人都能创建"切换到"只有被授权者能创建"，且切换是**可见的、带事件的、可回滚的**。
- 默认关闭使这次改动可以在既有回归套件下被验证为无行为变化。
- 前端能够如实反映当前准入状态，而不是让用户撞在 revert 上。

**代价（必须如实记录）**

- **`VotingFactory` 引入了 `Ownable`，这是一个新的中心化点。** 它只能准入创建者，不能删除投票、不能改票、不能动押金，但它确实集中了"谁能发起投票"这一项权力。这一点必须写进 README，而不是留在合约注释里。
- **关闭准入时，README §0 的批评仍然成立。** 这个开关不解决"公开部署下投票来源不可信"，它只是让部署者**可以选择**解决。README 必须区分"能力存在"与"当前部署是否启用"。
- **owner 可以被转让/放弃。** `Ownable` 的 `transferOwnership` 与 `renounceOwnership` 都可用。放弃所有权会让准入永久停留在当时的状态——若停留在"开启"，则创建能力被永久锁死。这是 OpenZeppelin 的标准语义，本项目不额外加保护，但必须记录。
- 新增 `OwnerChanged`-类事件与两个读方法，索引与 ABI 需同步。

## Compatibility Boundary

- **ABI 兼容**：`createPoll` 签名**不变**（准入是状态检查，不是新参数）。这是刻意的——加参数会让所有既有调用点失效，而准入作为状态可以让默认路径完全不动。
- `VotingFactory` 新增 `Ownable` 基类，新增 `creatorAllowlistEnabled` / `setCreatorAllowlist` / `setCreatorAllowlistEnabled` / `isCreatorAllowed`。
- `Poll.initialize` **不兼容**（新增 `executionTargets` 参数，见 ADR-0032 与本批次），处置同前。
- 既有工厂测试必须在默认关闭下全部保持通过——这是本 Task 的**兼容性证据**，不是附带检查。

## Retirement Impact

- README §0 关于"任何人都能创建投票"的表述必须改为区分能力与启用状态，否则会变成一句在准入开启的部署上不成立的话。
- 不退役任何既有行为。

## Baseline Sync

- Needed: needed
- Target: `README.md` §0、`docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md` §11
- Action: amend
- Reason: README §0 把"任何人都能创建投票"当作当前缺陷陈述，并指出"正解是给工厂加一层准入"。准入实现后，该段必须改为"能力已提供；当前部署是否启用见 `creatorAllowlistEnabled`"，否则读者无法判断手上这个部署属于哪种。

## Evidence References

- `contracts/contracts/VotingFactory.sol`（无 owner、无准入检查的现状）
- `contracts/contracts/Poll.sol`（`setWhitelist` 的增量授权形态，本 ADR 沿用）
- `docs/aegis/adr/ADR-0012-*.md`（"启用的按钮必须能成功"）
- `docs/aegis/adr/ADR-0032-results-only-count-when-they-have-consequences.md`
- `docs/aegis/plans/2026-09-22-voting-mechanisms-and-platform-depth.md` Task 7

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
