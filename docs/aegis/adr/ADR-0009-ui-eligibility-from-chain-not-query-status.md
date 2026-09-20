# ADR-0009 - 投票按钮的可用性必须由链上状态推导，且不得用被禁用的查询判定"进行中"

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- Design Spec §15「浏览器端写入路径的两个缺陷」；实测：注入钱包连接后，未白名单账户 `isWhitelisted=false` 的 3 个按钮**全部可点**，点击必然 revert
- 实测：修复前，无论钱包是否连接，每个投票按钮的文本都是"提交中…"；`pnpm ui:drill` 修复后断言"没有任何按钮停留在提交中…"在两个场景下均通过
- 实测：修复后已白名单账户 `isWhitelisted=true hasVoted=false` 下 3 个按钮**全部可点**，点击后交易到达"已确认"，卡片变为"你已投给该候选人"（交易 `0x14d9380e…` 区块 408，索引侧 tally 67→68 同步）
- `pnpm ui:drill` 两个场景各 7 / 11 项断言全部通过，退出码均为 0

## Context

项目此前的验证全部发生在**没有浏览器**的地方：类型检查、生产构建、服务端渲染、API 实测响应、索引器单测与合约测试。写入路径的前端部分不在其中，而两个真实缺陷恰好只在这个面上可见。

**缺陷一：按钮永远点不动。** `Ballot.tsx` 用 `isSubmitting={isPending || receipt.isPending}`。没有交易哈希时 wagmi 会禁用收据查询（`enabled: Boolean(hash && …)`），而被禁用的 TanStack Query **仍然报告 `status: "pending"`**，因此 `receipt.isPending` 恒为 true。按钮的 `disabled={!canVote || isSubmitting}` 于是永远成立，标签永远显示"提交中…"。**连上钱包也无法投票**——前端核心写入路径彻底失效，而所有既有验证都是绿的。

**缺陷二：未白名单账户也能点。** `canVote` 只检查阶段、连接状态与是否已投票，从不查白名单。按钮亮着，点下去由合约 revert 拒绝。合约其实**公开了** `mapping(address => bool) public isWhitelisted`，UI 完全可以自行判断。

两个缺陷共有一个性质：它们不改变任何接口、类型或构建产物，只改变"用户实际能不能完成这件事"。

## Decision

1. **"进行中"以 `isLoading` 判定，不以 `isPending` 判定。** `receipt.isLoading` 是 `isPending && isFetching`，只在收据确实在请求中时为真；`isPending` 对"被禁用的查询"同样为真，因此不能用来表示"正在发生"。凡是用 TanStack 查询状态驱动 UI 进行态的地方，一律按此区分。
2. **提现按钮的可用性由链上状态推导，不由索引推导。** `canVote` 加入 `isWhitelisted`（`useReadContract`，直接读 `Voting.isWhitelisted`），并在未通过时给出**具体理由**（"这个地址不在白名单里，合约会拒绝投票。"）。不采用 `/api/voters/[address]`，因为索引是可选的、且可能落后——用可能过期的数据去**阻止**一笔合法交易，比让用户多一次 revert 更糟。链是唯一事实源（ADR-0001）。
3. **"我的状态"面板新增"白名单"一行**，与"已投票""押金"并列，使用户在点击之前就能看到自己是否具备资格。
4. **新增 `pnpm ui:drill`**：用 DevTools Protocol 驱动 headless Chrome，注入 EIP-1193 provider（把 `eth_sendTransaction` 转发给本地节点由其解锁账户签名，全程不接触私钥），断言 **UI 的按钮可用性与链上 `isWhitelisted && !hasVoted && phase == Voting` 逐一相符**。它不引入任何浏览器自动化依赖——Node 22+ 自带 `WebSocket`。

## Alternatives Considered

- **让用户先点、由合约 revert 决定**：即修复前的行为。合约仍然安全，但用户要经历一次注定失败的钱包交互；且"按钮亮着却必然失败"本身就是错误信息。
- **用索引 `/api/voters/[address]` 判断白名单**：会引入"用可能落后的缓存阻止合法交易"这一新故障模式，且未配置数据库时该接口退化为 `unavailable`，按钮将失去判据。
- **只改标签文案，保留 `receipt.isPending`**：没有触及根因；按钮仍不可点。
- **引入 Playwright / Puppeteer**：能得到同样的覆盖，但为一个演练给项目增加数百 MB 的浏览器与依赖。CDP + 内置 `WebSocket` 已足够。
- **把 `ui:drill` 放进 CI**：它需要本机 Chrome 与运行中的 `hardhat node`，放进去只会让 CI 变得依赖环境而不稳定。定位为手动演练，与 `reorg-drill` / `refund-drill` 同类。

## Consequences

- 正面：前端写入路径第一次有了可复现的端到端证据，且这类"只影响用户能否完成操作"的缺陷从此可被自动发现。代价：演练是手动的，不进 CI，因此不会在每次提交时自动拦截。
- 正面：白名单状态读链而非读索引，判断不会因索引落后而错误地阻止投票。
- 已知边界：演练覆盖的是**投票**这一条写入路径。`refund`、`endVoting`、`setWhitelist` 三个写入动作仍只有合约测试与类型检查覆盖，没有浏览器端演练。
- 已知边界：演练注入的是**模拟 provider**，它与真实钱包（MetaMask）在账户切换、链切换、拒绝签名等交互上存在差异；这些路径未被覆盖。

## Compatibility Boundary

无接口或数据格式变更。`Ballot.tsx` 新增一次 `isWhitelisted` 读调用（在地址已知时启用），"我的状态"面板新增一行。两者都不影响 `/api/**` 的响应结构。

## Retirement Impact

若 wagmi 未来修复被禁用查询的 `isPending` 语义，第 1 条的字面写法可以简化，但**"进行态不得由被禁用的查询推导"这一原则仍然成立**，不应随之删除。若合约改为不公开 `isWhitelisted`（例如为隐私而改为仅事件），第 2 条必须重新设计，届时索引将成为唯一判据，并需同时解决"用落后数据阻止合法交易"的问题。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-3（前端）原本只登记了"类型检查、生产构建、SSR 与 API 实测"，并明确写明未做浏览器端交互验证；本次变更补上了该面，漂移表已补记一行。

## Evidence References

- web/src/components/Ballot.tsx
- web/scripts/ui-drill.ts
- docs/screenshots/ui-vote-confirmed.png
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
