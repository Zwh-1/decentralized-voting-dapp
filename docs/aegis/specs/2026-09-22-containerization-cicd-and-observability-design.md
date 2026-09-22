# 去中心化投票 DApp 的容器化、CI/CD 与可观测性设计规格

日期：`2026-09-22`
状态：`待用户评审`
仓库根：`D:\桌面\实习项目\decentralized-voting-dapp`
类型：Design Spec（operational-release + security-permission + public-contract）
前序规格：`2026-09-20-decentralized-voting-dapp-design.md`（应用本体设计，已完成并实测）

---

## 0. Aegis Visibility

本规格存在的理由：本阶段的四项交付（Dockerfile、Compose、Actions 流水线、Prometheus 整合）表面上是"加几个 YAML"，实际上引入的是**三类此前不存在的持久边界**——一个新的运行时部署边界、一个发布/回滚边界、以及一批新的可观测数据序列。这三样都有共同的特征：**写错了不会报错，只会在出事的那天暴露**。

同时，本阶段的真实目标不是"让服务跑起来"，而是**让每一个写进简历的技术主张都能在面试中被追问到底**。因此本规格的作用是两件事：

1. 把"容器化 + CI/CD"从关键词清单收缩为**每一环都有实测证据**的链路；
2. 在动手前把**会咬人的约束**（构建期内联的环境变量、schema 的单一所有者、索引滞后量的 null 语义）显式写成兼容边界，避免它们在实现期以"顺手绕过"的方式被违反。

本规格明确拒绝的诱惑：用 Kubernetes 换词汇量、用 Terraform 换"基础设施即代码"这四个字、用 Loki/ELK 换"集中日志"这个标签。理由见 §11 与 §12。

---

## 1. TaskIntentDraft

- **目标**：把已验证的 DApp（Next.js + MySQL + 链）改造为**在真实云服务器上一键拉起、由 GitHub Actions 自动构建并零停机发布、带完整监控告警**的部署形态，并把每一步做成可复现、可截图、可被面试追问的证据。
- **成功证据**（每条都必须实测，缺一即标注为未完成）：
  1. 全新机器上 `docker compose --profile local up -d --wait` 后 `docker compose ps` 全部 healthy；
  2. web 镜像的实测字节数，且 `docker image ls` 可复现；
  3. 一次完整的 GitHub Actions run（绿），四阶段（gate / build+scan / deploy / health-gate）耗时可见；
  4. **零停机发布**：发布期间对 `/api/health` 的持续探测**无一次失败**（这是方案 B 的证伪点，必须用脚本留时间序列证据）；
  5. 三类故障演练各留一张告警到达接收端的截图：容器死亡、索引滞后、`lagBlocks` 不可读（absent）；
  6. **回滚演练**：部署一个故意失败的镜像 → 健康门失败 → 自动或一键回滚 → 服务恢复，全过程留证据；
  7. `docs/aegis/baseline/` 新增一份本阶段基线记录，逐项写清**已实测 / 未实测**的边界。
- **停止条件**：允许 `完成` / `阻塞` / `需验证` / `超出范围` 四种结局。**Docker 引擎不可用属于阻塞，必须在阶段开始时解决**（见 §2.3）。
- **非目标**：见 §11。
- **风险提示**：`NEXT_PUBLIC_*` 的构建期内联会让"一个镜像跨环境复用"这一常见做法不成立（§7.3），这是本阶段唯一需要触及应用配置的地方。

### BaselineReadSetHint

```text
BaselineReadSetHint:
- 已有规格: docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md
- 已有基线: docs/aegis/baseline/2026-09-20-initial-baseline.md
            docs/aegis/baseline/2026-09-21-frontend-trust-rework.md
            docs/aegis/baseline/2026-09-21-optimization-pass.md
- 直接相关的 ADR:
  - ADR-0006 两层架构 + MySQL 降级为可选依赖（决定监控栈不得进入应用启动路径）
  - ADR-0010 被字节级守护的产物只含可复现字段
  - ADR-0012 失败状态必须指出失败的是谁（决定告警规则的粒度）
  - ADR-0013 观测字段必须与它真正计算的东西同名
  - ADR-0015 lagBlocks 只在滞后量成立时给出数字（决定 absent 与 0 必须区分）
  - ADR-0016 部署前检查的是"可用"而不只是"存在"，且绝不回显值
  - ADR-0017 一致性检查必须比较同一个瞬间
  - ADR-0020 失败报告只给形状，不回显配置
- 约束来源: CONTRIBUTING.md、README.md（实测指标 / 复现路径 / 已知边界）、
            docs/aegis/BASELINE-GOVERNANCE.md §3 §6、docker-compose.yml 的既有注释
- 本规格新增（无既有所有者）: 部署拓扑、发布与回滚机制、可观测性数据序列
```

### BaselineUsageDraft

```text
BaselineUsageDraft:
- Required baseline refs:
  - docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md §5 §6 §11
  - docs/aegis/baseline/2026-09-20-initial-baseline.md §5.2（五条不变量）
  - docs/aegis/baseline/2026-09-21-optimization-pass.md
  - CONTRIBUTING.md「先读这一节」
  - ADR-0006 / ADR-0012 / ADR-0015（本阶段直接继承的三条）
- Delivered context refs:
  - 本会话已读: web/package.json、web/next.config.ts、web/src/instrumentation.ts、
    web/src/app/api/health/route.ts、web/src/lib/health-report.ts、web/scripts/drain.ts、
    web/.env.example、contracts/.env.example、docker-compose.yml、.github/workflows/ci.yml、
    package.json、.gitignore、README.md（grep 检索）、docs/aegis/INDEX.md
  - 本会话已实测: docker version（失败，引擎不可用）、docker compose version v5.4.0、
    wsl -l -v（docker-desktop 与 Ubuntu 均 Stopped）、node v24.14.0、pnpm 11.25.0、
    127.0.0.1:3306 有 MySQL 监听、git remote -v（空）
  - 本会话已 grep: prometheus|prom-client|/metrics|grafana|node_exporter → 0 命中
- Acknowledged before plan refs:
  - docs/aegis/BASELINE-GOVERNANCE.md 的七维架构审查尚未在本规格中逐条展开（留待实施计划）
- Cited in design refs: 见上 Required baseline refs
- Missing refs: 无（第二阶段 Prometheus 产物经用户确认不存在，本阶段为新建）
- Decision: continue
```

### ImpactStatementDraft

