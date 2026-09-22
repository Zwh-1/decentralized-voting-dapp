# ADR-0036 - 多端点 RPC 只负责容忍"失败"，"撒谎"归一致性检查

Status: `accepted`
Date: `2026-09-22`
Amends: `docs/aegis/adr/ADR-0016-rpc-endpoints-are-configuration-not-code.md`（把单端点扩展为端点列表）

## Source Evidence

- `web/src/lib/rpc-endpoints.ts`：`resolveRpcEndpoints()`，端点列表合并的唯一 owner
- `web/src/lib/chain.ts`：`buildChainClient(chainId, rpcUrl: string | readonly string[])`，单端点走 `http()`，多端点走 `fallback(..., { rank: false })`
- `web/src/lib/indexer/endpoints.ts`：`createRotatingChainReader()`，轮换与失败计数
- `web/src/lib/failure.ts`：`rpcFailure()`，两个 RPC 分支共用的错误文本
- `web/test/endpoints.test.ts`（12 个测试）、`web/test/rpc-endpoints.test.ts`（10 个测试）
- 现状依据：改动前 `ServerConfig` 只有 `rpcUrl: string`，任何一个端点不可达即整站不可读

## Context

公开 RPC 会限流、会超时、会临时宕机，而"我的投票页面打不开"和"链上没有这个投票"在用户看来是同一件事——这正是 ADR-0011 禁止的谎报形态。因此需要多个端点。

但"多端点"这个需求里藏着一个不显然的分岔：**多个端点可以用来做两件完全不同的事**。

1. **容忍失败**：A 端点连不上，就换 B 端点重试。
2. **容忍撒谎**：A 端点返回了一个陈旧或错误的区块高度，用 B 端点交叉验证。

这两件事的代价和收益差得很远。第 1 件是明确的：连接失败、超时、5xx 都是可判定的，重试不会引入任何新的错误答案。第 2 件需要**多数票**才有意义——两个端点不一致时，没有任何依据判断哪个是对的；而按"取更多数"实现就需要 3 个以上端点，且当多数端点属于同一个运营方时（`infura` 的两个 key）"多数"是假的。

更关键的是第 2 件已经有了 owner：`checkConsistency` 把链上计数与索引计数在**同一瞬间**对比（ADR-0017），它能发现"链上事实被错误地陈述"。再让传输层做一次交叉验证，就会出现两个都说自己负责同一件事的组件，而它们不一致时读者无从判断该信谁。

## Decision

**一、多端点的职责只有一个：端点**失败**时换下一个。端点**撒谎**不在传输层的职责内。**

`createRotatingChainReader` 的文档明确写下这条边界：它降级的是**报错**的端点，不是**答错**的端点。这一句不是免责声明，而是防止后续维护者把交叉验证加进来——一旦加进来，一致性检查就会与传输层争夺同一个结论的所有权。

**二、轮换用"连续失败 N 次"，不用"失败即换"。**

`failuresBeforeRotate = 3`。原因是单次失败几乎总是瞬时的（限流、TCP 重置、一次超时），而每失败一次就换端点会产生两个坏结果：健康的端点因为一次抖动被永久排到队尾，以及日志里充满无法归因的轮换记录。连续失败才说明这个端点真的坏了。

成功会**重置**计数，所以一个"每三次请求失败一次"的端点不会被换掉——它是慢，不是坏。

**三、每次失败都照常抛出，绝不吞掉。**

轮换的语义是"再试一次"，而不是"失败了但没关系"。如果所有端点都失败，调用方必须拿到一个异常，因为**没有读到的数据不等于空数据**。`reader` 无论轮换到哪个端点都 rethrow，这一条有测试钉住。

**四、端点的标识只能是序号，绝不是 URL。**

`activeLabel` 返回的是 `"endpoint 1 of 3"` 这样的**序号**，不是端点地址。理由是 ADR-0016：错误文本里出现端点即泄露配置，而 API key 常常直接嵌在 URL 的用户名或查询串里。"给形状，不给值"在这里的具体形式是：读者能知道"第 2 个端点坏了"，无法知道第 2 个端点是什么。

