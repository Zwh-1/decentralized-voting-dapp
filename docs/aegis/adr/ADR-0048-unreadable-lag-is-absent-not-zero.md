# ADR-0048 - 新暴露面（/api/metrics 的契约）与告警层沿用 ADR-0015：不可读的滞后量是 absent 而不是 0

Status: `recorded-from-plan`
Date: `2026-09-22`

## Source Evidence

- `web/src/lib/metrics.ts`（计划 Task 2.1）：`renderMetrics` 中 `const lag = integer(health.lagBlocks);` 后 `...family("voting_index_lag_blocks", ..., lag === null ? [] : [lag])`；`family()` 在 `values.length === 0` 时返回 `[]`，因此连 `# HELP` / `# TYPE` 都不出现
- `web/src/lib/metrics.ts` 的 `integer()`：`/api/health` 把区块高度与滞后量都类型化为字符串，任何不是非负安全整数的值都被判为不可回答，从而走缺席分支，而不是被强制转换
- 实测（计划 §14.5，本地链 31337 区块 1662，`DATABASE_URL` 指向不可达端口）：`/api/health` 返回 `lagBlocks: null`、`indexConfigured: true`；同一时刻 `/api/metrics` 中 **`voting_index_lag_blocks` 整条缺席（连 HELP/TYPE 都没有）**，`voting_index_last_block` 同样缺席，而 `voting_index_configured 1` 仍在，`voting_index_errors_total` 由 0 变为 **1**，`voting_chain_head_block 1662` 与 `voting_poll_count 2` 仍在
- 实测（计划 §14.5 负向对照）：把 `metrics.ts` 的 null 分支改成输出 0 之后，**恰好 2 个守护测试变红**（22 通过 / 2 失败），两条分别是「不能回答时必须缺席」与「非整数时必须缺席」
- 实测（计划 §14.5，正常路径）：本地链上 `/api/metrics` HTTP 200、`content-type: text/plain; version=0.0.4; charset=utf-8`、10 条序列格式完整，`voting_index_lag_blocks 0` 是**真实测得的 0**，与「不可读」在输出上完全不同
- `ops/prometheus/rules/voting.yml` 第 44–57 行：`- alert: VotingIndexLagUnknown`，`expr: absent(voting_index_lag_blocks) and on() (voting_index_configured == 1)`，`for: 10m`，`severity: critical`；注释写明「an absent series satisfies no comparison, so without this rule the outage would produce no alert at all」
- ADR-0015（决策第 2 条与 Alternatives）：`lagBlocks` 在链读不到、`indexConfigured === false`、`cursorKnown === false` 三种情形上报 `null`，并已明确否掉「无索引时上报 0」——理由是「没有索引」与「索引完全跟上了」用同一个数字表示是更坏的混淆
- 边界：`promtool check config/rules` 本机未跑（无 `promtool`），`ops/prometheus/check-rules.py` 不解析 PromQL；该规则**从未在真实 Prometheus 里触发过**；`/api/metrics` 在 `getHealth()` 抛异常时返回 503 的分支只有代码审查、**未实测**（计划 §14.5 末尾）

## Context

本 ADR 的范围**必须**先说清楚，否则它会与 ADR-0015 争同一个决策面。

ADR-0015 已经拥有「`lagBlocks` 不可读时不给数字」这个决策：它决定了 `/api/health` 的字段语义，并且已经在 Alternatives 里否掉了「导出 0」，理由是那会把「没有索引」和「索引完全跟上」混成同一个数字。本轮**没有**产生新的决策：不可读就是不可读，这一点没有变。

变的是**读者**。ADR-0015 的读者是页面与 `/api/health` 的调用方；本阶段新增了 `/api/metrics` 这个给机器读的暴露面，于是同一条规则需要在一个新的地方被表达，并且带出一个 ADR-0015 不需要处理的后果：

