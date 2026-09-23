# 交付效果证据索引：截图与命令输出（2026-09-22）

状态：**全部待采集**。本文件规划证据落点，不声称任何证据已经存在。
对应基线记录：`../../baseline/2026-09-22-containerization-and-delivery.md`
对应规格：`specs/2026-09-22-containerization-cicd-and-observability-design.md` §13.1 / §13.2

## 0. 先说清楚这份文件的状态

**清单里的截图一张都不存在。** Docker 引擎在本机从未可用（`VirtualMachinePlatform` 未启用，解除需提权并重启；使用者已决定暂缓），因此：**镜像从未构建、容器从未启动、`compose up` 从未跑过**。没有服务器、没有域名、没有 TLS、没有 SMTP 凭据、GitHub 仓库未推送。

因此这份索引的每一行都是 `待采集`，并附上**采集命令**。任何人都可以照着命令在环境就绪后一次采集完，然后把状态改成 `已采集` 并填上文件名。

**为什么还是要把这份索引写出来**，而不是等环境就绪再写：

1. 一份「待采集」清单把「我们打算证明什么」固定在纸上，而这件事与「已经证明了什么」是**两件必须分开的事**。不写下来，环境就绪后的采集会退化成「截几张图放上去」。
2. 规格 §13.2 的映射表是**简历可辩护性**的映射。把它落成具体的文件路径与一句话证明，才能在事后核对「这一列到底有没有对应的证据」。
3. 已经**实测**的那部分（`bash -n` 10/10、桩化自测 80 项、负向对照 6 项、`config` 退出码 0、真实 HTTP 健康门、`probe-loop` 计数）**同样是证据**，只是形式是命令输出而不是截图。它们的原始文本引用集中在 §3，**这些不是待采集**。

## 1. 截图存放约定

新建目录 `docs/screenshots/delivery/`。命名规则 `<序号>-<主题>.png`，序号与 §2 表格的编号一致，这样「清单里第几行」与「文件名第几位」永远对得上。

```bash
mkdir -p docs/screenshots/delivery
```

**截图必须带上下文，不允许只截一行数字。** 对每个 `docker` / `curl` 输出，截图窗口要能看见**被执行的命令本身**——一张只有结果的图无法排除「结果来自另一条命令」或「来自另一次运行」。这是本项目对截图的既有标准（对比 `docs/screenshots/ballot-inconsistent.png`：它同时包含徽章、两侧票数与偏差数）。

## 2. 待采集截图清单

配合规格 §13.1 的 11 项验收。**每张图配一句「它证明了什么」——一句话说不清的就说明它不该被当成证据。**

