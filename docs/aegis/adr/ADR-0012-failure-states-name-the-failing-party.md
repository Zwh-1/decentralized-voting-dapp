# ADR-0012 - 失败状态必须指出失败的是谁，且不得用单一计数合并不同成因

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测（真实公网，本机）：`dweb.link/ipfs/` → HTTP **000**；`ipfs.io/ipfs/` → HTTP **000**；`gateway.pinata.cloud/ipfs/` → HTTP **200**，正文 `hello world`，`content-type: text/plain`。
- 实测（直接调用真实 `fetchCandidateMetadata`，CID 为真实存在的 `QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o`，其内容为纯文本而非元数据）：修改前 `{"status":"unreachable","attempts":3}`，耗时 12,591 ms；修改后 `{"status":"no-metadata","attempts":3,"answered":1}`。
- 实测（格式非法的 CID `bafyseededcandidate0`）：`{"status":"invalid-cid"}`，耗时 **0 ms**，未发出任何请求。
- 代码事实（修复前）：`fetchCandidateMetadata` 只有一个 `attempts` 计数，"没联系上"、"非 2xx"、"2xx 但正文不是元数据"三者都走 `continue`，最终一律返回 `unreachable`；`CandidateCard.tsx` 据此渲染 **"N 个网关均不可达"**。因此对上述真实 CID，UI 会声称三个网关都不可达，而其中 pinata 刚刚回了 200。
- 代码事实（修复前）：`isPlausibleCid` 用 `/^bafy[a-z2-7]{55}$/` 判定 CIDv1，而 CIDv1 base32 的第 2–4 位编码 codec（dag-pb/dag-json 为 `bafy`，**raw 为 `bafk`**），故合法的 `bafk…` 被拒，UI 渲染为 **"CID 格式无效，无法解析"**。
- 覆盖事实（修复前）：`web/src/lib/ipfs.ts` 无任何测试文件；且播种数据的 CID 会被 `isPlausibleCid` 在发请求前拒绝，因此回退循环、超时与 `unreachable` 三条路径从未执行过——测试里没有，对着真实网关也没有。
- 新增 `web/test/ipfs.test.ts` 15 个用例，含"不得把可达网关报成不可达"与"只统计真正作答的网关"。

## Context

本项目的 UI 反复出现过同一类缺陷，且每次都很具体：

| 轮次 | 症状                               | 真实原因                                           |
| ---- | ---------------------------------- | -------------------------------------------------- |
| 早期 | 投票按钮永远显示"提交中…"          | `receipt.isPending` 对被禁用的 TanStack 查询恒为真 |
| 早期 | 退款按钮静默禁用，不给理由         | 未区分四种禁用成因                                 |
| 早期 | 索引从区块 0 开始扫描              | 部署记录里 `blockNumber` 被写入方之一抹掉          |
| 本轮 | 页面称"服务端无法读取**链上**数据" | 数据库不可达；链是好的                             |
| 本轮 | 页面称"**3 个网关均不可达**"       | 其中 pinata 返回了 HTTP 200，只是正文不是元数据    |

共同点不是"某个判断写错了"，而是**失败被压缩成了一个布尔或一个计数，而渲染出来的那句话比证据更强**。`attempts` 是一个计数，它无法区分"没联系上"与"联系上了但内容不对"；一旦用它来生成句子，句子就必然在某一类情况下是假的。ADR-0009 已经为"进行态"和"资格判断"确立过原则；本条把它推广到**失败状态本身**。

## Decision

1. **每一个失败状态都命名失败的那一方。** 宁可多一个状态，也不要一个可以指向多个成因的名字。`MetadataResult` 因此是：

   ```ts
   | { status: "ok"; metadata }
   | { status: "invalid-cid" }                    // 本地判定，未发出请求
   | { status: "unreachable"; attempts }          // 一个网关都没联系上
   | { status: "no-metadata"; attempts; answered } // 联系上了，但没给出可用元数据
   ```

2. **区分"有没有作答"与"试了几次"。** `attempts` 是尝试数，`answered` 是真正返回响应的网关数。二者分开计数，才可能判断到底是网络问题还是内容问题。`unreachable` 当且仅当 `answered === 0`。

3. **面向用户的文案必须与状态一一对应。** 每种 `status` 渲染一句不同的话；不得让两种成因共用一句话。UI 因此分成"N 个网关均不可达"与"网关可访问（x/y 个已作答），但没有返回可用的候选人元数据"。

4. **本地校验只拒绝确实不可能解析的输入，并且拒绝时不得发出请求。** `isPlausibleCid` 接受 CIDv0（`Qm` + 44 base58）与任意 codec 的 CIDv1 base32（`b` + 58 个 base32 字符，共 59）。不锁死 codec 前缀，因为把合法但少见的 CID 说成"格式无效"是对用户数据的错误指控。拒绝必须发生在任何网络请求之前——实测 0 ms，这是可测的。

