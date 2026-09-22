# 实施计划：容器化、CI/CD 与可观测性

> 本计划由 `writing-plans` 产出，落在 `docs/aegis/plans/`。
> 它不是完成授权，也不替代规格与基线；执行中的完成声明仍需证据。
> 前序规格：`docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md`（状态：已通过评审）。
> 前序计划：`2026-09-22-voting-mechanisms-and-platform-depth.md`（批一至批三已完成，**批四前端体验尚未提交**，见 Task 0.3）。

## Progress

| 批次 | 任务                                              | 状态     | 证据                                                                                                                                                                    |
| ---- | ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 零   | Task 0.1 修复 Docker 引擎                         | **阻塞** | 根因见 §14；解除需管理员提权 + 重启，本会话做不到                                                                                                                       |
| 零   | Task 0.2 服务器初始化                             | 未开始   | —                                                                                                                                                                       |
| 零   | Task 0.3 GitHub / Docker Hub 准备                 | 未开始   | —                                                                                                                                                                       |
| 零   | Task 0.4 Sepolia 工厂重新部署 + 演示投票          | 未开始   | —                                                                                                                                                                       |
| 零   | Task 0.5 域名与 TLS                               | 未开始   | —                                                                                                                                                                       |
| 零   | Task 0.6 邮件（SMTP）接收端准备                   | 未开始   | —                                                                                                                                                                       |
| 一   | Task 1.1 standalone 产物                          | **完成** | `.next/standalone/web/server.js` 实测存在；typecheck 与 format 退出码均为 0；负向对照成立（改动前无该目录）。产物自包含性见 §14.4                                       |
| 一   | Task 1.2 Dockerfile 与 .dockerignore              | **阻塞** | 需 Linux 镜像才能验证；设计已按 §14.4 增补 `.env` 清除与自包含自检                                                                                                      |
| 一   | Task 1.3 compose base 扩写                        | 未开始   | —                                                                                                                                                                       |
| 一   | Task 1.4 indexer worker 入口                      | 未开始   | —                                                                                                                                                                       |
| 一   | Task 1.5 migrate 一次性服务                       | 未开始   | —                                                                                                                                                                       |
| 一   | Task 1.6 本地 override                            | 未开始   | —                                                                                                                                                                       |
| 一   | Task 1.7 一键拉起验收（含负向对照）               | 未开始   | —                                                                                                                                                                       |
| 二   | Task 2.1 `/api/metrics`                           | **完成** | 24 个新测试通过（全量 711 通过）；typecheck 0；构建含 `ƒ /api/metrics`；端到端 HTTP 200；lag 不可读时序列缺席已用真实数据验证；null→0 负向对照红了 2 个测试。详见 §14.5 |
| 二   | Task 2.2 metrics 不暴露公网                       | 未开始   | —                                                                                                                                                                       |
| 二   | Task 2.3 Prometheus 采集与告警规则                | 未开始   | —                                                                                                                                                                       |
| 二   | Task 2.4 exporters                                | 未开始   | —                                                                                                                                                                       |
| 二   | Task 2.5 Alertmanager 与邮件                      | 未开始   | —                                                                                                                                                                       |
| 二   | Task 2.6 Grafana provisioning 与看板              | 未开始   | —                                                                                                                                                                       |
| 二   | Task 2.7 部署版本可见性                           | 未开始   | —                                                                                                                                                                       |
| 二   | Task 2.8 三类故障演练                             | 未开始   | —                                                                                                                                                                       |
| 三   | Task 3.1 `ci.yml` 增加 `workflow_call`            | 未开始   | —                                                                                                                                                                       |
| 三   | Task 3.2 `release.yml`（门 → 构建 → 扫描 → 推送） | 未开始   | —                                                                                                                                                                       |
| 三   | Task 3.3 部署脚本三件套                           | 未开始   | —                                                                                                                                                                       |
| 三   | Task 3.4 SSH 部署 job                             | 未开始   | —                                                                                                                                                                       |
| 三   | Task 3.5 `rollback.yml`                           | 未开始   | —                                                                                                                                                                       |
| 三   | Task 3.6 流水线端到端验收                         | 未开始   | —                                                                                                                                                                       |
| 四   | Task 4.1 nginx 与上游模板                         | 未开始   | —                                                                                                                                                                       |
| 四   | Task 4.2 prod compose 双槽定义                    | 未开始   | —                                                                                                                                                                       |
| 四   | Task 4.3 `deploy.sh` 双槽流程                     | 未开始   | —                                                                                                                                                                       |
| 四   | Task 4.4 `rollback.sh` 秒级回滚                   | 未开始   | —                                                                                                                                                                       |
| 四   | Task 4.5 零停机证据与负向对照                     | 未开始   | —                                                                                                                                                                       |
| 四   | Task 4.6 expand-contract runbook                  | 未开始   | —                                                                                                                                                                       |
| 五   | Task 5.1 七条 ADR 落地                            | 未开始   | —                                                                                                                                                                       |
| 五   | Task 5.2 基线记录与简历材料                       | 未开始   | —                                                                                                                                                                       |

---

## 0. Aegis Visibility

本计划存在的理由：规格已经裁定"做什么"与"不做什么"，但规格里有一批**互相咬合的时序约束**——镜像必须在 CI 里由 git sha 标识、部署必须等测试门通过、迁移必须先于新代码并且必须向后兼容、健康门必须先于流量切换、回滚必须能在不拉镜像的前提下完成。这些约束任何一条放错顺序，都会产生"看起来部署成功了但线上是坏的"这种最难排查的故障。

另一个理由是 Task 0.4。本会话用一次只读链上调用证实了：**当前 Sepolia 工厂缺 `currentRulesHash`/`rulesHash`，且链上投票数为 0**（§13）。用户已选择"只接 Sepolia 真实链"，因此若不重部署，面试官打开页面看到的是一片 `unknown` 加零个投票——**方案再完整也演示不出来**。这条必须先清。

## 1. Goal

按六个批次把 DApp 交付形态做完，每批以可复现证据收尾：

| 批次 | 主题           | 交付的核心能力                                                                                    |
| ---- | -------------- | ------------------------------------------------------------------------------------------------- |
| 零   | 前置条件       | Docker 引擎可用、服务器就绪、仓库与镜像仓库就绪、Sepolia 部署与演示数据就绪、邮件通道打通         |
| 一   | 镜像与一键拉起 | 多阶段 Dockerfile、compose 分层与 profiles、migrate 一次性服务、indexer 独立 worker               |
| 二   | 可观测性       | `/api/metrics`、Prometheus 采集与 9 条告警规则、Alertmanager 邮件、Grafana 三块看板、三类故障演练 |
| 三   | CI/CD          | 测试门 → 构建 → 扫描/SBOM/证明 → 审批 → SSH 部署 → 健康门 → 回滚                                  |
| 四   | 零停机发布     | nginx 双槽、上游切换、秒级回滚、零停机与原地更新的双向对照证据                                    |
| 五   | 收尾           | 七条 ADR、基线记录（含"已实测/未实测"边界）、简历材料                                             |

**用户在本会话确认的三项决策：**

| 决策             | 结论                                                     |
| ---------------- | -------------------------------------------------------- |
| 云服务器         | 已有可用的 Linux 云服务器 → SSH 部署是真实生产发布       |
| 第二阶段监控产物 | 不存在，本阶段新建                                       |
| 交付范围         | A + B：单机 Compose + 双槽零停机（不含 Swarm、不含 k8s） |
| 部署环境的链     | **只接 Sepolia 真实链**（不跑本地链容器）                |
| 告警接收端       | **邮件（SMTP）**                                         |

**对规格 §4.2 的一处细化（记录在案）**：规格的服务清单里列了 `chain`（`--profile local`）服务。既然用户选择只接 Sepolia，本计划**退役该服务**：本地开发改为让容器通过 `host.docker.internal` 访问宿主机上已在运行的 `hardhat node`。profiles 因此只剩 `observability` 一个。这不是非目标变更，只是同一目标下更少的活动部件。

## 2. Scope Check：事实 / 假设 / 未知

```text
Scope Check:
- 事实（本会话已实测）:
  - web 与后端同进程：web/src/app/api/** 有 8 个 GET + 1 个 POST 路由，instrumentation.ts 在其中拉起索引循环
  - ci.yml 已有 5 个 job（contracts / abi-drift / web / indexer-e2e / format），覆盖单测、真 MySQL 幂等、端到端一致性
  - docker-compose.yml 只有 mysql（3307:3306，healthcheck，named volume），注释声明 schema 由 pnpm migrate 应用
  - 仓库内无任何 Dockerfile；grep prometheus|prom-client|/metrics|grafana|node_exporter → 0 命中
  - web/next.config.ts 无 output:"standalone"；有 serverExternalPackages:["mysql2"]
  - web/scripts/drain.ts 为一次性（drain 到 idle 退出，MAX_ROUNDS=1000），开头自行调用 migrate()，结束时打印 JSON 摘要
  - Sepolia 工厂 0xcf01c9d5… 有代码（1933 字节）、pollCount()=0、currentRulesHash() 三次调用均 revert
  - Sepolia 实现合约 0xb853ce67… 有代码 9127 字节（README 记录当前构建为 9125）
  - Docker 引擎不可用（npipe 连接失败）；两个 WSL 发行版均 Stopped；docker compose CLI v5.4.0 存在
  - node v24.14.0 / pnpm 11.25.0；本机 3306 有 MySQL；git remote 为空
  - 工作区有未提交的批四前端改动（web/src/lib/i18n/、ResultChart.tsx、TemplatePicker.tsx、
    wallet-connectors.ts、wagmi.ts 等）
- 假设（需在对应批次以负向对照验证）:
  - standalone 输出会包含 mysql2（依赖 serverExternalPackages 的追踪）→ Task 1.1 验证
  - pnpm workspace 下 standalone 的 server.js 位于 .next/standalone/web/server.js → Task 1.2 验证
  - 让 lagBlocks 变为 null（absent）可用"停掉 MySQL"精确触发 → Task 2.8 验证
- 未知（需在执行中消除，见 §12）:
  - 服务器发行版 / 架构 / 内存 / 是否 arm64
  - 是否已有域名
  - SMTP 提供方与凭据
  - Sepolia 部署账户是否仍有测试 ETH
  - Pinata 凭据是否可用（决定演示投票能否带 IPFS 元数据）
```

## 3. Baseline / Authority Refs

```text
BaselineUsageDraft:
- Required baseline refs:
  - docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md（全，本计划的直接依据）
  - docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md §5 §6 §11
  - docs/aegis/baseline/2026-09-20-initial-baseline.md §5.2（五条不变量）
  - docs/aegis/baseline/2026-09-21-optimization-pass.md
  - ADR-0001 / 0006 / 0010 / 0012 / 0013 / 0015 / 0016 / 0017 / 0020
  - CONTRIBUTING.md「先读这一节」、README.md（复现路径与已知局限）
- Delivered context refs:
  - 本会话已读: 见规格 §1 BaselineUsageDraft；另读 web/scripts/drain.ts（全）、
    web/src/lib/contracts/deployments.ts（全）、contracts/deployments/11155111.json（全）、
    plans/2026-09-22-voting-mechanisms-and-platform-depth.md（相关章节）
  - 本会话已实测: Sepolia 只读调用（§13）、Docker/WSL/node/pnpm/端口/git remote（§2）
- Acknowledged before plan refs:
  - docs/aegis/BASELINE-GOVERNANCE.md §6 七维审查将在每批结束时复核（本计划 §Risks 列出重点维度）
- Cited in plan refs: 见上 Required baseline refs
- Missing refs: 无
- Decision: continue
```

## 4. Requirement Ready Check

```text
Requirement Ready Check:
- Requirement source refs: 用户第三阶段四项动手实操 + 本会话 5 项决策（§1）+ 已评审通过的规格
- Goals and scope refs: §1 Goal、规格 §5.2 非目标
- User / scenario refs: 求职者本人（简历与面试演示）；云服务器运维者（发布、回滚、排障）
- Requirement item refs: 规格 §6 §7 §8 §9 §10
- Acceptance / verification criteria refs: 规格 §13、本计划「Verification」
- Open blocker questions: 服务器四项信息、域名、SMTP、Sepolia 测试 ETH（§12）
- Decision: ready（阻塞项集中在批零，且每一项都有明确的解除方式；不影响批一至批五的内容设计）
```

## 5. Change Necessity

```text
Change Necessity:
- User-visible need: DApp 能在真实服务器上一键拉起、自动发布、零停机、有监控告警，且每一环可被面试追问
- No-change / non-code option: 不可行。仅靠文档无法产生"零停机发布"与"告警真的到达"这两类证据，
  而这两类恰恰是运维岗位的核心能力主张
- Why code change is necessary:
  - 必须有容器镜像与编排定义，否则无法在服务器上复现运行环境
  - 必须有 /api/metrics，因为 Prometheus 无法消费现有的 JSON 健康端点
  - 必须有部署/回滚脚本，因为内联在 YAML 里的 shell 无法本地演练
- Minimum change boundary:
  - 应用代码改动仅 3 处，且都不改变既有行为：
    1) web/next.config.ts 增加 output:"standalone"
    2) 新增 web/src/lib/metrics.ts（纯函数，把健康读数格式化为 Prometheus 文本）
    3) 新增 web/src/app/api/metrics/route.ts（取数 + 输出）
  - scripts/drain.ts、schema、db 层、索引逻辑、合约源码均不改
- Decision: code-change
```

## 6. Existence Check

```text
Existence Check:
- Proposed new surface:
  - ops/ 目录（部署、nginx、prometheus、alertmanager、grafana、server 六类配置）
  - .github/workflows/release.yml 与 rollback.yml
  - web/src/app/api/metrics/route.ts 与 web/src/lib/metrics.ts
  - web/Dockerfile、.dockerignore、docker-compose.override.yml、docker-compose.prod.yml
- Existing owner / reuse candidate:
  - 健康数据的 owner 已存在：getHealth()（lib/data.ts），/api/metrics 必须复用它而不是新造状态
  - schema 迁移的 owner 已存在：lib/db/migrate.ts + scripts/migrate.ts，compose 只调用它
  - CI 质量门的 owner 已存在：.github/workflows/ci.yml，release.yml 只调用它
  - 观感/理由类规则已住在纯函数里（ADR-0027），metrics 格式化沿用同一惯例放进 lib/
- Why existing surface is insufficient:
  - 没有任何现存文件承载"进程角色划分""发布与回滚""告警规则"这三件事；规格 §3.2 已实测确认为全空
  - /api/health 返回 JSON，Prometheus 需要文本 exposition 格式，二者不能互相替代
    （且规格 §5.1 已把 /api/health 的契约列为不可变）
- Creation proof:
  - ops/ 下每个文件都对应规格中的一条验收项；没有"以后可能用得上"的文件
  - 每个新文件在本计划中都有唯一所属 Task 与验证命令
- Entropy / retirement impact:
  - 退役项：规格 §4.2 的 chain 服务（用户选择只接 Sepolia）
  - 不引入第二处 schema 定义、不引入第二处健康数据来源、不引入持私钥的后端组件
  - 不新增应用级 fallback 路径
- Decision: add-with-proof
```

## 7. TDD Route

```text
TDD Route:
- Mode: off
- Decision: skipped
- Strict authority: not applicable（用户未要求严格 TDD，项目亦未声明；沿用前序计划记录）
- Strict signals: 触及发布边界、安全（部署密钥）、可观测性契约——在 auto 下会要求 strict，但本会话 mode 为 off
- Light eligibility: 不适用（改动大且跨层）
- TDD-fit exception: 不适用
- Test posture: post-change regression + 负向对照（沿用本仓库既有做法）
- Reason: 本仓库的证据纪律是"先证明测试能失败"。本计划把该纪律落在两类负向对照上：
          (a) 代码级——metrics 的 null→0、standalone 的移除、healthcheck 的移除；
          (b) 机制级——零停机（持续探测失败数必须为 0）与原地更新（同一探测必须出现失败）
          的对照。后者是方案 B 唯一的证伪点，不可省。
- Verification: 每个 Task 的 Verification 段给出确切命令与预期
```

> 本计划不做 RED-GREEN 循环，但**强制负向对照**。特别是 Task 4.5：如果"原地 `up -d`"的对照也测不出失败请求，那说明探测方式无效，**零停机的主张不成立**，必须回到方案选择而不是宣布成功。

## 8. Architecture Integrity Lens

