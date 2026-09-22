# 实施计划：投票机制深化与平台能力补齐

> 本计划由 `writing-plans` 产出，落在 `docs/aegis/plans/`。
> 它不是完成授权，也不替代规格与基线；执行中的完成声明仍需证据。
> 前序计划：`2026-09-21-multi-tenant-voting-platform.md`（多租户改造，已完成并实测）。

## Progress

| 批次 | 任务                                        | 状态 | 证据                                                                                   |
| ---- | ------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| 一   | Task 1-2 多选 + 加权                        | 完成 | `PollMultiSelect.t.sol`、`PollMechanisms.t.sol`；commit `02ef5a5`                      |
| 一   | Task 3 委托投票                             | 完成 | `PollDelegation.t.sol`（21 测试）；ADR-0035；commit `367ef19`                          |
| 一   | Task 4 commit-reveal                        | 完成 | `PollCommitReveal.t.sol`；`commit-reveal-drill` 21/21；commit `dcecef5`                |
| 一   | 机制矩阵属性测试                            | 完成 | `PollMechanismMatrix.t.sol`（6 机制 × 200 轮，突变验证）                               |
| 二   | Task 5-7 quorum/timelock/execute + 创建准入 | 完成 | `PollExecutor.t.sol`（43 测试）；ADR-0032/0033；commit `79ed547` + `3767c59`           |
| 三   | Task 8 RPC 多端点容错                       | 完成 | `rpc-endpoints.ts` + `endpoints.ts`（22 测试）；ADR-0036                               |
| 三   | Task 9 分页/搜索/投票率                     | 完成 | `pagination.ts`（50 测试）；`whitelistedCount()`；ADR-0037/0038                        |
| 三   | Task 10 审计视图 + 读缓存                   | 完成 | `/audit` + `/api/audit`；`audit.ts`（20 测试）+ `cache.ts`（9 测试）；ADR-0039         |
| 四   | Task 11 结果图表                            | 完成 | `ResultChart.tsx`（服务端 SVG，无图表库）；`result-chart.test.ts`；ADR-0042            |
| 四   | Task 12 i18n + 移动端连接                   | 完成 | `lib/i18n/*`（8 个 describe）；`wallet-connectors.ts`；ADR-0040/0043                   |
| 四   | Task 13 模板/草稿 + 通知订阅                | 完成 | `templates.ts`（26）+ `draft.ts`（25）`notify`（28）+ `event-branches`（21）；ADR-0041 |

**批一验收结果**（2026-09-22）：

- `pnpm test`：272 合约 + 371 web，全通过；`pnpm typecheck`、`pnpm format:check`、`pnpm build:web` 均干净。
- 证伪点 `pnpm indexer:check-consistency` 在重建索引后为 `consistent`（`divergentPolls: 0`）。
- 负向对照（全部实测失败后已回滚）：`tamper-drill` → `divergent`；commit-reveal 两处突变各失败对应用例；机制矩阵突变 → `commit-reveal: balance != totalStaked`；`sync.ts` 允许列表改回旧写法 → 回归测试失败。

**批一暴露的三次「同一条规则写在两个地方」**（详见 ADR-0031「Implementation Record」）：

1. `uk_votes_log` 唯一键漏掉 `option_id`，多选事件的第二行被 `INSERT IGNORE` 静默丢弃；
2. `PollPhase` 在 `export-abi.ts` 里是手写字符串，插入 `Reveal` 后 `Ended` 错位（`trust.ts` 里还有第二份）；
3. `sync.ts` 的「是否已投过票」规则与测试 FakePool 各写一份，导致真代码错误时测试仍全绿。

因此批二起的默认做法是：**派生值一律从单一来源生成，不手写第二份**。

**批三验收结果**（2026-09-22）：

- `pnpm test`：350 合约（287 solidity + 63 nodejs）+ 499 web，全通过；`pnpm typecheck`、`pnpm format:check`、`pnpm build:web` 均干净。
- `pnpm build:web` 输出确认 `/audit` 与 `/api/audit` 已注册为动态路由。
- 批三新增测试 89 个：`pagination.test.ts` 50、`audit.test.ts` 20、`cache.test.ts` 9、`endpoints.test.ts` 12、`rpc-endpoints.test.ts` 10（后两者为 Task 8 期间新增）。

**批三纠正的两处计划偏离**：

1. **Task 9 原文要求用 `whitelistedCount` 替换硬编码 `eligible = null`**。这在加权投票下会让投票率超过 100%：该函数数的是**地址**，而分子 `totalVotes` 累加的是**票权**。批二已引入的 `frozenEligiblePower`（创建时冻结的票权总和）才是正确分母。落地为：`whitelistedCount()` 作为**活地址数**新增（Setup 与审计需要它），投票率/quorum/导出用 `frozenEligiblePower`。详见 ADR-0037。
2. **Task 10 的"缓存"原表述为调整页面级 `revalidate`**。Next.js 的 `revalidate` 在构建期求值、无法读运行期环境变量，且缓存整个页面渲染结果会把一致性标记一起冻住——而一致性检查必须比较同一瞬间（ADR-0017）。改为在 `getPolls()` 上做读穿缓存，一致性检查与健康检查**不经过**它。详见 ADR-0039。

**批三期间的一次真实返工**：`web/test/pagination.test.ts` 曾用 PowerShell 的 `Set-Content` 重写，被按 GBK 重新编码后成为非法 UTF-8（`read` 工具拒绝读取，字节 8789 处出现截断的 `E2 80` 序列）。改用文件写入工具整体重写。教训：源码文件一律走文件工具，不用 shell 重定向。

**批四验收结果**（2026-09-22）：

- `pnpm test`：350 合约（287 solidity + 63 nodejs）+ 659 web，全通过；`pnpm typecheck`、`pnpm format`、`pnpm build:web` 均干净。
- `pnpm build:web` 输出确认 `/notifications`、`/api/notifications`、`/api/subscriptions` 已注册为动态路由。
- 新增 ADR-0040（语言由读者选择、合约名不翻译）、ADR-0041（通知是推导的、订阅不是授权）、ADR-0042（服务端 SVG 图表）、ADR-0043（移动端连接的依赖树代价）。
- `ui-drill` 补跑：只读、`--vote`、`--change` 三条**全部 all checks passed**；`check-consistency` 为 `consistent`。这一轮抓到两个真实缺陷（`seed:local` 自批二起损坏、批四的 `console.warn` 触发断言），详见下方"补做"一节。

**批四新增测试 111 个**：`result-chart.test.ts`、`i18n.test.ts`（8 个 describe）、`wallet-connectors.test.ts`、`templates.test.ts` 26、`draft.test.ts` 25、`notify.test.ts` 28、`event-branches.test.ts` 21，以及 `ballot-reasons.test.ts` 追加的 6 条**语言覆盖**用例。

**批四中途的一次派生值合并**：`getAuditActivity` 与 `listNotifications` 都要读"跨投票的事件流"。第一版各写了六分支 `UNION ALL`，随后抽出 `web/src/lib/indexer/event-branches.ts` 作为唯一所有者。`UNION ALL` 按**位置**匹配，所以六支的列顺序必须一致——`branchSql()` 用同一模板生成每一支使位置差异无法表达，`event-branches.test.ts` 逐支比对别名位置。这是批一那条教训（派生值不手写第二份）在批四的第二次应用。

**批四的两处未完成，如实记录**：

1. **i18n 只做了一部分**。`ballot-reasons.ts`、塔标元数据、语言切换器、结果来源标签已参数化；`ballot-labels.ts` 的阶段/状态句与其余组件的文案仍是内联中文。英文界面目前是中英混杂，不是完整英文。详见 ADR-0040 的 Consequences。
2. **两条浏览器路径仍然没有端到端覆盖**：`ui-drill` 未覆盖英文语言切换，也未覆盖订阅按钮与草稿恢复（该 drill 从不访问创建页，因此没有加草稿断言——加了也是没有消费者的死代码）。图表断言**已加入并实测通过**（`bars=3 options=3`）。这三条路径目前分别只有 `i18n.test.ts`、`notify.test.ts`、`draft.test.ts` 的纯函数覆盖。

**批四随后的收口提交** `dace051`：发现 `validateConfig` 的文档写着"Solidity 侧使用相同的顺序"，而它**没有**实现 `validateGovernance` 的两条规则（`quorumBps > 10000`、`quorumBps != 0 && openToAll`）。缺失本身是有意的、且已在 `templates.ts` 写明（没有调用方能设置 quorumBps，所以两条规则**不可达**而非"未检查"，为不可达分支写文案是死代码），但 `mechanisms.ts` 那侧没说，于是"声称自己是镜像、实际只镜像一部分"成了一个等人踩的坑。改动只做两件事：把注释改成实话并点名未镜像的规则与它当前安全的条件；在 `templates.test.ts` 加一条断言"表单能构造出的每种配置 `quorumBps` 都是 0"，作为那个条件的可执行形式。已做突变验证（把 `DEFAULT_CONFIG.quorumBps` 改成 100 → 精确失败 1 条，报 `produced a quorum`）。

