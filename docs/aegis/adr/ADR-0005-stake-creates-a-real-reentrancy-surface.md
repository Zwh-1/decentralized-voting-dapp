# ADR-0005 - 以质押/退还构造真实重入面，并明确否认它是女巫防护

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- M-3 四组对照矩阵全部通过（VulnerableRefund 被攻破，CEIOnly/GuardOnly/生产合约攻不破）；M-1 加入质押后覆盖率仍为 100.00%；M-5 refund 中位 gas 37920

## Context

若合约中没有任何外部调用，nonReentrant 就是没有攻击面的守卫，能通过所有测试却什么也没证明。装饰性的安全措施比没有更糟，因为它会伪装成证据。原方案还把质押描述为防女巫攻击，这是错的：可全额退回的质押不构成经济门槛，攻击者多投一票的成本只是 gas。

## Decision

引入 0.001 ETH 质押与退还，目的明确限定为制造一次真实外部调用（call{value:} 向投票者退款）。主防御是 CEI（外部调用前置零 stakeOf），nonReentrant 仅作纵深防御。在 README 与合约注释中明确否认质押是女巫防护，真正的准入门槛是管理员白名单且白名单是中心化的。

## Alternatives Considered

- 不引入质押，只写独立的重入演示合约：重入会变成与主合约无关的玩具，主合约自身仍无攻击面。
- 保留质押但继续宣称防女巫：技术上错误，且是面试中的致命破绽。
- 改简历表述而不做对照测试：放弃了本项目最有说服力的一段证据，即同一漏洞在四种防御组合下的可观测差异。

## Consequences

- 正面：主合约具备真实攻击面；四组对照让“CEI 是否单独足够”变得可证明，其中 VulnerableRefund 是负向对照。代价：引入资金锁定，需要 sweepUnclaimed 与 30 天宽限期，而 sweepUnclaimed 本身是额外的管理员特权点；质押无法防止多投，抗女巫性完全依赖白名单。

## Compatibility Boundary

质押额为不可变常量 STAKE，改变它需要重新部署；退款宽限期 REFUND_GRACE_PERIOD 同理。ABI 含 refund 与 sweepUnclaimed。

## Retirement Impact

若将来移除质押，需同时删除 refund、sweepUnclaimed、REFUND_GRACE_PERIOD 与那组对照测试夹具，并重新评估重入面是否仍然存在。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §5.6 与 §10 已修正“质押防女巫”的错误主张并登记 sweepUnclaimed 的权限代价，本 ADR 记录取舍理由。

## Evidence References

- contracts/contracts/Voting.sol
- contracts/contracts/test/VulnerableRefund.sol

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
