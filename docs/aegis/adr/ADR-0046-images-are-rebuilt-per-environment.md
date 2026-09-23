# ADR-0046 - 镜像按环境重建（NEXT_PUBLIC_* 在构建期内联），tag 用 git sha；不做运行时注入

Status: `recorded-from-plan`
Date: `2026-09-22`

## Source Evidence

- `web/Dockerfile`（计划 Task 1.2）：`builder` 阶段接收 `ARG NEXT_PUBLIC_LOCAL_RPC_URL` / `NEXT_PUBLIC_SEPOLIA_RPC_URL` / `NEXT_PUBLIC_IPFS_GATEWAY`，并在同一阶段 `ENV` 后执行 `pnpm --filter @voting/web build`；文件头注释写明「changing one requires a rebuild and therefore a new tag」
- `web/next.config.ts`（计划 Task 1.1）：新增 `output: "standalone"`，注释说明它是纯打包关注点、不改变应用行为
- 规格 §5.2 非目标表最后一行：唯一允许的应用代码改动是新增 `/api/metrics` 路由与 `next.config.ts` 加 `standalone`，二者都不改变既有行为
- ADR-0019 第 7 条与 Consequences：新增 `NEXT_PUBLIC_SEPOLIA_RPC_URL`，且明确记着「`NEXT_PUBLIC_*` 是构建期内联的，改浏览器 RPC 需要重新构建」——浏览器端的链身份来自部署配置，这是承重设计而不是便利
- 实测（计划 §14.8 验证表）：`docker compose config --quiet` 退出码 **0**；`WEB_IMAGE_TAG` 由部署脚本导出，`docker-compose.yml` 用它拼出镜像引用
- `.github/workflows/release.yml` 第 62 行：`run: echo "version=sha-$(git rev-parse --short=12 HEAD)" >>"$GITHUB_OUTPUT"`；deploy job 消费 `needs.build.outputs.version`
- 边界：Docker 引擎本阶段不可用（计划 §14.8），**没有任何一次按 build-arg 的重建被执行过**；本条的结论来自配置与脚本的静态事实

## Context

规格 §3.4 把 `NEXT_PUBLIC_*` 在构建期内联列为第一个「会咬人的约束」（C1）：`web/.env.example` 第 87–89 行自己写着「a `NEXT_PUBLIC_*` value is inlined into the client bundle at build time, so both of these need a rebuild to take effect」。

这条约束之所以承重，是因为 ADR-0019 已经决定**浏览器端的链身份来自部署配置**：浏览器需要知道本次部署指向哪条链、合约地址是哪一个、浏览器该用哪个 RPC 端点。这些值只能经由 `NEXT_PUBLIC_*` 到达客户端包，因为 `CHAIN_ID` 与 `VOTING_ADDRESS` 是服务端变量，浏览器**没有任何途径**知道它们。也就是说这些 `NEXT_PUBLIC_*` 不是可删的装饰，删掉就退回到 ADR-0019 修掉的那个缺陷：整页认错了链。

因此问题不是「要不要在运行时注入」，而是「这些值只能在构建期定下来，那镜像与环境是什么关系」。

## Decision

**一、一个镜像只服务一个环境；每次部署按 build-arg 重建镜像。**

`NEXT_PUBLIC_*` 在构建期内联进客户端 bundle，这是平台的既有行为，本阶段不改它，也不绕过它。把 `NEXT_PUBLIC_*` 作为 `ARG` 在 `builder` 阶段注入，因此镜像与环境绑定。

**二、镜像 tag 用 git sha（`sha-<12hex>`），不用环境名。**

环境名做 tag 会让「同一个 tag 在不同时间指向不同字节」，那正是 `latest` 的病（见 ADR-0050）。git sha 让「这个环境在跑哪个提交」是一个可回答的问题。

**三、`web/next.config.ts` 的 `output: "standalone"` 是规格 §5.2 允许的两处应用代码改动之一。**

它是一个非功能性配置项：改变的是产物形状（`.next/standalone` 而不是整个 `node_modules`），不是应用行为。另一半是新增 `/api/metrics` 路由，那一条的范围与告警见 ADR-0048。

**四、构建期断言，而不是运行时兜底。**

runner 阶段 `RUN node -e "require.resolve('mysql2/promise')"` 让依赖布局问题在构建期失败，同时 `RUN rm -f /app/web/.env ... && test ! -e /app/web/.env` 保证构建机上的一份 `.env` 不会被 `next build` 带进已发布的镜像。后者尤其重要：该文件是构建**产生**的，不是从上下文拷来的，因此 `.dockerignore` 拦不住它。

