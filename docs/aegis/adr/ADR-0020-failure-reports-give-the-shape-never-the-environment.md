# ADR-0020 - 失败报告只给形状，不回显配置；原始错误只写服务端日志

Status: `recorded-from-work`
Date: `2026-09-21`

## Source Evidence

- 实测（`web/.env` 指向 Sepolia，页面上的 `立即同步索引`，上游端点短暂无响应）：页面渲染出
  `同步失败：The request took too long to respond. URL: https://ethereum-sepolia-rpc.publicnode.com/?apiKey=WP46… Request body: {"method":"eth_blockNumber"} Details: The request timed out. Version: viem@2.56.8`
  一行里同时包含了**服务端 RPC 端点**、它的 **apiKey**、请求体与库版本。任何能打开页面的人点一下这个按钮就能读到它们。
- 代码事实：同一个 `error.message` 出现在**五条** Route Handler 的 `message` 字段（`candidates` / `results` / `voters` / `index/sync` / `health`）、`/api/health` 的 `indexError`、以及服务端渲染进页面的失败横幅（`page.tsx` 的 `describe`）。它们全都是未认证的。
- 实测（同一实例的服务端日志）：`sync iteration failed; retrying { err: '…URL: https://…?apiKey=WP46…', backoff: 4000, consecutiveFailures: 1 }`——也就是说，这份文本**本来就**在服务端日志里，浏览器那一份只是重复，而且是有害的重复。
- 实测（本机对该端点的直接测量）：`eth_blockNumber` 连续三次分别 1.72s / 0.40s / 0.41s 返回，即超时是间歇性的。索引循环会自动重试（`backoff 4s → 8s`，恢复后 `indexError` 回到 `null`），因此这不是"索引坏了"，而是"索引把自己为什么卡住的全部环境细节公布到了浏览器上"。
- 代码事实（分类的可靠性边界）：mysql2 的连接失败是 `Error("connect ECONNREFUSED 127.0.0.1:3306")` 加上 `code`/`errno`/`syscall`/`port`，而同一句话去掉这些字段后就与 RPC 的拒绝无法区分。仅凭文本 `ECONNREFUSED` 分类会**指错依赖**（把 MySQL 说成 RPC），因此分类必须以驱动自身留下的标记为准。
- 实测（修复后，一次性实例：`RPC_URL=http://127.0.0.1:8599`、`DATABASE_URL` 指向死端口、`INDEXER_ENABLED=false`）：`POST /api/index/sync` → 503 `{"error":"sync_failed","message":"RPC 端点无响应（eth_blockNumber 调用）：请求超时或连接失败。请检查 web/.env 里的 RPC_URL 是否可达，或换一个端点；完整错误见服务端日志。"}`；`/api/candidates` 与 `/api/results` → 503 且指名 `eth_call`；`/api/health` → `indexError` 为数据库那一句。页面 HTML 中 `apiKey`、`WP46…`、`viem@` **均不存在**；同一实例的服务端日志里三者的完整错误（含 URL、请求体、堆栈）都在。

## Context

ADR-0012 定下"失败状态必须指出失败的是谁"，ADR-0016 定下"报告只给形状，绝不回显值"。本轮先修的是渲染层（校正 22 / ADR-0019）：让同步按钮**报告**结果。它当即报出了一个真实的上游故障——也就是这条 ADR 的证据来源。修好"不再沉默"之后，暴露出来的下一层问题正是 ADR-0016 已经回答过的那种：**报告里带了值**。

这里被带出去的值不是私钥，而是一段带 apiKey 的 RPC URL。它有两个特点让这件事不能算"无关紧要"：其一，它出现在**页面**上（服务端渲染的横幅与按钮文案），任何访客都能看到；其二，它是本项目唯一一处把服务端配置送进浏览器的路径——`CHAIN_ID`、`VOTING_ADDRESS`、`DATABASE_URL` 都被刻意留在服务端（ADR-0019 的整段论证就建立在这条边界上），只有错误文案绕过了它。

同时要保住的是**可诊断性**：校正 13 确立"挂掉的索引不会被悄悄吞掉"，`/api/health` 的 `indexError` 是运维唯一的窗口；把它换成一句空话会是反向的倒退。因此需要的不是"少说"，而是"说该说的那部分给该看的人"。

## Decision

1. **新增纯函数 `failure.ts: describeFailure(error)`**，所有失败文案的唯一来源。它返回一句**分类后的中文**：指名失败的依赖，并指名配置它的环境变量（`RPC_URL` / `DATABASE_URL`），绝不包含端点、apiKey、请求体或库版本。
2. **分类依据驱动自身的标记，而不是错误文本。** 顺序是：viem 的 `walk()`（只有 viem 的 `BaseError` 有）→ MySQL 的 `sqlMessage`/`sqlState`/`ER_*`/`errno` → 无歧义的文本线索（`took too long`、`fetch failed`…）→ 原样透传。`ECONNREFUSED` **被刻意排除在文本线索之外**：数据库与 RPC 的拒绝写法完全相同，靠它分类会把 MySQL 的故障指向 `RPC_URL`。
3. **文本线索**只保留那些不可能来自另一侧的措辞（超时、`fetch failed`、`HTTP request failed`、`socket hang up`、限流）。
4. **本项目自己写的错误原样透传。** `config.ts` 的报错是有意为之的（指名变量、不回显值），替换成"未预期的失败"会抹掉运维唯一的线索。
5. **`/api/*` 的 `message`、`/api/health` 的 `indexError`、SSR 横幅全部改用 `describeFailure`**，并在各自 catch 处 `console.error` 原始错误；`recordIndexFailure` 只在分类结果**变化**时记录一次（索引是被持续轮询的，否则每次失败都会刷屏）。
6. **一次兜底：** 透传分支会抹掉形如 URL 与 `apiKey=…` 的片段。这样"响应里不出现端点"这条性质不依赖于"分类是否恰好正确"。

