# Phase 46 — 死代码清零与接线收尾

> **版本目标：** v3.7.0
> **前置依赖：** Phase 45（v3.6.0 Pi 人格化交互与主动记忆落地）完成
> **新增测试要求：** ≥ 35 个
> **研究依据：** 2026-06-25 全项目死代码审计报告（4 路并行子代理审计 + 关键发现人工验证）；RouteDev 当前 `desktop/main/index.ts`、`src/cli/app-init.ts`、`src/cli/App.tsx`、`src/hooks/`、`src/skills/` 实现；AGENTS.md 陷阱 #22/#46 中关于死代码与桩实现的记录
> **核心命题：** RouteDev 经过 45 个 Phase 的迭代，积累了大量"已实现但未接线"、"源文件已删但测试/文档残留"、"完整代码但零引用"的死代码与桩实现。这些问题轻则让用户点击按钮报错"尚未接线"，重则让用户配置的 Hook 永远不执行、配置的 CLI 命令永远不可用。本 Phase 不新增功能，而是系统性清零所有审计发现的死代码与断链：把断掉的 IPC 桥接接上、把未注册的命令注册上、把零引用的代码删除或接入、把过时的文档同步上。目标是让代码库达到"所见即所用"的状态——任何 UI 入口都能走通后端，任何 CLI 命令都能被执行，任何导出都有消费者，任何文档都反映现状。

---

## 项目现状审计与可行性结论

### 1. 审计发现汇总

基于 2026-06-25 的全项目死代码审计，共发现 **15 个问题**，按严重度分布：

| 严重度 | 数量 | 说明 |
|--------|------|------|
| 🔴 Critical | 4 | 用户操作会报错或功能完全不可用 |
| 🟠 High | 6 | 完整死代码（未引用的文件/导出/组件/命令） |
| 🟡 Medium | 3 | 有降级的桩实现，默认情况能用但功能受限 |
| 🟢 Low | 2 | 文档残留、防御性代码 |

### 2. 已具备的实现基础

| 模块 | 当前状态 | 本 Phase 可复用度 |
|------|---------|------------------|
| `ExperimentManager`（`src/harness/experiment-manager.ts`） | 类实现完整，在 app-init.ts 中加载配置但未注入 engine | 高（C1 桥接的基础） |
| `HookRegistry`（`src/hooks/registry.ts`） | 类实现完整，能从磁盘加载 HookConfig | 高（C2 桥接的基础） |
| `CodeGraphManager`（`src/config/codegraph-manager.ts`） | 类实现完整 | 高（C1 桥接的基础） |
| `HookRunner`（`src/agent/hooks.ts`） | 钩子执行器，支持 8 种事件 + register/fire | 高（C2 接线的目标） |
| `built-in.ts` | 3 个硬编码 Hook 注册示例 | 高（C2 转换逻辑的参考） |
| `AgentLoopStepExecutor`（`src/agent/step-executor.ts`） | 真实 StepExecutor 实现 | 高（M1 已确认无需改动） |
| `StubRegistryClient` | 返回空列表的降级实现 | 中（C3 的回退路径） |
| `commands/index.ts` | barrel 文件集中导出所有命令 | 高（H1 注册只需补 import） |

### 3. 尚未落地的关键缺口

| 缺口 | 影响 | 本 Phase 处理方式 |
|------|------|------------------|
| 9 个 IPC handler 是桩实现 | 用户点击 CodeGraph/Experiment/Hook 操作报错"尚未接线" | Task 1 在 RouteDevEngine 中实现桥接方法 |
| HookConfigRegistry 与 HookRunner 断开 | 用户配置的 Hook 永不执行 | Task 2 实现 HookConfig → HookDefinition 转换并注册 |
| HttpRegistryClient 全抛 Not implemented | 配置 registryUrl 后市场操作全部抛错 | Task 3 实现 HTTP 客户端或禁用 UI 入口 |
| token-alert.json 用了不支持的事件 | Token 超限警告永不触发 | Task 4 修复事件类型或扩展 HookEvent |
| 5 个 CLI 命令未注册 | /clarify /experiment /quality /schedule /trust 不可用 | Task 5 在 App.tsx 中补注册 |
| 11 个桌面组件未引用 | 代码冗余、维护负担 | Task 6 删除或接入 |
| 6 个生产零引用导出 | 代码冗余、误导维护者 | Task 7 删除或接入 |
| 2 个死测试引用已删源文件 | 测试失败、CI 噪声 | Task 8 删除死测试 |
| AGENTS.md 文档过时 | 误导接手者、标注与实际不符 | Task 9 同步文档 |

### 4. 可行性总评