| #   | 文件路径                                                       | 它证明了什么                                                                                        | 采集命令                                                                                                                      | 对应验收项 | 状态       |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 01  | `docs/screenshots/delivery/01-compose-ps-healthy.png`          | 全新机器上一键拉起后**每个服务都 healthy**，而不只是「进程起来了」                                  | `docker compose down -v && docker compose up -d --wait && docker compose ps`                                                  | §13.1-1    | **待采集** |
| 02  | `docs/screenshots/delivery/02-compose-ps-negative.png`         | 去掉一个 healthcheck 后 `--wait` **必须失败**——证明 01 的通过不是因为门槛不存在                     | 临时注释掉一个 healthcheck → `docker compose up -d --wait; echo "exit=$?"`（期望非 0）                                        | §13.1-1    | **待采集** |
| 03  | `docs/screenshots/delivery/03-image-size.png`                  | 镜像体积的**实际字节数**，以及是否落在 < 250MB 的目标内                                             | `docker image ls voting-web:dev`（同时截 `docker history` 的前若干层，说明哪一层最大）                                        | §13.1-2    | **待采集** |
| 04  | `docs/screenshots/delivery/04-standalone-mysql2.png`           | `mysql2/promise` 在**镜像内**可解析——本机实测的「standalone 不自包含」在 Linux 上是否不再复发       | `docker run --rm voting-web:dev node -e "console.log(require.resolve('mysql2/promise'))"`                                     | §13.1-3    | **待采集** |
| 05  | `docs/screenshots/delivery/05-zero-downtime-experiment.png`    | 双槽发布期间**失败请求数为 0**                                                                      | `./ops/deploy/probe-loop.sh https://<域名>/api/health 120 2` 与服务器上 `./ops/deploy/deploy.sh <sha>` 并行；截 JSON 汇总行   | §13.1-4    | **待采集** |
| 06  | `docs/screenshots/delivery/06-zero-downtime-control.png`       | **对照组**：原地 `up -d` 重跑同一探测会出现失败请求——证明 05 的 0 不是因为探针太粗                  | `./ops/deploy/probe-loop.sh … 120 2` 与 `docker compose … up -d --force-recreate web-<active>` 并行；截 JSON 汇总行           | §13.1-4    | **待采集** |
| 07  | `docs/screenshots/delivery/07-rollback-recovered.png`          | 坏镜像 → 健康门失败 → 回滚后服务恢复，且 `active-slot` 与 `previous-tag` 与发布前一致               | `cat state/active-slot state/active-tag state/previous-tag` + `curl -o /dev/null -w '%{http_code}' https://<域名>/api/health` | §13.1-5    | **待采集** |
| 08  | `docs/screenshots/delivery/08-rollback-timing.png`             | 「秒级回滚」的**实际耗时**（`time` 的输出）                                                         | `time ssh deploy@<server> 'cd /srv/voting && ./ops/deploy/rollback.sh'`                                                       | §13.1-5    | **待采集** |
| 09  | `docs/screenshots/delivery/09-alertmanager-container-down.png` | `ContainerDown` **到达了接收端**，而不只是「规则已配置」                                            | 杀掉 web 容器 → 等待 ≤2 分钟 → 截收件箱里的告警邮件（含 Alertmanager 侧 `docker compose logs alertmanager`）                  | §13.1-6    | **待采集** |
| 10  | `docs/screenshots/delivery/10-alert-lag-high.png`              | `VotingIndexLagHigh` 被触发                                                                         | 制造 lag 后截 Prometheus 的 Alerts 页与 Alertmanager 侧记录                                                                   | §13.1-7    | **待采集** |
| 11  | `docs/screenshots/delivery/11-alert-lag-unknown.png`           | `VotingIndexLagUnknown` 被触发，且**与 10 是两条不同的告警**                                        | 让 `lagBlocks` 不可读（例如阻断 `getHealth()` 的数据库读取）→ 截同一页                                                        | §13.1-7    | **待采集** |
| 12  | `docs/screenshots/delivery/12-migrate-idempotent.png`          | 容器内 `migrate` 连续两次成功，第二次不报错、不重复建表                                             | `docker compose run --rm migrate && docker compose run --rm migrate; echo "exit=$?"`                                          | §13.1-8    | **待采集** |
| 13  | `docs/screenshots/delivery/13-health-without-monitoring.png`   | 关闭全部监控容器后 `/api/health` 仍 200——ADR-0006 的回归测试                                        | `docker compose --profile observability stop` 后 `curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/health`         | §13.1-9    | **待采集** |
| 14  | `docs/screenshots/delivery/14-mysql-3307-preserved.png`        | 既有命令 `docker compose up -d mysql` 仍可用，端口仍是 3307                                         | `docker compose up -d mysql && docker compose port mysql 3306`（期望 `0.0.0.0:3307` 或 `127.0.0.1:3307`）                     | §13.1-10   | **待采集** |
| 15  | `docs/screenshots/delivery/15-metrics-refused-publicly.png`    | `/api/metrics` **不经 nginx 暴露**，公网返回 403                                                    | `curl -s -o /dev/null -w '%{http_code}\n' https://<域名>/api/metrics`（期望 403）+ 内部网络里同一路径返回 200                 | §13.1-11   | **待采集** |
| 16  | `docs/screenshots/delivery/16-secret-scan-negative.png`        | 故意在脚本里 `echo` 一个密钥值，**评审/检查必须能抓到**——证明检查有效                               | 注入一次 → 跑检查 → 截输出；随后还原并复跑                                                                                    | §13.1-11   | **待采集** |
| 17  | `docs/screenshots/delivery/17-local-dev-stack.png`             | 本地 `docker compose up` 后 UI 可访问、服务端能读到宿主机链（`chainId` 31337、`chainHead` 非 null） | `docker compose up -d --wait && curl -s localhost:3000/api/health`                                                            | Task 1.6   | **待采集** |
| 18  | `docs/screenshots/delivery/18-compose-isolation-injected.png`  | 往生产文件注入 `extra_hosts` 后检查器**会失败并指名泄漏**——证明隔离守卫有效                         | 注入 `docker-compose.prod.yml` 的 `web-blue` → `python ops/ci/check-compose.py`（期望退出 1）→ 还原                           | §13.1-11   | **待采集** |

