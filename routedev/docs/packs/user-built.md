# 用户自建 Pack 指南

> 本文档介绍如何为 RouteDev 开发自定义能力 Pack（CapabilityPack）。
>
> Pack 是 RouteDev Phase 82 引入的轻量扩展机制，比传统 Plugin 更简洁：
> 无需清单注册调用，文件系统即注册表——把 Pack 目录放到约定位置即自动发现。

---

## 1. Pack 目录结构

RouteDev 按以下优先级扫描 Pack 目录（高优先级覆盖低优先级）：

| 优先级 | 来源 | 扫描路径 | 说明 |
|--------|------|----------|------|
| 1（最高） | 项目级 | `<cwd>/.routedev/packs/<name>/` | 跟随项目，团队共享 |
| 2 | 全局 | `~/.routedev/packs/<name>/` | 用户级，跨项目可用 |
| 3（最低） | 内置 | `src/plugins/packs/` | RouteDev 自带，不可覆盖 |

每个 Pack 是一个独立目录，至少包含两个文件：

```
.routedev/packs/my-custom-pack/
├── pack.json     # 元数据声明
└── index.ts      # 入口文件，默认导出 CapabilityPack
```

**同名 Pack（按 `id` 去重）**：项目级覆盖全局，全局覆盖内置。例如你在项目级和全局都放了 `id: "pack.linter"` 的 Pack，只有项目级的会生效。

---

## 2. pack.json 格式

`pack.json` 声明 Pack 的元数据，字段如下：

```json
{
  "id": "pack.my-custom",
  "layer": "extended",
  "description": "我的自定义 Pack",
  "costHint": "启用后会注入 1 个工具与 1 个命令，约增加 200 token"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | Pack 唯一标识，建议以 `pack.` 前缀避免与内置能力冲突 |
| `layer` | string | 是 | 能力分层：`extended`（高级区）或 `standard`（扩展区） |
| `description` | string | 是 | 人类可读描述，展示在设置页 |
| `costHint` | string | 是 | 启用成本提示，告知用户 token/性能影响 |

> **注意**：`pack.json` 中的 `id` 必须与 `index.ts` 默认导出对象的 `id` 字段一致，否则该 Pack 会被跳过并记录警告。

---

## 3. index.ts 入口文件

`index.ts` 是 Pack 的入口，**默认导出**一个符合 `CapabilityPack` 接口的对象：

```typescript
import type { CapabilityPack, PackContext } from '../../../src/plugins/capability-pack.js';

const myPack: CapabilityPack = {
  id: 'pack.my-custom',
  configKey: 'myCustom',  // 对应 config.packs.myCustom.enabled
  layer: 'extended',
  description: '我的自定义 Pack',
  costHint: '约增加 200 token',
  defaultEnabled: false,  // 用户需手动启用

  // 启用时调用：在此注册工具、命令、事件钩子
  async register(ctx: PackContext) {
    ctx.tools.register(myTool);
    ctx.commands.register('my.cmd', myCommandHandler);
    ctx.events.on('tool_call', myHook);
  },

  // 禁用时调用（可选）：清理注册项
  async unregister(ctx: PackContext) {
    ctx.tools.unregister(myTool.definition.name);
    ctx.commands.unregister('my.cmd');
    ctx.events.off('tool_call', myHook);
  },
};

export default myPack;
```

### CapabilityPack 接口

```typescript
export interface CapabilityPack {
  /** Pack 唯一标识（与 pack.json 的 id 一致） */
  id: string;
  /** 对应 config.packs 的 key（如 'myCustom'），用于读取启用状态 */
  configKey: string;
  /** 能力分层：extended | standard */
  layer: PackLayer;
  /** 人类可读描述 */
  description: string;
  /** 启用成本提示 */
  costHint: string;
  /** 默认是否启用（用户自建 Pack 必须为 false） */
  defaultEnabled: false;
  /** 启用时调用：注册工具/命令/钩子 */
  register(ctx: PackContext): Promise<void> | void;
  /** 禁用时调用（可选）：清理注册项 */
  unregister?(ctx: PackContext): Promise<void> | void;
}
```

---

## 4. PackContext API

`PackContext` 是 Pack 与宿主交互的唯一通道。用户 Pack 注册的工具**受 PermissionEngine 管控**——宿主会自动在工具执行前进行权限检查，Pack 无需自行实现权限逻辑。

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `tools` | `ToolRegistry` | 工具注册表，调用 `.register(tool)` / `.unregister(name)` / `.has(name)` |
| `commands` | `CommandRegistry` | 命令注册表，调用 `.register(name, handler)` / `.unregister(name)` / `.has(name)` |
| `events` | `PackEventBus` | 事件总线，调用 `.on(event, handler)` / `.off(event, handler)` / `.emit(event, payload)` |
| `config` | `AppConfig` | 全局配置（只读） |
| `logger` | `Logger` | 宿主日志接口（info / warn / error / debug） |
| `usage` | `UsageCounter` | 使用计数器，调用 `.increment({ kind, name, action })` |

### CommandHandler 签名

```typescript
type CommandHandler = (args: string) => Promise<string> | string;
```

命令处理器接收原始参数字符串，返回文本结果。

### 支持的事件钩子（PackEventType）

| 事件 | 触发时机 | 用途 |
|------|----------|------|
| `tool_call` | 工具调用前后 | 参数预处理、审计日志 |
| `message` | 消息收发 | 消息拦截、日志记录 |
| `turn_start` | Agent 回合开始 | 上下文注入 |
| `turn_end` | Agent 回合结束 | 状态清理 |
| `pack_load` | Pack 加载 | 加载后初始化 |
| `pack_unload` | Pack 卸载 | 卸载前清理 |

---

## 5. 完整示例

以下示例注册一个自定义工具、一个命令、一个事件钩子。完整可运行版本见 [`example-pack/`](./example-pack/)。

```typescript
import type { CapabilityPack, PackContext } from '../../../src/plugins/capability-pack.js';

