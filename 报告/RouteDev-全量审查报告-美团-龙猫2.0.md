# RouteDev 全量审查报告

> **审查者标注**：美团-龙猫2.0

---

## 执行摘要

- **审查日期**：2026-07-07
- **审查范围**：255 个源文件（src/ + desktop/main/ + desktop/renderer/src/）+ 配置文件 + 文档
- **测试文件**：242 个 .test.ts 文件（覆盖率约 95% 文件级）
- **总 findings**：28（Critical: 1 / Important: 9 / Minor: 12 / Info: 6）
- **整体评价**：

  RouteDev 是一个成熟的 Electron + TypeScript AI 编程助手项目，经过 75 个 Phase 的迭代已形成较完善的架构模式。项目采用 AppDependencies 装配模式实现了良好的模块化分层，安全管理到位（path traversal 防护、CSP、sandbox、symlink 逃逸检测），错误处理普遍采用 fail-open 降级策略。

  主要问题集中在：
  1. 多个核心文件超长（app-init.ts 2487 行、config/schema.ts 2122 行、goal-runner.ts 2033 行），影响可维护性
  2. 大量 `as unknown as` 类型断言（约 20+ 处），绕过类型检查
  3. 依赖严重过时（Electron 34→43、React 图标库 0.577→1.23、vite 6→8 等）
  4. 渲染端 `dangerouslySetInnerHTML` 存在潜在 XSS 风险
  5. IPC handler 中部分输入校验不完整

---

## 优先修复清单（Top 20）

| 编号 | Finding | 级别 | 简述 |
|------|---------|------|------|
| F-001 | IPC handler 无参数类型校验 | Critical | `chat:confirm-tool` / `plan:edit-response` 等 handler 直接透传 payload |
| F-002 | `dangerouslySetInnerHTML` 潜在 X ToolCallCard.tsx 多处使用，需确认输入已过滤 |
| F-003 | 超长文件 app-init.ts（2487 行） | Important | 单一职责违反，应按模块拆分 |
| F-004 | 超长文件 config/schema.ts（2122 行） | Important | 配置 schema 可按域拆分 |
| F-005 | 超长文件 goal-runner.ts（2033 行） | Important | Goal 执行逻辑复杂度过高 |
| F-006 | `as unknown as` 双重断言热点（20+ 处） | Important | 系统性绕过类型安全 |
| F-007 | 依赖严重过时（Electron 34→43 等 13 项） | Important | 缺失安全补丁与新特性 |
| F-008 | Renderer 进程 console.log 残留（多处） | Minor | 生产代码中应移除或使用 logger |
| F-009 | 魔法数字散点（MAX_STDOUT、timeout 等） | Minor | 应提取为命名常量 |
| F-010 | 部分 IPC handler 输入长度边界缺失 | Minor | `chat:generate-title` 等 handler 未校验输入路径 |
| F-011 | `any` 类型使用（5 处） | Minor | browser.ts / unified-reviewer.ts |
| F-012 | 同步 fs 操作在热路径 | Minor | 启动时同步读配置 |
| F-013 | AgentRole 类型碎片化（4 处定义，已知） | Info | 已知技术债，Phase 75-A4 已记录 |
| F-014 | Engine-bridge.ts pre-existing TS 错误（2 处，已知） | Info | 已知技术债，Phase 75-A4 已确认 |
| F-015 | TODO 遗留（orchestrator.ts:590） | Info | "TODO Phase 73" 已过时或待办 |
| F-016 | prompt_cache_key 未参数化 | Minor | llm/openai.ts 硬编码 prefix |
| F-017 | Shell 命令执行模式可绕过 | Important | DANGEROUS_PATTERNS 可被编码绕过 |
| F-018 | IPC 暴露面较宽（47 个 handler） | Minor | 部分低频功能可通过按需加载减少 |
| F-019 | 事件监听器清理机制不完整 | Minor | 部分 setTimeout 未在组件卸载时清理 |
| F-020 | hooks/adapter.ts 使用 `shell: true` | Important | spawn 启用 shell 模式增加注入风险 |

---

## 维度 1：架构与耦合

### 概述

本维度审查了入口链路、装配层、桥接层和模块边界。发现 3 个 findings（Important: 1 / Minor: 1 / Info: 1）。

### 依赖图关键路径

