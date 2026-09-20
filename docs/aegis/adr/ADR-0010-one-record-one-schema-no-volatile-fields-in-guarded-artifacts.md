# ADR-0010 - 部署记录只有一个写入 schema，被字节级守护的产物只含可复现字段

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测：在一条全新链上按 README 的快速开始只跑 `pnpm seed:local`，事后 `git diff` 显示 `contracts/deployments/31337.json` 丢了 `blockNumber`：

  ```diff
  -  "deployedAt": "2026-09-20T03:13:04.650Z",
  -  "blockNumber": 1
  +  "deployedAt": "2026-09-20T06:23:37.829Z"
  ```

  同一时刻 `export-abi` 生成的 `web/src/lib/contracts/deployments.ts` 随之变成 `blockNumber: undefined`（修复前实测值）。

- 实测：两个写入方对地址大小写不一致。`deploy.ts` 与 `seed-local.ts` 都写 viem 的 `voting.address`（校验和格式 `0x5FbDB2…`），而仓库里提交的记录与生成产物都是小写 `0x5fbd…`，于是任一脚本在全新链上跑一次都会额外产生一处无语义的 diff。
- 实测：`deployedAt` 在整个仓库中**没有任何消费方**（`git grep deployedAt` 只命中记录本身、三个脚本的类型声明与生成产物），却经由 `export-abi` 进入被 CI 以 `git diff --exit-code` 字节级守护的文件。它是时间戳，因此任何一次 `deploy:local` / `seed:local` 都会让它变化。
- 实测（修复后）：全新链上 `seed:local` → `export-abi`，生成产物 SHA256 与"由已提交记录生成"的 SHA256 **完全相同**（`C32DB34e…`）；记录本身与已提交版本的唯一差异是 `deployedAt`。
- 实测（新增 CI 作业的等价流程，全新链 + 全新库）：`migrate` → 7 张表；`drain` → `seen 404 / inserted 404 / duplicatesIgnored 0`；`check-consistency` → `consistent`、`200/200`、`discrepancies []`；把游标归零强制重放 → `seen 404 / inserted 0 / duplicatesIgnored 404`，投影仍为 `votes=200 cursor=406 tally=67,67,66`。
- 实测：CI 的"后台起节点 + 就绪轮询"shell 机制在 `bash` 下可用——后台进程拿到 PID、轮询在第 1 次即就绪、`curl` JSON-RPC 可读回链头、进程可终止、日志捕获到 71 行（失败可诊断）。

## Context

`contracts/deployments/<chainId>.json` 是**一份被两个脚本写入的文件**：`deploy.ts`（M4，Sepolia 与本地共用）和 `seed-local.ts`（本地一键播种）。两者各自维护一份字面量对象，没有共享类型，也没有任何检查约束它们一致。

结果是两次真实的静默退化：

**其一，`blockNumber` 被抹掉。** 该字段是第 4 轮为"索引从部署区块开始"而引入的：公共 RPC 会裁剪历史（Sepolia 最早可用区块约在 1,000,000），从区块 0 扫描不是慢，而是**直接失败**。`seed-local.ts` 不写它，于是按 README 走完快速开始的用户，其记录里没有这个字段，`resolveStartBlock` 回退到 `undefined`。本地链只有 406 块，所以看不出任何异常——缺陷只在换到真实链时才发作。更刺眼的是 `seed-local.ts` 当时已经取了 `const blockNumber = await publicClient.getBlockNumber();` 却从未使用：意图在，接线断了。

**其二，被守护的产物里混进了不可复现的字段。** `abi-drift` 作业用 `git diff --exit-code` 判定"生成的 ABI 与地址注册表是否与提交一致"。守护的有效性取决于**产物是否可由可复现的输入重建**。`deployedAt` 是时间戳，任何人跑一次本地播种都会改变它——于是这个检查会对一个语义上什么都没变的改动报红。一个会在无变化时报红的检查，最终会被当成噪音绕过，那它就不再守护任何东西。

问题的共同形状：**同一份事实有两个写入方，且一个字节级守护的边界内允许了不可复现的内容。**

## Decision

1. **两个写入方必须产出同一 schema。** `seed-local.ts` 改用 `viem.sendDeploymentTransaction`（而非 `deployContract`）并等待收据，把**创建区块**写入 `blockNumber`。`deployContract` 不返回部署交易，因此取不到创建区块——这不是风格选择，是唯一能做到的方式。`seed-local.ts` 中那个取了却不用的链头改名为 `headBlock`，仅用于摘要输出，避免与部署区块混淆。
2. **地址一律小写。** 记录与生成产物统一为小写形式（仓库里已提交的就是这一形式），两个脚本出口处显式 `.toLowerCase()`。机器可读记录不需要 EIP-55 校验和，而大小写不一致本身就是一类稳定的 diff 与比较 bug 来源。
3. **被字节级守护的产物只允许包含可由链复现的字段。** `export-abi` 不再把 `deployedAt` 发布进 `web/src/lib/contracts/deployments.ts`，并从 `Deployment` 接口中移除该字段。时间戳仍留在 JSON 记录里作为部署溯源信息——记录不被字节级守护，产物被守护，两者要求不同。
4. **本地链端口可配置。** 新增 `LOCALHOST_RPC_URL`（默认 `http://127.0.0.1:8545`），Hardhat 的 `localhost` 网络与 `seed-local.ts` 都认它。这不是为了灵活，而是为了让端到端流程能够**在第二条链上排练**：`deploy:local` 原先硬编码 8545，任何一次完整端到端演练都得先拆掉正在用的那条链，而本项目的多项测量都依赖那条链的状态。
5. **新增 `indexer-e2e` CI 作业。** 它起一个本地链、跑 `seed:local`、建表、`drain`、比对一致性，并把游标归零强制重放验证幂等（M-6b），且以 `CONFIRMATIONS=0` 运行——整条链对整份索引，落后不算通过。此前 CI 中**没有任何步骤触碰链或索引器**，而这个项目最核心的结论（偏差 0/200）正是它要守护的。

