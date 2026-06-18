# Phase 0c — 审计修复（基于 GPT 5.5 项目复审）

> **Phase 类型：** 修复（Remediation）
> **前置依赖：** Phase 20-23 全部完成（825 测试通过，v1.0.0 构建通过）
> **目标版本：** v1.0.1
> **审查来源：** GPT 5.5 独立项目复审（Phase 0b 报告），发现 3 个 Important + 2 个 Minor
> **执行人注意：** 本 Phase 修复独立审计发现的问题。每个 Task 对应一个审计编号，修复后需保持全量测试通过。

---

## 背景

Phase 20-23 完成后，GPT 5.5 对项目进行了独立复审。复审通过 `pnpm typecheck` 和 `pnpm test` 验证了构建健康度，逐文件审查了核心模块，给出 5 个发现（0 Critical / 3 Important / 2 Minor）。

架构师对每个发现进行了代码级交叉验证：

| 审计编号 | 发现 | 架构师验证 | 修正 |
|---------|------|-----------|------|
| Important-1 | provider 推断靠模型名启发式 | ✅ 确认：`inferProviderId()` 用 `includes('gpt')` 等 | 无 |
| Important-2 | 权限双轨（PermissionChecker + PermissionEngine） | ✅ 确认：两个类走不同代码路径 | 无 |
| Important-3 | App.tsx 组合根过重，createServiceContext 死代码 | ✅ 确认：394 行，~40 useRef | 无 |
| Minor-1 | README.md 严重过时 | ✅ 确认：只列 3 个 src/ 目录 | 无 |
| Minor-2 | CODEMAP.md 漂移 | ⚠️ 部分确认：文件列表对但行数过时 | 无 |
| （审计误判） | MessageRouter 按 provider 名路由客户端 | ❌ 不实：MessageRouter 用单个预注入 ILLMClient | 真正问题是 `inferProviderId()` 启发式 |

---

## 接口对齐观察表

以下签名已通过架构师代码级验证（Phase 23 完成后实际代码）：

| 接口 / 类型 | 当前签名 | 文件位置 | 备注 |
|---|---|---|---|
| `ServiceContext` | 28 必填 + 1 可选 = 29 字段 | `src/cli/service-context.ts` | Phase 20-23 新增 workModeController / sessionId / cwd / pluginRegistry? |
| `CommandBridge` | 10 个方法 | `src/cli/service-context.ts` | Phase 20 新增 setWorkMode + requestPlanEdit |
| `PermissionEngine` | class: `loadRules / addRule / getRules / check` | `src/tools/permission-engine.ts` | Task 1 保留为唯一权限源 |
| `PermissionChecker` | class: `checkPermission / setAutonomyMode / addRule / removeRule / listRules` | `src/tools/permission.ts` | Task 1 **删除或废弃** |
| `ToolExecutor` | class: `execute / executeSafe / setPermissionChecker / setSecurityChecker` | `src/tools/executor.ts` | Task 1 移除 setPermissionChecker 依赖 |
| `ModelRouter.route()` | `route(classification: ClassificationResult): Promise<RoutingResult>` | `src/router/router.ts` | Task 2 修改 inferProviderId |
| `LLMClientManager.listAll()` | `listAll(): Map<string, ILLMClient>` | `src/router/llm/index.ts` | Task 2 参考 |
| `WorkModeController` | class: `getMode / setMode / checkOperation / getComposePhase / advanceComposePhase` | `src/agent/work-modes.ts` | 不变 |
| `GuardedToolExecutorAdapter` | 包装 ToolExecutorAdapter，执行前检查 WorkMode | `src/agent/work-modes.ts` | 不变 |
| `PluginRegistry` | class: 11 个公开方法 | `src/plugins/registry.ts` | 不变 |
| `GoalGateManager` | class: `freeze / getGates / updateGate / modifyGate / unlock / lock / load / clear` | `src/agent/goal-gates.ts` | 不变 |
| `ContextManager` | 17 个公开方法（含 compressEnhanced / compactIfNeeded / recallMemories） | `src/agent/memory/context-manager.ts` | 不变 |
| `App.tsx` | 394 行 | `src/cli/App.tsx` | Task 3 重构 |

> **执行人注意：** 开始 Task 前先 `cat` 上述文件确认实际签名。上表是架构师验证的快照，代码可能因你之前的修复而有细微变化。

---

## Task 1：权限系统统一（审计 Important-2）