**同一次收口里重复踩到的坑**：突变验证时用 PowerShell `Set-Content` 改写 `mechanisms.ts`，文件被按 GBK 重新编码成非法 UTF-8（`read` 工具直接拒绝读取）。恢复方式为 `git checkout HEAD --` 取回已提交版本后用文件工具重做改动（已 diff 确认只剩预期的两处）。这与批三损坏 `pagination.test.ts` 是**同一个原因**。因此把批三那条教训升级为硬规则：**任何源码文件都不得经由 shell 重定向或 `Set-Content` 写入，包括临时性的突变验证**——要验证一条断言会响，也应改常量后立刻用文件工具改回，而不是让 shell 碰文件。

**批四提交里混入的一次无关改动，如实记录**：`pnpm format` 被 prettier 用来格式化全仓库，包括 markdown，因此它把**另一个计划**的两份文档（`docs/aegis/plans/2026-09-22-containerization-cicd-and-observability.md` 与对应的 spec，由 `2dd10bd` 引入）的表格分隔行补齐了宽度。随后 `git add -A` 把这些改动一并扫进了批四提交 `8485d6b`。已核实：改动**只有表格分隔行的空格填充**（`| --- |` → `| ------ |`），没有语义变化；用 `--ignore-all-space` 查看后剩下的"实质"差异全部是这一类。它不会破坏任何东西，但把 337 行属于另一个计划的改动记在了一个标题为"前端体验"的提交上，会让人在那份计划的历史里看到一次无法解释的变动。此处选择不回改历史（为此重排 `8485d6b`/`dace051` 的代价大于表格填充本身），改为记录在案。教训：**`git add -A` 之前先看 `git status`**，格式化工具的作用范围是整仓库，不是本次改动。

### 基线 §5.2 五条不变量：批四结束时的实测登记

`Baseline Sync Signals` 要求"第 1/2/3/5 条不得破坏，需在每批结束时逐条登记实测结论"。**这一登记此前四批都没有做过**，属于本次才补上的遗漏——补记于此，并注明每条的**证据来源**，而不是只写"未破坏"。批四本身**没有改动任何合约代码与 ABI**（`git show --name-only` 确认两处提交均未触及 `contracts/`），所以下面是复核而非新风险。

| #   | 不变量                                            | 批四结论 | 证据                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 链上是唯一事实源；MySQL 可 DROP 后从事件完整重建  | 未破坏   | 本批新增的 `subscriptions` 表**只存水位线**，通知完全由事件推导（ADR-0041），因此删库重建后订阅数据是唯一需要重设的用户状态，且它不参与任何票数计算                                                                                        |
| 2   | 后端永不持有任何私钥                              | 未破坏   | 实测 `web/src/**` 下无任何文件引用 `privateKey`/`PRIVATE_KEY`（grep 结果为空）；唯一引用处是 `web/scripts/preflight.ts`，那是部署 CLI，不是应用后端                                                                                        |
| 3   | 事件消费幂等                                      | 未破坏   | 本批未新增事件表；既有的 `UNIQUE(tx_hash, log_index)` 未被触碰（`schema.ts` 里的 `uk_*` 键），`INSERT IGNORE` 语义不变                                                                                                                     |
| 4   | 每个合格主体的票权至多被计入一次（ADR-0034 重述） | 未破坏   | `contracts/contracts/PollPowerConservation.t.sol` 九条属性测试通过，含 `test_Conservation_HoldsUnderRandomisedSequences`、`test_Conservation_TurnoutNeverExceedsOneHundredPercent`、`test_Conservation_FrozenDenominatorEqualsThePowerSum` |
| 5   | 事件插入与游标推进同一事务提交                    | 未破坏   | 实测 `web/src/lib/indexer/sync.ts`：`beginTransaction()`（L219）→ 事件插入（L334）→ 游标推进（L338）→ `commit()`（L344），异常走 `rollback()`（L348）。四步同处一个连接与事务                                                              |

**批四实际测得的数字**：350 合约（287 solidity + 63 nodejs）+ 659 web，全通过；`typecheck`、`format:check`、`build:web` 干净。

**最初记为"未执行"的 `ui:drill`，后来补跑并抓到两个真实缺陷。**

上面的判断（"需要运行中的 Next 服务、Playwright 浏览器与本地 Hardhat 部署，四条都没执行"）在当时是准确的，但**环境其实具备条件**：Chrome 已安装、8545 上有活链、3306 有 MySQL、`.env` 完整——缺的只是一个 `next start`。补跑之后抓到两个**与界面无关**的真实缺陷：

**缺陷一：`pnpm seed:local` 自批二起就是坏的，没有任何测试能发现。** 首轮 drill 的 CSV 导出返回 503，根因链是：

1. 本地部署早于批三，部署出的 `Poll` 实现**没有** `whitelistedCount()`（批三 `635c502` 才加入），而导出路由调用它 → `function selector was not recognized and there's no fallback function`。
2. 重新部署后再跑 seed，立刻失败：`ABI encoding params/values length mismatch. Expected length (params): 5, Given length (values): 4`。
3. `createPoll` 在**批二**增加了第 5 个参数 `address[] executionTargets`。`CreatePollForm.tsx` 同步更新了（并注释说明为何传空数组），**`seed-local.ts` 没有**。
4. 修掉 arity 后立刻露出第二个：`TypeError: Cannot convert undefined to a BigInt` —— `PollConfig` 在批二还多了 `quorumBps` 与 `timelockSeconds`，而 seed 的 `DEFAULT_CONFIG()` 只给了 7 个字段，缺这两个。

**为什么批二和批四都没发现**：`seed:local` 是开发便利脚本，**在 `pnpm test` 之外**。合约改签名时全部测试保持绿色，只有这个脚本静静地烂掉。这是批一那条教训（"派生值一律从单一来源生成，不手写第二份"）的又一个实例——只不过这次的"第二份"是**调用签名**。

**缺陷二：批四自己引入的 `console.warn` 让 drill 的一条断言失败。** 为缺失的 WalletConnect project id 加的 `console.warn` 触发了 `ui-drill` 的"页面不得记录 info 以上任何东西"断言。那条断言的用途是抓 **hydration mismatch** 这类 DOM 看不出来的缺陷——React 会在客户端重渲染，页面看起来完全正常，上面每一条 DOM 断言都会通过。

一个**故意的配置提示**不是缺陷。若为此放宽断言，下一个人就会把这类消息当作噪音，而这条断言恰恰是唯一能抓 hydration mismatch 的东西。改法是**降级为 `console.info`**：该提示在每个读者的每次页面加载时都会打印，而它报告的是"少了一个可选连接器"，不是"有东西坏了"——桌面端有注入钱包的读者毫无损失。提示与断言都保住了。

**实跑结果（全部通过）：**

| 命令                                   | 结果                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm ui-drill`（只读）                | **all checks passed**，含新增断言 `the result chart drew one bar per option — bars=3 options=3` |
| `pnpm ui-drill --vote`（针对开放投票） | **all checks passed**，`the transaction reached a confirmed receipt`                            |
| `pnpm ui-drill --change`               | **all checks passed**，`the change reached a confirmed receipt`，页面把新选项标为"我的"         |
| `pnpm ui-drill --refund`（新造状态）   | **all checks passed**，押金从 `1000000000000000` wei 归零，见下                                 |

`ui-drill.ts` 实际支持的四个标志中，`--reject` **本次仍未覆盖**。它要求注入的 provider 在 `eth_sendTransaction` 上返回 EIP-1193 的 `4001`（"用户拒绝"），而该 provider 默认把写请求直接转发给节点；本次没有为它准备拒绝行为，因此这条路径**未被验证**——但这属于"没跑"，不是"跑不了"。

`--vote` 首次运行失败，原因是**测试账户选择**而非缺陷：默认账户不在白名单里，drill 自己给出结论 `--vote requested, but the chain does not allow this account to vote`。改用 `POLL_ADDRESS` 指向那份**开放**投票后通过。

**`--refund` 起初未通过，追下去发现是 `ui-drill.ts` 自己的一个真实缺陷。**

第一次运行失败的原因是**种子状态**：该标志的前置条件是 `phase == Ended` 且 `stake > 0`，而两份种子投票都仍在投票期且押金为 0，drill 的前置自检直接拒绝，打出 `phase=1 (needs 2) stake=0 wei (needs > 0)`。这与 `--vote` 在白名单投票上失败是同一类情况——断言在正确地做事。

于是补造状态：新增 `contracts/scripts/refund-state.ts`，它在一份**已 seed** 的链上追加一份"已结束且有押金"的投票，用 `closeAfterDeadline()` 而非 `endPoll()`（后者是 owner 的强制覆盖，而退款路径应当走普通截止流程），并把投票人固定为 `ui-drill` 默认签名所用的那个 Hardhat 账户。

状态补齐后 drill **仍然失败**，而这一次暴露的是 drill 自身的问题：

```
chain  openToAll=true canVote=true hasVoted=true phase=3 stakeOf=1000000000000000 wei
OK     the ballot rendered a refund button
FAIL   the refund button is enabled exactly when the chain says the stake is refundable
       — chainSaysRefundable=false (phase=3 stake=1000000000000000) enabled=true
