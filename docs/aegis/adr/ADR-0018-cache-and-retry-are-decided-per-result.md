# ADR-0018 - 缓存与重试按结果区分，而不是按查询区分

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 代码事实（修复前）：`useCandidateMetadata` 用 `staleTime: Number.POSITIVE_INFINITY`，注释写的是"元数据是内容寻址的，成功的结果永不改变"。但 `fetchCandidateMetadata` **从不 reject**——它把每一种失败都 resolve 成 `MetadataResult` 的一个成员。于是"内容寻址所以永久缓存"这个论证被施加到了**失败**上。
- 实测（本机对公共网关）：`ipfs.io` 与 `dweb.link` 的 443 端口均不可达（TCP 连接失败），`gateway.pinata.cloud` 可达；而模块自己的注释记录了开发期间两个网关返回过 HTTP 429。也就是说"下一次尝试可能不同"是这类失败的常态。
- 代码事实：`CandidateCard` 的 IPFS 状态行只有文字，**没有任何重试入口**。`staleTime: Infinity` 之下，挂载/窗口聚焦/网络重连都不会触发重新获取，因此一次瞬时失败的结论会保留到整页刷新为止，用户看到的是"网关可访问（1/3 个已作答），但没有返回可用的候选人元数据"——一句关于**候选人数据**的陈述，而实际原因是网络。
- 实测（`pnpm ui:drill`，注入 provider，种子 CID 全部为 `bafyseededcandidateN`）：15/15 断言通过，`ipfsRetries=[false,false,false]`、控制台 0 条消息。仅读演练的 13 条断言之外新增了 2 条：不能改变的结论不得提供重试；提供重试的只能是网络造成的失败。
- 实测（一次性 CDP 探针，把文档里的占位 CID 替换为合规形状的 `bafy` + 55×`a`）：**该替换未能改变客户端实际使用的 CID**（标签仍为 `CID 格式无效，无法解析`），因此瞬态分支的重试按钮**仍只在单测中验证过**，未在浏览器中渲染过。
- 实测（同一探针，无注入 provider）：25 秒内 **16 条 error 级日志**，全部与 IPFS 无关——页面每约 4 秒轮询一次 `http://127.0.0.1:8545/`，被 Chrome 以 `Permission was denied for this request to access the 'loopback' address space` 拒绝（无头模式下该权限被直接拒绝，不弹窗）。这暴露了第 12 轮那条控制台断言的真实覆盖范围：它在**注入 provider** 的配置下成立，因为此时 wagmi 不会回退到 HTTP transport。

## Context

第 12 轮给浏览器演练加了"控制台不得有 error/warning"的断言，并当场抓到了 `/api/results` 的误报 500（ADR-0017）。那条断言的价值已经被证明，但它的**措辞**声称的比它验证的多：它写的是"页面没有抛异常、没有记录 info 以上的日志"，而实际测的是"在演练注入了 provider 的配置下"。无注入 provider 时页面会去轮询 RPC 端点，日志里会持续出现错误——不是应用逻辑错了，而是 wagmi 的 transport 回退到了浏览器不必然能访问的地址。一个声称过多、实际过少的断言，和一条会误报的断言一样会误导读者，只是方向相反。

本轮的起点则是同一类问题在另一处的表现：一句正确的论证（内容寻址的结果不会变）被写在了错误的**作用域**上（所有结果）。TanStack Query 把 `fetchCandidateMetadata` 的失败当作成功的数据处理——这不是缺陷，而是这个模块"不用异常表达可预期的失败"这一设计的直接结果（ADR-0012）。既然失败是数据，缓存策略就必须按数据区分。

还缺一个用户可见的部分：即使缓存策略修好了，恢复仍然依赖窗口聚焦或重连这类被动触发。读者被告知"没有返回可用的候选人元数据"之后，桌面端唯一能做的事就是刷新页面。

## Decision

1. **新增纯函数 `isRetryableMetadata(result)`**，用穷尽的 `switch` + `never` 判定"再试一次是否可能得到不同答案"。`invalid-cid` 是**本地**结论（CID 的形状是字符串自身的性质），因此**不可重试**且**可永久缓存**；`unreachable` 与 `no-metadata` 是网络给的结论，因此可重试。新增 `MetadataResult` 成员而不做这个决定会让构建失败。
2. **新增纯函数 `metadataStaleTime(result)`**，从 `isRetryableMetadata` 派生：未取到结果 → `0`；瞬态失败 → 30 秒；其余（`ok` 与 `invalid-cid`）→ `Infinity`。两个函数只有一个分类来源，因此不会漂移。
3. **`useCandidateMetadata` 改为函数形式的 `staleTime`**（`(query) => metadataStaleTime(query.state.data)`）。已确认安装的 `@tanstack/query-core@5.103.1` 支持 `StaleTimeFunction`，因此这条不依赖任何类型断言。
4. **卡片为可重试的失败提供"重试"按钮**（`metadata.refetch()`），并以 `data-metadata-retry` 作为演练断言用的钩子，使断言不依赖按钮措辞（`重试` / `重试中…`）。
5. **重试按钮是 `<dd>` 的兄弟节点而非子节点。** 演练断言读的是 `<dd>` 的文本作为卡片"陈述的结论"；把按钮放进去会让按钮文案混进那句话，从而使既有断言随按钮状态变化。
6. **控制台断言的措辞改为它真正验证的配置**："with the injected wallet, the page raised no exception and logged nothing above info level"。

