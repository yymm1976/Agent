# Phase 94：架构耦合治理

**目标：** 消除 goal-runner 子模块 ESM 循环依赖，收敛 Pack 门控散布，调整 agentLoop 创建职责归属，降低架构耦合度。

**架构：** 不新建 Pack 配置系统。将 goal-runner 共享类型与常量移至独立 `goal-runner-types.ts` 文件消除循环依赖；在 app-init.ts 增加显式装配配方步骤计算 `EnabledPacks` 功能矩阵，驱动子模块装配；将 agentLoop 创建从 tools 子系统移至 agent 子系统。

**Token 原则：** 不重写 goal-runner 子模块；不新建 Pack 注册机制；agentLoop 创建移位不改 ReActAgentLoop 类本身。

**涉及文件：**
- 新建：`routedev/src/runtime/goal-runner-types.ts`
- 修改：`routedev/src/runtime/goal-runner-core.ts`
- 修改：`routedev/src/runtime/goal-runner-scheduler.ts`
- 修改：`routedev/src/runtime/goal-runner-recovery.ts`
- 修改：`routedev/src/runtime/app-init.ts`
- 修改：`routedev/src/runtime/app-init-agent.ts`
- 修改：`routedev/src/runtime/app-init-tools.ts`
- 修改：`routedev/src/runtime/app-init-memory.ts`
- 修改：`routedev/src/runtime/app-init-router.ts`

**关联技术债：** TD-18 / TD-19（均 Medium）

---

## 明确不做

- 不重写 goal-runner 子模块逻辑
- 不新建 Pack 配置 DSL 或注册机制
- 不改变 ReActAgentLoop 类签名
- 不引入依赖注入容器
- 不改变现有 Pack 配置 schema

---

### Task 1：goal-runner-types.ts 共享文件（TD-19 上半）

**文件：**
- 新建：`routedev/src/runtime/goal-runner-types.ts`
- 修改：`routedev/src/runtime/goal-runner-core.ts`
- 修改：`routedev/src/runtime/goal-runner-scheduler.ts`
- 修改：`routedev/src/runtime/goal-runner-recovery.ts`
- 修改：`routedev/src/runtime/goal-runner-confirm.ts`

- [ ] **Step 1：识别共享类型与常量**

当前 goal-runner-core.ts:56-58 静态 import 三个子模块，子模块反向 import GoalRunnerCtx 类型和 MAX_CONTEXT_ITEMS 常量，形成循环依赖。

共享内容：
- `GoalRunnerCtx` 类型（接口）
- `MAX_CONTEXT_ITEMS` 常量
- `GoalRunnerState` 类型
- 其他被多模块引用的类型

- [ ] **Step 2：抽取到 goal-runner-types.ts**

将共享类型与常量移至新文件，所有子模块改为从 goal-runner-types.ts import。

- [ ] **Step 3：验证循环依赖消除**

```powershell
npx madge --circular routedev/src/runtime/goal-runner-core.ts
```

预期：无循环依赖。

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm test -- tests/runtime/goal-runner --run
```

---

### Task 2：EnabledPacks 装配配方（TD-19 下半）

**文件：**
- 修改：`routedev/src/runtime/app-init.ts`
- 修改：`routedev/src/runtime/app-init-agent.ts`
- 修改：`routedev/src/runtime/app-init-tools.ts`
- 修改：`routedev/src/runtime/app-init-memory.ts`
- 修改：`routedev/src/runtime/app-init-router.ts`
- 修改：`routedev/src/runtime/goal-runner-scheduler.ts`
- 修改：`routedev/src/runtime/goal-runner-recovery.ts`

- [ ] **Step 1：定义 EnabledPacks 功能矩阵**

在 app-init.ts 增加显式"装配配方"步骤：

```typescript
interface EnabledPacks {
  acRouter: boolean;
  trustGradient: boolean;
  closedLoopRouting: boolean;
  multiAgent: boolean;
  // ...其他 Pack
}

function computeEnabledPacks(config: AppConfig): EnabledPacks {
  return {
    acRouter: config.packs?.acRouter?.enabled ?? false,
    trustGradient: true, // Phase 79 后 Core
    closedLoopRouting: config.router?.closedLoopRouting?.enabled ?? false,
    multiAgent: config.packs?.multiAgent?.enabled ?? true,
  };
}
```

- [ ] **Step 2：app-init.ts 计算 EnabledPacks 并注入子模块**

app-init.ts 在调用各 setup 函数前计算 EnabledPacks，作为参数传递。

- [ ] **Step 3：子模块移除散布的 Pack 门控**

将 30 处 `config.packs?.xxx?.enabled` 改为读取传入的 `enabledPacks.xxx`：
- app-init-agent.ts（19 处）
- app-init-tools.ts（3 处）
- app-init-memory.ts（4 处）
- app-init-router.ts（2 处）
- goal-runner-scheduler.ts（1 处）
- goal-runner-recovery.ts（1 处）

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm test
```

---

### Task 3：agentLoop 创建移至 agent 子系统（TD-18）

**文件：**
- 修改：`routedev/src/runtime/app-init-tools.ts:249-256`
- 修改：`routedev/src/runtime/app-init-agent.ts`

- [ ] **Step 1：梳理当前创建流程**

当前 app-init-tools.ts:249-256 在 tools 子系统创建 ReActAgentLoop 实例，违反 CODEMAP.md 层次结构（tools/ 层不应创建 agent/ 层对象）。

- [ ] **Step 2：tools 子系统返回 registry**

app-init-tools.ts 的 setupTools() 改为仅返回 `{ registry, toolExecutor, adapter }`，不创建 agentLoop。

- [ ] **Step 3：agent 子系统创建 agentLoop**

app-init-agent.ts 的 setupAgent() 接收 tools 子系统返回的 registry/toolExecutor/adapter，由 agent 子系统创建 ReActAgentLoop 实例。

- [ ] **Step 4：调整 app-init.ts 调用顺序**

app-init.ts 调用顺序改为：
1. setupTools() → 返回 tools
2. setupAgent(tools) → 创建 agentLoop

- [ ] **Step 5：运行测试**

```powershell
rtk err pnpm test
rtk err pnpm typecheck
```

---

### Task 4：验收

- [ ] **Step 1：循环依赖检测**

```powershell
npx madge --circular routedev/src/ --extensions ts
```

预期：无新增循环依赖，goal-runner 循环依赖消除。

- [ ] **Step 2：全量测试基线**

```powershell
rtk err pnpm test
```

- [ ] **Step 3：typecheck**

```powershell
rtk err pnpm typecheck
```

- [ ] **Step 4：更新技术债跟踪表**

将 TD-18 和 TD-19 移至 §3 历史区。

---

## 依赖关系

- Task 1 依赖 Phase-92 Task 1（goal-runner 拆分后更容易抽取共享类型）
- Task 2 依赖 Task 1（共享类型就绪后再收敛 Pack 门控）
- Task 3 无依赖，可与 Task 1/2 并行
- Phase-95 无依赖本 Phase

## 验收标准

- goal-runner 子模块无 ESM 循环依赖（madge 检测通过）
- Pack 门控集中在 EnabledPacks，30 处散布收敛为单点计算
- agentLoop 创建归属 agent 子系统，tools 子系统不创建 agent 层对象
- 全量测试零新增失败
- typecheck 通过