**07 与 08 必须成对**。只有 07 时，「秒级」是一个形容词；只有 08 时，看不出服务真的恢复了。两张图合起来才是「回滚快**且**回滚对」。

**05 与 06 必须成对，且顺序不能反**。runbook 已写明理由：一个报告 0 失败的实验组，只有在同一台仪器能探测到**已知存在的**失败时才有意义。先采 06 再采 05，可以避免「探针太粗所以两组都是 0」这个最容易被接受为成功的错误结论。

## 3. 已实测的命令输出引用（不是待采集）

以下证据**已经存在**，形式是可复现的命令输出，记录在基线记录的第 3 节。它们不需要截图；需要截图的是它们在**真实环境**下的对应版本。

| 证据                                               | 实测输出                                                                                                                                                                     | 记录位置             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `bash -n` 全部 10 个 shell 脚本                    | 10 个脚本 / **0 失败**                                                                                                                                                       | 基线记录 §3 A-1      |
| `bash ops/deploy/selftest.sh`                      | **80 项全过 / 0 失败**，退出码 0                                                                                                                                             | 基线记录 §3 A-2      |
| `python ops/deploy/selftest-controls.py`           | **6 项全过**：干净树通过 + 4 组注入故障各被抓住 + 改回后再次通过                                                                                                             | 基线记录 §3 A-3      |
| `python ops/ci/check-workflows.py`                 | 退出码 0，3 个 workflow 全部成立                                                                                                                                             | 基线记录 §3 A-4      |
| `python ops/ci/selftest.py`                        | **9 项全过**：8 个故意破坏各自被抓住 + 干净树通过                                                                                                                            | 基线记录 §3 A-5      |
| `python ops/prometheus/check-rules.py`             | 退出码 0：23 条序列 / 9 条规则 / 3 看板 14 面板 / 4 个静态抓取目标                                                                                                           | 基线记录 §3 A-6      |
| 同上，负向对照                                     | 把 `probe_success` 改成 `probe_success_total` → 退出码 **1**，并指名规则与序列                                                                                               | 基线记录 §3 A-7      |
| `docker compose config --quiet`（基础 / 生产）     | 两种 profile **退出码均 0**                                                                                                                                                  | 基线记录 §3 A-8、A-9 |
| 生产服务清单与端口                                 | `mysql, migrate, web-blue, web-green, nginx, indexer`；生产配置里 `3307` 出现 **0 次**                                                                                       | 基线记录 §3 A-10     |
| 健康门打**真实 HTTP 服务器**                       | 200 → 退出 0；死端口 → 退出 1（`status 000`）；404 → 退出 1（`status 404`）                                                                                                  | 基线记录 §3 A-11     |
| 健康门预算精度（真实计时）                         | 1s → **1.4s**、3s → **3.4s**、5s → **5.2s**                                                                                                                                  | 基线记录 §3 A-12     |
| `bash ops/deploy/probe-loop.sh` 打真实服务器       | 全成功 `{"total":5,"succeeded":5,"failed":0,"maxConsecutiveFailures":0}` 退出 0；全失败 `{"total":3,"failed":3,"maxConsecutiveFailures":3,"firstFailureAtSeconds":0}` 退出 1 | 基线记录 §3 A-13     |
| Task 2.1 `/api/metrics`                            | 新增 24 测试；全仓 **711 passed / 0 failed**；build 含 `ƒ /api/metrics`；端到端 HTTP 200、10 条序列                                                                          | 基线记录 §3 A-14     |
| absent 路径真实数据                                | `voting_index_lag_blocks` 整条缺席、`voting_index_configured 1` 仍在、`errors_total` 0→1                                                                                     | 基线记录 §3 A-15     |
| Task 2.1 负向对照                                  | 把 `null` 改成 `0` → **恰好 2 个守护测试变红**                                                                                                                               | 基线记录 §3 A-16     |
| `python ops/ci/check-compose.py`                   | 退出码 **0**：6 项隔离断言 + 检测器自测 6 项                                                                                                                                 | 基线记录 §3 A-18     |
| 同上，**真树注入验证**                             | 往 `docker-compose.prod.yml` 注入 `extra_hosts` → 退出 **1**，指名「production references the host gateway」                                                                 | 基线记录 §3 A-18     |
| `docker compose config --quiet`（base + override） | 退出码 **0**                                                                                                                                                                 | 基线记录 §3 A-19     |
| `ci.yml` job 数                                    | **9** 个（`deploy-scripts` 与 `compose-isolation` 是本轮把「写了但没人跑的证据」接进门禁的产物）                                                                             | 基线记录 §3 A-20     |
| `pnpm format:check`                                | 退出码 0                                                                                                                                                                     | 基线记录 §3 A-17     |

