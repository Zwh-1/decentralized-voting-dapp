# ADR-0021 - CID 必须由它所命名的那份字节算出，绝不手写

Status: `recorded-from-work`
Date: `2026-09-21`

## Source Evidence

- 代码事实（修复前）：`web/src/lib/ipfs.ts` 的 `isPlausibleCid` 只接受 `^bafy[a-z2-7]{54}$`。而链上那三个 CID 是 `bafyseededcandidate0` / `bafyseededcandidate1` / `bafyseededcandidate2`——20 个字符，且含 base32 字母表里不存在的 `s`。
- 实测（修复前，运行中的页面 `http://127.0.0.1:3100`）：第一张卡片的 `元数据 CID` 渲染为 `bafyseededcandidate0`，`IPFS` 行渲染为 `CID 格式无效，无法解析`。那句话**是对的**：错的是上游，不是解析。
- 代码事实：`contracts/contracts/Voting.sol:88` 的 `addCandidate` 带 `onlyPhase(Phase.Setup)`。合约进入 Voting 之后，这串字符串在同一地址上**无法替换、无法删除**。ADR-0004 的 Compatibility Boundary 写的是"链上只存 CID、内容在 IPFS"，但项目里没有任何东西保证那个 CID 指向任何东西。
- 实测（离线计算，不联网）：`hello world\n`（12 字节）由 `contracts/scripts/cid.ts` 算出的 CIDv0 是 `QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o`，与公开的已知向量逐字符相同；它的 CIDv1 是 `bafybeicg2rebjoofv4kbyovkw7af3rpiitvnl6i7ckcywaq6xjcxnc2mby`，从 `gateway.pinata.cloud` 取回正是这 12 字节（HTTP 200）。一个自写编码器只有对着外部判据才算被验证过。
- 实测（`pnpm pin:metadata`，凭证为 Pinata 的 API key + secret）：服务返回的三个 CID 与本仓库对**同一份字节**算出的 raw 形式逐字符相同——candidate-1 `bafkreihnl2gt3dygiplwxv5kwbx53l4u24cmsnu3tniz2wmew3n7phfq5a`、candidate-2 `bafkreiezmqiiomytpzj5bhprhqepa5ijenxdwtapomhubszecnc2jlx57y`、candidate-3 `bafkreicnafrpxomcyqhmba7n22yd662kik5bon4nldeusvep72i2luomnu`；并由公共网关回读、逐字节比对通过。
- 实测（同一份字节的另一种编码，未被 pin）：candidate-1 的 dag-pb CIDv1 `bafybeicsozbs4b4qfcshiqyxw7ghv7hexrcfvnpki57jieidh7yfavmsrm` 是一个**完全合法**的 CID，但没有任何服务 pin 过它。经模块取回得到 `{"status":"unreachable","attempts":3}`（36.2 s 内三个网关都没有作答）。结论：链上写哪个编码不是风格问题，写错就是没有任何网关能取到。
- 实测（本机，对真实网关，180 字节文档）：`gateway.pinata.cloud` 四次重复取回耗时 **7.2 / 3.7 / 7.0 / 3.7 s**；`dweb.link`、`ipfs.io`、`w3s.link`、`4everland.io` 全部在网络层失败（约 11–12 s）。用模块原先的 6 s 预算取三条真实 CID 时，有三张卡片中的**两张**得到 `{"status":"unreachable","attempts":3}`——一个当时正在正常作答的网关被报成"不可达"。
- 实测（修复后，模块 + 真实网关 + 真实 CID）：三条 CID 全部 `{"status":"ok"}`，耗时 4140 / 5889 / 6756 ms，姓名分别为 林澈 / 周予安 / 苏芷宁。这是 `ok` 分支第一次在真实网关上发生——README §6 此前把它登记为未验证边界。
- 实测（`pnpm ui:drill`，只读，Chain 11155111，真实 Chrome + 注入钱包）：`metadata 已解析 / 已解析 / 已解析`、`names 林澈 / 周予安 / 苏芷宁`、浏览器控制台 0 条消息、17 条断言全通过。这条边界因此从"单测覆盖"变成"浏览器实测"。
- 实测（同一演练，在等待逻辑修好之前）：页面在钱包连上后立即被读取，三张卡片都还是 `读取中…`，于是**所有**关于元数据的断言全部通过却什么也没证明。改成只等元数据之后，`白名单` 与 `押金` 两行仍停在 `读取中…`，两条既有断言当场失败——等一行等于等错了对象。
- 实测（索引库，重建前）：投影里仍是 `bafyseededcandidate0/1/2`，而 `sync_cursor.last_block = 11749347`，已经**越过**新合约 11,749,345–11,749,348 的事件区间。不清空它，新合约的 `CandidateAdded` 永远不会被索引，而 `/api/candidates` 会回答"没有候选人"。
- 实测（重新部署与播种）：新合约 `0x564a8c64a3f5a05c5a93a9050192cf293b1ea0b6`；`addCandidate` ×3 与 `startVoting` 在区块 11,749,345–11,749,348 成功；随后 `/api/health` 为 `status=ok`、`lagBlocks=0`，`/api/results` 为 `consistent`，索引侧与链侧都给出那三个真实 CID。