```text
Architecture Integrity Lens:
- Invariant（规格 §1 六条，逐条检查本计划影响）:
  1. 链上唯一事实源 —— 不受影响：不新增任何链下状态来源，索引仍只是投影
  2. schema 单一所有者 —— **受触及且必须守护**：compose 引入 migrate 服务，是最容易产生
     第二处 schema 定义的位置。处置：migrate 服务只执行既有 scripts/migrate.ts，
     禁止任何 /docker-entrypoint-initdb.d 挂载（Task 1.5 显式验证）
  3. 后端不持私钥 —— 受触及：部署链路新增 SSH 私钥。处置：部署密钥只用于 SSH，
     不得进入任何容器；SEPOLIA_PRIVATE_KEY 只在本地/CI 的部署步骤使用，不进镜像（Task 3.4 验证）
  4. lagBlocks 的 null 语义 —— **受触及且是本计划的核心设计点**：Task 2.1 的负向对照专门守护它
  5. 应用不依赖监控 —— 受触及：处置为 profiles 隔离，Task 1.7 与 Task 2.3 验证
  6. 失败不回显值 —— 受触及：部署脚本与告警文案不得打印密钥（Task 3.3 验证）
- Canonical owner / contract:
  - 健康数据 owner 仍是 getHealth()；/api/metrics 是它的第二个读者，不是第二个来源
  - schema owner 仍是 lib/db/schema.ts + scripts/migrate.ts
  - 发布状态 owner 是服务器侧 /srv/voting/state/{active-slot,previous-tag}；
    nginx 上游文件是**派生品**，不得手工编辑（Task 4.1 固化这条）
- Responsibility overlap:
  - 风险：nginx 上游文件与 state 文件都可能表达"谁在服务"。若不规定主从，二者会不一致。
    处置：active-slot 是唯一真相，upstream.conf 由模板渲染，任何人不得手改
  - 风险：web 的进程内索引循环与 indexer 容器都可能推进游标。处置：web 侧
    INDEXER_ENABLED=false 写死在 prod compose（Task 4.2 验证）
- Higher-level simplification:
  - 是否该用 k8s/Swarm 一次拿到滚动更新与回滚？**否**，理由见规格 §5.2。
    双槽 nginx 以更少的活动部件拿到同一能力，且每一层都可被追问到底
- Retirement / falsifier:
  - 退役 chain 服务（用户选择只接 Sepolia）
  - 若 Task 4.5 的负向对照测不出失败请求 → 方案 B 的机制前提被证伪，回退到方案 A 并如实记录
- Verdict: proceed
```

## 9. Plan Pressure Test

```text
Plan Pressure Test:
- Owner / contract / retirement:
  - 未新增数据所有者；退役 chain 服务已登记；/api/health 契约不变
- Architecture integrity / higher-level path:
  - 已考虑并拒绝 k8s/Swarm，理由记录在规格 §5.2 与 §8
- Verification scope:
  - 每个 Task 有确切命令；三类故障演练与零停机对照是本计划最强的证据
  - 已知缺口：arm64 服务器的镜像平台、SMTP 具体提供方，属 §12 待补，不阻塞批一至批四设计
- Task executability:
  - 批零的 6 个 Task 全部是"确认或安装"，无设计不确定性
  - 批一至批四每个 Task 的文件路径、命令、预期输出已给出
- Pressure result: proceed
```

## 10. Plan-Time Complexity Check

```text
Complexity Budget:
- Artifact class: 配置型为主（Dockerfile / compose / workflow / ops 配置），代码型仅 2 个新文件
- Target files / artifacts:
  - 新建约 22 个文件（ops/ 17、workflows 2、web 2、根 2 减已存在）
  - 修改 3 个既有文件（web/next.config.ts、docker-compose.yml、.github/workflows/ci.yml）
  - 应用源码改动约 3 行（next.config.ts）
- Current pressure:
  - docker-compose.yml 现为 33 行单服务；扩写后约 150 行（含 13 个服务）
  - ci.yml 现为 260 行；只加 1 行（workflow_call）
- Projected post-change pressure:
  - docker-compose.yml 达到"单文件承载过多职责"的临界点 → 处置：observability 服务用
    profiles 但配置外置到 ops/prometheus 等目录，compose 内只保留镜像/挂载/网络声明
  - 部署逻辑若写进 workflow YAML 会让 release.yml 膨胀且不可本地演练 → 处置：全部外置到 ops/deploy/
- Budget result: at-risk（docker-compose.yml 是唯一接近预算的文件）
- Planned governance:
  - 若 prod 与 base 的分歧继续增长，拆出 docker-compose.observability.yml 成为独立文件
    （触发条件：observability 服务数 > 8 或 base 文件超过 180 行）

Plan-Time Complexity Check:
- Target files: docker-compose.yml（33 → ~150 行）
- Existing size / shape signals: 单服务 33 行，结构清晰，有解释性注释
- Owner fit: compose 文件本就是"服务拓扑"的 owner，扩写属职责内
- Add-in-place risk: 监控栈与服务拓扑混在一个文件会让"改监控"与"改应用部署"变成同一次改动
- Better file boundary: 三文件分层（base / override / prod）+ 配置外置到 ops/
- Recommendation: add owner file（先按三文件分层落地；达触发条件再拆 observability 文件）
```

## 11. Execution Readiness View

```text
Execution Readiness View:
- Intent Lock: 把 DApp 交付形态做到"真实服务器上零停机发布 + 完整监控告警"，每环留实测证据
- Scope Fence:
  做：Dockerfile、compose 分层与 profiles、/api/metrics、Prometheus+Alertmanager+Grafana、
      9 条告警规则、邮件接收端、GitHub Actions 五阶段流水线、双槽 nginx 零停机、秒级回滚、
      Sepolia 重新部署与演示数据、七条 ADR、基线记录
  不做：k8s、Swarm、Terraform、Loki/ELK、MySQL 高可用/备份、多环境双集群、服务网格、
        Vault、链节点内部监控、任何应用功能性改动
- Baseline Lock:
  规格 §5.1 的 8 条兼容边界全部生效；规格 §1 的 6 条不变量不得破坏
  规格 §4.2 的 chain 服务退役已登记（用户选择只接 Sepolia）
- Approved Behavior: 见各 Task 的 Verification 段
- Owner / Contract Constraints:
  getHealth() 仍是健康数据唯一来源；schema 仍由 migrate.ts 唯一应用；
  active-slot 是发布状态唯一真相；/api/health 契约不变
- Compatibility Boundary:
  `docker compose up -d mysql` 必须继续可用（服务名与 3307 不变）；
  ci.yml 既有 5 个 job 语义不变；abi-drift 字节守护不变；
  scripts/drain.ts、db 层、索引逻辑、合约源码不改
- Retirement Boundary:
  规格 §4.2 的 chain 服务（本计划退役）；
  容器化后 web 侧 INDEXER_ENABLED 恒为 false（进程内索引循环在 prod 中退役，
  但代码保留且默认行为不变，因为它是 dev 便利）
- Task Batches: 批零 0.1-0.6 / 批一 1.1-1.7 / 批二 2.1-2.8 / 批三 3.1-3.6 / 批四 4.1-4.6 / 批五 5.1-5.2
- Test Obligations:
  每批结束：pnpm test、pnpm typecheck、pnpm format:check、pnpm build:web
  批一另需：docker compose --profile local up -d --wait 全 healthy
  批二另需：三类故障演练各留告警到达截图
  批四另需：零停机探测失败数为 0，且原地更新对照必须出现失败请求
- Review Gates:
  批二结束：告警规则逐条复核（表达式、for 时长、是否有接收端会真的收到）
  批四结束：全链路演练（发布 + 回滚 + 故障注入）
  批五：规格 §13.1 的 11 项逐项对照，标注已实测/未实测
- Drift / Rewind Rules:
  若 Task 1.1 发现 standalone 不含 mysql2 → 停止批一，先解决依赖追踪，不得用"多 COPY 一份
  node_modules"绕过（那会破坏 Task 1.1 的体积目标并掩盖问题）
  若 Task 2.8 无法让 lagBlocks 精确变为 absent → 记录该演练为未完成，不得用"导出 0 也能告警"替代
  若 Task 4.5 对照测不出失败请求 → 方案 B 前提被证伪，回退方案 A 并登记
- Evidence Required Before Completion:
  规格 §13.1 的 11 项全部有证据或明确标注未实测；七条 ADR 落地；
  基线记录含"已实测/未实测"边界；README 更新部署章节
- Advisory Boundary: method-pack execution guidance only; not GateDecision, PolicySnapshot, or completion authority
```

## 12. Open Questions（执行时按推荐值实施）

| #   | 问题                   | 推荐值                                                                            | 理由                                                          |
| --- | ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | 服务器 CPU 架构        | 先查 `uname -m`；若是 `aarch64` 则改在服务器本机构建或加 `platforms: linux/arm64` | 现在按 amd64 设计；架构错了镜像拉下来直接报 exec format error |
| 2   | 监控栈与 DApp 是否同机 | **同机**，但为监控容器设内存限额                                                  | 简历项目不值得第二台机器；限额保证超限的是监控而不是应用      |
| 3   | 演示投票的选项元数据   | 若 Pinata 凭据可用则 pin 真实元数据；否则退化为 CID 为空的投票并**如实记录**      | 不伪造 CID（ADR-0021 明确禁止手写 CID）                       |
| 4   | Grafana 是否对公网开放 | **不开放**，仅通过 SSH 隧道访问                                                   | 单机暴露 3001 是最常见的被扫目标；隧道足够自己看              |
| 5   | 是否给 nginx 加限流    | **加**，对 `/api/*` 做 basic rate limit                                           | 一行配置换一个可以讲的防护点；但不得影响正常轮询              |
| 6   | 服务器上是否需要 swap  | 内存 ≤2G 时加 2G swap                                                             | 监控栈 + Next 构建峰值容易触发 OOM                            |

## 13. 本会话新增的链上证据（Task 0.4 的依据）

用 `viem` 对 Sepolia 公共 RPC（`ethereum-sepolia-rpc.publicnode.com`）做**只读**调用，无交易、无私钥：

| 核查项                                                 | 结果                                  | 判定                                                   |
| ------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------ |
| 链头                                                   | 11756951 → 11756953（两次调用间增长） | RPC 可用                                               |
| 工厂 `0xcf01c9d51911f189b40d9287bcf21a638c36bf92` 代码 | 1933 字节                             | 合约存活（与 README 记录一致）                         |
| 实现 `0xb853ce67cdfa7e7d67c2ce0c2ef4f62a3d0add6b` 代码 | 9127 字节                             | 有代码；README 记录当前构建为 9125 字节，**差 2 字节** |
| `pollCount()`                                          | `0`                                   | 链上**没有任何投票**                                   |
| `currentRulesHash()`                                   | 连续 3 次 revert                      | **不存在**                                             |
| `rulesHash(address)`                                   | revert                                | **不存在**                                             |

结论（与 README 第 1054 行登记的隐患一致，现由链上调用证实）：

1. 当前 Sepolia 部署**早于** `rulesHash`/`currentRulesHash` 的 ABI 变更，页面的"规则承诺"会显示 `unknown`；
2. Sepolia 上没有任何投票可供演示；
3. 实现合约字节数与当前构建不一致（9127 vs 9125），即部署的不是当前这份字节。

因为用户选择"只接 Sepolia"，**Task 0.4 从"可选优化"升级为必做项**。

---

## Tasks

### 批零：清阻塞项与前置条件

#### Task 0.1 修复本机 Docker 引擎

**Files**：无仓库文件（环境操作）。若走备选路线，新建 `docs/aegis/work/2026-09-22-docker-engine/10-intent.md` 记录环境事实。

**Why**：实测 `docker version` 报 `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`，`wsl -l -v` 显示 `docker-desktop` 与 `Ubuntu` 均 `Stopped`。README 也记录过同一问题（"本机 Docker 引擎始终未就绪，API 持续返回 500"）。**引擎不可用则本计划没有任何一条能标"已实测"**，而按本项目的纪律，未实测的能力不得写进简历。

**Change Necessity**：纯环境修复，无代码改动。

**Impact / Compatibility**：无。

**Steps**

1. 启动 Docker Desktop 并等待引擎就绪（Docker Desktop 需要 GUI 启动，`wsl -d docker-desktop` 不能替代）。
2. 验证引擎：`docker version --format '{{.Server.Version}}'` 必须输出非空，`docker info --format '{{.OSType}}'` 必须是 `linux`。
3. 验证端到端：`docker run --rm hello-world` 必须成功。
4. 确认构建可用：在仓库根执行 `docker build --help > $null` 与 `docker compose config --quiet`。
5. **备选路线（若 Docker Desktop 仍返回 500）**：在 WSL2 的 `Ubuntu` 发行版内安装原生 Docker Engine，并把仓库克隆进 WSL 文件系统（例如 `~/src/decentralized-voting-dapp`）**而不是** `/mnt/d/...`。理由：跨文件系统 bind mount 会让 `node_modules` 的 I/O 与 inotify 显著变差，且换行与权限语义不同。走此路线时须在基线记录里写明"Docker 引擎位于 WSL2"，因为这会改变 Windows 侧的路径与端口可达性。

**Verification**

```bash
docker version --format '{{.Server.Version}}'
docker info --format '{{.OSType}} {{.MemTotal}}'
docker run --rm hello-world
cd decentralized-voting-dapp && docker compose config --quiet && echo "compose OK"
```

预期：服务器版本非空、`linux`、hello-world 成功、compose 校验通过。

---

#### Task 0.2 服务器初始化

**Files**

- 新建 `ops/server/README.md`（操作手册：命令 + 每条命令要留的证据；**不是**自动化脚本）
- 新建 `ops/server/daemon.json`（Docker 日志轮转）
- 新建 `ops/server/ufw.rules`（放行清单，供人工核对）

**Why**：服务器是部署边界的另一半。日志不轮转会打爆磁盘，防火墙不开会暴露 9090/3001，非 root 账户是 SSH 部署的前提。这些都是一次性但必须留下痕迹的操作。

**Change Necessity**：docs/config-only（不产生应用代码）。

**Impact / Compatibility**：无（新服务器）。

**Steps**

1. 在 `ops/server/README.md` 中按顺序写清并执行：创建 `deploy` 用户（`adduser --disabled-password`）→ 装入 `docker` 组 → 把 CI 用的 ed25519 公钥写入 `deploy` 的 `authorized_keys`（权限 700/600）。
2. 按 Docker 官方 apt 源安装 Docker Engine + `docker-compose-plugin`（**不用**发行版自带的旧 `docker.io`）。
3. 写 `ops/server/daemon.json`：`{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}`，安装到 `/etc/docker/daemon.json` 后 `systemctl restart docker`。
4. 写 `ops/server/ufw.rules` 并执行：`ufw default deny incoming`、`ufw default allow outgoing`、`ufw allow 22/tcp`、`ufw allow 80/tcp`、`ufw allow 443/tcp`、`ufw enable`。**9090（Prometheus）、3001（Grafana）、9093（Alertmanager）一律不放行**。
5. 建立目录：`/srv/voting/{compose,ops,state}`、`/srv/voting/state/textfile`；`chown -R deploy:deploy /srv/voting`。
6. 时区统一：`timedatectl set-timezone Asia/Shanghai`（或与读者的时区一致），并在 `ops/server/README.md` 记录该选择。理由：日志与告警的时间轴错位会让排障变成考古。
7. 在 `ops/server/README.md` 末尾记录实测输出：`uname -m`（**决定镜像平台，见 §12 第 1 项**）、`nproc`、`free -h`、`df -h /`。

**Verification**

```bash
ssh deploy@<server> 'docker info --format "{{.ServerVersion}} {{.LoggingDriver}}"; ufw status verbose; uname -m; free -h; df -h /; ls -ld /srv/voting'
```

预期：Docker 版本非空、logging driver 为 `json-file`；ufw 仅 22/80/443 放行；`uname -m` 已记录；`/srv/voting` 属主为 `deploy`。

---

#### Task 0.3 GitHub / Docker Hub 准备

**Files**

- 修改：无（外部配置）；本 Task 只产出 `ops/server/secrets.md`（列出 secret **名字**与用途，**不含任何值**）

**Why**：`git remote -v` 为空，Actions 无从触发；镜像仓库与全部 secrets 是批三的前置。

**Change Necessity**：docs/config-only。

**Impact / Compatibility**：**重要**——工作区当前有未提交的批四前端改动（`web/src/lib/i18n/`、`ResultChart.tsx`、`TemplatePicker.tsx`、`wallet-connectors.ts`、`wagmi.ts`、`CreatePollForm.tsx`、`PollBallot.tsx`、`ballot-labels.ts`，以及被改动的 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`web/package.json`）。**这些不是本计划的工作，本计划的任何 Task 都不得提交或回退它们。**

**Steps**

1. 先由用户决定批四未提交改动的归属：单独提交、`git stash`、或按原计划完成后提交。**在做完这个决定前不要 push**，否则历史里会混入一个未完成的工作流。
2. 在 GitHub 创建仓库（推荐**公开**：简历场景需要面试官能访问），`git remote add origin <url>`，push `main`。
3. 在 Docker Hub 创建仓库（例如 `<user>/voting-web`），生成 **access token**（不用登录密码）。
4. 在 GitHub 仓库建 Environment `production`，配置 **required reviewers**（生产发布需人工审批）。
5. 写 `ops/server/secrets.md`，逐个列出 secret 名字与用途：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`、`SSH_HOST`、`SSH_USER`、`SSH_KEY`、`SSH_KNOWN_HOSTS`、`SEPOLIA_RPC_URL`、`SEPOLIA_PRIVATE_KEY`、`DATABASE_URL`、`MYSQL_ROOT_PASSWORD`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASSWORD`、`ALERT_EMAIL_TO`。**该文件只写名字，绝不写值**（ADR-0016/0020）。
6. `SSH_KNOWN_HOSTS` 的取值必须来自**可信途径**（服务器控制台执行 `ssh-keyscan` 后人工核对指纹，或从云厂商控制台复制），不得在 workflow 里现扫——现扫等于没有主机校验。

