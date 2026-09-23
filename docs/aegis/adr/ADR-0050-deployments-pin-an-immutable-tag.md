# ADR-0050 - 部署只用不可变 tag（sha-<12hex>），禁用 latest

Status: `recorded-from-plan`
Date: `2026-09-22`

## Source Evidence

- 本 ADR 的来源是本计划 **Task 3.2**（`release.yml`：门 → 构建 → 扫描 → 推送）与 **Task 3.4**（SSH 部署 job）；`sha-<12hex>` 这个 tag 规则由 Task 3.2 产出、由 Task 3.4 消费
- `.github/workflows/release.yml` 第 62 行（计划 Task 3.2）：`run: echo "version=sha-$(git rev-parse --short=12 HEAD)" >>"$GITHUB_OUTPUT"`，由 `steps.version.outputs.version` 输出；第 48–50 行的注释写明「The tag deploy consumes. Deliberately a digest-pinned immutable value, never a branch or `latest`.」
- `.github/workflows/release.yml` 第 78 行**确实发布 `latest`**：`type=raw,value=latest,enable={{is_default_branch}}`（第 76 行同时打 `type=raw,value=${{ steps.version.outputs.version }}`）——因此「只用不可变 tag」**不等于**「从不产生 `latest`」，后者是错的
- `.github/workflows/release.yml` 第 222 行（deploy 步骤）：`"cd /srv/voting && WEB_IMAGE='${{ env.IMAGE }}' WEB_IMAGE_TAG='${{ needs.build.outputs.version }}' ./ops/deploy/deploy.sh '${{ needs.build.outputs.version }}'"`——部署路径读的是 sha，不是 `latest`
- `.github/workflows/release.yml` 第 232 行（失败后自动回滚步骤）：`"cd /srv/voting && ./ops/deploy/rollback.sh"`，**不带参数**，因此回到服务器侧记录的 `state/previous-tag`，那也是 sha
- `ops/ci/check-workflows.py` 的 `check_no_mutable_deploy()`（第 125–132 行）：逐行扫描 `release.yml`，**只**对同时含 `deploy.sh` 与 `latest` 的行报 `release.yml: the deploy command references a mutable tag`；第 126 行的 docstring 写明「`latest` may be published, but it must never be what a deploy reads」，第 130 行注释写明「Only the deploy step matters: publishing `latest` for humans is fine.」——**断言的口径是「部署命令中不含可变形 tag」，不是「仓库中不出现 `latest`」**；`check_release()` 另断言 `needs.build.outputs.version` 出现在文件中
- `ops/ci/check-workflows.py` 第 19–21 行的文件头注释：「Deploying a mutable tag means a rollback to `latest` is not a rollback to anything in particular, and two deploys of the same name can be different images.」
- 实测（计划 §14.10）：`ops/ci/check-workflows.py` 退出码 **0**；`ops/ci/selftest.py` **9 项全过**——8 个故意破坏各自被抓住，干净树通过，其中第一个用例就是「deploy reads a mutable tag」（把 `deploy.sh '<version>'` 的参数替换成 `latest`，断言检查器报出 `mutable tag`）
- `docker-compose.prod.yml`：`web-blue` 与 `web-green` 都用 `${WEB_IMAGE:?WEB_IMAGE must be set to the registry image, e.g. user/voting-web}`，即镜像名缺失时 compose 直接拒绝展开，而不是退回一个默认值
- 实测（计划 §14.11）：生产叠加 `docker-compose.prod.yml` 后 `docker compose -f … -f … config --quiet` 退出码 **0**；服务清单为 `mysql, migrate, web-blue, web-green, nginx, indexer`
- 边界：`release.yml` 与 `rollback.yml` **从未真正跑过**（没有 GitHub 仓库，`gh workflow view` 无从执行）；`actionlint` 本机不可用

## Context

部署流水线的每一步都可以是对的，而制品指认错一次就全部作废。`latest` 的问题不在于它旧，而在于它**会移动**：