## Alternatives Considered

- **运行时配置端点**（规格 §6.4 登记的被否方案）：新增一个让浏览器在启动时拉取配置的接口。否掉的理由有两条且都具体：(a) 需要改动应用代码与 wagmi 的初始化路径，而规格 §5.2 把功能性改动列为非目标；(b) 极易把服务端的 `RPC_URL`（含 apiKey）泄给浏览器——`.env.example` 第 87–89 行已经明确区分服务端与浏览器端两套变量，混淆二者是安全缺陷而不是便利。
- **在容器启动时用 envsubst 重写已构建的 JS。** 重写的是内联后的产物，没有任何机制保证被替换的字符串只出现在预期位置；一旦漏改一处，浏览器会拿旧链的配置去读新链的合约，而 ADR-0019 的教训正是这种错误只在特定部署下可见。
- **用环境名做镜像 tag**（`voting-web:prod`）。同一个 tag 会随时间指向不同字节，回滚就不再指向一个确定的制品；这与 ADR-0050 否掉 `latest` 是同一条理由。
- **让一个镜像跨环境复用，靠挂载不同的 `.env`。** 对服务端变量成立，对 `NEXT_PUBLIC_*` 不成立——它们已经被内联进客户端 bundle，挂载 `.env` 不会改变已经写进 JS 的字面量。这条替代方案看起来最省事，也是唯一一条会**静默**失效的：服务端读到新值，浏览器还在用旧值。

## Consequences

- 正面：`NEXT_PUBLIC_*` 的取值与镜像字节一一对应，因此「测过的镜像就是部署的镜像」这句话对浏览器端配置也成立。
- 正面：改浏览器 RPC 或 IPFS 网关会强制产生一个新 tag，于是它必然走一遍完整的发布与健康门流程，而不是一次「只改配置」的静默重启。
- 代价：改一个 `NEXT_PUBLIC_*` 需要重新构建并重新推送镜像，构建缓存中 `builder` 之后的所有层都失效。这是 C1 的直接代价，也是本阶段选择接受它的原因——替代方案会改动应用代码或泄漏服务端凭据。
- 代价：镜像仓库里每个环境各有一份镜像，存储成本随环境数线性增长。当前只有一个生产环境，规模上不构成问题。
- **未实测**：镜像从未构建过（Docker 引擎不可用），因此「按 build-arg 重建确实把值写进了客户端 bundle」这条因果链在本阶段只有代码与配置层面的依据，没有产物层面的证据。CI 的 `release.yml` 也从未真正跑过（计划 §14.10 已记为未验证）。
- 边界：`NEXT_PUBLIC_*` 在构建期内联这一点**没有**被本阶段改变，它仍然是 ADR-0019 那条约束的一部分；本 ADR 只决定「因此镜像按环境重建」，不声称解决了内联本身。

## Compatibility Boundary

`/api/*` 的响应形状、页面行为、合约交互与 `deployments` 生成物均未改动。唯一进入应用代码的两处是 `output: "standalone"`（改变产物形状）与新增 `/api/metrics`（新增表面，不替换既有表面）。镜像引用方式对既有本地用法是加法：`docker-compose.yml` 用 `${WEB_IMAGE:-voting-web}:${WEB_IMAGE_TAG:-dev}`，不设变量时仍解析为 `voting-web:dev`，与 `docker build -f web/Dockerfile -t voting-web:dev .` 的既有命令一致。

## Retirement Impact

若 Next.js 将来支持把客户端配置外置为运行时可读的资源（例如 import maps 或官方运行时配置），第一条应当重新审视：届时「一镜像一环境」的成本可以去掉，但**必须同时**保证服务端凭据不会被带进浏览器可见的资源，否则就是规格 §6.4 已经否掉的那个安全缺陷换了个入口。若引入多环境（staging / prod 双集群，规格 §5.2 明确列为非目标），第二条的 tag 规则不变，只是 `sha-<12hex>` 需要配合环境标签才能唯一指认，届时应在 tag 中显式带上环境而不是复用同一个 sha。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: 「镜像与环境的关系」是本阶段新引入的架构事实：此前项目没有镜像，因此基线中不存在这一面。ADR-0019 登记的是浏览器端链身份的来源，本轮把同一约束在交付维度上的后果（镜像按环境重建）建档，两者是同一件事的两端，新基线快照应把它们并列，避免读者只读到其中一半。

## Evidence References

- web/Dockerfile
- web/next.config.ts
- docker-compose.yml
- .github/workflows/release.yml
- docs/aegis/adr/ADR-0019-the-browser-reads-the-chain-the-deployment-is-configured-for.md
- docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