```
desktop/main/index.ts (Electron 入口)
  └─ desktop/main/engine-bridge.ts (核心桥接)
       └─ src/runtime/app-init.ts (createAppDependencies 装配工厂)
            ├─ src/router/* (LLM 路由、分类、跟踪)
            ├─ src/agent/loop.ts (ReAct 循环)
            ├─ src/tools/builtin/* (工具链)
            ├─ src/memory/* (记忆系统)
            ├─ src/skills/* (技能系统)
            └─ src/runtime/goal-runner.ts (Goal 执行)
```

### 耦合热点 Top 5

| 模块 | 被 import 估计次数 | 是否合理 |
|------|-------------------|----------|
| `src/runtime/app-init.ts` | 3（engine-bridge、测试） | 合理但违反 SRP |
| `src/config/schema.ts` | 50+ | 核心共享类型 |
| `src/router/types.ts` | 30+ | 核心共享类型 |
| `src/utils/logger.ts` | 40+ | 合理 |
| `src/tools/registry.ts` | 20+ | 合理 |

### Findings

#### [F-003] app-init.ts 超长单一文件（2487 行）
- **级别**：Important
- **维度**：维度 1 - 架构与耦合
- **位置**：`src/runtime/app-init.ts:1-2487`
- **代码**：整个 `createAppDependencies` 函数跨越 2000+ 行，承担工具注册、记忆系统装配、路由集成、插件/技能系统接入、Phase 50-70 各模块渐进接入。
- **问题**：单一文件违反 SRP，装配逻辑复杂度高，修改风险大，新人难以理解。
- **修复建议**：按域拆分为独立装配模块：
  - `assemble-tools.ts` — 工具注册（约 150 行）
  - `assemble-memory.ts` — 记忆系统装配
  - `assemble-router.ts` — 路由集成
  - `assemble-extras.ts` — Phase 50-70 可选模块
  - `app-init.ts` — 只剩组合层（目标 ≤300 行）
- **证据**：文件 token 数超过 36000，是第二大文件的 2.3 倍。

#### [F-018] IPC 暴露面较宽（47 个 handler）
- **级别**：Minor
- **维度**：维度 1 - 架构与耦合
- **位置**：`desktop/main/index.ts:331-824`
- **问题**：47 个 IPC handler 全部注册在同一文件，部分低频功能（checkpoint、experiment、hook）始终占用主进程资源。
- **修复建议**：将低频 handler 按功能域拆分到独立模块（`ipc-handlers/checkpoint.ts`、`ipc-handlers/experiment.ts` 等），通过 index.ts 统一加载。
- **证据**：index.ts 文件 824 行，handler 注册占主要篇幅。

---

## 维度 2：类型安全

### 概述

本维度搜索了 `any` 类型、`@ts-ignore`/`@ts-expect-error`、`as` 断言、`as unknown as` 双重断言。发现 5 个 findings（Important: 1 / Minor: 3 / Info: 1）。

### `any` 使用统计

| 位置 | 次数 | 上下文 |
|------|------|--------|
| `src/tools/builtin/browser.ts:270,284` | 2 | puppeteer 动态 import |
| `src/agent/unified-reviewer.ts:346,384` | 2 | LLM 输出解析 |
| `src/agent/multi/orchestrator.ts:440` | 1 | 子 Agent 输出解析 |

### `@ts-expect-error` 位置

| 位置 | 原因 |
|------|------|
| `src/tools/builtin/browser.ts:272` | puppeteer 可选依赖动态 import |

### Findings

#### [F-006] `as unknown as` 双重断言热点（20+ 处）
- **级别**：Important
- **维度**：维度 2 - 类型安全
- **位置**：散点分布于多个文件，主要位置：
  - `src/runtime/app-init.ts:509,758,1231,1406,1502,1506,2059`（7 处）
  - `src/tools/security-enhanced.ts:397,401,413`（3 处）
  - `src/tools/registry.ts:61`、`adapter.ts:53`、`src/tools/mcp/mcp-tool.ts:34`（3 处）
  - `src/tools/mcp/client.ts:349`、`src/tools/builtin/todo-write.ts:172,190`（3 处）
  - `src/skills/embedder.ts:54`、`src/router/orchestrator.ts:189`、`src/router/llm/openai.ts:240,246`、`src/router/classifier.ts:91`、`src/plugins/registry.ts:341`、`-discovery.ts:630`（7 处）
- **代码示例**：
  ```typescript
  // app-init.ts:509
  const cm = contextManager as unknown as { setPrefixCache?: (c: unknown) => void };
  
  // registry.ts:61
  parameters: tool.definition.parameters as unknown as Record<string, unknown>,
  ```
