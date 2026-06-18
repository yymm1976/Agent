# Phase 26 — 技术债务清零与架构加固

> **Phase 类型：** 技术债务清理（Technical Debt Resolution）
> **前置依赖：** Phase 24 + Phase 25 完成（1062 测试通过，v1.2.0）
> **目标版本：** v1.3.0
> **核心目标：** 消除所有已知安全漏洞、架构不一致、性能隐患和代码质量问题，使代码库达到商业交付的工程标准

---

## 背景

RouteDev 经过 25 个 Phase 的迭代，功能已基本完整（1062 测试 / 82 文件 / v1.2.0）。但全面审计发现了以下技术债务：

- **2 个中等安全风险**（搜索工具路径遍历、企业微信凭据暴露）
- **4 个架构不一致**（help 命令类型绕过、/permissions 引擎隔离、硬编码提示词、仅 1 个自定义错误类）
- **3 个性能隐患**（同步 I/O 在热路径、DurableExecutor 列表阻塞、TokenTracker 同步写入）
- **6 个测试覆盖缺口**（watcher、paths、schema 等无测试）
- **5 个遗留 CONCERN**（从 Phase 2-4 延续至今未关闭）
- **3 个文档/规范缺口**（剩余提示词模板五块结构、EXECUTION_STATUS 未同步、AGENTS.md 需更新）

本 Phase 不做新功能，只还债。

---

## 接口对齐观察表

| 接口 / 类 | 当前问题 | 文件位置 | 本 Phase 修复方式 |
|---|---|---|---|
| `SecurityChecker.checkFilePath()` | 搜索工具未调用，路径遍历漏洞 | `src/tools/security.ts` | Task 1 为搜索工具添加路径校验 |
| `CommandBridge` | `CommandRegistry` 不在 ServiceContext 中 | `src/cli/service-context.ts` | Task 3 添加到 ServiceContext |
| `/permissions` 命令 | 创建新引擎实例，不反映运行时规则 | `src/cli/commands/permissions.ts` | Task 4 改为读取运行实例 |
| `TokenTracker.persist()` | `writeFileSync` 同步写入 | `src/router/tracker.ts` | Task 5 改为异步写入 |
| `DurableExecutor.listRecoverable()` | `readFileSync` + `readdirSync` 循环阻塞 | `src/agent/durable-executor.ts` | Task 5 改为异步批量读取 |
| `agent/prompts.ts` | 硬编码系统提示词，未走 PromptTemplateManager | `src/agent/prompts.ts` | Task 6 迁移到模板管理器 |
| `wechat-work.ts` | `corpSecret` 拼入 URL query string | `src/channels/adapters/wechat-work.ts` | Task 2 凭据脱敏 |

---

## Task 1：搜索工具路径遍历修复（安全 — 中等）

**目标**：修复 `code-search.ts` 和 `file-search.ts` 中缺失的路径边界检查。

### 问题

`file-read.ts` 和 `file-write.ts` 通过 `SecurityChecker.checkFilePath()` 验证路径在 `allowedDirs` 内。但 `code-search.ts` 和 `file-search.ts` 仅将 `args.path` 相对于 `context.workingDirectory` 解析，未调用 `SecurityChecker`。攻击者可通过 `../../etc` 搜索项目目录之外的文件。

### 修复

在 `code-search.ts` 和 `file-search.ts` 的入口添加路径校验：

```typescript
const resolvedPath = path.resolve(context.workingDirectory, args.path as string);
const securityCheck = context.securityChecker.checkFilePath(resolvedPath);
if (!securityCheck.allowed) {
  return { success: false, error: `搜索路径超出项目边界: ${args.path}` };
}
```

同时检查 `web-search.ts` 是否有类似问题（当前无文件路径操作，应无风险）。

### 验收

- 搜索 `../../etc` 返回"路径超出项目边界"错误
- 正常搜索不受影响
- 新增 ≥ 4 个测试（两个工具各 2 个：正常路径 + 越界路径）

---

## Task 2：企业微信凭据脱敏（安全 — 中等）

**目标**：消除 `corpSecret` 在 URL query string 中的暴露风险。

### 问题