5. **不可达是正常状态，不是异常。** 三种失败状态都由 UI 显式渲染，不抛出。

## Alternatives Considered

- **保持单一 `unreachable` + `attempts`，只改文案为"未能获取元数据"。** 句子不再为假，但用户无法判断该重试（网络）还是该换 CID（内容），而这两件事的处置完全不同。放弃精确性换取的只是少一个联合成员。
- **为每种成因各加一个布尔字段（`timedOut`、`notFound`、`badBody`）。** 表达力更强，但把状态机的判断推给了调用方，且组合数迅速膨胀。当前只需要区分"谁失败了"这一个维度。
- **把 `bafy` 与 `bafk` 并列写成白名单。** 仍然是白名单，下一个合法 codec 出现时同样的错会再犯一次。按 multibase 前缀 + 长度判定才是这个"廉价合理性检查"真正想表达的东西。
- **不做本地校验，直接请求三个网关。** 非法 CID 会换来三次必然的 4xx，实测中该路径 0 ms 完成对比 12–14 s 的网关轮询；而且浏览器控制台会出现三条无意义的错误请求。
- **把 `ipfs.ts` 的测试写成需要真实网关的集成测试。** 会引入网络依赖与 flaky。真实网关只用于一次性实测取证（见 Source Evidence），提交的测试全部 stub `fetch`。
- **为了让 `ok` 分支也有真实覆盖，往链上放一个真实 CID。** 需要一个带密钥的 pinning 服务，当前没有凭证。因此如实登记为未验证边界，而不是用 stub 冒充。

## Consequences

- 正面：UI 不再把可达的网关报成不可达；实测中该场景真实发生过（pinata 200 + 非元数据正文）。
- 正面：`bafk…` 形式的合法 CIDv1 不再被误报为"格式无效"。
- 正面：`ipfs.ts` 从零测试变为 15 个用例，覆盖回退顺序、非 2xx、网络异常、正文非元数据、全部耗尽、两种耗尽状态的区分、字段白名单与 abort signal。
- 正面：非法 CID 的 0 ms 短路被测试钉住，避免将来"顺手去掉本地校验"把三次 4xx 带回来。
- 代价：`MetadataResult` 新增成员 `no-metadata`，属破坏性类型变更。仓库内唯一消费者是同一应用的 `CandidateCard.tsx`，已同步。
- 代价：`fetchCandidateMetadata` 多维护一个计数。这是让"失败的是谁"可判定的最小代价。
- **未消解的边界**：`ok` 分支从未在真实网关上发生过。播种 CID 为伪造，仓库内无任何真实 CID 指向真实的候选人元数据 JSON。该分支只有 stub 覆盖，已在 README 与规格校正 14 中写明，不计入已验证。

## Compatibility Boundary

`MetadataResult` 增加 `no-metadata` 成员，且 `unreachable` 的**含义收窄**（此前只要没有可用元数据就返回它，现在仅当没有任何网关作答时）。任何依赖"`unreachable` 表示没拿到元数据"的消费者需要同时处理 `no-metadata`。仓库内唯一消费者为 `web/src/components/CandidateCard.tsx`。`isPlausibleCid` 的接受集合**扩大**（新增 `bafk…` 等非 `bafy` 的 CIDv1），拒绝集合相应缩小；此前被误拒的合法 CID 现在会真正发起请求。这些都不是对外发布的包。

## Retirement Impact

若将来接入自有 pinning 服务并固定全部元数据，第 2 条（分开计数）仍应保留——网关依然可能限流，区分网络与内容问题的价值不因此消失。若改用单一可信网关，`unreachable` 与 `no-metadata` 的区分反而更重要，因为唯一的网关失败时必须立刻知道是哪一种。第 3 条（文案与状态一一对应）在任何网关策略下都成立。第 4 条若因 CID 形式演进（例如出现新的 multibase 前缀）必须重审，重审时仍应遵循"只拒绝确实不可能解析的输入"，而不是逐个列出已知前缀。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-3 只登记了"类型检查、生产构建、SSR 与 API 实测"与浏览器端写入路径演练，从未覆盖 IPFS 元数据层；"多网关轮询"这一承诺既无测试也无实测。漂移表已补记一行，并显式登记 `ok` 分支仍未验证这一边界。

## Evidence References

- web/src/lib/ipfs.ts
- web/src/components/CandidateCard.tsx
- web/src/hooks/useCandidateMetadata.ts
- web/test/ipfs.test.ts
- README.md
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md
- docs/aegis/adr/ADR-0009-ui-eligibility-from-chain-not-query-status.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