- **受影响层**：容器镜像与运行时拓扑、进程划分（web / indexer / migrate）、HTTP 表面（新增 `/api/metrics`）、发布机制（双槽 + nginx 上游切换）、应用配置（`next.config.ts` 增加 standalone）、CI 工作流、服务器侧目录与密钥、可观测性数据序列与其保留策略。
- **不变量（必须保持，违反即为设计缺陷）**：
  1. **链上仍是唯一事实源**；MySQL 仍可随时 `DROP` 并从事件完整重建（ADR-0001）。
  2. **schema 只有一个所有者**：`web/src/lib/db/schema.ts` + `scripts/migrate.ts`。容器化**不得**引入 `/docker-entrypoint-initdb.d/` 脚本或任何第二处 schema 定义。
  3. **后端永不持有私钥**，投票写入仍只由用户钱包直连合约签名。
  4. **`lagBlocks` 的 null 语义不得在指标层被抹平**：无索引 / 游标不可读时**不导出该序列**，绝不导出 0（ADR-0015）。
  5. **应用在监控栈完全缺失时仍必须正常启动并提供服务**（继承 ADR-0006 的"MySQL 可选"，本阶段推广到监控栈）。监控不得成为应用的启动依赖。
  6. **失败报告只给形状，不回显配置值**：部署脚本、健康门、告警文案都不得打印或注解任何密钥值（ADR-0016 / ADR-0020）。
- **兼容边界**：
  - `docker compose up -d mysql` 这一条既有命令（README 第 271 行引用）**必须继续可用**，服务名 `mysql` 与宿主机端口 `3307` 不变。
  - `/api/health` 的现有 JSON 契约**不变**；`/api/metrics` 是新增表面，不替换它。
  - `pnpm` 脚本名与 CI 既有 5 个 job 的语义不变；`abi-drift` 的字节级守护不变。

---

## 2. Requirement Ready Check

```text
Requirement Ready Check:
- Requirement source refs: 用户在本会话粘贴的"第三阶段：应用交付与DevOps进阶（第7-9周）项目三"四项动手实操，
                           + 本会话确认的 3 项决策（§2.2）
- Goals and scope refs: §1 TaskIntentDraft、§11 非目标
- User / scenario refs: 求职者本人（简历与面试场景）；云服务器运维者（发布、回滚、排障）
- Requirement item refs: §6 Dockerfile / §7 Compose / §8 CI-CD / §9 监控 / §10 双槽发布
- Acceptance / verification criteria refs: §13 验收标准与证据清单、§14 简历可辩护性映射
- Open blocker questions: 服务器发行版/架构/内存、域名与 TLS（§15）
- Decision: ready（阻塞项不影响设计方向，只影响实施细节）
```

### 2.1 用户原话与本文档的映射

| 用户要求的动手实操 | 本文档章节 | 与用户预期描述的偏差（已实测确认） |
| --- | --- | --- |
| 把之前做的 DApp（前端、后端、MySQL）全部编写 Dockerfile | §6 | **偏差点**：前端与后端是**同一个** Next.js 进程（App Router 同时承载 UI 与 API Route + 索引器循环）。因此是 **1 个自写 Dockerfile**，复用给 web / migrate / indexer 三个角色；MySQL 用官方镜像不需要自写；`contracts/` 是编译期工具链，不进运行时镜像 |
| 使用 Docker Compose 一键拉起整个 DApp 环境 | §7 | 现仓库已有 `docker-compose.yml`（仅 MySQL，3307），本阶段是**扩写**而非新建，且必须保持既有命令可用 |
| 编写 GitHub Actions YAML：push 后自动跑单元测试、构建镜像推 Docker Hub、SSH 自动部署到云服务器 | §8 | **前半已完成**：`.github/workflows/ci.yml` 已有 5 个 job 覆盖单元测试、真 MySQL schema 幂等、端到端索引一致性。缺的是构建 / 推送 / 部署 / 回滚 |
| 将第二阶段的 Prometheus 监控整合进来，监控后端 API 状态 | §9 | **第二阶段产物不存在**（全库 grep 0 命中，用户已确认未落地）。本阶段是**新建**，数据源复用已有的 `getHealth()`，不新造数据所有者 |

### 2.2 用户在本会话确认的三项决策

| 决策 | 结论 | 影响的设计面 |
| --- | --- | --- |
| 云服务器 | **已有可用的 Linux 云服务器** | SSH 部署是真实生产发布，可留真实证据；服务器初始化列为前置任务 |
| 第二阶段监控产物 | **没有落地，本阶段新建** | 按新建设计，不承担"整合既有配置"的兼容包袱 |
| 交付范围 | **A + B：单机 Compose + 双槽零停机发布** | 不含 Docker Swarm，不含 Kubernetes（§11 说明理由） |

---

## 3. 现状核对（本会话实测，作为设计的事实基础）

### 3.1 已经存在、本阶段不重做的部分

| 已存在 | 内容 | 本阶段的关系 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | 5 个 job：contracts（编译/测试/覆盖率/gas）、`abi-drift`（ABI 漂移守卫）、web（类型检查+单测+真 MySQL 跑两遍 migration+推导视图）、`indexer-e2e`（真链真库端到端一致性）、format | **保持不动**，作为部署流水线的质量门被调用 |
| `docker-compose.yml` | MySQL 8.4，`3307:3306`，healthcheck，named volume，注释明确 schema 由 `pnpm migrate` 应用 | 扩写为 base，服务名与端口不变 |
| `/api/health` | 返回 `status` / `chainId` / `contract` / `pollCount` / `confirmations` / `indexConfigured` / `indexerLoopEnabled` / `lastIndexedBlock` / `chainHead` / `lagBlocks` / `indexError` | **作为指标的唯一数据源**，不新造状态 |
| `web/scripts/drain.ts` | 一次性 drain 到 idle 后退出（`MAX_ROUNDS=1000`），**开头自己调 `migrate()`**，结束时打印 JSON 摘要（`rounds` / `inserted` / `duplicatesIgnored` / `hitRoundLimit`） | 决定 indexer 容器需要外层调度循环；其 JSON 摘要可直接作为结构化日志 |
| `web/src/instrumentation.ts` | 进程内索引循环，受 `INDEXER_ENABLED` 控制，失败静默（设计上允许 chain-only 运行） | 容器化后 web 侧须置 `INDEXER_ENABLED=false` |

### 3.2 完全缺失、本阶段新建的部分

| 缺失项 | 实测证据 |
| --- | --- |
| 任何 Dockerfile | 仓库内 0 个 |
| Prometheus / 指标相关代码 | `grep -E "prometheus\|prom-client\|/metrics\|grafana\|node_exporter"` → **0 命中** |
| `output: "standalone"` | `web/next.config.ts` 仅有 `reactStrictMode` 与 `serverExternalPackages: ["mysql2"]` |
| git remote | `git remote -v` 输出为空 → GitHub Actions 无从触发 |
| 部署脚本 / 回滚脚本 | 不存在 |

### 3.3 环境实测（决定前置条件）