## Alternatives Considered

- **照旧返回原始 `error.message`，只在页面里截断。** 截断后的开头恰好就是 `URL: https://…?apiKey=…`，泄的还是同一串；而且截断会让运维拿到一个断掉的错误。
- **完全不返回错误内容（统一 `"internal error"`）。** 满足"不泄露"，但把 ADR-0012 与 ADR-0011 的可见性一起丢掉：运维在 `/api/health` 上再也看不出是数据库还是链。
- **把 `DATABASE_URL` / `RPC_URL` 从错误文本里正则删掉，其余原样返回。** 依赖"错误文本的形状"这一假设，且会把 viem 的堆栈与库版本发给浏览器——那不是给读者看的东西，且每次升级都会变。分类过的句子稳定得多。
- **把原始错误放在响应里、但只对管理员可见。** 本项目**没有**认证层（`/api/*` 全部未认证，这是刻意的），引入一个"管理员"概念只为一条错误文案，代价远大于收益。
- **只修页面与同步按钮，保留 `/api/*` 的原始 message。** `/api/*` 是浏览器会去 fetch 的（`/api/health` 就在页面的轮询里），把端点留在那里等于没修。
- **按 `ECONNREFUSED` 之类的文本直接判定依赖。** 见上：它会把两类拒绝混为一谈，而分错的代价是让运维去查一个健康的组件。

## Consequences

- 正面：端点的 apiKey 不再随页面、SSR 横幅或任何 `/api/*` 响应离开服务端；实测三者中均不含 `apiKey` / `WP46…` / `viem@`。
- 正面：文案变成一句可执行的中文，且指名了该改哪个变量；`eth_blockNumber` / `eth_call` 这类"哪个调用失败"也被保留。
- 正面：失败仍然可见（ADR-0012 / ADR-0011 的可见性未被牺牲），原始错误（含堆栈、URL、请求体）完整落在服务端日志里，一次故障模式记录一次。
- 代价：`indexError` 的值变了——它现在是一句分类文案，运维若想看到原始错误必须看服务端日志（本机与容器日志都是标准去向）。已有 3 条断言依赖旧的原始文本，已按新契约更新。
- 代价：文本线索删掉 `ECONNREFUSED` 之后，一个**不带驱动标记**的裸 `Error("connect ECONNREFUSED …")` 会原样透传（并抹掉 URL），即显示为一句未分类的英文。这是刻意的取舍：宁可少分类，不可分错类。
- 代价：`describeFailure` 是唯一入口，新增依赖时需要新的分类分支，否则会落到"未预期的失败"。
- 测试：web 单测 146 → **157**（新增 `failure.test.ts` 11 例，用 viem 自己的 `TimeoutError`/`HttpRequestError` 构造夹具；`data.test.ts` 的数据库假对象补上 mysql2 真实会带的 `code`/`errno`/`syscall`），全项目 215 → **226**。

## Compatibility Boundary

`/api/*` 的**形状**不变（仍然是 `{ error, message }`，HTTP 状态码不变，`error` 代码不变）。**可观察的变化**是 `message` 与 `/api/health` 的 `indexError` 的内容：由驱动原文改为分类后的中文句子，且不再包含端点、apiKey、请求体或库版本。这一变化对任何依赖具体错误文本的调用方都是破坏性的，因此在此写明：本项目内部无此类调用方，测试与文档已同步。

## Retirement Impact

第 1、5 条（唯一入口 + 全部出口）必须保留：只要有一条路径直接返回 `error.message`，这条边界就重新打开，而它不会以故障的形式表现出来。第 2 条（按驱动标记分类）在更换数据库或链客户端后需要复核：新驱动若不带 `errno`/`sqlMessage`/`walk`，会落到透传或误分类，届时应补分支而不是放宽文本线索。第 3 条的排除项（`ECONNREFUSED`）不要因为"想多认几种错误"而加回来。第 6 条兜底在任何重构下都应保留：它让"响应里没有端点"这条性质不依赖于分类的正确性。若将来 `/api/*` 引入认证与角色，第 5 条可以放宽为"对管理员附原始错误"，但面向匿名访客的那一份必须保持现状。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §5.2 只要求"后端不持私钥"，§4.3 的 M-6e/M-6g 行要求"没有假提交状态"与"读取失败不得渲染成具体值"，均未涉及"失败文案里可以出现什么"。这是一条此前未被登记为被验证对象的性质，漂移表补记一行即可，既有条目无需改写。

## Evidence References

- web/src/lib/failure.ts（新增）、web/test/failure.test.ts（新增）
- web/src/app/api/health/route.ts、candidates/route.ts、results/route.ts、voters/[address]/route.ts、index/sync/route.ts
- web/src/app/page.tsx、web/src/lib/data.ts（`recordIndexFailure`）、web/test/data.test.ts
- docs/aegis/adr/ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md
- docs/aegis/adr/ADR-0016-deploy-preflight-checks-usability-and-never-echoes-a-value.md
- docs/aegis/adr/ADR-0019-the-browser-reads-the-chain-the-deployment-is-configured-for.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