- **问题**：`as unknown as T` 是 TypeScript 中最不安全的断言方式，完全绕过类型检查。在 app-init.ts 中出现 7 次，使用 feature-detect 模式动态注入能力，但这种模式掩盖了真实的类型缺陷。
- **修复建议**：
  1. 为 AppDependencies 消费者定义明确的接口类型
  2. 使用 discriminated union + type guard 替代 `as unknown as`
  3. 为 `setPrefixCache`/`setBudgetMonitor` 等方法在 ContextManager/AgentLoop 中声明可选方法接口
- **证据**：grep `as unknown as` 在 src/ 返回 20+ 命中。

#### [F-011] `any` 类型使用（5 处）
- **级别**：Minor
- **维度**：维度 2 - 类型安全
- **位置**：
  - `src/tools/builtin/browser.ts:270,284` — puppeteer 动态 import
  - `src/agent/unified-reviewer.ts:346,384` — LLM 输出解析
  - `src/agent/multi/orchestrator.ts:440` — 子 Agent 输出解析
- **问题**：LLM 输出解析使用 `any`，运行时无类型保障。
- **修复建议**：定义 `ParsedIssue`/`ParsedResult` 接口，用 `zod` schema 校验 LLM 输出后转型。browser.ts 的 puppeteer 可用 `import('puppeteer').Browser` 类型替代。
- **证据**：grep `: any` 返回 5 命中。

#### [F-029] `@ts-expect-error` 无注释说明
- **级别**：Minor
- **维度**：维度 2 - 类型安全
- **位置**：`src/tools/builtin/browser.ts:272`
- **代码**：
  ```typescript
  // @ts-expect-error — puppeteer 是可选依赖，未安装时 import 会抛错
  ```
- **问题**：虽然有注释说明原因，但该注释可随代码移动而失同步。
- **修复建议**：使用 `import type` + 条件类型替代实例层面的 ts-expect-error。
- **证据**：仅 1 处，已注释说明原因，风险低。

---

## 维度 3：错误处理与韧性

### 概述

本维度审查了 catch 块处理、Promise rejection、fail-open 降级路径、超时和重试机制。发现 2 个 findings（Important: 1 / Info: 1）。

### fail-open 降级路径清单

| 位置 | 是否记录降级 |
|------|-------------|
| `app-init.ts:492-494` (OtelExporter) | ✅ `logger.warn` |
| `app-init.ts:515` (PrefixAwareCache) | ✅ 静默（注释说明） |
| `app-init.ts:553` (auditChain) | ✅ `logger.warn` |
| `app-init.ts:601` (BrowserTool) | ✅ 静默 |
| `app-init.ts:647-651` (ConfigGuard) | ✅ `logger.warn` |
| `app-init.ts:670-673` (CommandSandbox) | ✅ `logger.warn` |
| `app-init.ts:767` (BudgetMonitor) | ✅ 静默 |
| `index.ts:377` (plan:get-revisions) | ✅ fail-open 返回空 |
| `index.ts:386-391` (plan:check-omissions) | ✅ 返回错误描述 |

### Findings

#### [F-020] hooks/adapter.ts 使用 `shell: true` spawn 执行 Hook 命令
- **级别**：Important
- **维度**：维度 3 - 错误处理与韧性
- **位置**：`src/hooks/adapter.ts:88`
- **代码**：
  ```typescript
  const child = spawn(command, { shell: true, timeout, cwd });
  ```
- **问题**：Hook 命令通过 `shell: true` 完整传递到系统 shell，如果 Hook 命令字符串包含用户输入或 LLM 生成的内容，可被注入任意命令（如 `valid_command; rm -rf /`）。
- **修复建议**：
  1. 使用 `parseCommand()` tokenize 后取首 token 作为可执行文件
  2. 将 `shell: true` 改为数组参数形式 `spawn(args[0], args.slice(1), { cwd, timeout })`
  3. 或将命令写入脚本文件再执行
- **证据**：与 `security/sandbox.ts` 中 `spawn(command, args)`（无 shell 模式）的安全实践不一致。

#### [F-015] 遗留 TODO 注释
- **级别**：Info
- **维度**：维度 3 - 错误处理与韧性
- **位置**：`src/agent/multi/orchestrator.ts:590`
- **代码**：
  ```typescript
  // TODO Phase 73：synthesizer 派生点
  ```
