# RouteDev 死代码全量审查报告

> **审查者：** qwen3.7max  
> **日期：** 2026-07-05  
> **审查模式：** 全量审查  
> **项目版本：** RouteDev v4.5.4（TypeScript 6.x / Electron 30 / Node.js 20+）  
> **审查范围：** `src/` 目录下全部源代码模块（约 220+ 文件），重点关注未被接入生产路径、功能残缺或未开启的死代码模块

---

## 审查总结

RouteDev 经过 Phase 50 和 Phase 56-60 的大规模死代码清理（已删除 20+ 整文件、3000+ 行代码），代码库整体健康度较高。但本次全量审查仍发现 **4 个完全死代码的整目录/文件**、**7 个零生产引用的独立模块**、**2 个"数据黑洞"模块**（被实例化但产出从未被消费），以及 **3 个仅类型引用的半成品模块**。死代码主要集中在：未集成的实验性模块（deep-review）、Phase 59 移除实例化后的遗留代码（evaluation）、未启用的功能（config/presets, config/watcher）、以及冗余 barrel 文件。

**判定：需要清理。** 共识别 16 个需处理的死代码项，建议按优先级分批移除。

---

## 一、确认的完全死代码（整目录/整文件级）

### Critical-1：`src/agent/deep-review/` —— 整个目录完全孤立（4 个文件）

| 文件 | 导出数 | 外部引用 |
|------|--------|---------|
| `deep-review/aggregator.ts` | 5 | 0（仅目录内部互引） |
| `deep-review/risk-scorer.ts` | 1 | 0（仅目录内部互引） |
| `deep-review/types.ts` | 8 | 0（仅目录内部互引） |
| `deep-review/orchestrator.ts` | 多个 | 0（无外部 import） |

**为什么重要：** 整个 `deep-review/` 目录的 14+ 个导出在 `src/` 全目录中**零外部引用**。`config/schema.ts` 中虽然定义了 `deepReviewEnabled`、`deepReviewFocuses` 等配置字段，但这些配置从未连接到实际的 deep-review 模块——配置存在但功能从未被装配。这是一个典型的"设计完成、实现完成、但从未接入"的模块。

**影响：** 增加构建产物体积、增加代码搜索噪音、误导新开发者以为此功能已上线。

**修复建议：** 删除整个 `src/agent/deep-review/` 目录。如果未来计划启用，应在 git 历史中保留并在新 Phase 中重新引入。同时清理 `config/schema.ts` 中的 `deepReview*` 配置字段。

---

### Critical-2：`src/agent/prompts.ts` —— 已迁移但从未删除

**文件：** [src/agent/prompts.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/agent/prompts.ts)

| 导出 | 生产引用 | 测试引用 |
|------|---------|---------|
| `SYSTEM_PROMPT_TEMPLATE_ID` | 0 | 0 |
| `DEFAULT_SYSTEM_PROMPT_ZH` | 0 | 0 |
| `DEFAULT_SYSTEM_PROMPT_EN` | 0 | 0 |
| `getSystemPrompt` | 0 | 0 |

**为什么重要：** 文件头注释明确标注"Phase 26 Task 6：已迁移到 PromptTemplateManager"。系统提示逻辑已完全迁移到 `src/prompts/manager.ts`（由 `app-init.ts` 导入），但旧文件遗留了 4 个导出，全部无人调用。

**修复建议：** 删除 `src/agent/prompts.ts` 及对应测试文件 `tests/agent/prompts.test.ts`、`tests/prompts/system-prompt.test.ts`。

---

### Critical-3：`src/agent/requirements-clarifier.ts` —— 从未集成到生产流程

**文件：** [src/agent/requirements-clarifier.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/agent/requirements-clarifier.ts)

| 导出 | 生产引用 | 测试引用 |
|------|---------|---------|
| `RequirementsClarifier` | 0 | 1（测试自测） |
| `AMBIGUOUS_WORDS` | 0 | 1 |
| `VAGUE_ACTION_WORDS` | 0 | 1 |
| `VAGUE_QUANTIFIERS` | 0 | 1 |

**为什么重要：** Phase 37 Task 1 的需求澄清器模块。实现完整（含模糊词检测、歧义分析等），但从未被 `app-init.ts` 或 `goal-runner.ts` 接入生产路径。可能已被 `requirements-gatherer.ts` 替代。

**修复建议：** 删除 `src/agent/requirements-clarifier.ts` 及 `tests/phase37/requirements-clarifier.test.ts`。

---

### Critical-4：`src/agents/instance-harness.ts` —— 源码自述"无消费方"