1. 「测过的镜像」与「部署的镜像」不再是同一个对象。CI 扫描过、SBOM 记录过、构建证明签过的那个 digest，与部署时 `latest` 解析到的 digest 可以不同——中间只要有一次新的推送。整条供应链叙事（知道镜像里有什么、由谁构建、有没有已知漏洞）就挂在这一条上。
2. 「回滚到 `latest`」不是回滚到任何一个特定版本。它甚至可能把系统带回比当前**更新**的版本，而执行回滚的人以为自己回到了过去。

本项目的双槽设计把回滚做成一次配置切换（见 ADR-0051 与 ADR-0049），而那次切换之所以有意义，前提是每一槽上跑的镜像有一个确定的、不随时间改变的名字。

## Decision

**一、部署输入永远是 `sha-<12hex>`，由构建阶段从 `git rev-parse --short=12 HEAD` 产出。**

它是提交的函数，因此同一个名字永远指向同一份源码；而镜像 digest 与它的对应关系由构建阶段一次性确定。部署步骤显式传 `WEB_IMAGE_TAG='${{ needs.build.outputs.version }}'` 并把它作为 `deploy.sh` 的参数；失败后的自动回滚不带参数，因此回到 `state/previous-tag`，那也是 sha。

**二、`latest` 可以被人为发布，但部署路径只接受不可变 tag，绝不部署 `latest`。**

这一条要说准确：`release.yml` 第 78 行**确实会发布 `latest`**（`type=raw,value=latest,enable={{is_default_branch}}`），这是给人与工具一个「当前版本」的便利指针，本 ADR 不禁止它。被禁止的是**部署读它**。因此这条决策的正确表述是「部署路径只接受不可变 tag」，而**不是**「仓库里从不出现 `latest`」——后者是错的，也不是本设计想要的。

给人用的便利标签与给机器用的制品指认是两个不同的用途，合并它们才会产生问题。检查器因此只扫描部署步骤：`check_no_mutable_deploy()` 只对同时含 `deploy.sh` 与 `latest` 的行报错，发布 `latest` 的那一行不受影响。

**三、这条规则由机械检查强制，不靠记忆。**

`ops/ci/check-workflows.py` 在 CI 里跑，违反即失败。理由与 `ssh-keyscan`、`pull_request_target` 相同：这三类错误的共同点是「合法 YAML、合法 workflow，但在这里是错的」，而 `actionlint` 不可能知道这个仓库的规则。

**四、检查器本身必须有负向对照。**

`ops/ci/selftest.py` 故意把部署命令改成读 `latest`，并断言检查器**会**报错。一个不能失败的检查不是证据，它只是看起来像覆盖。

**五、生产 compose 强制显式指定镜像。**

`${WEB_IMAGE:?...}` 的 `:?` 让变量缺失时展开失败。这防的是「忘记设变量，于是跑了一个默认镜像」——那种情况在日志里看起来完全正常。

## Alternatives Considered

- **部署 `latest`**（规格 §12 登记的被否方案）。会让「测过的镜像」与「部署的镜像」不是同一个对象——CI 扫描过、SBOM 记录过、构建证明签过的那个 digest，与部署时 `latest` 解析到的 digest 可以不同；并且让回滚无法指认一个确定的制品：「回滚到 `latest`」甚至可能把系统带回比当前**更新**的版本。sha 没有这两个问题，因为它是提交的函数。
- **连 `latest` 也不发布，仓库里根本不出现它**。会失去一个有用的便利指针，而它并不是问题所在——问题在部署读它。把「不发布」当成实现「不部署」的手段，会让检查器退化成一条字符串禁令，从而无法区分「发布」与「部署」这两种用途。
- **用分支名（`main`）做 tag**。分支名会移动，与 `latest` 是同一类问题；而且它移动的时机不由发布流程决定，因此比 `latest` 更难预测。
- **用语义化版本号做 tag**（`v1.2.3`）。语义化版本本身是好的，但它可以被打两次（重推同一个 tag），因此「这个名字永远指向同一份字节」需要额外纪律来保证。git sha 不需要——它由内容决定。
- **只用镜像 digest 做部署输入**。digest 是最强的制品指认，但它不可读：运维手册里「回滚到上一个版本」需要人能说出一个名字（见 `ops/runbook/deploy.md`）。本阶段的折中是：部署命令读 sha，而 `release.yml` 同时用 digest 做 attestation 与扫描的引用，两者都指向同一次构建。
- **靠代码评审保证不写 `latest`**。这四条规则（不得 `ssh-keyscan`、不得 `pull_request_target`、部署输入不得是可变 tag、发布与回滚必须共用锁）每一条都是合法的 YAML，评审时看不出错，而机械检查看得出。计划 §14.10 记录了这个判断的实际回报：一个并发缺口就是被检查器报出来的。

