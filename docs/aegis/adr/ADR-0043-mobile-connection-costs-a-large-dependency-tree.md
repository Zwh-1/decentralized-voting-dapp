# ADR-0043 - 移动端连接换来了一整棵依赖树，这笔代价要说出来

Status: `accepted`
Date: `2026-09-22`
Amends: `docs/aegis/adr/ADR-0020-endpoints-are-reachable-but-never-echoed.md`（同一条"不回显敏感值"的规则，延伸到 WalletConnect 的 project id）

## Source Evidence

- `web/src/lib/wallet-connectors.ts`：`PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/i`、`resolveWalletConnect()`、`walletConnectNotice()`
- `web/src/lib/wagmi.ts`：`buildConnectors()`、`WALLET_APP_NAME`
- `web/test/wallet-connectors.test.ts`（含"通知里不含被拒绝的值"）
- `web/public/manifest.json`、`web/src/app/layout.tsx`（`manifest: "/manifest.json"`）
- `web/package.json`：`@walletconnect/ethereum-provider`、`@coinbase/wallet-sdk`
- 现状依据：改动前只有 `injected()` —— 桌面浏览器扩展能用，手机浏览器**完全无法连接**

## Context

"移动端钱包连接"是四类缺口里唯一一个**只能靠引入外部依赖**解决的。没有浏览器扩展的手机上，连接钱包只有两条路：WalletConnect（扫码/跳转）和 Coinbase Wallet SDK（跳转到 App）。两者都是几万行的第三方代码。

这与本项目的既有倾向相冲突：这里到处都在减少依赖、减少第二份事实、减少"我控制不了的东西"。所以这不是一个"加了就好"的决定，而是**一次明确的取舍**，必须把代价写出来，否则下一个人只会看到 `package.json` 里多了两行，不知道它们意味着什么。

## Decision

**一、连接器按"能不能用"装配，而不是无条件全部注册。**

```ts
buildConnectors() = [injected()] + (walletConnect 可用时) + [coinbaseWallet({ appName })]
```

WalletConnect 需要 project id。没有它，`walletConnect()` 注册出来的是一个**点了会报错**的选项——对读者来说这比"没有这个选项"更糟。所以缺 id 时**不注册**它，并在浏览器控制台给一句说明。

`injected()` 永远在，因为它是零依赖的那条路：桌面用户不该为了移动端支持而多付任何代价。

**二、project id 只做形状校验，且**永不回显**。**

`PROJECT_ID_PATTERN` 只检查"32 位十六进制"。它**不能**判断这个 id 是否有效——那需要一次网络请求，而一个用来校验配置的函数不应该有网络副作用。所以它的作用是抓住最常见的错误（粘贴了 URL、粘贴了私钥格式、忘了改占位符），而不是保证正确性。

`walletConnectNotice(status)` 的测试里有一条专门断言**通知文本里不含被拒绝的值**。这是 ADR-0020 的同一规则：一个诊断信息如果把配置值抄进去，它本身就成了泄露渠道——而这行字很可能出现在截图、issue 或日志里。

`web/src/lib/wagmi.ts` 里 `process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` 是**字面量**读取的。Next.js 只在构建时替换**字面量**的 `process.env.NEXT_PUBLIC_*` 访问；写成 `process.env[key]` 会在客户端拿到 `undefined`，表现为"配了但不生效"。

警告只在 `typeof window !== "undefined"` 时打印，因为服务端渲染期间打印一次配置警告会出现在构建日志里，让每次部署都看起来有一个问题。

**三、`manifest.json` 里不放图标。**

一个 `display: "browser"` 的 manifest 加上不存在的图标路径，会让浏览器去请求 404。宁可先不加图标，也不要引用没有的文件——这与本项目对"引用不存在的东西"的一贯态度一致（ADR-0016：给形状，不给编出来的值）。

## Consequences

**这是一次需要如实记账的代价。**

`@walletconnect/ethereum-provider` 与 `@coinbase/wallet-sdk` 拉进来的传递依赖包括 `@reown/appkit`、`@reown/appkit-pay`、`@reown/appkit-scaffold-ui` 以及 `@solana/*` 一整套。也就是说：**为了在手机上投一票，这个前端现在打包了一个 Solana 的支持栈**，而本项目的任何一条链都不是 Solana。

这笔代价换到的是：手机浏览器上**可以**连接钱包了。在此之前那是完全不可能的。取舍是划算的，但"划算"不等于"没有代价"，而这棵树的大小、以及其中大部分与本项目无关这一事实，必须留在这里而不是留给下一个人去 `pnpm why` 里发现。

相关的安装摩擦也记在这里：`pnpm add` 因为 `@reown/appkit` 的 postinstall 未被批准而退出 1（`ERR_PNPM_IGNORED_BUILDS`），并且 pnpm 会往 `pnpm-workspace.yaml` 里写一行**字面量占位符** `'@reown/appkit': set this to true or false`。那一行会让 pnpm 在任何脚本执行**之前**就退出，因此 `pnpm test` 与 `pnpm typecheck` 都会失败——表现是"整个仓库坏了"，而不是"安装没装完"。

最终取值为 `false`，理由是那个 postinstall 是 `scripts/appkit-version-check.js`：一个纯诊断脚本，不写任何文件，并且在所有分支上以 0 退出。允许它执行没有任何收益，禁止它会跳过一段无用代码。

**未验证的部分：**真实手机上的 WalletConnect 握手从未被执行过。这条路径需要 project id、一个可从手机访问的部署地址，以及一台手机。目前的覆盖是 `resolveWalletConnect` / `walletConnectNotice` 的单元测试（`web/test/wallet-connectors.test.ts`）与"连接器在缺 id 时不被注册"的类型与构建结果。
