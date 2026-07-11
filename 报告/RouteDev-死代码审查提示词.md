# RouteDev 死代码全量审查提示词

> **使用方法**：将本提示词完整粘贴给目标模型（Claude/GPT/Gemini/Qwen/豆包等），模型需具备代码库读取能力（如 Cursor / Trae / Claude Code 等 IDE Agent）。
>
> **项目路径**：`c:\Users\杨铭\Desktop\Agent\routedev`
>
> **版本说明（v1.2 / 2026-07-11）**：在六轮清理经验之上，增加 **Core / Pack / Experimental 分层** 判定。冻结中的实验模块 ≠ 死代码；默认关闭的能力包 ≠ 死代码。
>
> **历史背景**：本项目已经历六轮死代码清理（累计删除 229 文件 / -35389 行）。代码库已较为干净，但可能仍有残余死代码。审查者需提高判断门槛，避免高误报率。
>
> **必读分层文档（若存在）**：
> - `../蓝图与Phase/BLUEPRINT-CORE-CAPABILITY-PACK-v3.md`
> - `routedev/docs/CAPABILITY_LAYERS.md`
> - `routedev/docs/SLIMDOWN_BOARD.md`

---

## 一、角色与任务

你是 RouteDev 项目的死代码审查专家。请对项目全量代码进行死代码审查，输出结构化报告。

**审查目标**：找出真正未被生产路径调用的死代码，而非"未被入口白名单直接 import 的模块"。

**分层目标（v1.2 新增）**：在死/活之外，额外标注模块属于：
- **Core**：默认生产路径
- **Pack**：能力包，按需加载
- **Experimental / Freeze**：冻结观察，允许存在但不应继续扩张
- **True-Dead**：可删除

**严禁行为**：
- 严禁仅基于 `detect-dead-code.ts` 脚本输出就判定死代码（该脚本有已知缺陷）
- 严禁把"默认关闭的可选功能"判定为死代码
- 严禁把"通过动态 import 接入的模块"判定为死代码
- 严禁把 **Capability Pack 默认未加载** 判定为死代码
- 严禁把 **Experimental 冻结模块** 直接写成“必须删除”，除非同时满足 True-Dead 证据
- 严禁在不读取实际代码的情况下推测接线状态
- 严禁把 TypeScript 类型导出（interface/type）列为需要删除的死代码

---

## 二、项目架构与生产路径

### 2.1 技术栈
- TypeScript 6.x + Electron 34 + React 19（strict 模式，ESM）
- 桌面应用，无 CLI 入口（CLI 已在 Phase 72 退役）
- 构建工具：electron-vite + tsc
- 产品路线：Core 最小化 + Capability Pack 按需加载（Phase 80–84）

### 2.2 生产入口链路（唯一入口）

```
desktop/main/index.ts          ← Electron 主进程入口
  └─ desktop/main/engine-bridge.ts   ← 核心桥接层，this.deps.<field> 访问所有依赖
       └─ src/runtime/app-init.ts    ← 核心装配工厂，createAppDependencies()
            ├─ 静态 import：核心模块
            ├─ 动态 import()：可选模块（变量路径 + fail-open）
            ├─（规划中）CapabilityPack.register：按需能力包
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

#### 模式 4：Capability Pack / 冻结层（v1.2）

```text
Core        → 默认装配、默认注册工具
Pack        → config packs.<id>.enabled 或历史 *Integration.enabled 控制
Experimental→ 允许保留源码与类型，但生产默认不导入；标记 freeze
```

**正确处理**：
- Pack 有 `register()` / 条件装配 / 设置开关 → **不是死代码**
- Experimental 仅被测试引用 + 文档标明 freeze → 归 **Freeze**，不是 True-Dead
- 只有“无静态/动态引用、无 Pack 注册、无配置门控消费、无事件回调”才是 True-Dead

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
  └─ Grep "module-name" 在 src/runtime/app-init*.ts 中
  └─ 如果有 import(modulePath) → 活代码，停止

Step 4: 搜索 desktop/ 目录引用
  └─ Grep "module-name" 在 desktop/ 中（排除 tests/）
  └─ 如果有引用 → 活代码，停止

Step 5: 搜索类名/函数名引用
  └─ Grep "ClassName|functionName" 在 src/ + desktop/ 中（排除 tests/ 和文件自身）
  └─ 如果有引用 → 活代码，停止

Step 6: 搜索 Pack / 配置门控
  └─ Grep packs.|Integration|CapabilityPack|register( 相关 id
  └─ 有门控装配 → 归 Pack 或 Config-Gated，不是死代码

Step 7: 确认是否仅测试引用
  └─ 如果只有 tests/ 引用 → 标记为 "Test-only" 或 Freeze（若在分层清单）

Step 8: 确认是否仅 app-init 实例化但无消费
  └─ Grep "deps.moduleName|this.deps.moduleName" 在 src/ + desktop/ 中
  └─ 0 命中 → 僵尸字段（确认死代码）
```

