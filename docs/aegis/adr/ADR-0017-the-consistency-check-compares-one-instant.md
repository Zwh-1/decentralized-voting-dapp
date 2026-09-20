# ADR-0017 - 一致性检查必须比较同一个瞬间

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测（给浏览器演练新增"控制台不得有 error/warning"这条断言后，`--vote` 场景立刻失败）：`[log/error] network: Failed to load resource: the server responded with a status of 500` — `http://127.0.0.1:3100/api/results`。原有的 16 条 DOM 断言**全部通过**：这正是该盲区存在的理由。
- 实测（受控复现：白名单一笔 + 投票一笔，同时以 15ms 间隔轮询 `/api/results`）：**49 个非 200 响应**，全部是同一份内容：

  ```json
  {
    "status": 500,
    "verdict": "divergent",
    "discrepancies": [{ "candidateId": 1, "onChain": 68, "indexed": 67, "pending": 0 }],
    "onChainTotal": 201,
    "indexedTotal": 200,
    "unindexedBlocks": 0,
    "pendingVotes": 0,
    "lastIndexedBlock": "407"
  }
  ```

  持续约 1.5 秒（缓存期内每个请求都算出同一个错误结论），而非一闪而过。

- 实测（根因一，viem 的 `getBlockNumber` 缓存）：`createPublicClient` 默认客户端挖出新块前后各读一次 `getBlockNumber()` —— **406 → 406（STALE by 1）**；同一时刻 `cacheTime: 0` 的客户端为 **407 → 408（FRESH）**；暂停 4.5 秒（超过默认缓存 4000ms）后默认客户端才追到 408。
- 代码事实（修复前）：`checkConsistency` 依次读取 `readOnChainTally`（`eth_call latest`，永远新鲜）、`readIndexedTally(pool)`、`readCursor(pool)`、`client.getBlockNumber()`（被缓存）。未索引区间由 `cursor` 与 `head` 决定，而 `head` 可能落后于 `results()` 已经反映的高度。
- 实测（根因二的机制，单测钉住）：`indexed` 与 `cursor` 是两条独立语句；若索引器在两者之间提交一批，则那一批里的票**不在** `indexed` 里，又被 `fromBlock = cursor + 1` 排除在待补区间之外——**两侧都不计**。`persistBatch` 把事件与游标写在同一个事务里，因此单个快照内两者必然一致。
- 实测（修复后，同一探针、同一场景）：**0 个非 200 响应**；`--refund` 场景 19/19 断言、控制台 0 条消息；`check-consistency` 仍为 `consistent`、200/200。

## Context

M-6 的核心承诺是"索引与链的偏差为 0/200"，而 `divergent` 是这个承诺唯一的报警信号（HTTP 500、脚本退出码 1）。一个会**误报**的报警器比没有报警器更糟：读到这里的人会学会忽略它，而真正的不一致就藏在那次忽略里。

三处读取各自独立地把健康的索引指认为故障：

1. **`head` 取自被缓存的 `getBlockNumber`。** viem 默认把它缓存 4000ms。于是一笔刚挖出的票：`results()` 看见了（`eth_call` 不缓存），`head` 还停在上一块，`indexed` 也还没索引到它——这笔票落在 `(cursor, head]` **之外**，两侧都不计，报 `divergent`。
2. **`indexed` 与 `cursor` 不在同一快照里。** 两秒一次的索引循环可以在两条语句之间提交；被提交的那批票 `indexed` 没算，而游标已经越过它们，`fromBlock` 把它们排除在待补区间外。
3. **链侧自身也可能不在同一高度。** `results()` 若读 `latest`（高度 R），而日志枚举到高度 H < R，则 H 之后的票会被 `results()` 算进链上总数、却不在待补区间里；反之则会重复计入。

前两者共同解释了观测到的 `unindexedBlocks: 0` 与 `pendingVotes: 0`：检查**以为索引已经追上**，于是那笔票既不在 `indexed` 里，也没有资格被补回来。

这个缺陷能存活至今有一个具体原因：一致性检查此前只在**链安静时**被跑过（CI 的 `indexer-e2e` 是先 `drain` 再比对）。浏览器演练是第一个"一边改链一边比对"的东西，而它此前看不见控制台。

## Decision

