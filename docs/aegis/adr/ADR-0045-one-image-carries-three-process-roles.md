# ADR-0045 - 一个镜像承载 web / migrate / indexer 三个角色，角色差异只由 compose 的 command 表达

Status: `recorded-from-plan`
Date: `2026-09-22`

## Source Evidence

- `web/Dockerfile`（计划 Task 1.2）：五阶段 `base` / `deps` / `builder` / `runtime-deps` / `runner`；末尾是 `CMD ["node", "web/server.js"]`，不是 `ENTRYPOINT`
- `docker-compose.yml`（计划 Task 1.3）：`migrate`（`["node", "--import", "tsx", "web/scripts/migrate.ts"]`）、`indexer`（`["/app/ops/indexer/entrypoint.sh"]`）、`web` 三个服务同用 `${WEB_IMAGE:-voting-web}:${WEB_IMAGE_TAG:-dev}`
- 实测（计划 §14.8 验证表）：`docker compose config --quiet` 退出码 **0**；展开后四服务，三个角色共用 `voting-web:dev`，依赖条件为 `service_healthy` / `service_completed_successfully`
- 实测（计划 §14.8 修正 1）：`web/scripts/migrate.ts` 的 import 链实测为 `../src/lib/config` 与 `../src/lib/db/migrate`，这两个目录**不在 Next 构建的依赖图里**，standalone 的追踪器永不带上 `web/scripts` 与 `web/src`
- 实测（计划 §14.8 修正 2）：`npm i -g tsx` 之后 `node --import tsx` 报 `Cannot find module 'tsx'`——Node 按工作目录的常规规则解析 `--import` 的说明符，全局前缀不在解析路径上，`NODE_PATH` 对 ESM 解析也不生效
- 实测（计划 §14.8 修正 3）：Dockerfile 若用 `ENTRYPOINT ["node","web/server.js"]`，compose 的 `command:` 只覆盖 `CMD`，于是三个角色都会被拼成 `node web/server.js <自己的命令>`——每个角色都在跑 web server 并静默忽略自己的命令
- 边界：Docker 引擎在本阶段始终不可用（计划 §14.3 / §14.8），**镜像从未构建过**；本条的所有结论都来自静态校验（`docker compose config` 不需要引擎）

## Context

计划 Task 1.2–1.5 要求把 web、一次性 schema 迁移与索引器 worker 都做成容器，同时 `docker-compose.yml` 第 6–8 行已经写明 schema 只有一个所有者。规格 §4.3 因此把「一个镜像，三个角色」定为核心架构决策：三者共享同一份依赖树、同一份 `lib/db/`（schema / pool / migrate）与同一份 `lib/indexer/`（decode / plan / sync）。

照计划原文直写会做出三个各自失败的容器，这不是推测，是本阶段实测到的三处：standalone 产物不含 `web/scripts` 与 `web/src`（migrate 与 indexer 启动即 `MODULE_NOT_FOUND`）、全局安装的 `tsx` 在 `node --import` 下不可解析、`ENTRYPOINT` 与 `command:` 共存会让三个角色都跑 web server。前两处是「同一个事实写在两个地方」的又一次现身：standalone 的依赖追踪与脚本的实际 import 图是两个不同的答案。

## Decision

**一、web / migrate / indexer 共用一个 Dockerfile 与一个镜像，角色差异只由 compose 的 `command`（与 `working_dir`）表达。**

三者共享同一份事件解码逻辑与同一份 schema 定义。若给 indexer 单独一个 Dockerfile，解码逻辑与 schema 就会产生第二份构建产物，而本项目在批一已经因为「同一条规则写在两个地方」吃过三次亏。这一条直接服务 ADR-0001（链上是唯一事实源）：解码是链上事实进入链下投影的唯一入口，它只能有一个实现。

**二、Dockerfile 用 `CMD`，不用 `ENTRYPOINT`。**

compose 的 `command:` 只覆盖 `CMD`。留着 `ENTRYPOINT`，三个角色的命令会被当作参数追加到 web server 后面，结果是「三个角色都在跑 web server，且没有一个报错」——这是最坏的一种失败：它静默。

**三、runner 阶段显式复制 `web/scripts`、`web/src`、`web/tsconfig.json`，并复制 `runtime-deps` 阶段（`pnpm install --frozen-lockfile --prod`）产生的 pnpm 相对符号链接树，而不是依赖 standalone 的追踪结果。**

这**不违反**「绝不用再拷一个 node_modules 糊过去」这条纪律：用的是 pnpm 自己的产物而非任意目录，且相对链接在 Linux 上可移植——Windows 的 junction 用绝对路径，那才是 standalone 不可移植的原因。

**四、`tsx` 装进镜像自己的 node_modules：`npm install --prefix /app --no-save --no-audit --no-fund tsx@4.20.6`。**

