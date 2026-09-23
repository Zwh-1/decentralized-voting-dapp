# ADR-0051 - 部署逻辑入库为 ops/deploy/*.sh 脚本，而不是内联进 GitHub Actions YAML

Status: `recorded-from-plan`
Date: `2026-09-22`

## Source Evidence

- `ops/deploy/` 下的脚本（计划 Task 3.3 / 4.3 / 4.4）：`lib.sh`、`deploy.sh`、`rollback.sh`、`health-gate.sh`、`probe-loop.sh`、`publish-version.sh`
- 实测（计划 §14.11 验证表）：`bash -n` 全部 **10 个** shell 脚本，0 失败；`ops/deploy/selftest.sh` **80 项全过**（由本批的 41 项扩到 80 项，新增 39 项）
- 实测（计划 §14.11）：`ops/deploy/selftest-controls.py`（负向对照）**6 项全过**——4 处故意破坏各被抓住，干净树通过：把流量切换提到健康门之前（**2 条**断言抓到）、成功部署后顺手停掉旧槽（**1 条**）、把 migrate 挪到起槽之后（**7 条**）、让健康门失败仍记录成功（**6 条**）
- `ops/runbook/deploy.md`：事故手册直接引用同一批脚本（`./ops/deploy/rollback.sh`、`./ops/deploy/probe-loop.sh`、`cat state/active-slot state/active-tag`），并给出「按失败阶段查表」的处置流程
- `.github/workflows/release.yml` 的 deploy job：先 `rsync` 把 `ops/` 同步到服务器，再通过 SSH 执行 `./ops/deploy/deploy.sh '<version>'`——CI 与人工执行的是同一份代码
- 实测（计划 §14.11，三层「必须能失败」）：桩化自测（80 项）断言顺序性质本身；负向对照证明那 80 项**会失败**；真实网络层用 `health-gate.sh` 与 `probe-loop.sh` 打一个真的 node HTTP 服务器，覆盖成功 / 连接失败 / 404 三条路径
- 实测（计划 §14.11，真实网络）：健康门对真实服务器 200 → 退出 0，死端口 → 退出 1（`status 000`），404 → 退出 1（`status 404`）；`probe-loop.sh` 6 秒打真实服务器得到 `{"total":5,"succeeded":5,"failed":0,"maxConsecutiveFailures":0}` 退出 0，404 时退出 1
- 边界：`nginx -t` 从未真正跑过；`nginx -s reload` 的 graceful 行为未观察；两个槽的容器**从未同时起过**；**零停机的实验组与对照组都未做**；「秒级回滚」这个具体数字未测

## Context

规格 §8.3 把「部署逻辑放进仓库而非内联在 YAML 里」单独列为一节，理由只有一句但很硬：**内联 YAML 里的 shell 无法在本地演练，而「没演练过的部署脚本」等于没有回滚能力。**

这个判断在本阶段的执行记录里得到了具体回报。批四的产物几乎全是「顺序」和「不重启」这类**从外部看不见的性质**——一个把流量切早了的部署，日志上只写着「部署成功」。因此本批的主要工作不是写脚本，而是造出能证明脚本**错**的证据；而这件事只有在逻辑是可执行文件时才做得到：`selftest.sh` 用桩化的 `docker` / `curl` 驱动真实脚本，`selftest-controls.py` 再往真实脚本里注入故障、断言自测会红。

还有第二个理由同样具体：事故中有人要**手动**执行这段逻辑。`ops/runbook/deploy.md` 的写法是「在服务器上跑 `./ops/deploy/rollback.sh`」，如果逻辑内联在 YAML 里，那个人就只能去 Actions 页面点按钮——而故障期间最不该依赖的就是一条你无法在本地复现的链路。

## Decision

**一、部署与回滚的逻辑住在 `ops/deploy/*.sh`，CI 通过 SSH 调用它们，而不是把 shell 内联进 YAML。**

`release.yml` 的 deploy job 做两件事：`rsync` 把 `ops/` 同步到服务器，然后执行 `./ops/deploy/deploy.sh <tag>`。因此「CI 跑的」与「人在事故中跑的」是同一份代码，这正是 runbook 该有的性质。

**二、顺序不可颠倒，且顺序本身要被测试钉住。**

`deploy.sh` 的顺序是：pull → migrate → 起目标槽 → 健康门 → 切流量 → 观察窗 → 记录。前四步都不能影响用户；只有第五步会。`selftest.sh` 的 80 项断言的就是这个顺序。

**三、这些断言必须被证明会失败。**

`selftest-controls.py` 往真实脚本里注入四类故障并断言自测变红。其中「成功部署后停掉旧槽」这一条特别值得留：这个错误会让所有关于 `active-tag`、`active-slot`、日志的断言**继续全绿**，而它恰好摧毁了整个设计的核心主张——回滚从「改配置」退化成「冷启动」。**能通过全部既有断言的错误，只能靠一条专门为它写的断言抓住。**

**四、状态放在服务器上，不放 CI。**

`active-slot` / `active-tag` / `previous-tag` 写在服务器侧的 `state/` 下，是回滚能力的载体。放 CI 会让「哪个槽在服务」变成一个需要联网才能回答的问题。