**Verification**

```bash
git remote -v
gh secret list --env production
gh api repos/:owner/:repo/environments --jq '.environments[].name'
ssh-keyscan -t ed25519 <server> 2>/dev/null | ssh-keygen -lf -   # 与云端控制台显示的指纹核对
```

预期：remote 已配置；Environment 存在且带 reviewers；15 个 secret 名字齐备；指纹一致。

---

#### Task 0.4 Sepolia 工厂重新部署 + 演示投票

**Files**

- 修改 `contracts/deployments/11155111.json`（由 `deploy:sepolia` 写入）
- 修改 `contracts/deployments/archive/11155111-stale-<date>.json`（把旧记录归档，沿用既有做法）
- 修改 `web/src/lib/contracts/deployments.ts`（由 `pnpm export-abi` 生成）
- 修改 `README.md`（实测指标表中的 Sepolia 一行、已知局限中那条 ABI 陈旧说明）

**Why**：§13 的链上证据证明：当前工厂缺 `currentRulesHash`/`rulesHash`、`pollCount()` 为 0、实现字节数与当前构建差 2 字节。既然只接 Sepolia，不重部署就只能演示一片 `unknown` 和零个投票。

**Change Necessity**：必须重部署链上合约并更新被字节级守护的产物；`abi-drift` job 要求 `web/src/lib/contracts` 与链上记录一致。

**Impact / Compatibility**：新工厂地址 → 索引必须重建（游标从新部署区块开始）；旧地址上的数据作废（链上本来就是空的）。`deployments.ts` 是生成文件，不得手改。

**Steps**

1. 先确认部署账户余额：`0x409da00516d14a11b180df8460e3ffd68a239589`（`contracts/deployments/11155111.json` 的 deployer）。余额不足以重部署时**停止并报告**，不得改用其他私钥。
2. `pnpm --filter @voting/contracts deploy:sepolia`。脚本会在"该链已有不同地址记录"时告警——按 ADR-0010 与既有做法，把 `11155111.json` 先备份进 `deployments/archive/11155111-stale-<YYYY-MM-DD>.json`，再让它写入新记录。
3. `pnpm verify:sourcify`，要求两个合约都是 **`exact_match`**。这一步不是形式：上一轮正是靠它与链上运行时代码逐字节比对，才发现旧部署是陈旧的（README 已记录该教训）。
4. `pnpm export-abi`，然后 `git diff --exit-code -- web/src/lib/contracts` 应为**非空**（地址变了）。确认 `deployments.ts` 里 `deployedAt` 没有出现（ADR-0010 要求该字段不进被守护的产物）。
5. 逐项用只读调用复查新合约，方法与 §13 相同（把地址换成新地址）：`pollCount()` 可读、`currentRulesHash()` **不再 revert**、实现合约字节数等于当前构建（记录字节数）。
6. 创建演示投票：若 Pinata 凭据可用则 `pnpm pin:metadata` + `pnpm create-poll:sepolia`；否则创建不带元数据的投票，并在 README 与基线记录里**如实写明 CID 为空**。不得手写 CID（ADR-0021）。
7. 更新 `README.md`：实测指标表的 Sepolia 一行换成新地址与新区块；删除或改写"Sepolia 尚未用本轮代码重新部署"这条已知局限。
8. 提交上述产物。**只提交本 Task 涉及的文件**（`contracts/deployments/**`、`web/src/lib/contracts/**`、`README.md`），不得牵连批四的未提交改动。

**Verification**

```bash
pnpm build:contracts && pnpm test:contracts
pnpm export-abi && git status --short -- web/src/lib/contracts
# 只读复查（新地址）：
#   pollCount() -> 至少 1
#   currentRulesHash() -> 返回非零 bytes32
pnpm format:check
```

预期：测试全绿；`export-abi` 后产物与记录一致；新工厂 `currentRulesHash()` 不再 revert；链上至少 1 个投票；README 两处已更新。

---

#### Task 0.5 域名与 TLS

**Files**：新建 `ops/nginx/conf.d/00-tls.conf` 的证书路径约定（证书本身不入库）。

**Why**：只有在 HTTPS 下演示，`curl -I https://<域名>/api/health` 才能作为"从外部可达"的证据；也是面试官会直接点开的链接。

**Change Necessity**：config-only。

**Impact / Compatibility**：无。

**Steps**

1. 域名 A 记录指向服务器公网 IP。
2. 安装 certbot（`snap install certbot --classic`），用 `certonly --nginx` 或 `--standalone` 取得证书。
3. 配置自动续期：`systemctl list-timers | grep certbot` 确认 timer 已存在；`certbot renew --dry-run` 必须成功。
4. 在 `ops/nginx/README.md` 记录证书路径与续期方式。
5. **若没有域名**：退化为仅 HTTP（80），并在验收证据里写明"无 TLS"，不得假装有。这也是留待面试时说明的一个诚实边界。

**Verification**

```bash
curl -sI https://<域名>/api/health | head -1
echo | openssl s_client -connect <域名>:443 -servername <域名> 2>/dev/null | openssl x509 -noout -dates
certbot renew --dry-run
```

预期：HTTP 200；证书未过期且自动续期演练成功。

---

#### Task 0.6 邮件（SMTP）接收端准备

**Files**：新建 `ops/alertmanager/README.md`（记录 SMTP 提供方、端口、发件/收件地址；**密码只写"见环境变量"**）。

**Why**：规格 §9.6 要求"告警真的到达接收端"，而 Task 2.5 依赖一个真实可用的 SMTP 通道。这一步失败的代价是：演练时才发现收不到，而那时排查会把两件事混在一起。

**Change Necessity**：config-only。

**Impact / Compatibility**：无。

**Steps**

1. 选定 SMTP 提供方并取得**应用专用密码**（不要用账号主密码）。国内可选 QQ 邮箱 / 163；国外可选 Gmail app password。
2. 在服务器上验证出站端口可达：`nc -zv <smtp_host> 465`（或 587）。
3. 在服务器上用 `swaks` 或一条临时命令发一封测试邮件，确认**收件箱真的收到**（检查垃圾邮件箱）。
4. 把凭据写入服务器侧 `/srv/voting/.env`（权限 600），并把变量名追加进 `ops/server/secrets.md`。

**Verification**

```bash
ssh deploy@<server> 'nc -zv <smtp_host> 465; ls -l /srv/voting/.env'
# 测试邮件必须真的到达收件箱（截图留存）
```

预期：端口可达；`.env` 权限为 `-rw-------`；测试邮件到达。

---

### 批一：镜像与一键拉起

#### Task 1.1 让 Next.js 具备 standalone 产物

**Files**

- 修改 `web/next.config.ts`

**Why**：没有 `output: "standalone"`，runner 阶段被迫携带整个 `node_modules`，镜像从约 200MB 涨到 1GB 以上；且这与本任务要追求的"镜像瘦身可量化"直接矛盾。

**Change Necessity**：这是本计划唯一的应用配置改动，共 1 行。理由：它是 runner 阶段能否只复制必要文件的前提。

**Impact / Compatibility**：不改变任何运行时行为；`pnpm build:web` 成功且新增 `.next/standalone` 目录。CI 的 web job 不受影响。

**Steps**

1. 在 `web/next.config.ts` 的 `nextConfig` 中增加 `output: "standalone"`，并写一行注释说明"仅为容器镜像瘦身，不改变行为"。
2. `pnpm build:web`。
3. 确认入口文件的确切路径：**实测为 `.next/standalone/web/server.js`**（计划原来的预期正确）。这个路径在 Task 1.2 的 ENTRYPOINT 里被硬编码。
4. **产出物断言已按实测修正（2026-09-22）**。原计划断言 `mysql2` 会出现在 `.next/standalone/node_modules/mysql2`——**该断言不成立**，实测结果如下：
   - `mysql2` 的文件**确实被追踪**进 `standalone/node_modules/.pnpm/mysql2@3.24.4_@types+node@22.20.4/node_modules/mysql2/`（92 个文件，0.53 MB，含 `promise.js` 与 `lib/**`）；
   - 但**没有任何顶层链接指向它**：`standalone/node_modules/` 下只有 `.pnpm`，`standalone/web/node_modules/` 下**只有 `next`**；
   - 那个 `next` 还是**指向仓库绝对路径的 Junction**（`D:\桌面\实习项目\…\node_modules\.pnpm\next@…\node_modules\next`），容器内必然悬空；
   - 把 `standalone/` 复制到仓库之外后，`require.resolve("mysql2/promise")` → **`MODULE_NOT_FOUND`**（已复现），`require.resolve("next")` 之所以仍成功，只是因为它指回了本机仓库。
   - 另注：`mysql2/index.js` 不在追踪集内，这**不是**缺陷——应用只 `import "mysql2/promise"`，而 `promise.js` 不 require `index.js`，所以 `index.js` 确实不可达。
5. **负向对照**：已在基线阶段自然取得——改动前 `web/.next/standalone` 不存在，改动后存在，证明该配置确实在起作用。

**结论与后果**：本机（Windows）构建的 standalone **不自包含、不可移植**。这是 pnpm 在 Windows 上用 junction、而 Next 追踪器只保留了部分链接的结果。**Linux 容器内是否自包含尚未验证，需 Docker 解除后才能定论**（记录见 §14.4）。在该结论确立前，Task 1.2 的 Dockerfile 必须带一条镜像内自检，否则容器会在运行时才崩。

**Verification**

```bash
cd decentralized-voting-dapp
pnpm build:web
test -f web/.next/standalone/web/server.js && echo "server.js OK"   # 实测通过
pnpm typecheck && pnpm format:check                                  # 实测通过（退出码均为 0）
# 自包含性质检——必须把 standalone 复制到仓库之外再解析，否则会被本机仓库“救活”：
#   require.resolve("mysql2/promise") 在副本里必须成功
#   Windows 本机实测：失败（MODULE_NOT_FOUND），见 §14.4；Linux 容器内待验
```

预期：`server.js` 存在；typecheck 与 format 干净；**自包含性在 Linux 容器内必须单独验证**，Windows 本机不满足。

---

#### Task 1.2 编写 Dockerfile 与 .dockerignore

**Files**

- 新建 `web/Dockerfile`
- 新建 `.dockerignore`

**Why**：这是"给 DApp 写 Dockerfile"这一项交付的实体；也是批三构建、批四双槽共用的唯一镜像定义。

**Change Necessity**：必须新建。且**只允许一个 Dockerfile**：web / migrate / indexer 三角色共用同一镜像，理由见规格 §4.3（拆开会让事件解码逻辑与 schema 产生第二份构建产物）。

**Impact / Compatibility**：无既有文件受影响；新增对构建上下文的要求（见 Steps 1）。

**Steps**

1. **构建上下文必须是仓库根**。在 `web/Dockerfile` 顶部写注释固定这条，并在 `ops/` 文档里写清命令是 `docker build -f web/Dockerfile -t <tag> .`。理由：`pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 在根，上下文设为 `web/` 会让 `--frozen-lockfile` 失败或装出与 CI 不同的依赖树。
2. 写 `deps` 阶段：`FROM node:24-bookworm-slim`；`corepack enable`；先 `COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./` 与 `COPY web/package.json web/`、`COPY contracts/package.json contracts/`（**只复制 manifest，源码后置**，这是层缓存的关键）；然后 `RUN pnpm install --frozen-lockfile`。
   - 注意：`--filter @voting/web...`（三点后缀）会连同其 workspace 依赖一起装，但 `contracts` 的 devDependency（Hardhat）体积巨大且运行时不需要。**做法**：deps 阶段用全量 `--frozen-lockfile` 保证 lockfile 一致性，runner 阶段只复制 standalone 输出与必要的运行时依赖，不复制 `node_modules`。
3. 写 `builder` 阶段：`COPY . .`；声明 `ARG NEXT_PUBLIC_LOCAL_RPC_URL`、`ARG NEXT_PUBLIC_SEPOLIA_RPC_URL`、`ARG NEXT_PUBLIC_IPFS_GATEWAY` 并 `ENV` 化（理由见规格 §6.4：`NEXT_PUBLIC_*` 构建期内联）；`RUN pnpm --filter @voting/web build`。
4. 写 `runner` 阶段：`FROM node:24-bookworm-slim`；`ENV NODE_ENV=production`、`ENV PORT=3000`、**`ENV HOSTNAME=0.0.0.0`**（不设它，standalone 会绑定到容器主机名，从容器外无法访问——这是最常见的坑）；复制 `.next/standalone` → `/app`、`.next/static` → `/app/web/.next/static`、`public` → `/app/web/public`（`.next` 与 `public` 的目标路径按 Task 1.1 第 3 步实测的 `.next/standalone/web/server.js` 推出）；`USER node`；`EXPOSE 3000`；`HEALTHCHECK` 用 `node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`；`ENTRYPOINT ["node","web/server.js"]`。
   - **必须增补（2026-09-22 实测）**：紧接着 COPY 之后执行 `RUN rm -f /app/web/.env /app/web/.env.*`。理由是实测发现 **`next build` 会把 `web/.env` 复制进 `.next/standalone/web/.env`**（本机 909 字节，含 `RPC_URL`/`CHAIN_ID`/`DATABASE_URL` 等 10 个变量名）。该文件来自**构建阶段**，所以 `.dockerignore` 对它完全无效——排除构建上下文挡不住一个由构建过程自己生成的文件。当前那份 `.env` 只含本地开发值（`RPC_URL=http://127.0.0.1:8545`、`DATABASE_URL` 指向 `127.0.0.1:3306/voting_local_e2e`），**泄漏后果有限，但机制是危险的**：一旦构建机上有生产 `.env`，镜像一推到 Docker Hub 就等于把凭据公开。这条要写进 ADR-0016/0020 的边界。
   - **必须增补**：在 runner 阶段加一条镜像内自检 `RUN node -e "require.resolve('mysql2/promise')"`，工作目录设为 `/app/web`。理由见 §14.4：standalone 的自包含性在 Windows 上不成立，Linux 上待验；有了这条自检，不自包含的镜像会在**构建时**失败，而不是在容器运行时才崩。
5. **indexer / migrate 角色需要运行 `scripts/*.ts`，需要 `tsx`**。这三个脚本用 `node --import tsx scripts/*.ts` 执行。runner 阶段必须提供 `tsx`，否则 indexer 与 migrate 容器会立刻失败。**做法**：在 runner 阶段额外 `RUN npm i -g tsx@<与 web devDependency 相同版本>`（或在 builder 里预编译脚本为 JS——但那会引入构建复杂度）。**记录这条选择的原因**：`tsx` 是 devDependency，`--prod` 安装不会带上它，而 migrate/indexer 是生产必需的进程角色。这是"同一镜像三角色"这个决定的直接代价，必须写进 ADR（Task 5.1）。
6. 写 `.dockerignore`，至少包含：`.git`、`node_modules`、`**/node_modules`、`**/.next`、`**/artifacts`、`**/cache`、`**/coverage`、`**/*.log`、`.env`、`.env.*`（但保留 `.env.example`）、`docs`、`**/*.tsbuildinfo`。**`.env` 必须排除**：构建上下文会整个发给 daemon，密钥进上下文等于进构建缓存。
   - **但这不够（2026-09-22 实测）**：`.dockerignore` 只作用于**构建上下文**，挡不住由 `next build` 自己生成在 `.next/standalone/web/.env` 里的那一份。两处都必须处理，缺一不可——见第 4 步的 `RUN rm -f`。
7. 构建并用只读方式冒烟：以 `RPC_URL=<Sepolia RPC>` 起容器，`curl` `/api/health`，确认返回 JSON 且 `status` 合理。
8. **确认镜像里没有 `.env`**（负向对照的另一半）：`docker run --rm --entrypoint sh voting-web:dev -c 'ls -la /app/web/.env* 2>&1 || echo "clean"'` 必须输出 `clean`。

**Verification**

```bash
cd decentralized-voting-dapp
docker build -f web/Dockerfile -t voting-web:dev .
docker image ls voting-web:dev --format '{{.Repository}}:{{.Tag}} {{.Size}}'
# 自包含性：必须显式验，否则容器运行时才崩（见 §14.4）
docker run --rm --entrypoint node -w /app/web voting-web:dev \
  -e "require.resolve('mysql2/promise'); console.log('mysql2 resolvable')"
# 镜像内不得残留 .env
docker run --rm --entrypoint sh voting-web:dev -c 'ls /app/web/.env 2>/dev/null && exit 1 || echo "no .env (good)"'
docker run --rm -d --name smoke -p 13000:3000 \
  -e RPC_URL=https://ethereum-sepolia-rpc.publicnode.com -e CHAIN_ID=11155111 voting-web:dev
sleep 8 && curl -s localhost:13000/api/health | head -c 400
docker inspect smoke --format '{{.State.Health.Status}}'
docker rm -f smoke
```

