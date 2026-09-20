# ADR-0002 - 采用 Hardhat 3，而不是 Hardhat 2，并接受原生能力替代插件

Status: `recorded-from-work`
Date: `2026-09-20`

## Source Evidence

- 实测 solidity-coverage 与 hardhat-gas-reporter 的 peer 为 ^2.x 不可用；原生 hardhat test --coverage 报 Voting.sol 行/语句 100.00%；原生 --gas-stats 产出完整 gas 表

## Context

Hardhat 3 是完全重写版（ESM、defineConfig、新插件 API），绝大多数既有教程与模型记忆基于 Hardhat 2。选择它等于接受大部分问题没有现成答案；同时项目明确拒绝 Foundry，因此没有换工具链的退路。

## Decision

使用 Hardhat 3.17.0。遇到插件不可用时改用原生能力，而不是降级到 Hardhat 2。

## Alternatives Considered

- Hardhat 2.29.1 + solidity-coverage + hardhat-gas-reporter：生态成熟，但插件 peer 不匹配，且从一开始就落后一个主线版本。
- Foundry：用户明确表示没用过，学习成本会挤占排期。
- 裸 solc + 自写测试脚手架：放弃部署、网络管理与 viem 集成，工作量反而更大。

## Consequences

- 正面：起点即最新主线，ESM 与 TS 配置一致。代价：solidity-coverage 与 gas-reporter 不可用；原生覆盖率只有行与语句覆盖率，没有分支覆盖率，原规格的“分支覆盖率≥95%”是无法测量的目标；Hardhat 3.17.0 的 invariant 运行器不可用（见 ADR-0007）。

## Compatibility Boundary

测试网与本地使用同源码、同 ABI、同 solc 0.8.37 与同优化器设置，因此部署产物可互换。

## Retirement Impact

若将来插件生态补齐，应优先切回官方覆盖率与 gas 插件；当前原生命令是过渡方案，需保留替换路径。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-09-20-initial-baseline.md
- Action: cite unchanged
- Reason: 基线 §10 修订表已登记 Hardhat 3 与插件缺口这一事实；本 ADR 记录的是选择理由，不改变基线事实。

## Evidence References

- contracts/hardhat.config.ts
- contracts/gas-stats.json

## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
