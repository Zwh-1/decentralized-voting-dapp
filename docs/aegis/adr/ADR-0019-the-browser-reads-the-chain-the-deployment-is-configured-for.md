# ADR-0019 - 浏览器端的链身份来自部署配置，而不是钱包的默认链

Status: `recorded-from-work`
Date: `2026-09-21`

## Source Evidence

- 代码事实（修复前）：`Ballot.tsx` 用 `votingAddressFor(useChainId())` 决定合约地址。wagmi 在**没有连接钱包**时把 `chainId` 取为客户端配置里的第一条链，也就是本地的 Hardhat（31337），与 `CHAIN_ID` 无关。
- 实测（`web/.env` 指向 Sepolia，`next start -p 3100`，无钱包）：服务端首屏渲染出的 `合约地址` 是 **`0x5fbdb2315678afecb367f032d93f642f64180aa3`**，而服务端自己读的是 **`0x4bb0fd8c1a7e5e2bd95e2702c716f21e5ed6503e`**。同一页面上两个不同的合约，页面显示的是错的那个。
- 实测（同一状态）：`阶段` 渲染为 **`未知`** 并一直保持。原因是这个读数被发往 `http://127.0.0.1:8545`（`lib/wagmi.ts` 为 31337 配置的 transport），而该端口上没有任何节点在监听；Sepolia 的 RPC 是通的，服务端的 `链头 11748973` 就是它读回来的。
- 代码事实：`CHAIN_ID` 与 `VOTING_ADDRESS` 是**服务端**环境变量（`lib/config.ts`），Next.js 只把 `NEXT_PUBLIC_*` 内联进客户端包。也就是说浏览器**没有任何途径**知道这次部署指向哪条链——这不是取值取错了，而是信息根本没传过去。
- 实测（同一页面，`索引高度 11748968 / 链头 11748973` 与 `落后区块 0` 并列）：`落后区块` 按 `链头 − CONFIRMATIONS` 计算（ADR-0015），`索引用度` 却把游标与**原始链头**并列，于是一个正确的 `0` 看起来像"少了 5 个块"。
- 实测（修复前的同类缺陷，同一面板）：`押金` 由 `stakeOf.data ?? 0n` 渲染，读取失败时显示 **`0 ETH`**；`已投票` 显示 **`否`**；`白名单` 在读取失败后**永远停在 `读取中…`**。ADR-0014 已经把这条规则施加到 `合约状态` 面板，但没有施加到这两处。
- 实测（CDP 探针，无钱包，修复后）：`阶段 => 投票中`、`合约地址 => 0x4bb0fd…`、`索引高度 => 11749047 / 安全头 11749047`、`链头 => 11749052（最近 5 块待确认）`、`落后区块 => 0`，浏览器控制台 **0 条消息**。
- 实测（同一探针，用 CDP `Network.setBlockedURLs` 屏蔽浏览器所用 RPC）：`阶段 => 读取失败`，而服务端读到的 `数据来源 / 票数合计 / 索引高度 / 链头` 全部保留——失败被归因到产生它的那次读取，而不是被摊到整页。
- 实测（同一探针，浏览器用 viem 为 Sepolia 内置的 `11155111.rpc.thirdweb.com`）：一次加载出现 **8~12 条 `ERR_CONNECTION_CLOSED`**，全部指向该端点；`阶段` 有时仍是 `读取中…`。浏览器侧此前**没有任何**可配置的 Sepolia RPC 入口（`NEXT_PUBLIC_LOCAL_RPC_URL` 只覆盖 31337）。

## Context

ADR-0014 定下的规则是"读取失败不得渲染成具体值"，它当时只覆盖了 `合约状态` 面板的三行与服务端预取。本轮把这条规则在**链身份**这一层重新走了一遍，结果是同一个缺陷换了个位置：这次错的不是"未知被当成 0"，而是**整页认错了链**。

这个缺陷只在一种部署下可见：`CHAIN_ID` 不是客户端配置里的第一条链。本地开发（`CHAIN_ID=31337`）下两者的取值恰好相同，所以类型检查、构建、SSR、API 测试、`ui:drill` 全部通过——`ui:drill` 还显式拒绝在 31337 之外的链上运行（它会发真实交易）。缺陷恰好长在"唯一没被任何验证覆盖的配置"上，这是本项目反复遇到的那种面。

而修法不能只改显示。合约地址、`phase()`、`hasVoted`、`stakeOf`、`isWhitelisted` 五个读数共用同一个 `useChainId()`：只把地址显示改成正确的，读数仍然会打到错误的节点上，"显示正确、行为错误"比现在更糟。因此要决定的是**浏览器认为自己在跟哪条链说话**。

还有一条与它耦合的产品问题：当钱包连在**另一条链**上时（比如应用部署在 Sepolia、钱包停在本地链），服务端的票数与一致性比对来自 Sepolia，而钱包侧的读数与投票来自钱包所在的链。两套数字挨在一起显示却描述不同的链，这比单看任何一个都更容易误导。

## Decision

