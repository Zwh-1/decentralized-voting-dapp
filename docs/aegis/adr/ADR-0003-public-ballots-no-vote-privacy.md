# ADR-0003 - 明票上链，并在 README 与 UI 中主动声明没有投票隐私

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- README「设计取舍与已知局限」第 1 条；web/src/components/Ballot.tsx 的常驻隐私提示；Design Spec §11 非目标 1

## Context

“投票”一词天然携带隐私预期：真实选举中选票保密是防止胁迫与报复的核心机制。不声明这一点，读者会默认它具有其并不具备的性质，这比明说没有隐私更糟。真正的隐私投票都需要额外的密码学机制或信任假设。

## Decision

采用公开明票：投票内容与是否投过票都写在链上并永久可查。在 README 顶部、指标节与 UI 中主动且显著地声明，并解释后果。

## Alternatives Considered

- commit-reveal 两阶段：只解决截止前泄露，揭示期后仍公开，且引入“不揭示”的惩罚设计。
- Semaphore 或零知识匿名投票：需要电路编译、证明生成与可信设置，工作量超过本项目全部链上部分。
- MACI 抗串谋：需要协调者与密钥服务器，中心化假设更难解释，且远超排期。

## Consequences

- 正面：合约与前端保持简单，复杂度预算花在可测量的一致性上。代价：本项目不能用于任何需要隐私的投票场景，README 已明说不要用于真实选举；无法给出隐私投票的实现细节，只能给出方案名与权衡。

## Compatibility Boundary

明票是 ABI 层面的既定事实，不构成兼容负担；若将来改为隐私投票，属于语义重设计而非兼容扩展。

## Retirement Impact

无遗留路径需要退役；这是从未实施过的备选方案。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §5.1 与 §10 已将明票与隐私非目标登记为当前事实，本 ADR 只补充理由。

## Evidence References

- README.md
- web/src/components/Ballot.tsx

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
