# ADR-0040 - 默认中文，语言只由读者选择，合约的错误名不翻译

Status: `accepted`
Date: `2026-09-22`

## Source Evidence

- `web/src/lib/i18n/locales.ts`：`LOCALES = ["zh","en"]`、`DEFAULT_LOCALE = "zh"`、`resolveLocale`、`localeFromCookieHeader`
- `web/src/lib/i18n/messages.ts`：`ZH_MESSAGES` 是形状的唯一权威，`EN_MESSAGES satisfies Messages`
- `web/src/lib/i18n/ballot-phrases.ts`：`BallotPhrases`（约 35 条），只有 `wrongNetwork` 带占位符
- `web/src/lib/i18n/index.ts`：`interpolate()`、`translatorFor(locale = DEFAULT_LOCALE)`
- `web/src/components/LocaleProvider.tsx`、`LanguageSwitcher.tsx`、`web/src/app/layout.tsx`
- `web/src/lib/ballot-reasons.ts`：每个 `*Reason(input, locale = DEFAULT_LOCALE)`
- `web/test/i18n.test.ts`：8 个 `describe`，含键集相等、占位符对齐、无重复文案
- 现状依据：改动前全部面向读者的文案是内联中文硬编码，散在 24 个组件与 `ballot-reasons.ts` 里

## Context

项目从一开始只有中文文案，而且它们**内联在判断逻辑旁边**。要加英文，最省事的做法是到处写 `locale === "en" ? "..." : "..."`。这条路有一个具体的坏结局：条件表达式散开之后，**没有人能回答"哪些句子被翻译了"**——漏掉一条就永远漏掉，因为没有一处地方能看出缺口。

第二个约束来自本项目的既有不变量。`ballot-reasons.ts` 的函数**不是文案函数，是判定函数**：它们按固定顺序检查连接、合约可读、阶段、押金、白名单，然后返回"最该说的那一句"。顺序本身就是设计（ADR-0012：说出是哪一方出了问题）。把文案抽出去的时候，很容易顺手把判定也改写成按语言分支，那就把"顺序"变成了"每种语言各有一份顺序"。

第三个约束是风险 R5：`ui-drill` 断言的是**中文字符串**。任何改变默认语言的改动都会让这些断言静默失效——它们不会报错，只会再也匹配不上。

## Decision

**一、默认必须是 `zh`，且"默认"不是"兜底"而是"读者没表达偏好时的唯一答案"。**

`resolveLocale` 只认 `zh` 与 `en` 两个字面量；任何其他值（包括 `undefined`、cookie 里的乱码、`"ZH"`）都回到 `zh`。这样 `ui-drill` 里所有既有的中文断言在**没有任何 cookie** 的情况下继续成立，风险 R5 因此不需要靠"记得不要改默认值"来规避，而是被类型和测试钉住。

英文只有一种到达方式：**读者自己按了语言按钮**。没有 `Accept-Language` 协商，没有 IP 猜测，没有"检测到浏览器是英文就自动切"。理由是本项目的一条既有立场——不要替读者猜，因为猜错的表现是"这个网站是坏的"，而不是"这个网站选错了语言"。

**二、`ZH_MESSAGES` 是形状的唯一权威，`EN_MESSAGES` 用 `satisfies` 约束。**

```ts
export type Messages = { readonly [K in keyof typeof ZH_MESSAGES]: string };
export const EN_MESSAGES = { ... } satisfies Messages;
```

这一行是整套 i18n 里最重要的东西。它把"翻译有没有漏"从**人的注意力**问题变成**编译器**问题：加一条中文键而忘了英文，`typecheck` 直接失败。键集相等也有独立的测试，因为 `satisfies` 允许多余键。

**三、判定与文案分离，但分离的边界画在"整句"上，不画在"词"上。**

每个 `*Reason` 仍然**自己决定说哪一句**，只是句子的来源变成了参数：

```ts
export function voteReason(
  input: BallotInputs,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined;
```

顺序、谓词、`undefined` 的时机**一个字都没动**。`web/test/ballot-reasons.test.ts` 里那个"同一输入在两种语言下必须产出同一个原因"的扫描测试，就是这条边界的守卫：翻译可以改措辞，不可以改"读者被告知的是哪一件事"。

**四、合约的名字一个都不翻译。**

以下东西保持英文原样，包括在中文界面里：

- 自定义错误名：`AlreadyVoted`、`SameOption`、`HasNotVoted`、`InvalidPhase`、`DeadlineNotInFuture`
- 入口点：`startPoll()`、`closeAfterDeadline()`
- 变量名与函数名：`votedFor`、`changeVoteTo`、`commitmentOf`

理由不是"翻译不了"，而是**读者会拿这些字符串去链上核对**：在区块浏览器里搜 `AlreadyVoted`。译成"已经投过票了"之后，这句话在链上搜不到，读者就失去了唯一的交叉验证手段。这与 ADR-0016 同源：给形状，不给结论。

`deadlinePassed` 这类**状态词**则照常翻译，因为它描述的是读者的处境，不是一个可以被搜到的标识符。

**五、`interpolate` 故意让未填的占位符**可见**。**

```ts
interpolate("切换钱包到 {chainName}", {}); // -> "切换钱包到 {chainName}"
```

看起来像 bug，实际是刻意的：如果未填占位符被替换成空字符串，一条写错了键名的模板会渲染成通顺但**缺信息**的句子（"切换钱包到"），没人会发现。留着花括号，读到的是一句明显坏掉的话，控制台和截图里都藏不住。`i18n.test.ts` 里有一条扫描测试专门断言英文下**任何**可能产出的句子里都不含 `{...}`。

用 `Object.hasOwn` 而不是真值判断，是为了让 `0` 和空串能正常渲染——`{count}` 是 0 时必须显示 `0`，不能显示 `{count}`。

**六、语言状态有两只副本，但它不是"派生值手写两份"。**

cookie（`voting_locale`，服务端 `layout.tsx` 读取，用于 `<html lang>`）与 `localStorage`（客户端即时切换用）会同时写。这里不违反"派生值一律从单一来源生成"，因为两者**不是同一个值的两份拷贝**：cookie 是**请求时**的偏好，localStorage 是**这个浏览器**的偏好，它们的用途不同、生命周期不同。真正的单一来源是**读者的那次点击**，两个存储都是它的下游。

## Consequences

- 加一种语言现在是：加一个 `locales.ts` 的字面量、加一份 `satisfies Messages` 的目录、加一份 `satisfies BallotPhrases` 的短语表。编译器会指出所有缺口，`i18n.test.ts` 会指出占位符不一致。
- 未完成的部分必须记明：组件文案的抽取只做了一部分——`ballot-reasons.ts`、塔标元数据、语言切换器、结果来源标签已完成；**`ballot-labels.ts` 的阶段/状态句与其余组件的文案仍是内联中文**。也就是说，英文界面目前是"部分翻译"，不是"完整英文"。这一点在 README 里也写明了，因为一个看起来完整的语言按钮配上中英混杂的页面比没有按钮更糟。
- `ui-drill` 继续在默认中文下运行，因此它对英文路径**没有覆盖**。英文路径目前由 `i18n.test.ts` 的目录完整性测试覆盖，没有被浏览器端到端验证过。
