# ADR-0044 - 文案抽取的三个边界：插值值、测试钩子、数据制品

Status: `accepted`
Date: `2026-09-22`

## Source Evidence

- `web/src/lib/voting.ts`：`CHAIN_NAMES` / `EN_CHAIN_NAMES`、`chainName(chainId, locale = DEFAULT_LOCALE)`、`PHASE_LABELS` / `EN_PHASE_LABELS`、`phaseLabel(phase, locale)`
- `web/src/lib/presentation.ts`：`PHASE_TONE_LABELS`、`phaseTone(phase, deadlinePassed, locale)`
- `web/src/lib/health-report.ts`：`HEALTH_LABELS = { zh, en }`、`healthRows(health, locale)`、`lagLabel(lagBlocks, locale)`；`不适用` 与 `未启用` 是两个不同的键
- `web/src/components/TrustPanel.tsx`：`data-fingerprint={id}`（id 为 `committed` / `current`），旁边 `label` 才可翻译
- `web/src/components/PollBallot.tsx`：`data-phase={phase}`（数字），文字节点另放
- `web/scripts/ui-drill.ts`：`[data-fingerprint="committed"]`；CSV 断言 `exportProbe.includes("选项 ID")`
- `web/test/i18n.test.ts`：占位符声明表改为遍历**两个**目录
- `web/test/health-report.test.ts`：`describe("healthRows in English")`
- 现状依据：ADR-0040 的 Consequences 记着"英文界面目前是部分翻译"；本轮把它补完，并发现三类新的缺口

## Context

ADR-0040 决定了默认中文、语言由读者选择、合约名不翻译，并留下一条明确的未完成项：组件文案只抽了一部分，英文界面是中英混杂的。补完这件事时，三种**不在"字面量"这一类里**的中文漏了出来，而它们共同的特征是：**全文扫描 `"[\u4e00-\u9fff]"` 会全部命中，但只看 JSX 文本节点会全部漏掉。**

1. **插值值。** `chainName()` 与 `phaseLabel()` 的返回值被插进已翻译的句子（`list.noFactory`、`myVotes.currentAddress`、`ballot.wrongNetwork`…）。句子在目录里是英文的，填进去的值是中文的，渲染出 `The current chain (31337, 本地 Hardhat) has no registered factory address`。这**正是** ADR-0040 要消除的病症，只是从插值值进来而不是从字面量。

2. **测试钩子。** `TrustPanel` 的 `data-fingerprint={label}` 承载的是**可见标签**。标签进目录后，英文读者的属性值变成英文，而 `ui-drill` 的选择器写死 `[data-fingerprint="创建时的承诺"]`。

3. **数据制品。** 组件与路由里都拿不到的第四种情况：CSV 表头。

第四件事不是漏翻译，而是**测试看起来在覆盖、其实没有**：`health-report.test.ts` 的每一条断言都 pin 默认语言输出，因此 `healthRows` 接没接 locale 都是绿的——面板可以永远是中文而整套测试全过。

## Decision

**一、插值值必须和句子一起翻译。**

任何**返回文案**的函数，其返回值要进入已翻译句子时，该函数自己必须接受 `locale`：

```ts
export function chainName(chainId: number, locale: Locale = DEFAULT_LOCALE): string;
export function phaseLabel(phase: number | undefined, locale: Locale = DEFAULT_LOCALE): string;
```

做法沿用 `voting.ts` 的形状而非往 `messages.ts` 加键：**ZH 表保留、EN 表只放真正需要第二种拼法的条目**。`Sepolia` 是协议名，两种语言写法相同，因此**不重复**——"派生值一律从单一来源生成"在此处的含义是：同一份内容不写两遍。`health-report.ts` 同理用一个 `HEALTH_LABELS = { zh, en }` 表，因为十行标签是**一套连贯的词汇**，放在一处才能一眼回答"每行都翻了吗"。

尾参默认 `DEFAULT_LOCALE` 是让所有既有调用点与测试一字不改仍然工作的那一半，也是 ADR-0040 风险 R5 的兑现方式。

**二、判定留在原处，只有措辞过参数。**（ADR-0040 第三条的延续）

`phaseTone` 的四个分支、`lagLabel` 的空值分支、`healthRows` 的行顺序都**一个字没动**。翻译可以改词，不能改"读者被告知的是哪一件事"。

