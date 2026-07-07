# RouteDev 死代码审查报告

> **审查模型**：DeepSeek-V4-Pro  
> **审查日期**：2026-07-07  
> **审查范围**：`c:\Users\杨铭\Desktop\Agent\routedev` — `src/` + `desktop/`（排除 `tests/`、`node_modules/`）  
> **生产入口**：`desktop/main/index.ts` → `engine-bridge.ts` → `app-init.ts`  
> **审查方法**：严格按照提示词七步判定流程 + 交叉验证（每项换关键词复验）

---

## 1. 执行摘要

| 指标 | 数值 |
|------|------|
| 审查文件数 | 100% 核心入口 + 可疑项全量搜索 |
| 确认死代码 | **12** 项 |
| - True-Dead（纯死文件） | 0 |
| - Zombie-Field（僵尸字段） | **2** |
| - Dead-Method（死方法） | **1** |
| - Wiring-Bug（配置断裂） | **9** |
| 需人工裁决 | 0 |
| 误报排除 | **3**（`activityStore`、`skillLifecycleManager`、`configLayering` 初判死代码，交叉验证后确认活代码） |

---

## 2. 确认死代码清单

### 2.1 True-Dead（纯死文件）

无。所有 `.ts` 文件都至少有一处导入或动态引用，没有完全孤立的死文件。

---

### 2.2 Zombie-Field（僵尸字段）

这些字段在 `app-init.ts` 的 `AppDependencies` 接口中定义并实例化返回，但全项目（`src/` + `desktop/`）中零 `this.deps.` 或 `deps.` 消费。

| 字段 | app-init 实例化行 | 验证命令 | 命中数 | 结论 |
|------|-------------------|----------|--------|------|
| `orchestrator` | [src/runtime/app-init.ts:1425](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L1425) | `grep -r "deps.orchestrator\|this.deps.orchestrator" src/ desktop/` | 0 | 死字段 |
| `workerExecutor` | [src/runtime/app-init.ts:1432](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L1432) | `grep -r "deps.workerExecutor\|this.deps.workerExecutor" src/ desktop/` | 0 | 死字段 |

**证据**：`engine-bridge.ts` L799 已经注释"Phase 58：orchestrator/workerExecutor 已删除（executeWorkerStep 死方法清理）"，但字段仍暴露在 `AppDependencies` 接口中未移除。

---

### 2.3 Dead-Method（死方法）