- **IPC 桥接（C1）：** 高度可行。底层类已存在且在 app-init.ts 中加载，只需在 `RouteDevEngine` 中暴露 getter 并在 IPC handler 中调用，无需新写业务逻辑。
- **Hook 接线（C2）：** 可行。需要编写 HookConfig → HookDefinition 的转换层（shell command 字符串 → handler 函数，含 `{{filePath}}` 等变量替换），参考 `built-in.ts` 的实现模式。
- **HTTP Registry Client（C3）：** 可行。标准 HTTP 调用，使用项目已有的 `fetch` 或 `undici`，无需新依赖。若优先级低可先禁用 UI 入口。
- **事件类型修复（C4）：** 高度可行。要么在 HookEvent 增加 `on-model-call` 并在 AgentLoop 添加触发点，要么改模板为 `post-step`。
- **命令注册（H1）：** 高度可行。一行 import + 数组追加，每个命令已有完整 handler。
- **死代码清理（H2/H3/H4）：** 高度可行。删除文件/导出，跑 typecheck 验证无破坏。
- **文档同步（L1）：** 高度可行。纯文档修改。

---

## 核心设计原则

### 原则 1：接线优先于删除

对于"已实现但未接线"的代码（C1/C2/H1），优先接线让功能可用，而不是删除。底层能力已存在，浪费可惜。只有确认无未来使用计划时才删除（H2/H3）。

### 原则 2：不引入新依赖

本 Phase 是清零收尾，不引入新依赖。HTTP Client 使用 Node 18+ 内置的 `fetch`，不引入 axios/undici。

### 原则 3：每一步都可独立验证

每个 Task 完成后都能独立通过 typecheck + test 验证，不依赖其他 Task。Task 之间无强耦合，可并行执行（除 Task 9 文档同步需在所有代码改动后进行）。

### 原则 4：保留降级路径

修复桩实现时，保留 fail-open 降级。例如 C1 桥接后，若底层 ExperimentManager 加载失败，IPC handler 仍应返回空数组而非崩溃。

### 原则 5：文档与代码同步

任何删除/接线/新增的代码，必须在同一 Task 内同步更新 AGENTS.md、CODEMAP.md、config.example.yaml 中对应条目，避免文档再次过时。

---

## Task 1：IPC Handler 桥接 —— CodeGraph / Experiment / Hook（≥ 8 测试）

### 1.1 问题定位

**位置**：`desktop/main/index.ts:576-699`

9 个 IPC handler 使用 `(engine as unknown as { methodName?: ... })?.methodName?.()` 动态探测，但 `RouteDevEngine`（`desktop/main/engine-bridge.ts`）未实现这些方法，全部走 fallback 返回错误或空数组。

| IPC 通道 | 行号 | 当前返回 |
|---|---|---|
| `codemap:check-status` | 583 | `{ available: false, indexed: false }` |
| `codemap:install` | 600 | `{ success: false, error: '尚未接线' }` |
| `codemap:start-index` | 611 | `{ success: false, error: '尚未接线' }` |
| `experiment:list` | 620 | `[]` |
| `experiment:adopt` | 631 | `{ success: false, error: '尚未接线' }` |
| `experiment:discard` | 642 | `{ success: false, error: '尚未接线' }` |
| `experiment:get-diff` | 653 | `{ diff: '', filesChanged: 0, error: '尚未接线' }` |
| `hook:list` | 662 | `[]` |
| `hook:toggle` | 673 | `{ success: false, error: '尚未接线' }` |
| `hook:create` | 684 | `{ success: false, error: '尚未接线' }` |
| `hook:delete` | 695 | `{ success: false, error: '尚未接线' }` |

### 1.2 实现方案

在 `RouteDevEngine` 中新增以下 public 方法，桥接已存在的底层类：

```typescript
// desktop/main/engine-bridge.ts 新增方法
class RouteDevEngine {
  // CodeGraph
  getCodeGraphStatus(): CodeGraphStatus { ... }
  async installCodeGraph(): Promise<{ success: boolean; error?: string }> { ... }
  async startIndexCodeGraph(): Promise<{ success: boolean; error?: string }> { ... }

  // Experiment
  listExperiments(): ExperimentInfo[] { ... }
  async adoptExperiment(id: string): Promise<{ success: boolean; error?: string }> { ... }
  async discardExperiment(id: string): Promise<{ success: boolean; error?: string }> { ... }
  async getExperimentDiff(id: string): Promise<{ diff: string; filesChanged: number; error?: string }> { ... }

  // Hook
  listHooks(): HookInfo[] { ... }
  async toggleHook(id: string, enabled: boolean): Promise<{ success: boolean; error?: string }> { ... }
  async createHook(desc: string): Promise<{ success: boolean; hookId?: string; error?: string }> { ... }
  async deleteHook(id: string): Promise<{ success: boolean; error?: string }> { ... }
}
```