1. **`buildChainClient` 以 `cacheTime: 0` 创建客户端。** 这个客户端的全部职责就是回答"链现在是什么"，它读出的每个值都会被拿去与别处比较，因此没有任何一处需要缓存的高度。
2. **`indexed` 与 `cursor` 通过一个连接、一个事务读出**（`readIndexSnapshot`）。MySQL 默认 REPEATABLE READ 在第一次读时固定快照，而 `persistBatch` 本就同事务写入事件与游标，所以一个快照内的两者必然描述同一个已提交状态。两个读取函数改为同时接受 `Pool` 与 `PoolConnection`。
3. **`readOnChainTally` 接受可选的 `blockNumber`**，一致性检查把链上票数与日志枚举**钉在同一个高度**。
4. **读取顺序本身是答案的一部分**，并在代码里写明：先索引快照 → 再读链（因此 `head ≥ cursor`，因为索引器只能消费已经存在的区块）→ 链侧两项都用这一个高度。

## Alternatives Considered

- **只把 `head` 改成 `getBlockNumber({ cacheTime: 0 })`，不动客户端。** 能修掉占主导的那一半，但下一个调用点会重犯；而且"这个客户端的读数不该被缓存"是关于客户端的性质，不是关于某个调用点的性质。每处都要记得传参，等于把不变量交给记忆。
- **把 `indexed` 与 `cursor` 的读取顺序调换（先游标后票数）。** 只是把错误方向反过来：游标若偏旧，已被 `indexed` 计入的票会被重复补回，同样报 `divergent`。快照才是正确的那把工具。
- **读两次游标并取较小者。** 同上：取到旧游标就会把已经计过的票再补一次。
- **给一致性检查加重试，发现 `divergent` 就重算一次。** 会把"偶发误报"变成"偶发但慢的误报"，并且恰好掩盖住导致误报的那个原因。
- **把 `/api/results` 的 500 改成 200 加警告位。** 丢弃了 `divergent` 唯一的强制力：CI 与 `check-consistency` 靠退出码工作。
- **接受该窗口为"可容忍的偶发"。** 这正是本条 ADR 要否定的：一个训练读者忽略自己的报警器，其代价由真正发生不一致的那一天支付。

## Consequences

- 正面：一致性检查现在比较的是**一个瞬间**：索引的快照与链的单一高度，待补区间恰好覆盖两者之间的全部区块。
- 正面：`divergent` 重新成为可信信号——误报已由真实投票场景下的 49 → 0 证明。
- 正面：`cacheTime: 0` 让后台索引循环读到的也是真实链头，而不是最多 4 秒前的值。
- 正面：新增 5 个单测，其中一个专用假 pool 把"索引器在两次读之间提交"这件事建模出来，并同时钉住"分开读就会不一致"这一动机，使未来把两读拆开的重构会在此失败。
- 代价：每次 `getBlockNumber` 都真的打一次 RPC。对本机节点无意义，对公共 Sepolia 端点是一次可忽略的增量——索引循环本来每 2 秒就问一次。
- 代价：多一层 `getConnection`/事务，代价是每 2 秒一次（索引循环）之外的按需开销。
- 索引器单测 95 → **100**，全项目 159 → **164**。

## Compatibility Boundary

对外契约不变：`/api/results` 的字段集合、状态取值与 `divergent → HTTP 500` 的映射均未改动；`check-consistency` 的输出形状与退出码语义不变；`readIndexedTally`/`readCursor` 的签名放宽为接受连接（既有以 `Pool` 调用的位置无需改动）。**可观察的行为变化**：链上有交易落地的同时请求 `/api/results`，不再间歇性返回 500。这是修复本身，也正是被测量的那件事。

## Retirement Impact

若将来一致性检查改为读取多个投影（例如同时比对退款与白名单），第 2 条应扩展到它们，并保持"凡是共同构成一个判断的读取，必须来自同一个快照"这一划分。若引入比 `REPEATABLE READ` 更弱的隔离级别，第 2 条会失效，必须改为显式锁定或改读游标与计数的一次性查询。第 1 条在任何重构下都不得放松：任何"可能被缓存的高度"都会重新打开这个窗口，而它的症状是误报，不是缺报——后者会被发现，前者会被学会忽略。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-6 行登记的是"偏差 0/200 曾在 CI 中验证过"，从未把"检查本身在链正在变化时的行为"列为被验证对象；§6.3 记的是 `/api/results` 的状态取值与 HTTP 映射（ADR-0008），与本条无关。因此没有既有条目需要改写，漂移表补记一行即可。

## Evidence References

- web/src/lib/report.ts
- web/src/lib/chain.ts
- web/src/lib/indexer/sync.ts
- web/test/consistency-snapshot.test.ts
- web/scripts/ui-drill.ts
- docs/aegis/adr/ADR-0008-reconcile-unindexed-range-before-verdict.md
- docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