**在 Prometheus 里，缺席的序列不满足任何比较。**`voting_index_lag_blocks > 25` 这类规则在序列缺失时**静默失效**，所以「索引整个挂掉」这件事在只写比较规则的情况下反而不会报警。这是 ADR-0015 的页面读者不会遇到的失败模式——页面上 `null` 会渲染成 `—`，读者看得见；而在告警系统里，缺席与正常在规则求值上是同一件事。

## Decision

**一、本 ADR 的范围限定在「新的暴露面（`/api/metrics` 的契约）与告警层」。**

它是 ADR-0015 那条决策在新暴露面上的**延伸**，不是新决策，也**不是第二个所有者**。`lagBlocks` 何时为 `null` 由 ADR-0015 定义；本 ADR 只决定当它已经是 `null` 时，指标层输出什么、告警层如何察觉。

**二、`/api/metrics` 在 `lagBlocks` 不可读时整条省略 `voting_index_lag_blocks`，包括 `# HELP` 与 `# TYPE`。**

只省略样本行而留下 HELP/TYPE 会让抓取方看到一个有元数据、无样本的家族，而 `absent()` 匹配的是序列，注释行不构成序列——因此那种写法既不能表达「缺席」，又会让人以为这条指标存在。`family()` 因此在没有样本时返回空数组。

**三、非整数同样走缺席，不走强制转换。**

`/api/health` 把高度与滞后量类型化为字符串。一个不是非负安全整数的值被丢弃会产生缺席序列，因而触发告警；被强制转换则会产生一个错数字或一个静默的 0。两者之中只有一个会在告警里现身。

**四、配一条独立的 `absent()` 规则，因为比较规则看不见缺席。**

`VotingIndexLagUnknown` = `absent(voting_index_lag_blocks) and on() (voting_index_configured == 1)`，`for: 10m`。

`and on() (voting_index_configured == 1)` 这一半是必要的：在一个**按设计**就没有索引的部署上，序列缺失是正确状态而不是告警状态。`for: 10m` 那一半把「一次抓取短暂失败」与「这个部署真的失去了对自己索引的视野」区分开。

**五、这条规则检测的是「读不出来」，不是「落后」。**

「落后」由 `voting_index_lag_high` 那一类比较规则负责，两者互补：一条在数字太大时开火，一条在根本没有数字时开火。规格 §13.1 第 7 项要求两者**分别**被触发，因为只测其中一个无法证明二者被区分。

## Alternatives Considered

- **导出 0**（规格 §12 登记的被否方案）。会把「没有索引 / 读不出来」与「索引完全跟上」变成同一个数字，而这正是 ADR-0015 已经论证过的更坏混淆。在监控语境下它更坏一层：`0` 是所有读数里最令人安心的一种，因此一次数据库宕机会在 Grafana 上表现为「索引状态完美」，并且不触发任何告警。
- **导出 `-1` 或 `NaN` 之类的哨兵值**。哨兵值会被比较规则参与运算：`-1 > 25` 为假，于是同样静默；`NaN` 在 PromQL 中会污染整条表达式的求值结果，把一个缺失读数扩散成一条不可信的曲线。两者都只是把「缺席」伪装成数字。
- **只省略样本行，保留 `# HELP` / `# TYPE`**。`absent()` 匹配序列而不匹配注释，因此告警**仍然不会触发**，而输出看起来像是「这条指标存在、只是暂时没有值」。这是最危险的一种修法：它让人以为覆盖了。
- **在 `renderMetrics` 里把不可读渲染成一个专门的 `voting_index_lag_unknown` 指标**。会制造第二个「滞后量是多少」的所有者：一条曲线说未知，另一条说 0（因为上游把 null 转成了 0），而两者会各自演进。缺席加上一条 `absent()` 规则已经完整表达了这件事，不需要新序列。
- **只写比较规则，靠 `for:` 的时长间接覆盖。** 比较规则在序列缺失时求值为空，`for:` 永远不开始计时，因此「索引整个挂掉」不会产生任何告警。规格 §9.3 把这条明确称为「本设计要防的那个失败模式」。
- **把 `absent()` 规则写成无条件触发（去掉 `and on() (voting_index_configured == 1)`）。**会在每个按设计无索引的部署上永久开火，而人对长期误报的正常反应是不再相信告警——这会把一条正确的规则变成一条被忽略的规则。