**接线策略**：
- `ExperimentManager` / `HookRegistry` / `CodeGraphManager` 实例在 `app-init.ts` 中已创建（或可创建），需将其作为 `RouteDevEngine` 的构造参数注入
- 若 `app-init.ts` 是 CLI 路径的工厂，desktop 主进程需要独立的装配逻辑——在 `engine-bridge.ts` 的 `initialize()` 中按需创建这些管理器实例
- 所有方法采用 fail-open：底层管理器不存在时返回空数组/默认值，不抛错

### 1.3 简化 IPC handler

桥接完成后，将 `main/index.ts` 中的动态探测模式简化为直接调用：

```typescript
// 修改前（桩）
ipcMain.handle('codemap:install', async () => {
  const installFn = (engine as unknown as { installCodeGraph?: ... })?.installCodeGraph;
  if (installFn) return await installFn.call(engine);
  return { success: false, error: '尚未接线' };
});

// 修改后（真实）
ipcMain.handle('codemap:install', async () => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.installCodeGraph();
});
```

### 1.4 测试要求

- `codemap:check-status` 在未启用时返回 `{ available: false }`，启用后返回真实状态
- `codemap:install` 成功调用底层 CodeGraphManager 并返回 `{ success: true }`
- `experiment:list` 返回 ExperimentManager 中的实验列表
- `experiment:adopt` 成功采纳实验分支（mock git merge）
- `experiment:discard` 成功丢弃实验分支（mock worktree 删除）
- `hook:list` 返回 HookRegistry 中的 Hook 列表（含模板 + 自定义）
- `hook:toggle` 切换 Hook 启用状态并持久化
- `hook:create` 通过自然语言描述生成 Hook 并注册
- `hook:delete` 删除自定义 Hook（内置模板不可删）
- 引擎未初始化时所有 IPC 返回友好错误而非崩溃

---

## Task 2：HookConfigRegistry → HookRunner 接线（≥ 6 测试）

### 2.1 问题定位

**位置**：`src/cli/app-init.ts:493-512`

`HookConfigRegistry` 从磁盘加载了用户配置的 Hook（`.routedev/hooks.json`），但加载后仅打印日志，`hookRegistry` 是局部变量未返回，**从未将配置转换并注册到 `HookRunner`**。

验证：全项目搜索 `hookRegistry.list()` 只有 app-init.ts:503 一处（仅日志）；`hookRunner.register` 只有 app-init.ts:820 一处（注册的是另一个硬编码 hook）。

**用户影响**：用户通过 UI 创建的 Hook 能保存到磁盘但永不执行；10 个内置模板从未被自动加载为活跃 Hook。

### 2.2 实现方案

#### 2.2.1 HookConfig → HookDefinition 转换器

新增转换函数，将磁盘上的 HookConfig（含 shell command 字符串）转换为 HookRunner 可执行的 HookDefinition（含 handler 函数）：

```typescript
// src/hooks/adapter.ts（新增文件）
import type { HookDefinition, HookEvent, HookContext, HookResult } from '../agent/hooks.js';
import type { HookConfig } from './registry.js';
import { spawn } from 'node:child_process';

/**
 * 将 HookConfig（磁盘配置）转换为 HookDefinition（运行时可执行）
 * 支持 shell command 字符串与变量替换 {{filePath}} {{toolName}} 等
 */
export function configToDefinition(config: HookConfig): HookDefinition {
  return {
    id: config.id,
    event: config.event as HookEvent,  // 事件类型校验见 Task 4
    priority: config.priority ?? 50,
    async handler(ctx: HookContext): Promise<HookResult> {
      const command = replaceVariables(config.command, ctx);
      return executeShellCommand(command, config.timeout ?? 5000, config.cwd);
    },
  };
}

function replaceVariables(template: string, ctx: HookContext): string {
  return template
    .replace(/\{\{filePath\}\}/g, ctx.filePath ?? '')
    .replace(/\{\{toolName\}\}/g, ctx.toolName ?? '')
    .replace(/\{\{stepId\}\}/g, ctx.stepId ?? '');
}

function executeShellCommand(command: string, timeout: number, cwd?: string): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, timeout, cwd });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => {
      resolve({
        action: code === 0 ? 'continue' : 'skip',
        message: code === 0 ? undefined : `Hook 退出码 ${code}`,
        output: stdout,
      });
    });
    child.on('error', (err) => {
      resolve({ action: 'continue', message: `Hook 执行失败: ${err.message}` });
    });
  });
}
```

#### 2.2.2 在 app-init.ts 中接线

