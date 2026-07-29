---
name: refactor-extraction
description: 当用户要求重构、提取函数、消除重复代码、改善结构时使用。触发词：重构、refactor、提取、抽取、消除重复、SRP。
version: 1.0.0
author: routedev
tags:
  - refactoring
  - clean-code
  - srp
when_to_use: 当用户要求重构、提取函数/方法、消除重复、拆分大函数、改善代码结构时使用。优先保留行为不变，小步推进。
argument-hint: "<target-file-or-function>"
---

# Skill: refactor-extraction

> **目标**：在不改变外部行为的前提下，改善代码内部结构
>
> **触发词**：重构、refactor、提取、抽取、消除重复、SRP

## 重构流程（强制）

1. **建立测试基线**：重构前确认现有测试全绿（无测试则先补）
2. **影响分析**：用 codebase MCP callers 找所有调用方
3. **小步推进**：每次只做一个抽取/重命名，立即跑测试
4. **行为保持**：只改内部结构，不改公开 API 签名
5. **最终验证**：`rtk err pnpm test` + `rtk err pnpm typecheck`

## 抽取函数 checklist

- [ ] 待抽取代码段无外部副作用（仅依赖入参和局部变量）
- [ ] 抽取后入参列表清晰（不超过 4 个，否则考虑参数对象）
- [ ] 函数名是动词短语，描述"做什么"而非"怎么做"
- [ ] 抽取后原函数行数减少 ≥30%
- [ ] 测试仍全绿

## 禁止

- 重构同时改行为（拆成两个 PR）
- 重构时删除测试（测试是行为契约）
- 一次性大重构（小步推进，每步可回滚）
- 引入抽象但只有一个调用方（YAGNI）

## 输出格式

```
[重构类型] 目标 — 原因
[影响范围] 调用方数量 — 是否需要同步改
[验证] typecheck OK / test X passed / 0 failed
```
