---
name: unit-test
description: 当需要为指定代码生成单元测试时使用，覆盖正常路径与边界条件
version: 1.0.0
author: anthropic
tags:
  - test
  - quality
---
## 用途

为指定代码生成单元测试，覆盖正常路径与边界条件。

## 工作流程

1. 读取目标代码文件
2. 分析导出接口与分支
3. 生成测试用例并写入 `__tests__/` 目录

## 工具

使用 `Read` 读取源码，使用 `Write` 写入测试文件。