```typescript
// app-init.ts 修改 HookConfigRegistry 接线段
import(registryModulePath)
  .then(async (mod) => {
    const hookRegistry = new mod.HookConfigRegistry(path.join(cwd, hooksCfg.configPath));
    await hookRegistry.load();

    // 新增：将配置转换并注册到 HookRunner
    const configs = hookRegistry.list();
    for (const cfg of configs) {
      if (cfg.enabled === false) continue;
      try {
        const def = configToDefinition(cfg);
        hookRunner.register(def);
      } catch (err) {
        logger.warn('Hook 注册失败，跳过', { hookId: cfg.id, error: err });
      }
    }
    logger.info('HookConfigRegistry 接线完成', { registered: configs.filter(c => c.enabled !== false).length });

    // 将 hookRegistry 存入 deps 供后续 CRUD 操作
    deps.hookRegistry = hookRegistry;
  })
```

#### 2.2.3 内置模板自动加载

`src/hooks/templates/*.json` 的 10 个模板当前仅用于 AI 生成时的关键词匹配。本 Task 不自动加载所有模板为活跃 Hook（避免未预期的副作用），但提供 `hookRegistry.enableTemplate(templateId)` 方法，让用户在 UI 中一键启用模板。

### 2.3 测试要求

- HookConfig 的 shell command 正确转换为 HookDefinition 的 handler
- `{{filePath}}` `{{toolName}}` 变量替换正确
- Hook 执行成功时返回 `{ action: 'continue' }`
- Hook 执行失败（非零退出码）时返回 `{ action: 'skip', message }`
- Hook 超时时中止子进程并返回错误
- app-init.ts 启动后用户配置的 Hook 被注册到 HookRunner 并可触发

---

## Task 3：HttpRegistryClient 实现或 UI 禁用（≥ 4 测试）

### 3.1 问题定位

**位置**：`src/skills/registry-client.ts:67-88`

`HttpRegistryClient` 的 5 个方法（listSkills / listHooks / listAgentProfiles / downloadPackage / search）全部抛 `Not implemented`。用户在 SettingsPage.tsx:4547 配置 `Registry URL` 后，所有远程市场操作都会抛错。

### 3.2 实现方案（二选一）

#### 方案 A：实现 HTTP 客户端（推荐）

使用 Node 18+ 内置 `fetch`，无需新依赖：

