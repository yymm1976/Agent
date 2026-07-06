# RouteDev 死代码全量审查提示词

> **使用方法**：将本提示词完整粘贴给目标模型（Claude/GPT/Gemini/Qwen/豆包等），模型需具备代码库读取能力（如 Cursor / Trae / Claude Code 等 IDE Agent）。
>
> **项目路径**：`c:\Users\杨铭\Desktop\Agent\routedev`
>
> **历史背景**：本项目已经历六轮死代码清理（累计删除 229 文件 / -35389 行）。代码库已较为干净，但可能仍有残余死代码。审查者需提高判断门槛，避免高误报率。

---

## 一、角色与任务

你是 RouteDev 项目的死代码审查专家。请对项目全量代码进行死代码审查，输出结构化报告。

**审查目标**：找出真正未被生产路径调用的死代码，而非"未被入口白名单直接 import 的模块"。

**严禁行为**：
- 严禁仅基于 `detect-dead-code.ts` 脚本输出就判定死代码（该脚本有已知缺陷）
- 严禁把"默认关闭的可选功能"判定为死代码
- 严禁把"通过动态 import 接入的模块"判定为死代码
- 严禁在不读取实际代码的情况下推测接线状态
- 严禁把 TypeScript 类型导出（interface/type）列为需要删除的死代码

---

## 二、项目架构与生产路径

### 2.1 技术栈
- TypeScript 6.x + Electron 33 + React 19（strict 模式，ESM）
- 桌面应用，无 CLI 入口（CLI 已在 Phase 72 退役）
- 构建工具：electron-vite + tsc

### 2.2 生产入口链路（唯一入口）

```
desktop/main/index.ts          ← Electron 主进程入口
  └─ desktop/main/engine-bridge.ts   ← 核心桥接层，this.deps.<field> 访问所有依赖
       └─ src/runtime/app-init.ts    ← 核心装配工厂，createAppDependencies()
            ├─ 静态 import：核心模块
            ├─ 动态 import()：可选模块（变量路径 + fail-open）
            └─ 实例化后返回 AppDependencies 对象
                 ├─ src/agent/loop.ts          ← 聊天循环
                 ├─ src/runtime/goal-runner.ts ← /goal 命令执行
                 └─ src/tools/builtin/*        ← 工具注册
```

**渲染进程入口**：`desktop/renderer/src/main.tsx → App.tsx`

### 2.3 关键设计模式（必须理解，否则会大量误报）

#### 模式 1：动态 import + fail-open（app-init.ts 大量使用）

```typescript
// app-init.ts 中的典型模式
const modulePath = '../agent/middleware/code-map-context.js';
import(modulePath)
  .then((mod) => {
    if (typeof mod.CodeMapContextMiddleware === 'function') {
      const middleware = new mod.CodeMapContextMiddleware(...);
      agentLoop.registerMiddleware(middleware);
    }
  })
  .catch(() => { /* fail-open: 模块加载失败不阻塞启动 */ });
```

**踩坑点**：6 份历史报告中，4 份因为不识别此模式，把所有通过动态 import 接入的模块误判为死代码。**动态 import 是有效的生产引用**，不是死代码。

#### 模式 2：配置门控的可选功能（默认 enabled: false）

```typescript
// defaults.ts 中的典型配置
phase68Integration: {
  provenanceGraph: { enabled: false }  // 默认关闭，但代码完整
}

// goal-runner.ts 中的消费方式
if (deps.provenanceGraph) {
  deps.provenanceGraph.addArtifact({...});  // 有真实方法调用
}
```

**踩坑点**：`enabled: false` ≠ 死代码。这些是"默认关闭的可选功能"，用户可在 config 中开启。只要代码中有真实的方法调用链（`deps.xxx.method()`），就是活代码。历史上 3 份报告把 13-25 个此类配置全部误判为"僵尸配置"。

#### 模式 3：deps 注入 + 条件消费

```typescript
// app-init.ts 返回 deps 对象
return {
  memoryStore,      // ← 被 goal-runner.ts 解构使用 → 活
  hybridRetriever,  // ← 被 goal-runner.ts 解构使用 → 活
  someModule,       // ← 无任何文件解构使用 → 僵尸字段（需确认）
};
```

**判断方法**：Grep 搜索 `deps.someModule` 或 `this.deps.someModule` 在 `src/` + `desktop/` 全目录，0 命中 = 僵尸字段。

---

## 三、审查方法（必须严格遵守）

### 3.1 判定流程（每个待判模块必须走完）