## Alternatives Considered

- **把 `staleTime` 一律设成一个较小的有限值。** 会让成功的、内容寻址的结果在每次窗口聚焦时被重新抓取，而它的内容由 CID 唯一确定——用请求换不到任何新信息，还会放大公共网关的限流。
- **在 `fetchCandidateMetadata` 里对失败 `throw`，让 TanStack 的 `retry` 去处理。** 会把"可预期的失败"变成异常，与 ADR-0012 的整个设计相悖，也会让 `metadataLabel` 的三态分支失去数据来源。
- **只用窗口聚焦/重连做恢复，不加按钮。** 恢复路径存在但不可见；读者被告知候选人没有元数据，界面上没有任何东西表明这个结论会过期。
- **对 `invalid-cid` 也提供重试。** 它的结论由 `isPlausibleCid` 在发请求之前得出，重试确定性地得到同一答案，属于用界面暗示一个不存在的可能性。
- **让 `invalid-cid` 也可过期。** 与上一条同源：这不是网络失败，过期只会把一个确定结论变成反复计算的结论。
- **把控制台断言放宽到"只测第一方请求"。** 是更大的改动，且会削弱它已经证明过的能力（抓到 `/api/results` 的 500）。当前的问题是**措辞**声称过多，改措辞即可，断言本身不动。
- **在本轮同时修 wagmi 的 transport 回退。** 记录为**已实测、未处置**的发现（见下），因为它需要先确定对无钱包访客的正确行为，而那是产品决定，不是本轮修复的延伸。

## Consequences

- 正面：一次被限流的网关不再把结论钉死在整个会话上；30 秒后窗口聚焦或重连即可自愈。
- 正面：确认内容寻址的结论（`ok`）仍然永不重新抓取——这条论证被保留，只是回到了它成立的作用域。
- 正面：本地结论（`invalid-cid`）既不被重试也不被过期，界面不会暗示一个不存在的可能性。
- 正面：读者现在有一个显式入口（`重试`），而不是只能刷新页面。
- 正面：控制台断言现在声明了它成立的条件；读者不会把它当成"任何配置下浏览器都干净"。
- 代价：瞬态失败在 30 秒内仍会被复用，因此自愈不是瞬时的。
- 代价：卡片多了一个按钮与一个属性；断言依赖 `data-metadata-retry` 这个名字。
- 索引器单测 100 → **106**，全项目 164 → **170**；演练断言 13/17/19 → **15/19/21**（三场景各 +2）。
- **已实测、未处置**：无注入 provider 的页面对 RPC 端点每约 4 秒轮询一次，在无头 Chrome 中每次产生 2 条 error 日志（本机 `RPC_URL=127.0.0.1:8545`，Chrome 拒绝 loopback 访问且不弹窗）。对部署到公共 RPC 的实例不出现；对本地演示则会弹权限请求。正确行为（无钱包时是否应该轮询）是产品决定，留待下一轮。

## Compatibility Boundary

对外契约不变：`/api/*` 的响应形状、合约交互、以及 `MetadataResult` 的成员集合均未改动；`fetchCandidateMetadata` 仍然从不 reject。**可观察的行为变化**：瞬态失败会在 30 秒后过期，且这类失败的卡片上出现一个"重试"按钮；`ok` 与 `invalid-cid` 的行为与修复前完全一致（永不重新抓取，且不提供重试）。

## Retirement Impact

若将来把元数据改为服务端抓取并缓存，第 1、2 条应决定服务端缓存的 TTL 划分，第 4 条可退化为一次服务端重试；但"本地结论与网络结论区别对待"这一划分必须保留。若引入 pinning 服务使 `ok` 可被验证，第 1 条中 `no-metadata` 的可重试性需要重新审视——固定的内容不再会因为网关限流而"稍后可用"，届时它与 `ok` 一样不该重试。第 5 条在任何卡片重构下都应保留：把操作控件嵌进被断言的文本节点里，会让措辞断言随控件状态漂移。第 6 条是断言措辞的纪律，不得为了"看起来更强"而改回通用表述。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §6.4 与 §14 校正 12 登记的是 `ipfs.ts` 的四种结果与卡片措辞（ADR-0012），从未把"缓存与重试策略"或"控制台断言的作用域"列为被验证对象；§4.3 的 M-6e 行只要求"没有假提交状态"。因此没有既有条目需要改写，漂移表补记一行即可。

## Evidence References

- web/src/lib/ipfs.ts
- web/src/hooks/useCandidateMetadata.ts
- web/src/components/CandidateCard.tsx
- web/test/ipfs.test.ts
- web/scripts/ui-drill.ts
- docs/aegis/adr/ADR-0012-metadata-failure-modes-are-named-not-collapsed.md
- docs/aegis/adr/ADR-0017-the-consistency-check-compares-one-instant.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