## Context

CID 是一个**断言**："这些字节存在于某处"。修复前，仓库里没有任何东西把这个断言和字节连起来：那个字符串可以来自任何人、任何时间、任何笔误，而类型系统、测试、构建、SSR 都对它无话可说。它在界面上唯一的去处就是"格式无效，无法解析"——一句关于字符串形状的真话，把读者的注意力引向解析器，而真正的错误在上游。

这个缺陷是不可逆的：`addCandidate` 只在 Setup 可调用，因此修法不是"改掉仓库里的占位串"，而是**重新部署一个合约**，并把"CID 从哪来"这件事本身变成有判据的流程。

要让判据成立，必须先区分两个方向，它们的要求相反：

- **读取侧必须宽松**：一个合法但少见的编码（`bafk…` raw codec）被报成"格式无效"，等于告诉读者数据坏了，而实际是校验太窄。这条已经修过（ADR-0012 的同一类，见 `isPlausibleCid` 的注释）。
- **写入侧必须严格**：CID 由**字节 + 导入配置**共同决定（codec、是否分块、是否包一层目录）。同一份字节在 dag-pb 与 raw 两种导入下是两个不同的块，而只有一个真的在网络上（证据 6）。因此"本地算出 CID 再写进链上"这个方向是错的：**必须先 pin，再拿服务返回的 CID，并核对它与本地计算一致**。实测正是这样发现 Pinata 的 `cidVersion: 1` 返回的是 raw leaves 而不是 dag-pb——这个事实不能靠猜，猜错的代价是一个永久无法解析的链上字符串。

## Decision

1. **候选人元数据文档入库**：`contracts/metadata/candidate-N.json`，LF 结尾、确定性序列化（ADR-0010 的同一约束：受守卫的产物里不放易变字段）。
2. **新增 `contracts/scripts/cid.ts`**：零依赖的 CID 计算与**真解码**解析，只用 `node:crypto`。覆盖 sha2-256 多哈希、CIDv0 base58btc、CIDv1 base32lower、raw codec 与 dag-pb + UnixFS 单块 protobuf；`parseCid` 真的把字节解出来（而不是正则匹配形状），并导出 `sameBlock`——CIDv0 与 dag-pb CIDv1 是**同一个块**的两种编码，比较字符串会把一个正确的 CID 判成不匹配。
3. **新增 `contracts/scripts/metadata.ts` 与 `contracts/metadata/manifest.json`**：manifest 记录每个文档被 pin 之后**服务返回的** CID；`seedableCids()` 在使用前逐条重算并核对"这个 CID 就是这些字节"，不一致就拒绝播种。
4. **新增 `contracts/scripts/pin-metadata.ts`**：上传原始字节 → 要求服务返回的 CID 与本地计算属于**同一个块**（`sameBlock`）→ 从公共网关回读并逐字节比对 → 才写 manifest。凭证只从 `contracts/.env` 读（JWT 或 key+secret 两种形态都接受），且**从不回显任何值**——半个凭证按"半个"报告（ADR-0016/0020 的措辞纪律）。重复执行是幂等的：已记录且**确实可取回**的文档不再上传。
5. **播种脚本不再接受手写 CID**：默认取 manifest。`SEED_CANDIDATES` 覆盖仍然保留（它是运维在紧急情况下唯一的入口），但每个值必须是**真的 CID**（`cidProblem` 逐条校验），且运行时会声明"未与任何文档核对"。
6. **`web/src/lib/ipfs.ts` 的单请求超时 6 s → 15 s**，并在"配置的网关"与默认列表之间去重。15 s 是实测值而不是偏好：一个比最慢真实应答更短的超时不是安全阈值，而是一台**误报机器**，而且它用与真故障完全相同的措辞报告（"3 个网关均不可达"）。
7. **`NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/`**：把元数据实际 pin 到的那个网关放在第一位，否则每张卡片都要先等两个在本机根本不可达的默认网关。**末尾斜杠是必需的**（模块拼的是 `${gateway}${cid}`），`.env.example` 写明原因。
8. **`ui:drill` 读到的是稳定页面，并且检查渲染出来的内容**：新增"被称为格式无效 ⟺ 不是可解析形状"与"显示文档姓名 ⟺ 已解析"两条双向断言，读每张卡片的 `元数据 CID` 与标题；把"连上钱包立刻读一次"改成"等到整页不再有 `读取中…`"；只读运行不再限定本地链。