```
Step 1: 确认文件存在
  └─ LS / Glob 确认文件路径

Step 2: 搜索静态 import 引用
  └─ Grep "from.*module-name" 在 src/ + desktop/ 中（排除 tests/ 和文件自身）
  └─ 如果有生产引用 → 活代码，停止

Step 3: 搜索动态 import 引用（关键！）
  └─ Grep "module-name" 在 src/runtime/app-init.ts 中
  └─ 如果有 import(modulePath) → 活代码，停止

Step 4: 搜索 desktop/ 目录引用
  └─ Grep "module-name" 在 desktop/ 中（排除 tests/）
  └─ 如果有引用 → 活代码，停止

Step 5: 搜索类名/函数名引用
  └─ Grep "ClassName|functionName" 在 src/ + desktop/ 中（排除 tests/ 和文件自身）
  └─ 如果有引用 → 活代码，停止

Step 6: 确认是否仅测试引用
  └─ 如果只有 tests/ 引用 → 标记为 "Test-only"，需人工确认

Step 7: 确认是否仅 app-init 实例化但无消费
  └─ Grep "deps.moduleName|this.deps.moduleName" 在 src/ + desktop/ 中
  └─ 0 命中 → 僵尸字段（确认死代码）
```

### 3.2 分类标准

| 类别 | 判定条件 | 处理建议 |
|------|----------|----------|
| **True-Dead（真死代码）** | Step 2-5 全部 0 命中，且 Step 7 确认无消费 | 删除文件 |
| **Zombie-Field（僵尸字段）** | app-init.ts 实例化并返回 deps，但 engine-bridge.ts 和其他文件 0 消费 | 删除实例化 + deps 字段，保留源文件 |
| **Dead-Method（死方法）** | 类被使用，但某个方法 0 调用方 | 删除方法 |
| **Config-Gated（配置门控）** | `enabled: false` 但有真实方法调用链 | **不是死代码，不处理** |
| **Test-Only（仅测试）** | 仅 tests/ 引用 | 需人工确认是否有动态 import 未被发现 |
| **Type-Export（类型导出）** | 仅 TypeScript interface/type 未被外部引用 | **不处理**（不影响运行时） |

### 3.3 交叉验证要求

对于每个标记为 "True-Dead" 或 "Zombie-Field" 的项，**必须**：
1. 派子 Agent 独立核验（如果使用支持子 Agent 的 IDE）
2. 或手动二次确认：换一个搜索关键词重新 Grep
3. 在报告中附上 Grep 命令和命中数

**原因**：历史上 6 份报告的平均误报率为 73%。不交叉验证的报告无价值。

---

## 四、已知踩坑点（必读，避免重复犯错）

### 踩坑点 1：动态 import 误判（历史误报率 90%+）

**错误模式**：模型只搜索 `from 'xxx'` 静态 import，找不到就判死代码。

**实际情况**：app-init.ts 中有 20+ 个模块通过 `const path = '...'; import(path)` 动态加载。

**正确做法**：对每个待判文件，额外搜索文件名（不含扩展名）在 app-init.ts 中的出现。

### 踩坑点 2：配置门控误判（历史误报率 100%）

**错误模式**：看到 `enabled: false` 就判"僵尸配置"。

**实际情况**：Phase 68/69/70 的设计模式就是"defensive feature with config gate"——默认关闭，用户可在 config 中开启。这些模块有完整的消费链路（`if (dep) { dep.method() }`）。

**正确做法**：对于 `enabled: false` 的配置，必须 Grep 搜索对应的实例变量名在 src/ 中的方法调用。有方法调用 = 活代码。

### 踩坑点 3：只搜 src/ 忘了 desktop/（历史误报率 60%+）

**错误模式**：只在 src/ 中搜索引用，忘了 desktop/main/engine-bridge.ts 和 desktop/renderer/。

**实际情况**：`micro-summary.ts`、`omission-checker.ts` 等模块被 desktop/main/engine-bridge.ts 直接 import。

**正确做法**：搜索范围必须包含 `src/` + `desktop/`。

### 踩坑点 4：把类型导出当死代码（历史误报率 100%）

**错误模式**：把 `export interface Foo`、`export type Bar` 未被外部引用的列为死代码。

**实际情况**：TypeScript 类型导出不影响运行时，不需要清理。`detect-dead-code.ts` 脚本会标记大量类型导出为"dead"，但这些都是噪音。

**正确做法**：只关注运行时导出（class、function、const），忽略 interface/type 导出。

### 踩坑点 5：建议删除整目录（历史误报率 100%）

**错误模式**：看到 `src/policies/` 下几个类的 export 未被直接引用，就建议删除整个目录。

**实际情况**：`src/policies/` 下的 `createBuiltinIntentGuardPolicies` 等工厂函数被 app-init.ts 静态 import 并调用，类本身在工厂函数内部使用。

**正确做法**：永远不要建议删除整个目录。逐文件、逐 export 核验。

### 踩坑点 6：不区分"实例化"和"消费"

**错误模式**：看到 `new Foo()` 就认为 Foo 是活代码。

