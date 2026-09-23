# ADR-0047 - 监控栈用 compose profile 隔离，不参与应用启动路径

Status: `recorded-from-plan`
Date: `2026-09-22`

## Source Evidence

- `docker-compose.yml`（计划 Task 2.4–2.6）：`prometheus` / `alertmanager` / `node-exporter` / `cadvisor` / `mysqld-exporter` / `blackbox-exporter` / `grafana` 共 7 个服务全部带 `profiles: ["observability"]`
- 实测（计划 §14.9 验证表）：`docker compose config --quiet`（基础）退出码 **0**；`docker compose --profile observability config --quiet` 退出码 **0**；服务清单 11 个（4 应用 + 7 观测）
- `ops/nginx/conf.d/10-app.conf` 第 55–70 行：`location = /api/metrics { return 403; }`，注释写明「Relying on "we do not publish that port" is not enough here: this proxy forwards everything under / to the application」
- `ops/prometheus/prometheus.yml`：`job_name: web` 的目标是 `web:3000`，即 compose 服务名，Prometheus 靠加入 `backend` 网络抓取，因此该端点从不需要公开
- 实测（计划 §14.9 偏离计划的判断 2）：exporter 一律不加容器健康检查，因为 Prometheus 自己的 `up` 序列已经在报「它答没答」，再加一层就是第二个「它还活着吗」的所有者
- 规格 §13.1 第 9 项把「关闭全部监控容器后 `/api/health` 仍 200」登记为 ADR-0006 的回归测试
- 边界：**该项验收从未执行**（计划 §14.9 未验证清单：`--profile observability up -d --wait` 未跑过、Grafana 未渲染过、告警邮件未投递过）

## Context

规格 §7.2 把「监控栈用 `profiles: [observability]` 隔离，不写在应用启动路径上」与 ADR-0006 的「可选依赖」原则直接挂钩：ADR-0006 决定 MySQL 降级为可选、无 `DATABASE_URL` 时所有读取回退为直接读链；监控栈是同一原则的下一个对象——**应用不依赖监控，就像它不依赖数据库**。

反面情形不是假设。如果监控与应用同生共死，那么「监控挂了」会升级成「服务挂了」：一次 Prometheus 的内存超限会连带把 web 拖下去，而这时没有任何东西在记录发生了什么——**监控系统恰好在你最需要它的那一刻消失，而且它消失的原因正是你此刻要查的事情**。

还有一层更安静的风险：监控栈本身约需 1.5GB 常驻（规格 §7.3），与 web / MySQL 争抢内存会 OOM kill 应用。所以每个服务都有显式 `mem_limit`，让超限的是监控而不是应用。

## Decision

**一、7 个观测服务全部带 `profiles: ["observability"]`，不激活该 profile 时它们根本不被创建。**

`docker compose up -d` 拉起的是 4 个应用服务；`docker compose --profile observability up -d` 才是全栈。因此「应用起来了、监控没起来」是一个正常状态，而不是故障。

**二、监控不进入任何应用的启动依赖。**

应用侧的 `depends_on` 只指向 `mysql` 与 `migrate`，没有一个观测服务出现在应用的依赖链上。反向也不成立：观测服务可以依赖应用（Prometheus 抓 web），但应用永不依赖观测。

**三、`/api/metrics` 只在内网被抓取，公网显式拒绝。**

Prometheus 走 `backend` 网络直接抓 `web:3000`；nginx 用 `location = /api/metrics { return 403; }` 精确匹配拦掉公网路径。选 `=` 精确匹配而不是前缀匹配，是为了让这条拒绝不受 location 书写顺序影响——它要表达的是「这个路径不公开」，而不是「恰好写在前面」。

**四、观测服务里只有「就绪状态会卡住别的东西」的才带健康检查。**

`prometheus` / `alertmanager` / `grafana` 有；四个 exporter 没有。exporter 的存活已经由 `up` 序列与 `ContainerDown` 规则覆盖，再加容器健康检查就是第二个「它还活着吗」的所有者，两者第一次分叉时就会打架（ADR-0012 / ADR-0013 同源的纪律）。

**五、每个观测服务都设 `mem_limit`。**

这是第一条的补充而不是重复：profile 保证监控不在启动路径上，`mem_limit` 保证它也不会通过耗尽内存间接把应用拖下水。

## Alternatives Considered