**五、端点列表的合并规则只有一个 owner。**

`resolveRpcEndpoints(primary, extra)` 是所有调用方的唯一入口：`primary` 在前，`extra` 按逗号拆分，空串丢弃，大小写不敏感去重。它**接收值而不是 `process.env`**——因为 Next.js 只对字面量 `process.env.NEXT_PUBLIC_名字` 做内联替换，把 `process.env` 传进函数会让浏览器端读到 `undefined`。

这条有 10 个测试，其中最重要的是"纯空白的 primary 视为未提供"：不这样处理，`RPC_URL=" "` 会被当成一个合法端点，于是每个请求都去连一个空地址。

**六、0 个端点不是错误配置，而是"使用 viem 默认"。**

`resolveRpcEndpoints` 在什么都没配时返回 `[]`，`buildChainClient` 抛错。但浏览器侧的 `wagmi.ts` 在 `[]` 时走 `http()`（viem 默认端点）——因为浏览器的传输是钱包的 transport，配置缺失时 wallet 的链自会处理。服务端没有这个退路，因此抛错。

两侧行为不同是刻意的，且各自有测试。

## Alternatives Considered

- **用 `fallback` 的 `rank: true`（viem 默认）按延迟排序**：被否决。`rank` 会让端点顺序随网络抖动而变，于是"这次读到了旧高度"变得不可复现——同一个 bug 报两次可能拿到两次不同的端点序列。`rank: false` 让顺序等于配置顺序，可复现。
- **传输层做多数票交叉验证**：被否决。理由见 Context：需要 ≥3 个端点、多数可能属于同一运营方，且与 `checkConsistency` 争夺同一个结论的所有权。
- **失败即轮换**：被否决。一次抖动把健康端点永久排到队尾，且日志不可归因。
- **轮换时吞掉失败、返回旧值**：被否决。这是 ADR-0011 的最坏形式——把"读不到"伪装成"读到了"。
- **把端点 URL 写进 `activeLabel` 方便排查**：被否决。ADR-0016 已定；且 open 的 API key 在 URL 里，写进日志等于写进任何能看到日志的地方。
- **在 `data.ts` 里 per-call 重建 reader**：这是**本次真实写错并被测试抓住**的版本。per-call 重建会**遗忘失败计数**，于是 `failuresBeforeRotate = 3` 永远不会达成——每次调用都是第一次失败。修正为把 `indexerChain` 存进 `ServerState` 单例。

## Consequences

- `ServerConfig.rpcUrl` 保留为 `rpcUrls[0]`，新增 `rpcUrls: readonly string[]`。这是纯增，既有调用点不变。
- `web/.env.example` 新增 `RPC_URLS`、`NEXT_PUBLIC_LOCAL_RPC_URLS`、`NEXT_PUBLIC_SEPOLIA_RPC_URLS`。
- 端点的**配置顺序即优先级**。这是一个运维事实，不是实现细节：把付费端点写在前面就会优先用它。
- 索引同步循环与 API 路由共用同一个 reader 实例，因此失败计数是共享的。**如果一个端点在 API 路由上坏了，同步循环也会绕开它**——这是有意的，同一进程内没有理由对同一个端点得出两种结论。
- 端点的健康状态**不持久化**，进程重启后重新计。持久化会让一个已经恢复的端点长期被跳过，而"跳过健康端点"比"多试一次坏端点"代价更高。

## Baseline Sync

- Target: `docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md` §7（运行与配置）
- Action: `amend`
- Reason: §7 只描述了 `RPC_URL` 单端点。需补上 `RPC_URLS` 与"配置顺序即优先级"，以及"轮换只针对失败"这条边界——否则运维会以为配了多个端点就获得了交叉验证。

- Target: `README.md`「环境变量」
- Action: `append`
- Reason: 多端点是一个用户可见的可靠性开关，且默认值（不配即单端点）意味着不读 README 的人不会知道有这条路。