FAIL   --refund requested, but the chain does not allow this account to refund
       — phase=3 (needs 2) stake=1000000000000000 wei (needs > 0)
```

链上说可取回、**页面也正确地启用了按钮**，而 drill 自己算出 `chainSaysRefundable=false`。根因是 `web/scripts/ui-drill.ts` 第 611 行写着 `const PHASE_ENDED = 2;`，而批一把 `Reveal` 插入合约枚举后 `Ended` 已从 2 变成**3**。

**这是同一类缺陷在本仓库的第三次出现。** `web/test/ballot-labels.test.ts` 里早就留着一条注释记录这件事（"these assertions used to hard-code 1 and 2, and inserting Reveal into the contract's enum turned 2 into the wrong phase"），测试改用了具名成员 `PollPhase.Voting` / `PollPhase.Ended`，但**脚本被漏掉了**。讽刺的是，我自己写的 `refund-state.ts` 第一版也硬编码了 `2` 并因此失败——同一个陷阱在同一次会话里骗了两个人。

修法是把 `PHASE_ENDED` 改为从生成的枚举派生（`PollPhase.Ended`），使这个错误**无法表达**。修复后：

```
OK  the refund button is enabled exactly when the chain says the stake is refundable
    — chainSaysRefundable=true (phase=3 stake=1000000000000000) enabled=true
OK  the refund reached a confirmed receipt
OK  the chain shows the stake was returned — stakeOf=0 wei (was 1000000000000000)
OK  the refund button disabled itself once the stake was gone
OK  the page now says there is nothing to refund — refundReason="没有可取回的押金。"
UI drill: all checks passed.
```

**教训**：凡是把合约枚举的**序号**写进代码的地方，都是一颗定时炸弹，而它在枚举插值时**不会报错**——只会安静地指向另一个阶段。所以第四个不变量式的规则是：**枚举一律用具名成员，永远不写序号**。这条已经写进 `ui-drill.ts` 的注释里。

**两条计划自身的错误，一并记录：**

1. `Verification` 段把命令写作 `ui:drill`，实际脚本名是 `ui-drill`（连字符，无冒号）。
2. 该段列出的 `--delegate` 与 `--commit` **两个标志在 `ui-drill.ts` 里根本不存在**；实际支持的是 `--vote`、`--change`、`--refund`、`--reject`。这两条命令**不可执行**，而先前"未执行"的记录恰好掩盖了这一点。

**顺带完成一次不变量 1 的实测**：重跑 drill 需要重新部署并重建索引，`DROP DATABASE` 之后 `indexer:drain` 重放 416 条事件（`inserted: 416`、`duplicatesIgnored: 0`），`check-consistency` 报告 `consistent`（200/200 与 5/5；执行写操作后为 6/6），`divergentPolls: 0`。

**一次环境状态教训**：`seed:local` 会**自己部署一份工厂**并覆盖 `deployments/31337.json`，因此正确顺序是 `seed:local` **之后**再 `export-abi`；我按 `deploy:local` → `export-abi` → `seed:local` 的顺序做，导致应用指向的工厂与实际播种的工厂不是同一个，表现为索引重放 0 条事件而链上确有事件。诊断它花了几轮，最终靠**直接解码那条孤零零的日志**定位——它是 `OwnershipTransferred`（`0x8be0079c…`）而不是 `PollCreated`，说明那份工厂上根本没有投票。教训：**"索引重放 0 条"要先怀疑目标地址，不要先怀疑解码器。**

## 0. Aegis Visibility

本计划存在的理由：用户判定「项目在功能上还不够」，并且这不是观感问题而是**语义缺口**。当前的投票模型是"单一问题、一人一票、全程公开、结果不执行"——投票系统之所以成为投票系统的高级语义（多选、加权、委托、隐私、阈值执行）**一个都不存在**。

更关键的是，这四处限制**全部写在合约里且创建即永久**，前端与索引层无法绕过：

| 根因                                       | 位置           | 锁死了什么                      |
| ------------------------------------------ | -------------- | ------------------------------- |
| `votedFor` 是标量 `mapping(addr=>uint256)` | `Poll.sol:254` | 多选、委托、加权                |
| `question` 是单个 `string`                 | `Poll.sol:202` | 多问题问卷                      |
| `STAKE` 是常量且不参与计票                 | `Poll.sol:56`  | 加权投票                        |
| 无 threshold / timelock / execute          | `Poll.sol:461` | 治理闭环（"投票通过→自动执行"） |

因此本计划的改造**必须落在合约层**，前端与索引跟随。这正是规划（而非直接写代码）有价值的压力点：`docs/aegis/BASELINE-GOVERNANCE.md` §3 要求"不得让实现静默偏离已确认基线"，而本计划同时触及两条已接受 ADR 与一条规格非目标。

## 1. Goal

在**保留并向上扩展** `Poll` / `VotingFactory` 架构（不做推倒重来）的前提下，按四批补齐功能缺口，每批以可复现证据收尾：

| 批次 | 主题         | 交付的核心能力                                                             |
| ---- | ------------ | -------------------------------------------------------------------------- |
| 批一 | 投票机制     | 多选、加权投票、委托投票、commit-reveal 两阶段隐私投票（创建时可选）       |
| 批二 | 治理与权限   | quorum 阈值、时间锁、结果上链执行、工厂创建准入                            |
| 批三 | 数据与接口层 | RPC 多端点容错、列表分页与搜索、投票率（合格选民数）、全局审计视图、读缓存 |
| 批四 | 前端体验     | 结果图表、移动端钱包（WalletConnect）、i18n、投票模板与草稿、通知订阅      |

**用户在本会话确认的三项决策：**

| 决策     | 结论                                                     |
| -------- | -------------------------------------------------------- |
| 改造尺度 | **渐进式**：保留 `Poll` 合约向上扩展，不做 Governor 重写 |
| 隐私取舍 | **做 commit-reveal 两阶段**，做成创建时可选项            |
| 交付范围 | **四个方向全做，分批交付**                               |

## 2. Scope Check：事实 / 假设 / 未知

```text
Scope Check:
- 事实（已读源码确认）:
  - Poll.sol 682 行，Phase 三态，STAKE 为 constant，votedFor 为 scalar mapping
  - VotingFactory.sol 137 行，createPoll 4 参数，无权限限制
  - schema.ts 260 行，6 表 3 视图，votes 为 append-only 事件流，current_votes 为派生视图
  - decode.ts 313 行，已支持 PollCreated / 7 种 Poll 事件
  - 8 个 GET 路由 + 1 个 POST（index/sync）；前端 18 个组件
  - 基线测试：合约 177 + web 327 = 504，全绿（本会话已实测）
- 假设（需在批一 Task 1 中以负向对照验证）:
  - commit-reveal 与"一人一票"可共存：commit 阶段占位，reveal 阶段计数
  - 多选可通过把 votedFor 改为映射到位图/计数实现，且索引视图仍可派生
  - 委托可在不改工厂的前提下加在 Poll 层
- 未知（需在批一前段消除）:
  - 委托链（A→B→C）是否允许、循环委托如何拒绝
  - 未揭示的票在结果中如何处理（视为弃权，还是让 poll 无法结束）
  - 加权投票的权重来源（快照区块 / 现价 / 固定值）
```

**这三条未知必须先决策，否则批一无法开工**。本计划在 §7「Open Questions」给出推荐值，执行时若用户未另行指示则按推荐实施，并在 ADR 中记录为已决。

## 3. Baseline / Authority Refs

```text
BaselineUsageDraft:
- Required baseline refs:
  - docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md §5（合约）、§6（索引器）、§11（非目标）、§12（ADR 信号）
  - docs/aegis/baseline/2026-09-20-initial-baseline.md §5.2（五条不变量）
  - docs/aegis/baseline/2026-09-21-optimization-pass.md §9（后续比对建议）
  - CONTRIBUTING.md「先读这一节」五条硬约束
  - docs/aegis/BASELINE-GOVERNANCE.md §3、§6
- Delivered context refs:
  - 本会话已读：Poll.sol、VotingFactory.sol、schema.ts、decode.ts、package.json、README.md（全）、
    CONTRIBUTING.md、BASELINE-GOVERNANCE.md、ADR-0003、plans/2026-09-21-multi-tenant-voting-platform.md、
    baseline/2026-09-21-optimization-pass.md、规格 §0-§2 与章节大纲
  - 本会话已实测：pnpm test:indexer（327 通过）、pnpm test:contracts（177 通过）