| 项 | 实测结果 | 影响 |
| --- | --- | --- |
| Docker 引擎 | **不可用**：`docker version` 报 `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` | **第一号阻塞项**。README 已记录过同一问题（"本机 Docker 引擎始终未就绪，API 持续返回 500"） |
| WSL | `docker-desktop` 与 `Ubuntu` 两个发行版均为 `Stopped` | 修 Docker Desktop 或改用 WSL2 内的 Docker Engine |
| docker compose CLI | `v5.4.0`，存在但无 daemon | 修好引擎即可用，支持 `up --wait` |
| Node / pnpm | `v24.14.0` / `11.25.0` | 满足 `engines: >=22.13.0` 与 `packageManager: pnpm@11.25.0` |
| 本机 3306 | 有 MySQL 监听 | 容器化后整栈走容器网络；3307 映射仅用于从宿主机查看数据 |
| 服务器 | 用户确认已有可用 Linux 云服务器 | 发行版/架构/内存待补（§15），影响镜像平台与监控栈内存预算 |

### 3.4 三个会咬人的约束（本规格的核心设计输入）

| # | 约束 | 出处 | 设计后果 |
| --- | --- | --- | --- |
| **C1** | `NEXT_PUBLIC_*` 在**构建期内联**进客户端 bundle | `web/.env.example` 第 87-89 行："a `NEXT_PUBLIC_*` value is inlined into the client bundle at build time, so both of these need a rebuild to take effect" | **一个镜像不能跨环境复用**。本阶段选择"每次部署按 build-arg 重建镜像"，不动应用代码（§7.3 记录被否掉的替代方案） |
| **C2** | schema 的唯一所有者是 `lib/db/schema.ts` + `scripts/migrate.ts`，**明确不用 init 脚本** | `docker-compose.yml` 第 6-8 行："The schema itself is applied by the indexer (`pnpm migrate`), not by an init script, so there is exactly one definition of the schema." | migrate 必须是**一次性任务容器**，用 `service_completed_successfully` 排序；**禁止** `docker-entrypoint-initdb.d` |
| **C3** | 后台索引循环是"便利"而非"机制"；可靠入口是 `POST /api/index/sync` 与 `pnpm drain` | `instrumentation.ts` 注释、README "在无服务器部署中不会持续运行" | 索引器拆为独立容器是正确的架构方向，同时换来"worker 独立重启/扩缩容"的运维叙事 |

---

## 4. 目标架构

### 4.1 运行时拓扑

```text
                    ┌───────────────────────────┐
   Internet ───────►│  nginx  :80/:443          │  TLS 终止 / 反向代理 / 安全响应头
                    │  上游: web-blue|web-green  │  ← 双槽，切换即发布/回滚
                    └──────────┬────────────────┘
                               │ edge 网络
                    ┌──────────▼────────────────┐
                    │  web-blue :3000           │  UI + API（INDEXER_ENABLED=false）
                    │  web-green :3000          │  同一镜像的两个槽位，只启用一个
                    └──────────┬────────────────┘
                               │ backend 网络（internal: true）
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼────────┐   ┌─────────▼────────┐   ┌─────────▼─────────────┐
│ indexer worker │   │  mysql :3306     │   │  migrate（一次性）     │
│ drain 调度循环  │   │  索引投影         │   │  复用 web 镜像         │
└───────┬────────┘   └──────────────────┘   └───────────────────────┘
        │
┌───────▼────────────────────┐        ┌─────────────────────────────────────┐
│ chain（profile: local）     │        │ 可观测性（profile: observability）    │
│ anvil / hardhat node       │        │ prometheus / alertmanager / grafana  │
└────────────────────────────┘        │ node-exporter / cadvisor /           │
  或外部 Sepolia RPC                   │ mysqld-exporter / blackbox-exporter  │
                                       └─────────────────────────────────────┘
```

### 4.2 服务清单与所有权

| 服务 | 镜像来源 | 职责 | 是否自建配置 | profile |
| --- | --- | --- | --- | --- |
| `mysql` | `mysql:8.4` 官方 | 索引投影存储 | 否（沿用现有定义） | 默认 |
| `migrate` | **复用 web 镜像**，覆盖 command | 一次性 schema 迁移 | 复用 | 默认（一次性） |
| `indexer` | **复用 web 镜像**，覆盖 command | drain 调度循环 | 复用 | 默认 |
| `web-blue` / `web-green` | **自建，同一个 Dockerfile** | UI + API | **是** | prod |
| `web`（开发单槽） | 同上 | 本地开发 | 复用 | 默认（dev override） |
| `nginx` | `nginx:alpine` 官方 | TLS + 反代 + 上游切换 | nginx.conf + 模板 | prod |
| `chain` | 自建或官方 | 本地演示链 | 可选 | `local` |
| `prometheus` | `prom/prometheus` | 采集 + 告警规则 | scrape / rules | `observability` |
| `alertmanager` | `prom/alertmanager` | 告警路由 / 抑制 / 静默 | 配置 | `observability` |
| `grafana` | `grafana/grafana` | 看板 | provisioning + 看板 JSON | `observability` |
| `node-exporter` | `prom/node-exporter` | 宿主机指标 | 否 | `observability` |
| `cadvisor` | `gcr.io/cadvisor/cadvisor` | 容器指标 | 否 | `observability` |
| `mysqld-exporter` | `prom/mysqld-exporter` | MySQL 指标 | 否 | `observability` |
| `blackbox-exporter` | `prom/blackbox-exporter` | 探 `/api/health` 与外部可达性 | 配置 | `observability` |

### 4.3 核心架构决策：一个镜像，三个角色

**web / migrate / indexer 共用同一个 Dockerfile 与同一个镜像，仅以 `command` 区分。**

理由（这同时是本阶段最重要的熵控制决定）：

1. 三者共享同一份依赖树、同一份 `lib/db/`（schema、pool、migrate）与同一份 `lib/indexer/`（decode、plan、sync）。若给 indexer 单独一个 Dockerfile，**事件解码逻辑与 schema 就会产生第二份构建产物**——而本项目刚刚在批一吃过"同一条规则写在两个地方"的三次亏（见 `plans/2026-09-22-voting-mechanisms-and-platform-depth.md` 第 27-33 行）。
2. 同一镜像意味着 `migrate`、`drain`、`check-consistency` 与 web 运行时**版本严格一致**。分别构建则会出现"迁移脚本是新版、运行时是旧版"这种只在部署当天暴露的错配。
3. 这是 12-factor 的进程模型：同一份代码，不同进程角色，可独立重启与扩缩容。

对应 ADR 信号见 §12。

---

## 5. 兼容边界与非目标（先写清，避免实现期漂移）

### 5.1 必须保持的兼容边界

| 边界 | 具体约束 | 违反的后果 |
| --- | --- | --- |
| 既有 compose 命令 | `docker compose up -d mysql` 仍可用；服务名 `mysql`、宿主机端口 `3307` 不变 | README 文档漂移；既有开发者工作流被打断 |
| schema 单一所有者 | 不得出现 `docker-entrypoint-initdb.d` 或任何第二处 schema 定义 | 违反 C2 与 ADR-0006，直接制造双所有者 |
| `/api/health` 契约 | JSON 结构不变；`/api/metrics` 为新增表面，不替换 | 前端 `HealthPanel` 与 `health-report.ts` 的 14 个用例会失效 |
| `lagBlocks` 的 null 语义 | 指标层不得把 null 渲染为 0 | 违反 ADR-0015，制造"读不出来 = 同步好了"的假保证 |
| 应用不依赖监控 | 监控栈不参与应用启动路径 | 违反 ADR-0006 的"可选依赖"原则 |
| CI 既有 job | 5 个 job 的语义不变；`abi-drift` 的字节级守护不变 | ABI 陈旧会静默进入产物 |
| 私钥不落后端 | 部署流水线不得引入任何持币私钥 | 违反本项目首要安全不变量 |
| 失败不回显值 | 脚本、日志、告警文案不得打印密钥值 | 违反 ADR-0016 / ADR-0020 |

