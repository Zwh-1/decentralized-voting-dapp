# ADR-0022 - 钱包的拒绝必须说成一句中文，且必须以"链上有没有变化"收尾

Status: `recorded-from-work`
Date: `2026-09-21`

## Source Evidence

- 实测（真实使用，Sepolia，已白名单的 owner 账户 `0x409da005…9589`，页面 `http://127.0.0.1:3100`）：点击「投一票（0.001 ETH 押金）」，在钱包弹窗里点「拒绝」，页面的**我的状态**面板下渲染出一行英文：

      User rejected the request.

  这是 viem 透传的钱包原文（EIP-1193 code `4001`），也是本轮修复前 `Ballot.tsx` 的写法 `writeError.message.split("\n")[0]` 的唯一产物。

- 实测（同一时刻，直接读链）：`isWhitelisted=true`、`hasVoted=false`、`votedFor=0`、`stakeOf=0 wei`、`totalStaked=0`、三个候选人票数 `0/0/0`。**拒绝一笔签名没有改变链上任何东西**，而页面上那句话对此只字未提。
- 实测（`eth_estimateGas(vote(1), 0.001 ETH)`，from = 同一账户）：`149049`，未 revert。即时报错的那次，合约、白名单、阶段、金额**全都是对的**，第 4001 号错误是唯一的问题。
- 代码事实（修复前）：写入路径的错误只有一处渲染，`Ballot.tsx` 的 `writeError.message.split("\n")[0]`，直接透传。读路径早在 ADR-0009/0012/0014/0019/0020 被逐行整治过，**写入路径的这一行是整页最后一处未经分类的英文**。
- 代码事实：`failure.ts: describeFailure` 服务的是**服务端依赖**失败（RPC、MySQL），`writeContract` 的错误根本不经它；其注释还明确写着"本项目自己写的错误原样透传"。
- 实测（修复后，`pnpm ui:drill --reject`，真实 Chrome + 注入钱包，Sepolia 11155111，账户 `0x409da005…9589`）：注入的 provider 在 `eth_sendTransaction` 上抛 `code 4001`，与真实钱包拒绝同一形状；页面渲染 **`你在钱包里拒绝了这笔交易，链上没有任何变化。`**，`data-write-error="classified"`，正文**不含任何 ASCII 字母**，且断言 `hasVoted` / `stakeOf` 与点击前逐位相同。

## Context

ADR-0012 定下"失败状态必须指出失败的是谁"，ADR-0019 把三态读取铺到每一行，ADR-0020 又规定"只给形状、不回显配置，原始错误只写服务端日志"。这五条 ADR 覆盖的都是**读**：轮询、预取、SSR、`/api/*`、IPFS 网关。**写**只有一条路径，也就是 `useWriteContract`，而它的错误从头到尾只有一行代码，且没有任何 ADR 提到过它。

它的症状有两种，且第二种比第一种更贵：

1. **说了读者看不懂的话。** `User rejected the request.` 是钱包的措辞、viem 的原文、英文。整页中文里突然出现一句英文，读者第一反应是"程序坏了"——实测中这一点被问了出来。
2. **没有说最该说的那句话。** 拒绝签名与"投票失败"在链上的后果完全不同：前者什么都没发生，可以立刻重试；后者可能已经花掉 gas。**读者的下一个动作取决于这个区别**，而这句话恰恰不说。

同时也不能走向另一个极端：把所有写入错误都变成一句"交易失败"。钱包能返回的成因彼此无关——拒绝签名（`4001`）、已有一个待处理请求（`-32002`）、钱包在别的链上、余额不足、节点认为这笔交易**已经提交过**（`already known`）——它们对读者的含义不同，其中 `already known` 是唯一一类**不能**说"链上没有任何变化"的：节点手里可能真的有一笔相同交易。

## Decision