**文件：** [src/agents/instance-harness.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/agents/instance-harness.ts)

| 导出 | 生产引用 | 测试引用 |
|------|---------|---------|
| `AgentInstance` | 0 | 2 |
| `AgentHarness` | 0 | 2 |
| `createSessionStorageKey` | 0 | 2 |
| `parseSessionStorageKey` | 0 | 2 |
| `HarnessScope` | 0 | 2 |
| `createDefaultInstance` | 0 | 2 |
| `createHarness` | 0 | 2 |

**为什么重要：** 文件第 17 行注释明确承认"Instance/Harness 层设计完整但无消费方"。所有 7 个导出在生产路径中零使用。这是设计先行但从未接入的典型案例。

**修复建议：** 删除 `src/agents/instance-harness.ts` 及相关测试文件。

---

### Critical-5：`src/skills/skill-prompt-command.ts` —— 零引用

**文件：** [src/skills/skill-prompt-command.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/skills/skill-prompt-command.ts)

| 导出 | 生产引用 | 测试引用 |
|------|---------|---------|
| `parseSkillArgs` | 0 | 0 |
| `substituteArgs` | 0 | 0 |
| `SkillPromptResult` | 0 | 0 |
| `ParsedSkillArgs` | 0 | 0 |

**为什么重要：** 不仅生产代码零引用，连测试文件都没有。这是一个完全未被任何人使用的模块，可能是 Skill 系统早期实验的遗留物。

**修复建议：** 直接删除 `src/skills/skill-prompt-command.ts`。

---

## 二、确认的零生产引用模块

### Important-1：`src/config/presets.ts` —— 预设系统从未启用

**文件：** [src/config/presets.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/config/presets.ts)

| 导出 | 生产引用 | 测试引用 |
|------|---------|---------|
| `getPresetConfig` | 0 | 1（自测） |
| `applyPreset` | 0 | 1 |
| `listPresets` | 0 | 1 |

**为什么重要：** 配置预设功能（`getPresetConfig`、`applyPreset`、`listPresets`）实现完整，但从未被任何业务模块调用。唯一引用来自测试文件的自测。`desktop/renderer/src/components/SetupWizard.tsx` 中有同名函数但是局部定义，并非从此文件导入。

**修复建议：** 删除 `src/config/presets.ts` 及 `tests/config/presets.test.ts`。

---

### Important-2：`src/config/watcher.ts` —— 配置热更新从未启用

**文件：** [src/config/watcher.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/config/watcher.ts)

| 导出 | 生产引用 | 测试引用 |
|------|---------|---------|
| `ConfigWatcher` | 0 | 1（自测） |

**为什么重要：** `ConfigWatcher` 类实现了配置文件变更监听功能，但从未被生产代码实例化。`src/code-map/watcher.ts` 注释中提到"与 config/watcher.ts 保持一致的实现模式"，说明此模块被当作参考实现保留，但实际从未运行。

**修复建议：** 删除 `src/config/watcher.ts` 及 `tests/config/watcher.test.ts`。

---

## 三、运行时死代码（仅 type-only 引用，实例化已移除）

### Important-3：`src/evaluation/saturation-monitor.ts`

**文件：** [src/evaluation/saturation-monitor.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/evaluation/saturation-monitor.ts)

- **唯一外部引用：** `completion-gate.ts` 第 11 行 `import type { SaturationMonitor, EvaluationRunResult, SaturationMonitorConfig }`（纯类型导入，编译后擦除）
- `completion-gate.ts` 定义了 `setSaturationMonitor()` 方法（第 98 行），但**该方法在整个代码库中从未被调用**
- `app-init.ts` 第 2530-2532 行注释明确表示实例化代码已在 Phase 59 中移除

**修复建议：** 删除 `src/evaluation/saturation-monitor.ts`，同时移除 `completion-gate.ts` 中的 `setSaturationMonitor()` 方法和 type-only import。

---

### Important-4：`src/evaluation/process-defect-ontology.ts` —— 10 个导出中 9 个未使用

**文件：** [src/evaluation/process-defect-ontology.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/evaluation/process-defect-ontology.ts)

| 导出 | 外部引用 |
|------|---------|
| `ProcessDefect`（interface） | 1（`score-card.ts`，type-only import） |
| `DefectCategory` | 0 |
| `CalibratedScorecard` | 0 |
| `DefectDetectionConfig` | 0 |
| `DEFECT_DESCRIPTIONS` | 0 |
| `classifyDefect` | 0 |
| `calibrateRisk` | 0 |
| `computeControlPreservation` | 0 |
| `computeProcessGrade` | 0 |
| `buildCalibratedScorecard` | 0 |