### 5.2 非目标（本阶段明确不做，且写清理由）

| 非目标 | 理由 |
| --- | --- |
| Kubernetes / k3s | 单机单应用的编排收益远小于其运维复杂度。简历上"会用 k8s"不如"能讲清发布与回滚的每一次失败模式"；投入 1-2 周换取词汇量，性价比为负 |
| Docker Swarm | 单机 Swarm 有"为了用而用"的味道，且 2026 年就业市场价值低于 k8s。双槽 nginx 以 1-2 天拿到同样的"零停机"叙事 |
| Terraform / 云资源 IaC | 本阶段只有一台既有服务器，IaC 的收益主要在"多环境可重建"。**可选延伸**：一次 Ansible playbook 做服务器初始化（用户、Docker 安装、防火墙、日志轮转）成本很低，但不在本阶段承诺范围内 |
| 集中日志（Loki / ELK） | 单机场景下 `docker compose logs` + json-file 轮转已足够排障。若时间允许可作为延伸，但**不作为验收项**，避免"装了没用" |
| MySQL 高可用 / 读写分离 / 备份自动化 | 索引是**可重建的投影**（ADR-0001），备份的价值远低于链上数据本身。明确不做，并在文档里写明"索引损毁的恢复路径是重建，不是恢复备份" |
| 多环境（staging / prod 双集群） | 双槽机制本身就是"新版本先在未启用的槽位接受健康检查"的预演环境 |
| 服务网格 / API 网关 | 单机单应用，nginx 足够 |
| Vault / 密钥管理服务 | GitHub Environments secrets + 服务器 `.env`（600）+ 专用部署密钥已覆盖威胁模型。引入 Vault 会把"多一个会挂的组件"加进启动路径 |
| 链节点自身的深度监控 | 本阶段只监控"应用能否读到链"（通过 health/lag 指标体现），不监控节点内部的 p2p/同步状态 |
| 应用代码的功能性改动 | 唯一允许的代码改动是新增 `/api/metrics` 路由与 `next.config.ts` 加 `standalone`，二者都不改变既有行为 |

---

## 6. 交付物 1：Dockerfile 设计

### 6.1 结构：三阶段

| 阶段 | 作用 | 关键点 |
| --- | --- | --- |
| `deps` | 装依赖 | `corepack enable`；`pnpm install --frozen-lockfile`；**先只 COPY 三个 manifest + lockfile**，源码后置，以复用层缓存 |
| `builder` | 构建 | 接收 `ARG NEXT_PUBLIC_*`；`pnpm --filter @voting/web build` |
| `runner` | 运行时 | 只带 `.next/standalone` + `.next/static` + `public`；`USER node` 非 root；`HEALTHCHECK` 打 `/api/health`；`--init` 处理信号 |

### 6.2 关键决定与理由