1. **新增纯函数 `ballot-labels.ts: describeWriteFailure(error)`**，写入路径失败文案的唯一来源，返回 `{ text, classified }`。`text` 永远是一句中文陈述句；`classified` 表示成因是否被识别。
2. **分类依据错误链上的标记，而不是错误文本。** 走完 `cause` 链（上限 10 层、自引用安全），收集每一层的 `code` / `name` / `shortMessage` / `details` / `message`，然后按证据强度判断：EIP-1193 的 `4001` 与 `-32002` 是数值码，`ChainMismatchError` 一类是 viem 的类名，文本线索只在两者都缺席时兜底。viem 把钱包的 `ProviderRpcError` 埋在一到两层 `BaseError` 之下，**只读 `error.message` 的分类器看不见它**。
3. **每一类都指名失败方，并写明链上的后果**：

   | 成因                           | 渲染                                                                                                           |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
   | 读者在钱包里拒绝（`4001`）     | 你在钱包里拒绝了这笔交易，链上没有任何变化。                                                                   |
   | 钱包已有待处理请求（`-32002`） | 你的钱包里已经有一个待处理的请求，请先在上面那个弹窗里处理完，再重试；链上没有任何变化。                       |
   | 钱包在别的链上                 | 钱包所在的网络与页面配置的网络不是同一条链，交易没有发出。请切换钱包网络后重试。                               |
   | 余额不足                       | 钱包余额不足以支付押金和网络费，交易没有发出，链上没有任何变化。                                               |
   | 节点认为已提交过               | 钱包或节点认为这笔交易已经提交过，链上可能已经有一笔相同的交易。请等它确认，或刷新页面查看状态，不要重复提交。 |
   | 合约回滚                       | 合约回滚了这笔交易：链上状态没有改变（这笔交易若已被打包，网络费仍会消耗）。                                   |

   最后一行刻意同时说出两种可能：回滚可能发生在估算阶段（什么都没发出），也可能发生在打包之后（gas 已消耗）。ADR-0012 的规则是"宁可多一个状态，也不要一句在某一类情况下为假的话"。

4. **不认识的成因不作猜测。** 落到 `classified: false` 与一句"钱包或节点返回了一个页面无法归类的错误，原始错误已输出到浏览器控制台"，由组件把这句原始错误**打印到浏览器控制台**。这既保住可诊断性，又不让页面替一个没识别的错误编造结论（ADR-0012、ADR-0020 的同一条规则）。
5. **金额与合约自有的 error 名都不进句子。** 余额不足那句不写 `0.001 ETH`（押金数额已经印在按钮上，写死等于复制一个常量）；合约回滚那句不复述 Solidity 的 `AlreadyVoted(0x…)`（UI 已按 ADR-0009 用同样的链上读数把按钮关掉，能走到这里的是竞态或过期标签页，读者需要的是"没变化、可以重试"）。原始 error 名进控制台。
6. **组件侧**：`Ballot.tsx` 渲染 `writeFailure.text`，并给这一行加 `data-write-error={classified ? "classified" : "unclassified"}`；未识别时在 `useEffect` 里 `console.error` 一次（不是渲染期，避免重渲染重复打印）。
7. **演练**：`ui:drill --reject` 让注入钱包在 `eth_sendTransaction` 上抛 `4001`，驱动真实 Chrome 断言八件事——一个可点的投票按钮确实被点击、错误行存在、`data-write-error="classified"`、文案逐字等于第 3 条那一句、正文不含 ASCII 字母、拒绝确实发生在钱包（`eth_sendTransaction:refused`）、没有被说成"提交中…"、**并回读链上 `hasVoted`/`stakeOf` 与点击前逐位相同**。这是"链上没有任何变化"这句话第一次被断言，而不只是被宣告。该模式**不广播任何交易**，因此与 `--vote`/`--refund` 不同，可以对着已部署的链跑。

## Alternatives Considered

- **照旧透传原文，只在前面加一句中文前缀（"投票失败："）。** 读者仍然看不懂 `User rejected the request.`，"链上有没有变化"这个真正决定下一步动作的问题依然没有答案。
- **把所有写入错误统一成"交易失败，请重试"。** 对 `already known` 是错的（可能真有一笔在链上），对链不匹配也是错的（重试一万次都不会成功），而且把读者唯一能自己解决的两类（换网络、加余额）抹掉了。
- **把分类放进 `failure.ts`。** 那个模块的契约是"服务端依赖失败，按驱动自身的标记分类"，它的出口是 `/api/*` 的 JSON 与 SSR 横幅；钱包错误只出现在 DOM 里，证据是 EIP-1193 码。合并会让两个不相干的分类表住进同一个函数，且"只给形状、不回显配置"那条边界会被稀释。
- **按 `instanceof UserRejectedRequestError` 分类。** 需要把 viem 的类引进一个纯模块，且 viem 换类名就失效；`failure.ts` 早已为同一理由选择了按形状判断。
- **把合约的自有 error 逐个映射成中文。** 表达力更强，但要维护 9 条映射，而这 9 条在正常操作下**不可达**——按钮的可用性来自同一组链上读数（ADR-0009），能触发的只有竞态。登记为边界比维护一张死表更诚实。
- **未识别时不打印任何东西。** 页面变干净了，但排障线索一起消失；ADR-0020 的做法是"原始错误只写日志"，这里对应的是浏览器控制台。