1. **浏览器从服务端渲染取得链身份。** 新增 `data.ts: getConfiguredTarget()`，返回 `{ chainId, votingAddress }`（配置不可读时为 `null`），由 `page.tsx` 作为 `configuredTarget` 属性传给 `Ballot`。这是浏览器唯一能知道"本次部署指向哪条链"的途径——`CHAIN_ID` 不在客户端包内。
2. **新增纯函数 `voting.ts: resolveChainTarget()`** 决定链与地址：连接了钱包时**以钱包所在链为准**（交易要由那个钱包在那条链上签名，地址必须是那条链上部署的那个），没有钱包时**以配置的链为准**。两者都不是"猜"：各自都是当时唯一能被证实的那条。
3. **链 id 一律按调用传给 wagmi**（`useReadContract({ chainId })`），而不是依赖客户端的默认链；并且只接受客户端配置登记过的链（经 `config.chains.find` 收窄类型）。未登记的链 id 会让 wagmi 抛 `ChainNotConfiguredError`，因此这种情况被报告为"没有可用的合约地址"，与"该链上没有部署合约"区分开，也不让一次读取把整页带崩。
4. **钱包链 ≠ 配置链时显式告警，并提供一键切换。** 页面顶部给出红色说明（哪条链上是服务端数据、哪条链上是你的投票），`WalletBar` 的链徽章转为警示色并出现"切到 <配置链>"。此前只有在链名未知时才出现切换按钮，而"Sepolia 对本地链"这种最常见的错配恰恰是"已知链名"。
5. **把 ADR-0014 的规则补齐到其余每一行。** 新增 `lib/ballot-labels.ts`：`阶段 / 已投票 / 投给 / 押金 / 白名单` 各自只依据**自己那次读取的状态**渲染，失败即 `读取失败`、未完成即 `读取中…`、链上没有可用合约即 `—`；`押金` 的失败态不再显示 `0 ETH`（`sweepUnclaimed()` 会把宽限期内未领回的押金交给 owner，这一行的代价是用户的资金）。
6. **`索引高度` 与 `落后区块` 的统计口径对齐：** 前者渲染 `游标 / 安全头`（`链头 − CONFIRMATIONS`），原始链头单独成行并注明"最近 N 块待确认"。一个正确的 `0` 不再看起来像自相矛盾。
7. **浏览器侧的 RPC 可配置：** 新增 `NEXT_PUBLIC_SEPOLIA_RPC_URL`（与既有的 `NEXT_PUBLIC_LOCAL_RPC_URL` 对称），未设置时沿用 viem 的默认端点。实测默认端点在本机不稳定，因此这条不是对称性洁癖。
8. **`立即同步索引` 必须报告结果**：`triggerSync()` 现在返回带类型的 `SyncResponse`，非 2xx 抛出路由给出的 `message`，按钮在请求进行中被禁用，成功后显示本次同步做了什么（同步了哪个区间 / 已追上 / 修复了重组 / 没有数据库）。附带把 `isSubmitting` 从"整页一个值"改为**按候选人区分**——投给 #1 不再让 #2、#3 也显示"提交中…"。

## Alternatives Considered

- **`<WagmiProvider initialState={{ chainId }}>`（服务端把链 id 注入 wagmi 的初始状态）。** 这是 wagmi 文档的 SSR 姿势，但在这里不可靠：`createConfig` 只在 `ssr: true` 时设置 `skipHydration`，否则 zustand 的 persist 在**客户端**首次渲染前就已从 `localStorage` 完成水合，`hydrate()` 里 `initialState` 那一支被跳过——服务端渲染 Sepolia、客户端渲染 31337，正好制造水合不一致。而硬编码 `ssr: true` 会在两端关掉 EIP-6963 发现，为一个显示问题改动钱包发现路径，代价更大。
- **只加 `NEXT_PUBLIC_CHAIN_ID`。** 它把同一个事实写在两处（服务端 `CHAIN_ID` 与客户端 `NEXT_PUBLIC_CHAIN_ID`），且两处可以静默漂移；更要紧的是它在任何既有 `.env` 上都不存在，因此修复在运维补上这个变量之前不会生效——而这个 bug 的表现正是"运维以为已经配好了"。
- **只修正 `合约地址` 的显示，读数仍然走 `useChainId()`。** 显示会正确而行为仍然错误：地址是 Sepolia 的，`phase()` 打到已经不存在的本地节点。这比现状更难排查。
- **把 `phase` 一并放进 `/api/health`，让浏览器不再自己读链。** 会让 ADR-0009 的"资格来自链上"出现第二个来源（服务端的 phase 与钱包侧的白名单/已投票读数来自不同高度），并且把一个每 10 秒刷新的服务端字段变成投票按钮可用性的依据。
- **错配时只禁用投票，不告警。** 会留下"服务端的票数与一致性比对描述的是另一条链"这件事不被说明；读者会以为页面在说同一次投票。
- **给未登记的链做一条兜底 transport。** 需要为任意链 id 现造 viem chain 与 RPC，而"这条链上没有部署"与"这个构建不认识这条链"是两个不同的答案，合并它们会让其中一个是错的（ADR-0012）。