| 决定 | 理由 |
| --- | --- |
| 基础镜像 `node:24-bookworm-slim` | 项目在 Node 24 上验证过（CI 已 pin），`engines` 要求 ≥22.13；**不用 alpine**：`mysql2` 是 native-ish，musl 下需要额外构建步骤，收益不抵风险 |
| 构建上下文 = **仓库根**：`docker build -f web/Dockerfile .` | `pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 在根。上下文设成 `web/` 会让 `--frozen-lockfile` 失败或装出与 CI 不同的依赖树 |
| `next.config.ts` 增加 `output: "standalone"` | 否则 runner 阶段被迫携带整个 `node_modules`，镜像体积从约 200MB 涨到 1GB 以上。这是一个**非功能性**配置项，不改变任何行为 |
| `.dockerignore` 排除 `.env*`、`node_modules`、`.next`、`contracts/artifacts`、`coverage`、`*.log` | 构建上下文会整个发送给 daemon；`.env` 进上下文等于把密钥送进构建缓存 |
| 镜像瘦身目标 < 250MB | 可量化、可截图、可追问 |

### 6.3 必须验证的一条陷阱

`web/next.config.ts` 有 `serverExternalPackages: ["mysql2"]`，意味着 **mysql2 不被 bundle**，要靠 Next 的依赖追踪进入 standalone 输出。必须在构建后确认 `.next/standalone/node_modules/mysql2` 真实存在——**否则容器启动时才报模块缺失**。这条进 §13 验证清单。

### 6.4 镜像与环境的关系（C1 的落地方案）

采用 **build-arg 重建**：`NEXT_PUBLIC_LOCAL_RPC_URL` / `NEXT_PUBLIC_SEPOLIA_RPC_URL` 等作为 `ARG` 在 build 阶段注入，因此**镜像与环境绑定**，每次部署都重建镜像（tag 用 git sha，天然唯一）。

**被否掉的替代方案**：新增运行时配置端点，让浏览器在启动时拉取配置。否掉的理由：(a) 需要改动应用代码与 `wagmi` 初始化路径；(b) 极易把服务端的 `RPC_URL`（含 apiKey）泄给浏览器——而 `.env.example` 第 87-89 行已明确区分了服务端与浏览器端两套变量，混淆二者是安全缺陷而非便利。此取舍记入 ADR 信号（§12）。

---

## 7. 交付物 2：Docker Compose 设计

### 7.1 文件分层

| 文件 | 用途 | 加载方式 |
| --- | --- | --- |
| `docker-compose.yml` | base：全部服务定义（含 profiles 标记） | 默认 |
| `docker-compose.override.yml` | 本地开发：源码挂载、暴露 3307/3001/9090、单槽 `web` | 默认自动叠加 |
| `docker-compose.prod.yml` | 生产：拉取不可变 tag 镜像而非 build、资源限额、`restart: unless-stopped`、日志轮转、双槽 web、nginx | `-f` 显式叠加 |
| `.env` / `.env.prod` | 环境值与密钥 | `env_file`，服务器上权限 600，git-ignored |

三种启动方式：

| 场景 | 命令 |
| --- | --- |
| 本地全栈（含自建链） | `docker compose --profile local up -d --wait` |
| 本地全栈 + 可观测性 | `docker compose --profile local --profile observability up -d --wait` |
| 生产 | `docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile prod up -d --wait` |
| 只要一个 MySQL（既有用法，必须保持可用） | `docker compose up -d mysql` |

### 7.2 关键决定

| 决定 | 理由 |
| --- | --- |
| 依赖顺序全部用 `depends_on` 的 `service_healthy` / `service_completed_successfully`，**禁止 `sleep`** | `sleep` 是"猜"，healthcheck 是"知道"。mysql 已有 healthcheck；web 加一个打 `/api/health` |
| `migrate` 为一次性服务 + `service_completed_successfully` | 落实 C2：schema 仍由唯一所有者应用，只是换了个调用时机 |
| 一键拉起用 `up -d --wait` | 没有 `--wait`，"一键拉起"只是"一键启动进程"，与"环境已就绪"是两回事 |
| 网络分段：`backend`（`internal: true`）+ `edge` | mysql 不暴露到宿主机（生产）；prometheus 与 web 走内部网络，`/api/metrics` 不经 nginx |
| 监控栈用 `profiles: [observability]` 隔离，不写在应用启动路径上 | 落实 ADR-0006 的"可选依赖"原则：监控全挂，DApp 照常服务 |
| 日志 `json-file` + `max-size` / `max-file` | 不限制日志=把服务器磁盘交给运气。这也是 §9 磁盘告警之外的**第一道**防线 |
| web 容器 `INDEXER_ENABLED=false` | 索引由独立 worker 负责；两个进程同时 drain 会互相干扰（虽然幂等，但游标竞争会产生无意义的重放） |
| indexer 用 `while` 循环包住一次性 `drain` | `drain.ts` 是"drain 到 idle 就退出"（已读源码确认）。直接 `command: drain` 配合 `restart: always` 会变成忙循环。外层调度循环每轮间隔 `POLL_INTERVAL_MS`，并把 drain 的 JSON 摘要原样输出为结构化日志 |

### 7.3 生产 profile 的额外约束

- 镜像以**不可变 tag**（git sha）拉取，禁止 `latest`（`latest` 会让"回滚"与"重新部署"不可区分）。
- 为每个服务设置内存限额：监控栈自身约需 1.5GB 常驻，与 web/MySQL 争抢内存会导致 OOM kill 应用——**必须显式限额**，让超限的是监控而不是应用。
- `restart: unless-stopped`，且**不使用 `restart: always`**（运维误停容器后不该自动弹回来）。

---

## 8. 交付物 3：CI/CD 流水线设计

### 8.1 工作流划分

| 文件 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `push` / `pull_request` / `workflow_dispatch`（**新增 `workflow_call`**） | **保持不动**，仅增加可被调用的触发器，作为质量门 |
| `.github/workflows/release.yml` | `push` to `main`、`v*` tag、`workflow_dispatch` | 构建 → 扫描 → 推送 → 部署 |
| `.github/workflows/rollback.yml` | `workflow_dispatch`（必填 `tag`） | 一键回滚 |

新增 `workflow_call` 是对既有文件的**加法**改动，不改变原有触发语义（pull_request 与 push 行为不变）。

### 8.2 阶段设计

| 阶段 | 内容 | 关键决定与理由 |
| --- | --- | --- |
| **1 gate** | 调用 `ci.yml` | **部署必须依赖测试通过**。绝不能让镜像构建与测试并行、然后无条件部署——那样"测试通过才发布"就只是仪式 |
| **2 build** | `docker/setup-buildx-action` + `build-push-action`；`cache-from/to: type=gha`；`docker/metadata-action` 打 `sha-<short>` / `main` / semver | 仅构建 `linux/amd64`（除非服务器是 arm64，见 §15）。QEMU 多平台构建在没有对应硬件时只是把流水线拖慢数倍。**部署只使用 `sha-<short>` 这个不可变 tag** |
| **3 scan** | `aquasecurity/trivy-action` 扫 HIGH/CRITICAL 并阻断，`--format sarif` 上传 Security 页；`anchore/sbom-action`（Syft）出 SPDX SBOM；`actions/attest-build-provenance` 出构建证明 | 这三件构成"供应链安全"的可辩护叙事：**知道镜像里有什么、由谁构建、有没有已知漏洞** |
| **4 deploy** | SSH 到服务器：`pull` → 运行 `migrate` 一次性容器 → 启动目标槽 → 健康门 → 切换 nginx 上游 → 观察窗口 → 收尾 | 顺序不可颠倒：新 schema 必须先于新代码就绪（且必须向后兼容，见 §10.3） |
| **5 health-gate** | 轮询 `/api/health` 直到 200 或超时；失败即回滚 | 把"部署成功"从"命令退出码 0"变成"服务真的在服务"。**这是整条流水线里最重要的一步** |

### 8.3 部署与回滚的实现位置

部署逻辑放进仓库而非内联在 YAML 里：

| 文件 | 作用 |
| --- | --- |
| `ops/deploy/deploy.sh` | 发布：拉镜像、迁移、启槽、健康门、切上游、观察 |
| `ops/deploy/rollback.sh` | 回滚：把上游切回上一槽并 reload；必要时按 tag 重建 |
| `ops/deploy/health-gate.sh` | 轮询健康端点，超时非零退出 |
| `ops/deploy/state/previous-tag`、`active-slot` | 服务器侧状态（非入库），是回滚能力的载体 |
| `ops/nginx/templates/upstream.conf.tmpl` | 上游模板，由 `active-slot` 渲染 |

理由：内联 YAML 里的 shell 无法在本地演练，而"没演练过的部署脚本"等于没有回滚能力。脚本入库后，**CI 与人工操作跑的是同一份代码**——这正是运维手册（runbook）该有的性质。

### 8.4 密钥与安全

| 项 | 方案 | 理由 |
| --- | --- | --- |
| 镜像仓库 | `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`（非密码） | Token 可撤销、可限权 |
| SSH 认证 | 专用 ed25519 部署密钥（无 passphrase），存 `secrets.SSH_KEY` | 不用密码登录；密钥仅能登录该服务器 |
| 主机校验 | **`SSH_KNOWN_HOSTS` 作为 secret 固定**，禁用 `ssh-keyscan` 兜底 | `ssh-keyscan` 会把中间人当正常主机，等于没有主机校验 |
| 服务器账户 | 专用 `deploy` 用户加入 `docker` 组，**不用 root** | 最小权限；`docker` 组本身等价 root，这一点在文档中如实写明而不假装更安全 |
| 生产审批 | GitHub `environment: production` + required reviewers | 人工审批本身就是运维职责的体现 |
| 并发控制 | `concurrency: {group: deploy-production, cancel-in-progress: false}` | 两次部署互相踩会产生无法解释的状态 |
| 配置注入 | 服务器侧 `.env`，权限 600 | 密钥不进仓库、不进镜像、不进构建缓存 |
| 不回显 | 脚本只打印变量名与形状，绝不打印值 | ADR-0016 / ADR-0020 |

### 8.5 不使用 `pull_request_target`

公开仓库的第一条纪律。`pull_request_target` 会把 secrets 暴露给来自 Fork 的不可信代码。本阶段不使用该触发器。

---

## 9. 交付物 4：Prometheus 可观测性设计

### 9.1 指标端点

**新增 `GET /api/metrics`**（Next.js Route Handler，`dynamic = "force-dynamic"`），输出 Prometheus 文本格式。

**决定：手写 exposition，不引入 `prom-client`。** 理由：

1. 指标集合是固定的十来个，手写文本格式的代码量与维护面都更小；
2. 避开 `prom-client` 默认注册表在 Next 热重载/多进程下的重复注册陷阱；
3. 避开 `prom-client` 在 standalone 构建下的打包与依赖追踪问题（与 §6.3 同源的坑）。

### 9.2 指标清单（全部从已有状态派生，不新造数据所有者）

| 指标 | 来源 | 类型 | 备注 |
| --- | --- | --- | --- |
| `voting_up` | 进程 | gauge | 存活 |
| `voting_chain_head_block` | `chainHead` | gauge | 不可读时不导出 |
| `voting_index_last_block` | `lastIndexedBlock` | gauge | 同上 |
| `voting_index_lag_blocks` | `lagBlocks` | gauge | **null 时整个序列 absent**，见 §9.3 |
| `voting_index_configured` | `indexConfigured` | gauge 0/1 | |
| `voting_indexer_loop_enabled` | `indexerLoopEnabled` | gauge 0/1 | 与"索引已配置"分开报告（ADR-0013） |
| `voting_poll_count` | `pollCount` | gauge | 读链失败时不导出 |
| `voting_index_errors_total` | `indexError` 变化驱动 | counter | 口径见 §9.4 |
| `voting_index_sync_duration_seconds` | 索引循环 | histogram | |
| `voting_http_requests_total{method,route,status}` | 路由包装 | counter | RED 指标 |
| `voting_http_request_duration_seconds` | 路由包装 | histogram | |
| `voting_db_pool_connections{state}` | `lib/db/pool.ts` | gauge | 无索引时 absent |
| `process_resident_memory_bytes` / `nodejs_eventloop_lag_seconds` | `process.*` | gauge | 手写取值，不引额外依赖 |

### 9.3 核心设计：null 必须表现为 absent，而不是 0

这是本项目 `lagBlocks` 语义（ADR-0015）在运维层的延续，也是本阶段**最有辨识度的一个设计点**。

- **规则**：当 `lagBlocks` 为 `null`（链读不到 / 无索引 / 游标不可读）时，**不导出 `voting_index_lag_blocks` 这一行**。
- **理由**：导出 0 等于向监控系统宣称"索引完全跟上链头"，而这三种情形下恰恰是**无法回答**该问题。这与 ADR-0015 拒绝把 null 打印成 0 是同一条原则，只是读者从页面换成了 Prometheus。
- **代价与应对**：`> 25` 这类比较规则在序列缺失时**静默失效**（Prometheus 的缺席不等于 0）。因此必须配一条基于 `absent()` 的独立告警，否则"索引整个挂掉"反而不会报警——**这正是本设计要防的那个失败模式**。

### 9.4 口径必须写明的两处

| 项 | 口径 | 为什么必须写明 |
| --- | --- | --- |
| `voting_index_errors_total` | 由健康读数的 `indexError` 字段**变化**驱动，因此是**单进程内**的近似计数；进程重启会归零 | 这是 gauge 派生的计数器，不是真正的累计计数器。若将来多实例，必须改为按实例打标签或改用 Pushgateway。不写明就是埋了一个"数为什么对不上"的坑 |
| `voting_indexer_loop_enabled` | 容器化后 web 侧恒为 0（索引交给独立 worker） | 否则读者会以为"索引循环坏了"。指标本身正确，但需要文档解释拓扑 |

### 9.5 告警规则

| 规则 | 表达式（示意） | 在防什么 |
| --- | --- | --- |
| `VotingIndexLagHigh` | `voting_index_lag_blocks > 25` for 5m | 索引确实落后 |
| `VotingIndexLagUnknown` | `absent(voting_index_lag_blocks) and on() voting_index_configured == 1` for 10m | **ADR-0015 的运维化表达**：滞后量不可读 ≠ 同步正常 |
| `VotingIndexErrors` | `increase(voting_index_errors_total[10m]) > 0` | 解码/插入失败 |
| `VotingHealthDegraded` | blackbox `/api/health` 非 200 for 3m | 服务降级 |
| `VotingApiErrorRate` | 5xx 占比 > 2% for 5m | 接口质量 |
| `ContainerDown` | `up == 0` for 2m | 容器死亡 |
| `MySQLDown` | `mysql_up == 0` for 2m | 数据库不可用 |
| `HostDiskWillFillIn4Hours` | `predict_linear(node_filesystem_avail_bytes[6h], 4*3600) < 0` | 磁盘将在 4 小时内写满（含预测，而非只看当前值） |
| `DeployVersionDrift`（延伸） | 运行中的版本标签 ≠ 期望标签 | 部署没有真正生效（见 §9.7） |

### 9.6 Alertmanager 与 Grafana

- **Alertmanager**：分组（按 `alertname` + 实例）、`inhibit_rules`（主机级故障抑制其上的容器告警，避免告警风暴）、静默窗口。
- **必须配一个真实可达的接收端**（邮件 / 飞书 webhook / Discord 任一）。**没有接收端的告警等于没有告警**，这条以"告警真的到达了"的截图作为验收证据。
- **Grafana 三块看板，JSON 入库提交并用 provisioning 自动加载**（不手工点击配置）：
  1. **业务**：链上高度 vs 索引高度双线、`lagBlocks`、投票数、投票速率；
  2. **API RED**：请求速率 / 错误率 / 时延分位；
  3. **主机与容器**：CPU / 内存 / 磁盘 / 网络 + 容器重启次数。
- 看板入库的意义：`--profile observability up` 之后看板**已经存在**，这正是"一键拉起"该有的含义。

### 9.7 部署版本可见性（低成本高回报的延伸）

由 `deploy.sh` 把当前生效的 tag 与槽位写成 node-exporter 的 textfile collector 文件，得到 `voting_deploy_info{tag,slot}`。收益：

- Grafana 上直接标注"这次告警发生在哪个版本"（发布与告警的时间轴对齐）；
- `DeployVersionDrift` 规则可以检测"CI 说部署成功了，但线上跑的还是旧版本"——这是仅靠健康门**检测不到**的一类失败。

### 9.8 保留与容量

- `--storage.tsdb.retention.time=15d`，volume 持久化；
- 在文档中写明磁盘占用估算与依据（而非"应该够用"）；
- 与 §7.2 的容器日志轮转一起，构成两道磁盘防线。

---

## 10. 方案 B：双槽零停机发布

### 10.1 机制

两个槽位服务 `web-blue` / `web-green` 使用**同一个镜像**（不同 tag），nginx 上游只指向其中一个。发布流程：

```text
1. 读 active-slot（当前生效槽位）
2. 计算 target = 另一个槽位
3. 以新 tag 启动 target 槽（旧槽继续对外服务）
4. 健康门：直接打 target 槽的 /api/health，直到 200 或超时 → 失败则停掉 target，旧槽不受影响
5. 渲染 upstream.conf 指向 target，nginx -s reload（graceful：旧 worker 处理完在途请求才退出）
6. 观察窗口：持续探测，确认错误率与延迟正常
7. 收尾：把 target 写入 active-slot，旧 tag 写入 previous-tag；旧槽保留一段时间（作为秒级回滚的保障）
```

### 10.2 为什么这是"真"零停机

- `nginx -s reload` 是 **graceful** 的：旧 worker 不会切断已建立的连接，新 worker 用新上游配置接管新请求。切换窗口内不丢请求。
- 新版本在**对外服务之前**就已通过健康门，因此不存在"发布即 5xx"的窗口。
- **回滚 = 把上游切回去 + reload**，是秒级操作、不依赖镜像拉取、不依赖流水线可用。这是双槽相对于"原地 `up -d`"最本质的优势。

### 10.3 与 schema 迁移的相互作用（本阶段最容易被忽略的约束）

发布期间**新旧两个槽位同时连接同一个 MySQL**，因此：

- `migrate` 必须在**旧槽仍在服务**的情况下执行，也就是说 **schema 变更必须向后兼容**（expand-contract）：
  - 允许：新增表 / 新增列（带默认值）/ 新增视图 / 新增索引；
  - **禁止在同一次发布里**删除或重命名旧槽仍在读写的列与视图。
- 破坏性变更拆成两次发布：第 N 次加新结构并双写/回填，第 N+1 次（确认无旧版本运行后）删除旧结构。
- **因此"回滚"的定义是：回滚应用镜像，不回滚 schema。** 这条必须写进 runbook，否则某次"回滚后服务起不来"会被误判为回滚机制失效，而真实原因是那次迁移不向后兼容。

> 这条约束同时回答了面试里那个几乎必问的问题："数据库迁移了，你怎么回滚？"

### 10.4 双槽带来的成本（如实记录）

- 发布期间两个槽同时在内存中（内存需按两倍 web 预算；`web` 本身很轻，可接受）。
- nginx 上游由文件模板渲染 + reload，多了一处可能与实际状态不一致的地方 → 用 `active-slot` 文件作为**单一状态载体**，并由 `deploy.sh` 与 `rollback.sh` 共同读写，不允许手工编辑上游文件。
- 复用 `docker` 网络别名实现槽位切换，避免为每个槽硬编码端口。

---

## 11. 服务器侧前置任务

| 任务 | 内容 | 证据 |
| --- | --- | --- |
| 服务器初始化 | 建 `deploy` 用户、安装 Docker Engine + compose 插件、`ufw` 仅放行 22/80/443（9090/3001/9101 等监控端口**不对公网暴露**）、启用 Docker 日志轮转 | `docker info`、`ufw status` 输出 |
| 目录结构 | `/srv/voting/{compose,ops,.env,state}`；`.env` 权限 600 | `ls -l` 输出（不含值） |
| 域名与 TLS | 域名 A 记录 + certbot 证书，certbot renew 定时任务 | `curl -I https://<域名>/api/health` 返回 200；证书有效期输出 |
| GitHub | 建仓库并 `git remote add`、配 Environment `production` 与 required reviewers、写入全部 secrets | `gh secret list` 输出（仅名字） |
| Docker Hub | 建仓库、建 access token | |
| 本地 | **修复 Docker 引擎**（§3.3 阻塞项） | `docker run --rm hello-world` 成功 |