## Alternatives Considered

- **让浏览器自己算 CID（把文档打进前端包）。** 会把候选人元数据变成前端资产，与 ADR-0004"链上只存 CID、内容在 IPFS"直接冲突；而且浏览器算出的 CID 只证明"这些字节的哈希是这个"，不证明任何网关上有它。
- **只收紧 `isPlausibleCid`（要求真的能解码）。** 形状与内容无关：`bafyseededcandidate0` 修好格式也仍然指向不存在的块。上一轮刚把这条校验**放宽**（不限 codec），本轮的实测证明那是必需的——真实返回的正是 `bafk…`。
- **继续用占位 CID，只在界面上标注"演示数据"。** 把不可更正的数据留在链上，并让界面为它背书；这正是本项目反复拒绝的那种"把错误解释成正常状态"。
- **引入 `multiformats` + `@ipld/dag-pb` 来计算 CID。** 会改动 `pnpm-lock.yaml`（CI 有锁文件漂移检查），而这里的编码有外部可验证的判据（已知向量 + pinning 服务返回的 CID + 网关回读），因此几十行纯编码是更小的代价。
- **先算出 CID 再上传，不核对服务返回什么。** 服务端的导入配置（CID 版本、是否 raw leaves、是否 `wrapWithDirectory`）无法预先假定；本轮实测就发现 `cidVersion: 1` 是 raw leaves。不核对的结果是把一个没人 pin 过的 CID 写进链上。
- **缩短超时让失败更快。** 会把实测 7.2 s 的网关报成不可达——正是本轮要消除的那种误报；"更快地给出错误结论"不是改进。
- **保留旧 Sepolia 合约，只修仓库。** `addCandidate` 是 Setup-only，链上那三个字符串不可替换。ADR-0004 的 Compatibility Boundary 就是这么写的，所以这条边界是设计的一部分，不是本轮的意外。
- **在演练里用 CDP 替换页面上的 CID 来造失败场景。** 上一轮已经实测过：替换文档里的占位 CID **没有**改变客户端实际使用的 CID，断言当时仍然是空过的。真实内容比模拟失败更值得先覆盖（本轮做的是前者）。

## Consequences

- 正面：`ok` 分支第一次在真实网关上发生——三条 CID，模块 4140/5889/6756 ms，浏览器演练 `已解析 / 已解析 / 已解析`，卡片显示 `林澈 / 周予安 / 苏芷宁`，控制台 0 条消息。README §6 的两条"成功路径从未在真实网关上发生"因此关闭。
- 正面：CID 现在与链外的事实绑定。改一个字节：`pnpm test` 会失败（`metadata/` 自检），播种会拒绝（`manifestProblems`），pin 会拒绝（`sameBlock`）。"手写 CID"这条路径被结构性移除，而不是靠纪律。
- 正面：上一轮把 `isPlausibleCid` 放宽为不限 codec，本轮由真实数据证明是必需的。
- 正面：演练不再"读得太早"。改动前它在钱包连上后立刻读页面，元数据断言**全部通过却零证据**；现在它等到整页稳定，并把姓名与 CID 一起断言。
- 代价：三个网关都无应答时，卡片要 **45 s**（3 × 15 s）才说出"3 个网关均不可达"，原先 18 s。期间只显示 `读取中…`；这是刻意的取舍——错误的"不可达"会让读者去排查一条其实正常的网络。
- 代价：Sepolia 合约地址变更（`0x4bb0fd8c…503e` → `0x564a8c64…a0B6`），索引库必须清空重建（游标已越过新区块的证据见 Source Evidence）；旧地址上的候选人与票成为历史记录。
- 代价：新增 `contracts/metadata/` 与一个需要网络和凭证的**手工**步骤；`contracts/.env` 多两个变量。
- 测试：contracts 单测 **28 → 60**（新增 `test/cid.ts` 19、`test/metadata.ts` 13）；web 单测 **157 → 161**（`ipfs.test.ts` +4）；`pnpm typecheck` 通过；只读演练断言 **15 → 17**（实测数字，非推算）。
- **已知边界**：`manifest.json` 的"确实已 pin"只在执行 `pnpm pin:metadata` 的那一次被证明。CI 不会 pin，因此一个后来消失的 pin（服务端回收、配额、账号变动）不会被任何测试发现，只会在读者那里表现为"网关可访问但没有返回可用的候选人元数据"。
- **已知边界**：`--vote` / `--refund` 两个演练场景本轮**未重跑**（需要一个本地节点与第二套索引）。被改动的是三个场景共用的读取与等待逻辑，它在 Sepolia 只读场景中被真实执行过；两个写场景的断言数量按同一块断言推算为 +2，但**未经本轮实测**。
- **已知边界**：新断言的否方向（未解析时卡片显示编号）与"重试"按钮，仍然**没有在浏览器中渲染过**——本轮链上全是真实可解析的 CID，因此没有卡片进入失败分支。

