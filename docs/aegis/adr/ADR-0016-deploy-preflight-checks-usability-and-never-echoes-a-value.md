# ADR-0016 - 部署前检查的是"可用"，不只是"存在"，且绝不回显值

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测（`contracts/.env` 里 `SEPOLIA_PRIVATE_KEY` 为空、`VOTING_OWNER` 是一个 66 字符的 `0x`+64 位十六进制值）：`deploy:local` 退出码 1，输出 `InvalidAddressError: Address "0x7077…" is invalid.`，**并把该值原样打进终端**，随后堆栈指向 viem 的 `encodeAddress`。报错全文没有出现 `VOTING_OWNER`。
- 实测（同一份 `.env`，`deploy:sepolia`）：退出码 1，只报 `SEPOLIA_PRIVATE_KEY` 缺失。`VOTING_OWNER` 的问题当时完全没有露面，因为本地网络会提前返回、而非本地网络只数"变量在不在"。
- 代码事实（修复前）：`deploy.ts` 的 `preflight()` 只检查两个必需变量**是否存在**；`VOTING_OWNER` 从未被检查，而是以 `as \`0x${string}\`` 断言后直接传给构造函数。
- 代码事实：`deploy.ts` 用 `process.env.VOTING_OWNER ?? deployer.account.address`，因此 `VOTING_OWNER` 对**每个**网络都生效，包括 `localhost` 与 `hardhat`。
- 实测（viem 的报错形状）：对错误值抛 `InvalidAddressError`，消息长度 221 字符，**包含该值**（`does the message echo the value? true`），**不包含**变量名。
- 实测（修复后）：同一份 `.env` 下 `deploy:sepolia` 报 `needs 2 configuration fixes`，同时指名 `SEPOLIA_PRIVATE_KEY`（未设置）与 `VOTING_OWNER`（"this value is 66 characters"），全文不含该值；`deploy:local` 报 `needs 1 configuration fix`（仅 `VOTING_OWNER`）且不再到达 viem。
- 实测（回归）：`VOTING_OWNER` 未设置时 `deploy:local` 正常部署（`0xccf176…`，区块 407，owner 默认为部署者）；预检对 `localhost` 静默放行。

## Context

D3（Sepolia 真机部署）需要一个由人手编辑的 `.env`。第一次拿到真实内容时，那个文件处于**第三种**状态：不是缺失，而是**填了但不能用**——一个 32 字节的秘密被贴进了地址字段。原有的守卫只数变量在不在，于是这条路径以两种方式同时出错：

1. **报错不指名变量。** 读者看到的是 `InvalidAddressError` 与一段 viem 堆栈，无法从消息判断该去改哪一个变量。
2. **报错回显了值。** 这是更严重的一条：被回显的是一个私钥形状的秘密，而它进入的是终端、CI 日志与任何粘贴了输出的地方。一个"贴错了字段"的失误因此升级为一次泄露。

第二个网络路径还掩盖了这个问题：`deploy:local` 提前返回不检查任何东西，`deploy:sepolia` 只检查两个必需变量。于是同一个坏值在两条路径上都逃过检查，直到撞进 viem。

与 ADR-0012（失败必须指名出错的一方）和 ADR-0014（不得为未知公布具体值）同源，但对象是**部署前的输入校验**，而且这里多出一条它们没有的约束：**校验消息本身可以成为泄露渠道**。

## Decision

1. **把预检抽成 `contracts/scripts/preflight.ts`，导出纯函数 `configurationProblems(networkName, env)`**，使规则可被单测覆盖，而不是只藏在脚本的顶层 `await` 之后无法import的位置。
2. **检查"可用"而不只是"存在"。** `SEPOLIA_RPC_URL` 必须能解析为 http(s) URL；`SEPOLIA_PRIVATE_KEY` 必须是 `0x`+64 位十六进制；`VOTING_OWNER`（若设置）必须是 `0x`+40 位十六进制。三者的失败都**在校验层**报出，不再交给 viem。
3. **报告里永不出现值，只出现形状。** 消息给出"期望什么"与"这个值有多少个字符"。这是硬约束，并由一条专门断言"值与其前 4 位都不得出现在报告里"的测试钉住。
4. **凭证与部署输入按不同的条件把关。** 凭证（RPC URL、私钥）只在非本地网络需要；`VOTING_OWNER` 是部署**输入**，在任何网络都校验。把它一起挂在"是否本地"上是修复过程中的实际错误——见下文。
5. **keystore 提示只给真正的秘密。** `VOTING_OWNER` 是地址，把它指向 `keystore set` 会把一个公开值加密起来，并让直接读 `process.env` 的 `deploy.ts` 看不到它。
6. **一次报出全部问题**，而不是每次只报一个（原有行为，保留）。
7. **`.env.example` 写明 `VOTING_OWNER` 必须是地址、不是私钥**，并说明贴错时应轮换该密钥。