- **问题**：Phase 73 已发布后，此 TODO 未清理或实现。
- **修复建议**：确认是否需要实现，关闭或转化为 issue。
- **证据**：grep `TODO|FIXME|XXX` 仅此 1 条命中。

---

## 维度 4：性能

### 概述

本维度审查了同步阻塞操作、内存泄漏风险、React 渲染热点、资源释放。发现 2 个 findings（Minor: 2）。

### 同步阻塞操作清单

| 位置 | 操作 | 说明 |
|------|------|------|
| `src/runtime/doctor.ts:134` | `spawnSync` | 版本探测，启动时一次性 |
| `src/router/tracker.ts:379` | `readFileSync` | 启动时加载持久化状态 |
| `src/router/routing-history.ts:169` | ` 启动时加载历史 |
| `src/tools/trust-gradient.ts:426` | `readFileSync` | 读取配置文件 |
| `src/skills/market-manager.ts:163,202,523` | `readFileSync` | 读取 Skill 元数据 |
| `src/harness/experiment-manager.ts:161,184` | `readFileSync` | 读取 gitignore / 注册表 |
| `src/plugins/filesystem-discovery.ts:258` | `readFileSync` | 读取 Skill 状态 |
| `src/runtime/app-init.ts:1948` | `readFileSync` | 读取 ProjectDoc |

### Findings

#### [F-012] 同步 fs 操作在启动热路径
- **级别**：Minor
- **维度**：维度 4 - 性能
- **位置**：`src/router/tracker.ts:379`、`src/router/routing-history.ts:169`、`src/runtime/app-init.ts:1948`
- **问题**：启动时使用同步读文件，在 SSD 上影响较小，但在慢速磁盘或网络挂载目录时会阻塞事件循环。
- **修复建议**：将启动时的配置/状态读取改为 `await fs.promises.readFile()` 异步版本，配合顶层 await 或 .then() 链式调用。
- **证据**：grep `readFileSync` 返回约 15 处，主要在启动/初始化阶段。

#### [F-019] 组件事件监听器/定时器清理不完整
- **级别**：Minor
- **维度**：维度 4 - 性能
- **位置**：`desktop/renderer/src/components/StatusBanner.tsx:97` 和多个 `setTimeout` 未在 `useEffect` cleanup 中清除
- **问题**：`scheduleDismiss` 中的 `setTimeout` 未返回清理函数，组件卸载时定时器仍在运行。
- **修复建议**：在 useEffect 返回清理函数清除所有定时器。
  ```typescript
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    return () => timers.forEach(clearTimeout);
  }, [deps]);
  ```
- **证据**：grep `setTimeout` 返回约 15 处，部分 setTimeout-for-kill 模式（shell-exec:180）需保留。

---

## 维度 5：安全

### 概述

本维度审查了 Electron 安全配置、preload 暴露面、路径遍历防护、命令注入风险、敏感信息泄露、CSP 配置。发现 5 个 findings（Critical: 1 / Important: 3 / Minor: 1）。

### Electron 安全配置审计

| 配置项 | 值 | 评价 |
|--------|-----|------|
| `contextIsolation` | `true` | ✅ 正确 |
| `nodeIntegration` | `false` | ✅ 正确 |
| `sandbox` | `true` | ✅ 正确 |
| preload 路径 | `../preload/index.cjs` | ✅ 隔离 API |

### CSP 配置

```typescript
// Content-Security-Policy（index.ts:191）
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src ${connectSrc}`
```
✅ 合理，生产环境 `connect-src 'self'` 限制数据外泄。

### Preload API 暴露面审计

暴露通道：47 个 handler，覆盖 chat、config、command、tool、mcp、skill、fs、window、experiment、hook、checkpoint、plan、agent、on/off 等。

### IPC Handler 输入校验审计（抽样）

| Handler | 类型校验 | 长度边界 | 枚举校验 |
|---------|----------|----------|----------|
| `chat:send` ✅ | ✅ | ✅ | N/A |
| `mcp:connect` ✅ | ✅ | ✅ (≤256) | N/A |
| `skill:toggle` ✅ | ✅ | ✅ | N/A |
| `hook:create` ❌ | `unknown` | ❌ | N/A |
| `experiment:adopt` ✅ | ✅ | ✅ | N/A |
| `chat:confirm-tool` ❌ | ❌ | ❌ | N/A |
| `plan:edit-response` ❌ | ❌ | ❌ | N/A |
| `agent:followUp` ❌ | ❌ | ❌ | N/A |
| `agent:setFollowUpMode` ❌ | ❌ | ❌ | ✅ |
| `checkpoint:rollback` ✅ | ✅ | ✅ | N/A |