const myPack: CapabilityPack = {
  id: 'pack.example',
  configKey: 'example',
  layer: 'extended',
  description: '示例 Pack：工具 + 命令 + 钩子',
  costHint: '约增加 300 token',
  defaultEnabled: false,

  async register(ctx: PackContext) {
    // 1. 注册自定义工具——自动受 PermissionEngine 管控
    ctx.tools.register({
      definition: {
        name: 'example_echo',
        description: '原样返回输入',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        requiresApproval: false,
        category: 'system',
      },
      validateArgs(args) {
        return typeof args.message === 'string'
          ? { valid: true }
          : { valid: false, message: 'message 必须是字符串', errorCode: 1 };
      },
      async execute(args) {
        return { success: true, output: String(args.message), durationMs: 0 };
      },
    });

    // 2. 注册斜杠命令（handler 返回 string）
    ctx.commands.register('example.greet', async (args) => {
      const name = args?.trim() || 'world';
      ctx.logger.info(`Hello, ${name}!`);
      return `Hello, ${name}!`;
    });

    // 3. 监听事件钩子：工具调用时记录审计日志
    ctx.events.on('tool_call', (payload) => {
      ctx.logger.debug('[example-pack] 工具调用', { payload });
    });

    ctx.logger.info('example-pack 已注册');
  },

  async unregister(ctx: PackContext) {
    ctx.tools.unregister('example_echo');
    ctx.commands.unregister('example.greet');
    ctx.logger.info('example-pack 已卸载');
  },
};

export default myPack;
```

---

## 6. 调试与故障排查

### Pack 未被发现

1. 确认目录结构：`.routedev/packs/<name>/pack.json` + `index.ts`
2. 检查 `pack.json` 的四个必填字段（`id` / `layer` / `description` / `costHint`）是否齐全
3. 查看 `%APPDATA%/RouteDev/logs/combined.log` 中 `[pack-discovery]` 前缀的警告日志

### Pack 加载失败（fail-open）

RouteDev 采用 **fail-open** 策略：单个 Pack 加载失败不会阻断其他 Pack 发现，也不会崩溃 Core。常见原因：

- `index.ts` 语法错误
- 默认导出不是合法的 `CapabilityPack` 对象
- `pack.id` 与 `pack.json` 的 `id` 不一致

### 权限被拒

用户 Pack 注册的工具自动受 PermissionEngine 管控。如果工具被拒绝执行，检查：

- `config.security` 中的路径白名单/命令白名单
- 工具的 `requiresApproval` 设置（写操作建议设为 `true`）

---

## 7. 与传统 Plugin 的区别

| 维度 | CapabilityPack（Phase 82） | Plugin（Phase 22） |
|------|---------------------------|-------------------|
| 发现方式 | 文件系统约定，零配置 | routedev-plugin.json 清单 |
| 入口导出 | 默认导出对象 | default 或命名导出 plugin |
| 权限模型 | 自动受 PermissionEngine 管控 | 声明式 permissions 字段 |
| 适用场景 | 轻量能力扩展（工具/命令/钩子） | 完整插件（含主题/路由） |
| 失败策略 | fail-open，不阻断 Core | fail-open，不阻断宿主 |

对于仅需注册工具/命令/钩子的场景，推荐使用 Pack；需要自定义路由或主题时使用 Plugin。