## Alternatives Considered

- **只把 viem 的报错包一层 try/catch 重新抛出。** 那时值**已经**被 viem 写进消息里了；要擦掉它就得解析并改写第三方消息，比在它之前拦住更脆弱。
- **只检查存在性，让 viem 负责形状。** 就是修复前的行为，也是本条 ADR 全部证据的来源。
- **把 `VOTING_OWNER` 也当成凭证、只对非本地网络校验。** 这是我在实施中真的写错的一版：它让 `deploy:local` 继续把值送给 viem 并回显。契约是"部署输入在任何网络都生效"，不是"只有远程部署才需要"。
- **对 `VOTING_OWNER` 提供 keystore 提示。** 会让一个公开值被加密，且 `deploy.ts` 读的是 `process.env`，加密后反而取不到。
- **在 `deploy.ts` 里就地校验而不抽模块。** 那段代码在顶层 `await` 之后，测试无法 import 它，而本轮正需要"回显值"这种断言——把规则放在测不到的位置，就会再次靠人工浏览器/终端去发现。
- **对 `SEPOLIA_RPC_URL` 只检查非空。** 一个写成 `127.0.0.1:8545`（缺 scheme）的端点会在连接阶段失败，报出的是 Hardhat 的通用错误而不是"这个变量不是 URL"。

## Consequences

- 正面：手编 `.env` 的两种真实失败（形状错、贴错字段）都在连接任何网络之前被指名报出。
- 正面：错误路径不再回显秘密值。这是一次实质的泄露面收敛，而不是文案改进。
- 正面：`deploy:local` 与 `deploy:sepolia` 共用一套规则与一种口吻；此前两条路径的严格程度不同，且都不足以拦住实测到的那份文件。
- 正面：规则可单测（新增 15 例），其中一条专门守护"不得回显"。
- 代价：`deploy.ts` 少一段内联逻辑，多一个模块与一个导入。
- 代价：预检现在对"看起来很合理"的配置也可能拒绝（例如把地址填进私钥字段），需要读者按消息里的形状说明去核对——这是用一次可读的拒绝换掉一次不可读的失败。
- 合约侧 nodejs 测试 8 → **23**，合约总数 49 → **64**，全项目 144 → **159**。

## Compatibility Boundary

`contracts/scripts/deploy.ts` 的命令行与产物（`deployments/<chainId>.json` 的字段集合）不变。`contracts/scripts/preflight.ts` 是新增模块；原先从 `deploy.ts` 导出的 `preflight` 现在自该模块导出，`credentialProblems` 在实施中改名为 `configurationProblems`（它已不只是凭证检查）。**可观察的行为变化**：配置形状错误时，部署在连接网络之前就以非零码退出并给出项目自己的说明；此前它会继续到 viem 并以一段不指名变量、且回显值的错误结束。合法配置下的部署流程逐字节不变（本地路径已实测：新地址、区块 407、记录字段齐全，随后已还原链与记录）。

## Retirement Impact

若将来增加更多"部署输入"（例如初始候选人列表、质押额覆盖），第 2 条与第 4 条应扩展到它们，并保持"输入按是否生效把关、凭证按网络把关"的划分。若引入硬件钱包或 `keystore` 之外的签名后端，第 5 条仍需保留：keystore 只适用于秘密。第 3 条在任何重构下都不得放松——一旦报告允许携带值，泄露面就会随每一条新校验重新长出来。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线从未把"部署前的输入校验"列为被验证对象。§7（当前状态与风险）记的是运行期风险，§9（兼容边界）记的是产物与接口形状，校正 9 记的是 Hardhat 3 不读 `.env`、校正 10 记的是索引起始区块——都不涉及"配置填错时会发生什么"。因此没有既有条目需要改写，漂移表补记一行即可。

## Evidence References

- contracts/scripts/preflight.ts
- contracts/scripts/deploy.ts
- contracts/test/preflight.ts
- contracts/.env.example
- docs/aegis/adr/ADR-0010-one-record-one-schema-no-volatile-fields-in-guarded-artifacts.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md
- docs/aegis/adr/ADR-0014-three-state-reads-and-independent-prefetch.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