- Acknowledged before plan refs:
  - ADR-0001（链上唯一事实源）、ADR-0003（明票无隐私，**本计划将取代**）、
    ADR-0004（IPFS 只承载元数据）、ADR-0005（押金构造重入面）、
    ADR-0023（工厂 + 每投票一合约）、ADR-0024（改投撤票各自成事件）、
    ADR-0025（准入方式创建时固定）、ADR-0026（导出即需有调用点）、ADR-0027（规则住纯函数）
- Cited in plan refs: 上述全部；特别 §5.2 五条不变量逐条在 §8「Baseline Sync Signals」登记
- Missing refs: 无
- Decision: continue
```

## 4. Requirement Ready Check

```text
Requirement Ready Check:
- Requirement source refs: 用户本会话三项选择（渐进式 / commit-reveal / 全做分批）+「功能上还不够」的判定
- Goals and scope refs: 本计划 Goal 表；规格 §1 与 §11 需同步修订
- User / scenario refs:
  - 投票人：多选、加权、委托他人、隐私投票
  - 发起人：选投票机制、设阈值与时间锁
  - 参与者：看图表、用手机投、换语言、收通知
  - 第三方审计者：核对结果、查全局审计日志（既有能力不退化）
- Requirement item refs: Tasks 1-4（批一）、5-7（批二）、8-10（批三）、11-13（批四）
- Acceptance / verification criteria refs: 每个 Task 的 Verification 段；批次级验收见 §9
- Open blocker questions: 三条未知已列于 §2，推荐值见 §7，按推荐实施
- Decision: ready
```

## 5. Change Necessity

```text
Change Necessity:
- User-visible need: 用户要能发起多选/加权/委托/隐私投票、要治理闭环、要在手机与非中文环境下使用、要有图表与通知
- No-change / non-code option: 不可行。四处"创建即永久"的限制都在合约里：
    votedFor 是 scalar（Poll.sol:254）、question 是单个 string（Poll.sol:202）、
    STAKE 是 constant（Poll.sol:56）、无 threshold/timelock/execute（Poll.sol:461）
  前端无法绕过已上链的状态结构；索引视图也无法凭空派生不存在的事件
- Why code change is necessary: 投票规则本身在变（谁有票、一票值多少、票是否公开、结果是否执行），
  这属于语义重设计而不是展示层扩展
- Minimum change boundary:
    contracts/contracts/Poll.sol（核心）
    contracts/contracts/VotingFactory.sol（创建参数透传）
    web/src/lib/indexer/{decode,sync}.ts + db/schema.ts（新事件入投影）
    web/src/lib/{data,types,contracts}（读模型与 ABI）
    web/src/components/{CreatePollForm,PollBallot,PollAdmin} + 新增展示组件
    web/src/app/api/**（分页、搜索、审计、通知）
    docs/（新 ADR、规格修订、基线漂移）
- Decision: code-change
```

## 6. Files

**批一（投票机制）**

| 动作 | 文件                                                                            |
| ---- | ------------------------------------------------------------------------------- |
| 新建 | `contracts/contracts/PollMechanisms.sol`（机制枚举 + 纯函数校验，独立的 owner） |
| 新建 | `contracts/contracts/PollMechanisms.t.sol`                                      |
| 修改 | `contracts/contracts/Poll.sol`（多选/加权/委托/commit-reveal）                  |
| 修改 | `contracts/contracts/VotingFactory.sol`（`PollConfig` 结构体参数）              |
| 修改 | `contracts/contracts/Poll.t.sol`、`PollProperties.t.sol`、`VotingFactory.t.sol` |
| 修改 | `web/src/lib/indexer/decode.ts`（新事件解码）                                   |
| 修改 | `web/src/lib/db/schema.ts`（新表 + 视图改写）                                   |
| 新建 | `web/src/lib/mechanisms.ts`（与合约同构的纯函数，供 UI 判定）                   |
| 修改 | `web/test/decode.test.ts`、`sync.test.ts`、新增 `mechanisms.test.ts`            |
| 修改 | `web/src/components/CreatePollForm.tsx`、`PollBallot.tsx`、`OptionRow.tsx`      |
| 新建 | `web/src/components/DelegationPanel.tsx`、`CommitRevealPanel.tsx`               |
| 修改 | `web/src/lib/{data,types}.ts`、`pnpm export-abi` 重新生成 `contracts/`          |

**批二（治理与权限）**

| 动作 | 文件                                                                                       |
| ---- | ------------------------------------------------------------------------------------------ |
| 修改 | `contracts/contracts/Poll.sol`（quorum / timelock / execute / 执行负载）                   |
| 新建 | `contracts/contracts/PollExecutor.t.sol`（执行与时间锁测试）                               |
| 修改 | `contracts/contracts/VotingFactory.sol`（`createPoll` 准入：`creatorAllowlist`）           |
| 修改 | `web/src/components/PollAdmin.tsx`、新增执行按钮与阈值展示                                 |
| 新建 | `web/src/components/ExecutionPanel.tsx`                                                    |
| 修改 | `web/src/lib/indexer/decode.ts` + `db/schema.ts`（ExecutionQueued / Executed / Cancelled） |

**批三（数据与接口层）**

| 动作 | 文件                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------- |
| 修改 | `web/src/lib/config.ts`（`RPC_URLS` 多值）、`chain.ts`、`wagmi.ts`（fallback transport）       |
| 修改 | `web/src/lib/indexer/sync.ts`（端点轮换）                                                      |
| 修改 | `web/src/app/api/polls/route.ts`（`?page=&q=&sort=`）、`web/src/lib/data.ts`（`getPollsPage`） |
| 新建 | `web/src/lib/pagination.ts`（纯函数分页/搜索，可单测）                                         |
| 修改 | `web/src/app/api/polls/[address]/export/route.ts`（合格选民数替代硬编码 null）                 |
| 修改 | `contracts/contracts/Poll.sol`（`whitelistedCount` 计数）                                      |
| 新建 | `web/src/app/audit/page.tsx` + `web/src/app/api/audit/route.ts`                                |
| 新建 | `web/src/components/SearchBar.tsx`、`Pagination.tsx`、`ResultChart.tsx`                        |
| 修改 | 页面缓存策略（改 `force-dynamic` 为 revalidate 或加读缓存层）                                  |

**批四（前端体验）**

| 动作 | 文件                                                                                   |
| ---- | -------------------------------------------------------------------------------------- |
| 新建 | `web/src/lib/i18n/{index.ts,zh.ts,en.ts}`、`web/messages/`                             |
| 修改 | 全部 `components/*.tsx` 与 `app/*/page.tsx`（文案抽取）                                |
| 修改 | `web/src/lib/wagmi.ts`（WalletConnect / Coinbase 连接器）                              |
| 新建 | `web/src/lib/templates.ts`、`web/src/components/TemplatePicker.tsx`                    |
| 修改 | `web/src/components/CreatePollForm.tsx`（草稿 localStorage）                           |
| 新建 | `web/src/lib/notify/`、`web/src/app/api/subscriptions/route.ts`、`db/schema.ts` 订阅表 |
| 新建 | `web/public/manifest.json`（PWA）                                                      |

**文档（每批随做随改）**

- `docs/aegis/adr/`：新增 ADR-0030（投票机制可配置）、ADR-0031（commit-reveal 取代 ADR-0003）、ADR-0032（治理执行与时间锁）、ADR-0033（工厂创建准入）、ADR-0034（加权与委托下的"一人一票"重定义）
- `docs/aegis/specs/2026-09-20-…-design.md`：§5、§6、§11（非目标修订）、§12、§14（新校正）
- `docs/aegis/baseline/`：每批一份漂移记录
- `docs/aegis/INDEX.md`：追加条目
- `README.md`：能力表、实测指标、已知局限
- `CONTRIBUTING.md`：五条不变量的第 4 条需重述（见 ADR-0034）

## 7. TDD Route

```text
TDD Route:
- Mode: off
- Decision: skipped
- Strict authority: not applicable（用户未要求严格 TDD，项目亦未声明）
- Strict signals: 触及合约、持久化、权限——在 auto 下会要求 strict，但本会话 mode 为 off
- Light eligibility: 不适用（改动大）
- TDD-fit exception: 不适用
- Test posture: post-change regression（沿用本仓库既有做法）
- Reason: 仓库既有风格是先实现再补针对性回归与负向对照，且负向对照是其证据纪律的核心
          （见 baseline/2026-09-21-optimization-pass.md §7、规格 §14 校正 7）。
          本计划保留该纪律：每个合约 Task 必须给出"注入已知缺陷后测试确实失败"的负向对照。