`wechat-work.ts:184` 将 `corpSecret` 拼入获取 access_token 的 URL：
```
https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=X&corpsecret=Y
```
该 URL 可能出现在：HTTP 代理日志、CDN 日志、网络监控工具中。

### 修复

1. 在发起请求前，日志记录时脱敏 URL（替换 corpSecret 为 `***`）
2. 确认 HTTP client 不将完整 URL 写入任何日志或错误消息
3. 如果企业微信 API 支持 POST body 传参，改用 POST（当前 API 仅支持 GET query）

### 验收

- 搜索代码库，确认 `corpSecret` 不出现在任何日志输出路径
- 添加集成测试：模拟 access_token 请求，验证日志中不含明文 secret

---

## Task 3：CommandRegistry 纳入 ServiceContext（架构一致性）

**目标**：消除 `help` 命令的 `(ctx as any).__commandRegistry` 类型绕过。

### 问题

`help.ts:12` 使用 `(ctx as any).__commandRegistry` 访问命令注册表，绕过了 TypeScript 类型系统。如果属性名变更或注册表未附加，命令静默失败。

### 修复

1. 在 `ServiceContext` 接口中新增 `commandRegistry: CommandRegistry` 字段（29→30 字段）
2. 在 `createAppDependencies()` 或 `createServiceContext()` 中传入 `CommandRegistry` 实例
3. `help.ts` 改为 `ctx.commandRegistry`，删除 `as any`
4. 全局搜索其他 `as any` 用法确认无遗漏

### 验收

- `src/` 中零 `as any` 用法
- `/help` 命令正常工作
- ServiceContext 字段数更新为 30
- 新增 1 个测试：help 命令使用 ServiceContext.commandRegistry

---

## Task 4：/permissions 命令修复（架构一致性）

**目标**：让 `/permissions` 显示运行时实际规则，而非默认规则快照。

### 问题

`permissions.ts` 调用 `createDefaultEngine()` 创建新的默认引擎，而非访问运行中的 `PermissionEngine` 实例。运行时添加的自定义规则在输出中不可见。

### 修复

1. 将运行中的 `PermissionEngine` 实例通过 `ServiceContext` 传入命令处理器
2. `permissions.ts` 改为读取 `ctx.permissionEngine.listRules()`
3. 如果 `ServiceContext` 尚无 `permissionEngine` 字段，新增该字段

### 验收

- 运行时添加自定义 deny 规则后，`/permissions` 输出包含该规则
- 新增 1 个测试：/permissions 反映运行时规则

---

## Task 5：同步 I/O 异步化（性能）

**目标**：消除热路径上的同步文件操作，避免事件循环阻塞。

### 5.1 TokenTracker.persist() 异步化

`tracker.ts` 的 `persist()` 使用 `writeFileSync`，每次 token 更新都阻塞事件循环。

**修复**：改为 `fs.promises.writeFile` + 防抖（debounce 500ms），确保高频更新不频繁写盘。保留 `persistSync()` 仅用于进程退出前的最终写入（通过 `process.on('exit')` 调用）。

### 5.2 DurableExecutor.listRecoverable() 异步化

`durable-executor.ts` 的 `listRecoverable()` 在循环中使用 `readdirSync` + `statSync` + `readFileSync`，读取所有 session 目录。

**修复**：改为 `fs.promises.readdir` + `fs.promises.stat` + `fs.promises.readFile`，使用 `Promise.all` 并行读取。`getSnapshot()` 同步版保留（单次读取，可接受），新增 `getSnapshotAsync()` 异步版。

### 5.3 config/loader.ts 保持同步

`loader.ts` 的 `readFileSync` 仅在启动时调用一次，**保持同步**（可接受）。

### 验收

- `TokenTracker.persist()` 为异步，含防抖
- `DurableExecutor.listRecoverable()` 为异步并行
- 无 `readFileSync`/`writeFileSync` 在非启动路径中
- 新增 ≥ 4 个测试（persist 防抖、异步 listRecoverable、并发安全）

---

## Task 6：硬编码提示词迁移到 PromptTemplateManager（架构一致性）

**目标**：让 `agent/prompts.ts` 中的系统提示词通过 `PromptTemplateManager` 加载，而非硬编码字符串常量。

