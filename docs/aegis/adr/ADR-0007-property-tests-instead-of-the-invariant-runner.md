# ADR-0007 - 用确定性属性测试替代 Hardhat 3 不可用的 invariant 运行器

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 六步逐条排除实验记录于 Design Spec §14 校正 7；@nomicfoundation/edr@0.20.0 的 InvariantConfigArgs 无 target 字段；VotingProperties.t.sol 1000 轮 + 256 轮 fuzz 通过，注入变异后以 votes can never exceed the whitelist size 失败

## Context

M-4 要求随机 1000 次投票后反例 0 个，默认实现方式是 Hardhat 的 invariant_* 测试。实施时发现 Hardhat 3.17.0 的不变量运行器会求值 invariant_* 但从不调用任何目标合约，因此读取 ghost 计数器的不变量会以零计数通过，“1000 轮 0 反例”会是一份完全空转的假证据。

## Decision

删除 invariant 文件与 handler，改用 VotingProperties.t.sol 中的确定性属性测试：用 keccak256(seed, round) 驱动 1000 轮投票（40 名选民 × 3 名候选人，seed 固定 0xC0FFEE），每轮之后重新断言全部不变量，并额外断言这 1000 轮确实产生了工作（accepted + rejected == ROUNDS），使空转在结构上不可能通过。保留 256 轮 fuzz 作为补充。

## Alternatives Considered

- 保留 invariant_* 因为它至少报告 runs: 1000：静默空转的测试比没有测试更危险，它会伪装成证据。
- 降级到 Hardhat 2 以获得可用的 invariant 运行器：与 ADR-0002 冲突，且为一个工具缺陷放弃整个主线版本不划算。
- 只在文档标注不变量测试不可靠但不替换：会留下 M-4 无证据的指标缺口。

## Consequences

- 正面：M-4 有真实证据且该证据经过负向对照（注入同一变异后属性测试失败）；固定 seed 使失败可精确定位到轮次。代价：1000 轮固定序列无法像真正的 invariant 测试那样自由探索任意调用顺序，因此不能完全等价替代，这是已知的方法学折衷。

## Compatibility Boundary

hardhat.config.ts 中刻意不设 invariant 配置块并附注释说明原因，防止后来者误以为遗漏而“修复”成空转测试。

## Retirement Impact

若 Hardhat 修复目标调用，应补回真正的 invariant 测试，并保留本属性测试作为确定性回归。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §10 已登记 M-4 方法的更正与本 ADR 所述的运行器缺陷，本 ADR 记录决策与其负向对照证据。

## Evidence References

- contracts/contracts/VotingProperties.t.sol
- contracts/hardhat.config.ts

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
