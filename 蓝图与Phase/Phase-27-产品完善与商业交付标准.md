# Phase 27 — 产品完善与商业交付标准

> **Phase 类型：** 功能收束 + 产品打磨（Feature Convergence + Product Polish）
> **前置依赖：** Phase 26 完成（v1.3.0，技术债务已清零）
> **目标版本：** v1.4.0
> **核心目标：** 实现所有蓝图规定的"必须"功能，补全所有遗留缺口，将产品从"开发者可用"提升到"用户可交付"

---

## 背景

Phase 26 清零了技术债务，代码库达到了商业级工程标准。但仍有一批"已创建但未接入"或"蓝图要求但未实现"的功能模块：

1. **DurableExecutor 未接入主循环**——模块已创建（668 行），但 App.tsx 未实例化它，StatusBar 的 `durableSnapshot` prop 未传入数据
2. **RouterPlugin 未集成**——`ModelRouter.route()` 从未检查 RouterPlugin，插件的路由替换能力形同虚设
3. **ThemePlugin 未渲染**——设计系统已就绪，但 StatusBar/ChatView 未读取 ThemePlugin 配置
4. **notes.md 未实现**——蓝图 Section X.1 规定的"Agent 唯一写通道"，12 个 Phase 过去仍未创建
5. **DiffView 动作未绑定**——`[A]/[R]/[S]` 按钮纯展示，未接入 git apply/reject
6. **插件状态不持久化**——enable/disable 仅内存，重启丢失
7. **通知不写入审计日志**——critical/important 级别通知仅输出到终端

本 Phase 把所有"差一步"的功能补齐，让 RouteDev 成为一个功能闭环的产品。

---

## 接口对齐观察表

| 接口 / 类 | 当前状态 | 文件位置 | 本 Phase 引用方式 |
|---|---|---|---|
| `DurableExecutor` | 模块完整，未接入 App.tsx | `src/agent/durable-executor.ts` | Task 1 接入主循环 |
| `ModelRouter.route()` | 不检查 RouterPlugin | `src/router/router.ts` | Task 2 添加插件检查 |
| `PluginRegistry` | 4 种插件类型，ThemePlugin 未消费 | `src/plugins/registry.ts` | Task 3 接入渲染 |
| `StatusBar` props | `durableSnapshot?` 已定义，未传入 | `src/cli/components/StatusBar.tsx` | Task 1 + Task 8 传入数据 |
| `DiffView` | 展示组件，动作未绑定 | `src/cli/components/DiffView.tsx` | Task 5 绑定 git 操作 |
| `AuditLogger` | JSONL 格式，不记录通知 | `src/harness/audit-logger.ts` | Task 7 添加通知记录 |
| `ServiceContext` | 30 字段（Phase 26 后） | `src/cli/service-context.ts` | Task 1/4 新增字段 |
| `CommandBridge` | 10 方法 | `src/cli/service-context.ts` | Task 6 /resume UI 使用 |

---

## Task 1：DurableExecutor 运行时集成

**目标**：将 DurableExecutor 接入 App.tsx 主运行循环，让 `/goal` 长任务自动启用持久化执行。

### 设计

#### 1.1 接入策略

在 `app-init.ts` 的 `createAppDependencies()` 中创建 `DurableExecutor` 实例，传入 `ServiceContext`。`goal-runner.ts` 在执行多步计划时检查是否需要持久化：

```
启用条件（满足任一即启用）：
- 计划步骤数 > 5
- 用户在 semi/manual 模式下（涉及人工审批）
- 用户显式指定 /goal --durable
```

#### 1.2 StatusBar 数据接入

`goal-runner.ts` 在步骤执行过程中定期调用 `DurableExecutor.getSnapshot()`，将数据传入 StatusBar 的 `durableSnapshot` prop。

#### 1.3 /resume 命令基础接入

Phase 24 已创建 `/resume` 命令骨架。本 Task 将其接入 DurableExecutor 实例：
- `/resume` 调用 `durableExecutor.listRecoverable()` 显示可恢复列表
- `/resume <planId>` 调用 `durableExecutor.resumeFrom(planId)` 从断点恢复

### 验收

- `/goal` 长任务（>5 步）自动启用持久化
- 中断后 `/resume` 能列出并恢复执行
- StatusBar 显示持久化执行进度
- 新增 ≥ 5 个测试

---

## Task 2：RouterPlugin 集成

**目标**：让 `ModelRouter.route()` 在路由前先询问 RouterPlugin，插件返回结果则使用，否则 fallback 到默认路由。

### 设计

```typescript
// router.ts — route() 方法修改

async route(classification: ClassificationResult): Promise<RouteDecision> {
  // 1. 先问 RouterPlugin
  const routerPlugin = this.pluginRegistry?.getActiveRouterPlugin();
  if (routerPlugin) {
    const pluginDecision = await routerPlugin.route(classification);
    if (pluginDecision) return pluginDecision;
  }

  // 2. 默认路由逻辑（现有代码）
  return this.defaultRoute(classification);
}
```

### 验收