> **问题：** PermissionChecker（Phase 7）和 PermissionEngine（Phase 21）同时存在，走不同代码路径。PermissionChecker 在 ToolExecutor.execute() 内部硬检查，PermissionEngine 在 AgentMiddlewarePipeline.onActing 阶段中间件检查。两套规则可能不同步，新增入口可能绕过增强规则。
> **目标：** PermissionEngine 成为唯一权限决策源。删除 PermissionChecker 或其职责降级为纯日志记录。

### Step 1：分析 PermissionChecker 的调用链

执行前必须搞清楚谁在调用：

```bash
# 查找 PermissionChecker 的所有引用
grep -rn "PermissionChecker\|IPermissionChecker\|permissionChecker\|setPermissionChecker" src/ tests/
```

预期发现：
- `src/tools/executor.ts` — `setPermissionChecker()` + `execute()` 中调用 `checkPermission()`
- `src/cli/App.tsx` — 实例化 PermissionChecker 并注册到 ToolExecutor
- `tests/` — 可能有测试引用

### Step 2：移除 ToolExecutor 中的权限检查

修改 `src/tools/executor.ts`：

1. 删除 `setPermissionChecker()` 方法
2. 删除 `execute()` 中的 `this.permissionChecker.checkPermission()` 调用
3. 删除 `private permissionChecker` 字段
4. **保留** `SecurityChecker` 调用（安全检查 ≠ 权限检查）
5. **保留** `executeSafe()` 方法

### Step 3：确保 PermissionEngine 中间件覆盖所有工具执行

验证 `src/agent/loop.ts` 中的中间件调用链：

1. `setMiddlewarePipeline()` 已存在
2. 每次工具执行前调用 `middleware.execute('onActing', ctx)`
3. `ctx.metadata.permissionDenied` 被检查，存在则跳过执行

如果有任何工具执行路径不经过 loop.ts 的中间件（例如直接调用 ToolExecutor），需补上中间件调用或改用 loop.ts 的统一路径。

### Step 4：迁移 App.tsx 中的权限规则

当前 App.tsx 中可能同时注册了两套规则：
- `permissionChecker.addRule(...)` → **删除这些调用**
- `createDefaultEngine()` → **保留，这是唯一入口**

确认 PermissionEngine 的 `DEFAULT_DENY_RULES + DEFAULT_CONFIRM_RULES + DEFAULT_AUTO_RULES` 覆盖了原 PermissionChecker 的所有规则。如果有遗漏，添加到 `src/tools/permission-engine.ts` 的默认规则集中。

### Step 5：处理 PermissionChecker 文件

选择以下方案之一：

**方案 A（推荐）：** 删除 `src/tools/permission.ts`，同时删除所有 import 和测试。

**方案 B：** 保留文件但在类上添加 `@deprecated` JSDoc 注释，所有方法内抛出 `Error('Use PermissionEngine instead')`。

### Step 6：单元测试

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | deny 规则在 auto 模式下不可绕过 | PermissionEngine.check → decision: 'deny' |
| 2 | confirm 规则触发用户确认 | decision: 'confirm'，requestConfirm 被调用 |
| 3 | 无匹配规则 + auto 模式 → auto | decision: 'auto' |
| 4 | ToolExecutor.execute() 不再检查权限 | execute 不因权限拒绝而返回错误（权限由中间件处理） |
| 5 | 中间件 onActing 拦截被 deny 的工具 | permissionDenied 被设置，工具不执行 |
| 6 | 回归：原 PermissionChecker 的规则在 PermissionEngine 中生效 | 所有旧规则场景通过 |

### Step 7：提交

```bash
git add -A
git commit -m "refactor(permissions): unify dual-track permission system into PermissionEngine"
```

---

## Task 2：Provider 路由修正（审计 Important-1）

> **问题：** `ModelRouter.inferProviderId()` 用模型名启发式推断 provider（`includes('gpt')` → openai）。对于不在匹配列表中的模型名（如自定义微调模型 `my-finetune-v3`），推断会失败或返回错误 provider。
> **目标：** 配置中的 provider 字段成为权威来源，推断仅作后备。

### Step 1：修改 `inferProviderId()` 逻辑

修改 `src/router/router.ts`：

当前逻辑（问题代码）：
```typescript
private inferProviderId(modelId: string): string {
  if (modelId.includes('gpt')) return 'openai';
  if (modelId.includes('claude')) return 'anthropic';
  // ...
}
```