**实际情况**：`new Foo()` 只是实例化。如果创建的实例从未被任何方法调用（如 ExecutionOrchestrator 被实例化但 execute() 从未被调用），整条链路仍是死的。

**正确做法**：对于每个实例化的对象，追踪其方法是否被调用。

### 踩坑点 7：信号监听器 / 事件回调误判

**错误模式**：看到 `triggerShutdown` 函数没有被任何代码直接调用，就判死代码。

**实际情况**：`triggerShutdown` 被信号监听器（SIGINT/SIGTERM）回调，通过 `registerShutdownHook → installSignalListeners → process.on('SIGINT', () => triggerShutdown())` 链路间接调用。

**正确做法**：对于事件回调、信号监听器、Promise.then 回调等，追踪完整调用链。

---

## 五、重点审查模块

以下模块在历史审查中频繁出现误报或真死代码，请重点审查：

### 5.1 高风险区（历史上真死代码高发）

| 区域 | 历史发现 | 审查重点 |
|------|----------|----------|
| `src/runtime/app-init.ts` | 僵尸字段（实例化但无消费） | 逐个检查 return deps 中的字段是否被 engine-bridge.ts 消费 |
| `src/agent/loop.ts` | 死方法、陈旧注释 | 检查 setXxx() 方法是否有调用方 |
| `src/runtime/goal-runner.ts` | 解构但未调用的依赖 | 检查解构出的变量是否有方法调用 |
| `src/agent/dual-loop-orchestrator.ts` | 死链（如已删的 metricsCollector） | 检查 setXxx() 方法和 if (this.xxx) 分支 |
| `src/config/defaults.ts` | 配置断裂（配置了但未传递） | 检查配置是否被 app-init.ts 传递给对应模块 |

### 5.2 误报高发区（历史上被误判的模块，请谨慎）

| 区域 | 被误判原因 | 正确状态 |
|------|------------|----------|
| `src/policies/*` | 未识别静态 import | 活代码（PolicyEngine 在第四轮改为静态 import） |
| `src/import/*` | 未识别动态 import | 活代码（被 app-init.ts 动态 import） |
| `src/mcp/claude-bridge.ts` | 未识别动态 import | 活代码 |
| `src/tools/builtin/browser.ts` | 未识别动态 import | 活代码 |
| `src/agent/micro-summary.ts` | 未搜索 desktop/ | 活代码（被 engine-bridge.ts 引用） |
| `src/agent/omission-checker.ts` | 未搜索 desktop/ | 活代码（被 engine-bridge.ts 动态 import） |
| `src/security/audit-panel.ts` | 未搜索全部 import | 活代码（被 4 个安全模块引用） |
| `src/code-map/fallback.ts` | 未识别动态 import | 活代码（被 app-init.ts 动态 import） |
| Phase 68/70 配置 | 把"默认关闭"当死代码 | 活代码（配置门控的可选功能） |

### 5.3 已清理区域（不需要重复审查）

以下已在六轮清理中处理，除非有新代码引入，否则不需要重复审查：
- `src/agent/execution-orchestrator.ts` — 已删除（第五轮）
- `src/scheduler/` — 整目录已删除（第五轮）
- `src/memory/incremental-extractor.ts` — 已删除（第五轮）
- `src/memory/conservative-merger.ts` — 已删除（第五轮）
- `src/skills/sdk-loader.ts` + `sdk.ts` — 已删除（第四轮）
- `src/agent/context/system-prompt-builder.ts` — 已删除（第四轮）
- `src/cli/` — 已重命名为 `src/runtime/` 并清理（第三轮）

---

## 六、输出格式要求

### 6.1 报告结构

```markdown
# RouteDev 死代码审查报告

> 审查模型：[模型名称]
> 审查日期：[日期]
> 审查范围：src/ + desktop/（排除 tests/、node_modules/）
> 生产入口：desktop/main/index.ts → engine-bridge.ts → app-init.ts

## 1. 执行摘要
- 审查文件数：xxx
- 确认死代码：x 项
- 需人工裁决：x 项
- 误报排除：x 项（附理由）

## 2. 确认死代码清单
### 2.1 True-Dead（纯死文件）
| 文件 | 死因 | 验证命令 | 命中数 |
|------|------|----------|--------|
| ... | ... | `grep -r "xxx" src/ desktop/` | 0 |

### 2.2 Zombie-Field（僵尸字段）
| 字段 | app-init 实例化行 | engine-bridge 消费 | 验证命令 |
|------|-------------------|-------------------|----------|
| ... | Lxxx | 0 命中 | `grep "deps.xxx" src/ desktop/` |

### 2.3 Dead-Method（死方法）
| 方法 | 定义位置 | 调用方 | 验证命令 |
|------|----------|--------|----------|
| ... | ... | 0 | `grep "methodName" src/ desktop/` |

### 2.4 Wiring-Bug（配置断裂）
| 配置项 | defaults.ts 位置 | app-init.ts 传递 | 影响 |
|--------|------------------|------------------|------|
| ... | Lxxx | ❌ 未传递 | ... |

## 3. 需人工裁决清单
| 模块 | 原因 | 建议 |
|------|------|------|

## 4. 误报排除清单（自查记录）
| 模块 | 初判 | 实际状态 | 排除理由 |
|------|------|----------|----------|

## 5. 交叉验证记录
| 项 | 核验方法 | 核验结果 |
|----|----------|----------|
```