## Consequences

- 正面：`CHAIN_ID=11155111` 且无钱包时，页面显示的合约地址、`阶段` 与五个链上读数都指向 Sepolia；实测 `阶段 => 投票中`、控制台 0 条消息（无水合不一致）。
- 正面：浏览器所用 RPC 不可达时，`阶段 => 读取失败` 而服务端读到的行原样保留——失败被归因到它真正发生的那次读取。
- 正面：`押金`、`已投票`、`投给`、`白名单` 四行在读取失败时不再给出确定结论；`押金` 那一行的代价本来就是用户的资金。
- 正面：`索引高度` 与 `落后区块` 口径一致，`链头` 自己解释了那 5 个块的去向。
- 正面：手动同步的失败不再是静默的（此前 503 与成功在界面上完全一样）。
- 代价：`Ballot` 多了一个必填属性；页面多了一处按链的状态分支（`config.chains.find`），未登记的链 id 会以"没有可用合约"呈现，这是刻意的。
- 代价：`NEXT_PUBLIC_*` 是构建期内联的，改浏览器 RPC 需要重新构建（与 `NEXT_PUBLIC_IPFS_GATEWAY` 同一约束，已在 `.env.example` 写明）。
- 测试：索引器/web 单测 106 → **146**（`ballot-labels.test.ts` 12 → 41，新增 `chain-target.test.ts` 7，`config.test.ts` 修正 1 个已失效的夹具并新增 1 个）。其中 `config.test.ts` 的"没有部署记录的链"原本用 `11155111` 当夹具，Sepolia 部署记录一出现该用例就不再测它声称的东西——这是本轮修掉的另一处"测试比它声称的少"。
- **已知边界**：`ui:drill` 仍然只在 31337 上运行（它用 `--vote` / `--refund` 时发真实交易），因此本轮的两条浏览器证据来自一次性 CDP 探针，不是演练；"钱包连在错链上"的分支（告警横幅与切换按钮）**只在单测与代码层面验证过**，没有用真实钱包在两条链之间切换过。

## Compatibility Boundary

`/api/*` 的响应形状、合约交互、`deployments` 生成物均未改动。**可观察的行为变化**：无钱包时页面显示的合约地址与链名改为部署配置的那条链；`阶段` 不再把三种状态合并为 `未知`；`我的状态` 的四行在读取失败/进行中时不再显示具体值；`索引高度` 的第二个数字由原始链头改为安全头（新增独立的 `链头` 行）；`立即同步索引` 会显示结果且在请求中禁用；投票按钮的"提交中…"只出现在被点击的那张卡片上；新增可选环境变量 `NEXT_PUBLIC_SEPOLIA_RPC_URL`。

## Retirement Impact

第 1、2 条是"客户端不得自行猜测链身份"的落点：即使将来把链列表改成从配置生成（多链部署），"没有钱包时以部署配置为准、有钱包时以钱包为准"这一划分必须保留。第 3 条在 wagmi 升级后仍需保证：任何按调用传入的 `chainId` 都必须先经过客户端配置的收窄，否则未登记的链会从"可报告的未知"变成一次抛错。第 5 条是 ADR-0014 的补齐，必须随面板一起保留——将来若面板改由服务端渲染，同样要逐行携带各自的状态。第 6 条依赖 ADR-0015 的 `lagBlocks` 定义，若滞后的口径改为按原始链头计算，这一行必须同步改回，两者不得各自表述。第 7 条在一个真实 pinning/RPC 服务被写进部署文档后应重新审视：如果服务端与浏览器被要求使用同一个端点，两处配置应收敛为一个。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §6.4 与 §14 校正 12/16 登记的是 `合约状态` 面板三行的措辞与"读取失败不得渲染成具体值"（ADR-0014）；本轮把同一条规则延伸到链身份与 `我的状态` 四行，并为"客户端默认链"这一此前**从未被登记为被验证对象**的行为建档。既有条目无需改写，漂移表补记一行。

## Evidence References

- web/src/lib/voting.ts（`CHAIN_NAMES`、`chainName`、`resolveChainTarget`）
- web/src/lib/data.ts（`getConfiguredTarget`）
- web/src/app/page.tsx（`configuredTarget` 属性）
- web/src/components/Ballot.tsx（按调用传 `chainId`、错链告警、同步反馈、按候选人区分提交态）
- web/src/components/WalletBar.tsx（配置链徽章与切换）
- web/src/lib/ballot-labels.ts、web/src/lib/wagmi.ts、web/src/lib/client-api.ts
- web/test/chain-target.test.ts（新增）、web/test/ballot-labels.test.ts、web/test/config.test.ts
- docs/aegis/adr/ADR-0009-ui-eligibility-from-chain-not-query-status.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md
- docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md
- docs/aegis/adr/ADR-0015-lag-is-null-when-there-is-no-index-to-be-behind.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
