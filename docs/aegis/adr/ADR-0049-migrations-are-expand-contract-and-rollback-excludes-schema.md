# ADR-0049 - schema 迁移采用 expand-contract，回滚不含 schema

Status: `recorded-from-plan`
Date: `2026-09-22`

## Source Evidence

- `ops/runbook/migrations.md`（计划 Task 4.6）：允许新增表 / 新增可空或有默认值的列 / 新增索引 / 新增视图；禁止在同一次发布里删除或重命名旧版本仍在读写的列、表、视图，或给既有列加 `NOT NULL` 而无默认值；破坏性变更拆两次发布（第 N 次 expand 并回填、第 N+1 次 contract）；并明确「回滚 = 回滚镜像，不回滚 schema」
- `CONTRIBUTING.md` 第 14 行第 6 条不变量：「schema 迁移必须向后兼容」，并指向 `ops/runbook/migrations.md`；第 16 行的说明写明它「**不是新增的独立约束，而是第 3 条在发布维度的延伸**」——第 3 条说事件与游标不能分开提交，第 6 条说新旧两版不能争抢同一份 schema，理由相同：**共享状态的两方不能被同时停机**
- `ops/deploy/rollback.sh`：全文没有 `run --rm migrate`；第 144 行向部署日志追加 `rollback note: schema NOT rolled back (expand-contract; see ops/runbook/migrations.md)`；第 150 行**每次运行**都打印 `NOTE: the database schema was NOT rolled back, by design.`
- `ops/deploy/rollback.sh` 第 23–38 行的文件头注释写明否掉可逆迁移的理由：「Rolling the schema backwards would also destroy whatever the version being abandoned had already written, turning a bad release into data loss」
- 实测（计划 §14.6）：`ops/deploy/selftest.sh` 断言回滚路径**未调用 `run --rm migrate`**，且输出明说 schema 未回滚；该断言随本批从 41 项扩到 80 项
- 实测（计划 §14.11）：`ops/deploy/selftest.sh` **80 项全过**；`ops/deploy/selftest-controls.py` **6 项全过**，其中「把 migrate 挪到起槽之后」这组注入故障被 **7 条断言**抓住
- `docker-compose.yml` 第 10–15 行：明确没有 `docker-entrypoint-initdb.d` 挂载、没有 seed `.sql`，schema 只有一个所有者 `web/src/lib/db/schema.ts`
- 边界：`migrate` 从未在容器里真正跑过（Docker 引擎不可用），两次发布法**从未被真正执行过一次**

## Context

规格 §10.3 把「与 schema 迁移的相互作用」称为本阶段最容易忽略的约束。双槽发布期间新旧两版**同时连一个 MySQL**：旧槽还在服务，新槽已经启动并正在接受健康检查。因此每一次迁移都必须让旧版本继续可用。

这条约束的失败形态特别隐蔽，值得逐字记下（`ops/runbook/migrations.md` 第 26–30 行）：一个破坏旧版本的迁移**不会在部署时报错**。新槽通过它自己的健康检查（它自己的查询是好的），流量切过去，然后那个**空闲的**槽——仍然在运行、仍然是回滚目标——开始在每个请求上报错。故障只在有人尝试回滚时才浮现，而那是最糟糕的发现时机。

把这件事写进 ADR 的另一个理由在 `CONTRIBUTING.md` 第 16 行：它不是一条新原则，而是既有的第 3 条不变量（事件与游标同事务）在发布维度上的延伸。两者存在的原因完全相同——**共享状态的两方不能被同时停机**，差别只在时间尺度：一个是一个事务，一个是一个发布窗口。

## Decision

**一、schema 迁移采用 expand-contract，破坏性变更拆成两次发布。**

第 N 次（expand）加新结构并回填，同时保留旧结构，新旧两版都能工作；第 N+1 次（contract）在确认无旧版本运行之后才删除旧结构。代价是多一次发布。

**二、回滚只回滚镜像，不回滚 schema。**

`rollback.sh` 把流量切回上一槽，**不碰数据库**。理由不是省略，是决定：迁移本来就是向后兼容的，所以上一版能在当前 schema 上运行；而反向执行迁移会**毁掉被放弃那一版已经写入的数据**，把一次坏发布变成数据丢失。

**三、把这条边界说出口，而不是留给读者推断。**

`rollback.sh` **每次运行**都打印 schema 未回滚的说明，不只是看起来不对的时候。下一个读这份日志的人常常正在排查「回滚完成了，但应用表现得像新版本」——答案就是 schema 从未被反向执行。

**四、发布前用一行命令判断本次是否动了 schema。**

`git log --oneline <上一个 tag>..<本 tag> -- web/src/lib/db/schema.ts`。输出非空即表示本次动了 schema。这是一行、成本为零、能防住这个设计里最伤人的那个错误，因此它属于发布清单而不是记忆。

**五、若某次迁移不向后兼容，该次发布不可回滚，只能前滚修复。**