改为：
```typescript
private inferProviderId(modelId: string): string {
  // 1. 优先从配置中查找（配置中的 provider 字段是权威来源）
  const configMatch = this.findProviderFromConfig(modelId);
  if (configMatch) return configMatch;
  
  // 2. 后备：启发式推断（仅当配置中找不到时）
  return this.heuristicInfer(modelId);
}

private findProviderFromConfig(modelId: string): string | null {
  // 遍历 config.models 或 clientManager.listAll()，找到 modelId 对应的 provider
  for (const [providerId, client] of this.clientManager.listAll()) {
    if (client.supportsModel(modelId)) return providerId;
  }
  return null;
}
```

### Step 2：确保 ILLMClient 有 `supportsModel()` 方法

如果 ILLMClient 接口没有这个方法，需要添加：

```typescript
interface ILLMClient {
  // ... 现有方法
  /** 检查客户端是否支持指定模型 */
  supportsModel(modelId: string): boolean;
}
```

如果添加接口方法成本太高，可以直接检查配置中的 model 列表：

```typescript
private findProviderFromConfig(modelId: string): string | null {
  const models = this.config.models ?? [];
  const match = models.find(m => m.name === modelId || m.id === modelId);
  return match?.provider ?? null;
}
```

### Step 3：添加 provider 配置验证

在 `ModelRouter` 初始化时，验证所有配置的 model 都有对应的 provider client。不匹配时记录 warning（不阻塞启动）。

### Step 4：单元测试

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 配置中有 `provider: 'openai'` 的模型 → 路由到 openai | 不从启发式推断 |
| 2 | 配置中无该模型 → 回退到启发式 | `includes('gpt')` 仍有效 |
| 3 | 自定义模型名 `my-finetune-v3` 配置了 `provider: 'anthropic'` | 路由到 anthropic，不被启发式误导 |
| 4 | 配置和启发式都无法匹配 → 返回默认 provider 或抛出明确错误 | 有 fallback |

### Step 5：提交

```bash
git add -A
git commit -m "fix(router): use config provider as primary source, heuristic as fallback"
```

---

## Task 3：App.tsx 装配收敛（审计 Important-3）

> **问题：** App.tsx 394 行，~40 个 useRef 内联初始化，`buildServiceContext` 回调手动组装 ServiceContext。同时 `service-context.ts` 的 `createServiceContext()` 是死代码。初始化逻辑重复、可测试性差。
> **目标：** 将 App.tsx 的装配逻辑收敛到 `createServiceContext()`，App.tsx 只负责 React 状态管理和 UI 渲染。

### Step 1：重构 `createServiceContext()`

修改 `src/cli/service-context.ts`，使 `createServiceContext()` 接受所有依赖并返回完整的 ServiceContext：

```typescript
export function createServiceContext(deps: {
  config: AppConfig;
  clientManager: LLMClientManager;
  router: ModelRouter;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  // ... 所有 29 个字段所需的依赖
}): ServiceContext {
  return {
    config: deps.config,
    clientManager: deps.clientManager,
    // ... 完整组装
  };
}
```

关键：这个函数必须能处理可选字段（如 `pluginRegistry`），缺失时给合理默认值。

### Step 2：App.tsx 调用 createServiceContext

修改 `src/cli/App.tsx`：

1. 删除 `buildServiceContext` 回调
2. 在初始化 useEffect 中，收集所有依赖，调用 `createServiceContext(deps)`
3. App.tsx 只保留：
   - React 状态管理（useState / useRef）
   - 命令注册（CommandRegistry）
   - UI 渲染（JSX）
   - 事件处理（用户输入 → 命令分发）

### Step 3：提取初始化逻辑

如果 App.tsx 中的初始化代码仍然过长（>50 行），提取到独立文件：

```typescript
// src/cli/app-init.ts
export async function initializeApp(config: AppConfig): Promise<AppDependencies> {
  // 创建 clientManager, router, tracker, agentLoop 等
  // 返回所有需要传入 App 组件的依赖
}
```

### Step 4：App.tsx 行数目标

重构后 App.tsx 应 ≤ 300 行（从 394 行减少至少 94 行）。

### Step 5：单元测试

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | `createServiceContext()` 返回完整的 29 字段对象 | 所有字段非 undefined |
| 2 | 缺少可选字段（pluginRegistry）时使用默认值 | 不抛异常 |
| 3 | App.tsx 行数 ≤ 300 | verify.ts 可扩展检查 |
| 4 | 回归：App 组件正常渲染 | 不崩溃 |

### Step 6：提交

```bash
git add -A
git commit -m "refactor(app): consolidate service assembly into createServiceContext()"
```

---

## Task 4：文档同步（审计 Minor-1 + Minor-2）

> **问题：** README.md 只列 3 个 src/ 目录，进度停在 Phase 1。CODEMAP.md 行数过时，缺少 Phase 20-23 新模块。
> **目标：** 文档与代码同步，让新接手者能在 5 分钟内理解项目结构。

