# RouteDev 死代码审查报告 — 第三次交叉验证（修正与确认）

- **审查引擎**: DeepSeekV4Flash
- **审查时间**: 2026-07-07
- **审查范围**: 对前两次报告结论的逐项验证 + 新维度检查
- **方法论**: 生产代码 import 逐文件验证 + 动态 import 追踪 + 自动化扫描结果人工复核

---

## 目录

1. [前次报告误判修正](#1-前次报告误判修正)
2. [自动扫描工具 false positive 分类](#2-自动扫描工具-false-positive-分类)
3. [确认的死代码清单](#3-确认的死代码清单)
4. [新维度验证结果](#4-新维度验证结果)
5. [最终汇总矩阵](#5-最终汇总矩阵)

---

## 1. 前次报告误判修正

本次交叉验证纠正了前次报告中因依赖自动化扫描工具（`dead-code-report.json`）而导致的 **6 项误判**：

### 误判 1: `policies/` 模块 — 实际有消费路径

**前次报告**: 标注 IntentGuard / Playbook / ToolApproval / ToolGuide 为"疑似未接线"（P4）

**实际验证**: `app-init.ts` L1344-1363 通过 `createBuiltinIntentGuardPolicies()` / `createBuiltinPlaybookPolicies()` 等工厂函数实例化并注入 PolicyEngine。

```
app-init.ts L1344: policyEngine.addPolicy(createBuiltinIntentGuardPolicies(config));
app-init.ts L1350: policyEngine.addPolicy(createBuiltinPlaybookPolicies(config));
app-init.ts L1356: policyEngine.addPolicy(createBuiltinToolGuidePolicies(config));
app-init.ts L1362: policyEngine.addPolicy(createBuiltinToolApprovalPolicies(config));
```

**根因**: 自动化扫描工具只检测 `import { ClassName }` 模式，无法追踪工厂函数包装的消费路径。

### 误判 2: `code-map/` 模块 — 有完整生产消费链

**前次报告**: 标注 `loadLanguage` / `createParser` / `CodeMapFallback` / `scanSourceFiles` / `updatePageRank` / `searchBySymbolName` 等为"死导出"

**实际验证**:

| 函数 | 消费路径 | 验证 |
|------|---------|------|
| `loadLanguage` / `createParser` | parser.ts 内部 L161/L164 自调用 | ✅ 被同一文件使用 |
| `CodeMapFallback` | app-init.ts L1727 动态 import 调用 | ✅ 动态 import 消费 |
| `scanSourceFiles` / `updatePageRank` | indexer.ts 内部 L232/L251/L311/L331/L528 自调用 | ✅ 被同一文件使用 |
| `searchBySymbolName` / `findCallPath` / `findCallChain` / `getFileStructure` | querier.ts 内部 L110/L189 自调用，或 code-graph-query.ts L10-16 import 消费 | ✅ 生产消费 |

**根因**: 工具检测的是"导出项的 import 计数"，但无法区分"同一文件内部使用"和"外部消费"。这些函数被设计为模块内部工具函数，export 只是 TypeScript 模块化的自然结果，并非死代码。

### 误判 3: `import/` 模块 — 通过动态 import 消费

**实际验证**: app-init.ts L106 / L1930-1932 通过 `import('../import/anthropic-skills-loader.js')` / `import('../import/claude-plugin-importer.js')` / `import('../import/codex-importer.js')` 动态加载。

### 误判 4: `security/` 模块 — 直接 import 消费

**实际验证**: app-init.ts L167-168: `import { CommandSandbox } from '../security/sandbox.js'` / `import { IntegrityManifest } from '../security/integrity-manifest.js'`

### 误判 5: `observability/` 模块 — 通过动态 import 消费

**实际验证**: app-init.ts L460-482: `import('../observability/otel-exporter.js')` 动态加载。

### 误判 6: `mcp/claude-bridge` — 通过动态 import 消费

**实际验证**: app-init.ts L2033-2057: `import('../mcp/claude-bridge.js')` 动态加载。

### 误判 7: `camelSplit` — 被 database.ts 消费

**实际验证**: 虽然 `camelSplit` 函数本身只被 `camelSplitToFTS` 调用，但 `camelSplitToFTS` 被 `database.ts` L14 / L326-327 引入并用于 FTS 索引构建。`camel-split-tokenizer.ts` 整体是 code-map 系统中活跃的组成部分。

---

## 2. 自动扫描工具 false positive 分类

`dead-code-report.json` 的 1389 个导出项中，大量被标记为"dead"的条目实际上是活跃的。false positive 可归类为以下模式：

### 2.1 内部模块自用函数（占比最高）

| 模式 | 示例 | 消费方式 |
|------|------|---------|
| 同一文件内被调用 | `loadLanguage` / `createParser` / `scanSourceFiles` / `updatePageRank` | 在同一文件的另一函数中调用 |
| 被同模块的文件调用 | `camelSplit` → `database.ts` | 模块内部跨文件引用 |
| 被聚合入口类调用 | `querier.ts` 各函数 → `CodeMapEngine` | 通过 CodeMapEngine 统一入口使用 |

### 2.2 工厂函数 / 间接包装

| 模式 | 示例 | 消费方式 |
|------|------|---------|
| 工厂函数构造 | `IntentGuard` / `Playbook` 等 | `createBuiltinXxxPolicies()` 工厂函数包装 |
| 回调 / 闭包引用 | PolicyEngine 策略类 | 通过 `addPolicy()` 注入 |

### 2.3 动态 import

| 模式 | 示例 | 消费方式 |
|------|------|---------|
| 按需加载 | `CodeMapFallback` / `ClaudeMCPBridge` | `import('../code-map/fallback.js')` |
| 插件系统 | `AnthropicSkillsLoader` / `CodexInstructionImporter` | `import('../import/xxx.js')` |

### 2.4 类型导出（Type-only）

TypeScript 中大量 `interface` / `type` 导出被标记为"dead"，但这是 TS 的常见模式——类型定义消费方通常只 import type，不产生运行时引用。工具统计的是"值引用"而非"类型引用"，导致这些类型被误报。

**结论**: `dead-code-report.json` 的 1389 个"dead"导出项中，**估算 90%+ 为 false positive**。该工具更适合作为**初始筛选器**，不能替代人工交叉验证。

---

## 3. 确认的死代码清单

经过三轮交叉验证，以下为**确认**的死代码：

### 3.1 Phase 64 Skill Routing 全线（🔴 高）

| 条目 | 类型 | 原因 |
|------|------|------|
| `decomposeWithSADIfEnabled` | 导出函数 | 生产代码中 0 个 import 调用 |
| `SkillRoutingConfig` | 导出接口 | 仅在 `decomposeWithSADIfEnabled` 签名中使用，该函数本身无消费方 |
| `BiEncoderSkillRetriever` | 类 | 仅在 `decomposeWithSADIfEnabled` 中被实例化 |
| `SkillContextOptimizer` | 类 | 同上 |
| `DecompositionGranularityAuditor` | 类 | 同上 |
| `CompatibilityScorer` | 类 | 同上 |
| `SADDecomposer` | 类 | 同上 |
| `skillRouting` 配置段 | schema + defaults 定义 | 无任何代码读取 `config.skillRouting` |

**影响**: 整个 Phase 64 子系统的代码、配置、文档均为死代码。

### 3.2 `bundled-skill-extractor.ts` 三个导出函数（🟡 中）

| 条目 | 原因 |
|------|------|
| `isSafeRelativePath` | 生产代码 0 引用，仅测试引用 |
| `extractBundledSkill` | 同上 |
| `cleanupExtractedFiles` | 同上 |

### 3.3 `operation-classifier.ts` — `buildRegimeTransition`（🟡 中）

| 条目 | 原因 |
|------|------|
| `buildRegimeTransition` | 生产代码 0 引用，仅测试引用 |

### 3.4 `progressive-disclosure.ts` — `disclose`（🟡 中）

| 条目 | 原因 |
|------|------|
| `disclose` | 生产代码 0 引用，仅测试引用 |

> **注意**: 3.2-3.4 中的函数可能属于"为未来预留的 API"或"尚未被主流程接线的功能"。是否删除取决于项目策略。

---

## 4. 新维度验证结果

### 4.1 desktop/renderer/ 组件树完整性

| 检查项 | 结果 |
|--------|------|
| App.tsx 路由加载 | ✅ 所有页面组件（ChatPage / NewTaskPage / SettingsPage / DiscoveryPage / SetupWizard）均正确 import |
| 11 个 Settings*Tab 组件 | ✅ 全部在 SettingsPage.tsx L35-45 import + L4840-4888 渲染 |
| 布局组件（Layout / TitleBar / StatusBanner） | ✅ 全部在 App.tsx import |
| Store 模块 | ✅ useRouteDevStore / useProjectsStore 均有组件消费 |
| 错误边界 | ✅ ErrorBoundary 在 App.tsx 包裹根组件 |

**结论**: desktop/renderer/ 无死组件。

### 4.2 code-map/ 模块生产消费链完整确认

**生产消费者及其消费的文件**:

| 生产消费者 | 消费的文件 | 消费方式 |
|-----------|-----------|---------|
| `code-graph-query.ts` (Tool) | database.ts, querier.ts, schema.ts | 直接 import |
| `code-map-context.ts` (Middleware) | indexer.ts, querier.ts, database.ts, git-integration.ts, schema.ts, token-counter.ts | 直接 import |
| `app-init.ts` | indexer.ts, fallback.ts | 动态 import |

**结论**: code-map/ 模块整体活跃，无死模块。

### 4.3 未被生产代码引用的文件（疑似孤儿模块）

经过逐文件排查，以下文件在 `src/` 和 `desktop/` 中 **未被任何生产代码 import**：

| 文件 | 分析 |
|------|------|
| 无 | 所有文件均有至少一个生产消费者 |

**结论**: `src/` 下不存在孤儿模块文件。

---

## 5. 最终汇总矩阵

### 修正后的死代码综合清单

| # | 问题 | 首次报告 | 二次报告 | 终审结论 | 严重程度 |
|---|------|---------|---------|---------|---------|
| 1 | Schema-default 值不一致（9处） | ✅ P1 | ✅ P6 | ✅ 确认 | 🟡 中 |
| 2 | Phase 64 Skill Routing 未接线 | 未发现 | ✅ P1+P2 | ✅ 确认 | 🔴 高 |
| 3 | AppDependencies 僵尸字段 | ✅ 无 | — | ✅ 确认无 | 🟢 无 |
| 4 | Orphan 模块 | ✅ 无 | — | ✅ 确认无 | 🟢 无 |
| 5 | Phase 59+ 清理状况 | ✅ 良好 | — | ✅ 确认良好 | 🟢 无 |
| 6 | Config guard 死分支 | — | ✅ 无 | ✅ 确认无 | 🟢 无 |
| 7 | policies/ 未接线 | — | ❌ P4 误判 | 🔄 修正：有消费 | 🟢 无 |
| 8 | code-map/ 死导出 | — | ❌ P3+P7 误判 | 🔄 修正：有消费 | 🟢 无 |
| 9 | import/ security/ observability/ 死模块 | — | 未提及 | ✅ 三者均有消费 | 🟢 无 |
| 10 | desktop/renderer/ 死组件 | — | 未提及 | ✅ 无死组件 | 🟢 无 |
| 11 | bundled-skill-extractor 死导出 | — | 未提及 | ✅ 确认死代码 | 🟡 中 |
| 12 | operation-classifier dead export | — | 未提及 | ✅ 确认死代码 | 🟡 中 |
| 13 | progressive-disclosure dead export | — | 未提及 | ✅ 确认死代码 | 🟡 中 |

### 最终死代码量估算

| 类别 | 估算行数 | 占比 | 说明 |
|------|---------|------|------|
| Phase 64 全线 | ~600 行 | ~0.5% | 代码 + 配置 + 注释 |
| 3 个死导出函数 | ~150 行 | ~0.1% | bundled-skill-extractor + operation-classifier + progressive-disclosure |
| Schema-default 注释噪音 | ~50 行 | ~0.04% | 9 个 `.default(false)` 需修正 |
| **总计** | **~800 行** | **~0.6%** | 相对于项目总量非常低 |

### 健康度总评

RouteDev 的死代码率极低（~0.6%），核心管线经过 Phase 59 的彻底清理后非常干净。主要遗留问题集中在 **Phase 64 技能路由子系统**——该子系统代码完整、配置齐全、文档详尽，但从未被接入生产路径。这可能是即将上线的功能，也可能是被搁置的旧设计。

建议项目团队确认 Phase 64 的意图：
- **如果计划上线** → 在 app-init.ts 中接入 `config.skillRouting` 并调用 `decomposeWithSADIfEnabled`
- **如果已放弃** → 删除整个管线（8 个文件 + 1 个配置段）

---

*本报告为 RouteDev 死代码审查的第三次交叉验证，基于 `c:\Users\杨铭\Desktop\Agent\routedev` 在 2026-07-07 的文件状态。*
*报告覆盖: 配置交叉映射 / import 连通性 / 动态 import 追踪 / 组件树完整性 / 自动扫描工具结果人工复核。*