**这一节里没有一项来自容器内。** 这是本阶段的证据结构与它的缺口所在；把它写在这里是为了让缺口看得见，而不是让它消失在「有 17 项证据」这个总数里。

## 4. 规格 §13.2 简历映射 → 证据落点

规格 §13.2 给了 10 个简历关键词、它们对应的项目内真实证据、以及面试官会追问什么。下表把它落成**具体的文件路径**。

**「现在可辩护」列的含义必须读准**：它指「现在有实测支撑的部分」。**这不等于该关键词已经可以整句主张**——多数关键词的完整主张仍在待采集列。

| 简历关键词                   | 现在可辩护的证据（已实测）                                                                                                                                                                                               | 待采集的证据（§2 的编号）                  | 面试会追问                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------- |
| Docker 多阶段构建 / 镜像瘦身 | 四阶段 Dockerfile 与 `standalone` 的设计理由；**本机实测的「standalone 不自包含」真实缺陷**（基线记录 §2.3）                                                                                                             | 03、04                                     | 为什么 standalone？`mysql2` 为什么不能被 bundle？哪一步破坏了层缓存？ |
| Docker Compose 编排          | 分层文件 + profiles + `service_healthy` / `service_completed_successfully`；`config` 退出码 0（base / override / 生产三种组合）；生产服务清单与 `3307` 为 0；开发/生产隔离由 `check-compose.py` 机械守护（含检测器自测） | 01、14、17                                 | `service_healthy` 与 `sleep` 差在哪？migrate 为什么不能进 initdb？    |
| CI/CD 流水线                 | 5 阶段流水线的结构与不变量；**9** 个 CI job；一个**能失败**的自写检查器（8 个破坏用例全被抓住）                                                                                                                          | 09（以及 `gh run list` 的截图，未列入 §2） | 怎么保证「测过的」就是「部署的」？                                    |
| 零停机发布 / 蓝绿            | 双槽 + 上游派生的**顺序性质**经桩化验证；负向对照证明这些断言会失败；探测仪器能看见失败                                                                                                                                  | 05、06                                     | 切换瞬间在途请求怎么办？两个版本同时连一个库怎么办？                  |
| 回滚                         | 回滚快路径**不重启容器**的断言；冷槽先起先过门；上游被拒时恢复旧文件                                                                                                                                                     | 07、08                                     | `schema` 已经迁移了怎么回滚？                                         |
| 镜像安全 / 供应链            | 流水线里 Trivy + SBOM + provenance 的**位置与阻断条件**；仓库面密钥扫描无真实值                                                                                                                                          | 15、16                                     | 扫出的 HIGH 怎么处置？豁免怎么管？                                    |
| Prometheus 指标设计          | 13 个指标 + **null/absent 区分有真实数据支撑**（lag 整条缺席而 `configured 1` 仍在）                                                                                                                                     | 10、11                                     | 为什么「读不出来」不能报 0？counter 在多实例下怎么算？                |
| 告警规则 / 降噪              | 9 条规则 + `inhibit_rules` 的出处可校验，且校验器**会失败**                                                                                                                                                              | 09、10、11                                 | 哪条会误报？告警来了先看哪个看板？                                    |
| Linux / 主机运维             | 初始化清单（`deploy` 用户、防火墙最小放行、日志轮转、磁盘预测告警）的内容                                                                                                                                                | 08、12、13（真实的 `df -h /srv` 等）       | 磁盘满了怎么定位？OOM 怎么看？为什么监控端口不对公网暴露？            |
| 密钥管理                     | 仓库面 **228 个文件**扫描无真实值（8 处命中全为占位符/截断示例）；不回显值的实现                                                                                                                                         | 16                                         | 为什么不用密码？为什么不用 `ssh-keyscan`？密钥怎么轮换？              |