- Verification: 每个 Task 的 Verification 段给出确切命令与预期
```

> **本计划不做 RED-GREEN 循环**，但**强制负向对照**。这是本仓库最重要的证据纪律：`baseline §7` 记录的四条真实缺陷全部由测试当场发现，而"测试通过"在本项目的含义是**先证明测试能失败**。批一尤其必须遵守——它要改的是"一人一票"这个被 1000 轮属性测试守护的不变量。

## 8. Existence Check

```text
Existence Check:
- Proposed new surface:
  - PollMechanisms.sol（机制校验纯函数，独立于 Poll）
  - web/src/lib/mechanisms.ts（与合约同构的 UI 侧判定）
  - Debate: 是否需要 DelegationPanel / CommitRevealPanel / ExecutionPanel 三个新组件
- Existing owner / reuse candidate:
  - Poll.sol 已拥有投票状态与计数（batching 机制应加在它内部，而非新合约）
  - ballot-reasons.ts 已是"能不能点"的纯函数 owner（ADR-0027），新机制的禁用理由应扩展它
  - PollAdmin.tsx 已是发起人操作 owner
- Why existing surface is insufficient:
  - 四种机制的组合校验（多选×加权×委托×隐私）会产生 16 种组合，把它们塞进 Poll.sol 会让
    合约同时承担"存储投票"与"校验机制组合"两件事；且每加一种机制都要改投票主路径。
    独立成纯函数 owner 后，Poll 只调用 `PollMechanisms.validate(config)`。
  - 前端同理：mechanisms.ts 让 UI 判定可单测，避免重蹈 ADR-0027 之前的覆辙（规则塞回组件）
- Creation proof:
  - PollMechanisms 是纯函数、无状态、无权限，可被 Solidity 测试直接覆盖
  - mechanisms.ts 与合约保持同构，并有测试断言二者对同一 config 给出一致判定
    （这是必要的一致性护栏：两侧规则不一致会让 UI 亮着按钮而链上 revert）
- Entropy / retirement impact:
  - 新增一个 owner（机制校验），但消除了"每加机制就改投票主路径"的级联
  - 不新增兼容层：旧 Poll 部署作废，ABI 不兼容，与 ADR-0023 那一轮的处理一致
- Decision: add-with-proof
```

## 9. Architecture Integrity Lens

```text
Architecture Integrity Lens:
- Invariant（基线 §5.2 五条，逐条检查本计划影响）:
  1. 链上唯一事实源 —— 不受影响：新机制全部是链上状态，索引仍只做投影
  2. 后端不持私钥 —— 不受影响：所有新写入仍由钱包签名
  3. 事件消费幂等 —— 受触及：新增事件必须继续带 UNIQUE(tx_hash, log_index)
  4. 一人一票 —— **语义被扩展**：多选/加权/委托下"一票"不再等于"一个地址一个选项"。
     这是本计划最大的基线压力点，必须由 ADR-0034 显式重定义，不得静默放宽
  5. 事件与游标同事务 —— 不受影响：沿用 persistBatch
- Canonical owner / contract:
  - Poll 合约仍是"这个投票的票数"的唯一 owner；Factory 仍只创建与登记、不记账
  - 机制校验归 PollMechanisms；禁用理由归 ballot-reasons.ts；观感映射归 presentation
  - 索引的 current_votes 视图仍是派生，绝不引入可变计数器
- Responsibility overlap:
  - 风险：commit-reveal 会引入"已 commit 未 reveal"的中间态。若不建模，索引会把它当成
    "没投票"而链上可能另有裁决 —— 这正是 ADR-0011/0014 禁止的"用默认值代替未知"。
    处置：新增显式状态 `committed`，与"未参与"分开报告
  - 风险：委托会引入"票的归属"与"票的行使"分离。处置：委托只转移行使权，
    计票仍记在被代表人名下（或按 ADR-0034 的决定），索引视图必须与之同构
- Higher-level simplification:
  - 是否该直接换成 OpenZeppelin Governor？**否**。理由：本项目的全部价值在于
    "链上状态 / 链下投影 / 前端展示"三者一致性可被独立测量（README 开篇）。
    Governor 会引入它自己的计数与投票模块，反而让"谁拥有票数"出现第二个 owner。
    渐进式扩展保住了这个边界。
- Retirement / falsifier:
  - 若批一完成后，`indexer:check-consistency` 无法在多机制下给出 `consistent`
    （即索引无法派生链上票数），则"保留 Poll 架构向上扩展"这一主张被证伪，
    必须停止批二并重新评估 Governor 路径
- Verdict: proceed，但批一必须先落地 ADR-0031/0034，且以一致性检查为证伪点
```

## 10. Plan Pressure Test

```text
Plan Pressure Test:
- Owner / contract / retirement:
  - 机制校验独立成 owner（PollMechanisms + mechanisms.ts），Poll 保持单一职责
  - 旧 ABI 与旧部署整体退役，不保留兼容层（与 ADR-0023 先例一致）
  - 索引 schema 需加列/加表，Sepolia 索引库需清空重建（理由同 ADR-0021：游标已越过新区块区间）
- Architecture integrity / higher-level path:
  - 已论证不采用 Governor（见 Lens 的 Higher-level simplification）
  - 一致性检查作为证伪点，批一结束必须跑通
- Verification scope:
  - 合约层：Hardhat 单元 + 1000 轮属性测试扩展到多机制
  - 索引层：decode/sync 单测 + 真实 MySQL 视图验证 + 一致性检查
  - 浏览器层：ui:drill 扩展（多选/委托/commit-reveal 三块新交互）
- Task executability:
  - 每个 Task 给出确切文件、命令与预期；批一每步都可独立验证
- Pressure result: proceed
```

## 11. Plan-Time Complexity Check

```text
Plan-Time Complexity Check:
- Target files:
  - Poll.sol 现 682 行 —— 加入四种机制后会显著膨胀，是本计划最大的复杂度风险
  - data.ts、PollAdmin.tsx（659 行）、PollBallot.tsx（554 行）已是仓库最大的几个文件
  - schema.ts 260 行（6 表 3 视图）、decode.ts 313 行
- Existing size / shape signals:
  - 仓库已有"拆组件"先例：Ballot.tsx 586 行被拆为 PollList / PollCard / CreatePollForm / MyVotes
  - 仓库也有"拆文件被放弃"先例：data.ts 拆分因循环依赖被放弃，改为同文件划边界
- Owner fit:
  - Poll.sol 承担 682 行尚可，但四种机制全塞进去会超过 1000 行并混入四种语义
  - 机制校验可外提（PollMechanisms.sol），投票主路径不可外提（状态耦合）
- Add-in-place risk:
  - 直接往 Poll.sol 加四种机制会让"读这个合约理解投票"变成不可能
- Better file boundary:
  - 拆出 PollMechanisms.sol（校验）+ 把 commit-reveal 的哈希与窗口逻辑做成内部库
  - 前端新增三个面板组件，不往 PollAdmin/PollBallot 上堆
- Recommendation: split task（批一 Task 1 先立 PollMechanisms.sol 与 ADR，再改 Poll.sol）
```

## 12. Execution Readiness View

```text
Execution Readiness View:
- Intent Lock: 渐进式补齐四类功能缺口（投票机制 / 治理 / 数据接口 / 前端体验），保留 Poll 架构
- Scope Fence:
  做：多选、加权、委托、commit-reveal、quorum+timelock+execute、创建准入、
      分页搜索、投票率、审计视图、RPC 容错、图表、WalletConnect、i18n、模板草稿、通知
  不做：zk 投票（MACI/Semaphore）、跨链多链索引、The Graph、公网托管、Gas 代付、
        后端持私钥、为本地演示留后门分支
- Baseline Lock:
  基线 §5.2 五条不变量中 1/2/3/5 不得破坏；第 4 条（一人一票）由 ADR-0034 显式重定义后生效
  规格 §11 非目标中被本计划取代的条目必须显式修订并记 ADR（不得静默违反）
- Approved Behavior: 见 Tasks 1-13 的验收段
- Owner / Contract Constraints:
  Poll 仍是票数唯一 owner；Factory 不记账；索引只做投影；机制校验归 PollMechanisms
- Compatibility Boundary:
  ABI 不兼容（Poll.initialize 与 VotingFactory.createPoll 签名都变）；
  旧部署与旧索引库作废；不保留兼容层
- Retirement Boundary:
  旧的 scalar votedFor 语义、ADR-0003 的"无隐私"结论、
  前端硬编码的 eligible=null 与固定 50 条扫描上限，均在对应批次退役
- Task Batches: 批一 Task 1-4 / 批二 Task 5-7 / 批三 Task 8-10 / 批四 Task 11-13
- Test Obligations:
  每批结束：pnpm test（合约 + web）、pnpm typecheck、pnpm format:check、pnpm build:web
  批一另需：pnpm indexer:check-consistency 为 consistent（证伪点）
  涉及事件/表结构变更时另需：pnpm indexer:refund-drill