---

## 12. ADR 信号（实施期需落为正式 ADR）

| 拟定 ADR 主题 | 决策 | 被否掉的替代方案 |
| --- | --- | --- |
| 一个镜像承载 web / migrate / indexer 三个角色 | 单一 Dockerfile + 不同 `command` | 按角色拆多个 Dockerfile（会造成解码逻辑与 schema 的第二份构建产物） |
| 镜像按环境重建，而非运行时注入 `NEXT_PUBLIC_*` | 每次部署以 build-arg 重建，tag = git sha | 运行时配置端点（需改应用代码，且易把服务端 `RPC_URL` 泄给浏览器） |
| 监控栈不参与应用启动路径 | compose profiles 隔离 | 监控与监控对象同生共死（会把"监控挂了"升级为"服务挂了"） |
| `lagBlocks` 不可读时序列 absent，配 `absent()` 告警 | 指标层保持 null 语义 | 导出 0（制造"读不出来 = 同步好了"的假保证，违反 ADR-0015） |
| schema 迁移采用 expand-contract，回滚不含 schema | 破坏性变更拆两次发布 | 迁移可逆（在双槽并存下不可行） |
| 部署只使用不可变 tag | tag = `sha-<short>`，禁用 `latest` | 用 `latest`（会让回滚与重新部署不可区分） |
| 部署逻辑入库为脚本而非内联 YAML | `ops/deploy/*.sh`，CI 与人工共用 | 内联 YAML（无法本地演练，等于没有回滚能力） |

