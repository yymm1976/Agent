# Phase 22 — Plugin 系统

> **Phase 类型：** 新功能（Feature）
> **前置依赖：** Phase 17b（AgentMiddlewarePipeline 已就绪，命令体系已收束）
> **目标版本：** v0.20.0
> **蓝图引用：** Section 4.4 自定义插件（主题/工具/Hook/路由）、design-routedev-spec2 Section 1.6

---

## 背景

蓝图规定 RouteDev 支持四种插件类型——主题（theme）、工具（tool）、钩子（hook）、路由（router）。插件在不修改核心代码的前提下扩展 RouteDev 的能力。Phase 17b 已交付 `AgentMiddlewarePipeline`（五阶段中间件管线），为 Hook 插件提供挂载基础；`ToolRegistry` 从 Phase 6 起就支持动态注册。本 Phase 把零散的扩展点收拢为统一的插件架构。

**核心原则：**
- 插件错误不崩溃宿主——所有插件代码在 try-catch 隔离中执行
- 插件通过 `routedev-plugin.json` 清单声明能力，运行时动态 `import()` 加载
- SDK 提供类型安全的 `define*Plugin()` 辅助函数，降低开发门槛
- `/plugin` 命令让用户在 CLI 中管理插件

**新增模块：** `src/plugins/` 目录（types.ts + registry.ts + sdk.ts + index.ts）和 `src/cli/commands/plugin.ts`。

**插件目录扫描路径：**
1. `~/.qoderwork/routedev/plugins/`（全局，Windows: `%APPDATA%/RouteDev/plugins/`）
2. `<cwd>/.routedev/plugins/`（项目级）

---

## 接口对齐观察表

以下签名已通过代码验证，Phase 中的引用必须与此一致：

| 接口 / 类 | 当前签名 | 文件位置 | 本 Phase 引用方式 |
|---|---|---|---|
| `ToolRegistry.register(tool)` | `register(tool: ITool): void` | `src/tools/registry.ts` | ToolPlugin 通过此方法注入工具 |
| `ToolRegistry.unregister(name)` | `unregister(name: string): void` | `src/tools/registry.ts` | ToolPlugin 卸载时注销工具 |
| `ToolRegistry.list()` | `list(): ITool[]` | `src/tools/registry.ts` | `/plugin info` 查询插件注册的工具 |
| `ITool` | `{ readonly definition: ToolDefinition; execute(args, ctx): Promise<ToolResult>; validateArgs(args): { valid, errors } }` | `src/tools/types.ts` | SDK 的 `defineToolPlugin` 生成符合此接口的对象 |
| `ToolDefinition` | `{ name, description, parameters: ToolParameterSchema, requiresApproval, category }` | `src/tools/types.ts` | 插件声明工具时必须填全字段 |
| `AgentMiddlewarePipeline` | `register(phase, handler): void` / `execute(phase, ctx): Promise<void>` | `src/agent/middleware.ts` | HookPlugin 通过 register 注入中间件 |
| `MiddlewarePhase` | `'onAgent' \| 'onReasoning' \| 'onActing' \| 'onModelCall' \| 'onSystemPrompt'` | `src/agent/middleware.ts` | HookPlugin 选择挂载阶段 |
| `MiddlewareHandler` | `(ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>` | `src/agent/middleware.ts` | SDK 的 `defineHookPlugin` 包装此类型 |
| `CommandDefinition` | `{ name, aliases?, description, usage?, handler: (args, ctx) => Promise<CommandHandlerResult> }` | `src/cli/command-registry.ts` | `/plugin` 命令按此格式注册 |
| `CommandHandlerResult` | `{ type: 'handled'; messages?: string[] } \| { type: 'passthrough'; input: string }` | `src/cli/command-registry.ts` | `/plugin` 各子命令的返回值 |
| `ScenarioClassifier` | `classify(input: ClassificationInput): Promise<ClassificationResult>` | `src/router/classifier.ts` | RouterPlugin 替换/增强此逻辑 |
| `ClassificationInput` | `{ query: string; context?: { projectType?, ... } }` | `src/router/types.ts` | RouterPlugin 的输入 |
| `ClassificationResult` | `{ tier: ScenarioTier; confidence: number; reasoning: string; source: 'rule' \| 'llm' }` | `src/router/types.ts` | RouterPlugin 的输出 |
| `ServiceContext` | 25 字段接口（config, clientManager, router, tracker, agentLoop, checkpointManager, mcpManager, commandBridge 等） | `src/cli/service-context.ts` | Task 5 新增 `pluginRegistry?: PluginRegistry` 字段 |
| `StatusBar` props | `{ currentModel, currentTier, isDegraded, todayTokensUsed, autonomyMode, workMode }` | `src/cli/components/StatusBar.tsx` | ThemePlugin 可能自定义渲染（预留，本 Phase 不修改） |