## Compatibility Boundary

对外契约不变：`/api/*` 的响应形状、合约接口、`MetadataResult` 的成员集合、`fetchCandidateMetadata` 从不 reject 的性质均未改动。**可观察的行为变化**：Sepolia 的合约地址变了（新部署），因此任何针对旧地址的索引都变成陈旧数据，必须重建；候选人卡片上的 `元数据 CID` 由 `bafyseededcandidateN` 变为三条真实的 `bafk…`；单请求超时 6 s → 15 s，失败路径最坏耗时 18 s → 45 s；新增可选环境变量 `NEXT_PUBLIC_IPFS_GATEWAY`（构建期内联）与两个 pinning 凭证变量；`package.json` 新增 `pin:metadata` 脚本；仓库新增 `contracts/metadata/`。

## Retirement Impact

- 第 1–4 条是"CID 由它所命名的字节算出"的落点。将来若更换 pinning 服务（web3.storage、自建 kubo、S3+网关等），"服务返回的 CID 必须与本地计算属于同一个块"这一步**必须保留**：它是这条链路上唯一能证明"链上的字符串真的指向内容"的检查，去掉它，剩下的就只是一次上传成功。
- 第 2 条的 `sameBlock` 依赖 multiformats 的定义：同一 multihash、同一 codec、仅编码不同即为同一个块。若将来允许其它 codec（dag-cbor、dag-json），`computedCids` 与 `sameBlock` 的覆盖面必须同步扩展，`cidProblem` 的措辞也要跟着改——否则会出现"喂进去一个真实存在的块，工具说不认识"。
- 第 6 条的 15 s 是**本机实测值**，不是偏好。换网关、换网络、换部署地区，都必须重新测量而不是照抄；这条注释存在的意义就是让下一个人知道它从哪来。
- 第 7 条依赖 `NEXT_PUBLIC_*` 的构建期内联语义。如果将来元数据改由服务端抓取并缓存，这条应当移到服务端配置，并把"密钥不进浏览器"一并考虑。
- 第 8 条的"等到整页不再 `读取中…`"必须随卡片一起保留：它之所以存在，是因为一次读得太早的断言会**全部通过却什么也不证明**，而这比一条会失败的断言更难发现。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §6.4 与 §14 校正 12/16 登记的是 `ipfs.ts` 的四种结果与卡片措辞，校正 23 登记的是失败文案不得回显环境；三者都没有把"CID 是从哪来的"登记为被验证对象。本轮为这条从未被登记的事实建档（新增校正 24），并关闭 §6 里两条"成功路径从未在真实网关上发生"的未验证边界。既有条目无需改写，漂移表补记一行。

## Evidence References

- contracts/scripts/cid.ts（新增：计算、真解码解析、`sameBlock`）
- contracts/scripts/metadata.ts、contracts/metadata/（新增：文档、manifest、自检）
- contracts/scripts/pin-metadata.ts（新增：pin、核对、回读）
- contracts/scripts/seed-local.ts、contracts/scripts/seed-sepolia.ts
- contracts/test/cid.ts（新增）、contracts/test/metadata.ts（新增）
- web/src/lib/ipfs.ts（超时、网关去重）、web/.env.example
- web/scripts/ui-drill.ts（等待整页稳定、CID 与姓名断言、任意链只读）
- contracts/deployments/11155111.json（`0x564a8c64…`）
- docs/aegis/adr/ADR-0004-ipfs-for-metadata-only.md
- docs/aegis/adr/ADR-0010-one-record-one-schema-no-volatile-fields-in-guarded-artifacts.md
- docs/aegis/adr/ADR-0012-failure-states-name-the-failing-party.md
- docs/aegis/adr/ADR-0016-deploy-preflight-checks-usability-and-never-echoes-a-value.md
- docs/aegis/adr/ADR-0018-cache-and-retry-are-decided-per-result.md
- docs/aegis/adr/ADR-0020-failure-reports-give-the-shape-never-the-environment.md

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
