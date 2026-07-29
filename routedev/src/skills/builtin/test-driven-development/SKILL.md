---
name: test-driven-development
description: 当用户要求实现新功能或修 bug 前先写测试时使用。触发词：TDD、测试驱动、先写测试、red-green-refactor。
version: 1.0.0
author: routedev
tags:
  - testing
  - tdd
  - quality
when_to_use: 当用户要求 TDD 流程、先写测试再实现、或在添加功能前补测试时使用。严格遵循 red-green-refactor 循环。
argument-hint: "<feature-description>"
---

# Skill: test-driven-development

> **目标**：用 red-green-refactor 循环驱动功能实现，保证每行实现都有测试覆盖
>
> **触发词**：TDD、测试驱动、先写测试、red-green-refactor

## TDD 循环（强制）

### Red：先写失败测试

1. 用 codebase MCP 定位目标模块与调用链
2. 写一个最小测试，描述期望行为（尚未实现）
3. 跑 `rtk err pnpm test`，确认测试失败（red）
4. 失败原因必须是"功能未实现"，而非编译错误或语法错误

### Green：最小实现

1. 只写让测试通过的最少代码
2. 不做未来扩展、不加额外抽象
3. 跑 `rtk err pnpm test`，确认测试通过（green）
4. 如有多个测试失败，一次只修一个

### Refactor：重构

1. 测试全部通过后才能重构
2. 每次小步重构后立即跑 `rtk err pnpm test`
3. 重构过程中测试必须始终绿色

## 禁止

- 跳过 Red 阶段直接写实现
- 一次写多个测试再一起修（违反最小步进）
- 重构时同时改测试（测试是契约，不能动）
- 用 `console.log` 调试代替断言

## 输出格式

每轮循环结束输出：
```
[Red] 测试名 — 期望行为 — 失败原因
[Green] 实现位置 — 通过的测试数
[Refactor] 改动点 — 测试是否仍绿
```