---

## Task 1：插件类型系统

> **目标：** 定义所有插件相关的基础类型，作为后续 Task 的类型契约。

**文件：** 创建 `src/plugins/types.ts` + `src/plugins/index.ts`

- [ ] **Step 1：定义 Plugin 基础接口与四种特化类型**

```typescript
// src/plugins/types.ts
import type { ITool } from '../tools/types.js';
import type { MiddlewarePhase, MiddlewareHandler } from '../agent/middleware.js';
import type { ClassificationInput, ClassificationResult } from '../router/types.js';

export type PluginType = 'theme' | 'tool' | 'hook' | 'router';

export interface Plugin {
  readonly id: string;   // `${type}-${name}`
  readonly name: string;
  readonly version: string;
  readonly type: PluginType;
  enabled: boolean;
  init(context: PluginInitContext): Promise<void>;
  destroy(): Promise<void>;
}

export interface PluginInitContext {
  cwd: string;
  config: Record<string, unknown>;
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export interface ThemePlugin extends Plugin {
  readonly type: 'theme';
  renderStatusBar?: (props: Record<string, unknown>) => unknown;
  colors?: Partial<ThemeColors>;
}
export interface ThemeColors {
  primary: string; secondary: string; accent: string;
  background: string; text: string; error: string; success: string;
}

export interface ToolPlugin extends Plugin {
  readonly type: 'tool';
  getTools(): ITool[];
}

export interface HookPlugin extends Plugin {
  readonly type: 'hook';
  getHooks(): Array<{ phase: MiddlewarePhase; handler: MiddlewareHandler }>;
}

export interface RouterPlugin extends Plugin {
  readonly type: 'router';
  classify(input: ClassificationInput): Promise<ClassificationResult | null>;
}

export interface PluginManifest {
  id: string; name: string; version: string;
  description?: string; author?: string; type: PluginType;
  entry: string;   // 入口文件（默认 index.js）
  configSchema?: Record<string, unknown>;
  minHostVersion?: string;
}

export interface PluginStatus {
  id: string; name: string; version: string; type: PluginType;
  enabled: boolean; loaded: boolean; error?: string;
  registeredTools?: string[];
  registeredHooks?: MiddlewarePhase[];
}
```

- [ ] **Step 2：创建 `src/plugins/index.ts`** — `export * from './types.js'; export * from './registry.js'; export * from './sdk.js';`
- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build && pnpm typecheck
git add src/plugins/types.ts src/plugins/index.ts
git commit -m "feat(plugins): add plugin type system with four plugin variants"
```

---

## Task 2：插件注册表（PluginRegistry）

> **目标：** 实现插件的发现、加载、生命周期管理。核心要求：插件错误不崩溃宿主。

**文件：** 创建 `src/plugins/registry.ts`

- [ ] **Step 1：实现 PluginRegistry 类**

```typescript
// src/plugins/registry.ts — 关键方法签名

export interface PluginRegistryOptions {
  globalPluginDirs: string[];   // 全局插件目录
  projectPluginDir: string;     // 项目级插件目录
  toolRegistry: ToolRegistry;
  middlewarePipeline: AgentMiddlewarePipeline;
  cwd: string;
}

