# 安全策略

## 范围

这是一个**教学与作品集项目**，用于演示链上状态与链下投影之间的一致性。它**不应**被用于任何真实选举或任何有实际利益的投票场景。README 已就此作出声明。

尽管如此，合约与索引器中若存在**真实缺陷**，欢迎报告。

## 这些不是漏洞，是已声明的设计取舍

以下各项都是经过权衡后有意接受的，并已在 ADR 或 README 中记录。请**不要**将它们作为漏洞报告。

| 项                                        | 说明                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| 投票内容与投票行为公开可查                | 明票是刻意的选择，见 [ADR-0003](docs/aegis/adr/ADR-0003-public-ballots-no-vote-privacy.md) |
| 管理员可增删白名单，白名单是中心化的      | 白名单是**唯一**的准入门槛。质押不构成经济门槛，不防女巫（ADR-0005）                       |
| `sweepUnclaimed()` 允许管理员取走逾期押金 | 已承认的额外管理员特权点。宽限期 `REFUND_GRACE_PERIOD = 30 days`                           |
| 候选人元数据依赖公共 IPFS 网关            | 网关可整体替换；元数据不可用是正常的降级状态，不是故障（ADR-0004）                         |
| 索引必然落后链上若干区块                  | `/api/health` 显式暴露 `lagBlocks`，不假装实时                                             |

## 已经被测试覆盖的攻击面

报告前请先确认不是重复项：

- **重入**：四组对照矩阵已覆盖——`VulnerableRefund`（无 CEI 无守卫）**可被攻破**，`CEIOnlyRefund`、`GuardOnlyRefund` 与生产合约均不可。主防御是 CEI，`nonReentrant` 仅为纵深防御。
- **`refund` 与 `sweepUnclaimed` 的守卫分支**：共 12 条测试（`refund` 5 条、`sweepUnclaimed` 7 条），覆盖宽限期前后、重复领取、非投票者、非 owner、零地址、无可领取金额、接收方拒收 ETH 等路径。
- **不变量**：1000 轮确定性属性测试（固定 seed `0xC0FFEE`）+ 256 轮 fuzz，均经负向对照验证（注入变异后测试会失败）。
- **索引幂等性**：游标归零强制重放，实测 404 行全部命中重复、插入 0 行。
- **配置泄露到浏览器**：五条 Route Handler、`/api/health` 的 `indexError` 与 SSR 失败横幅共用 `web/src/lib/failure.ts` 的 `describeFailure()`，失败文案里不含 RPC 端点、apiKey、请求体或库版本（单测对真实 viem 错误断言了这一点），原始错误只写服务端日志。见 [ADR-0020](docs/aegis/adr/ADR-0020-failure-reports-give-the-shape-never-the-environment.md)。

当前 `Voting.sol` 行覆盖率与语句覆盖率均为 100.00%。

## 如何报告

请通过 GitHub Security Advisory（仓库的 Security 标签页 → Report a vulnerability）私下报告，或在无法使用时开一个标记为 `security` 的 issue。

报告请包含：

1. 受影响的文件与函数；
2. 可复现的最小步骤，最好是能加入 `contracts/contracts/test/` 的测试或攻击合约；
3. 实际影响，以及攻击者需要具备的前提（例如是否必须是白名单地址或合约 owner）。

**请不要**在公开 issue 中附带可直接利用的完整攻击脚本。

## 部署状态

合约**尚未**部署到任何公共网络。仓库中的 `contracts/deployments/31337.json` 只是本地 `hardhat node` 的记录。任何真实的 Sepolia 部署都需要自备凭证，见 README 的「Sepolia 部署与验证」一节。
