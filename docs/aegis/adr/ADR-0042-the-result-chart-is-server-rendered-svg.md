# ADR-0042 - 结果图表是服务端画出来的 SVG，且"零票"不是"一条平线"

Status: `accepted`
Date: `2026-09-22`
Amends: `docs/aegis/adr/ADR-0011-missing-index-data-falls-back-to-chain.md`（"读不到"与"是空的"必须分开，同样适用于图表）

## Source Evidence

- `web/src/components/ResultChart.tsx`：`chartGeometry()`、`chartAriaLabel()`、`chartHeight()`、`chartViewBox()`、`NO_VOTES_MESSAGE`
- `web/src/components/PollBallot.tsx`：派生**一个** `tally`（`source: "chain"`），只在 `tally !== undefined` 时渲染图表
- `web/src/lib/ballot-labels.ts`：`tallySourceLabel(source)`
- `web/test/result-chart.test.ts`
- `web/scripts/ui-drill.ts`：`chartFound` / `chartBarCount`，断言条形数等于选项数
- 现状依据：改动前计票只能读数字，读者要自己在脑子里比大小

## Context

要做"结果图表可视化"，第一反应是装一个图表库。但本项目的读者面对的是一个**可能读不到数据**的界面：链不可达、索引没配、RPC 限流都会发生。通用图表库的默认行为是"数据是空的就画一个空坐标系"——那正好是最坏的表现，因为**"零票"和"读不到"会画出同一张图**。

第二个约束是这张图要放在一个 **Server Component** 里（投票详情页是服务端渲染的），而多数图表库是客户端组件。为了画一个条形图而把整块内容推到客户端，会让首屏多一次数据往返。

第三个约束是无障碍：一个 `<svg>` 里的 `<rect>` 对读屏软件什么也不是。

## Decision

**一、手写 SVG，不引图表库。**

一张横向条形图是：每个选项一条 `<rect>` 加一个标签。它的几何是**可测的纯函数**（`chartGeometry`），可以脱离 DOM 断言"票数多的那条更长、总宽度不超过画布、零票的条宽度恰好是 0"。引一个库会把这些变成"库的内部行为"，同时为一张条形图带来一个会在升级时变动的依赖树。

服务端渲染的 SVG 也不需要 JavaScript 才能显示——这对一个"钱包可能没装"的页面是真实的好处。

**二、零票产出 `{ kind: "no-votes" }`，是一句明确的文案，不是一条零长度的线。**

`NO_VOTES_MESSAGE` 存在的理由就是 ADR-0011：`0` 是**一个确定的事实**（票数统计成功，结果是零），必须和一整块空白区分开。空白读者会读成"坏了"。所以零票时输出的是"还没有人投票"这句话，并且**不画条形**。

**三、`<svg role="img">` 带一个用真实结果拼出来的 `aria-label`。**

`chartAriaLabel()` 读的是同一份计票数据，输出的是"选项 1：3 票；选项 2：0 票"这样的句子。读屏用户因此拿到的是**结果**，而不是"图形"这个事实。也就是说无障碍不是补一句"结果图表"，而是把图表**本来要传达的信息**用另一种形式给出来。

**四、图表只在 `tally !== undefined` 时渲染。**

`PollBallot` 先派生**一个** `tally` 对象，图表、票数合计、来源标签全部读它。读不到计票时**不渲染图表**，而不是渲染一张空图。这样"读不到"在界面上表现为**没有图表**——一个可以被诚实描述的缺失——而不是一张看起来像"零票"的图。

**五、选项标签目前是 `选项 #<id>`，这是一个已知的降级。**

投票的候选元数据由 `useCandidateMetadata` 提供，那是一个客户端 hook，Server Component 用不了。所以服务端渲染的图表只能标出选项编号。这是**有意的取舍**：宁可让图表显示编号，也不要为了拿到名字把整页推到客户端。读者在同一个页面的选票卡片上能看到名字，编号与卡片一一对应。

## Consequences

- `ui-drill` 断言 `chartBarCount === optionActionCount`，并且**只在图表存在时**断言。这个比较的方向是关键：一个悄悄漏掉某个选项的图表仍然会渲染，而且渲染成一张**更短但完全合理**的条形图。拿"这里写死的期望数量"去比抓不到它，只有拿选票自己渲染出的选项数去比才能。
- 字体大小是**估算值**，不是实测值。实现这条的 subagent 无法运行 `ui:drill`（需要同时跑起 Next 服务、Playwright 和本地 Hardhat 部署），因此没有肉眼确认过图表的实际外观。这是一个真实的验证缺口，不是"已验证"。
- 图表依赖的计票来源在图上以 `data-chart-source` 标出，与 `tallySourceLabel` 用同一份来源词汇（"链上直读" / "MySQL 索引"），所以图上的数字和卡片上的数字不会各说各的来源。