### 6.2 必须附带的验证证据

每个死代码判定**必须**附带：
1. **Grep 命令**（完整的搜索模式 + 范围）
2. **命中数**（0 命中才能判死）
3. **已排除的范围**（如"排除 tests/ 和文件自身"）

**不带证据的判定一律视为幻觉。**

---

## 七、审查流程建议

### 阶段 1：建立全景（30%）

1. Read `src/runtime/app-init.ts`，理解 AppDependencies 接口和返回的 deps 对象
2. Read `desktop/main/engine-bridge.ts`，理解 `this.deps.<field>` 消费了哪些字段
3. Read `src/config/defaults.ts`，理解所有配置项的默认值
4. Read `src/config/schema.ts`，理解配置结构

### 阶段 2：逐模块核验（50%）

对 `src/` 下每个子目录：
1. LS 列出所有 .ts 文件
2. 对每个文件，按"三、3.1 判定流程"走完 7 步
3. 记录每步的 Grep 命令和命中数

### 阶段 3：交叉验证（20%）

1. 对所有标记为死代码的项，换关键词重新 Grep
2. 检查是否有动态 import 被遗漏
3. 检查是否有 desktop/ 引用被遗漏
4. 检查是否有事件回调/Promise 链路被遗漏

---

## 八、质量自检清单（提交报告前必须过）

- [ ] 每个死代码判定都附带了 Grep 命令和命中数
- [ ] 搜索范围包含 src/ + desktop/（不只是 src/）
- [ ] 已检查动态 import（搜索文件名在 app-init.ts 中的出现）
- [ ] 未把 `enabled: false` 的配置门控功能判为死代码
- [ ] 未把 TypeScript 类型导出判为需要删除的死代码
- [ ] 未建议删除整个目录
- [ ] 已区分"实例化"和"方法调用"（有 new 不等于活）
- [ ] 已检查事件回调/信号监听器的间接调用链
- [ ] 所有 True-Dead 项经过交叉验证

---

## 九、已知活代码白名单（不需要审查）

以下模块已在前六轮中确认为活代码，除非有新代码变更，否则不需要重复审查：

**核心运行时**：
- `src/runtime/app-init.ts` — 装配工厂（活，但内部可能有待清理的僵尸字段）
- `src/runtime/goal-runner.ts` — /goal 执行器
- `src/agent/loop.ts` — 聊天循环
- `src/agent/dual-loop-orchestrator.ts` — 双循环编排

**安全策略（第四轮改为静态 import）**：
- `src/policies/policy-engine.ts`
- `src/policies/intent-guard.ts`
- `src/policies/playbook.ts`
- `src/policies/tool-guide.ts`
- `src/policies/tool-approval.ts`

**记忆系统**：
- `src/memory/memory-store.ts`
- `src/memory/hybrid-retriever.ts`
- `src/memory/bm25-index.ts`（被 hybrid-retriever 使用）
- `src/memory/codebase-memory.ts`（被 app-init 动态 import）
- `src/memory/local-maintenance.ts`

**工具系统**：
- `src/tools/builtin/*`（全部通过 app-init.ts 注册）

**导入系统（被 app-init.ts 动态 import）**：
- `src/import/claude-plugin-importer.ts`
- `src/import/codex-importer.ts`
- `src/import/anthropic-skills-loader.ts`
- `src/mcp/claude-bridge.ts`

**Desktop 层**：
- `desktop/main/engine-bridge.ts`
- `desktop/renderer/src/App.tsx`
- 所有 `desktop/renderer/src/components/*.tsx`

---

## 十、预期产出

| 指标 | 目标 |
|------|------|
| 误报率 | < 20%（历史平均 73%，要求大幅降低） |
| True-Dead 文件 | 预计 < 5 个（已清理六轮） |
| Zombie-Field | 预计 < 5 个 |
| Wiring-Bug | 预计 < 2 个 |
| 每项判定附带 Grep 证据 | 100% |
| 交叉验证覆盖率 | 100% |

**如果报告中标记的死代码超过 20 项，极大概率是误报**——六轮清理后残余死代码应很少。请对超过 20 项的报告自查是否遗漏了动态 import 检查。

---

*本提示词基于六轮死代码审查的踩坑经验编写，历史误报模式已全部纳入踩坑点清单。*