### 问题

`src/agent/prompts.ts` 包含硬编码的系统提示词字符串。Phase 16 已实现 `PromptTemplateManager`（支持优先级：项目覆盖 > 用户自定义 > 内置默认），但 `agent/prompts.ts` 未使用它。

### 修复

1. 将 `agent/prompts.ts` 中的默认提示词注册为 `PromptTemplateManager` 的内置模板
2. `loop.ts` 和其他消费者改为从 `PromptTemplateManager` 获取提示词
3. `agent/prompts.ts` 改为导出模板 ID 常量（而非字符串内容）
4. 确保用户可通过项目配置文件覆盖任何内置提示词

### 验收

- `agent/prompts.ts` 不含硬编码提示词字符串
- 所有提示词通过 `PromptTemplateManager.get()` 获取
- 项目覆盖机制工作正常
- 新增 ≥ 3 个测试（默认模板加载、项目覆盖、模板 ID 常量）

---

## Task 7：自定义错误类体系（代码质量）

**目标**：从仅 1 个 `LLMError` 扩展为完整的错误类层次，替代当前的字符串模式匹配错误分类。

### 设计

```typescript
// src/utils/errors.ts — 新建

class RouteDevError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

class ToolExecutionError extends RouteDevError {
  constructor(toolName: string, message: string) {
    super(message, 'TOOL_EXECUTION_ERROR');
    this.toolName = toolName;
  }
  toolName: string;
}

class PermissionDeniedError extends RouteDevError {
  constructor(rule: string, message: string) {
    super(message, 'PERMISSION_DENIED');
    this.rule = rule;
  }
  rule: string;
}

class ConfigValidationError extends RouteDevError {
  constructor(field: string, message: string) {
    super(message, 'CONFIG_VALIDATION_ERROR');
    this.field = field;
  }
  field: string;
}

class SecurityViolationError extends RouteDevError {
  constructor(message: string) {
    super(message, 'SECURITY_VIOLATION');
  }
}
```

### 修复范围

1. `executor.ts` 抛出 `ToolExecutionError` 而非 plain `Error`
2. `permission-engine.ts` 的 deny 路径抛出 `PermissionDeniedError`
3. `security.ts` 抛出 `SecurityViolationError`
4. `config/schema.ts` 的 Zod 验证失败转换为 `ConfigValidationError`
5. `error-messages.ts` 的 `humanizeError()` 优先按错误类型（`instanceof`）分类，字符串匹配作为后备

### 验收

- 5 个自定义错误类存在且被使用
- `error-messages.ts` 使用 `instanceof` 优先分类
- 现有测试不受影响（向后兼容）
- 新增 ≥ 5 个测试（每个错误类 1 个）

---

## Task 8：剩余提示词模板五块结构改造（规范完成）

**目标**：将 Phase 24/25 遗留的 5 个未转换模板改为五块结构。

### 待转换模板

1. `checkpoint.writer` — CheckpointWriter 提示词
2. `goal.parser` — GoalParser 提示词
3. `init.analyzer` — /init 项目分析提示词
4. `vision.analyzer` — 视觉分析提示词
5. `dream.consolidator` — 梦境整合提示词

### 修复

对每个模板添加五块结构标记（Block 1-4 必需，Block 5 可选），保持原有内容不变。改造后 `PromptTemplateManager.validateAll()` 零 warn。

### 验收

- `validateAll()` 零 warn
- 所有 12 个内置模板符合五块结构
- 新增 1 个测试：validateAll() 全通过

---

## Task 9：测试覆盖补全 + CONCERN 关闭

**目标**：补齐无测试模块的覆盖，正式关闭所有遗留 CONCERN。

### 新增测试

| 模块 | 测试文件 | 测试数 |
|------|---------|-------|
| `config/watcher.ts` | `tests/config/watcher.test.ts` | ≥ 3 |
| `config/schema.ts` | `tests/config/schema.test.ts` | ≥ 3 |
| `utils/paths.ts` | `tests/utils/paths.test.ts` | ≥ 2 |
| `agent/prompts.ts` | `tests/agent/prompts.test.ts` | ≥ 2 |