## Consequences

- 正面：`voting_index_lag_blocks` 的缺席与「真实的 0」在输出上完全不同。实测两端都有证据：正常链上是 `voting_index_lag_blocks 0`，不可达数据库时是整条缺失且 `voting_index_configured 1` 仍在。
- 正面：这组证据同时支撑了 `absent()` 规则的触发前提——`voting_index_configured == 1` 与缺席的 lag 同时出现，正是该规则 `and on()` 那一半所依赖的条件，因此它不再是纸面推演。
- 正面：守护这条语义的测试被证明**会失败**：把 null 分支改成输出 0，恰好 2 个测试变红。一个不能失败的测试不是证据。
- 代价：读者必须同时看 `voting_index_configured` 与 `voting_index_lag_blocks` 才能判断缺席是否值得关心；只看一条曲线会把「按设计没有索引」误读成故障。这一成本由 `and on()` 那一半在规则层消掉，但在看板上仍然存在。
- 代价：`voting_index_lag_blocks` 缺席时，Grafana 上是断点而不是一条线。这是刻意的——断点表达「没有读数」，一条平线表达「读数是这个值」，而后者是错的。
- **未实测**：`promtool check config/rules` 未跑（本机无 `promtool`），因此规则表达式的合法性只有自写校验器的间接支持；该规则**从未在真实 Prometheus 里被触发过**（`--profile observability up -d --wait` 未跑过，告警邮件未投递过）；`/api/metrics` 在 `getHealth()` 抛异常时返回 503 的分支**只有代码审查**，没有实测。规格 §13.1 第 7 项要求的两条规则分别被触发，本阶段**未执行**。

## Compatibility Boundary

`/api/health` 的字段集合、HTTP 状态码与 `lagBlocks` 的取值规则**一个字未改**，因此 ADR-0015 的兼容边界原样成立。本 ADR 新增的只有 `/api/metrics` 这一暴露面与一条告警规则。`/api/metrics` 是可被机器读取的新契约，其可观察行为是：滞后量不可读时该序列不出现，而 `voting_index_configured` 仍出现；`getHealth()` 抛异常时返回 503 与空 body，让抓取本身成为存活信号。任何只读 `/api/health` 的调用方不受影响。

## Retirement Impact

若 `/api/metrics` 将来被拆成多个端点，`voting_index_lag_blocks` 的缺席语义必须跟着走，不能在其中之一上退化成 0——本 ADR 与 ADR-0015 要一起迁移。若 `lagBlocks` 换成足以承载「不适用 / 未知 / 具体值」三态的显式类型（ADR-0015 的 Retirement Impact 已经预告了这一方向），本 ADR 的第二、三条应改为从该类型的显式成员渲染缺席，而不是继续从 `null` 推断。若引入多实例部署，`voting_index_errors_total` 的口径（单进程近似、重启归零，规格 §9.4）必须先改，否则 `absent()` 规则会与计数器口径一起变得不可解释。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: ADR-0015 的基线同步记的是「基线 §4.3 与 §14 均未把 `lagBlocks` 在无索引/不可达时的语义列为被验证对象」，并已补记一行漂移。本轮新增的是同一语义在 Prometheus 上的表达与一条 `absent()` 规则，以及新暴露面的契约本身，这些都是既有基线中不存在的事实，因此新基线快照应登记它们，并同时登记「规则从未真正触发过」这一未验证边界。

## Evidence References

- web/src/lib/metrics.ts
- web/src/app/api/metrics/route.ts
- web/test/metrics.test.ts
- ops/prometheus/rules/voting.yml
- docs/aegis/adr/ADR-0015-lag-is-null-when-there-is-no-index-to-be-behind.md
- docs/aegis/adr/ADR-0011-both-kinds-of-missing-index-fall-back-to-the-chain.md
- docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md
- docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