## Alternatives Considered

- **让 `seed-local.ts` 调用 `deploy:local` 的代码路径，消除重复。** 更彻底，但 `deploy.ts` 还承担 Sepolia 特有的职责（Etherscan 链接、覆盖既有记录的告警、`VOTING_OWNER` 环境变量），把播种耦合进去会让本地路径承担它不需要的分支。改为在两侧写死同一约束并用注释与 CI 的实际执行来锁定。
- **统一成校验和格式（EIP-55）而非小写。** 校验和的价值在于人手工键入时能发现笔误；这两个字段是机器写、机器读，收益为零，且会改动已提交的产物与所有既有测量基线。选小写是取其"与已提交状态一致"。
- **在产物中保留 `deployedAt`，改用"比较时忽略该行"的漂移检查。** 让检查变得需要解析内容、维护忽略列表，比"不发布该字段"复杂得多，且会掩盖真正的漂移。
- **干脆不提交 `deployments/31337.json`。** 那么 `abi-drift` 作业与冷克隆可复现性都会失去本地链的地址锚点，且 `pnpm test` 中依赖 `getDeployment(31337)` 的用例会失去依据。
- **把 `ui:drill` 也放进 CI 以补齐浏览器覆盖。** 它需要本机 Chrome 与运行中的节点，判定为环境依赖而非能力缺失，维持在手动演练（见 ADR-0009）。

## Consequences

- README 的快速开始（`pnpm seed:local` 一条命令）现在与 `deploy:local` 写出**同一份记录**，且都不会再破坏 `blockNumber`。此前"按文档操作会退化"这一状态被消除。
- `abi-drift` 作业的语义变强：它现在真正等价于"生成产物与提交一致"，而不是"自上次部署以来没人跑过播种"。验证方式是可执行的一句话：全新链上 `seed:local && export-abi`，生成文件哈希不变。
- 新增的 `indexer-e2e` 作业把此前只在手动流程中存在的端到端保证纳入 CI。它与 `web` 作业的边界**互不掩盖**：`web` 只验证 schema 对真实 MySQL 有效且迁移幂等，不碰链；`indexer-e2e` 才碰链。
- 代价：CI 多一个作业，需要起节点、播种 200 票并跑两次 drain，是流水线中最慢的一环。这是为守护头号结论付出的、可接受的成本。
- 代价：`deployments/<chainId>.json` 在本地播种后仍会因 `deployedAt` 与提交版本不同而出现在 `git status` 中。这是有意的（部署溯源应当记录真实时间），且已不再影响任何被守护的产物。
- 未解决：`deploy.ts` 与 `seed-local.ts` 仍各自维护一份字面量，靠注释而非类型约束一致。彻底的做法是抽出共享的记录构造与写入函数，本轮未做——因为那会改动两个脚本的职责边界，而当前的可验证收益（哈希不变 + CI 实际执行）已经拿到。

## Compatibility Boundary

`contracts/deployments/<chainId>.json` 的字段集合不变（仍是 `chainId`/`voting`/`owner`/`deployer`/`deployedAt`/`blockNumber`），只是 `blockNumber` 现在由两个写入方都保证存在，且地址统一为小写。生成的 `web/src/lib/contracts/deployments.ts` 移除了 `Deployment.deployedAt`——这是一个**破坏性类型变更**，已确认全仓库无消费方（`git grep deployedAt` 只命中记录本身、三个脚本内的类型声明与产物）。前端读取的 `getDeployment(chainId)` 签名与返回值其余部分不变，`/api/**` 的响应结构不变。

`LOCALHOST_RPC_URL` 是新增的**可选**环境变量，不设置时行为与之前逐字节相同（8545）。`seed-local.ts` 仍识别 `RPC_URL`（作为次优先回退），因此既有的本地脚本与文档无需改动。

## Retirement Impact

若 Hardhat 未来允许以声明方式表达"本地链端口"，`LOCALHOST_RPC_URL` 这一手动读取可以移除，但"端到端演练必须能在第二条链上进行而不影响在用的链"这一约束应当保留。若 `deploy.ts` 与 `seed-local.ts` 未来合并为共享的记录写入函数，第 1、2 条的具体措施将被取代，但"同一份事实只有一个 schema"这一原则不随之失效。若 CI 未来可以运行浏览器自动化，`indexer-e2e` 与 `ui:drill` 的边界需重新划分——前者守护链与索引的一致性，后者守护用户能否完成操作，两者不可互相替代。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-6（一致性）此前只在本机手动流程中验证，CI 中无任何步骤触碰链；§14 校正 10 登记的部署记录实际上有两个写入方且 schema 不一致；M-0 的 `abi-drift` 守护产物含不可复现字段。漂移表已补记四行，权威面状态中的 ADR 数量与 CI 流水线数量已同步更新。

## Evidence References

- contracts/scripts/seed-local.ts
- contracts/scripts/deploy.ts
- contracts/scripts/export-abi.ts
- contracts/hardhat.config.ts
- contracts/deployments/31337.json
- web/src/lib/contracts/deployments.ts
- web/src/lib/config.ts
- .github/workflows/ci.yml
- README.md
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