```typescript
export class HttpRegistryClient implements RegistryClient {
  constructor(private registryUrl: string, private token?: string) {}

  private async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.registryUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`Registry ${res.status}: ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  async listSkills(): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>('/api/skills');
  }
  async listHooks(): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>('/api/hooks');
  }
  async listAgentProfiles(): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>('/api/agent-profiles');
  }
  async search(query: string): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>(`/api/search?q=${encodeURIComponent(query)}`);
  }
  async downloadPackage(name: string, version: string): Promise<Buffer> {
    const res = await fetch(`${this.registryUrl}/api/packages/${name}/${version}/download`);
    if (!res.ok) throw new Error(`Download ${res.status}: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

#### 方案 B：禁用 UI 入口

若 HTTP 实现优先级低，在 SettingsPage.tsx:4547 的 "Registry URL" 输入框上方添加提示并禁用输入：

```tsx
<Input
  value={...}
  disabled
  placeholder="远程市场暂未实现，留空使用本地"
/>
<p className="text-xs text-rd-textMuted">远程市场功能开发中，当前使用本地 StubRegistryClient。</p>
```

### 3.3 决策

采用**方案 A**。理由：
- 项目已进入 v3.7.0，远程市场是 Skill/Hook 生态的基础设施
- Node 18+ 内置 fetch，实现成本低
- 保留 UI 入口，为未来扩展留空间

### 3.4 测试要求

- listSkills 正确解析返回的 JSON 数组
- search 对 query 做 URL 编码
- downloadPackage 返回 Buffer
- 网络错误时抛出可读的错误信息（含状态码）
- token 存在时添加 Authorization 头
- registryUrl 不可达时抛错而非静默返回空

---

## Task 4：token-alert.json 事件类型修复（≥ 2 测试）

### 4.1 问题定位

**位置**：
- `src/hooks/templates/token-alert.json:6` —— `"event": "on-model-call"`
- `src/agent/hooks.ts:35-43` —— `HookEvent` 类型只有 8 种合法值，不含 `on-model-call`

`HookConfigRegistry.isValidConfig` 只检查 `typeof c.event === 'string'`，会接受这个非法事件并存储，给用户造成"已启用"的假象。即便 Task 2 接线后，token-alert 模板生成的 Hook 也无法注册到 HookRunner。

### 4.2 实现方案（二选一）

#### 方案 A：扩展 HookEvent（推荐）

在 `hooks.ts` 的 `HookEvent` 类型中增加 `'on-model-call'`，并在 AgentLoop 的 LLM 调用处添加触发点：

```typescript
// src/agent/hooks.ts
export type HookEvent =
  | 'pre-step' | 'post-step' | 'on-error' | 'on-complete'
  | 'pre-tool-call' | 'post-tool-call'
  | 'on-session-start' | 'on-session-end'
  | 'on-model-call';  // 新增

// src/agent/loop.ts 在 LLM 调用前
await this.hookRunner?.fire('on-model-call', {
  modelId: request.modelId,
  inputTokens: tokenCounter.inputTokens,
  // ...
});
```

#### 方案 B：改模板为 post-step

将 token-alert.json 的 event 改为 `post-step`，在每步执行后检查 token 用量。语义会略有变化（从"每次 LLM 调用"变为"每步执行后"），但实现成本最低。

### 4.3 决策

采用**方案 A**。理由：
- token 超限警告的语义是"每次 LLM 调用后检查"，post-step 粒度太粗（一步可能多次调用 LLM）
- `on-model-call` 事件对未来其他 Hook（如成本告警、模型切换日志）也有价值

### 4.4 附加：HookConfigRegistry 事件校验

在 `registry.ts` 的 `isValidConfig` 中增加事件白名单校验，拒绝非法事件：

```typescript
const VALID_EVENTS: string[] = [
  'pre-step', 'post-step', 'on-error', 'on-complete',
  'pre-tool-call', 'post-tool-call',
  'on-session-start', 'on-session-end', 'on-model-call',
];

isValidConfig(c: unknown): c is HookConfig {
  return typeof c === 'object' && c !== null
    && typeof c.id === 'string'
    && typeof c.event === 'string'
    && VALID_EVENTS.includes(c.event)  // 新增白名单校验
    && typeof c.command === 'string';
}
```

### 4.5 测试要求

- `on-model-call` 事件在 AgentLoop LLM 调用时正确触发
- token-alert Hook 在 token 超阈值时返回警告
- 非法事件名在 `isValidConfig` 中被拒绝

---

## Task 5：注册 5 个未注册的 CLI 命令（≥ 5 测试）

### 5.1 问题定位

**位置**：`src/cli/App.tsx:143`

5 个命令在 `commands/index.ts` 中导出且有完整 handler，但 App.tsx 的注册数组未包含它们：

| 命令 | 文件 | 功能 |
|---|---|---|
| `/clarify` | `src/cli/commands/clarify.ts` | 需求澄清追问 |
| `/experiment` | `src/cli/commands/experiment.ts` | 实验管理 |
| `/quality` | `src/cli/commands/quality.ts` | 质量仪表盘 |
| `/schedule` | `src/cli/commands/schedule.ts` | 定时任务管理 |
| `/trust` | `src/cli/commands/trust.ts` | 信任级别管理 |

用户输入这些命令会被当作普通消息发给 LLM。

### 5.2 实现方案

在 App.tsx 中补 import 和注册：

```typescript
// src/cli/App.tsx 顶部 import 追加
import {
  // ... 已有 imports
  clarifyCommand,
  experimentCommand,
  qualityCommand,
  scheduleCommand,
  trustCommand,
} from './commands/index.js';

// 第 143 行注册数组追加
[/* 已有命令 */, clarifyCommand, experimentCommand, qualityCommand, scheduleCommand, trustCommand]
  .forEach(c => commandRegistryRef.current.register(c));
```

### 5.3 附加：修复 /clarify 引用不存在的 /clarify-enrich

**位置**：`src/cli/commands/clarify.ts:77-81`

`/clarify` 命令提示用户使用 `/clarify-enrich` 合并回答，但该命令不存在。代码注释承认"交互式收集回答待后续实现"。

**修复**：将提示改为引导用户手动将回答补充到 `/goal` 命令中，移除对不存在命令的引用：

```typescript
// 修改前
messages.push('请回答以上问题后，使用 /clarify-enrich 合并回答到目标。');
messages.push('（当前版本仅展示问题，交互式收集回答待后续实现）');

// 修改后
messages.push('请回答以上问题后，将回答补充到 /goal 命令的目标描述中重新执行。');
```

### 5.4 测试要求

- `/clarify` 命令被 CommandRegistry 识别并执行（不再走 passthrough）
- `/experiment list` 返回实验列表
- `/quality` 显示质量仪表盘
- `/schedule add` 添加定时任务
- `/trust status` 显示信任级别
- `/clarify` 输出不再引用 `/clarify-enrich`

---

## Task 6：清理 11 个未引用的桌面渲染组件（≥ 2 测试）

### 6.1 问题定位

以下 11 个组件在 `desktop/renderer/src/components/` 下完整实现，但全目录 grep 无任何 import（仅 `ProjectSidebar` 被 Layout.tsx 引用）：

| 组件 | 功能 | 处理方式 |
|---|---|---|
| `BranchPanel.tsx` | 分支任务面板 | 删除（功能未接入） |
| `BranchReviewModal.tsx` | 分支审查弹窗 | 删除（功能未接入） |
| `ExperimentReviewModal.tsx` | 实验审查弹窗 | 删除（功能未接入） |
| `MemoryBadge.tsx` | 记忆徽章 | 保留（Phase 45 Task 6 计划使用） |
| `MessageTimeline.tsx` | 消息时间线 | 删除（功能未接入） |
| `QuickStartChips.tsx` | 快速开始选项 | 保留（Phase 45 Task 2 计划使用） |
| `RequirementChangeModal.tsx` | 需求变更弹窗 | 删除（功能未接入） |
| `Sidebar.tsx` | 旧版侧边栏 | 删除（已被 ProjectSidebar 取代） |
| `SubAgentCard.tsx` | 子 Agent 卡片 | 删除（功能未接入） |
| `ThinkingSteps.tsx` | 思考步骤展示 | 删除（功能未接入） |
| `ToolApprovalModal.tsx` | 工具审批弹窗 | 删除（功能未接入） |

### 6.2 实现方案

#### 6.2.1 删除确认无未来使用的 9 个组件

删除以下文件：
- `BranchPanel.tsx`
- `BranchReviewModal.tsx`
- `ExperimentReviewModal.tsx`
- `MessageTimeline.tsx`
- `RequirementChangeModal.tsx`
- `Sidebar.tsx`
- `SubAgentCard.tsx`
- `ThinkingSteps.tsx`
- `ToolApprovalModal.tsx`

#### 6.2.2 保留 2 个有 Phase 45 计划的组件

- `MemoryBadge.tsx` —— Phase 45 Task 6 明确计划使用
- `QuickStartChips.tsx` —— Phase 45 Task 2 明确计划使用

若 Phase 45 尚未实现这些组件的接入，在文件头部添加注释标注待接入状态：

```typescript
/**
 * 待接入：Phase 45 Task 6 计划在 ChatPage 中使用此组件显示记忆徽章
 * 当前未被任何页面引用，保留待 Phase 45 实现
 */
```

### 6.3 测试要求

- 删除 9 个组件后 `pnpm typecheck` 通过（确认无其他文件引用）
- `pnpm build` 成功
- 保留的 2 个组件文件存在且可被 import

---

## Task 7：清理 6 个生产零引用的导出（≥ 2 测试）

### 7.1 问题定位

以下 6 个导出在 `src/` 中完整实现，但生产代码零引用（仅测试文件引用）：

| 导出 | 位置 | 功能 | 处理方式 |
|---|---|---|---|
| `VariablePool` | `src/agent/multi/blackboard-extension.ts:27` | Blackboard 变量池 | 删除文件 |
| `ImplicitFeedbackDetector` | `src/agent/implicit-feedback-detector.ts:51` | 隐式反馈检测 | 删除文件 |
| `HookMarketManager` | `src/hooks/market-manager.ts:65` | Hook 市场管理 | 接入或删除 |
| `CodeStyleAnalyzer` | `src/skills/code-style-analyzer.ts:73` | 代码风格分析 | 接入或删除 |
| `CompactionAuditLog` + `createSandboxedRegistry` | `src/tools/trust-gradient.ts:569,620` | 压缩审计 + 工具阉割 | 删除导出（同文件其他导出保留） |
| `buildFailureReport` + `formatFailureReport` | `src/agent/failure-report.ts:123,143` | 结构化失败报告 | 接入或删除 |

### 7.2 实现方案

#### 7.2.1 删除确认无未来使用的 4 个

- **`VariablePool`**：文件头注释写"由 Orchestrator 注入"但实际未引用，158 行完整实现从未接入。删除整个文件 `blackboard-extension.ts`，同步删除对应测试。
- **`ImplicitFeedbackDetector`**：Phase 40 完整实现但从未被 QualitySignalMiddleware 使用。删除文件，同步删除测试。
- **`CompactionAuditLog` + `createSandboxedRegistry`**：从 `trust-gradient.ts` 中删除这两个导出（保留同文件的 `CompactionBoundary` 和 `createCompactionBoundary`，它们已被 `context-compaction.ts` 引用）。同步删除测试中的对应 import 和用例。
- **`buildFailureReport` + `formatFailureReport`**：AGENTS.md 第 76 行描述了设计意图但生产路径未调用。删除文件 `failure-report.ts`，同步删除测试。

#### 7.2.2 接入有明确使用场景的 2 个

- **`HookMarketManager`**：与已接入的 `SkillMarketManager` 对称，应在 `app-init.ts` 中动态 import 接入，为 Task 2 的 Hook 管理提供市场能力。接线方式参考 `SkillMarketManager`（app-init.ts:742）。
- **`CodeStyleAnalyzer`**：可作为 `file_read` 工具的后处理，提取文件代码风格特征注入项目记忆。接线点在 `src/tools/builtin/file-read.ts` 的 execute 方法末尾。若优先级低可暂缓，在文件头部标注"待接入"。

### 7.3 测试要求

- 删除 4 个导出后 `pnpm typecheck` 通过
- `pnpm test` 中对应测试文件已删除或更新
- `HookMarketManager` 接入后 `app-init.ts` 启动时正确加载（fail-open）
- `pnpm build` 成功

---

## Task 8：清理死测试代码（≥ 0 测试，纯删除）

### 8.1 问题定位

以下 2 个测试文件引用的源文件已被删除，运行测试必然失败：

| 测试文件 | 引用的源文件 | 状态 |
|---|---|---|
| `tests/agent/declarative-context.test.ts:8` | `src/agent/declarative-context.ts` | 源文件已删除 |
| `tests/agent/entity-state.test.ts:9` | `src/agent/entity-state.ts` | 源文件已删除 |

### 8.2 实现方案

删除这 2 个测试文件。

### 8.3 验证

- `pnpm test` 不再出现这两个文件的失败
- `pnpm typecheck` 通过

---

## Task 9：文档同步（≥ 0 测试，纯文档）

### 9.1 问题定位

以下文档条目已过时，与代码现状不符：

| 文档 | 位置 | 过时内容 |
|---|---|---|
| `AGENTS.md` | 第 66 行 陷阱 #22 | 标注 `declarative-context.ts`、`entity-state.ts` 为"死代码未接入"，但源文件已删除；同时标注 `eq-detector.ts`、`voice-manager.ts`、`persona-engine.ts`、`preference-manager.ts`、`vision.ts`、`concise-thinking.ts` 为"死代码"，但实际已通过 app-init.ts 动态 import 接入 |
| `CODEMAP.md` | 第 95-96 行 | 仍列出 `entity-state.ts`、`declarative-context.ts` 条目 |
| `config.example.yaml` | 第 134-137 行 | 仍有 `structuredState.enabled` 和 `declarativeContext.enabled` 配置项 |
| `EXECUTION_REPORTS.md` | 第 121-132 行 | 仍记录这两个功能已完成 |

### 9.2 实现方案

#### 9.2.1 更新 AGENTS.md 陷阱 #22

将第 66 行的描述更新为：

```markdown
22. **实验性优化功能默认关闭**：`optimization.structuredState`/`declarativeContext` 两项已在 Phase 46 中随源文件删除一并清理（功能废弃，不再维护）。`conciseThinking` 默认 `false`，`tokenTracking` 默认 `true`。`eq-detector`/`voice-manager`/`persona-engine`/`preference-manager`/`vision`/`concise-thinking` 已通过 app-init.ts 动态 import + fail-open 接入生产路径，不再是死代码
```

#### 9.2.2 更新 CODEMAP.md

删除 `entity-state.ts` 和 `declarative-context.ts` 的条目。

#### 9.2.3 更新 config.example.yaml

删除 `structuredState.enabled` 和 `declarativeContext.enabled` 配置项及注释。

#### 9.2.4 更新 EXECUTION_REPORTS.md

在对应 Phase 报告中追加备注："Phase 46 已废弃 declarative-context / entity-state 模块，源文件与测试已删除"。

#### 9.2.5 追加 Phase 46 陷阱警告

在 AGENTS.md 的陷阱列表末尾追加本 Phase 新增陷阱（见下文"新增陷阱警告"章节）。

### 9.3 验证

- 文档中不再引用已删除的文件
- `grep -r "declarative-context\|entity-state" AGENTS.md CODEMAP.md config.example.yaml` 无残留（EXECUTION_REPORTS.md 中的历史记录保留，但需标注已废弃）

---

## Task 10：集成测试与最终验证（≥ 6 测试）

### 10.1 端到端验证

1. **IPC 桥接端到端**：用户在设置页点击"安装 CodeGraph" → IPC 调用 `engine.installCodeGraph()` → 底层 CodeGraphManager 执行 → 返回 `{ success: true }` → UI 显示成功
2. **Hook 执行端到端**：用户通过 UI 创建 Hook（post-tool-call 事件，command `echo {{toolName}}`）→ 保存到磁盘 → 重启应用 → 执行任意工具 → Hook 被触发 → 日志中看到 echo 输出
3. **CLI 命令端到端**：用户输入 `/schedule add "每日构建" "0 8 * * *" "build"` → 命令被识别并执行 → 定时任务列表中可见
4. **远程市场端到端**：用户配置 `market.registryUrl` → 点击"从市场安装 Skill" → 返回 Skill 列表 → 选择安装 → 安装成功
5. **token-alert 端到端**：配置 token-alert Hook → LLM 调用使 token 超阈值 → Hook 触发 → 用户收到警告
6. **死代码清理验证**：`pnpm typecheck` + `pnpm test` + `pnpm build` 全部通过，无未引用的导出警告

### 10.2 回归测试

- 所有现有测试仍通过（除 Task 8 删除的 2 个死测试）
- 桌面应用启动正常，无新增 console error
- CLI 所有原有命令仍可用

---

## 新增陷阱警告

**126. IPC handler 桥接后必须保留 fail-open：** `RouteDevEngine` 中新增的 `installCodeGraph`/`adoptExperiment`/`toggleHook` 等方法，在底层管理器（ExperimentManager/HookRegistry/CodeGraphManager）未加载或加载失败时，必须返回空数组/默认值而非抛错。desktop 主进程的装配路径与 CLI 的 app-init.ts 不同，不能假设底层一定存在。

**127. HookConfig → HookDefinition 转换必须做变量替换而非字符串拼接：** `{{filePath}}` 等变量必须用正则替换，不能用 `template + ctx.filePath`，否则变量不存在时会留下 `{{filePath}}` 字面量传给 shell，导致命令语法错误。同时必须转义路径中的空格和特殊字符（Windows 路径常见）。

**128. Hook shell command 必须设超时：** `executeShellCommand` 必须设 timeout（默认 5 秒），否则一个卡死的 Hook 会阻塞整个 Agent Loop。超时后中止子进程并返回 `{ action: 'continue' }` 不阻断主流程。

**129. on-model-call 事件触发点必须在 LLM 调用前 fire：** token-alert 需要在调用前检查预算，而不是调用后。若在调用后 fire，超限的 token 已经消耗。触发点在 `loop.ts` 的 `callLLMStream` 之前。

**130. HttpRegistryClient 必须校验 registryUrl 格式：** 用户可能输入不带 `http://`/`https://` 前缀的 URL，或输入带尾斜杠的 URL。构造函数中必须规范化（补全协议前缀、去除尾斜杠），否则 fetch 会抛 `Invalid URL`。

**131. 删除导出时必须检查同文件其他导出：** `trust-gradient.ts` 中 `CompactionAuditLog`/`createSandboxedRegistry` 是死代码，但同文件的 `CompactionBoundary`/`createCompactionBoundary` 已被 `context-compaction.ts` 引用。删除时只删导出不删文件，且必须跑 typecheck 验证。

**132. HookMarketManager 接线必须与 HookConfigRegistry 共存：** `HookMarketManager` 负责远程市场的发布/安装/卸载，`HookConfigRegistry` 负责本地配置的加载/保存。两者操作同一份 `.routedev/hooks.json`，必须用文件锁或 debounce 写入避免冲突。安装远程 Hook 后必须调用 `hookRegistry.load()` 重新加载。

---

## 思考引导总结

1. **为什么不直接删除桩实现 IPC handler，而是接线？** 底层 ExperimentManager/HookRegistry/CodeGraphManager 已完整实现，删除 IPC handler 等于废弃这些功能。接线成本远低于重写，且用户 UI 已经依赖这些 IPC。

2. **Hook 接线为什么不在 Phase 39 当时就做？** Phase 39 专注于"代码地图增强与 Skill 自动化与分支合并工作流"，Hook 接线被列为"待后续实现"。本 Phase 是收尾，正好补上。

3. **HttpRegistryClient 为什么不引入 axios？** Node 18+ 内置 fetch 已足够，引入新依赖违反"不引入新依赖"原则，且增加包体积。

4. **死代码清理的判断标准是什么？** 三条标准：(1) 生产代码零引用（排除测试）；(2) 无明确的未来使用计划（如 Phase 45 计划使用的 MemoryBadge 保留）；(3) 删除后 typecheck + build 通过。三条都满足才删。

5. **/clarify-enrich 为什么不实现而是移除引用？** 交互式多轮输入需要 CommandBridge 支持，属于新功能开发，超出本 Phase "清零收尾"的范围。移除对不存在命令的引用，避免误导用户。

6. **执行顺序建议：** Task 8（删死测试，最快见效） → Task 5（注册命令，一行改动） → Task 4（修复事件类型） → Task 1（IPC 桥接） → Task 2（Hook 接线） → Task 3（HTTP Client） → Task 6（删组件） → Task 7（删导出） → Task 9（文档同步） → Task 10（集成测试）。Task 1 和 Task 2 可并行，Task 6 和 Task 7 可并行。

7. **本 Phase 完成后的状态：** 代码库达到"所见即所用"——任何 UI 入口都能走通后端，任何 CLI 命令都能被执行，任何导出都有消费者，任何文档都反映现状。后续 Phase 可在此基础上安心扩展，无需再担心踩到死代码的坑。
