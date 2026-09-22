# ADR-0041 - 通知是推导出来的，订阅只是水位线，而且它不是授权

Status: `accepted`
Date: `2026-09-22`
Amends: `docs/aegis/adr/ADR-0023-current-vote-is-a-view-not-a-counter.md`（把"不存第二份"从选票计数延伸到通知）

## Source Evidence

- `web/src/lib/db/schema.ts`：`subscriptions` 表（`last_read_block`），**没有** `notifications` 表
- `web/src/lib/notify/index.ts`：`isNewerThan()`、`watermarkFor()`、`summarizeNotifications()`、`parseSubscriptionRequest()`
- `web/src/lib/data.ts`：`indexedHead()`、`subscribe()`、`unsubscribe()`、`listSubscriptions()`、`listNotifications()`、`markNotificationsRead()`
- `web/src/app/api/subscriptions/route.ts`、`web/src/app/api/notifications/route.ts`
- `web/src/app/notifications/page.tsx` + `view.tsx`、`web/src/components/SubscribeButton.tsx`
- `web/src/lib/indexer/event-branches.ts`：审计视图与通知**共用**的六分支事件并集
- `web/test/notify.test.ts`、`web/test/event-branches.test.ts`
- 现状依据：改动前索引器只写事件表，没有任何"谁关心哪个投票"的概念

## Context

任务 13 的字面要求是"索引到新事件时为订阅者生成通知行"。最直接的实现是一张 `notifications` 表：索引器每写一个事件，顺手为每个订阅者插一行。

这条路有三个具体的坏结局，而且都不是理论上的：

1. **第二份事实。** 通知行的内容是"投票 P 在区块 N 发生了 X"。这句话**已经在事件表里了**。两份记录必然漂移，而漂移的表现恰恰是"我看到一条通知，但审计视图里没有这件事"——一个读者无法判断谁对谁错的矛盾。

2. **重放与 reorg。** 本项目有一条既有的 reorg 恢复路径（`reorg-drill`），它按区块区间重放事件。一张通知表意味着**每次重放都必须记得先删掉对应区间的通知行**。这是一步会被忘掉的操作，而忘掉它的表现是重复通知——不一定看得出来的那种损坏。

3. **它不需要存在。** "我订阅的投票里，水位线之上的事件"是一个**查询**。存一份等于把查询结果当成了事实。

## Decision

**一、只存水位线：`subscriptions(address, poll_address, last_read_block)`。**

通知 = 订阅的投票里、`block_number > last_read_block` 的事件。没有 `notifications` 表，没有索引器侧的写入路径，也就没有"重放时要记得清理"这一步。这与 ADR-0023 把 `current_votes` 做成视图而不是计数器是同一条理由。

**二、水位线的初值是索引的当前高度，不是链的当前高度。**

`subscribe()` 取的是 `sync_cursor.last_block`。取链头会造成一种静默丢失：水位线落在**索引还没写出来的事件之上**，那些事件永远不会通知任何人。`indexedHead()` 在索引从未同步过时返回 `null`（而不是 `0`），因为"还没有可用的水位线"和"水位线是 0"是两件不同的事。

**三、"标记已读"只推进到**实际展示过的**高度，绝不推进到链头。**

```ts
watermarkFor(entries, current); // 取 entries 里的最高区块，且永不后退
```

如果读者看到的是到区块 500 的内容，而请求到达时链已经到 520，把水位线推到链头会把 501–520 **静默标记为已读**——它们再也不会出现，而且没有任何东西会说它们被跳过了。代价是：请求期间挖出的那个事件会保持未读状态。这是**可见的**代价（读者下次还看到它），另一个方向是**不可见的**丢失。选前者。

**四、`POST /api/notifications` 的请求体只决定**范围**，不决定**高度**。**

调用方可以指定"只标记某个投票"，但**不能**提交"我被展示了哪些条目"。这是一个安全决定，不是简化：如果高度由调用方提供，任何地址都能把**任何其他地址**的水位线推到任意高度，把从未展示过的事件标记为已读。

服务端自己从索引重新推导一遍。这与 ADR-0009 同源：状态从链（这里是索引）读，不从界面读。

**五、`phase_events` 没有 `voter` 列，因此按地址过滤时**整个分支被排除**。**

不是"丢掉这个条件"——丢掉条件会为一次针对某个地址的过滤返回所有人的阶段事件。这个坑在 `event-branches.ts` 里以 `hasVoter` 标记，并有测试钉住"恰好只有 `phase` 这一支没有 voter"。

**六、审计视图与通知共用一份事件并集的定义。**

两者都是"跨投票读同一个事件流"。各写一份六分支 `UNION ALL` 的结果是：某张表加一列之后两份会漂移，而漂移的表现是"审计里有这笔退款，我的通知里没有"——一个没人会想到去测的差异。

`UNION ALL` **按位置匹配、不按名字**。所以六支的列顺序必须完全一致，否则一个把 `amount_wei` 写在 `allowed` 位置的分支**不会报错**，只会把 wei 金额填进"是否允许"字段。`branchSql()` 用同一个模板生成每一支，使位置差异无法表达；`event-branches.test.ts` 逐支比对别名的位置，这是唯一能在读者看到之前抓住它的办法。

`branchSql` 把"分支自己的条件"和"调用方的条件"**合并进同一个 `WHERE`**。早期版本暴露的是"已经带 `WHERE` 的 FROM，调用方往后追加"，那会产出 `WHERE a WHERE b`（语法错误），并且诱导调用方干脆丢掉分支条件——那会让 `cast` 分支返回所有种类的投票行。

**七、信任模型很弱，因此写在 schema、模块头注释和 ADR 三处。**

`address` 由调用方提供且**未经验证**：本项目没有账号、没有会话。所以任何人都能为任何地址创建订阅，也能查询任何地址的订阅列表。

这仅在**通知内容本身全是公开数据**的前提下可接受——"投票 P 在区块 N 发生了一笔退款"，每一个字都在链上。伪造订阅最多是让某个读者看到一个他没订阅过的投票，是打扰，不是泄露。

由此得出的规则，也是唯一不能被放宽的一条：**订阅是提示，不是授权。** 没有任何东西可以以"持有订阅"为条件放行，也没有任何通知可以携带非公开信息。

## Consequences

- 没有邮件、webhook 或推送。它们需要凭据、一个常驻发送 worker，以及"发送失败怎么办"的运维答案，这三样本项目都没有。一个会静默丢消息的"通知功能"比一个只在站内显示、读者能自己确认收到了什么的功能更糟。
- "未读数"在索引不可用时返回 **404 而不是空列表**。"这个部署读不到"和"你没有新动态"是两件不同的事，把前者说成后者是在断言没读过的东西（ADR-0011）。
- 一次请求读全部未读行、只截断返回的页。读者有 400 条未读而只看到 50 条时，徽标必须显示 400；否则它会读成"你快要追上了"，而事实相反。响应里带 `truncated`，调用方不必靠比较长度去猜。
- 通知排序用 `(block_number, tx_hash)` 两个键，因此是全序。只按区块排序时，同一区块的两个事件可以在两次请求之间互换顺序，读者翻页时会看到一条两次、漏掉一条。
- 与订阅相关的写入没有被端到端验证过：`ui-drill` 没有覆盖订阅按钮，`SubscribeButton` 的浏览器行为目前只有 `notify.test.ts` 对纯函数部分与 `typecheck` 覆盖。