`rollback.sh` **无法**替你检测这个条件，这一点在 runbook 与脚本注释里都写明了。把「不可回滚」说成一个已知状态，比假装回滚总能成功要好。

## Alternatives Considered

- **可逆迁移（写 down 迁移，回滚时反向执行）**（规格 §12 登记的被否方案）。在双槽并存下不可行：反向执行会毁掉被放弃那一版已经写入的数据——旧槽在它服务的那段时间里写进新结构的行，会随着 down 迁移一起消失。于是回滚把一次坏发布升级成数据丢失，而数据丢失是不可回滚的。
- **回滚时同时回滚 schema，并接受数据丢失**。等于承认「回滚」是一个会丢数据的操作，那么事故中正确的选择就变成了「不回滚、带病前滚」，而脚本提供的却是一个更危险的动作。把危险动作从工具里去掉，比在文档里警告它更可靠。
- **停掉旧槽再迁移，消除双版本并存窗口**。会摧毁本阶段的核心主张：旧槽是秒级回滚的目标，停掉它就把回滚从「改配置」退化成「冷启动」。规格 §10.2 与 ADR-0051 都依赖旧槽常驻。
- **把 `rollback.sh` 写成能自动检测「本次迁移是否向后兼容」**。做不到：「向后兼容」是关于旧版本查询行为的断言，脚本能读到的只有 schema diff，而 diff 无法回答旧版本的查询是否会失败。假装能检测会制造一个看起来有覆盖的假保证。
- **让 `rollback.sh` 在 schema 曾变更时直接拒绝回滚**。会把「不兼容的迁移不可回滚」这条真实约束错误地施加到所有兼容迁移上，而兼容迁移的回滚是本设计里最安全的操作。

## Consequences

- 正面：回滚是一个不会丢数据的动作，因此事故中可以直接执行它，不需要先判断「这次回滚会不会毁掉数据」。
- 正面：迁移在旧版本仍在服务时执行（`deploy.sh` 第 100–109 行），因此一次失败的迁移**代价为零**——什么都没动。
- 正面：这条约束是**可被机械判定**的一部分：回滚路径从不调用 migrate 这一点已进 `selftest.sh` 的 80 项断言；而「migrate 必须早于起槽」这一点由 `selftest-controls.py` 的注入故障证明它**会**被抓到（7 条断言）。
- 代价：破坏性变更需要两次发布，多一个发布窗口。runbook 直接承认这一点：「The cost is one extra release. The alternative is a release that cannot be rolled back, which is a much larger cost paid on a day nobody chooses.」
- 代价：一次不兼容的迁移会让该次发布永久不可回滚。这是已知且被写明的状态，不是遗漏；缓解手段只有发布前那一行 `git log` 检查与人工确认。
- **未实测**：`migrate` 从未在容器里真正执行过（Docker 引擎不可用），因此「连续执行两次仍然成功」（规格 §13.1 第 8 项）与「两次发布法」本身**都没有被执行过**。本 ADR 的实测证据全部来自桩化自测与负向对照，不是真实的数据库迁移。

## Compatibility Boundary

不改变现有 schema、不改变任何既有迁移的语义、不改变 `/api/*` 的契约。本 ADR 是对**未来** schema 变更的约束，因此它带来的可观察变化为零；它改变的是「下一次改 schema 时允许做什么」。对既有部署的唯一影响是：`rollback.sh` 的输出多两行说明 schema 未回滚——这是刻意的，因为它要解释的正是「回滚后应用行为像新版本」这种误判。

## Retirement Impact

若将来不再使用双槽（例如改为原地发布或迁到支持滚动更新的编排平台），「迁移必须向后兼容」这条约束的**理由**会改变：双版本并存窗口消失后，破坏性变更可以在一次发布里完成。但第二条（回滚不回滚 schema）**不应**随之退役——它防的是数据丢失，而不是并存窗口；只要回滚仍然可能发生在一次已经写入数据的发布之后，反向执行就仍然会毁掉那些数据。若将来引入真正的 schema 版本化工具（能表达 down 迁移且能判定兼容性），第五条关于「脚本无法检测」的说明需要重新核对，而不是直接删除。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: 既有基线（2026-09-20 与 2026-09-21 两份）登记的是 schema 的单一所有者与索引的幂等性，没有任何条目描述「迁移在发布维度上的约束」与「回滚的边界」。`CONTRIBUTING.md` 第 6 条不变量是本次新增的硬约束，新基线快照必须登记它，并同时登记「两次发布法从未被执行过」这一未验证边界。

## Evidence References

- ops/runbook/migrations.md
- ops/runbook/deploy.md
- ops/deploy/rollback.sh
- ops/deploy/deploy.sh
- ops/deploy/selftest.sh
- ops/deploy/selftest-controls.py
- CONTRIBUTING.md
- docker-compose.yml
- docs/aegis/adr/ADR-0006-two-layers-and-optional-mysql.md
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