export class PluginRegistry {
  private plugins = new Map<string, { instance: Plugin; manifest: PluginManifest }>();

  // 发现：扫描目录，读 routedev-plugin.json，目录不存在时静默跳过
  async discover(): Promise<PluginManifest[]>

  // 加载：await import(entryFile)，外层 try-catch，失败只记 status.error
  async loadPlugin(manifest: PluginManifest, pluginDir: string): Promise<void>

  // 初始化：逐个 plugin.init()，单个失败不阻塞其他
  // 加载后自动：ToolPlugin.getTools() → toolRegistry.register()
  //             HookPlugin.getHooks() → middlewarePipeline.register()
  async initAll(): Promise<void>

  // 销毁：逆序调用 plugin.destroy()
  async destroyAll(): Promise<void>

  // 管理：enable 时重新注册工具/钩子，disable 时 unregister
  enable(pluginId: string): boolean
  disable(pluginId: string): boolean

  // 查询
  listStatuses(): PluginStatus[]
  getPluginStatus(pluginId: string): PluginStatus | null
  getEnabledByType(type: PluginType): Plugin[]
  getActiveRouterPlugin(): RouterPlugin | null  // 同一时刻最多一个生效
}
```

**执行人注意：**
- 发现阶段用 `fs.readdir` + `fs.readFile` 读清单，目录不存在不报错
- 加载阶段：动态 import 的导出约定为 `default export` 或命名导出 `plugin`
- `initAll()` 内部在调用 `plugin.init()` 之后，根据 `plugin.type` 自动桥接：
  - `'tool'` → `(plugin as ToolPlugin).getTools().forEach(t => toolRegistry.register(t))`
  - `'hook'` → `(plugin as HookPlugin).getHooks().forEach(h => middlewarePipeline.register(h.phase, h.handler))`
- `disable()` 时调用 `toolRegistry.unregister()` 移除该插件注册的工具

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build && pnpm typecheck
git add src/plugins/registry.ts
git commit -m "feat(plugins): add PluginRegistry with discover/load/lifecycle management"
```

---

## Task 3：插件 SDK

> **目标：** 提供类型安全的辅助函数，让插件作者用最少代码创建合规插件。

**文件：** 创建 `src/plugins/sdk.ts`

- [ ] **Step 1：实现四个 define*Plugin 辅助函数**

```typescript
// src/plugins/sdk.ts

/** 简化工具定义（SDK 自动填充 category='system', requiresApproval=false, validateArgs=always-valid） */
interface SimpleToolDef {
  name: string; description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  requiresApproval?: boolean; category?: ToolDefinition['category'];
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

// 将 SimpleToolDef[] 包装为 ITool[]，返回完整 ToolPlugin（id=`tool-${name}`, version='1.0.0', 空 init/destroy）
export function defineToolPlugin(name: string, tools: SimpleToolDef[]): ToolPlugin

export function defineHookPlugin(name: string, hooks: Array<{ phase: MiddlewarePhase; handler: MiddlewareHandler }>): HookPlugin

interface ThemeDef { colors?: Partial<ThemeColors>; renderStatusBar?: (props: any) => unknown; }
export function defineThemePlugin(name: string, theme: ThemeDef): ThemePlugin

export function defineRouterPlugin(name: string, classifier: (input: ClassificationInput) => Promise<ClassificationResult | null>): RouterPlugin
```