### CONCERN 关闭清单

| # | CONCERN | 关闭方式 |
|---|---------|---------|
| 1 | App.tsx 非流式调用 | 确认为设计选择：部分命令路径无需流式。标记为 CLOSED-WONTFIX |
| 2 | ModelConfig 字段名 provider vs providerId | Phase 0c 已改为配置优先路由，字段名不再关键。标记为 CLOSED-RESOLVED |
| 3 | Anthropic SDK 版本差异 | 确认功能正常，版本跟踪交由依赖更新流程。标记为 CLOSED-ACCEPTED |
| 4 | TokenTracker 无磁盘持久化 | Task 5 已改为异步持久化。标记为 CLOSED-RESOLVED |
| 5 | Ink 7 + React 19 兼容性 | 确认运行正常，无实际问题。标记为 CLOSED-ACCEPTED |

### 验收

- 4 个新测试文件，≥ 10 个新测试
- EXECUTION_STATUS.md CONCERN 列表全部标记为 CLOSED
- 全量测试通过

---

## Task 10：文档同步与 AGENTS.md 更新

**目标**：确保所有项目文档反映 Phase 26 的改动。

### 更新范围

1. **AGENTS.md**：更新陷阱警告（新增 ServiceContext 30 字段、错误类体系、搜索路径校验）
2. **CODEMAP.md**：新增 `src/utils/errors.ts` 条目，更新 `src/tools/security.ts` 描述
3. **README.md**：更新版本号到 v1.3.0，更新功能列表
4. **EXECUTION_STATUS.md**：同步 Phase 24/25 状态为 DONE，新增 Phase 26 条目

### 验收

- 文档与实际代码一致
- 无过期描述

---

## 执行顺序

```
Task 1 (路径遍历修复) ── 安全优先
Task 2 (凭据脱敏) ──── 安全优先
  ↓
Task 3 (CommandRegistry) ─┐
Task 4 (/permissions) ────┤── 架构修复，可并行
Task 5 (异步 I/O) ───────┤
Task 6 (提示词迁移) ──────┤
Task 7 (错误类体系) ──────┘
  ↓
Task 8 (五块结构) ─────── 规范完成
Task 9 (测试 + CONCERN) ── 覆盖补全
  ↓
Task 10 (文档同步) ────── 最后做，反映所有改动
```

---

## 验收标准

| # | 验收标准 | 验证方式 |
|---|---------|---------|
| 1 | 搜索工具路径遍历漏洞已修复 | 攻击测试：搜索 ../../etc 被拒绝 |
| 2 | 企业微信凭据不出现在日志中 | grep 日志文件确认无明文 secret |
| 3 | ServiceContext 零 `as any` | `grep -r "as any" src/` 零结果 |
| 4 | /permissions 反映运行时规则 | 添加自定义规则后验证输出 |
| 5 | 热路径无同步 I/O | grep readFileSync/writeFileSync 仅在 loader.ts |
| 6 | 所有提示词通过 PromptTemplateManager | agent/prompts.ts 无硬编码字符串 |
| 7 | 5 个自定义错误类被使用 | instanceof 检查在 error-messages.ts |
| 8 | validateAll() 零 warn | 运行验证 |
| 9 | 全量测试通过 | `pnpm vitest run` |
| 10 | 构建通过 | `pnpm build && pnpm typecheck` |
| 11 | 新增测试 ≥ 30 个 | 测试计数 |
| 12 | 所有 CONCERN 已关闭 | EXECUTION_STATUS.md 检查 |
| 13 | 文档与代码一致 | 人工审查 |

---

## 对下一阶段的提醒

1. **DurableExecutor 运行时集成**：当前模块已创建但未接入 App.tsx 主运行循环，Phase 27 需接入
2. **RouterPlugin 集成**：ModelRouter.route() 尚未检查 RouterPlugin
3. **ThemePlugin 渲染**：StatusBar/ChatView 尚未读取 ThemePlugin 配置
4. **插件状态持久化**：enable/disable 状态仅内存，重启丢失
5. **notes.md 模块**：蓝图要求的自由格式草稿本（Agent 唯一写通道），当前未实现