---

## 13. 验收标准与证据清单

### 13.1 必须实测并留证的项目

| # | 验收项 | 证据形式 | 证伪方式（负向对照） |
| --- | --- | --- | --- |
| 1 | 全新机器一键拉起 | `docker compose ps` 全 healthy 截图 | 故意去掉一个 healthcheck → `--wait` 必须失败 |
| 2 | 镜像体积 | `docker image ls` 字节数 | 去掉 `standalone` → 体积应显著上升（证明该配置确实生效） |
| 3 | `mysql2` 进入 standalone 输出 | `.next/standalone/node_modules/mysql2` 存在 | 移除 `serverExternalPackages` → 应改变输出（证明追踪路径真实） |
| 4 | 零停机发布 | 发布期间持续探测 `/api/health` 的时间序列，**失败请求数为 0** | 改用原地 `up -d` 重跑同一探测 → 应出现失败请求（这是方案 B 的证伪点） |
| 5 | 回滚 | 坏镜像 → 健康门失败 → 回滚后服务恢复的截图 | 回滚后 `active-slot` 与 `previous-tag` 必须与发布前一致 |
| 6 | 告警到达 | `ContainerDown` 到达接收端的截图 | 杀掉 web 容器后 2 分钟内必须触发 |
| 7 | 区分 absent 与 0 | `VotingIndexLagHigh` 与 `VotingIndexLagUnknown` **分别**被触发 | 只测其中一个无法证明二者被区分 |
| 8 | schema 幂等仍在容器内成立 | `migrate` 连续执行两次成功 | — |
| 9 | 应用不依赖监控 | 关闭全部监控容器后，`/api/health` 仍 200 | 这是 ADR-0006 的回归测试 |
| 10 | 既有 compose 命令未破坏 | `docker compose up -d mysql` 仍可用且端口仍为 3307 | README 第 271 行的命令可原样执行 |
| 11 | 密钥不泄漏 | `grep` 全仓库与镜像层，无密钥值；脚本输出无值 | 故意在脚本里 `echo` 密钥 → 评审必须能抓到（证明检查有效） |