这条边界有一个具体后果值得记下：`不适用`（这个部署算不出这个数）与 `未启用`（这个功能没打开）**是两个不同的断言**，因此是两个不同的键。抽取过程中它们一度被合并，`health-report.test.ts` 立刻变红（`'未启用' !== '不适用'`）。那条测试的注释解释了为什么它是承重的（ADR-0015：不要用一个缺失的读数编造一个健康的读数）。**"不要造同义词"这条纪律禁止的是两个键装同一个字符串，不是两个不同的判断装同一个键。**

**三、测试钩子不许挂在文案上。**

`data-*` 属性的值若取自可翻译的文案，则读者换语言会让选择器失效。修法是**钩子携带稳定的机器标识，文案另放**：

```tsx
<dd data-fingerprint={id}>{value}</dd>   // id: "committed" | "current"
<span data-phase={phase}>{phaseInfo.label}</span>   // phase: number
```

`data-phase-label` 尤其值得记：它**从未带过值**，也**从未被任何选择器引用**。它之所以要改，不是因为它坏了，而是因为"读起来像机器可读的值、实际是可翻译文案"的属性，会在**有人第一次真正去选它的那天**坏掉。一个空转的隐患不是没有隐患。

**四、数据制品的语言不跟随读者。**

CSV 表头**保持中文，两种语言下都是**。理由（从强到弱）：

1. **列名是 schema 键，不是散文。** 下游脚本按 `选项 ID` 找那一列。表头跟着 cookie 变，意味着同一个 URL 对不同人返回两种 schema——`/api/polls/0x…/export?format=csv` 不再可复现，而**可复现正是导出存在的唯一理由**。这一点与导出路由自己的注释承诺一致："an export must stay reproducible for a machine that has no opinion about language"。
2. 元数据行（`投票合约` / `问题` / `阶段`…）是同一类东西，只翻一半会得到**半个文件的翻译**，是最差的结果。
3. 若英文读者真需要英文导出，正确做法是 `?lang=en` 这种**进入 URL、可被缓存**的显式参数——导出的语言成为它身份的一部分——而不是一个静默改变机器可读制品的 cookie。那是新功能，不是抽取。
4. 与 ADR-0040 第四条同源：读者或脚本会拿这些字符串去核对，改名就切断了唯一的交叉验证手段。

**注意这条只适用于 CSV 的列名。** 同一个路由的 JSON body 里 `phaseLabel` 仍然翻译，因为 JSON body 是给人读的，而 CSV 表头是给脚本匹配的。**同一个文件里两种判断并存，是刻意的。**

**五、"测试通过"不等于"测到了"。**

`health-report.test.ts` 原本只 pin 默认语言，两条路径都绿。因此新增的英文测试断言的是**全部十行标签**，而不是抽查一个——**一个翻译过的行只能证明参数存在，不能证明十行都用了它**。同时它断言"数据类值必须保持原样"（工厂地址、链 ID 在被翻译的英文行里仍是原文），因为翻译它们会破坏读者复制核对的动作。

同类纪律：占位符声明表此前只遍历 `ZH_BALLOT_PHRASES`，**所有 `Messages` 键的占位符拼写其实无人检查**。现已改为遍历两个目录。该守卫的两侧性用变异测试验证过：往真实目录注入一个拼错的 `{oops}` 会让它失败并报出确切键名，注入前基线通过，文件逐字节还原。

## Consequences

- ADR-0040 记的"英文界面是部分翻译"**到此为止不再成立**：`ballot-labels.ts`、全部组件、`voting.ts` / `presentation.ts` / `health-report.ts` / `trust.ts` / `failure.ts` / `data.ts` 的文案都已过参数，`src/` 下不再有未接 `locale` 的文案函数调用点。
- **未完成的部分必须记明**：`ui-drill` 仍然只在默认中文下运行，因此**英文路径没有浏览器端到端覆盖**（ADR-0040 的这条限制依然有效）；英文路径由 `i18n.test.ts` / `chrome-copy.test.ts` / `health-report.test.ts` 的目录测试覆盖。移动端 WalletConnect 握手仍未实测。
- 新增文案函数必须带 `locale`，否则同类泄漏会重新长出来。**这条没有被编译器强制**——`locale` 是可选尾参，所以忘了传不会报错。目前靠 `src/` 下的调用点审计与目录测试兜着，这是一个已知的、写在这里的弱点。
- `failure.ts` 的 `<已隐去的 URL>` / `<已隐去>` 保持中文：它们替换的是已被移除的文本，是**脱敏保证**的一部分，`failure.test.ts` 对其有断言。而 `describeFailure` 的四句解释**要翻译**——它是返回给九个 `/api/*` 路由、被三个 Server Component 渲染的**脱敏替代品**，真正进日志的是原始异常。