**执行人注意：** 所有 `define*` 函数是纯函数，无副作用。`id` 自动生成为 `${type}-${name}`。`version` 默认 `'1.0.0'`。`init()` 和 `destroy()` 为空 async 函数。
- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build && pnpm typecheck
git add src/plugins/sdk.ts
git commit -m "feat(plugins): add SDK helpers for type-safe plugin definitions"
```

---

## Task 4：Plugin CLI 命令

> **目标：** 实现 `/plugin` 命令及子命令，让用户在 CLI 中管理插件。

**文件：** 创建 `src/cli/commands/plugin.ts`

- [ ] **Step 1：实现 /plugin 命令**

```typescript
// src/cli/commands/plugin.ts
export const pluginCommand: CommandDefinition = {
  name: 'plugin', aliases: ['plugins'],
  description: '插件管理',
  usage: '/plugin list | /plugin enable <name> | /plugin disable <name> | /plugin info <name>',
  handler: async (args, ctx) => {
    const [sub = 'list', name] = args.trim().split(/\s+/);
    const reg = ctx.pluginRegistry;
    if (!reg) return { type: 'handled', messages: ['插件系统未初始化。'] };
    switch (sub) {
      case 'list': {
        const s = reg.listStatuses();
        if (!s.length) return { type: 'handled', messages: ['暂无已安装的插件。\n将插件放入 ~/.qoderwork/routedev/plugins/ 目录即可。'] };
        return { type: 'handled', messages: [['已安装插件:', ...s.map(p =>
          `  ${p.error ? '[ERR]' : p.enabled ? '[ON] ' : '[OFF]'} ${p.name} v${p.version} (${p.type})`
        )].join('\n')] };
      }
      case 'enable':
        if (!name) return { type: 'handled', messages: ['用法: /plugin enable <name>'] };
        return { type: 'handled', messages: [reg.enable(name) ? `插件 ${name} 已启用。` : `插件 ${name} 不存在或启用失败。`] };
      case 'disable':
        if (!name) return { type: 'handled', messages: ['用法: /plugin disable <name>'] };
        return { type: 'handled', messages: [reg.disable(name) ? `插件 ${name} 已禁用。` : `插件 ${name} 不存在或禁用失败。`] };
      case 'info': {
        if (!name) return { type: 'handled', messages: ['用法: /plugin info <name>'] };
        const s = reg.getPluginStatus(name);
        if (!s) return { type: 'handled', messages: [`插件 ${name} 不存在。`] };
        return { type: 'handled', messages: [[
          `插件: ${s.name} v${s.version}`, `类型: ${s.type}`,
          `状态: ${s.enabled ? '已启用' : '已禁用'}${s.error ? ' (错误)' : ''}`,
          s.registeredTools?.length ? `工具: ${s.registeredTools.join(', ')}` : '',
          s.registeredHooks?.length ? `Hook: ${s.registeredHooks.join(', ')}` : '',
          s.error ? `错误: ${s.error}` : '',
        ].filter(Boolean).join('\n')] };
      }
      default:
        return { type: 'handled', messages: ['用法: /plugin list | enable <name> | disable <name> | info <name>'] };
    }
  },
};
```

- [ ] **Step 2：在 `src/cli/commands/index.ts` 添加 `export * from './plugin.js';`**

- [ ] **Step 3：在 App.tsx CommandRegistry 初始化处注册 `pluginCommand`**

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build && pnpm typecheck
git add src/cli/commands/plugin.ts src/cli/commands/index.ts src/cli/App.tsx
git commit -m "feat(cli): add /plugin command with list/enable/disable/info subcommands"
```

---

## Task 5：集成 + 测试

> **目标：** 将 PluginRegistry 接入 App 启动流程，扩展 ServiceContext，编写测试覆盖四种插件类型。

### Step 1：扩展 ServiceContext

**文件：** 修改 `src/cli/service-context.ts`

在 `ServiceContext` 接口中新增：
```typescript
pluginRegistry?: PluginRegistry;  // 可选——插件系统初始化失败时为 undefined
```

在 `createServiceContext` 参数列表新增 `pluginRegistry?: PluginRegistry`，传入 ctx。

### Step 2：App.tsx 启动流程集成

在 `buildServiceContext`（或 `useEffect` 初始化阶段）中：