### 13.2 简历可辩护性映射

| 简历关键词 | 项目里的真实证据 | 面试会追问 |
| --- | --- | --- |
| Docker 多阶段构建 / 镜像瘦身 | §6 的三阶段 + standalone，实测体积 | 为什么 standalone？mysql2 为什么不能被 bundle？哪一步破坏了层缓存？ |
| Docker Compose 编排 | 分层文件 + profiles + healthcheck 依赖 | `service_healthy` 与 `sleep` 差在哪？migrate 为什么不能进 initdb？ |
| CI/CD 流水线 | 5 阶段流水线，测试门 → 扫描 → 审批 → 部署 → 健康门 | 怎么保证"测过的"就是"部署的"？（不可变 tag / digest） |
| 零停机发布 / 蓝绿 | 双槽 + nginx graceful reload + 失败请求数为 0 的实测 | 切换瞬间在途请求怎么办？两个版本同时连一个库怎么办？ |
| 回滚 | 秒级上游切换 + `previous-tag` + 演练截图 | schema 已经迁移了怎么回滚？ |
| 镜像安全 / 供应链 | Trivy SARIF + SBOM + provenance | 扫出的 HIGH 怎么处置？豁免怎么管？ |
| Prometheus 指标设计 | 13 个指标 + null/absent 区分 | 为什么"读不出来"不能报 0？counter 在多实例下怎么算？ |
| 告警规则 / 降噪 | 9 条规则 + inhibit_rules + 真实接收端 | 哪条会误报？告警来了先看哪个看板？ |
| Linux / 主机运维 | 防火墙最小放行、日志轮转、磁盘预测告警、非 root 部署用户 | 磁盘满了怎么定位？OOM 怎么看？为什么监控端口不对公网暴露？ |
| 密钥管理 | Environments secrets + `.env` 600 + 专用部署密钥 + 固定 known_hosts | 为什么不用密码？为什么不用 ssh-keyscan？密钥怎么轮换？ |

---

## 14. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Docker 引擎不可用（**已发生**） | 本阶段全部"已实测"主张无法成立 | 阶段第一步先修复；修复前不做任何"已验证"声明 |
| `NEXT_PUBLIC_*` 构建期内联 | 镜像与环境耦合，无法"构建一次多处部署" | 接受并写入 ADR；若将来需要，再评估运行时配置端点 |
| 监控栈内存占用（约 1.5GB） | 小内存机器 OOM 会杀掉应用 | 服务器建议 ≥2C4G；为每个容器设内存限额，让超限的是监控而非应用 |
| `absent()` 规则被漏配 | "索引整个挂掉"反而不告警 | §13.1 第 7 项把"区分 absent 与 0"作为独立验收项 |
| 不向后兼容的迁移 | 双槽并存期新槽读写失败；回滚后服务起不来 | §10.3 的 expand-contract 约束 + runbook 明确"回滚不含 schema" |
| 告警没有被真正送达 | 演练时才发现接收端配错 | 以"告警到达接收端"的截图作为验收项，而不是以"规则已配置" |
| 服务器时间/时区不一致 | 日志与告警时间轴错位，排障困难 | 容器统一 `TZ`，Prometheus 与主机时区一致；在文档中写明 |
| 磁盘写满 | 数据库损坏、部署失败 | 容器日志轮转 + 15 天指标保留 + 磁盘预测告警，三道防线 |

---

## 15. 待补信息（不阻塞设计方向，影响实施细节）

| # | 待确认 | 影响 |
| --- | --- | --- |
| 1 | 服务器发行版与版本（Ubuntu/Debian/CentOS…） | Docker 安装方式、防火墙工具（ufw/firewalld） |
| 2 | 服务器 CPU 架构（amd64 / arm64） | 镜像构建平台；arm64 需要 `buildx` 对应平台或改为在服务器上构建 |
| 3 | 服务器内存与磁盘 | 监控栈是否放同机；指标保留期 |
| 4 | 是否有域名、能否签 TLS 证书 | nginx 是否配 HTTPS；只有 IP 时退化为 HTTP + 自签 |
| 5 | 部署后应用读哪条链（Sepolia 真实链 / 服务器上跑本地链容器） | 决定 `RPC_URL` 与 `NEXT_PUBLIC_*` 的取值，以及是否需要 Sepolia 测试 ETH |
| 6 | 告警接收端偏好（邮件 / 飞书 / Discord / 其他） | Alertmanager 接收器配置 |
| 7 | GitHub 仓库可见性（公开 / 私有） | Docker Hub 免费额度的私有仓库数量限制 |

**推荐默认值**（若未另行指示则按此实施）：

- 服务器上以 `chain` 容器跑一条本地链作为**演示环境**，同时保留 Sepolia profile 指向真实链——两者用 profile 切换，互不干扰。
- 告警接收端先用邮件（零额外依赖），飞书/企业微信 webhook 作为延伸。
- 仓库**公开**（简历场景需要可被面试官访问；secrets 全部集中在 Environments，不进仓库）。
- 服务器 ≥ 2C4G，监控栈与 DApp 同机，全部容器设内存限额。

---

## 16. Spec Self-Review

| 检查项 | 结果 |
| --- | --- |
| 占位符扫描 | 无 TBD / TODO。"待补信息"（§15）是**刻意的外部输入清单**，每项都给了推荐默认值，不阻塞开工 |
| 内部一致性 | §4.3 的"一个镜像三角色"与 §6 的 Dockerfile 设计一致；§10.3 的 expand-contract 与 §8.2 第 4 阶段的顺序一致；§9.3 的 absent 设计与 ADR-0015 一致 |
| 边界检查 | 不变量 6 条（§1）、兼容边界 8 条（§5.1）、非目标 10 条（§5.2）均已显式标注 |
| 所有者检查 | 未新增数据所有者：指标全部派生自既有 `getHealth()`；schema 所有者未变（§5.1） |
| ADR 信号 | 7 项已登记（§12），含被否掉的替代方案与理由 |
| 复杂度检查 | 新增表面共 4 类：1 个 Dockerfile、4 个 compose 文件、3 个工作流 + 4 个脚本、1 个指标端点。全部有存在的理由；无重复所有者 |
| 歧义检查 | 已消除"谁来切换槽位"（§10.4 明确 `active-slot` 为唯一状态载体）、"回滚是否含 schema"（§10.3 明确不含） |
| 范围检查 | 面向单一实施计划，批次划分见后续 `writing-plans` 产出的计划文档 |

---

## 17. 后续步骤

1. **用户评审本规格**（`待用户评审` → `已确认`），并补 §15 的待确认信息；
2. 由 `writing-plans` 产出实施计划（`docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md`），按批次拆分为可执行任务；
3. 实施期遵守本规格 §5 的兼容边界与 §13 的验收标准；
4. 完成后新增基线记录 `docs/aegis/baseline/2026-09-22-containerization-and-delivery.md`，逐项标注**已实测 / 未实测**（沿用本项目既有的诚实标注风格）。