**建议的采集顺序**（按「先证伪仪器、再证明显结果」排列，与 runbook 的纪律一致）：

1. **06**（对照组）→ 确认探针能看见失败；
2. **05**（实验组）→ 现在 0 失败才有意义；
3. **02**（healthcheck 负向对照）→ 确认 `--wait` 的门槛是真的；
4. **01** → 一键拉起；
5. **16**（密钥检查负向对照）与 **18**（compose 隔离注入）→ 确认两个检查器都有效；
6. **11**（`LagUnknown`）与 **10**（`LagHigh`）**分别**采 → 缺任一张都无法证明二者被区分；
7. 其余按 §13.1 顺序补齐（17 可在本地栈一站采完，不依赖服务器）。

## 5. 采集时的三条纪律

1. **截图里必须看得见被执行的命令。** 只有结果的一行数字无法排除「来自另一次运行」。
2. **负向对照与正向结果必须成对保存，且文件名不合并。** 把「对照组也有失败」与「实验组零失败」放进同一张图的代价是，下一个人无法判断哪一半是主张。
3. **采集完把 §2 的 `待采集` 改成 `已采集`，并把实测数字写进基线记录的表格。** 只留下图片而不更新表格，等于让证据与主张脱钩——而这份索引存在的全部意义就是防止这件事。

## 6. 未采集的原因（如实记录）

| 缺失的前置条件             | 阻塞了哪些证据                                     |
| -------------------------- | -------------------------------------------------- |
| Docker 引擎不可用          | 01、02、03、04、12、13、14、**17**（全部容器相关） |
| 无服务器                   | 05、06、07、08                                     |
| 无域名 / 无 TLS            | 05、06、07、15（HTTPS 侧）                         |
| 监控栈从未启动             | 09、10、11                                         |
| 无 SMTP 凭据               | 09                                                 |
| 仓库未推到 GitHub          | `gh run list` 类证据（未列入 §2）                  |
| 密钥检查的负向对照尚未设计 | 16                                                 |

**这张表与基线记录的「未实测清单」是同一份缺口的两面**：基线记录按验收项列，这里按证据文件列。

**注意 17 的位置**：它不需要服务器、不需要域名、不需要监控栈——**只缺 Docker 引擎**。所以引擎一旦就绪，它应当与 01/02 一起被采掉，而不必等服务器。把「只缺一个前置条件」与「缺三个」区分开，是这张表唯一的作用。