- Review Gates:
  批一结束做一次合约边界复核（不变量、重入面、押金守恒、权限）
  批四结束做一次全链路演练（含移动端连接器与 i18n 切换）
- Drift / Rewind Rules:
  若批一发现多机制下索引无法派生链上票数 → 停止批二，记录证伪，回到架构选择
  若某机制导致属性测试无法维持不变量 → 该机制单独回退，不拖累其余三批
- Evidence Required Before Completion:
  合约测试全绿（含扩展后的属性测试）、一致性检查 consistent、
  ui:drill 新场景全通过、负向对照实测记录、ADR 与基线漂移登记完成
- Advisory Boundary: method-pack execution guidance only; not GateDecision, PolicySnapshot, or completion authority
```

## 13. Open Questions（执行时按推荐值实施）

| #   | 问题                         | 推荐值                                                          | 理由                                                                   |
| --- | ---------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | 委托是否支持链式（A→B→C）    | **不支持**，只允许一层委托                                      | 链式需要防环、需要遍历，gas 不可预测；一层已覆盖"我没空投票"的核心场景 |
| 2   | 未揭示的 commit 如何影响结果 | **不计票，但不阻塞结束**；揭示窗口结束后视为弃权，押金仍可退    | 若"未揭示即阻塞"会让恶意者用一次 commit 冻结整个投票                   |
| 3   | 加权投票的权重来源           | **创建时快照的固定权重表**（创建者上传地址→权重），不引入 ERC20 | 引入 ERC20 会把依赖、转账、快照区块全部拖进来，超出渐进式范围          |
| 4   | quorum 的基数                | **合格选民数**（白名单规模或快照权重总和），按机制自动选择      | 与 Task 9 的"合格选民数"复用同一来源，避免两份口径                     |
| 5   | 执行失败的处置               | **标记为 failed 并允许重试**，不回滚投票状态                    | 回滚会让"投过票的人"状态不一致；失败可见比静默回滚更符合本项目纪律     |

---

## Tasks

### 批一：投票机制

---

#### Task 1：立 ADR 与机制校验 owner

**Files**

- 新建 `docs/aegis/adr/ADR-0030-voting-mechanisms-are-configurable-at-creation.md`
- 新建 `docs/aegis/adr/ADR-0031-commit-reveal-replaces-public-ballots.md`
- 新建 `docs/aegis/adr/ADR-0034-one-vote-one-person-is-redefined-per-mechanism.md`
- 新建 `contracts/contracts/PollMechanisms.sol`
- 新建 `contracts/contracts/PollMechanisms.t.sol`
- 新建 `web/src/lib/mechanisms.ts`
- 新建 `web/test/mechanisms.test.ts`
- 修改 `docs/aegis/INDEX.md`、`CONTRIBUTING.md`

**Why**：`CONTRIBUTING.md:15` 明确要求"如果一项改动需要违反五条不变量之一，它需要先改 ADR，而不是先改代码"。多选/加权/委托直接改变第 4 条"一人一票"的含义，因此 ADR 必须先落地。

**Change Necessity**：这不是文档洁癖。ADR-0003 已经**明确考虑并拒绝了 commit-reveal**（原文："只解决截止前泄露，揭示期后仍公开，且引入'不揭示'的惩罚设计"）。用户现在选择它，属于决策反转，按 `BASELINE-GOVERNANCE.md` §3 必须以新 ADR 取代旧 ADR，否则实现就在静默偏离基线。

**Impact / Compatibility**：无代码兼容影响（本 Task 只加 ADR 与一个尚未被调用的纯函数合约）。

**Steps**

1. 写 ADR-0031。必须包含三段实质内容：
   - **取代关系**：显式声明 `supersedes: ADR-0003`，并逐条回应 ADR-0003 当初拒绝 commit-reveal 的两条理由（截止前泄露已解决；"不揭示的惩罚设计"由 Open Question 2 的推荐值处理——不计票但不阻塞）
   - **诚实的边界**：commit-reveal **只隐藏投票过程中**的选择，揭示后仍然公开。不得声称它提供"永久隐私"。这一条必须与 `README.md` 现有的「没有投票隐私」声明同步改写，否则页面会宣称一个不存在的性质
   - **代价**：投票从一步变两步；未揭示即弃权；需要揭示窗口
2. 写 ADR-0034。重定义第 4 条不变量为：**"在给定机制配置下，每个合格主体的票权至多被计入一次"**。必须给出四种机制各自的形式化表述，并明确"多选"下的一票是"一份选项集合"，"加权"下是"权重和上限"。
3. 写 ADR-0030。声明机制在 `initialize` 时固定、无 setter（沿用 ADR-0025 对 `openToAll` 的同一理由：中途可改的规则会让票数变成可被按结果调节的量）。
4. 实现 `PollMechanisms.sol`：纯函数 `validate(PollConfig) → (bool, string)`，覆盖 16 种机制组合的合法性（例如"加权 + 多选"是否允许、"隐私 + 委托"是否允许）。**不接受所有组合**：明确拒绝语义冲突的组合，并在 ADR-0030 里列出被拒组合与理由。
5. 实现 `web/src/lib/mechanisms.ts`，与上面同构。
6. 写 `web/test/mechanisms.test.ts`，含一条**跨语言一致性断言**：对同一组 config，TS 侧与 Solidity 侧判定一致（Solidity 侧结论以 test fixture 的期望值固化）。

**Verification**

```bash
cd decentralized-voting-dapp
pnpm --filter @voting/contracts test:solidity   # PollMechanisms.t.sol 全绿
pnpm --filter @voting/web test                  # mechanisms.test.ts 全绿
python <aegis>/scripts/aegis-workspace.py check --root .
```

预期：新 ADR 结构校验通过；机制组合校验有正例也有反例（**反例不可省**：只测合法组合无法证明校验在做事）。

---

#### Task 2：`Poll.sol` 支持多选与加权

**Files**

- 修改 `contracts/contracts/Poll.sol`
- 修改 `contracts/contracts/Poll.t.sol`
- 修改 `contracts/contracts/PollProperties.t.sol`

**Why**：`votedFor` 是 `mapping(address => uint256)`（`Poll.sol:254`），一个地址只能指向一个选项，多选在数据模型上就不存在。

**Change Necessity**：必须改存储结构。多选需要"一个地址对应一组选项"，加权需要"票数增量不等于 1"。

**Impact / Compatibility**：ABI 不兼容。`vote(uint256)` 变为 `vote(uint256[])`；`votedFor` mapping 语义变化；`VoteCast` 事件需能表达多选与权重。

**Steps**

1. 把 `votedFor` 语义扩展为 `mapping(address => uint256[]) votedOptions`，并保留 `votedFor` 作为"单选时的兼容读取"（返回数组首元素或 0）——**但要在 ADR-0034 登记这是读取便利而非第二份真相**。
2. `voteCount` 由 `uint256` 改为按权重累加：单选每票 +1；加权按权重表累加。
3. **未被选中的选项必须显式计 0**，不得因"没出现在数组里"而在 `results()` 中缺行——`option_tally` 视图依赖每个选项都有行（`schema.ts:233-245` 的注释已说明这一点）。
4. 扩展属性测试：把 40 选民 × 3 选项 × 1000 轮扩展为**多机制矩阵**，每轮随机选择机制与操作，复查不变量。
5. **负向对照必做**（本仓库的核心纪律）：注入"多选时只给第一个选项计数"的变异，属性测试必须以票数不守恒失败。

**Verification**

```bash
pnpm --filter @voting/contracts test
pnpm coverage     # 覆盖率不得低于本轮基线 96.57% / 95.63%
pnpm gas          # 记录多选与加权的 gas 增量
```

预期：属性测试全绿；负向对照实测失败并记录失败信息。

---

#### Task 3：委托投票

**Files**

- 修改 `contracts/contracts/Poll.sol`
- 修改 `contracts/contracts/Poll.t.sol`、`PollProperties.t.sol`
- 新建 `web/src/components/DelegationPanel.tsx`
- 修改 `web/src/components/PollBallot.tsx`

**Why**：持票人无法参与是治理场景最常见的抱怨。当前没有 `delegate` 概念。

**Change Necessity**：委托是投票权转移，必须在链上表达；链下无法代理签名（会违反"后端不持私钥"）。

**Impact / Compatibility**：新增 `delegate` / `undelegate` 与 `Delegated` 事件；`vote` 需区分"本人投"与"代投"。

**Steps**

1. 加 `mapping(address => address) delegatedTo`，只允许**一层**（Open Question 1）；`delegate(to)` 时若 `to` 已委托给他人，revert（拒绝链式）。
2. 自委托与循环委托必须 revert，并各有一条测试。
3. `voterState` 扩展返回委托信息（**注意：`voterState` 已被 ADR-0025 扩展过一次为 5 元组，本次是第二次破坏性扩展——README 与基线必须同步**）。
4. 明确"被委托人投票时票权算谁的"并写进 ADR-0034；索引侧 `decode.ts` 必须能推导出同一结论。
5. 前端：`DelegationPanel` 显示"我委托给了谁 / 谁委托给了我"，并处理"我已委托出去，因此不能直接投"的禁用理由（扩展 `ballot-reasons.ts`，保持纯函数）。

**Verification**

```bash
pnpm --filter @voting/contracts test
pnpm --filter @voting/web test
TEST_ACCOUNT=0x… pnpm ui:drill --delegate   # 新增场景，需同步扩展 ui-drill.ts
```

---

#### Task 4：commit-reveal 隐私投票

**Files**

- 修改 `contracts/contracts/Poll.sol`（commit / reveal 两阶段 + 揭示窗口）
- 修改 `contracts/contracts/Poll.t.sol`、`PollProperties.t.sol`
- 修改 `web/src/lib/indexer/decode.ts`、`web/src/lib/db/schema.ts`
- 新建 `web/src/components/CommitRevealPanel.tsx`
- 修改 `web/src/lib/ballot-reasons.ts`、`web/test/ballot-reasons.test.ts`

**Why**：这是 ADR-0031 的落点，也是用户明确选择的方向。

**Change Necessity**：隐私只能在链上机制层解决，前端加密无意义（明文仍会进交易）。

**Impact / Compatibility**：新增 `commit` / `reveal` 两个写路径；`Phase` 需增加揭示窗口（或复用 `Voting` + 新增 `Reveal`）；索引需新增 `committed` 状态。

**关键设计与陷阱（执行者必须照此处理）**

1. **`committed` 必须与"未参与"分开报告。** 这是 ADR-0011/0014 的硬要求：不得用默认值代替"未知"。若把"已 commit 未 reveal"渲染成"没投票"，就是对读者的谎报。
2. **未揭示不阻塞结束**（Open Question 2）：揭示窗口结束后未揭示者视为弃权，押金仍可通过 `refund` 取回。
3. **commit 的哈希必须绑定投票人与 poll 地址**（`keccak256(abi.encode(voter, poll, optionIds, salt))`），否则可被抢跑重放。
4. `Phase` 枚举扩展会改变 `phase_events.to_phase` 的取值——索引侧 `decode.ts` 与已有数据的语义必须同步，**Sepolia 索引库必须清空重建**（理由同 ADR-0021）。
5. 前端两步交互：commit 后按钮变"等待揭示"，并给出揭示截止倒计时（复用 `Countdown.tsx`）。

**Verification**

```bash
pnpm test
pnpm indexer:migrate && pnpm indexer:drain
pnpm indexer:check-consistency     # 必须是 consistent —— 这是 §9 的证伪点
pnpm indexer:refund-drill          # 表结构变了，必须重跑
```

**批一收尾**：跑完整 `pnpm test && pnpm typecheck && pnpm format:check && pnpm build:web`，并执行 §9 的证伪判定。若一致性检查无法给出 `consistent`，**停止批二**并记录证伪。

---

### 批二：治理与权限

---

#### Task 5：quorum 与时间锁

**Files**：修改 `contracts/contracts/Poll.sol`、新建 `contracts/contracts/PollExecutor.t.sol`

**Why**：当前 `endPoll` 只改 phase（`Poll.sol:461-466`），投票结果是一组数字，没有任何后果。

**Change Necessity**：阈值与时间锁是链路状态，必须在链上。

**Steps**

1. 加 `quorumBps`（基点，避免浮点）与 `timelockSeconds`，均在 `initialize` 固定。
2. `PollOutcome` 判定函数：`Passed / Rejected / QuorumNotMet`，作为 `view` 暴露。
3. 时间锁只允许在 `Passed` 后启动，且不可缩短。

**Verification**：`pnpm --filter @voting/contracts test`；三种 outcome 各有测试。

---

#### Task 6：结果上链执行

**Files**：修改 `Poll.sol`、`PollExecutor.t.sol`、`web/src/components/ExecutionPanel.tsx`、`PollAdmin.tsx`

**Why**：完成"投票通过→自动执行"闭环。

**Steps**

1. `queueExecution(target, value, calldata)` 仅创建者、仅 `Passed`、仅时间锁后。
2. `execute()` 任何人可调（时间锁已过），失败时标记 `failed` 并允许重试（Open Question 5，**不回滚投票状态**）。
3. `cancelExecution()` 仅创建者且仅在执行前。
4. 目标调用必须是受控的：记录 `target` 白名单或要求 `target` 为本人创建的合约，避免任意调用成为后门。
5. 索引新增 `ExecutionQueued` / `Executed` / `ExecutionCancelled` 三事件。

**Verification**：含"执行失败后重试成功"与"时间锁未到拒绝执行"两条关键测试。

---

#### Task 7：工厂创建准入

**Files**：修改 `VotingFactory.sol`、`web/src/components/CreatePollForm.tsx`

**Why**：README §0 承认"任何人都能创建投票，因此投票本身不可信"，并指出"正解是给工厂加一层准入"。本 Task 实现该选项。

**Steps**

1. 加 `creatorAllowlistEnabled` 与 `setCreatorAllowlist`（owner 管理）。**默认关闭**，保持现有行为不变（不破坏既有测试与演示）。
2. 关闭时不增加任何 gas 之外的检查；开启时非白名单 `createPoll` revert。
3. 前端在开启时显示"仅特定地址可创建投票"。

**Verification**：两种模式下各有测试；默认关闭时既有工厂测试**必须全部保持通过**（这是兼容性证据）。

---

### 批三：数据与接口层

---

#### Task 8：RPC 多端点容错

**Files**：修改 `web/src/lib/config.ts`、`chain.ts`、`wagmi.ts`、`web/src/lib/indexer/sync.ts`

**Why**：`config.ts:130` 只读单个 `RPC_URL`；RPC 一挂全站白屏（`data.ts:392-404` 多处 catch 后返回 null）。

**Steps**

1. `RPC_URLS`（逗号分隔）替代单值，保留 `RPC_URL` 作为首选项（向后兼容）。
2. viem `fallback` transport 用于读写；索引器在连续失败 N 次后轮换端点。
3. `describeFailure` 的文案需说明"所有端点均失败"而非只报第一个（ADR-0012：失败状态必须指出失败的是谁）。
4. **不得回显端点或 apiKey**（ADR-0020），新增端点后尤其要注意。

**Verification**：单测覆盖"第一个端点失败、第二个成功"的路径；实测用死端口 + 活端点组合验证。

---

#### Task 9：分页、搜索与投票率

**Files**：修改 `web/src/lib/data.ts`、`web/src/app/api/polls/route.ts`、新建 `web/src/lib/pagination.ts`、`web/src/components/{SearchBar,Pagination}.tsx`、修改 `export/route.ts`、修改 `Poll.sol`

**Why**：`VotingFactory.allPolls()` 无分页（`VotingFactory.sol:129` 自认"索引才是分页的正确位置"）；`export/route.ts:82` **硬编码 `eligible = null`**，导致 `turnoutPercent` 永远为空。

**Steps**

1. 合约加 `whitelistedCount`（白名单真实计数），替代前端猜。
2. `pagination.ts` 纯函数：`paginate` / `filterPolls` / `sortPolls`，全部可单测。
3. `/api/polls?page=&pageSize=&q=&sort=`；无索引时回退链上并**明确标注分页能力受限**（不得假装分页了）。
4. `export/route.ts` 用真实 `eligible` 计算投票率；读不到时仍为 `null`（**不得用 0 冒充**，ADR-0011）。
5. `MyVotes.tsx:39` 的 `SCAN_LIMIT = 50` 截断必须暴露给用户（"仅显示最近 50 条"），而不是静默丢弃。

**Verification**：`pagination.test.ts` 覆盖边界（空、越界页、非法 sort）；导出文件含非空 `turnoutPercent`。

---

#### Task 10：审计视图与读缓存

**Files**：新建 `web/src/app/audit/page.tsx`、`web/src/app/api/audit/route.ts`；修改页面缓存策略

**Why**：`PollActivity` 只有投票级视图，无全局审计；且无 MySQL 时直接 404（`activity/route.ts:33-43`）。

**Steps**

1. 全局审计页：按时间倒序的跨投票事件流，可按地址/投票/事件类型过滤，可导出。
2. 无索引时明确显示"这个部署没有可用的索引"，**不得显示成"没有活动"**（沿用现有纪律）。
3. 页面缓存：把 `force-dynamic` 改为可配置的 `revalidate`，但**索引状态与链上事实不得被缓存过长**（ADR-0017：一致性检查必须比较同一瞬间）。

**Verification**：审计页导出与 `PollActivity` 口径一致；缓存改动后一致性检查仍为 `consistent`。

---

### 批四：前端体验

---

#### Task 11：结果图表与视觉

**Files**：新建 `web/src/components/ResultChart.tsx`、修改 `PollBallot.tsx`、`app/poll/[id]/page.tsx`、`package.json`

**Why**：当前只有 `ShareBar` 进度条与百分比文本，无柱状/饼图。

**Steps**

1. **不引入重型图表库**：用 SVG 自绘（投票选项通常 < 20 个，用不上 d3/recharts 的能力，且能避免体积与 SSR 问题）。若确实引入，需在计划外单独说明理由。
2. 图表必须与文本口径一致（同一 `results()` 数据源），并标注数据来源（`source: "index" | "chain"`）。
3. 无障碍：SVG 需带 `role="img"` 与 `aria-label`。

**Verification**：`ui:drill` 断言图表渲染的元素数量与链上选项数相等。

---

#### Task 12：移动端钱包与 i18n

**Files**：修改 `web/src/lib/wagmi.ts`、新建 `web/src/lib/i18n/`、全量组件文案抽取、新建 `web/public/manifest.json`

**Why**：仅 `injected()` 连接器（`wagmi.ts:25`）在手机上很可能连不上；所有文案硬编码中文。

**Steps**

1. 加 WalletConnect / Coinbase 连接器。需要 `projectId`，**凭证不进仓库**（沿用 `contracts/.env` 的纪律）。
2. i18n：抽出 `zh.ts` / `en.ts`，`ballot-reasons.ts` 与 `ballot-labels.ts` 的规则句必须**参数化**（它们是本项目最大的文案面）。
3. 语言切换持久化；默认中文（不破坏现有测试的文案断言——**注意 `ui:drill` 大量断言中文文案，切换默认语言的改动会破坏它们**）。
4. PWA manifest，触控目标最小 44px。

**Verification**：`pnpm test` 全绿（文案断言需同步调整为读 key 而非硬编码字符串——这是一次有价值的重构，能让测试不再依赖具体措辞）。

---

#### Task 13：模板、草稿与通知

**Files**：新建 `web/src/lib/templates.ts`、`TemplatePicker.tsx`、`web/src/lib/notify/`、`api/subscriptions/route.ts`、修改 `CreatePollForm.tsx`、`db/schema.ts`

**Why**：`CreatePollForm` 每次清空（`:113-118`），刷新即丢；无任何触达手段。

**Steps**

1. 草稿存 localStorage，刷新可恢复；提交成功后清除。
2. 模板：预设常见投票结构（单选/多选/加权），带默认机制配置。
3. 订阅：仅实现**站内订阅记录 + 事件驱动的待办列表**，不引入邮件/webhook 外部依赖（那需要凭证与运维，超出渐进式范围）。索引到新事件时为订阅者生成通知行。
4. 通知页显示"我订阅的投票有新动态"。

**Verification**：草稿恢复有单测与 drill 断言；通知在索引事件后确实产生。

---

## Risks

| #   | 风险                                                          | 处置                                                                   |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| R1  | 多机制下索引无法派生链上票数（架构主张被证伪）                | §9 的 falsifier；批一结束用 `check-consistency` 判定，失败则停批二     |
| R2  | commit-reveal 的中间态被渲染成"没投票"（谎报，违反 ADR-0011） | Task 4 步骤 1 强制新增 `committed` 状态；`ballot-reasons` 需有对应理由 |
| R3  | 委托引入"票权归属"第二份真相                                  | ADR-0034 显式定义归属；索引视图与合约同构，并有跨侧一致性测试          |
| R4  | `Poll.sol` 膨胀到难以理解                                     | Task 1 先拆 `PollMechanisms.sol`；批一结束复核行数与职责               |
| R5  | i18n 改动破坏现有中文文案断言（大量 ui:drill 断言）           | Task 12 步骤 3 要求同步改为断言 key；这是一次性成本，需预留时间        |
| R6  | 加权投票若引入 ERC20 会拖入依赖与快照区块                     | Open Question 3 定为固定权重表，明确不做 ERC20                         |
| R7  | 索引 schema 多次变更导致 Sepolia 库反复重建                   | 批一与批二的事件变更合并到一次重建；变更前先导出旧数据留证             |
| R8  | 规格 §11 非目标被违反                                         | 每批结束检查 §11，被取代的条目必须显式修订并记 ADR                     |

## Retirement

- **ADR-0003（无隐私）由 ADR-0031 取代**，README 与 UI 的隐私声明必须同步改写，不得保留"本项目没有投票隐私"这句已经不再成立的表述。
- **`CONTRIBUTING.md` 第 4 条不变量由 ADR-0034 重述**，保留原意（不得重复计票）但明确其在多机制下的形式。
- **`export/route.ts:82` 的 `eligible = null` 硬编码退役**（Task 9）。
- **`MyVotes.tsx:39` 的静默 50 条截断退役**，改为可见的提示（Task 9）。
- **页面 `force-dynamic` 策略退役**，改为可配置缓存（Task 10）。
- **旧的 `vote(uint256)` 单选签名与 scalar `votedFor` 语义退役**，不保留兼容层（与 ADR-0023 先例一致：无外部消费者）。

## Baseline Sync Signals

- 基线 §5.2 五条不变量：第 1/2/3/5 条不得破坏，需在每批结束时逐条登记实测结论；第 4 条由 ADR-0034 重定义后生效。
- 规格 §11 非目标中"不做多轮次选举"的同类条目（若存在与本计划冲突者）必须显式修订，方式沿用规格 §14 校正 26 对非目标 3 的处理（记 ADR + 写明取代理由）。
- 需新增 ADR 至少五条：ADR-0030、0031、0032、0033、0034。
- `BASELINE-GOVERNANCE.md` §6 的七个维度在每批结束复核，特别关注**第 6 条 Retirement completeness**（本计划退役项较多）与**第 7 条 Entropy flow**（新增了 PollMechanisms、mechanisms.ts、三个面板组件，需证明净复杂度未上升）。

## Execution Route

```text
Execution Route:
- Decision: inline
- Evidence: 批一内部任务严格串行——Poll.sol 被 Task 2/3/4 连续修改，且 Task 1 的 ADR 必须先定
  语义（票权归属、未揭示处理）才能写代码；批二依赖批一的 Phase 与事件定义；批三/批四虽相对独立，
  但都读同一份 ABI 与 schema，ABI 未冻结前并行会返工
