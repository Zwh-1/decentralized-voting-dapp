# ADR-0011 - 索引的两种缺失走同一条回退路径，且不得用默认值代替"未知"

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测（`DATABASE_URL` 指向死端口 3399，链正常）：五条路由**全部 503**——`/api/health`、`/api/candidates`、`/api/results`、`/api/voters/<addr>`、`POST /api/index/sync`，响应体均为 `{"error":"upstream_unavailable","message":"connect ECONNREFUSED 127.0.0.1:3399"}`。
- 实测（同一状态）：页面返回 **HTTP 200** 且渲染出 **"服务端无法读取链上数据： connect ECONNREFUSED 127.0.0.1:3399"**。同一时刻 `chainHead` 可读、`/api/candidates` 若走链回退可得到正确的 67/67/66。
- 实测（修复后，同一状态）：`/api/health` → 200 `{"status":"degraded","chainHead":"406","indexError":"connect ECONNREFUSED 127.0.0.1:3399"}`；`/api/candidates` → 200 `{"source":"chain","total":200,...}`；`/api/results` → 200 `{"status":"unavailable","indexedTotal":null,"onChainTotal":200,...}`；`/api/voters` → 200 `{"source":"chain","whitelisted":true,"hasVoted":true,"votedFor":3,"voteTxHash":null}`；页面不再出现该句。
- 实测（无 `DATABASE_URL`，修复前与修复后一致）：`/api/candidates` `source: "chain"`；`/api/results` `status: "unavailable"`、`indexedTotal: null`；`POST /api/index/sync` → 200 `{"enabled":false,"reason":"DATABASE_URL is not set; the index is disabled."}`。
- 实测（索引正常，修复前与修复后一致）：`/api/results` `status: "consistent"`、`onChainTotal: 200`、`indexedTotal: 200`、`discrepancies: []`、`lastIndexedBlock: "406"`；`/api/voters` `source: "index"` 且带 `voteTxHash`。
- 实测：修复前 `/api/voters` 在无索引状态下 `whitelisted` 恒为 `null`；修复后为链上真值（已投票账户 `true`，非白名单账户 `false`）。
- 代码事实：`requirePool()` 的报错文案是 `"The index is not configured; this read must fall back to the chain."`，而它唯一一处调用位于 `state.pool === null` 的早返回**之后**，因此永不抛出——即"必须回退到链"这句声明所在的分支恰恰不回退。
- 代码事实：`getVoter()` 的 `catch` 以 `{ hasVoted: false, votedFor: 0, stakeWei: 0n }` 兜底，因此链不可达时该接口会声称所有地址都未投票。
- 新增 `web/test/data.test.ts` 9 个用例，其中一条专门断言链不可达时 `getVoter` 必须 reject 而非返回 `hasVoted: false`。

## Context

`data.ts` 是整个服务端唯一决定"答案来自链还是索引"的地方，而它只有一个判据：`state.pool === null`。这使"索引缺失"的两种情形被区别对待：

| 情形                | `pool` | 原行为                      |
| ------------------- | ------ | --------------------------- |
| 未设 `DATABASE_URL` | `null` | 回退读链，`source: "chain"` |
| 设了但数据库读不到  | 非空   | 抛出 → 路由 503             |

第一种是设计意图，第二种是疏漏。它的代价不是"少了一个优化"，而是**在链完全健康时让应用说链读不到**：`page.tsx` 把 `getTally`/`getResults`/`getHealth` 包在一次 `Promise.all` 里，任一失败即三者俱失，`catch` 里那句"服务端无法读取链上数据"于是成了对故障原因的错误归因。这正是 ADR-0009 处理过的同一类问题——UI 不得对失败原因说谎——只是这次说谎的是服务端到页面的这条路径。

同一模块里还有第二处同族问题：`getVoter` 用默认值兜底链读失败。合约测试与项目文档都强调"链是 `hasVoted`/`votedFor`/押金的唯一事实源"（ADR-0001），而默认值把"问不到"渲染成了"没投票"——一个自信的错误答案，比一个 503 更有害。

## Decision

1. **索引的两种缺失归入同一条回退路径。** 新增 `withIndex(state, readFromIndex, readFromChain)`：`pool` 为空直接走链；`pool` 非空但读失败则记录原因并同样走链。`ready()`（首次应用的 schema）失败也记录而不抛出，否则每个读都会在进入判断前就炸掉。
2. **回退不是静默的。** 每次成功读清除记录、每次失败写入 `state.indexError`，由 `/api/health` 以 `indexError` 报出并把 `status` 置为 `degraded`。故障必须可见，否则"容错"就退化成"掩盖"。
3. **凡是没有比对过，就不得宣称比对结论。** `getResults()` 索引侧失败时返回 `status: "unavailable"`、`indexedTotal: null`、`indexed: null`，与"未配置"完全相同。它**先**读链并让链失败向上抛：这个接口的意义就是两侧比对，缺了链侧的数字就无从作答，500/503 是诚实的回复。
4. **不用默认值代替"未知"。** `getVoter()` 删除那个以 `hasVoted: false` 兜底的 `catch`，链读失败向上抛（路由转为 503）。`source` 字段继续说明实际由哪一侧作答，客户端无需猜测。
5. **白名单判断一律读链。** `readOnChainVoter` 增加 `isWhitelisted`（合约已公开该 getter），`whitelisted` 在两种模式下都取自链。索引侧不再参与这个字段：`whitelist_events` 的历史仍留在库里，但"当前是否在名单内"由映射本身回答，且**按构造不可能因索引落后而出错**——这正是 ADR-0009 对 UI 采用的同一推理。
6. **删除死代码。** `requirePool`（见上）与无人调用的 `getPhase` / `readOnChainPhase`（服务端的 phase 读取；UI 通过 wagmi 直读合约，没有任何路由需要它）。