预期：镜像成功构建且体积 **< 250MB**（记录实测字节数）；`mysql2/promise` 可解析；镜像内无 `.env`；`/api/health` 返回 JSON；容器健康检查为 `healthy`。

---

#### Task 1.3 扩写 compose base

**Files**

- 修改 `docker-compose.yml`

**Why**：这是"用 Docker Compose 一键拉起整个 DApp 环境"的实体。现文件只有 MySQL。

**Change Necessity**：必须扩写；且必须**保持既有用法可用**。

**Impact / Compatibility**：**兼容边界**——`docker compose up -d mysql` 必须继续可用，服务名 `mysql` 与宿主机端口 `3307` 均不变（README 第 271 行引用该命令）。新增服务不得改变 mysql 的既有定义。

**Steps**

1. 保留 `mysql` 服务**逐字不变**（image、container_name、restart、environment、ports `3307:3306`、command、volumes、healthcheck 全部原样），只把它移入新的网络声明中。
2. 新增 `migrate` 服务：`image: ${WEB_IMAGE}`，`command: ["node","--import","tsx","web/scripts/migrate.ts"]`，`depends_on: {mysql: {condition: service_healthy}}`，`restart: "no"`，`env_file: .env`。**禁止挂载任何 `docker-entrypoint-initdb.d`**。
3. 新增 `indexer` 服务：同一镜像，`command` 指向 `ops/indexer/entrypoint.sh`（Task 1.4），`depends_on` 要求 `migrate` 为 `service_completed_successfully` 且 `mysql` healthy，`restart: unless-stopped`，`env_file: .env`，并显式 `INDEXER_ENABLED=false`（它自己是 worker，不需要 web 的进程内循环）。
4. 新增 `web` 服务：同一镜像，`depends_on` 要求 `migrate` `service_completed_successfully`，`restart: unless-stopped`，**`INDEXER_ENABLED=false`**（索引交给 indexer，避免两个进程同时 drain 游标），healthcheck 打 `/api/health`。
5. 网络分段：`backend`（`internal: true`）+ `edge`。mysql 与 indexer 只挂 `backend`；web 挂两个（dev 下需要从宿主机访问，见 Task 1.6）。
6. 端口：base 文件里 **web 不映射端口**（dev 的映射放在 override，生产的经 nginx）。
7. 全部 `depends_on` 只用 `service_healthy` / `service_completed_successfully`，**不写任何 `sleep`**。
8. 在文件顶部保留并扩写既有的解释性注释：说明 schema 由 migrate 服务应用、3307 映射的用途、profile 划分。

**Verification**

```bash
cd decentralized-voting-dapp
docker compose config --quiet && echo "schema OK"
docker compose up -d mysql && docker compose ps
# 兼容边界：README 第 271 行的命令必须仍可用
mysql -h 127.0.0.1 -P 3307 -uroot -proot -e 'select 1' 2>/dev/null || \
  docker compose exec mysql mysqladmin ping -h 127.0.0.1 -uroot -proot
```

预期：`config` 通过；mysql 起来且 healthcheck healthy；3307 可连。

---

#### Task 1.4 indexer worker 入口

**Files**

- 新建 `ops/indexer/entrypoint.sh`
- 修改 `web/Dockerfile`（把该脚本复制进镜像并 `chmod +x`，或用 compose 的 `command: ["sh","-c","..."]`）

**Why**：`web/scripts/drain.ts` 实测为**一次性**（drain 到 idle 即退出，`MAX_ROUNDS=1000`）。若直接 `command: drain` 配 `restart: always`，会变成"退出→重启"的忙循环，日志被刷爆且掩盖真实故障。

**Change Necessity**：需要一层调度包装。选择脚本文件而非 compose 内联循环：可被 review、可被单测式手工执行。

**Impact / Compatibility**：不改 `drain.ts`。`drain.ts` 的 JSON 摘要原样输出为结构化日志（`rounds`/`inserted`/`duplicatesIgnored`/`hitRoundLimit`），这正是日志栈需要的形状。

**Steps**

1. 写 `ops/indexer/entrypoint.sh`：`set -eu`；进入循环，每轮执行 `node --import tsx web/scripts/drain.ts`；把该轮退出码与耗时打印为一行结构化日志；`sleep "${POLL_INTERVAL_MS:-4000}"` 时以秒为单位换算；对非零退出码**只记录不退出**（否则一次 RPC 抖动会让容器进入重启风暴），但连续失败 N 次（默认 10）后主动退出让编排层重启，并在日志里写明原因。
   - 注意 `drain.ts` 开头会自己 `migrate()`，因此 worker 天然容忍"schema 尚未应用"的启动顺序；但 `migrate` 服务仍保留，因为它给 `web` 提供了明确的就绪前置。
2. 在 `web/Dockerfile` 的 runner 阶段把 `ops/indexer/entrypoint.sh` 复制进 `/app/ops/indexer/` 并 `chmod +x`。
3. 提供 `INDEXER_ENABLED`、`POLL_INTERVAL_MS`、`CONFIRMATIONS`、`CHUNK_BLOCKS`、`DATABASE_URL`、`RPC_URL`、`CHAIN_ID` 的环境变量传递（经 `env_file` 与 compose 的 `environment`）。
4. 因为 **worker 不带 HTTP 端口**，无法用 healthcheck 探活；用 `docker inspect` 的 `State.Status` 与日志新鲜度代替，并在 Task 2.3 用 `voting_index_errors_total` 与 lag 指标间接监控它。

**Verification**

```bash
docker compose up -d mysql migrate indexer
sleep 20 && docker compose logs --tail 30 indexer
docker compose ps indexer
```

预期：日志里出现 drain 的 JSON 摘要**多次**（证明循环在跑而不是跑一次就退）；容器状态 `running`；无"重启风暴"（`docker inspect --format '{{.RestartCount}}'` 保持 0）。

---

#### Task 1.5 migrate 一次性服务与排序验证

**Files**：无（compose 内已定义；本 Task 是验证与守护）

**Why**：这是**最容易产生第二处 schema 定义**的位置。规格 §5.1 把它列为兼容边界。

**Change Necessity**：无新增代码，纯验证。

**Impact / Compatibility**：守护 schema 单一所有者这一不变量。

**Steps**

1. 确认 compose 中没有任何 `docker-entrypoint-initdb.d`、没有 `*.sql` 挂载、没有 `MYSQL_INITDB_*` 相关配置。
2. 手动跑一次：`docker compose run --rm migrate`，必须成功。
3. **再跑一次**，必须仍成功（幂等）。这与 CI 的 web job 做的"跑两遍"是同一主张，只是换了执行环境。
4. 让 `web` 在 `migrate` 未完成时启动：`docker compose up -d --no-deps web`，观察它应等待（或直接失败），不得出现"表不存在"的运行时错误被静默吞掉。
5. 用 `rg` 全仓库确认 `entrypoint-initdb` 零命中，并把该检查写进 Task 5.1 的 ADR 兼容边界段。

**Verification**

```bash
docker compose run --rm migrate && echo "first OK"
docker compose run --rm migrate && echo "second OK (idempotent)"
docker compose exec -T mysql mysql -uroot -proot voting -e 'show tables;'
grep -rn "entrypoint-initdb" . --include='*.yml' --include='*.yaml' --include='*.sh' || echo "no initdb mount (expected)"
```

预期：两次都成功；表已建（含视图）；initdb 零命中。

---

#### Task 1.6 本地开发 override

**Files**

- 新建 `docker-compose.override.yml`

**Why**：本地开发要能改代码即生效，且要能连宿主机上正在跑的 `hardhat node`。这也是"退役 chain 服务"这一决定的落地点。

**Change Necessity**：必须新建（Docker 会自动叠加 `override` 文件，使 `docker compose up` 在开发机上开箱可用）。

**Impact / Compatibility**：不影响生产（生产用 `-f` 显式指定文件，不自动叠加 override）。注意：`docker compose -f docker-compose.yml -f docker-compose.prod.yml` 时必须**显式不包含** override。

**Steps**

1. web 服务：挂载 `./web/src`、`./web/scripts`、`./web/public`（只读可选）以便热更新；映射 `3000:3000`。
2. web 与 indexer 都加 `extra_hosts: ["host.docker.internal:host-gateway"]`，并把 `RPC_URL` 默认设为 `http://host.docker.internal:8545`，使容器能访问宿主机上的 `hardhat node`。
   - 注意：`NEXT_PUBLIC_LOCAL_RPC_URL` 是**浏览器**用的地址，浏览器在宿主机上，所以它必须仍是 `http://127.0.0.1:8545`——两者不能混用。在 override 里加注释写明这条区别（这正是 `.env.example` 第 87-89 行强调的"服务端与浏览器端是两套变量"）。
3. 可选：为开发把 `restart` 设为 `"no"`，避免改错配置后容器反复重启掩盖报错。
4. 在 `ops/README.md` 记录三种启动命令（本地 / 本地+监控 / 生产）与各自适用场景。

**Verification**

```bash
cd decentralized-voting-dapp
pnpm --filter @voting/contracts exec hardhat node &   # 宿主机起链
docker compose up -d --wait
curl -s localhost:3000/api/health | head -c 300
docker compose exec web getent hosts host.docker.internal
docker compose down
```

预期：全栈 healthy；`/api/health` 能读到宿主机的链（`chainId` 为 31337、`chainHead` 非 null）。

---

#### Task 1.7 一键拉起验收（含负向对照）

**Files**：无（验收 Task）

**Why**：规格 §13.1 第 1 项要求"从干净机器一键拉起"的证据，且必须有负向对照，否则无法区分"就绪"与"只是启动了进程"。

**Change Necessity**：无。

**Impact / Compatibility**：无。

**Steps**

1. 从干净状态开始：`docker compose down -v`（含卷）→ 确认无残留（`docker volume ls | grep voting` 为空）。
2. `docker compose up -d --wait`。记录总耗时。
3. `docker compose ps` 全部为 `healthy`/`running`（migrate 应为 `exited (0)`）。
4. 抓取截图：`docker compose ps` 输出。
5. **负向对照**：临时从 web 服务注释掉 healthcheck，重新 `up -d --wait`，**必须失败或立即返回**（证明 `--wait` 真的在等健康而不是在等进程启动）。恢复配置。
6. 追加一条：把 `mysql` 的 healthcheck 改成必然失败的命令，`--wait` 亦须失败。恢复。

**Verification**

```bash
docker compose down -v
time docker compose up -d --wait
docker compose ps
docker compose logs --tail 20 migrate   # 必须显示迁移成功
```

预期：`up -d --wait` 退出码 0 且耗时被记录；`ps` 全 healthy；负向对照两次都失败。

---

### 批二：可观测性

#### Task 2.1 `/api/metrics` 端点

**Files**

- 新建 `web/src/lib/metrics.ts`（纯函数：健康读数 + 运行计数 → Prometheus 文本）
- 新建 `web/src/app/api/metrics/route.ts`（取数 + 输出）
- 新建 `web/test/metrics.test.ts`

**Why**：Prometheus 无法消费现有的 JSON `/api/health`，而规格 §5.1 又把 `/api/health` 的契约列为不可变。因此需要一个新表面。

**Change Necessity**：必须新增端点。**但数据来源必须复用 `getHealth()`**，不得新造状态——否则会出现第二处"索引落后多少"的定义。

**Impact / Compatibility**：新增表面，不改既有路由。`:route.ts` 必须 `export const dynamic = "force-dynamic"`，否则 Next 会尝试静态化。

**Steps**

1. 写 `web/src/lib/metrics.ts`，导出 `renderMetrics(input): string`。规则必须显式：
   - 每个指标输出 `# HELP` 与 `# TYPE`，最后一行以 `\n` 结尾（Prometheus 文本格式要求）；
   - **`lagBlocks === null` 时整条 `voting_index_lag_blocks` 都不输出**（不是输出 0、也不是输出 NaN）。同理处理 `chainHead === null` 与 `pollCount === null`；
   - `voting_index_configured`、`voting_indexer_loop_enabled` 用 0/1；
   - `voting_index_errors_total` 由 `indexError` 从 null 变为非 null 的**变化**驱动（进程内计数），并在 HELP 文本里写明"单进程近似计数，重启归零"（规格 §9.4 要求口径必须写明）；
   - 标签值做转义（`\` `"` `\n`）——路由名可能含 `[address]` 这类字符；
   - 不输出任何配置值或 URL（ADR-0016/0020）。
2. 写 `route.ts`：取 `await getHealth()` 与进程指标（`process.memoryUsage()`、事件循环延迟可用 `perf_hooks.monitorEventLoopDelay`），调 `renderMetrics`，返回 `new Response(text, { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } })`。
3. 写 `web/test/metrics.test.ts`，覆盖：正常读数 → 各指标存在且格式合法；`lagBlocks: null` → **断言输出中不含 `voting_index_lag_blocks`**；`chainHead: null` 同理；标签转义；结尾有换行。
4. **负向对照**：临时把 null 分支改成输出 0，测试**必须失败**。恢复。
5. 与前端组件解耦：`metrics.ts` 必须是纯函数（不 import React），理由同 ADR-0027——`web/test/**` 无法 import React 组件。

**Verification**

```bash
cd decentralized-voting-dapp
pnpm --filter @voting/web test
pnpm typecheck
pnpm build:web
# 格式校验（容器内或本地有 promtool 时）
docker compose up -d web && curl -s localhost:3000/api/metrics | head -40
```

预期：测试全绿；负向对照下失败；`/api/metrics` 输出可被 `promtool check metrics` 接受（无 promtool 时人工核对 HELP/TYPE 与结尾换行）。

---

#### Task 2.2 metrics 不暴露公网

**Files**

- 修改 `docker-compose.yml`（web 不发布 metrics 端口——base 已不含端口，本 Task 是守护）
- 修改 `ops/nginx/conf.d/*.conf`（显式拒绝 `/api/metrics`，见 Task 4.1）

**Why**：`/api/metrics` 是内部信息（链 ID、合约地址、索引高度）。规格 §9.1 要求它不经 nginx。

**Change Necessity**：config-only。

**Impact / Compatibility**：无。

**Steps**

1. 确认 prod 下 web **没有** `ports:` 映射。
2. 在 nginx 里加一条显式规则：`location = /api/metrics { return 403; }`。这条比"靠不加映射来保护"更可靠——因为 Task 4.1 的 nginx 反代会把整个 web 暴露出去，若不显式拒绝，`/api/metrics` 会随 `proxy_pass` 一起漏出去。
3. Prometheus 通过 `backend` 网络直连 `web-blue:3000` / `web-green:3000`（Task 2.3 的 scrape 目标）。

**Verification**

```bash
# 生产拓扑下（nginx 在 443）
curl -s -o /dev/null -w '%{http_code}\n' https://<域名>/api/metrics    # 期望 403
# 内部网络直连
docker compose exec prometheus wget -qO- http://web-blue:3000/api/metrics | head -5
```

预期：外部 403；内部可取。

---

#### Task 2.3 Prometheus 采集与告警规则

**Files**

- 新建 `ops/prometheus/prometheus.yml`
- 新建 `ops/prometheus/rules/voting.yml`
- 修改 `docker-compose.yml`（新增 prometheus 服务，`profiles: ["observability"]`）

**Why**：规格 §9.5 的 9 条规则是本阶段"监控告警"能力主张的核心。其中 `absent()` 那条是全项目最有辨识度的设计点。

**Change Necessity**：必须新增配置。规则表达式是决策本身，必须逐字写对。

**Impact / Compatibility**：prometheus 挂 `backend` 网络读取；`--storage.tsdb.retention.time=15d`；volume 持久化。

**Steps**

1. 写 `ops/prometheus/prometheus.yml`：`global.scrape_interval: 15s`、`evaluation_interval: 15s`；`rule_files: /etc/prometheus/rules/*.yml`；scrape 目标：
   - `web`（静态目标 `web-blue:3000`，另在批四补齐 green 槽；或直接用 `dns_sd`/文件发现，先用静态并注明批四需要更新）
   - `node-exporter:9100`、`cadvisor:8080`、`mysqld-exporter:9104`
   - `blackbox`（探 `/api/health`，`metrics_path: /probe`，`params.module: [http_2xx]`，`relabel_configs` 把目标塞进 `__param_target`）