```typescript
// 1. 创建 AgentMiddlewarePipeline（如 Phase 17b 未在 App 中创建，此处补上）
const middlewarePipeline = new AgentMiddlewarePipeline();

// 2. 创建 PluginRegistry
const pluginRegistry = new PluginRegistry({
  globalPluginDirs: [path.join(os.homedir(), '.qoderwork', 'routedev', 'plugins')],
  projectPluginDir: path.join(cwd, '.routedev', 'plugins'),
  toolRegistry, middlewarePipeline, cwd,
});

// 3. 发现 + 加载 + 初始化（整个块 try-catch，失败不影响启动）
try {
  for (const m of await pluginRegistry.discover()) {
    await pluginRegistry.loadPlugin(m, /* pluginDir */);
  }
  await pluginRegistry.initAll();
} catch (error) {
  logger.error('Plugin system init failed', { error: error instanceof Error ? error.message : String(error) });
}
```

### Step 3：App 退出时销毁

在 quit 命令或 `process.on('SIGINT')` 中调用 `await pluginRegistry?.destroyAll();`

### Step 4：单元测试

| # | 测试用例 | 验证点 |
|---|---------|--------|
| 1 | `defineToolPlugin` 返回合法 ToolPlugin | `type === 'tool'`，`getTools()` 返回 ITool[] |
| 2 | `defineHookPlugin` 返回合法 HookPlugin | `type === 'hook'`，`getHooks()` 含 phase + handler |
| 3 | `defineThemePlugin` 返回合法 ThemePlugin | `type === 'theme'`，colors 正确合并 |
| 4 | `defineRouterPlugin` 返回合法 RouterPlugin | `type === 'router'`，`classify()` 可调 |
| 5 | `discover()` 空目录 | 返回空数组，不抛异常 |
| 6 | `discover()` 含无效清单 | 跳过无效项，返回有效清单 |
| 7 | `loadPlugin()` 入口文件不存在 | `status.error` 有值，进程不崩溃 |
| 8 | `initAll()` 单个插件 init 抛异常 | 其他插件正常初始化 |
| 9 | `enable` / `disable` | 状态切换正确，ToolPlugin 的工具注册/注销 |
| 10 | `destroyAll()` 逆序调用 | destroy 按注册逆序执行 |
| 11 | 集成：加载 sample tool plugin | `ToolRegistry.has(pluginToolName) === true` |
| 12 | `/plugin list` 命令 | 返回 `'handled'` + 插件列表字符串 |
| 13 | `/plugin info <name>` 命令 | 返回插件详情 |

### Step 5：创建 sample plugin 用于集成测试

```
tests/fixtures/sample-plugin/
  ├── routedev-plugin.json   — { "id": "sample-tool", "name": "Sample", "version": "1.0.0", "type": "tool", "entry": "index.js" }
  └── index.js               — 导出一个 defineToolPlugin 生成的 ToolPlugin
```

### Step 6：运行全量测试 → 提交

```powershell
npx vitest run
pnpm build && pnpm typecheck
git add src/plugins/ src/cli/commands/plugin.ts src/cli/service-context.ts src/cli/App.tsx tests/plugins/ tests/fixtures/
git commit -m "feat(plugins): integrate PluginRegistry into App + add comprehensive tests"
git push origin main
```

---

## 对下一阶段的提醒

1. **ThemePlugin 渲染接入**：StatusBar.tsx / ChatView.tsx 尚未读取 ThemePlugin 配置，需添加 theme context 消费逻辑
2. **RouterPlugin 与 ModelRouter 集成**：`ModelRouter.route()` 尚未检查路由插件，需添加"先问 RouterPlugin，null 则 fallback 默认分类器"
3. **插件状态持久化**：enable/disable 状态只存在内存，重启丢失。需持久化到 `plugins-state.json`
4. **插件热加载**：当前仅启动时加载。后续可 `fs.watch` 插件目录自动 reload
5. **插件市场**：蓝图提到"插件市场（可选）"——可对接 npm registry 或自建索引
6. **插件沙箱**：当前插件与宿主共享进程，远期可用 Worker Threads 隔离
7. **AgentMiddlewarePipeline 前置依赖**：如 Phase 17b Task 8 未执行，需先补完 `src/agent/middleware.ts`
8. **Windows 路径兼容**：全局目录用 `os.homedir()` + `path.join()`，不硬编码 `~`
