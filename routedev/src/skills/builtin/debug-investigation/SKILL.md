---
name: debug-investigation
description: 当用户报告 bug 或现象异常需要排查时使用。触发词：调试、debug、排查、为什么挂了、报错、栈追踪、stack trace。
version: 1.0.0
author: routedev
tags:
  - debugging
  - investigation
  - root-cause
when_to_use: 当用户报告 bug、现象异常、报错、需要定位根因时使用。优先压缩失败信号再追符号，禁止盲读大文件。
argument-hint: "<error-message-or-symptom>"
---

# Skill: debug-investigation

> **目标**：从报错信号出发，逐步缩小范围到具体根因
>
> **触发词**：调试、debug、排查、为什么挂了、报错、stack trace

## 调查流程（强制）

1. **压缩失败信号**：用 `rtk err <原命令>` 拿到压缩后的失败堆栈
2. **从报错符号定位定义**：用 codebase MCP 找符号、调用方
3. **精读关键实现**：只读 MCP 返回的 file:line 片段，不扫全文件
4. **最小复现**：构造最小调用路径触发同一错误
5. **修复后再次验证**：`rtk err <命令>` 确认通过

## 优先级顺序

| 步骤 | 工具 | 用途 |
|------|------|------|
| 1 | `rtk err <cmd>` | 压缩失败信号 |
| 2 | codebase MCP search_graph | 从报错符号找定义 |
| 3 | codebase MCP callers | 找谁调用出错位置 |
| 4 | Read file:line | 精读关键片段 |
| 5 | `rtk err <cmd>` | 修复后验证 |

## 禁止

- 把整个 vitest/tsc/pnpm 日志粘进上下文（用 `rtk err` 压缩）
- 在未定位符号前盲读整个文件
- 修复后不验证就提交

## 输出格式

```
根因：[一句话]
证据：[报错符号 + 调用链]
修复：[改动点 + 行号]
验证：[命令 + 结果]
```