### 3.2 分类标准

| 类别 | 判定条件 | 处理建议 |
|------|----------|----------|
| **True-Dead（真死代码）** | Step 2-6 全部 0 命中，且 Step 8 确认无消费 | 删除文件 |
| **Zombie-Field（僵尸字段）** | app-init 实例化并返回 deps，但 engine-bridge 和其他文件 0 消费 | 删除实例化 + deps 字段，保留源文件 |
| **Dead-Method（死方法）** | 类被使用，但某个方法 0 调用方 | 删除方法 |
| **Config-Gated（配置门控）** | `enabled: false` 但有真实方法调用链 | **不是死代码，不处理** |
| **Pack-Gated（能力包门控）** | 仅在 Pack enable 时注册 | **不是死代码**；检查 Pack 文档是否同步 |
| **Freeze（冻结实验）** | 分层清单标 Experimental，生产默认不装配 | **不删**；禁止继续接线扩张 |
| **Test-Only（仅测试）** | 仅 tests/ 引用 | 需人工确认是否有动态 import 未被发现 |
| **Type-Export（类型导出）** | 仅 TypeScript interface/type 未被外部引用 | **不处理** |

### 3.3 交叉验证要求

对于每个标记为 "True-Dead" 或 "Zombie-Field" 的项，**必须**：
1. 派子 Agent 独立核验（如果使用支持子 Agent 的 IDE）
2. 或手动二次确认：换一个搜索关键词重新 Grep
3. 在报告中附上 Grep 命令和命中数
4. 对照 `CAPABILITY_LAYERS.md`（若存在）确认不是 Pack/Freeze

**原因**：历史上 6 份报告的平均误报率为 73%。不交叉验证的报告无价值。

---

## 四、已知踩坑点（必读，避免重复犯错）

### 踩坑点 1：动态 import 误判（历史误报率 90%+）

**错误模式**：模型只搜索 `from 'xxx'` 静态 import，找不到就判死代码。

**正确做法**：对每个待判文件，额外搜索文件名（不含扩展名）在 `app-init*.ts` 中的出现。

### 踩坑点 2：配置门控误判（历史误报率 100%）

**错误模式**：看到 `enabled: false` 就判"僵尸配置"。

**正确做法**：对于 `enabled: false` 的配置，必须 Grep 搜索对应的实例变量名在 src/ 中的方法调用。有方法调用 = 活代码。

### 踩坑点 3：只搜 src/ 忘了 desktop/（历史误报率 60%+）

**正确做法**：搜索范围必须包含 `src/` + `desktop/`。

### 踩坑点 4：把类型导出当死代码（历史误报率 100%）

**正确做法**：只关注运行时导出（class、function、const），忽略 interface/type 导出。

### 踩坑点 5：建议删除整目录（历史误报率 100%）

**正确做法**：永远不要建议删除整个目录。逐文件、逐 export 核验。

### 踩坑点 6：不区分"实例化"和"消费"

**正确做法**：对于每个实例化的对象，追踪其方法是否被调用。

### 踩坑点 7：信号监听器 / 事件回调误判

**正确做法**：对于事件回调、信号监听器、Promise.then 回调等，追踪完整调用链。

### 踩坑点 8：把 Freeze / Pack 当死代码（v1.2）

**错误模式**：多 Agent、高级图谱、Trace/Scorecard、browser 等默认不装，就被写成 True-Dead。

**正确做法**：
- 先查分层清单与配置门控
- Freeze 输出到“冻结观察”，不是删除清单
- Pack 输出到“按需能力”，检查文档/设置是否可达

---

## 五、重点审查模块

### 5.1 高风险区（历史上真死代码高发）

| 区域 | 历史发现 | 审查重点 |
|------|----------|----------|
| `src/runtime/app-init*.ts` | 僵尸字段 | 逐个检查 return deps 是否被消费 |
| `src/agent/loop.ts` | 死方法、陈旧注释 | setXxx() 是否有调用方 |
| `src/runtime/goal-runner*.ts` | 解构未调用 | 变量是否有方法调用 |
| `src/agent/multi/*` | 可能 Freeze | 区分 freeze 与 true-dead |
| `src/config/defaults.ts` | 配置断裂 | 配置是否被传递 |

### 5.2 误报高发区

