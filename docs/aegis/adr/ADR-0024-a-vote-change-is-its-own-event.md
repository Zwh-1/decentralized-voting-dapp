# ADR-0024 - 改投与撤票必须发出各自的事件，当前票只能由事件流推导

- 状态：已接受
- 日期：2026-09-21
- 相关：ADR-0001、ADR-0017、ADR-0023

## 背景

用户要求投票人可以**修改**与**删除**自己的投票。`Poll` 因此引入 `changeVote` 与 `withdrawVote`。合约侧的记账很直接：改投递减旧选项、递增新选项；撤票清空槽位并把押金退回。

但链下索引侧出现了一个新的、必须当场决定的问题：**索引如何知道一个地址「现在」投给了谁？**

旧模型里这个问题不存在。`Voting` 用 `hasVoted` 布尔量，一票投出即终局，「这个地址投给了谁」由一个 `VoteCast` 事件永久确定。索引可以简单地 `INSERT` 一条记录，永远不需要回头改。

新模型下，「投过票」不再是终局事实。一个地址可能投 A、改投 B、再撤票。索引如果沿用旧做法，就会把三条记录都当作票，得出 A 与 B 各一票、总数 2 的错误结论。

同时还有一个症状层面的问题：如果改投实现为「发两次 `VoteCast`」，索引将无法判断哪一次是「最后发生的那个动作」——两个事件在语义上完全对称，只有区块高度和 log index 能排序，而这会让「撤票」与「改投」无法区分，索引必须反推意图。

## 决策

**一、`VoteChanged` 必须是独立的事件，而不是两次 `VoteCast`。**

```
event VoteCast(address indexed voter, uint256 indexed optionId, uint256 newCount);
event VoteChanged(address indexed voter, uint256 fromOptionId, uint256 toOptionId);
event VoteWithdrawn(address indexed voter, uint256 amount);
```

三个事件语义互不相同，各自携带足以定位动作的信息。`VoteChanged` 同时给出 `fromOptionId` 与 `toOptionId`：

- 索引不必比较前后计数来推断方向；
- 区块浏览器上的历史可以直接读懂「从 A 改到 B」，而不是两行对称的 `VoteCast`；
- 「最后一次动作是什么」由事件类型直接回答，不必依赖排序后的推断。

**二、`votes` 表是追加式事件流，当前票由视图推导。**

索引的 `votes` 表记录**发生过什么**，字段为 `event_type`（`cast` / `changed` / `withdrawn`），而不是**结果是什么**。当前票由视图 `current_votes` 给出：对每个 `(poll_address, voter)` 取按 `(block_number, log_index)` 排序的最后一条事件，`cast`/`changed` 取其 `option_id`，`withdrawn` 表示当前无票。票数再由 `option_tally` 在 `current_votes` 之上聚合。

## 理由

**关键在于：索引不得自己维护一份「当前票数」的可变计数器。**

最省事的做法是在 `votes` 表旁加一列 `current_option_id`，同步时按事件就地更新。这个做法会立即违反 ADR-0001：链上有 `votedFor`，索引里有 `current_option_id`，两者是**两个各自独立的权威**。它们一旦分歧，系统里没有任何东西能判断谁对——因为索引不再是从链上事件推导出来的投影，而是一个平行的事实源。

以事件流为唯一输入、用视图推导当前状态，使得「索引的当前票」在数学上是「链上事件的一个纯函数」。一致性检查（ADR-0017）因此可以真正比较：链上的 `results()` 与索引的 `option_tally` 算的是同一件事，分歧就是真故障。若索引自己记计数器，分歧只能说明「有一边写错了」，而无法指出是哪一边。

这也解释了为什么 `VoteChanged` 必须独立：视图的推导依赖「最后一次动作的类型」。如果改投伪装成两次 `VoteCast`，`withdrawn` 与「改投到 0 号」在事件层面无法区分，视图就必须依赖「option_id 是否为 0」这类约定，而约定是会在某次重构中被悄悄破坏的东西。

**幂等性不因此受损**：`votes` 表的 `UNIQUE(tx_hash, log_index)` 与 `INSERT IGNORE` 保证重放同一区间不产生重复事件，视图是确定性函数，重放后结果不变。ADR-0017 要求的「游标与事件在同一事务内提交」同样保留。

## 代价

- **查询比读一列贵**：每次读当前票数都要排序取最后一条。在演示规模下无感；规模变大时的正解是物化视图或增量快照，但那必须由**链上事件重算得出**，而不是由同步循环顺手累加——这条界线是本 ADR 的核心，不得为性能而跨越。
- **`withdrawn` 行的 `option_id` 语义**：本实现将其记为 `0`（事件本身只携带 `amount`，不带选项）。视图与一致性检查都必须显式跳过它，不能把「撤票」当成「投给 0 号」。这一条已在 `report.ts` 的待补票计算与视图定义中分别处理，并有专门测试覆盖。
- **撤票后地址回到「未投票」**：`voterState` 的 `currentOptionId` 归 0，与「从未投票」在链上不可区分。二者只能靠历史区分，因此 `VoterResponse` 增加了 `history` 字段，并且不再把 `votedFor: null` 当作「从未投票」的同义词。

## 验证

- `contracts/test/Voting.ts`：断言改投发出的是 `VoteChanged` 而非第二个 `VoteCast`。
- `contracts/contracts/PollProperties.t.sol`：vote/changeVote/withdrawVote 交错 1000 轮后，断言「票数等于当前投票人数」、`sum(voteCount)` 与计数一致、以及全部撤票后票数与托管以太都归零。
- 负向对照（变异测试）：注释掉 `changeVote` 中旧选项的递减后，上述断言如期失败（`9 != 8`、`11 != 1` 等）。证明这些不变式真的会失败，而非恒真。