- **监控与监控对象同生共死**（规格 §12 登记的被否方案）：把 Prometheus 放进应用的依赖链，或用同一个 compose 文件无 profile 一起拉起。会把「监控挂了」升级为「服务挂了」，并且在故障期间同时失去观测能力——恰好是最需要它的时刻。
- **不隔离，靠运维纪律「只起应用那几个服务」**。纪律不是机制：`docker compose up -d` 会拉起文件里定义的一切，而这条命令是本项目文档里的一键拉起命令（规格 §7.1）。把「不要起监控」寄托在人工输入上，第一次有人照文档敲命令就失效。
- **给每个 exporter 加容器健康检查**（计划 Task 2.4 的初版设想）。会造成「它还活着吗」有两个所有者，而两者在 exporter 能应答但抓取失败这类情形上必然给出不同答案。
- **把 `/api/metrics` 交给 nginx 用 `deny` 或只靠「不发布端口」保护**。注释已经写明了否掉的理由：nginx 把 `/` 下的一切转发给应用，`/api/metrics` 因此默认可达；而「我们没发布那个端口」描述的是另一个端口，不构成对这个路径的约束。
- **把监控栈放进 `docker-compose.override.yml`**。override 会被 `docker compose` 自动叠加（见 `docker-compose.prod.yml` 开头的说明），因此它并不构成隔离，只是把监控挪到了另一个默认加载的文件里。

## Consequences

- 正面：应用可以在监控全挂的情况下照常服务，且这一点是**结构性的**——不激活 profile 时那些容器不存在，没有「没配好」的中间态。
- 正面：观测栈可以整体重启、升级或停机维护，而不触及应用。反过来，应用的滚动发布也不会打断采集。
- 正面：内存竞争有上界。监控超限时被 OOM kill 的是监控，应用继续服务。
- 代价：观测服务的启动需要一条更长的命令（多一个 `--profile observability`），这条命令同时出现在 `docker-compose.yml` 的注释与规格 §7.1 的三种启动方式里，是一处需要同步的文档面。
- 代价：`/api/metrics` 的公网拒绝是一条 nginx 规则，因此它**只在生产拓扑下成立**；本地直接打 `web:3000` 不经 nginx，此时该端点是可达的。这是刻意的——本地开发者需要能 curl 它。
- **未实测**：规格 §13.1 第 9 项的验收（关闭全部监控容器后 `/api/health` 仍 200）**没有执行**；`--profile observability up -d --wait` 未跑过；`promtool check config/rules` 未跑（本机无 `promtool`，自写的 `ops/prometheus/check-rules.py` 明确不解析 PromQL，两者不能互相替代）；四个 exporter 的 `/metrics` 未取过；Grafana 未渲染过；告警邮件未投递过。因此「不参与启动路径」目前是配置层面的事实，不是运行时观察到的行为。

## Compatibility Boundary

既有 `docker compose up -d mysql` 与 `docker compose up -d` 的语义不变——不激活 observability profile 时服务清单与扩写前一致（外加 migrate / indexer）。`/api/health` 的 JSON 形状与 HTTP 状态码不变；`/api/metrics` 是新增表面，不替换任何既有表面。唯一的可观察行为变化是：从公网访问 `/api/metrics` 得到 403，而不是应用响应。

## Retirement Impact

若将来引入集中日志（Loki / ELK，规格 §5.2 列为非目标），它必须沿用同一个 profile，否则「监控栈不在启动路径上」这条性质会在新增服务时被悄悄破坏——而破坏它的方式恰好是最自然的那种：往文件里加一个服务。若观测栈迁到独立的宿主机，第一条（profile）应当重新表述为「不在同一个编排单元里」，但第二条（应用不依赖观测）与第三条（端点只在内网）必须原样保留，它们与部署位置无关。若引入服务网格或集中式指标网关，第四条关于「不要有第二个『它还活着吗』的所有者」的约束需要重新分配所有者，而不是叠加一层。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: 观测栈是全新引入的运行时面，既有基线（2026-09-20 / 2026-09-21 两份）里没有任何条目描述它。ADR-0006 的「可选依赖」原则此前只覆盖 MySQL；本轮把它延伸到监控栈，因此新基线快照需要同时登记「应用不依赖监控」这一架构事实与「该验收尚未实测」这一未验证边界。

## Evidence References

- docker-compose.yml
- ops/prometheus/prometheus.yml
- ops/prometheus/rules/voting.yml
- ops/nginx/conf.d/10-app.conf
- ops/blackbox/blackbox.yml
- docs/aegis/adr/ADR-0006-two-layers-and-optional-mysql.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md
- docs/aegis/adr/ADR-0013-health-fields-name-what-they-compute.md
- docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