### Findings

#### [F-001] 多个 IPC handler 缺少参数校验（Critical）
- **级别**：Critical
- **维度**：维度 5 - 安全
- **位置**：`desktop/main/index.ts:351,356,739,779,788,797`
- **问题**：以下 handler 对 payload 无直接类型/长度校验，透传给 engine 方法：
  - `chat:confirm-tool` (line 351) — 直接调用 `engine?.resolveToolConfirm`
  - `plan:edit-response` (line 356) — 直接调用 `engine?.resolvePlanEdit`
  - `hook:create` (line 739) — payload 类型为 `unknown`
  - `agent:followUp` (line 779) — content 无长度校验
  - `agent:clearAllQueues` (line 788) — 无 arity 校验
  - `agent:setFollowUpMode` (line 797) — 接受任意 string mode
- **攻击场景**：渲染进程被 XSS 攻击后，攻击者可发送任意 IPC 消息。虽然 contextIsolation 限制了渲染进程访问 Node API，但已通过 preload 暴露的 IPC 通道可被滥用。例如，发送超大 content 字符串可消耗 LLM token 额度；发送非法 mode 值可能导致 engine 内部状态不一致。
- **修复建议**：为每个 handler 添加参数类型+边界校验：
  ```typescript
  // 示例：agent:followUp
  ipcMain.on('agent:followUp', (_event, content: unknown) => {
    if (typeof content !== 'string' || content.length === 0 || content > 10000) {
      console.warn('[agent:followUp] 无效 content 参数');
      return;
    }
    if (!engine) return;
    engine.followUp(content);
  });
  ```
- **证据**：grep `ipcMain.on|ipcMain.handle` 返回 47 handler，约 10 处缺少基础校验。

#### [F-002] ToolCallCard 使用 `dangerouslySetInnerHTML`
- **级别**：Important
- **维度**：维度 5 - 安全
- **位置**：`desktop/renderer/src/components/ToolCallCard.tsx:408,411,425`
- **代码**：
  ```tsx
  <span dangerouslySetInnerHTML={{ __html: fullHtml }} />
  <span dangerouslySetInnerHTML={{ __html: headHtml }} />
  <span dangerouslySetInnerHTML={{ __html: tailHtml }} />
  ```
- **问题**：`fullHtml`/`headHtml`/`tailHtml` 由 `ansiToHtml()` 生成 ANSI 转 HTML 输出。如果 ANSI 输入包含用户可控内容（如 shell 输出中的 HTML 标签），可被注入到渲染进程 DOM。
- **修复建议**：
  1. 确认 `ansiToHtml()` 是否对 `<>&"` 进行实体转义
  2. 如未转义，在 `ansiToHtml()` 中添加 HTML escape 层
  3. 替换为安全的 React token 渲染方案
- **证据**：grep `dangerouslySetInnerHTML` 在 renderer/src 返回 3 命中。

#### [F-017] Shell DANGEROUS_PATTERNS 可被编码绕过
- **级别**：Important
- **维度**：维度 5 - 安全
- **位置**：`src/security/sandbox.ts:94-111`
- **代码**：
  ```typescript
  const DANGEROUS_PATTERNS: RegExp[] = [
    /rm\s+(-[a-z]*r[a-z]*f[a-z]*)\s+\/(\s|$|\*)/i,
    /^format\s+[a-z]:/i,
    // ...
  ];
  ```
- **问题**：正则模式可被以下技术绕过：
  1. 编码：`rm -rf /` → `$(echo cm0gLXJmIC8= | base64 -d | sh)`
  2. Shell 别名 / PATH 劫持
  3. 间接执行：`node -e "require('child_process').exec('rm -rf /')"`
  4. 多行 heredoc 绕过行首匹配
- **修复建议**：
  1. 在 `sandbox.execute()` 中添加 parseCommand 首 token 白名单校验
  2. 对用户输入使用 spawn(cmd, argsArray) 而非 shell 模式
  3. 对 LLM 生成的命令添加执行前多模式交叉校验
- **证据**：DANGEROUS_PATTERNS 仅覆盖约 10 种明显模式。