- Fallback: 批三与批四之间无共享文件依赖，若 ABI 在批二结束时已冻结，可改为 subagent-driven 并行
- User confirmation required: no
```

## Verification（批次级总验收）

**每批结束必跑：**

```bash
cd decentralized-voting-dapp
pnpm test                    # 合约 + web 全绿
pnpm typecheck
pnpm format:check
pnpm build:web
```

**批一额外必跑（含证伪点）：**

```bash
pnpm indexer:migrate && pnpm indexer:drain
pnpm indexer:check-consistency    # 必须 consistent
pnpm indexer:refund-drill         # 表结构已变
pnpm coverage && pnpm gas
```

**批二额外必跑：**

```bash
pnpm indexer:reorg-drill          # 新增执行事件后重组自愈仍需正确
```

**批四额外必跑：**

```bash
# 脚本名是 `ui-drill`（连字符，无冒号）。需要三样东西同时就绪：
#   1. 一份用**当前代码**做的本地部署  2. 跑起来的 Next 服务  3. 已安装的 Chrome
pnpm deploy:local && pnpm seed:local && pnpm export-abi   # 顺序不可颠倒，见下
pnpm indexer:migrate && pnpm indexer:drain
cd web && PORT=3100 pnpm start                             # 另开一个终端
TEST_ACCOUNT=0x… APP_URL=http://127.0.0.1:3100/ pnpm ui-drill           # 只读
TEST_ACCOUNT=0x… APP_URL=http://127.0.0.1:3100/ pnpm ui-drill --vote    # 该账户必须能投票
TEST_ACCOUNT=0x… APP_URL=http://127.0.0.1:3100/ pnpm ui-drill --change
```

`ui-drill.ts` 实际支持的标志只有 `--vote`、`--change`、`--refund`、`--reject`。本文档早先写的 `--delegate` 与 `--commit` **并不存在**，那两条命令无法执行（已于批四补跑时发现并更正）。

`--vote` 会**先自检**账户能否投票，不能投时直接失败并说明原因。在一份白名单投票上用默认账户必然失败，这是设计如此：要么换一个在白名单内的账户，要么用 `POLL_ADDRESS` 指向一份开放投票。

`seed:local` 会**自己部署一份工厂**并覆盖 `deployments/<chainId>.json`，所以 `seed` 必须在 `export-abi` **之前**。顺序颠倒不会报错，而是让应用指向的工厂与实际播种的工厂不同，表现为索引重放 0 条事件。
