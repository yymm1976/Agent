# Phase 92：大文件拆分

**目标：** 拆分 5 个超限文件，降低单文件改动成本与审查 token 消耗，提升子 Agent 可读性。

**架构：** 参照现有 `app-init.ts` 拆分模式（app-init-agent / app-init-memory / app-init-observability / app-init-router / app-init-tools），按职责抽取为独立函数文件，主文件改为 dispatcher。不新增抽象层或工厂模式。

**Token 原则：** 拆分不改逻辑，仅移动代码；抽取的函数保持原有签名；不引入新类型或接口（除非原文件内部已定义但未导出）。

**涉及文件：**
- 修改：`routedev/src/runtime/goal-runner.ts`（44 imports → 拆分）
- 修改：`routedev/src/runtime/app-init-agent.ts`（1233 行 → 拆分）
- 修改：`routedev/src/code-map/extractor.ts`（740 行 → 拆分）
- 修改：`routedev/src/tools/builtin/spawn-agent.ts`（345 行 → 拆分）
- 修改：`routedev/desktop/renderer/src/pages/SettingsPage.tsx`（462 行 → 拆分）

**关联技术债：** TD-02 / TD-08 / TD-09 / TD-10 / TD-11（均 Medium）

---

## 明确不做

- 不重写被拆分代码的逻辑（仅移动 + 调整 import）
- 不引入新设计模式（如策略模式、工厂模式）
- 不新增配置项或 Pack 门控
- 不在拆分过程中"顺手"修复其他 finding
- 不改变公共 API 签名（导出函数名 / 参数 / 返回值保持不变）

---

### Task 1：goal-runner.ts 拆分（TD-02）

**文件：**
- 修改：`routedev/src/runtime/goal-runner.ts`
- 新建：`routedev/src/runtime/goal-runner-persist.ts`（持久化职责）
- 新建：`routedev/src/runtime/goal-runner-load.ts`（Goal 加载与校验职责）

- [ ] **Step 1：梳理 goal-runner.ts 职责边界**

当前 44 imports 覆盖：Goal 生命周期 / 步骤调度 / 工具确认 / 恢复 / 持久化。其中步骤调度 / 确认 / 恢复已在 Phase 79 拆出（goal-runner-core / confirm / scheduler / recovery）。

本 Task 仅拆剩余两块：
- 持久化：save / load / snapshot 读写
- Goal 加载与校验：解析 Goal JSON / 校验步骤 ID / 构建 DAG

- [ ] **Step 2：抽取 goal-runner-persist.ts**

将 saveState / loadState / saveSnapshot 函数移至新文件，goal-runner.ts 仅 import 调用。
保持函数签名不变，导出方式不变。

- [ ] **Step 3：抽取 goal-runner-load.ts**

将 parseGoal / validateGoal / buildDag 函数移至新文件。

- [ ] **Step 4：验证拆分无逻辑改动**

```powershell
rtk git diff --stat
```

预期：新增 2 文件，goal-runner.ts 行数下降，无逻辑修改。

- [ ] **Step 5：运行测试**

```powershell
rtk err pnpm test -- tests/runtime/ --run
```

预期：Phase-91 新增的 goal-runner 测试全部通过。

---

### Task 2：createAgentSubsystem 拆分（TD-08）

**文件：**
- 修改：`routedev/src/runtime/app-init-agent.ts`
- 新建：`routedev/src/runtime/app-init-agent-trust.ts`（TrustGradient 装配）
- 新建：`routedev/src/runtime/app-init-agent-middleware.ts`（中间件装配）
- 新建：`routedev/src/runtime/app-init-agent-loop.ts`（ReActAgentLoop 装配）

- [ ] **Step 1：识别 15 个职责区块**

当前 1233 行包含 15 个独立职责区块（TrustGradient / PermissionMiddleware / QualitySignal / ExpertisePrompt / ReActAgentLoop / CompletionGate / DualLoop / SubAgent / Vision / MemoryInjector / Hooks / ToolRegistry / Router / Checkpoint / Dispose）。

按内聚性合并为 3 个抽取文件：
- agent-trust：TrustGradient + PermissionMiddleware
- agent-middleware：QualitySignal + ExpertisePrompt + Hooks
- agent-loop：ReActAgentLoop + DualLoop + CompletionGate + SubAgent