| 区域 | 被误判原因 | 正确状态 |
|------|------------|----------|
| `src/policies/*` | 未识别静态 import | 活代码 |
| `src/import/*` | 未识别动态 import | Pack/活代码 |
| `src/tools/builtin/browser.ts` | 未识别动态 import | Pack 候选，非死代码 |
| `src/agent/micro-summary.ts` | 未搜索 desktop/ | 活代码 |
| Phase 68/70 配置 | 把默认关闭当死代码 | Config-Gated |
| Trace/Scorecard | 低频入口 | Pack/命令触发，非死代码 |

### 5.3 已清理区域（不需要重复审查）

以下已在六轮清理 + Phase 77 死代码自审中处理，除非有新代码引入，否则不需要重复审查：
- `src/agent/execution-orchestrator.ts` — 已删除
- `src/scheduler/` — 整目录已删除
- `src/memory/incremental-extractor.ts` — 已删除
- `src/memory/conservative-merger.ts` — 已删除
- `src/skills/sdk-loader.ts` + `sdk.ts` — 已删除
- `src/agent/context/system-prompt-builder.ts` — 已删除
- `src/cli/` — 已重命名为 `src/runtime/` 并清理
- Phase 77：`formatTimeline` / `getTraceStepBoundaries` / `StepBoundary` / 旧 `currentGoalId`

---

## 六、输出格式要求

### 6.1 报告结构

```markdown
# RouteDev 死代码审查报告

> 审查模型：[模型名称]
> 审查日期：[日期]
> 审查范围：src/ + desktop/（排除 tests/、node_modules/）
> 生产入口：desktop/main/index.ts → engine-bridge.ts → app-init.ts
> 分层基线：CAPABILITY_LAYERS.md（若有）

## 1. 执行摘要
- 审查文件数：xxx
- 确认死代码：x 项
- Pack/Freeze 保留：x 项
- 需人工裁决：x 项
- 误报排除：x 项

## 2. 确认死代码清单
### 2.1 True-Dead
### 2.2 Zombie-Field
### 2.3 Dead-Method
### 2.4 Wiring-Bug

## 3. 分层保留清单（不是死代码）
### 3.1 Pack-Gated
### 3.2 Freeze

## 4. 需人工裁决清单
## 5. 误报排除清单
## 6. 交叉验证记录
```

### 6.2 必须附带的验证证据

每个死代码判定**必须**附带：
1. **Grep 命令**
2. **命中数**
3. **已排除的范围**
4. **分层结论**（Core/Pack/Freeze/Dead）

**不带证据的判定一律视为幻觉。**

---

## 七、审查流程建议

### 阶段 1：建立全景（30%）
1. Read `app-init*.ts`、`engine-bridge.ts`、`defaults.ts`、`schema.ts`
2. 若存在则 Read `CAPABILITY_LAYERS.md` 与整改蓝图

### 阶段 2：逐模块核验（50%）
按 3.1 流程走完，并标注分层。

### 阶段 3：交叉验证（20%）
换关键词、查动态 import、查 desktop、查 Pack 门控。

---

## 八、质量自检清单

- [ ] 每个死代码判定都附带 Grep 命令和命中数
- [ ] 搜索范围包含 src/ + desktop/
- [ ] 已检查动态 import
- [ ] 未把 `enabled: false` 判为死代码
- [ ] 未把 Pack/Freeze 判为 True-Dead
- [ ] 未把 TypeScript 类型导出判为需删除
- [ ] 未建议删除整个目录
- [ ] 已区分实例化与方法调用
- [ ] 已检查事件回调间接调用链
- [ ] 所有 True-Dead 项经过交叉验证

---

## 九、已知活代码 / 分层白名单（摘要）

**Core（默认活）**：`loop.ts`、`goal-runner*`、`permission-engine`、`router/*`、`tracker`、核心 builtin 工具、checkpoint、project memory

**Pack（默认可关，仍算活）**：browser/web、code-map 高级能力、spawn_agent/subagent、trace replay/scorecard、import/cite/macros

**Freeze（观察，不当死代码删）**：multi orchestrator/blackboard/conflict 默认路径、渐进信任动态升级、隐式经验适配、无证据的复杂并行 goal 调度

**Desktop 层**：`engine-bridge.ts`、`App.tsx`、主要 components

---

## 十、预期产出

| 指标 | 目标 |
|------|------|
| 误报率 | < 20% |
| True-Dead 文件 | 预计 < 5 个 |
| Zombie-Field | 预计 < 5 个 |
| Pack/Freeze 误删建议 | 0 |
| 每项判定附带 Grep 证据 | 100% |
| 交叉验证覆盖率 | 100% |

**如果报告中标记的死代码超过 20 项，极大概率是误报**——请自查是否把 Pack/Freeze/动态 import 算死了。

---

*本提示词基于六轮死代码审查踩坑经验 + Phase 80–84 分层整改路线更新（v1.2）。*