**为什么重要：** 10 个导出中只有 `ProcessDefect` 类型被引用（编译后擦除）。`buildCalibratedScorecard`、`classifyDefect`、`calibrateRisk` 等核心函数虽然内部互相调用，但没有任何外部模块调用它们。这是一个"自包含但封闭"的计算系统——实现了完整的过程缺陷分类与评分，但从未被任何生产流程触发。

**修复建议：** 保留 `ProcessDefect` interface 并迁移到 `score-card.ts` 中（或提取到共享 types 文件），删除其余 9 个死导出和整个文件。

---

## 四、"数据黑洞"模块（被实例化但产出从未被消费）

### Important-5：`src/agent/curated-set.ts` —— 数据收集后无人读取

**文件：** [src/agent/curated-set.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/agent/curated-set.ts)

- **唯一生产消费者：** `context-compaction.ts` 第 167 行实例化 `CuratedSet`，第 752 行 `populateCuratedSet()` 写入数据
- **问题：** `context-compaction.ts` 的 `getCuratedSet()` 方法（第 801 行）在整个 `src/` 中**从未被任何代码调用**
- **实质：** CPU 和内存被消耗用于收集和排序数据，但这些数据从未被下游模块读取或使用

**为什么重要：** 这比纯死代码更隐蔽——它在运行时执行了真实计算，占用了 token 预算和内存，但产出的数据被丢弃。在长对话场景下可能造成不必要的性能开销。

**修复建议：** 要么接入 `getCuratedSet()` 的消费者（如注入到下一轮 prompt 构建中），要么移除 `CuratedSet` 的实例化和写入逻辑以节省运行时资源。

---

### Important-6：`src/agent/verification-records.ts` —— 记录写入后无人读取

**文件：** [src/agent/verification-records.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/agent/verification-records.ts)

- **唯一生产消费者：** `context-compaction.ts` 第 213 行实例化 `VerificationRecords`，第 765 行写入验证记录
- **问题：** `context-compaction.ts` 的 `getVerificationRecords()` 方法（第 810 行）在整个 `src/` 中**从未被任何代码调用**
- **实质：** 与 `curated-set.ts` 相同——验证记录被写入后从未被读取或用于决策

**修复建议：** 同上，要么接入消费者，要么移除写入逻辑。

---

## 五、冗余 Barrel 文件

### Minor-1：`src/observability/index.ts`

**文件：** [src/observability/index.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/observability/index.ts)

- 转导出 `OtelExporter`、`TrajectoryOtelBridge` 等符号
- **0 个生产导入，0 个测试导入**
- 底层模块（`integration.ts`、`otel-exporter.ts`）通过直接路径被 `app-init.ts` 动态引用

**修复建议：** 删除此 barrel 文件。

---

### Minor-2：`src/security/index.ts`

