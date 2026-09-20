# 贡献指南

## 先读这一节

这是一个**教学与作品集项目**，不是生产系统。它接受的贡献有一个硬前提：**不破坏下面的不变量**。这五条来自基线 §5.2，在两层重构后逐条重新验证通过（见 `docs/aegis/specs/` 的 M-1 … M-6b）。

| #   | 不变量                             | 为什么它是硬约束                                                         |
| --- | ---------------------------------- | ------------------------------------------------------------------------ |
| 1   | 链上是唯一事实源，链下只做只读投影 | 一旦允许链下写链，"链上成功、写库失败"的补偿问题就会重新出现（ADR-0001） |
| 2   | 后端永不持有私钥                   | 进程内出现签名能力，就去中心化失败                                       |
| 3   | 事件消费幂等                       | 同一事件重复投递不得改变最终状态，否则重放会翻倍计票                     |
| 4   | 一人一票                           | 白名单地址只能成功投票一次                                               |
| 5   | 事件与其游标在同一事务内提交       | 不允许"事件已写、游标未动"，也不允许反之                                 |

如果一项改动需要违反其中之一，那它需要先改 ADR，而不是先改代码。

## 环境

- Node.js **>= 22.13.0**（Hardhat 3 要求）
- pnpm **11**
- MySQL 8 —— **可选**。不配 `DATABASE_URL` 时应用仍可完整运行，所有读取回退为直接读链

## 常用命令

```bash
pnpm install

pnpm test              # 全部测试：合约 49 + 索引器 36
pnpm run test:contracts
pnpm run test:indexer
pnpm coverage          # 行覆盖率 / 语句覆盖率
pnpm gas               # gas 快照写入 contracts/gas-stats.json
pnpm run typecheck
pnpm run format        # 提交前请运行；CI 会检查
```

## 不要手改生成物

`web/src/lib/contracts/` 下的 `voting-abi.ts`、`deployments.ts`、`index.ts` 由下述命令生成：

```bash
pnpm export-abi
```

它们已被登记进 `.prettierignore`，并且 CI 有一条 `abi-drift` 流水线专门守护该目录——手改会在 CI 上直接失败。要改 ABI，改合约，然后重新生成。

## 测试期望

- 新增行为需要有对应测试。合约改动必须同时跑 `pnpm test:contracts`。
- 覆盖率不得下降。当前 `Voting.sol` 为 100.00% / 100.00%。
- 测试夹具（`contracts/contracts/test/` 下的攻击合约与脆弱变体）由 `coverage.skipFiles` 排除在覆盖率分母之外，**绝不允许进入部署路径**。

## 关于"缺失"的不变量测试

`contracts/hardhat.config.ts` 中**刻意没有** `invariant` 配置块，并附有注释说明原因。Hardhat 3.17.0 的不变量运行器会求值 `invariant_*` 却从不调用目标合约，因此任何依赖 ghost 计数器的不变量都会以零计数通过。

1000 轮的 M-4 证据由 `contracts/contracts/VotingProperties.t.sol` 提供。**请不要"修复"这个看似的遗漏**——那会让一份空转的测试伪装成证据。完整排查过程见 `docs/aegis/adr/ADR-0007-property-tests-instead-of-the-invariant-runner.md`。

## 提交前

```bash
pnpm test
pnpm run typecheck
pnpm run format:check
pnpm run build          # 合约 + ABI 导出 + Next 生产构建
```

## 架构决策

持久性的架构决策记录在 `docs/aegis/adr/`。改动架构面（事实源、包边界、ABI、依赖方向、兼容或退役策略）时请一并新增或修订 ADR，而不是只在提交信息里说明。