| 方法 | 定义位置 | 验证命令 | 命中数 |
|------|----------|----------|--------|
| `ModelRouter.setReasoningMode()` | [src/router/router.ts:189](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/router/router.ts#L189) | `grep -r "setReasoningMode" src/ desktop/` | 1（仅定义，无调用） |

**注**：`private reasoningMode: ReasoningMode` 在构造函数中被赋值，但 setter 从未被调用。构造函数赋值来自 `RouterConfig`，而 `RouterConfig` 未读取 `config.reasoningMode`（见下节配置断裂）。

---

### 2.4 Wiring-Bug（配置断裂）

这些配置项在 `defaults.ts` 和 `schema.ts` 中定义，但在运行时代码（`app-init.ts`/`engine-bridge.ts`/`goal-runner.ts`）中从未被读取。它们仅在 UI 设置页（`desktop/renderer/src/`）中显示，后端不消费。

| 配置项 | defaults 行 | 验证命令 | 命中数（排除UI） | 影响 |
|--------|-------------|----------|------------------|------|
| `config.sounds` | L~行 | `grep -r "config\.sounds" src/ desktop/main/` | 0 | UI 可改，后端不读取 |
| `config.updates` | L~行 | `grep -r "config\.updates" src/ desktop/main/` | 0 | UI 可改，后端不读取 |
| `config.channels` | L~行 | `grep -r "config\.channels" src/ desktop/main/` | 0 | UI 可改，后端不读取 |
| `config.llmProviders` | schema 中存在 | `grep -r "config\.llmProviders" src/ desktop/main/` | 0 | 全项目无任何消费 |
| `config.reasoningMode` | L~行 | `grep -r "config\.reasoningMode" src/ desktop/main/` | 0（仅 tests/ 引用）| Router 类有 `reasoningMode` 字段，但 `buildRouterConfig` 不读取配置 |
| `config.errorDisplay` | L~行 | `grep -r "config\.errorDisplay" src/ desktop/main/` | 0 | UI 可改，后端不读取 |
| `config.modelDisplay` | L~行 | `grep -r "config\.modelDisplay" src/ desktop/main/` | 0 | UI 可改，后端不读取 |
| `config.persona` | L~行 | `grep -r "config\.persona" src/ desktop/main/` | 0（误匹配：`impersonation` 与 `personalizedPageRank` 与配置无关） | UI 可改，后端不读取 |
| `config.voice` | L~行 | `grep -r "config\.voice" src/ desktop/main/` | 0（仅 tests/ 引用） | UI 可改，后端不读取 |
| `config.discovery` | L~行 | `grep -r "config\.discovery" src/ desktop/main/` | 0（误匹配：`FilesystemDiscovery` 类名与配置无关） | UI 可改，后端不读取 |
| `config.market` | L~行 | `grep -r "config\.market" src/ desktop/main/` | 0（仅 tests/ 引用；`SkillMarketManager` 硬编码路径不读配置） | SkillMarketManager 不读取此配置 |

**注**：`config.adversarial` 在 `goal-runner.ts:519` 有明确消费（`if (config.adversarial?.enabled)`），排除死代码。  
**注**：`config.configLayering` 在 `loader.ts:259` 有明确消费，排除死代码。  
**注**：`reasoningMode` 存在二级配置断裂：`buildRouterConfig` 不读取 `config.reasoningMode` → 构造 `ModelRouter` 时始终使用默认值 `balanced` → `setReasoningMode` 从未被调用。

---

## 3. 需人工裁决清单

无。所有可疑项均已通过交叉验证确认。

---

## 4. 误报排除清单（自查记录）

| 模块/字段 | 初判 | 实际状态 | 排除理由 |
|----------|------|----------|----------|
| `activityStore` | Zombie-Field | 活代码 | 被 `spawn-agent.ts:629,659` 消费：`if (deps.activityStore) → startActivity()/finishActivity()` |
| `skillLifecycleManager` | Zombie-Field | 活代码 | 被 `spawn-agent.ts:772` 消费：`if (deps.skillLifecycleManager) → recordExecution()` |
| `configLayering` | Wiring-Bug | 活代码 | 被 `loader.ts:259` 消费：`const layeringEnabled = config.configLayering?.enabled !== false` |
| `reasoningMode` | 活代码 | Wiring-Bug | `ModelRouter` 类有字段，但 `buildRouterConfig` 不读取 `config.reasoningMode`， setter 未被调用 |

---

## 5. 交叉验证记录

| 项 | 核验方法 | 核验结果 |
|----|----------|----------|
| 12 个可疑配置 | 换关键词 `config\.字段名` 全项目搜索 | 确认 9 个零命中（排除 tests/ 和 UI），1 个配置断裂，2 个活代码 |
| 4 个可疑 deps 字段 | 换关键词 `deps\.字段名` 全项目搜索 | 确认 2 个零命中，2 个有真实方法调用 |
| `activityStore` | 搜索 `deps.activityStore` 跨文件 | 找到 `spawn-agent.ts` 中的消费调用 |
| `skillLifecycleManager` | 搜索 `deps.skillLifecycleManager` 跨文件 | 找到 `spawn-agent.ts` 中的消费调用 |
| `configLayering` | 搜索 `configLayering` 在 loader.ts | 找到配置合并守护代码 `line 259` |
| `reasoningMode` | 搜索 `config.reasoningMode` + `setReasoningMode` | 确认 `buildRouterConfig` 不读取配置，setter 无调用 |
| `persona` | 逐行检查命中文件 | 确认命中为 `impersonation` 和 `personalizedPageRank`，非 `config.persona` |
| `discovery` | 逐行检查命中文件 | 确认命中为 `FilesystemDiscovery` 类名，非 `config.discovery` |
| `market` | 检查 `SkillMarketManager` 源码 | 确认硬编码路径，不读取 `config.market` |

---

## 6. 清理建议

### 6.1 Zombie-Field（优先级：高）

从 `src/runtime/app-init.ts` 的 `AppDependencies` 接口定义中移除：

```typescript
// 删除以下两行
orchestrator: Orchestrator;
workerExecutor: WorkerExecutor;
```

它们已经在 `engine-bridge.ts:799` 注释中标记为"已删除"，但接口定义仍存在，属于不必要的暴露。

### 6.2 Dead-Method（优先级：中）

删除 `src/router/router.ts` 中的死方法：

```typescript
// 删除此方法（从未被调用）
setReasoningMode(mode: ReasoningMode): void {
  this.reasoningMode = mode;
}
```

### 6.3 Wiring-Bug 修复（优先级：中）

**方案 A（推荐）**：从 `src/config/defaults.ts` 和 `src/config/schema.ts` 中移除以下 9 个配置字段：
```
sounds, updates, channels, llmProviders, errorDisplay, modelDisplay,
persona, voice, discovery, market
```
如果这些功能计划未来实现，保留接口但添加 `// TODO: Phase XX 待实现` 注释，并在 UI 设置页隐藏对应配置项。

**方案 B**：补全接线 — 对 `config.reasoningMode`：

```typescript
// 在 src/router/config.ts:buildRouterConfig() 中添加：
reasoningMode: appConfig.reasoningMode,
```

使得 `ModelRouter` 构造函数能从配置读取默认值。

---

## 七、质量自检（按提示词要求）

- [x] 每个死代码判定都附带了 Grep 命令和命中数
- [x] 搜索范围包含 `src/` + `desktop/`（不只是 `src/`）
- [x] 已检查动态 import（搜索文件名在 `app-init.ts` 中的出现）
- [x] 未把 `enabled: false` 的配置门控功能判为死代码
- [x] 未把 TypeScript 类型导出判为需要删除的死代码
- [x] 未建议删除整个目录
- [x] 已区分"实例化"和"方法调用"（有 `new` 不等于活）
- [x] 已检查事件回调/信号监听器的间接调用链
- [x] 所有确认死代码项经过交叉验证

---

*报告生成时间：2026-07-07 | 审查引擎：DeepSeek-V4-Pro*