2. 写 `ops/prometheus/rules/voting.yml`，九条规则逐条给出表达式、`for`、`labels.severity`、`annotations.summary/description`。**关键两条必须写对**：

   ```yaml
   - alert: VotingIndexLagHigh
     expr: voting_index_lag_blocks > 25
     for: 5m

   - alert: VotingIndexLagUnknown
     # lagBlocks 为 null 时该序列整体缺席，因此比较型规则会静默失效。
     # 这条规则专门覆盖"索引已配置但滞后量读不出来"这一失败模式。
     expr: absent(voting_index_lag_blocks) and on() (voting_index_configured == 1)
     for: 10m
   ```

   其余七条：`VotingIndexErrors`（`increase(voting_index_errors_total[10m]) > 0`）、`VotingHealthDegraded`（blackbox 探针 `probe_success == 0`）、`VotingApiSlow`（blackbox 探针 `probe_duration_seconds > 2`）、`ContainerDown`（`up == 0`）、`MySQLDown`（`mysql_up == 0`）、`HostDiskWillFillIn4Hours`（`predict_linear(node_filesystem_avail_bytes[6h], 4*3600) < 0`）、以及 `DeployVersionDrift`（Task 2.7 后启用，`voting_deploy_info` 与期望 tag 不一致）。

   **修正（2026-09-22，执行 Task 2.1 时发现）**：原写的是 `VotingApiErrorRate`（5xx 占比 > 2%），但它依赖 `voting_http_requests_total`——**本计划没有任何 Task 会产出这个序列**。按请求粒度的 RED 指标需要在 `middleware.ts` 或逐个路由处理器里埋点，而规格 §5.2 把"任何功能性应用改动"列为非目标，只允许新增 `/api/metrics` 与 `next.config.ts` 的 `standalone`；为此去改 17 个路由文件会越过已批准的边界。

   所以这条规则改为基于 blackbox 的 `probe_duration_seconds`：它测的是同一件事（后端 API 是否在合理时间内响应），却不需要侵入应用。**一条引用不存在序列的告警规则会静默地永不触发**，这正是本计划通篇要防的失败模式，因此在这里修正，而不是保留一个看起来更完整的规则清单。按请求的错误率若要补，应作为独立的一次改动并同步修订规格 §5.2。
   每条 `annotations` 必须写明"在防什么"，不得只写指标名。

3. 加 compose 服务：`prom/prometheus`，挂载 `prometheus.yml`、`rules/`、`alertmanager` 地址、`prometheus-data` 卷；**`profiles: ["observability"]`**；给内存限额。
4. 本地校验：`promtool check config` + `promtool check rules`（用 `--entrypoint` 覆盖容器入口执行）。

**Verification**

```bash
cd decentralized-voting-dapp
docker run --rm -v "$PWD/ops/prometheus:/p:ro" --entrypoint promtool prom/prometheus \
  check config /p/prometheus.yml
docker run --rm -v "$PWD/ops/prometheus:/p:ro" --entrypoint promtool prom/prometheus \
  check rules /p/rules/voting.yml
docker compose --profile observability up -d --wait
curl -s localhost:9090/api/v1/targets | head -c 600      # 需先临时映射 9090 或用容器内 wget
curl -s localhost:9090/api/v1/rules | head -c 600
```

预期：`check` 双通过；targets 全 `up`；rules 无 error；九条规则均已加载。

---

#### Task 2.4 exporters

**Files**

- 修改 `docker-compose.yml`（node-exporter / cadvisor / mysqld-exporter / blackbox-exporter）
- 新建 `ops/blackbox/blackbox.yml`
- 新建 `ops/mysqld-exporter/.my.cnf`（模板，密码经环境变量注入；文件权限 600）

**Why**：只有应用指标无法回答"磁盘满了吗""容器被 OOM 了吗""MySQL 连接数是多少"——而这三类问题正是运维排障的日常。

**Change Necessity**：必须新增。MySQL 导出器需要一个只读监控账户，这是唯一需要新数据库权限的地方。

**Impact / Compatibility**：新增一个 MySQL 用户 `exporter`（`PROCESS`、`REPLICATION CLIENT`、`SELECT` on `performance_schema`）。不得复用应用账户。

**Steps**

1. 加四个服务，全部 `profiles: ["observability"]`，并设内存限额。
2. `node-exporter`：`pid: host`、挂载 `/proc`、`/sys`、`/` 为只读，并挂载 `/srv/voting/state/textfile` → `/var/lib/node_exporter/textfile` 且带 `--collector.textfile.directory`（Task 2.7 用）。
3. `cadvisor`：`privileged: true`（它需要读 cgroup）并挂载 `/var/run/docker.sock:ro`、`/sys`、`/var/lib/docker`。**在 `ops/README.md` 中如实写明 cadvisor 需要特权**，不要假装它是普通容器。
4. `mysqld-exporter`：用 `--mysqld.username=exporter` + `MYSQLD_EXPORTER_PASSWORD` 环境变量（不要用 DSN 明文）。在 `ops/server/README.md` 里给出创建该账户的 SQL（只读权限）。
5. `blackbox-exporter`：写 `ops/blackbox/blackbox.yml`，定义 `http_2xx` 模块；并同时探**外部 URL**（`https://<域名>/api/health`）——这证明"从外面看得见"，与内部探针是两条不同的证据。
6. 抓取目标写进 `ops/prometheus/prometheus.yml`。

**Verification**

```bash
docker compose --profile observability up -d --wait
docker compose exec prometheus wget -qO- http://node-exporter:9100/metrics | head -3
docker compose exec prometheus wget -qO- http://mysqld-exporter:9104/metrics | grep -m1 mysql_up
docker compose exec prometheus wget -qO- http://cadvisor:8080/metrics | head -3
docker compose exec prometheus wget -qO- 'http://blackbox-exporter:9115/probe?target=https://<域名>/api/health&module=http_2xx' | grep -m1 probe_success
```

预期：四者均返回指标；`mysql_up 1`；`probe_success 1`。

---

#### Task 2.5 Alertmanager 与邮件

**Files**

- 新建 `ops/alertmanager/alertmanager.yml.tmpl`（模板）
- 新建 `ops/alertmanager/entrypoint.sh`（envsubst 后启动）
- 修改 `docker-compose.yml`（alertmanager 服务，`profiles: ["observability"]`）

**Why**：规格 §9.6——没有接收端的告警等于没有告警。本阶段选邮件。

**Change Necessity**：**Alertmanager 原生不支持在配置里做环境变量插值**。因此必须用模板 + `envsubst`，否则 SMTP 密码只能明文写进配置文件。这是本 Task 存在的技术理由。

**Impact / Compatibility**：SMTP 密码从 `/srv/voting/.env` 经环境变量注入；容器内不落明文文件。

**Steps**

1. 写 `alertmanager.yml.tmpl`：`global.smtp_smarthost`、`smtp_from`、`smtp_auth_username`、`smtp_auth_password`（用 `${SMTP_PASSWORD}` 占位）、`smtp_require_tls: true`。
2. `route`：`group_by: [alertname, instance]`、`group_wait: 30s`、`group_interval: 5m`、`repeat_interval: 4h`；子路由按 `severity` 分（`critical` 立即、`warning` 延后）。
3. `inhibit_rules`：`ContainerDown` 抑制同一实例上的应用级告警；`HostDiskWillFillIn4Hours` 优先级最高。理由：主机挂了再报十条容器告警只会淹没真正的根因。
4. `receivers`：`email` 接收器，`to: ${ALERT_EMAIL_TO}`，`send_resolved: true`（恢复通知与告警同等重要，否则收件箱只有坏消息）。
5. `entrypoint.sh`：`envsubst < /etc/alertmanager/alertmanager.yml.tmpl > /tmp/alertmanager.yml`（**只替换明确列出的变量**，避免误替换 Prometheus 模板语法中的 `$`），`chmod 600`，`exec alertmanager --config.file=/tmp/alertmanager.yml`。
6. compose 服务：`prom/alertmanager`，挂载模板与脚本，`command: ["/bin/sh","/etc/alertmanager/entrypoint.sh"]`，内存限额。
7. 手工触发一次测试告警：`amtool alert add alertname=TestAlert severity=critical`，确认**邮件真的到达**并截图。

**Verification**

```bash
docker compose --profile observability up -d alertmanager
docker compose exec alertmanager amtool --alertmanager.url=http://localhost:9093 alert add \
  alertname="SmokeTest" severity="critical" --annotation=summary="smoke test"
# 检查投递
docker compose logs --tail 30 alertmanager | grep -i -E 'smtp|sent|error'
```

预期：日志显示邮件已发送且无 SMTP 错误；收件箱收到告警邮件（截图）。

---

#### Task 2.6 Grafana provisioning 与看板

**Files**

- 新建 `ops/grafana/provisioning/datasources/prometheus.yml`
- 新建 `ops/grafana/provisioning/dashboards/dashboards.yml`
- 新建 `ops/grafana/dashboards/business.json`、`api-probe.json`、`host-containers.json`
- 修改 `docker-compose.yml`（grafana 服务，`profiles: ["observability"]`）

**Why**：看板入库提交 + provisioning，才能让"一键拉起"之后看板**已经存在**，而不是手工点二十次。手工配置的看板无法复现，也就无法作为交付物。

**Change Necessity**：必须新增配置。

**Impact / Compatibility**：Grafana 数据源与看板以文件为唯一来源；管理密码经环境变量注入。**不映射到公网**（§12 第 4 项）。

**Steps**

1. 写 datasource provisioning：`prometheus`，`url: http://prometheus:9090`，`isDefault: true`。
2. 写 dashboard provider：`path: /var/lib/grafana/dashboards`，`foldersFromFilesStructure: false`。
3. 写三块看板 JSON：
   - `business.json`：链头 vs 索引高度**双线同图**（这是最直观的一张图）、`voting_index_lag_blocks`、`voting_poll_count`、`voting_index_errors_total` 的 `rate()`；用 `voting_deploy_info` 做版本注释。
     - **修正（2026-09-22）**：原写"索引同步耗时直方图分位"，但没有同步耗时直方图这类指标——Task 2.1 未产出它，任何 `histogram_quantile` 都会查空。改为错误率曲线，它由真实存在的计数器算出。
   - `api-probe.json`：`probe_success`（外部探针能否拿到 200）、`probe_duration_seconds`（后端 API 的响应时间）、`up{job="web"}`、`voting_process_resident_memory_bytes`。**不含按请求的 5xx 比例**，理由见 Task 2.3 的 2026-09-22 修正。
     - **修正（2026-09-22）**：该文件原名 `api-red.json`，但 RED 三件套里的两个序列都不存在；改名为 `api-probe.json` 以名副其实——一个叫 RED 却不含 RED 的看板，比没有看板更容易误导。
   - `host-containers.json`：CPU、内存、`node_filesystem_avail_bytes`、容器重启次数（`container_start_time_seconds` 变化或用 cadvisor 的 `container_last_seen`）。
   - 每块看板设置合理默认时间范围（最近 6 小时）与刷新间隔。
   - **通用约束**：每块看板引用的每条序列都必须能在某个 Task 的产出里找到出处；找不到的就不放进看板。理由同 Task 2.3——查空的图表和永不触发的规则一样，会让人以为自己有覆盖。
4. compose 服务：`grafana/grafana`，挂载三个 provisioning 路径，`GF_SECURITY_ADMIN_PASSWORD` 从环境变量注入，**不映射端口**（经 SSH 隧道访问）。
5. 在 `ops/README.md` 写明访问方式：`ssh -L 3001:localhost:3001 deploy@<server>` 后浏览器开 `localhost:3001`。

**Verification**

```bash
docker compose --profile observability up -d --wait
ssh -L 3001:localhost:3001 deploy@<server>
# 浏览器确认：数据源自动存在、三块看板自动出现、图有数据
```

预期：无需手工配置；三块看板出现且有数据（截图）。

---

#### Task 2.7 部署版本可见性

**Files**

- 新建 `ops/deploy/publish-version.sh`
- 修改 `ops/server/README.md`（确保 textfile 目录存在且属主正确）

**Why**：规格 §9.7。健康门只能证明"服务在服务"，无法证明"服务的是**新版本**"。把生效 tag 写成指标后，Grafana 上能把告警与发布对齐，且 `DeployVersionDrift` 规则能抓到"CI 说成功了但线上还是旧版"。

**Change Necessity**：需要一个小脚本把状态写进 node-exporter 的 textfile collector。

**Impact / Compatibility**：写 `/srv/voting/state/textfile/voting_deploy.prom`，属主 `deploy`，权限 644（node-exporter 以 nobody 读取时需要可读）。

**Steps**

1. 写 `ops/deploy/publish-version.sh <tag> <slot>`：原子写入（先写临时文件再 `mv`，避免 node-exporter 读到半个文件）。
2. 指标：`voting_deploy_info{tag="<sha>",slot="blue"} 1`，并输出时间戳 `voting_deploy_timestamp_seconds`。
3. 由 Task 3.3 的 `deploy.sh` 在切换成功后调用。
4. 在 `ops/prometheus/rules/voting.yml` 启用 `DeployVersionDrift`：把期望 tag 通过 Prometheus 的 `--set` 或一个静态记录规则提供，比较运行 tag 与期望 tag；先记为 `warning` 并写明它只检测"不一致"而非"落后"。

**Verification**

```bash
ssh deploy@<server> '/srv/voting/ops/deploy/publish-version.sh abc1234 blue; cat /srv/voting/state/textfile/voting_deploy.prom'
curl -s localhost:9100/metrics 2>/dev/null | grep voting_deploy   # 或在容器内取
```

预期：文件内容为合法 exposition；node-exporter 暴露 `voting_deploy_info{tag="abc1234",slot="blue"} 1`。

---

#### Task 2.8 三类故障演练

**Files**：新建 `ops/runbook/drills.md`（演练步骤 + 预期 + 实际结果 + 截图路径）

**Why**：规格 §13.1 第 6、7 项。这三条是本阶段最有说服力的证据，也是最容易被省略的部分。特别是第 7 项：**只测 `LagHigh` 无法证明你区分了 absent 与 0**。

**Change Necessity**：docs-only（本 Task 不改代码，只产证据）。

**Impact / Compatibility**：演练在服务器上进行，会造成短暂的服务中断或降级——**必须安排在无人使用的时段**，并在 runbook 里写明回滚步骤。

**Steps**

1. **演练甲：容器死亡。** `docker kill` web 容器 → 期望：`ContainerDown` 在 2 分钟内触发、邮件到达。恢复容器。
2. **演练乙：索引滞后。** 停掉 indexer 容器，同时让链上继续产生区块（在 Sepolia 上等于等待，或临时把 `POLL_INTERVAL_MS` 调大）→ 期望：`VotingIndexLagHigh` 触发。恢复。
3. **演练丙：滞后量不可读（absent）。** 目标是产生 `lagBlocks === null` 但 `indexConfigured === true` 的状态。手段：把 `DATABASE_URL` 指向一个不可达地址后重启 web（health 会 503 且 lag 为 null），或停掉 MySQL 容器。
   - **必须先核实哪种操作精确产生 absent 而不是 0**（读 `lib/data.ts` 的 `getHealth`，确认"索引已建表但游标读不出来"与"没有索引"两种情形各自的返回值），并在 runbook 里写明核实结论。若两者都无法产生 absent，则**本演练记为未完成**，不得用"导出 0 也能告警"替代——那等于承认设计点不成立。
   - 期望：`VotingIndexLagUnknown` 触发（而不是 `LagHigh`）。这同时证明两条规则各自的作用域。恢复。
4. **演练丁（可选但推荐）：MySQL 宕机。** 停 MySQL → `/api/health` 返回 503，但页面仍能只读链（这是项目已有能力，容器化后重测一次）。期望：`VotingHealthDegraded` 与 `MySQLDown` 同时触发，且 `inhibit_rules` 行为符合预期。
5. 每条演练在 `ops/runbook/drills.md` 记录：命令、时间、告警触发时刻（与命令时刻的差值）、邮件截图文件名、恢复命令、**实际与预期的偏差**。

**Verification**

```bash
# 演练甲
docker kill voting-web-blue
sleep 150 && docker compose logs --tail 5 alertmanager   # 应有告警投递记录
docker compose up -d web-blue

# 演练丙（先核实 getHealth 的返回语义再执行）
grep -n "lagBlocks" web/src/lib/data.ts
```

预期：四条演练各自留下"告警到达"的证据；偏差如实记录。

---

### 批三：CI/CD

#### Task 3.1 `ci.yml` 增加 `workflow_call`

**Files**

- 修改 `.github/workflows/ci.yml`

**Why**：`release.yml` 必须以既有质量门为前提。加 `workflow_call` 是唯一必要的改动，这样"测试通过才发布"不是仪式。

**Change Necessity**：1 行加法。理由：复用既有 5 个 job，而不是在 release 里重写一套测试。

**Impact / Compatibility**：**兼容边界**——既有 `push` / `pull_request` / `workflow_dispatch` 触发语义不变。`abi-drift` 的字节级守护不变。

**Steps**

1. 在 `on:` 下增加 `workflow_call:`（与既有三个触发器并列）。
2. 不改任何 job。
3. 用 `actionlint` 校验（本地无则用 `gh workflow view`）。

**Verification**