- [ ] **Step 2：抽取 agent-trust.ts**

将 TrustGradientManager / PermissionEngine / PermissionMiddleware 的创建与装配代码移至新文件，导出 `setupAgentTrust(config, deps)` 函数。

- [ ] **Step 3：抽取 agent-middleware.ts**

将 QualitySignal / ExpertisePrompt / Hooks 的创建与注册代码移至新文件，导出 `setupAgentMiddleware(config, deps)` 函数。

- [ ] **Step 4：抽取 agent-loop.ts**

将 ReActAgentLoop / DualLoop / CompletionGate / SubAgent 的创建代码移至新文件，导出 `setupAgentLoop(config, deps, trust, middleware)` 函数。

- [ ] **Step 5：主文件改为 dispatcher**

app-init-agent.ts 仅保留 createAgentSubsystem 主函数，调用 3 个 setup 函数。

- [ ] **Step 6：运行测试**

```powershell
rtk err pnpm test -- tests/runtime/app-init --run
rtk err pnpm typecheck
```

---

### Task 3：walkAndExtract 拆分（TD-09）

**文件：**
- 修改：`routedev/src/code-map/extractor.ts`
- 新建：`routedev/src/code-map/extractor-ts.ts`
- 新建：`routedev/src/code-map/extractor-py.ts`
- 新建：`routedev/src/code-map/extractor-java.ts`
- 新建：`routedev/src/code-map/extractor-go.ts`

- [ ] **Step 1：识别 4 语言分支**

当前 740 行按语言分 4 块（TS / Python / Java / Go），每块约 150-200 行。

- [ ] **Step 2：抽取各语言 extractor**

每种语言抽取为独立文件，导出 `extractXxx(filePath, content): CodeSymbol[]` 函数。

- [ ] **Step 3：主文件改为 dispatcher**

extractor.ts 的 walkAndExtract 改为按语言扩展名 dispatch 到对应 extractor。

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm test -- tests/code-map/ --run
```

---

### Task 4：wrapSpawnAgentWithDelegation 拆分（TD-10）

**文件：**
- 修改：`routedev/src/tools/builtin/spawn-agent.ts`

- [ ] **Step 1：识别 4 阶段**

当前 345 行包含 4 阶段：applyDelegationPolicy / packContext / checkDelegationGate / executeSpawn。

- [ ] **Step 2：抽取为独立函数**

在同文件内抽取 4 个函数（不新建文件，345 行拆分后主函数约 80 行，无需多文件）。

- [ ] **Step 3：运行测试**

```powershell
rtk err pnpm test -- tests/tools/spawn-agent --run
```

---

### Task 5：SettingsPage 拆分（TD-11）

**文件：**
- 修改：`routedev/desktop/renderer/src/pages/SettingsPage.tsx`
- 新建：`routedev/desktop/renderer/src/components/settings/SettingsTabNav.tsx`
- 新建：`routedev/desktop/renderer/src/components/settings/SettingsDialogs.tsx`

- [ ] **Step 1：抽取 Tab 导航**

将 Tab 切换逻辑抽取为 SettingsTabNav 组件。

- [ ] **Step 2：抽取对话框**

将设置对话框（确认 / 重置 / 导入导出）抽取为 SettingsDialogs 组件。

- [ ] **Step 3：主页面改为配置驱动**

SettingsPage 保留 30+ Tab 的配置数组，渲染委托给子组件。

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm typecheck
```

---

### Task 6：验收

- [ ] **Step 1：全量测试基线**

```powershell
rtk err pnpm test
```

- [ ] **Step 2：typecheck**

```powershell
rtk err pnpm typecheck
```

- [ ] **Step 3：更新技术债跟踪表**

将 TD-02 / TD-08 / TD-09 / TD-10 / TD-11 移至 §3 历史区。

---

## 依赖关系

- Task 1（goal-runner 拆分）建议在 Phase-91 完成后进行（有测试保障拆分正确性）
- Task 2-5 无相互依赖，可并行
- Phase-94 Task 1（goal-runner-types.ts）依赖本 Phase Task 1 完成

## 验收标准

- 5 个文件行数均降至 300 行以下
- 拆分前后测试全通过
- typecheck 通过
- 公共 API 签名不变