## Alternatives Considered

- **让索引不可达时一律 503，只在文档里写清。** 这是修复前的行为，且模块注释确实只承诺"未设置时回退"。但它把一次数据库宕机升级成"应用无法回答链能回答的问题"，并让页面对读者误报原因。文档与代码一致并不足以让一个错误归因变成正确。
- **只改 `page.tsx` 的文案，把"链上数据"改成"数据"。** 能消除那句假话，但五条路由仍然 503，链上回退路径依然够不到。治标。
- **给索引不可达加熔断，短期内不再尝试连接。** 能省掉每次读的一次失败连接，但会把一次瞬时抖动变成进程生命周期内的持续降级。当前策略是每次都尝试、失败即记录，简单且可自愈。
- **把 `hasVoted` 改为 `boolean | null` 以表达"未知"。** 语义上更精确，但会让一个消费面很窄的接口发生破坏性类型变更，而"链不可达"本身就该是错误状态而非数据状态。选择让失败向上抛。
- **让 `/api/health` 在索引不可达时返回 503。** 会与既有的 `status: "degraded"`（链不可达时返回 200）约定不一致，且会让编排系统把"链上功能完好、仅缺索引"判为实例不健康。维持在体内用 `status` 与 `indexError` 表达。
- **把 `whitelist_events` 的最新一行与链上 getter 都保留、取二者的并集或最新。** 增加一个"哪个更新"的判断，而映射 getter 按定义就是当前值，不存在比它更新的链下记录。

## Consequences

- 正面：一次 MySQL 宕机不再使 `/api/candidates`、`/api/voters`、`/api/results` 失去链上答案；页面不再对故障原因说谎；`/api/health` 让这次宕机仍然可见且可定位到具体子系统。
- 正面：`/api/voters` 现在**任何**配置下都能回答"这个地址是否在白名单"，不再依赖索引存在。
- 正面：一致性结论的语义变紧——`consistent` 只在真的比过之后出现；`unavailable` 明确表示"没有可比较的索引"，无论原因是没配还是挂了。
- 已知边界：`POST /api/index/sync` 在索引不可达时仍返回 503。这是有意的：它是**写**入索引的入口，没有数据库就无从写起，回退没有意义。它与四条读接口的区别已在 README 的三种状态实测表中写明。
- 代价：索引挂掉时，每个读都会先付一次失败的连接尝试。连接被拒通常立即返回，且这是可自愈策略的代价；若将来需要，可在 `indexError` 基础上再加退避。
- 代价：`HealthResponse` 新增必填字段 `indexError`，属破坏性类型变更。仓库内唯一的消费者是同一个 `web/` 应用，已同步更新。
- 新增 9 个单测（`web/test/data.test.ts`）钉住以上行为，其中"链不可达必须抛出"一条直接针对被删除的那个兜底 `catch`。索引器单测 57 → 66，总数 106 → 115。

## Compatibility Boundary

`/api/candidates`、`/api/results`、`/api/voters/[address]`、`POST /api/index/sync` 的响应**结构**不变（`ResultsResponse.status` 的取值集合不变，`unavailable` 本就存在）。实际变化有三处：索引不可达时这四条不再返回 503 而是返回链上答案；`/api/voters` 的 `whitelisted` 在两种模式下都取自链（此前无索引时为 `null`）；`/api/health` 新增必填字段 `indexError`，且索引不可达时不再返回 503 而是 200 + `status: "degraded"`。

`web/src/lib/chain.ts` 的 `OnChainVoter` 新增必填字段 `isWhitelisted`，`readOnChainPhase` 被移除。`web/src/lib/data.ts` 移除 `getPhase`（无调用方）。这些都不是对外发布的包，仓库外无消费者。

## Retirement Impact

若将来索引成为必需依赖（例如为了规模而放弃链上直读），第 1、3 条需重新设计——届时"没有索引"将是一种故障而非一种配置，`unavailable` 也应改为错误状态。若合约不再公开 `isWhitelisted`（例如为隐私改为仅事件），第 5 条必须重做，且需同时解决"用可能落后的链下数据判断资格"的问题。若 `HealthResponse` 的增加字段被外部监控大量依赖，`indexError` 的字符串格式应视为契约而非调试信息。第 4 条（不得用默认值代替未知）在任何架构下都成立，不应随重构删除。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-6 与 M-7 只登记了"类型检查、生产构建、SSR 与 API 实测"，而 API 实测此前仅覆盖 `/api/results` 与 `/api/health`，其余三条路由从未执行；"索引可选"这一承诺也只在"未配置"这一种状态下被验证过。漂移表已补记一行。

## Evidence References

- web/src/lib/data.ts
- web/src/lib/chain.ts
- web/src/lib/types.ts
- web/src/app/api/candidates/route.ts
- web/src/app/api/voters/[address]/route.ts
- web/src/app/api/results/route.ts
- web/src/app/api/health/route.ts
- web/src/app/api/index/sync/route.ts
- web/src/app/page.tsx
- web/test/data.test.ts
- README.md
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