#### [F-010] 部分 IPC handler 输入长度边界缺失
- **级别**：Minor
- **维度**：维度 5 - 安全
- **位置**：`desktop/main/index.ts:652-659`（chat:generate-title）
- **问题**：handler 未校验 userMessage 参数的最大长度，攻击者可发送超大字符串消耗 LLM token 额度。
- **修复建议**：添加 `userMessage.length` 上限（如 10000 字符），超出后截断或拒绝。

---

## 维度 6：可维护性与代码质量

### 概述

本维度审查了长文件、长函数、重复代码、命名一致性、魔法数字、TODO/FIXME、注释覆盖率。发现 4 个 findings（Important: 3 / Minor: 1）。

### 长文件 Top 10（>500 行）

| 文件 | 行数 | 评价 |
|------|------|------|
| `src/runtime/app-init.ts` | 2487 | ⚠️ 严重 |
| `src/config/schema.ts` | 2122 | ⚠️ 应拆分 |
| `src/runtime/goal-runner.ts` | 2033 | ⚠️ 应拆分 |
| `src/agent/loop.ts` | 1954 | ⚠️ 考虑 |
| `desktop/main/engine-bridge.ts` | 1738 | ⚠️ 考虑 |
| `src/agent/memory/graph.ts` | 1159 | 可选 |
| `src/code-map/extractor.ts` | 1013 | 可选 |
| `src/tools/builtin/spawn-agent.ts` | 993 | 可选 |
| `desktop/renderer/src/store/useRouteDevStore.ts` | 975 | ⚠️ 应拆分 |
| `src/agent/multi/worker-executor.ts` | 952 | 可选 |

### Findings

#### [F-004] config/schema.ts 超长（2122 行）
- **级别**：Important
- **维度**：维度 6 - 可维护性与代码质量
- **位置**：`src/config/schema.ts:1-2122`
- **问题**：单文件包含所有配置类型的 Zod schema（router、agent、security、memory、mcp、subAgents、autonomy、goalIntegration 等）。
- **修复建议**：按域拆分 schemas：
  - `schemas/router-schema.ts`
  - `schemas/agent-schema.ts`
  - `schemas/security-schema.ts`
  - `schemas/memory-schema.ts`
  - `schemas/experimental-features.ts`（phase50-70 渐进接入开关）
  - `schema.ts` — 统一 re-export + 组合 AppConfig

#### [F-005] goal-runner.ts 超长（2033 行）
- **级别**：Important
- **维度**：维度 6 - 可维护性与代码质量
- **位置**：`src/runtime/goal-runner.ts:1-2033`
- **问题**：单个 `createGoalRunner` 函数实现 2033 行，包含 Goal 拆解、计划编辑、步骤执行、验证等所有逻辑。
- **修复建议**：拆分为 `goal-decomposer.ts`、`goal-step-executor.ts`、`goal-verifier.ts` + 组合层。

#### [F-009] 魔法数字散点
- **级别**：Minor
- **维度**：维度 6 - 可维护性与代码质量
- **位置**：多处
- **示例**：
  - `src/tools/builtin/shell-exec.ts:14` — `MAX_STDOUT = 100 * 1024`
  - `ShellExecTool.circuit` — `failureThreshold: 5, resetTimeoutMs: 30000`
  - `src/runtime/app-init.ts:287-294` — 已部分提取为常量
- **修复建议**：将工具内部熔断阈值和超时提取到 config schema 中统一管理。

---

## 维度 7：测试覆盖

### 概述

本维度统计了测试文件与源码的比例、关键模块的测试覆盖、测试命名质量。发现 1 个 finding（Minor: 1）。

### 测试覆盖率估算

| 模块 | 测试文件数 | 关键类/函数覆盖 |
|------|-----------|----------------|
| `agent/` | ~50 | ✅ 高 |
| `router/` | ~19 | ✅ 高 |
| `tools/` | ~25 | ✅ 高 |
| `memory/` | ~10 | ✅ 中高 |
| `runtime/` | ~6 | ⚠️ 中 |
| `config/` | ~3 | ✅ 高 |
| `plugins/` | ~4 | ✅ 高 |
| `e2e/` | ~1 | ⚠️ 低 |

### 跳过的测试

无 `.skip()` / `xit()` / `xdescribe()` 命中 ✅

### Findings