**五、唯一保留在 YAML 里的是编排：触发器、门、环境审批、密钥安装、并发锁。**

这些是平台能力而不是部署逻辑，本地无法也不应复现。但它们的**不变量**同样由机械检查强制（见 ADR-0050），因此不存在「YAML 里没人管」的部分。

## Alternatives Considered

- **把 shell 内联进 GitHub Actions YAML**（规格 §12 登记的被否方案）。无法在本地演练，因此「回滚能力」只能在上线后第一次需要它时被检验；同时事故中无法手动执行同一段逻辑。
- **内联 YAML，另写一份脚本供人工使用**。两份实现会漂移，而漂移的方向恰好是最危险的那种：演练过的那份（脚本）与真正执行的那份（YAML）行为不同。规格 §8.3 的主张是「CI 与人工操作跑的是同一份代码」，两份实现直接否掉它。
- **把部署逻辑做成一个容器镜像 / 一个 Makefile**。容器镜像会让部署依赖一个需要先拉取的制品——在「registry 不可达」这类事故里，恰好失去回滚手段。Makefile 是可行的替代，但本项目既有的 10 个脚本已全部是 POSIX sh/bash，且 `bash -n` 与 shellcheck 都在 CI 里，换成 Makefile 会丢掉这两层检查。
- **把状态存进 CI 或数据库**。会把「哪个槽在服务」变成需要外部依赖才能回答的问题，而回滚恰恰发生在外部依赖可能不可用的时候。
- **只做正向演练（跑一次部署并观察成功）**。这不足以证明任何东西：计划 §14.11 记录的第一个注入故障（把流量切换提到健康门之前）会让部署**看起来完全成功**，日志与退出码都是 0。只有负向对照能把它暴露出来。

## Consequences

- 正面：部署逻辑可以在没有 Docker 引擎、没有服务器的本机被完整驱动。本阶段的全部顺序证据（80 项）都来自桩化自测，它们**不需要引擎**——这一点在 Docker 引擎始终不可用的前提下是决定性的。
- 正面：事故手册与流水线引用同一批脚本，因此「手册里写的步骤」不会与「CI 实际做的事」漂移。
- 正面：这套检查被证明会失败。`selftest-controls.py` 的 4 组注入故障各被抓住，其中「把 migrate 挪到起槽之后」被 7 条断言抓住，说明断言不是只覆盖了一个角度。
- 代价：`ops/deploy/` 现在有 10 个 shell 脚本，是一处需要维护的代码面。`shellcheck` 已进 CI（计划 Task 3.1），但**本机未安装、未在本地跑过**。
- 代价：桩化自测证明的是脚本的**顺序性质**，不是镜像可用、不是容器真的能起来。计划 §14.6 明确写下这条边界：「它不代表镜像可用（那是批一验收的事），只证明脚本在该停的地方停住了」。
- **未实测**：`nginx -t` 从未真正跑过；`nginx -s reload` 的 graceful 行为未观察；两个槽的容器**从未同时起过**；`render-upstream.sh` 的 `envsubst` 渲染未在 Linux 上跑过；**零停机的实验组与对照组都未做**，「秒级回滚」这个具体数字未测；`deploy.sh` 与 `rollback.sh` **从未对着真实 Docker 引擎执行过**。健康门与 `probe-loop.sh` 打真实 HTTP 服务器的三条路径是本批唯一不依赖桩的运行时证据。

## Compatibility Boundary

不改变任何运行时契约：镜像内容、`/api/*`、schema、页面行为与 CI 既有 5 个 job 的语义都不受影响。对既有本地用法是加法：`ops/` 是新增目录，`release.yml` 的 deploy job 是新增 job。唯一的行为变化在发布侧：部署与回滚经由服务器上的脚本执行，因此服务器需要一份 `ops/` 的同步副本（由 `rsync` 提供），而不是在 CI runner 上就地执行。

## Retirement Impact

若将来改用支持声明式发布编排的平台（例如按 digest 部署的编排系统），第一条（逻辑入库）应当保留其**目的**——CI 与人工必须跑同一份代码——但实现形式可以变。第五条划出的边界需要重新核对：门、审批与并发锁可以交给平台，但顺序（migrate 早于起槽、健康门早于切流量）**必须**仍然有可执行的载体，否则 `selftest.sh` 的 80 项断言无处可依，而它们正是本设计唯一的顺序证据。第四条（状态在服务器上）在任何方案下都应保留：回滚能力不能依赖一个需要联网才能读到的状态。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: 既有基线里没有任何条目描述部署与回滚的实现位置、顺序约束与验证方式；ADR-0006 只登记了两层源码结构与可选 MySQL。本轮新增的是「部署逻辑入库」这条硬约束与它的三层验证证据，新基线快照应登记这些事实，并同时登记「脚本从未对真实引擎执行过、零停机未实测」这一未验证边界。

## Evidence References

- ops/deploy/deploy.sh
- ops/deploy/rollback.sh
- ops/deploy/health-gate.sh
- ops/deploy/probe-loop.sh
- ops/deploy/publish-version.sh
- ops/deploy/lib.sh
- ops/deploy/selftest.sh
- ops/deploy/selftest-controls.py
- ops/runbook/deploy.md
- ops/nginx/render-upstream.sh
- .github/workflows/release.yml
- docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