- RouterPlugin 存在时优先使用其路由结果
- RouterPlugin 不存在或返回 null 时 fallback 到默认路由
- 新增 ≥ 3 个测试

---

## Task 3：ThemePlugin 渲染接入

**目标**：让 StatusBar 和 ChatView 读取 ThemePlugin 配置，实现主题可定制。

### 设计

StatusBar 初始化时检查 ThemePlugin：

```typescript
const themePlugin = ctx.pluginRegistry?.getEnabledByType('theme')[0];
const themeColors = themePlugin?.getColors?.() ?? DEFAULT_COLORS;
```

设计系统的 `SemanticColor` 映射到 ThemePlugin 提供的颜色值。如果 ThemePlugin 未安装或未启用，使用设计系统的默认颜色（向后兼容）。

### 验收

- 安装 ThemePlugin 后，StatusBar 颜色随主题变化
- 无 ThemePlugin 时保持默认外观
- 新增 ≥ 2 个测试

---

## Task 4：插件状态持久化

**目标**：插件的 enable/disable 状态持久化到磁盘，重启后恢复。

### 设计

存储路径：`~/.qoderwork/routedev/plugin-state.json`

格式：
```json
{
  "plugins": {
    "my-theme": { "enabled": true },
    "my-tool": { "enabled": false }
  },
  "updatedAt": 1718700000000
}
```

`PluginRegistry.initAll()` 启动时读取状态文件，恢复各插件的 enable/disable 状态。`enable()` 和 `disable()` 调用后自动写入状态文件。

### 验收

- 禁用插件后重启，插件仍为禁用状态
- 状态文件损坏时 fallback 到默认全启用
- 新增 ≥ 3 个测试

---

## Task 5：DiffView 动作绑定

**目标**：让 DiffView 的 `[A] 全部接受`、`[R] 全部拒绝`、`[S] 逐行审查` 按钮实际生效。

### 设计

#### 5.1 全部接受 (A)

将 diff 内容通过 `git apply` 应用到工作目录。使用 `ToolExecutor` 执行 `git apply` 命令，结果通过 `CommandBridge.addSystemMessage()` 通知用户。

#### 5.2 全部拒绝 (R)

丢弃 diff 内容，不做任何文件修改。通过 `addSystemMessage()` 通知"变更已拒绝"。

#### 5.3 逐行审查 (S)

进入逐 hunk 模式：每个 hunk 显示后等待用户输入 `a`(accept) / `r`(reject) / `s`(skip)。最终将接受的 hunk 合并为一个 patch 文件，通过 `git apply` 应用。

### 验收

- [A] 应用全部变更，文件内容更新
- [R] 丢弃全部变更，文件不变
- [S] 逐 hunk 审查，仅应用接受的 hunk
- 新增 ≥ 4 个测试

---

## Task 6：/resume 交互式选择 UI

**目标**：将 `/resume` 从纯文本列表升级为交互式选择界面。

### 设计

```
┌─ 可恢复的执行 ──────────────────────────────────┐
│                                                   │
│  ▸ 1. [paused] "重构认证模块"                    │
│       完成 3/8 步 · 2小时前 · 已消耗 4,200 token │
│    2. [failed] "添加单元测试"                    │
│       完成 5/12 步 · 昨天 · 错误: LLM 超时       │
│                                                   │
│  ↑↓ 选择 · Enter 恢复 · Esc 取消                │
└───────────────────────────────────────────────────┘
```

使用 Ink 的 `useInput` hook 实现键盘导航。选择后调用 `durableExecutor.resumeFrom(planId)`。

### 验收

- 键盘导航正常工作
- Enter 恢复选中执行
- Esc 取消
- 无可恢复执行时显示友好提示
- 新增 ≥ 3 个测试

---

## Task 7：通知持久化到审计日志

**目标**：将 critical/important 级别的通知写入审计日志，便于事后审查。

### 设计

在 `notification.ts` 的发送函数中，对 critical/important 级别通知调用 `AuditLogger.log()`：

```typescript
if (options.level === 'critical' || options.level === 'important') {
  auditLogger.log('notification', options.level, {
    message: options.message,
    timestamp: Date.now(),
  });
}
```

### 验收

- critical 通知出现在审计日志中
- normal/subtle 通知不写入审计日志
- 新增 1 个测试

---

## Task 8：Compose + HookRunner TracePanel 可视化

**目标**：在 TracePanel 中展示 Compose 管线阶段切换和 HookRunner 钩子执行时间线。

### 设计

#### 8.1 Compose 阶段时间线

`ComposePipeline` 在阶段切换时记录 Trace span：
```typescript
trace.startSpan({ name: `compose:${phase}`, type: 'compose-phase' });
// ... 阶段执行 ...
trace.endSpan();
```

TracePanel 以分组方式展示：`Compose: requirements (45s) → coding (2m10s) → testing (1m30s) → review (30s)`

#### 8.2 HookRunner 钩子时间线

`HookRunner.fire()` 为每个钩子执行记录 Trace span：
```typescript
trace.startSpan({ name: `hook:${event}:${hook.name}`, type: 'hook' });
await handler(context);
trace.endSpan();
```