## Consequences

- 正面：写入路径不再向页面输出英文；实测拒绝场景渲染 `你在钱包里拒绝了这笔交易，链上没有任何变化。`，正文零 ASCII 字母。
- 正面：这句话里最 actionable 的那半句（链上有没有变化）第一次被**断言**过，而不只是被写下来——`--reject` 回读链上 `hasVoted`/`stakeOf` 与点击前逐位相同。
- 正面：`already known` 单独成类，`already known` 与"拒绝"不会共用一句在某一类下为假的话。
- 正面：`ballot-labels.ts` 新增 12 个用例，web 单测 161 → **173**。
- 代价：未识别的成因在页面上只剩一句泛泛的中文，运维要看原文得开浏览器控制台。这是刻意的取舍：页面上的句子必须为真，控制台里的话可以只是原文。
- 代价：`ui:drill` 多一个模式与 8 条断言；注入钱包多一个 `REJECT_SENDS` 分支。
- **未消解的边界**：`--reject` 复现的是**provider 拒绝签名**这一形状，不是"读者在真实 MetaMask 里点拒绝"的完整链路（真实钱包在拒绝前还会自己做一次 gas 估算与 UI 确认；演练里估算走的是转发到节点的 `eth_estimateGas`）。这条边界与 README 里"演练用的是模拟 provider"是同一条。
- **未消解的边界**：`-32002`（已有一个待处理请求）、链不匹配、余额不足、`already known`、合约回滚五类**只有单测覆盖，没有在真实钱包上触发过**。它们的证据目前是形状，不是实测。
- **新登记的相邻缺口（未修）**：写入路径没有"钱包在别的链上就不发交易"的前置守卫。页面只在 `walletChainId !== configuredTarget.chainId` 时显示红色横幅，`writeContract` 仍会把一笔带着押金的交易发往**该链上并不存在合约的那个地址**。ADR-0019 解决了"读哪条链"，本条只解决"失败怎么说"，这个问题原样留着并在此登记，不假装它不存在。

## Compatibility Boundary

`Ballot.tsx` 渲染的写入错误文案由"viem 原文首行"变为"分类后的中文句子"，并新增一个 `data-write-error` 属性。依赖这段文本的消费者只有 `ui:drill`，已同步。`describeWriteFailure` 是新导出，仓库外无消费者。不涉及 ABI、API 响应或数据库。

## Retirement Impact

第 1 条（唯一入口）必须保留：只要有一处重新写 `error.message.split("\n")[0]`，这条边界就重新打开，而且它以"某天又出现一句英文"的形式表现，不会被任何构建或类型检查发现。第 2 条（按标记分类、走 cause 链）在更换钱包连接库后需复核：viem 若不再把 `ProviderRpcError` 放进 `cause`，`4001` 会落到未识别分支——届时补分支，不要放宽成"按文本兜底"。第 4 条（不认识就不猜）在任何重构下都不得取消。第 5 条（不复述金额与 Solidity error 名）在新增合约错误或调整押金时必须重审，但仍应遵循"句子只放读者能据以行动的信息"。若将来引入"钱包在错链时不发交易"的守卫，第 3 条的链不匹配一行应从"交易没有发出"改为"页面没有发起交易"，并以实测更新。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §4.3 的 M-6e 只要求"未白名单账户按钮禁用且说明理由"与"不存在假提交状态"，§5.2 只要求"后端不持私钥"；两者都没有规定**写入失败时页面可以说什么**。这是一条此前未被登记为被验证对象的性质，漂移表补记一行，既有条目无需改写。§9 的"不允许为本地演示在合约中留后门分支"与本条无关：本次改动没有触碰合约，白名单门槛原样保留。

## Evidence References

- web/src/lib/ballot-labels.ts（`describeWriteFailure`）、web/test/ballot-labels.test.ts（12 例）
- web/src/components/Ballot.tsx（写入错误行 + `data-write-error`）
- web/scripts/ui-drill.ts（`--reject` 模式、注入钱包的 `REJECT_SENDS`、8 条断言）
- docs/screenshots/ui-write-error-rejected.png
- docs/aegis/adr/ADR-0009-ui-eligibility-from-chain-not-query-status.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md
- docs/aegis/adr/ADR-0019-the-browser-reads-the-chain-the-deployment-is-configured-for.md
- docs/aegis/adr/ADR-0020-failure-reports-give-the-shape-never-the-environment.md
- README.md
- docs/aegis/specs/2026-09-20-decentralized-voting-dapp-design.md（校正 25）

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