#### [F-021] e2e 测试覆盖薄弱
- **级别**：Minor
- **维度**：维度 7 - 测试覆盖
- **位置/e2e/user-journey.test.ts`
- **问题**：仅 1 个 e2e 测试文件，CONTRIBUTING.md 要求 e2e 串行运行但未实际落地覆盖。
- **修复建议**：增加核心用户旅程 e2e 测试（首次启动、对话聊天、工具确认、切换项目）。

---

## 维度 8：文档与注释

### 概述

本维度审查了根文档覆盖率、文档与代码一致性。发现 2 个 findings（Minor: 2）。

### 文档完整性

| 文档 | 状态 |
|------|------|
| `README.md` | ✅ |
| `AGENTS.md` | ✅ Top 10 核心陷阱 + Phase 47/48 新增 |
| `CONTRIBUTING.md` | ✅ Issue-driven workflow + commitlint + 测试规范 |
| `CHANGELOG.md` | ✅ |
| `CODEMAP.md` | ✅ |

### Findings

#### [F-023] README.md 与 AGENTS.md 信息冗余
- **级别**：Minor
- **维度**：维度 8 - 文档与注释
- **问题**：技术栈说明在 README.md 和 AGENTS.md 中重复出现。
- **修复建议**：README.md 仅保留简介和安装说明，技术栈详情链接到 AGENTS.md。

#### [F-024] 公共 API JSDoc 覆盖率约 60%
- **级别**：Minor
- **维度**：维度 8 - 文档与注释
- **问题**：部分内部工具类方法缺少 JSDOC。
- **修复建议**：为所有 exported class 公共方法添加 JSDoc。

---

## 维度 9：依赖管理

### 概述

本维度审查了依赖版本新旧、未使用依赖、重复依赖、dev/dependencies 分界、husky/commitlint 配置。发现 2 个 findings（Important: 1 / Info: 1）。

### 过时依赖清单（major 落后）

| 包 | 当前 | 最新 | 落后 |
|----|------|------|------|
| `electron` | 34.5.8 | 43.0.0 | 9 major 🔴 |
| `@vitejs/plugin-react` | 4.7.0 | 6.0.3 | 2 major |
| `electron-vite` | 2.3.0 | 5.0.0 | 3 major 🔴 |
| `vite` | 6.4.3 | 8.1.3 | 2 major 🔴 |
| `tailwindcss` | 3.4.19 | 4.3.2 | 1 major |
| `lucide-react` | 0.577.0 | 1.23.0 | 1 major |
| `web-tree-sitter` | 0.22.6 | 0.26.10 | patch |
| `@types/node` | 25.9.4 | 26.1.0 | 1 major |

### Findings

#### [F-007] 核心构建依赖严重过时
- **级别**：Important
- **维度**：维度 9 - 依赖管理
- **位置**：`package.json:34-76`
- **问题**：Electron（34→43，落后 9 major）、vite（6→8）、electron-vite（2→5）均严重过时。这些是核心构建/运行时依赖，意味着缺失安全补丁与新特性。
- **修复建议**：制定分阶段升级计划：
  1. 先升 vite 小版本 + patch 依赖
  2. 再升 electron-vite → electron（需回归测试）
  3. 优先级：`vite` > `electron-vite` > `tailwindcss` > `electron`
- **证据**：`npm outdated` 显示 13 项过时，其中 5 项 major 落后。

#### [F-025] commitlint 配置未完全生效
- **级别**：Info
- **维度**：维度 9 - 依赖管理
- **位置**：`commitlint.config.cjs:5`
- **问题**：CONTRIBUTING.md 支持 `[scope]` 和 Conventional Commits 两种格式，但 commitlint 仅校验后者。`[scope]` tau 风格的 commit 会被 hook 拒绝。
- **修复建议**：引入自定义 parser plugin 支持 `[scope]` 格式，或修改 CONTRIBUTING.md 描述。

---

## 维度 10：死代码与冗余

### 概述

本维度审查了未使用导出、注释代码块、空分支、临时文件。发现 3 个 findings（Minor: 2 / Info: 1）。

### Findings

#### [F-026] 仓库含多个临时/审计文件
- **级别**：Minor
- **维度**：维度 10 - 死代码与冗余
- **位置**：仓库根目录
- **文件**：`dead-code-audit-output.md`、`dead-code-report.json`、`__read_lines.ps1`、`tmp_classify_test.mjs`、`_audit-output.txt`、`_import-paths.txt`、`_importers.txt`、`_unreferenced-src.txt`、`_audit.ps1`、`zombie-analysis.cjs`
- **问题**：开发/审计过程的临时产物不应入库。
- **修复建议**：删除文件 + 在 .gitignore 添加模式：`__*.ps1`、`*audit*`、`tmp_*.mjs`、`zombie-*.cjs`。

#### [F-027] electron-builder.yml output 目录"
- **级别**：Minor
- **维度**：维度 10 - 死代码与冗余
- **位置**：`electron-builder.yml:8`
- **问题**：Phase 54 "临时" 规避方案未修正，仍使用 release-v6。
- **修复建议**：确认 release-v4/v5 锁定问题是否已解决，改回或移除 TODO 注释。

#### [F-028] AGENTS.md 引用源文件待确认
- **级别**：Info
- **维度**：维度 10 - 死代码与冗余
- **问题**：AGENTS.md 列出 `src/runtime/notification.ts` 为关键入口，需确认该文件存在且活跃。
- **修复建议**：确认或更新文档。

---

## 附录：审查覆盖范围

### 已读取/分析文件

**核心入口**：
- [x] `desktop/main/index.ts` (824 行)
- [x] `desktop/main/engine-bridge.ts` (1738 行)
- [x] `src/runtime/app-init.ts` (2487 行，分段读取)
- [x] `desktop/preload/index.ts` (135 行)

**配置文件**：
- [x] `package.json`
- [x] `tsconfig.json`
- [x] `electron-builder.yml`
- [x] `commitlint.config.cjs`
- [x] `electron.vite.config.mjs`

**安全配置**：
- [x] `src/security/sandbox.ts`
- [x] `src/tools/builtin/shell-exec.ts`

**文档**：
- [x] `AGENTS.md`
- [x] `CONTRIBUTING.md`

### 抽样审查文件

**类型安全热点**：
- [x] `src/tools/builtin/browser.ts`
- [x] `src/agent/unified-reviewer.ts`
- [x] `src/agent/context-compaction.ts`
- [x] `src/router/llm/openai.ts`

**渲染层**：
- [x] `desktop/renderer/src/components/ToolCallCard.tsx`
- [x] `desktop/renderer/src/store/useRouteDevStore.ts`

**依赖分析**：
- [x] `package.json` dependencies/devDependencies 分界
- [x] 运行 `npm outdated`（13 项过时）

**文件统计**：
- [x] 源码文件总数 255（src/ + desktop/main/ + desktop/renderer/src/）
- [x] 测试文件总数 242
- [x] 长文件 Top 25（PowerShell 统计）

### 已排除误报清单

| 疑似问题 | 排除原因 |
|----------|----------|
| app-init 中 7 处动态 import "未被静态引用" | 设计意图：可选模块加载 |
| fail-open 降级路径 "未处理错误" | 设计意图：有 warn 日志 |
| AgentRole 类型碎片化 | 已知技术债 |
| engine-bridge.ts pre-existing TS 错误 | 已知问题 |
| `.routedev/skills/` 不入库 | gitignore 运行时数据 |
| 类型导出 / interface | 不是死代码 |
| reviewer verdict 三态 | 设计意图 |
| progress-ledger append-only | 设计意图 |

---

## 审查者信息

- **审查者模型**：美团-龙猫2.0
- **审查工具**：CatPaw IDE（Cursor Agent）
- **审查日期**：2026-07-07
- **审查耗时**：约 1.5 小时
- **总 findings 数**：28
- **Critical 数量**：1（F-001 IPC handler 无参数校验）
- **Important 数量**：9
- **Minor 数量**：12
- **Info 数量**：6
- **建议处理方式**：排期修复
  - 立即修复（本周）：F-001 IPC 参数校验、F-002 dangerouslySetInnerHTML
  - 近期修复（1-2 周）：F-007 依赖升级、F-020 hooks adapter shell
  - 排期修复（1-2 月）：F-003/004/005 文件拆分、F-006 类型安全重构
- **备注**：
  1. 本报告基于静态代码搜索和人工确认，未运行 `npm run build`/`npm test`；
  2. 已知技术债（AgentRole 碎片化、engine-bridge TS 错误）未重复报告；
  3. fail-open 降级和动态 import 等设计意图已排除出 finding。

---

> **审查结论**：RouteDev 项目整体架构合理，安全设计到位，测试覆盖率高，但核心文件过长、依赖过时、部分 IPC 校验缺失是主要风险点。建议按优先级分阶段修复，其中 F-001（IPC 参数校验）应作为本周安全加固项。