TracePanel 在 L3 级别显示钩子执行详情。

### 验收

- TracePanel 显示 Compose 阶段时间线
- TracePanel L3 级别显示钩子执行详情
- 新增 ≥ 3 个测试

---

## Task 9：notes.md 模块（蓝图 Section X.1）

**目标**：实现蓝图规定的"Agent 唯一写通道"——notes.md 自由格式草稿本。

### 背景

蓝图 Section X.1 明确规定：Main Agent 的唯一写通道是 `notes.md`（自由格式草稿本），CheckpointWriter 读取 notes.md 后分类写入结构化字段，然后清空 notes.md。这个机制确保了 Agent 的思考过程不会污染主上下文。

### 设计

```typescript
// src/agent/memory/notes.ts — 新建

class NotesManager {
  private notesPath: string;

  /** Agent 追加笔记 */
  async append(content: string): Promise<void>;

  /** CheckpointWriter 读取全部笔记 */
  async readAll(): Promise<string>;

  /** CheckpointWriter 分类后清空 */
  async clear(): Promise<void>;

  /** 获取笔记文件大小（字节） */
  async size(): Promise<number>;
}
```

### 集成点

- `ReActAgentLoop` 新增 `notes` 工具，允许 Agent 在推理过程中写入 notes.md
- `CheckpointWriter.checkpoint()` 读取 notes.md → 分类到 11 个结构化字段 → 清空 notes.md
- `DreamConsolidator` 整合 notes.md 的历史内容

### 验收

- Agent 可通过 `notes` 工具写入内容
- CheckpointWriter 读取并分类后清空
- notes.md 存储在 session 目录下
- 新增 ≥ 4 个测试

---

## Task 10：Discord 适配器（可选，蓝图 Section XIII）

**目标**：实现 Phase 19 遗留的 Discord 渠道适配器。

### 前提

此 Task 为可选。如果时间紧迫可跳过，标记为"未来增强"。

### 设计

参考已完成的 Telegram 和 Slack 适配器模式：

```typescript
// src/channels/adapters/discord.ts — 新建

class DiscordAdapter implements ChannelAdapter {
  verifySignature(body, signature, timestamp): boolean;
  parseMessage(raw): ParsedMessage;
  formatResponse(response): DiscordMessageFormat;
}
```

使用 Discord.js 或原生 REST API。签名验证使用 `crypto.verify` (Ed25519)。

### 验收

- Discord 适配器通过签名验证测试
- 消息收发正常
- 新增 ≥ 3 个测试

---

## 执行顺序

```
Task 1 (DurableExecutor 集成) ── 核心功能缺口
Task 9 (notes.md) ──────────── 蓝图缺口
  ↓
Task 2 (RouterPlugin) ────────┐
Task 3 (ThemePlugin) ─────────┤── 插件生态完善，可并行
Task 4 (插件持久化) ──────────┤
Task 7 (通知审计) ────────────┘
  ↓
Task 5 (DiffView 动作) ───────┐
Task 6 (/resume UI) ──────────┤── UX 补全，可并行
Task 8 (TracePanel 可视化) ───┘
  ↓
Task 10 (Discord 可选) ────── 最后做，可选
```

---

## 验收标准

| # | 验收标准 | 验证方式 |
|---|---------|---------|
| 1 | DurableExecutor 接入 /goal 长任务 | 执行 >5 步计划，验证 progress.json 生成 |
| 2 | /resume 从断点恢复 | 中断后恢复执行 |
| 3 | RouterPlugin 路由优先级正确 | 安装 RouterPlugin 验证路由替换 |
| 4 | ThemePlugin 影响 StatusBar 颜色 | 安装 ThemePlugin 验证颜色变化 |
| 5 | 插件状态重启后保持 | 禁用→重启→验证仍禁用 |
| 6 | DiffView [A]/[R]/[S] 实际生效 | 分别测试三种操作 |
| 7 | /resume 交互式选择正常工作 | 键盘导航 + Enter 恢复 |
| 8 | critical 通知出现在审计日志 | 触发 critical 通知后检查日志 |
| 9 | TracePanel 显示 Compose 和 Hook 时间线 | 运行 Compose 管线后查看 TracePanel |
| 10 | notes.md 写入→读取→清空流程正确 | Agent 写入笔记，CheckpointWriter 处理后验证清空 |
| 11 | 全量测试通过 | `pnpm vitest run` |
| 12 | 构建通过 | `pnpm build && pnpm typecheck` |
| 13 | 新增测试 ≥ 35 个 | 测试计数 |

---

## 对下一阶段的提醒

1. **性能基线强制门**：Phase 28 应将性能测试从"记录"升级为"强制门"（不通过则构建失败）
2. **端到端冒烟测试**：Phase 28 应添加完整的用户旅程端到端测试
3. **发布清单**：Phase 28 应制定完整的发布前检查清单
4. **国际化**：所有 UI 文案硬编码中文，远期可抽取为 i18n
5. **Windows 安装程序**：远期可用 pkg 或 nexe 打包为独立可执行文件