```bash
cd decentralized-voting-dapp
actionlint .github/workflows/ci.yml 2>/dev/null || echo "actionlint 不可用，改用 gh"
gh workflow list
gh workflow view CI
```

预期：语法合法；三个既有触发器仍在；workflow 可被 `workflow_call` 引用。

---

#### Task 3.2 `release.yml`：门 → 构建 → 扫描 → 推送

**Files**

- 新建 `.github/workflows/release.yml`

**Why**：这是"push 后自动构建镜像并推送到 Docker Hub"的实体。

**Change Necessity**：必须新增。全部逻辑外置到 `ops/deploy/`（Task 3.3），workflow 只做编排。

**Impact / Compatibility**：需要 5 个 secret；`environment: production` 需要 reviewers（Task 0.3）。

**Steps**

1. `on`：`push: branches: [main]`、`push: tags: ['v*']`、`workflow_dispatch`。
2. `env`：`NODE_VERSION: "24"`；`IMAGE: <dockerhub_user>/voting-web`。
3. job `gate`：`uses: ./.github/workflows/ci.yml`（**部署必须 needs 它**）。
4. job `build`（`needs: gate`）：
   - `docker/setup-buildx-action@v3`
   - `docker/metadata-action@v5` 生成 tags：`type=sha,format=short`（**部署用这个，不可变**）、`type=ref,event=branch`、`type=semver,pattern={{version}}`、`type=raw,value=latest,enable={{is_default_branch}}`
   - `docker/login-action@v3`（username/password）
   - `docker/build-push-action@v6`：`context: .`、`file: web/Dockerfile`、`push: true`、`cache-from: type=gha`、`cache-to: type=gha,mode=max`、`platforms: linux/amd64`（除非 §12 第 1 项显示服务器是 arm64）、`build-args` 注入 `NEXT_PUBLIC_SEPOLIA_RPC_URL` 等
   - **输出 digest 与 tag 到 job output**，供 deploy 使用
5. job `scan`（`needs: build`）：`aquasecurity/trivy-action` 扫 `HIGH,CRITICAL`、`exit-code: 1`、`format: sarif`、`output: trivy.sarif`，再 `github/codeql-action/upload-sarif`；随后 `anchore/sbom-action` 生成 SPDX SBOM 并上传 artifact；`actions/attest-build-provenance` 出证明（需要 `id-token: write` 与 `packages: write` 权限）。
6. **注意**：`build-args` 里的 `NEXT_PUBLIC_SEPOLIA_RPC_URL` 会进客户端 bundle，因此**不得**使用带 apiKey 的私有端点（`web/.env.example` 第 92 行已警告"这个值会随客户端包发出去"）。在 workflow 里加注释固定这条。
7. `concurrency: {group: release-${{ github.ref }}, cancel-in-progress: false}`。

**Verification**

```bash
gh workflow view Release
gh run list --workflow=Release --limit 3
# 本地预演构建（不经 CI）：
docker build -f web/Dockerfile -t test-local . && echo "local build OK"
```

预期：workflow 语法合法；一次 push 后 gate 与 build 成功；Docker Hub 上出现 `sha-xxxxxxx` tag；Security 页出现 SARIF 结果。

---

#### Task 3.3 部署脚本三件套

**Files**

- 新建 `ops/deploy/deploy.sh`
- 新建 `ops/deploy/health-gate.sh`
- 新建 `ops/deploy/rollback.sh`
- 新建 `ops/deploy/lib.sh`（共用：日志、状态文件读写、ssh 无关的纯本地逻辑）

**Why**：规格 §8.3——内联在 YAML 里的 shell 无法本地演练，而"没演练过的部署脚本"等于没有回滚能力。脚本入库后，CI 与人工跑的是同一份代码。

**Change Necessity**：必须新增。这是回滚能力的实体。

**Impact / Compatibility**：脚本在服务器上操作 `/srv/voting`；**不得打印任何密钥值**（只打印变量名与形状）。

**Steps**

1. `lib.sh`：`log()`、`die()`、`read_state`/`write_state`（写 `/srv/voting/state/{active-slot,previous-tag}`，原子写）、`require_var NAME`（存在性检查，**只报名字不回显值**——沿用 ADR-0016 的做法）。
2. `health-gate.sh <url> <timeout_seconds>`：循环 `curl -sf` 直到 200 或超时；超时 `exit 1`；输出尝试次数与耗时；**不得把响应体里的配置值打进日志**（只打 status 与耗时）。
3. `deploy.sh <tag>`（本 Task 先实现单槽版本，批四升级为双槽）：
   - 读 `active-slot` 与 `previous-tag`；
   - `docker compose -f ... pull`；
   - 先跑 `migrate`：`docker compose run --rm migrate`，失败即中止（**且此时旧容器仍在服务**）；
   - 起新版本容器；
   - 调 `health-gate.sh`；
   - 成功 → 写 `publish-version.sh`、更新 `previous-tag`；失败 → 中止并保持旧版本运行。
4. `rollback.sh [tag]`：不带参数时回滚到 `previous-tag`；**批四升级为"切换上游 + reload"（秒级）**，本 Task 先实现"按 previous-tag 重新部署"。
5. 三个脚本都做 `set -euo pipefail`，并把每次执行追加到 `/srv/voting/state/deploy.log`（含时间戳、tag、结果，不含值）。

**Verification**

```bash
# 语法与静态检查
sh -n ops/deploy/deploy.sh && sh -n ops/deploy/rollback.sh && sh -n ops/deploy/health-gate.sh
shellcheck ops/deploy/*.sh 2>/dev/null || echo "shellcheck 不可用"
# 本地演练 health-gate 的两个分支
./ops/deploy/health-gate.sh http://127.0.0.1:3000/api/health 5   # 服务在跑 -> 0
./ops/deploy/health-gate.sh http://127.0.0.1:9/api/health 5      # 无服务 -> 1
```

预期：语法通过；`health-gate` 成功与失败两个分支都被实际走到（失败分支必须真的返回非零）。

---

#### Task 3.4 SSH 部署 job

**Files**

- 修改 `.github/workflows/release.yml`（新增 deploy job）

**Why**：这是"通过 SSH 自动部署到云服务器"的实体。

**Change Necessity**：必须新增。

**Impact / Compatibility**：需要 `SSH_KEY`/`SSH_KNOWN_HOSTS` 等 secret；`environment: production` 触发人工审批。

**Steps**

1. job `deploy`：`needs: [build, scan]`、`environment: production`（触发 required reviewers）、`if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')`。
2. `concurrency: {group: deploy-production, cancel-in-progress: false}`。
3. 准备 SSH：用 `webfactory/ssh-agent` 或手工 `install -m 600` 写 key；**把 `SSH_KNOWN_HOSTS` 写到 `~/.ssh/known_hosts`**；**禁止 `ssh-keyscan`**（现扫等于没有主机校验）。
4. 把 `ops/` 同步到服务器（`rsync -az --delete ops/ deploy@host:/srv/voting/ops/`），或让服务器 `git fetch` 对应 commit——**推荐 rsync 指定路径**，避免服务器上需要 git 凭据。
5. 在服务器上执行：`SSH 到 deploy 用户` → `cd /srv/voting && WEB_IMAGE=<image>:<sha> ./ops/deploy/deploy.sh <sha>`。
6. `WEB_IMAGE` 与 `DATABASE_URL` 等经服务器侧 `/srv/voting/.env` 提供；workflow 只传 tag。
7. 把健康门结果作为 job 结论；失败时**自动调 `rollback.sh`**（写成 `if: failure()` 的步骤），并让 job 失败。
8. 把部署摘要（tag、耗时、健康门尝试次数）写进 job summary（`$GITHUB_STEP_SUMMARY`），**不含任何值**。

**Verification**

```bash
gh run view --log      # 观察 deploy job
ssh deploy@<server> 'cat /srv/voting/state/{active-slot,previous-tag}; tail -20 /srv/voting/state/deploy.log'
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps    # 服务器上
```

预期：部署 job 在审批后执行成功；服务器状态文件被正确更新；部署日志可读且无密钥值。

---

#### Task 3.5 `rollback.yml`

**Files**

- 新建 `.github/workflows/rollback.yml`

**Why**：发布失败时的恢复路径必须与发布同等可操作，且**不依赖流水线本身可用**（规格 §10.2）。workflow 只是入口，真正的能力在 `rollback.sh`。

**Change Necessity**：必须新增。

**Impact / Compatibility**：`workflow_dispatch` 带 `tag` 输入（可选，缺省用 `previous-tag`）。

**Steps**

1. `on: workflow_dispatch: inputs: tag: {description: '要回滚到的镜像 tag（留空则用 previous-tag）', required: false}`。
2. `environment: production`（回滚同样需要审批，避免误操作把线上切到更旧的版本）。
3. 步骤：SSH → `./ops/deploy/rollback.sh ${tag:-}` → 健康门 → job summary。
4. 在 `ops/runbook/drills.md` 里补一节"回滚演练"：故意部署一个健康检查必然失败的镜像 → 观察健康门失败 → 触发自动/人工回滚 → 确认服务恢复、`active-slot` 与 `previous-tag` 与发布前一致。

**Verification**

```bash
gh workflow run Rollback -f tag=<先前的 sha>
gh run watch
ssh deploy@<server> 'cat /srv/voting/state/active-slot; curl -s localhost:3000/api/health | head -c 200'
```

预期：回滚成功；服务恢复；状态文件回到发布前。

---

#### Task 3.6 流水线端到端验收

**Files**：新建 `ops/runbook/pipeline-evidence.md`（记录一次完整 run 的证据）

**Why**：规格 §13.1 第 4 项。这是"CI/CD 流水线"这一能力主张的总证据。

**Change Necessity**：docs-only。

**Impact / Compatibility**：无。

**Steps**

1. 做一次真实的代码改动（例如 README 加一行），push 到 `main`。
2. 记录：gate 通过耗时、build 耗时、scan 结果（HIGH/CRITICAL 数量与处置）、审批等待、部署耗时、健康门尝试次数。
3. 确认 Docker Hub 上 `sha-<short>` tag 与 `latest` 均存在，且**部署用的 tag 与之逐字一致**（这是"测过的就是部署的"的证据）。
4. 抓取 Actions 页面截图与 job summary。
5. 记录一个**真实的失败案例**：故意让测试失败（临时改一个断言），确认 `gate` 失败后 `build`/`deploy` **不执行**。这是"测试门有效"的负向对照。

**Verification**

```bash
gh run list --limit 5
gh run view <run-id> --json jobs --jq '.jobs[] | {name, conclusion, startedAt, completedAt}'
```

预期：一次全绿 run 的完整耗时表；一次被 gate 拦住的 run（无 build/deploy job 运行）。

---

### 批四：双槽零停机

#### Task 4.1 nginx 与上游模板

**Files**

- 新建 `ops/nginx/nginx.conf`
- 新建 `ops/nginx/templates/upstream.conf.tmpl`
- 新建 `ops/nginx/conf.d/10-app.conf`
- 修改 `docker-compose.yml` 或 `docker-compose.prod.yml`（nginx 服务）

**Why**：双槽切换的执行者是 nginx 的 `reload`，它必须是 **graceful** 的（旧 worker 处理完在途请求才退出），这是"零停机"这个词成立的技术前提。

**Change Necessity**：必须新增。

**Impact / Compatibility**：**`/api/metrics` 必须显式 403**（Task 2.2）。上游文件是**派生品**，不得手工编辑——`active-slot` 是唯一真相（规格 §10.4）。

**Steps**

1. 写 `nginx.conf`：`worker_processes auto`、`events { worker_connections 1024; }`、`http` 段包含 `conf.d/*.conf` 与上游文件、`access_log`/`error_log` 到 stdout（容器惯例）、`client_max_body_size` 合理值。
2. 写 `upstream.conf.tmpl`：`upstream voting_app { server ${ACTIVE_SLOT}:3000 max_fails=3 fail_timeout=10s; keepalive 32; }`。**只列一个 server**——双槽靠改文件 + reload 切换，而不是靠 nginx 的被动负载均衡。理由：被动均衡无法保证"新版本先通过健康门再接管流量"，而那正是零停机的关键。
3. 写 `10-app.conf`：80 → 301 到 443；443 段 `ssl_certificate`/`ssl_certificate_key`（Task 0.5 的路径）；`location /` → `proxy_pass http://voting_app`；透传 `Host`/`X-Real-IP`/`X-Forwarded-For`/`X-Forwarded-Proto`；`proxy_http_version 1.1` + `proxy_set_header Connection ""`（配合 keepalive）；`location = /api/metrics { return 403; }`；对 `/api/` 加 `limit_req`（§12 第 5 项）；静态资源加 `expires`。
4. compose 服务：`nginx:alpine`，挂载 `nginx.conf`、`conf.d/`、上游文件所在目录、证书目录（只读），映射 `80:80`、`443:443`。
5. 写 `ops/nginx/README.md`：明确"upstream.conf 由 `deploy.sh`/`rollback.sh` 渲染，任何人不得手改；若手改会在下次发布时被覆盖"。