即解析实际会看的位置。代价写在这里：`tsx` 是 devDependency，`--prod` 不会装它，因此运行时镜像必须多带一个 devDependency——这是一镜像三角色换来的、明码标价的成本。

## Alternatives Considered

- **按角色拆多个 Dockerfile**（规格 §12 登记的被否方案）。会让事件解码逻辑与 schema 产生第二份构建产物，两份产物会在某一次只改一边的提交上分叉，而分叉的表现是「索引器写进了一个 schema 里没有的列」。这违反 ADR-0001 关于链下只做只读投影、且投影只有一份的要求。
- **依赖 Next standalone 的依赖追踪把 migrate / indexer 需要的模块带进镜像**（计划 Task 1.2 第 3–5 步的隐含前提）。实测追踪器不覆盖 `web/scripts` 与 `web/src`，照写则容器启动即 `MODULE_NOT_FOUND`。
- **用 `ENTRYPOINT` 加 compose `command:` 给三个角色换命令**（计划 Task 1.2 与 1.3 的原设计）。实测三者都会退化成 web server，且不报错。
- **`npm i -g tsx`**（计划 Task 1.2 第 5 步）。实测 `node --import tsx` 找不到它；要让它工作就得动 `NODE_PATH` 或包装脚本，而 ESM 解析根本不看 `NODE_PATH`。
- **在镜像里再拷一份完整 `node_modules` 兜底**。这是计划 §14.4 明确禁止的「糊过去」：它会把依赖树变成第二份没有 lockfile 背书的真相。本 ADR 选的是 pnpm 自己的相对链接树，两者不是同一件事。

## Consequences

- 正面：`migrate`、`drain` 与 web 运行时**版本严格一致**，不会出现「迁移脚本是新版、运行时是旧版」这种只在部署当天暴露的错配。
- 正面：这是 12-factor 的进程模型——同一份代码、不同进程角色、可独立重启。`indexer` 因此可以单独重启而不动 web。
- 代价：运行时镜像必须携带 `web/scripts`、`web/src`、`web/tsconfig.json` 与一个 devDependency（`tsx`）。这直接与「镜像瘦身目标 < 250MB」竞争，而该目标**未实测**（Docker 引擎不可用）。
- 代价：`migrate` 与 `indexer` 的失败形态是「运行时解析 TypeScript」，比预编译产物多一层可能出错的地方。换取的是脚本源码与 web 源码永远同版本。
- **未实测**：镜像能否构建、体积是否 < 250MB、`mysql2/promise` 在镜像内是否可解析、`migrate` 是否幂等、indexer 循环是否在跑而不退出——全部需要 Docker 引擎，本阶段引擎始终不可用。
- 构建期断言：`RUN node -e "require.resolve('mysql2/promise')"` 让依赖布局问题在**构建期**而不是运行时暴露。这条断言的失败路径**未实测**（镜像未构建过），它本身也只是把发现时机提前，不改变 §14.7 关于「缺的是顶层链接而不是文件」的结论。

## Compatibility Boundary

不改变任何 HTTP 契约、schema、页面行为或 CI 既有 job 的语义。可观察的变化只在容器层：新增 `migrate` 与 `indexer` 两个服务名；`web` 服务不再发布端口（本地端口由 Task 1.6 的 override 提供，生产由 nginx 提供）。既有 `docker compose up -d mysql` 仍可用，服务名 `mysql` 与宿主机端口 `3307` 逐字保留，这是规格 §5.1 的硬边界。

## Retirement Impact

若将来某个角色确实需要独立依赖树（例如索引器换语言或换运行时），本 ADR 的边界是：**解码逻辑必须仍只有一份**，因此应当共享同一份源码或同一份生成物，而不是复制一份实现。若 `tsx` 被预编译产物取代（例如 `tsc` 产出 JS 后再进镜像），第四条退役，镜像可以回到纯 `--prod` 依赖，届时「运行时多带一个 devDependency」这条成本随之消失。若 `migrate` 改由数据库迁移工具（如 Prisma / Drizzle 的独立 CLI）承担，第二条关于 `CMD` 的约束仍适用于 `indexer`。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: 运行时的容器拓扑（哪些进程角色存在、由什么区分、镜像里必须携带什么）此前从未被登记为被验证对象；既有基线 §2 / §5.1 / §6 描述的是两层源码结构与可选 MySQL，与容器拓扑无关。本阶段的新基线快照应把「一镜像三角色」记为当前架构事实，并同时登记镜像从未构建过这一未验证边界。

## Evidence References

- web/Dockerfile
- docker-compose.yml
- .dockerignore
- ops/indexer/entrypoint.sh
- docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md
- docs/aegis/adr/ADR-0001-chain-is-the-only-source-of-truth.md
- docs/aegis/adr/ADR-0006-two-layers-and-optional-mysql.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