### Step 1：重写 README.md

内容要求：

1. **项目简介**（3-5 行）：RouteDev 是什么、核心能力（智能路由 + 自主开发 + MCP 工具）
2. **快速开始**：`pnpm install → pnpm build → node dist/index.js`
3. **项目结构**：列出所有 src/ 一级目录及其一句话职责
4. **架构概览**：用 ASCII 图或简表展示核心数据流（用户输入 → 分类器 → 路由器 → Agent Loop → 工具执行 → 响应）
5. **开发命令**：`pnpm test` / `pnpm build` / `pnpm typecheck` / `pnpm tsx scripts/verify.ts`
6. **版本**：v1.0.0
7. **License**：AGPL-3.0

不要超过 120 行。保持精简。

### Step 2：更新 CODEMAP.md

1. 扫描所有 src/ 一级目录，更新文件列表和行数
2. 补充 Phase 17c-23 新模块：
   - `src/agent/context-compaction.ts` — 五阶段渐进压缩
   - `src/agent/memory/graph.ts` — 知识图谱记忆
   - `src/agent/work-modes.ts` — 工作模式控制器
   - `src/agent/goal-gates.ts` — 目标门控管理
   - `src/tools/permission-engine.ts` — 三层权限引擎
   - `src/plugins/` — 插件系统（types + registry + sdk）
   - `src/cli/components/TracePanel.tsx` — Trace 可视化
   - `src/cli/components/StepCard.tsx` / `StepEditor.tsx` — 步骤编辑器
   - `src/cli/wizard.tsx` — 首次运行向导
   - `src/channels/adapters/slack.ts` — Slack 适配器
3. 更新行数统计（用 `wc -l` 或脚本实际计算，不要猜）

### Step 3：更新 AGENTS.md 陷阱列表

Phase 0c 修复后需追加：
- 权限检查走 PermissionEngine 中间件，不走 PermissionChecker（已废弃）
- provider 路由优先从配置读取，启发式仅作后备

### Step 4：提交

```bash
git add README.md CODEMAP.md AGENTS.md
git commit -m "docs: sync README, CODEMAP and AGENTS.md with current codebase (v1.0.0)"
```

---

## 验收标准

1. **权限统一：** PermissionChecker 已删除或标记废弃，PermissionEngine 是唯一权限源
2. **中间件覆盖：** 所有工具执行路径都经过 onActing 中间件权限检查
3. **Provider 路由：** 配置中的 provider 字段是权威来源，`inferProviderId()` 仅作后备
4. **App.tsx 瘦身：** ≤ 300 行，createServiceContext() 是单一装配入口
5. **README.md：** 更新至 v1.0.0，包含完整项目结构和开发命令
6. **CODEMAP.md：** 行数经实际计算，覆盖 Phase 17c-23 所有新模块
7. **全量测试通过：** `pnpm test` 零失败
8. **构建通过：** `pnpm build && pnpm typecheck` 零错误
9. **验收门通过：** `pnpm tsx scripts/verify.ts` 全部通过
10. **新增测试 ≥ 15 个**

---

## 补充说明

**A. 审计评分与修复目标：**

| 维度 | 审计评分 | 修复目标 | 对应 Task |
|------|---------|---------|-----------|
| 安全性 | 4/5 | 5/5（权限统一后无绕过路径） | Task 1 |
| 路由/模型一致性 | 3/5 | 4/5（配置优先 + 启发式后备） | Task 2 |
| 权限治理 | 3/5 | 5/5（单一策略源） | Task 1 |
| 可维护性 | 3/5 | 4/5（App 装配收敛） | Task 3 |
| 文档同步 | 2/5 | 4/5（README + CODEMAP 更新） | Task 4 |

**B. 审计误判澄清：**
GPT 5.5 报告称 MessageRouter 按 provider 名选择客户端。经代码验证：MessageRouter 使用单个预注入的 `ILLMClient`，模型选择由 `ModelRouter.route()` 决定，不存在按 provider 分发客户端的逻辑。真正的问题是 `inferProviderId()` 的启发式推断脆弱，Task 2 修复此问题。

**C. 不引入新依赖：**
本 Phase 所有修复均在现有架构内完成。不新增 npm 包。

**D. 执行顺序建议：**
Task 1（权限统一）→ Task 2（Provider 路由）→ Task 3（App 瘦身）→ Task 4（文档同步）
Task 1 最先做，因为它影响安全基线。Task 4 最后做，因为前面的修改会影响文档内容。