**Verification**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d nginx
docker compose exec nginx nginx -t
curl -sI https://<域名>/api/health | head -1
curl -s -o /dev/null -w '%{http_code}\n' https://<域名>/api/metrics   # 期望 403
# graceful reload 不丢连接：并发压测同时 reload
( for i in $(seq 1 200); do curl -s -o /dev/null -w '%{http_code}\n' https://<域名>/api/health; done ) &
sleep 2 && docker compose exec nginx nginx -s reload
wait
```

预期：`nginx -t` 通过；`/api/health` 200；`/api/metrics` 403；reload 期间 200 个请求全部 200（这是 graceful 的初步证据，正式证据在 Task 4.5）。

---

#### Task 4.2 prod compose 双槽定义

**Files**

- 新建 `docker-compose.prod.yml`
- 修改 `ops/deploy/deploy.sh`（槽位参数化）

**Why**：双槽需要两个服务定义与同一个镜像的两个 tag。

**Change Necessity**：必须新增 prod 文件（生产与开发的分歧已足够大：拉镜像 vs 构建、双槽 vs 单槽、资源限额、日志轮转）。

**Impact / Compatibility**：`web-blue` 与 `web-green` **都必须 `INDEXER_ENABLED=false`**，否则两个 web 进程会与 indexer 容器三方争抢游标。**indexer 服务在生产只有一份**，不随槽位翻倍。

**Steps**

1. `docker-compose.prod.yml` 定义 `web-blue` 与 `web-green`：同一 `image: ${WEB_IMAGE}`，无 `ports`，只挂 `backend` + `edge`，各带 healthcheck、内存限额、`restart: unless-stopped`、日志轮转（`max-size: 10m`、`max-file: 3`）。
2. 两者 `INDEXER_ENABLED=false`（显式写在 `environment`，不依赖默认值）。
3. `migrate` 与 `indexer` 在生产只有一份（复用 base 定义，不翻倍）。
4. 生产下 mysql **不映射端口**（去掉 `3307:3306`，只在 `backend` 内部可达）——这是 dev 与 prod 的一处刻意分歧，需在文件里注释说明。
5. composer 文件的"生产命令"写成一行固定命令，写进 `ops/README.md` 与 Task 3.3 的脚本：
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile observability ...`
   **注意必须显式列出 `-f`，不能依赖自动叠加的 `override`**（否则生产会挂载开发源码）。
6. 给 nginx 的 `depends_on` 加上两个槽的 `service_started`（nginx 只代理，不要求它们 healthy；上游文件决定指向谁）。

**Verification**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep -c "INDEXER_ENABLED=false"   # 期望 >= 2
docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep -A3 "ports:" | grep -c 3307  # 期望 0（生产不映射）
```

预期：配置合法；两个槽均为 `INDEXER_ENABLED=false`；生产不映射 3307。

---

#### Task 4.3 `deploy.sh` 双槽流程

**Files**

- 修改 `ops/deploy/deploy.sh`
- 新建 `ops/nginx/render-upstream.sh`（渲染模板并 reload）

**Why**：这是零停机的执行体。顺序错了就会产生"发布窗口内 5xx"。

**Change Necessity**：必须改写（从单槽升级为双槽）。

**Impact / Compatibility**：**顺序不可颠倒**：migrate（向后兼容）→ 起目标槽 → 健康门（直接打目标槽）→ 切上游 → 观察 → 收尾。旧槽在观察期内保持运行，这既是保险也是秒级回滚的前提。

**Steps**

1. 读 `active-slot`（缺失时按 `blue` 初始化并把当前运行 tag 记为 `previous-tag`）。
2. 计算 `target` = 另一个槽。
3. `docker compose -f ... pull`。
4. **先 migrate**：`docker compose -f ... run --rm migrate`。失败即中止——此时旧槽仍在对提供服务，线上无影响。
5. 起目标槽：`docker compose -f ... up -d --no-deps web-${target}`，并注入新 tag。
6. **健康门直接打目标槽**（不经 nginx）：从 nginx 容器内 `wget http://web-${target}:3000/api/health`，或临时用 `docker compose exec` 探测。超时 → 停掉目标槽，中止，**不切流量**。
7. 渲染上游指向 `target` 并 `nginx -s reload`。
8. 观察窗口：持续探测外部 `/api/health` 一段时间（例如 60 秒，间隔 2 秒），**要求失败数为 0**；出现失败 → 立即切回旧槽并 reload，然后失败退出。
9. 收尾：把 `target` 写入 `active-slot`，把上一个 tag 写入 `previous-tag`；调 `publish-version.sh <tag> <target>`；旧槽**继续运行**（不 `down`），它的 tag 保留以便秒级回滚。
10. 追加部署日志到 `/srv/voting/state/deploy.log`。

**Verification**

```bash
cd decentralized-voting-dapp
sh -n ops/deploy/deploy.sh && sh -n ops/nginx/render-upstream.sh
# 服务器上演练
ssh deploy@<server> 'cd /srv/voting && WEB_IMAGE=<img>:<newsha> ./ops/deploy/deploy.sh <newsha>'
ssh deploy@<server> 'cat /srv/voting/state/active-slot; cat /srv/voting/state/previous-tag'
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps   # 两个槽都在跑
```

预期：`active-slot` 翻转；两个槽都在运行（目标槽服务新版本）；`deploy.log` 记录了各阶段耗时。

---

#### Task 4.4 `rollback.sh` 秒级回滚

**Files**

- 修改 `ops/deploy/rollback.sh`

**Why**：秒级回滚是双槽相对"原地更新"最本质的优势。回滚必须是**配置切换**，不依赖镜像拉取、不依赖流水线可用。

**Change Necessity**：必须改写。

**Impact / Compatibility**：**回滚不回滚 schema**（规格 §10.3）。runbook 必须写明这条，否则某次"回滚后起不来"会被误判为回滚机制失效。

**Steps**

1. 读 `active-slot` 与 `previous-tag`。
2. 若目标槽的容器仍在运行且 tag 与 `previous-tag` 一致 → **直接渲染上游切回并 reload**（秒级，无需拉镜像）。
3. 若目标槽容器不存在（例如服务器重启过）→ 以 `previous-tag` 起该槽，健康门通过后再切上游。
4. 健康门 + 观察窗口，与 `deploy.sh` 同规格（失败数必须为 0）。
5. 交换 `active-slot`/`previous-tag`，调 `publish-version.sh`，写 deploy.log。
6. **明确不执行任何 migrate**，并在脚本输出里打印一行说明"schema 未回滚，这是设计决定（expand-contract）"。

**Verification**

```bash
sh -n ops/deploy/rollback.sh
# 演练：先发布一个坏镜像（health 必失败），观察 deploy.sh 中止不切流量；
# 再手工 rollback，确认秒级恢复
time ssh deploy@<server> 'cd /srv/voting && ./ops/deploy/rollback.sh'
ssh deploy@<server> 'cat /srv/voting/state/active-slot'
```

预期：回滚耗时在秒级（记录实测值）；服务恢复；`active-slot` 与发布前一致。

---

#### Task 4.5 零停机证据与负向对照

**Files**

- 新建 `ops/deploy/probe-loop.sh`（持续探测并统计失败数，供演练使用）
- 修改 `ops/runbook/drills.md`（新增"零停机发布"一节）

**Why**：规格 §13.1 第 4 项。这是方案 B **唯一的证伪点**：如果对照也测不出失败请求，那说明探测方式无效，零停机的主张不成立。

**Change Necessity**：需要一个小探测脚本（可复用于演练与日常）。

**Impact / Compatibility**：演练期间会对线上产生流量（探测本身很轻）。

**Steps**

1. 写 `ops/deploy/probe-loop.sh <url> <duration_seconds> <interval_seconds>`：循环请求，统计总数、成功数、失败数、最大连续失败数，结束时输出一行 JSON 摘要（与 `drain.ts` 的风格一致）。
2. **实验组**：启动探测（例如 120 秒 / 2 秒间隔 = 60 次），在探测进行中执行一次双槽发布。**要求失败数 = 0、最大连续失败 = 0**。
3. **对照组**：同一探测下，改用原地更新（`docker compose up -d --force-recreate web-blue`，即把当前槽重建）。**预期出现失败请求**（容器停止到新容器就绪之间的窗口）。
4. 把两次的 JSON 摘要并排列进 `ops/runbook/drills.md` 与规格 §13.1 的证据表。**若对照组没有失败**，则说明探测间隔太粗（例如窗口短于 2 秒），必须缩短间隔重测，直到对照能测出失败为止——否则实验组的"0 失败"没有意义。
5. 截图 Grafana 上发布时段的两个版本标记（`voting_deploy_info`）与错误率曲线。

**Verification**

```bash
cd decentralized-voting-dapp
sh -n ops/deploy/probe-loop.sh
# 实验组（发布期间）
./ops/deploy/probe-loop.sh https://<域名>/api/health 120 2 &
ssh deploy@<server> 'cd /srv/voting && ./ops/deploy/deploy.sh <newsha>'
wait
```

预期：实验组 `{"total":N,"failed":0,"maxConsecutiveFailures":0}`；对照组 `failed > 0`。两份证据都留档。

---

#### Task 4.6 expand-contract runbook

**Files**

- 新建 `ops/runbook/migrations.md`
- 修改 `CONTRIBUTING.md`（增加一条"破坏性 schema 变更必须拆两次发布"）

**Why**：规格 §10.3。双槽并存期间新旧版本同时连一个 MySQL，因此迁移必须向后兼容。这条约束同时是面试必问题的答案。

**Change Necessity**：docs + 一条贡献约束。不写下来，下一个改 schema 的人（包括未来的自己）一定会违反它。

**Impact / Compatibility**：这是对新 schema 变更的**约束**，不改变现有 schema。

**Steps**

1. 写 `ops/runbook/migrations.md`：
   - **允许**：新增表、新增带默认值的列、新增视图、新增索引（对新旧两个版本都无害）；
   - **禁止在同一次发布里**：删除或重命名旧版本仍在读写的列/视图、给已有列加 NOT NULL 而无默认值；
   - **破坏性变更的两次发布法**：第 N 次加新结构并回填（同时保留旧结构），第 N+1 次（确认无旧版本在运行后）删除旧结构；
   - **明确**：回滚 = 回滚镜像，**不回滚 schema**；若某次迁移不向后兼容，该次发布**不可回滚**，必须以前滚方式修复。
2. 在 `CONTRIBUTING.md` 里增加一条约束，指向该 runbook，并说明它与既有五条不变量的关系（它是第 3 条"事件与游标同事务"在发布维度的延伸）。
3. 给出一个**具体的检查命令**：发布前用 `git log --oneline <prev-tag>..<new-tag> -- web/src/lib/db/schema.ts` 判断本次是否动了 schema，输出非空则强制走 runbook 流程。
4. 在 `deploy.sh` 里加一个**警告**（不是阻断）：若本次 tag 涉及 `schema.ts` 变更，打印一行提示"本次含 schema 变更，请确认其为 expand 型且已阅读 ops/runbook/migrations.md"。

**Verification**

```bash
grep -n "expand-contract\|不回滚" CONTRIBUTING.md ops/runbook/migrations.md
sh -n ops/deploy/deploy.sh
```

预期：runbook 与贡献约束均已落地；`deploy.sh` 在涉及 schema 变更时打印警告。

---

### 批五：收尾

#### Task 5.1 七条 ADR 落地

**Files**

现有 ADR 最大序号为 **0039**（已核对 `docs/aegis/adr/` 目录），因此本批新增 7 条为 0040–0046：

- 新建 `docs/aegis/adr/ADR-0040-one-image-carries-three-process-roles.md`
- 新建 `docs/aegis/adr/ADR-0041-images-are-rebuilt-per-environment.md`
- 新建 `docs/aegis/adr/ADR-0042-observability-never-sits-in-the-startup-path.md`
- 新建 `docs/aegis/adr/ADR-0043-unreadable-lag-is-absent-not-zero.md`
- 新建 `docs/aegis/adr/ADR-0044-migrations-are-expand-contract-and-rollback-excludes-schema.md`
- 新建 `docs/aegis/adr/ADR-0045-deployments-pin-an-immutable-tag.md`
- 新建 `docs/aegis/adr/ADR-0046-deployment-logic-lives-in-repo-scripts.md`
- 修改 `docs/aegis/INDEX.md`（逐条登记）

**Why**：`CONTRIBUTING.md:86` 要求"改动架构面时请一并新增或修订 ADR，而不是只在提交信息里说明"。规格 §12 已登记 7 项信号，每项都含被否掉的替代方案。

**Change Necessity**：docs-only。但这是本项目的硬约束，不是可选项。

**Impact / Compatibility**：无代码影响。ADR 必须带 `Status:` 与规范小节（否则 `aegis-workspace.py check` 会报缺短语——本会话已观察到 ADR-0023/0024 存在该问题）。

**Steps**

1. 逐条落地规格 §12 的 7 项，每条含：Context / Decision / Alternatives Considered（含**被否掉的理由**）/ Consequences / Compatibility Boundary / Retirement Impact / Baseline Sync / Evidence References：
   a. **ADR-0040** 一个镜像承载 web / migrate / indexer 三个角色（被否：按角色拆多个 Dockerfile）；
   b. **ADR-0041** 镜像按环境重建，而非运行时注入 `NEXT_PUBLIC_*`（被否：运行时配置端点）；
   c. **ADR-0042** 监控栈不参与应用启动路径（被否：监控与监控对象同生共死）；
   d. **ADR-0043** `lagBlocks` 不可读时序列 absent，配 `absent()` 告警（被否：导出 0）；
   e. **ADR-0044** schema 迁移采用 expand-contract，回滚不含 schema（被否：可逆迁移）；
   f. **ADR-0045** 部署只使用不可变 tag（被否：用 `latest`）；
   g. **ADR-0046** 部署逻辑入库为脚本而非内联 YAML（被否：内联 YAML）。
2. 每条 ADR 必须引用本计划的具体 Task 与实测证据（不是"将会"）。
3. 登记进 `docs/aegis/INDEX.md`，然后跑 `check`。
4. 顺带修掉本会话发现的**既有**登记缺口（ADR-0033、ADR-0036～0039 未登记；ADR-0023/0024 缺短语）——**这一项需先经用户确认**，因为它是前序工作流的遗留，不属于本计划范围（`anti-entropy-governance` 要求退役/修补他人产物前需显式确认）。

**Verification**

```bash
python <aegis>/scripts/aegis-workspace.py check --root .
grep -c "Status: \`" docs/aegis/adr/ADR-00*.md
```

预期：新 ADR 全部通过结构校验；INDEX 已登记。

---

#### Task 5.2 基线记录与简历材料

**Files**

- 新建 `docs/aegis/baseline/2026-09-22-containerization-and-delivery.md`
- 修改 `README.md`（新增"部署与运维"章节、更新实测指标、更新已知局限）
- 新建 `docs/aegis/work/2026-09-22-delivery-evidence/90-evidence.md`（截图与命令输出索引）

**Why**：README 的既有章节对每一行都标注了"已实测"，并且专门记录了"容器没真正跑起来"这类未实测边界。本阶段必须沿用这个标准——**这正是这个项目最有说服力的地方**。

**Change Necessity**：docs-only。

**Impact / Compatibility**：README 是唯一面向外部读者的权威文档；更新它必须与代码同步。

**Steps**

1. 写基线记录，按规格 §13.1 的 11 项逐项给出：验收项 / 命令 / 实测输出 / 结论（已实测 / 未实测）。
2. 明确标注**未实测**的部分（预期至少包括：TLS 若有域名缺失、arm64 若未覆盖、Pinata 若缺凭据导致的演示投票元数据缺失、`LagUnknown` 演练若无法精确产生 absent）。
3. 更新 README：新增"部署与运维"章节（一键拉起、生产发布、回滚、监控入口）；更新实测指标表（镜像体积、零停机探测结果、流水线耗时）；删除或改写已不成立的已知局限（如"Docker 路径未实测"）。
4. 整理简历材料：把规格 §13.2 的映射表落成实际的截图清单与文件路径，每张截图配一句"它证明了什么"。
5. **不要**在 README 或任何文档里写入未实测的主张。若某项没跑通，写"未实测"并说明原因。

**Verification**

```bash
ls docs/aegis/baseline/2026-09-22-containerization-and-delivery.md docs/aegis/work/2026-09-22-delivery-evidence/90-evidence.md
grep -c "未实测" docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
pnpm format:check
python <aegis>/scripts/aegis-workspace.py check --root .
```

预期：两份文档存在；未实测项被显式标注（这个计数不应为 0）；格式与工作区校验通过。

---

## 兼容边界与退役

**必须保持（违反即为设计缺陷）**

| 边界                                                    | 验证 Task                |
| ------------------------------------------------------- | ------------------------ |
| `docker compose up -d mysql` 仍可用，服务名与 3307 不变 | Task 1.3、Task 1.7       |
| schema 只有一个所有者（无 initdb 脚本）                 | Task 1.5                 |
| `/api/health` JSON 契约不变                             | Task 2.1（新增而非替换） |
| `lagBlocks` 的 null 语义不得在指标层被抹平              | Task 2.1（负向对照）     |
| 应用在监控全缺时仍正常启动与服务                        | Task 2.3、Task 1.7       |
| 失败报告不回显配置值                                    | Task 3.3、Task 3.4       |
| `ci.yml` 既有 5 个 job 语义不变                         | Task 3.1                 |
| 部署链路不引入持币私钥                                  | Task 3.4                 |

**退役项**

| 退役对象                                               | 原因                                          | 处置                                                                            |
| ------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------- |
| 规格 §4.2 的 `chain` 服务（`--profile local`）         | 用户选择只接 Sepolia                          | 不实现；本地开发改由 `host.docker.internal` 访问宿主机 hardhat node（Task 1.6） |
| prod 中 web 的进程内索引循环（`INDEXER_ENABLED=true`） | 索引由独立 worker 承担                        | 显式置 `false`（Task 4.2）；**代码保留**，因为它是 dev 便利，且默认行为不变     |
| Sepolia 上的旧工厂 `0xcf01c9d5…`                       | 缺 `currentRulesHash`/`rulesHash`（§13 实测） | 归档记录并重新部署（Task 0.4）                                                  |

---

## Execution Route

```text
Execution Route:
- Decision: inline
- Evidence: 批次之间是严格串行的依赖链——批一产出的镜像 tag 是批三构建与批四双槽的输入；
  批二的 metrics 端点是批三健康门与批四观察窗口的观测对象；批四改写批三已建立的部署脚本。
  同一条文件（ops/deploy/deploy.sh）在批三与批四被连续修改，并行会直接冲突。
  此外批零的 Task 0.1（Docker 引擎）是批一的前置，Task 0.6（SMTP）是 Task 2.5 的前置，
  这两条链路无法并行启动。
- Fallback: 批二的配置类任务（Task 2.4 exporters、Task 2.6 Grafana 看板）与批一批三无共享文件，
  若用户希望压缩时间，可在批一的 Dockerfile 冻结后并行委派；但 Task 2.1（metrics 端点）
  必须串行，因为它是批三健康门与批四观察窗口的依赖。
- User confirmation required: no
```

---

## Verification（批次级总验收）

**每批结束必跑：**

```bash
cd decentralized-voting-dapp
pnpm test                    # 合约 + web 全绿
pnpm typecheck
pnpm format:check
pnpm build:web
docker compose config --quiet
```

**批零额外：**

```bash
docker version --format '{{.Server.Version}}'    # 非空
docker run --rm hello-world
pnpm export-abi && git status --short -- web/src/lib/contracts
# 链上只读复查：新工厂 currentRulesHash() 不再 revert、pollCount() >= 1
```

**批一额外：**

```bash
docker compose down -v
docker build -f web/Dockerfile -t voting-web:dev .
docker image ls voting-web:dev          # 记录体积，目标 < 250MB
docker compose up -d --wait && docker compose ps
docker compose run --rm migrate && docker compose run --rm migrate   # 幂等
```

**批二额外：**

```bash
docker compose --profile observability up -d --wait
curl -s localhost:3000/api/metrics | head -40
promtool check rules ops/prometheus/rules/voting.yml
# 四类故障演练各留"告警到达"的截图（drills.md）
```

**批三额外：**

```bash
gh run list --limit 5
gh run view <run-id> --json jobs --jq '.jobs[] | {name, conclusion}'
# 负向对照：测试失败时 build/deploy 必须不执行
```

**批四额外：**

```bash
./ops/deploy/probe-loop.sh https://<域名>/api/health 120 2 &   # 实验组
ssh deploy@<server> 'cd /srv/voting && ./ops/deploy/deploy.sh <sha>'
wait
time ssh deploy@<server> 'cd /srv/voting && ./ops/deploy/rollback.sh'
# 对照组：原地 up -d --force-recreate，同一探测必须出现失败请求
```

---

## Risks

| 风险                                            | 影响                                      | 缓解 / 处置                                                                                              |
| ----------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Docker 引擎修不好（README 记录过 API 持续 500） | 本计划没有任何一条能标"已实测"            | Task 0.1 备选路线：WSL2 内原生 Docker Engine + 仓库移入 WSL 文件系统                                     |
| 批四未提交改动与 push 冲突                      | 历史里混入未完成工作流                    | Task 0.3 第 1 步：先由用户决定其归属；本计划任何 Task 不得提交或回退它们                                 |
| `tsx` 不在生产依赖中                            | migrate / indexer 容器启动即失败          | Task 1.2 第 5 步显式处理，并写进 ADR（Task 5.1a）                                                        |
| standalone 的 `server.js` 路径与预期不符        | ENTRYPOINT 指向不存在的文件               | Task 1.1 第 4 步先确认路径再写 Dockerfile                                                                |
| `HOSTNAME` 未设为 `0.0.0.0`                     | 容器内服务正常但容器外连不上              | Task 1.2 第 4 步固化                                                                                     |
| 无法精确产生 `lagBlocks === null`               | `LagUnknown` 演练无法完成，设计点无法证明 | Task 2.8 第 3 步先读 `lib/data.ts` 核实语义；若无法产生则**如实记为未完成**，不得用"导出 0 也能告警"替代 |
| 零停机对照组测不出失败                          | 实验组的"0 失败"失去意义                  | Task 4.5 第 4 步：缩短探测间隔重测，直到对照能测出失败                                                   |
| 不向后兼容的迁移                                | 双槽并存期新槽读写失败；回滚后服务起不来  | Task 4.6 的 expand-contract 约束 + runbook                                                               |
| 服务器是 arm64                                  | 镜像 exec format error                    | §12 第 1 项：Task 0.2 先取 `uname -m`                                                                    |
| 监控栈内存挤占导致应用 OOM                      | 应用被 kill                               | 每个容器设内存限额（Task 2.3–2.6）；§12 第 2、6 项                                                       |
| 邮件被投进垃圾箱                                | 演练时误判为"告警没发出"                  | Task 0.6 第 3 步先验证投递，并把发件人加入白名单                                                         |
| Grafana 对公网暴露                              | 被扫描、弱口令                            | §12 第 4 项：仅 SSH 隧道访问                                                                             |
| `absent()` 规则被漏配或写错                     | "索引整个挂掉"反而不告警                  | Task 2.3 逐字给出表达式；Task 2.8 演练丙专门验证它触发                                                   |

**BASELINE-GOVERNANCE §6 七维复核重点（每批结束时）**

- **第 6 条 Retirement completeness**：`chain` 服务已登记退役；prod 中 web 的索引循环已退役但代码保留（dev 便利），须确认没有"两份都在推进游标"的实际路径。
- **第 7 条 Entropy flow**：新增约 22 个文件。须证明每一项都对应一条验收项，且没有引入第二处 schema 定义、第二处健康数据来源或第二处发布状态真相。
- **第 3 条 Contract changes**：`/api/health` 不变、`/api/metrics` 新增、compose 的 mysql 定义不变——三处都需在批五逐条登记。

---

## 14. 阻塞记录

### 14.1 Task 0.1 无法在本会话内解除（2026-09-22 19:27 实测）

**症状**：`docker version` 报 `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`。

**排查路径与证据**

| 步骤                    | 检查                                                                        | 结果                                                                 |
| ----------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Docker Desktop 是否在跑 | `Get-Process com.docker.backend`                                            | 无进程                                                               |
| 可执行文件是否存在      | `Test-Path 'C:\Program Files\Docker\Docker\Docker Desktop.exe'`             | True（已安装）                                                       |
| 启动后是否存活          | `Start-Process '…\Docker Desktop.exe'`                                      | 进程随即消失，210 秒内引擎未就绪                                     |
| WSL 发行版              | `wsl -l -v`                                                                 | `Ubuntu` 与 `docker-desktop` 均 `Stopped` 且无法启动                 |
| WSL 启动失败原因        | `wsl -d Ubuntu -- true`                                                     | `Wsl/Service/CreateInstance/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED` |
| 虚拟机监控程序          | `(Get-CimInstance Win32_ComputerSystem).HypervisorPresent`                  | **False**                                                            |
| BIOS 虚拟化             | `VirtualizationFirmwareEnabled` / `SecondLevelAddressTranslationExtensions` | True / True（**不需要进 BIOS**）                                     |
| Docker Windows 服务     | `Get-Service com.docker.service`                                            | `Stopped` / `Manual`                                                 |
| 当前权限                | `WindowsPrincipal.IsInRole(Administrator)`                                  | **False**                                                            |
| 功能状态                | `Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform`    | **`requires elevation`（连查询都要提权）**                           |

**根因**：Windows 可选功能 `VirtualMachinePlatform`（WSL2 依赖的虚拟机平台）**未启用**，因此 WSL2 无法创建虚拟机，Docker Desktop 的 WSL2 后端也就无法启动引擎。这是 Windows 功能缺失，不是 Docker 配置问题。

**解除方式**（需管理员权限，且**必须重启**；本会话审批提示被禁用，故无法自行执行）

```powershell
# 以管理员身份打开 PowerShell（Win+X → 终端(管理员)）
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
Restart-Computer
```

等价单命令：`wsl --install --no-distribution`（同样需要提权与重启）。

重启后验证：

```powershell
wsl -l -v                     # 两个发行版应可启动，VERSION 为 2
docker version                # 引擎版本非空
docker run --rm hello-world   # 成功
```

**影响范围**：Task 0.1 是批一至批四全部"实测证据"的前提。解除前，Task 1.2–1.7 只能编写、不能验证；按本项目纪律，未验证不得标记完成。

**不依赖 Docker 的可推进项**（若选择并行推进）：Task 1.1（standalone 产物，`pnpm build:web` 可验证）、Task 2.1（`/api/metrics`，`pnpm test` / `pnpm typecheck` 可验证）、Task 5.1（七条 ADR，`aegis-workspace.py check` 可验证）。

### 14.2 仓库存在并发写入者（2026-09-22 19:27 实测）

**证据**：`d801bba`（19:19:12，i18n 批次）提交后，工作区在数分钟内再次变脏，且文件 mtime 与查询时刻几乎重合：

```text
19:26:56  web/src/lib/i18n/messages.ts
19:27:03  web/test/i18n.test.ts
19:27:24  web/src/lib/templates.ts
查询时刻  19:27:26
```

**含义**：本仓库当前**不是**单一写入者。`executing-plans` 要求协调者是唯一的 Git 变更所有者，而并发者在同一工作区写 `web/` 会让两件事同时失效：

1. **验证结果不可归因**——测试变红可能是对方的中间态，而不是本计划的改动；
2. **构建产物互相破坏**——两个 `next build` 同时写同一个 `web/.next` 目录。这是本计划刻意不启动 `web/` 构建的直接原因。

**附带发现**：本计划文件在提交前被外部 `pnpm format` 重新格式化过（Progress 表格出现对齐填充），说明并发会话会运行全仓库 prettier。因此本计划的任何 markdown 编辑都要以 `pnpm format:check` 通过为准，否则会让 CI 的 format 作业失败。

**处置**：在并发写入停止或明确协调之前，不启动 `web/` 的构建与测试，也不提交任何 `web/` 路径。

### 14.3 解除安排（2026-09-22 使用者决定）

| 阻塞              | 使用者的决定                                                | 谁来做                                       |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------- |
| §14.1 Docker 引擎 | 提权启用 `VirtualMachinePlatform` 并重启本机                | **使用者**（本会话无提权，且审批提示被禁用） |
| §14.2 并发写入者  | 那是使用者自己的另一个会话，正在做批四 i18n；**让它先做完** | 使用者协调；本计划在此期间不动 `web/`        |

**恢复执行的前置条件**（两者都满足后再开始批一）：

```powershell
# 1. 重启后本机 Docker 可用
wsl -l -v                     # 两个发行版可启动，VERSION 为 2
docker version                # 引擎版本非空
docker run --rm hello-world   # 成功
# 2. 工作区干净，且批四 i18n 已由那个会话提交
git status --short            # 为空
```

**恢复后的第一个动作**：Task 0.1 的收尾验证（上述三条命令留证），随后进入 Task 1.1。若本机 Docker 在重启后仍不可用，则改走 §14.1 登记的备选路线（WSL2 内装原生 Docker Engine，并把仓库移入 WSL 文件系统），并在基线记录中写明"Docker 引擎位于 WSL2"。

**本计划在等待期间不做的事**：不编写无法验证的 `ops/` 配置（按 §1 的纪律，未实测不得标记完成），不提前写批五的 ADR（ADR 记录的是已执行的决策，不是待执行的设想）。

### 14.4 执行 Task 1.1 时的两项实测发现（2026-09-22）

执行 Task 1.1（新增 `output: "standalone"`）时逐项验证产物，得到两项计划未预见的结果。

**发现一：本机构建的 standalone 不自包含**

| 检查                                                          | 实测                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `.next/standalone/web/server.js`                              | 存在（入口路径与计划预期一致）                                                                    |
| `standalone/node_modules/.pnpm/…/mysql2`                      | 存在，92 文件 / 0.53 MB（含 `promise.js` 与 `lib/**`）                                            |
| 指向 `mysql2` 的顶层链接                                      | **不存在**（`standalone/node_modules/` 只有 `.pnpm`；`standalone/web/node_modules/` 只有 `next`） |
| `standalone/web/node_modules/next`                            | **Junction，指向仓库绝对路径** `D:\桌面\实习项目\…\node_modules\.pnpm\next@…`                     |
| standalone 复制到仓库外后 `require.resolve("mysql2/promise")` | **`MODULE_NOT_FOUND`**                                                                            |
| 同一副本里 `require.resolve("next")`                          | 成功——但只因那个 Junction 指回了本机仓库，容器内会悬空                                            |

结论：Windows 上用 pnpm + Next standalone 产出的目录**既不自包含也不可移植**。

**这不等于 Linux 容器内也坏**：pnpm 在 Linux 用真实符号链接，Next 追踪器在那边大概率能建出完整链接。但**本机无法验证**，因此：

- 判定为**未验证**，不得当作通过；
- Task 1.2 已增补镜像内自检 `RUN node -e "require.resolve('mysql2/promise')"`，让不自包含的镜像在**构建时**失败，而不是运行时才崩；
- 计划原来的断言（`standalone/node_modules/mysql2` 存在）已按实测改写。另注：`mysql2/index.js` 不在追踪集内是**正常**的——应用只 `import "mysql2/promise"`，而 `promise.js` 不 require `index.js`，故 `index.js` 确实不可达。

**发现二：`next build` 会把 `web/.env` 复制进 standalone，从而烘进镜像**

| 检查                        | 实测                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/.env` 是否被 git 忽略  | 是（`.gitignore:26`）                                                                                                                                                               |
| `.next/standalone/web/.env` | **存在**，909 字节，与仓库那份大小相同                                                                                                                                              |
| 其中的变量名                | `RPC_URL`、`CHAIN_ID`、`DATABASE_URL`、`CONFIRMATIONS`、`CHUNK_BLOCKS`、`POLL_INTERVAL_MS`、`INDEXER_ENABLED`、`LOG_LEVEL`、`NEXT_PUBLIC_LOCAL_RPC_URL`、`NEXT_PUBLIC_IPFS_GATEWAY` |
| 当前值的性质                | 均为本地开发值（`RPC_URL=http://127.0.0.1:8545`；`DATABASE_URL` 指向 `127.0.0.1:3306/voting_local_e2e`，无外部凭据）                                                                |

**为什么计划没挡住**：Task 1.2 原第 6 步只要求 `.dockerignore` 排除 `.env`。但 `.dockerignore` 只作用于**构建上下文**，而这一份 `.env` 是 `next build` **在构建阶段自己生成**的——排除上下文挡不住它。两处必须同时处理。

**当前风险有限，机制危险**：就现有内容而言，泄漏的只是本地回环地址，没有可利用凭据。但只要构建机上有生产 `.env`（带 API key 的 RPC、生产库口令），一次 `docker push` 就等于公开凭据。因此 Task 1.2 已增补 `RUN rm -f /app/web/.env /app/web/.env.*`，以及一条"镜像内不得残留 `.env`"的验证，并要求写进 ADR-0016/0020 的边界。

**对计划的影响**：Task 1.1 的配置改动本身已验证通过（`server.js` 路径确认、typecheck 与 format 退出码均为 0、负向对照成立），但**批一在此停住**——Task 1.2 起的每一条验证都需要一个 Linux 镜像，而 Docker 尚未解除（§14.1）。

### 14.5 Task 2.1 完成记录与三处规则修正（2026-09-22）

批一停在 Task 1.2 之后，转去做**完全不依赖 Docker** 的 Task 2.1，因为它的验证义务全在 `pnpm` 里。它已完成。

**新增文件**

| 文件                               | 作用                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `web/src/lib/metrics.ts`           | 纯函数 `renderMetrics(input): string`；把健康读数渲染成 Prometheus 文本。另含 `escapeLabelValue` 与 `createIndexErrorCounter` |
| `web/src/app/api/metrics/route.ts` | `GET /api/metrics`，`dynamic = "force-dynamic"`；只负责取数与输出                                                             |
| `web/test/metrics.test.ts`         | 24 个测试                                                                                                                     |

数据来源复用 `getHealth()`，是它的**第二个读者**，不是第二个真相源。`getHealth()` 不带 locale 调用——故意的：错误计数器比较的是渲染后的 `indexError` 句子，若跟随请求语言，切换语言会被误记成一次新故障。

**实测证据**

| 验证项                               | 结果                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 单元测试                             | 24 个新增全过；web 全量 **711 通过 / 0 失败**（含 140 个 suite）                                                                       |
| `pnpm typecheck`                     | 退出码 0                                                                                                                               |
| `pnpm build:web`                     | 成功，路由表出现 `ƒ /api/metrics`                                                                                                      |
| 端到端（本地链 31337，区块 1662）    | HTTP 200，`content-type: text/plain; version=0.0.4; charset=utf-8`，10 条序列格式完整，`voting_index_lag_blocks 0`（**真实测得的 0**） |
| `pnpm format:check`                  | 通过                                                                                                                                   |
| **负向对照：把 null 分支改成输出 0** | **恰好 2 个守护测试变红**（"不能回答时必须缺席"与"非整数时必须缺席"），22 通过 2 失败 → 证明测试真的在保护 ADR-0015，而不是摆设        |

**端到端验证了 absent 路径**（原计划把它排在 Task 2.8 演练丙，需要 Docker；实际上不需要，一个不可达的 `DATABASE_URL` 就能精确制造）：

注入 `DATABASE_URL` 指向不可达端口后，`/api/health` 返回 `lagBlocks: null`、`lastIndexedBlock: null`、`indexConfigured: true`、`indexError` 为"索引数据库不可读"，而 `chainHead`/`pollCount` 仍可读（应用继续从链上服务，这是既有行为）。同一时刻 `/api/metrics`：

- **`voting_index_lag_blocks` 整条缺席**（连 HELP/TYPE 都没有），`voting_index_last_block` 同样缺席；
- **`voting_index_configured 1` 仍在**；
- `voting_index_errors_total` 从 0 变成 **1**（计数器确实捕获了跃迁）；
- `voting_chain_head_block 1662`、`voting_poll_count 2` 仍在。

`voting_index_configured == 1` 与缺席的 lag 同时出现，正好是 Task 2.3 那条 `absent(voting_index_lag_blocks) and on() (voting_index_configured == 1)` 依赖的条件——**该规则的触发前提现在有真实数据支撑**，不再是纸面推演。

**执行中发现的三处计划缺陷，均已修正**

1. **`VotingApiErrorRate` 依赖不存在的序列**（Task 2.3）。原规则用 `voting_http_requests_total`，但没有任何 Task 产出它。按请求粒度的 RED 需要在 `middleware.ts` 或 17 个路由里埋点，而规格 §5.2 把功能性应用改动列为非目标。改为基于 blackbox 的 `VotingApiSlow`（`probe_duration_seconds > 2`）——测同一件事且不侵入应用。
2. **`business.json` 引用不存在的直方图**（Task 2.6）。原写"索引同步耗时直方图分位"，但无此指标。改为 `voting_index_errors_total` 的 `rate()`。
3. **看板命名误导**（Task 2.6）。`api-red.json` 的 RED 三件套里两个序列都不存在，改名为 `api-probe.json`。

三处的共同理由写进了计划：**查空的图表和永不触发的规则一样，会让人以为自己有覆盖**。这条约束现在也作为通用要求写进了 Task 2.6 的第 3 步——每块看板引用的序列都必须能在某个 Task 的产出里找到出处。

**本 Task 未覆盖的**：`/api/metrics` 在 `getHealth()` **抛异常**时返回 503 的分支没有端到端验证（上面那次降级是 `getHealth()` 正常返回、把数据库错误收进 `indexError`，所以走的是 200 分支）。该分支只有代码审查，没有实测，按纪律标注为未验证。