**文件：** [src/security/index.ts](file:///c:/Users/%E6%9D%A8%E9%93%AD/Desktop/Agent/routedev/src/security/index.ts)

- `export * from './audit-panel.js'`、`export * from './sandbox.js'`、`export * from './integrity-manifest.js'`
- **0 个生产导入，0 个测试导入**
- 底层模块各自有独立导入路径

**修复建议：** 删除此 barrel 文件。

---

## 六、低可达性代码（单链路依赖，需关注）

以下模块虽然不算死代码，但仅通过单一链路进入生产代码。如果上游模块被重构或移除，这些文件会立即变成死代码：

| 文件 | 唯一生产消费者 | 风险 |
|------|--------------|------|
| `src/agent/budget-aware-renderer.ts` | `context-compaction.ts` | 如果压缩模块重构则变成死代码 |
| `src/agent/branch-operations.ts` | `branch.ts` | 与 branch 系统强耦合 |
| `src/agent/loop-memory.ts` | `dual-loop-orchestrator.ts` | 仅双循环编排器使用 |

这些模块当前保留是合理的，但建议在注释中标明其唯一依赖关系，以便未来重构时注意。

---

## 七、高风险模块（仅动态 import + 无独立测试）

以下 3 个文件仅通过 `app-init.ts` 的动态 `import()` 加载，且完全没有独立测试文件。如果动态加载路径出错，不会有任何编译期或测试期报错：

| 文件 | 动态加载位置 | 测试覆盖 |
|------|------------|---------|
| `src/policies/intent-guard.ts` | `app-init.ts:1414` | **0 个测试** |
| `src/policies/tool-approval.ts` | `app-init.ts:1450` | **0 个测试** |
| `src/policies/tool-guide.ts` | `app-init.ts:1438` | **0 个测试** |

**为什么重要：** 这些策略模块通过 PolicyEngine 插件架构注册，运行时才动态加载。缺少测试意味着如果策略逻辑有 bug（如 deny 规则错误），可能在生产环境中造成工具执行异常而无法提前发现。

**修复建议：** 为每个策略模块补充至少 1 个单元测试，覆盖其 `evaluate()` 方法的核心路径。

---

## 八、`dead-code-report.json` 机器扫描数据参考

项目自带的 `scripts/detect-dead-code.ts` 扫描报告显示：

| 指标 | 数值 |
|------|------|
| 总 export 数 | 1530 |
| 死代码 export（无 src/ 和 tests/ 消费方） | ~380 |
| 仅测试使用的 export | ~330 |

死代码 export 高频分布目录：
- `src/config/schema.ts` — ~80 个未使用的 type/const（大量配置类型冗余）
- `src/agent/` — ~60 个未使用的 interface/type
- `src/agent/multi/` — ~15 个
- `src/policies/` — ~15 个
- `src/code-map/` — ~12 个

本次人工审查聚焦于**整文件/整目录级**的死代码模块，机器报告中的 ~380 个 export 级死代码（主要是未使用的 interface/type 定义）未逐一列出，建议通过 `pnpm detect-dead-code` 定期扫描清理。

---

## 九、审计脚本双写问题

`scripts/audit-dead-code.ts`（Phase 53 旧版）和 `scripts/detect-dead-code.ts`（Phase 71 新版）都向项目根的 `dead-code-report.json` 写入，后执行者覆盖先执行者。建议废弃 `audit-dead-code.ts` 的 JSON 写入功能，仅保留 `detect-dead-code.ts` 作为唯一报告生成器。

---

## 十、汇总统计

| 类别 | 文件/目录数 | 处理方式 |
|------|-----------|---------|
| 完全死代码的整目录 | 1（deep-review/，4 文件） | 删除整个目录 |
| 完全死代码的整文件 | 5（prompts.ts, requirements-clarifier.ts, instance-harness.ts, skill-prompt-command.ts, 2 barrel 文件） | 删除文件及对应测试 |
| 零生产引用的独立模块 | 2（presets.ts, watcher.ts） | 删除文件及对应测试 |
| 运行时死代码（仅 type 引用） | 2（saturation-monitor.ts, process-defect-ontology.ts） | 删除或提取有用部分 |
| 数据黑洞模块 | 2（curated-set.ts, verification-records.ts） | 接入消费者或移除写入 |
| 冗余 barrel 文件 | 2（observability/index.ts, security/index.ts） | 删除 |
| 无测试的动态加载模块 | 3（intent-guard.ts, tool-approval.ts, tool-guide.ts） | 补充测试 |
| **合计** | **~21 项** | |

---

## 十一、做得好的地方

1. **Phase 50 + Phase 56-60 的大规模清理**：已删除 20+ 整文件、22 个未调用函数、84 个多余 export、约 3000+ 行代码，将死代码 export 从可能的 700+ 降至 380，清理效率高。
2. **自动化检测体系完善**：`detect-dead-code.ts` 脚本区分了 dead / test-only / entry-file 三种状态，配合白名单机制避免误报，可持续监控新增死代码。
3. **`app-init.ts` 作为集中装配中心**：约 130 个模块通过此单一入口组装，使得生产代码路径清晰可追踪，大大降低了死代码识别的难度。

---

## 十二、修复优先级建议

| 优先级 | 项目 | 预期清理行数 |
|--------|------|-----------|
| P0（立即） | `deep-review/` 整个目录 | ~500 行 |
| P0（立即） | `src/agent/prompts.ts` | ~120 行 |
| P0（立即） | `src/agents/instance-harness.ts` | ~200 行 |
| P1（本 Phase） | `requirements-clarifier.ts`、`skill-prompt-command.ts` | ~300 行 |
| P1（本 Phase） | `config/presets.ts`、`config/watcher.ts` | ~250 行 |
| P1（本 Phase） | `saturation-monitor.ts`、`process-defect-ontology.ts` 清理 | ~400 行 |
| P2（下 Phase） | `curated-set.ts`、`verification-records.ts` 数据黑洞处理 | 需要设计决策 |
| P2（下 Phase） | barrel 文件删除、测试补充 | ~50 行 |
| **合计** | | **~1800+ 行** |

---

*报告生成工具：qwen3.7max 全量代码审查*  
*审查日期：2026-07-05*