## Consequences

- 正面：「测过的就是部署的」这句话有了唯一支撑——部署读的 tag 是构建产出的版本输出，而扫描与证明引用的是同一次构建。
- 正面：回滚指向一个确定的制品。`rollback.sh` 读 `previous-tag` 并把那一槽切回来，那个 tag 不随时间改变。
- 正面：检查器证明了它**会**失败。`ops/ci/selftest.py` 的 8 个破坏用例里，第一个就是部署读可变 tag。
- 代价：每次发布都会在镜像仓库里留下一个新 tag，仓库需要保留策略（本阶段未定义清理策略）。
- 代价：`sha-<12hex>` 不可读，运维需要额外的映射（`ops/deploy/publish-version.sh` 写出的 textfile 指标与 `state/active-tag`）才能回答「现在跑的是哪个提交」。这个映射本身是一处可能漂移的面，由 `DeployVersionDrift` 规则盯着。
- **未实测**：`release.yml` 与 `rollback.yml` **从未真正执行过**（没有 GitHub 仓库，`gh workflow view` 无从执行）；`actionlint` 本机不可用，因此 workflow 的完整 schema 与表达式上下文**未校验**——自写检查器只覆盖仓库自己定的四条不变量，不覆盖 schema。`sha-<12hex>` 作为部署输入的实际可用性因此只有配置层面的证据。

## Compatibility Boundary

不改变任何运行时契约：镜像内容、`/api/*`、schema 与页面行为都不受影响。对既有本地用法是加法：`docker-compose.yml` 仍用 `${WEB_IMAGE:-voting-web}:${WEB_IMAGE_TAG:-dev}`，不设变量时解析为 `voting-web:dev`，与既有 `docker build -t voting-web:dev .` 一致。唯一的行为变化在流水线侧：部署命令里出现 `latest` 会让 CI 的 workflow-invariants job 失败。

## Retirement Impact

若将来改用支持内容寻址部署的平台（例如按 digest 部署的编排系统），第一条可以升级为「部署输入是 digest」，但**必须同时**保留一个人可读的映射，否则 `ops/runbook/deploy.md` 里「回滚到上一个版本」这类操作会失去可执行性。若引入多环境，`sha-<12hex>` 需要与环境标签组合才能唯一指认一次部署，届时 `check_no_mutable_deploy` 的规则应扩展为「部署输入必须是 sha 与环境标签的组合」，而不是放宽为「只要不是 latest」。第三条（机械检查）在任何方案下都应保留：它约束的是「不许把移动的东西当制品」，与用什么名字无关。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-22-containerization-and-delivery.md
- Action: create snapshot
- Reason: 发布与分发策略属于基线必须登记的面（否则未来的贡献者会误读），而既有基线里没有任何条目描述发布制品如何被指认。本轮新增的是「部署输入不可变」这条硬约束与强制它的机械检查，新基线快照应同时登记这两者，并登记「workflow 从未执行过」这一未验证边界。

## Evidence References

- .github/workflows/release.yml
- .github/workflows/rollback.yml
- ops/ci/check-workflows.py
- ops/ci/selftest.py
- docker-compose.prod.yml
- ops/deploy/deploy.sh
- ops/deploy/rollback.sh
- docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
