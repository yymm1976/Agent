# Phase 91：测试基建补全

**目标：** 补齐 goal-runner 子模块单元测试与桌面聊天链路入口级集成测试，消除 Critical/High 级测试覆盖盲区。

**架构：** 不新建测试框架或抽象层。goal-runner 子模块沿用现有 vitest 单元测试模式；ChatBridge 集成测试复用 `desktop/main/__tests__/chat-bridge.integration.test.ts` 已有的 setupBridge 工厂，扩展覆盖 requestId 隔离与 AbortController 生命周期。

**Token 原则：** 测试代码不引入新依赖；mock 注入使用工厂函数选项（TD-21 模式）；不新增测试配置文件。

**涉及文件：**
- 新建：`routedev/tests/runtime/goal-runner-core.test.ts`
- 新建：`routedev/tests/runtime/goal-runner-confirm.test.ts`
- 新建：`routedev/tests/runtime/goal-runner-scheduler.test.ts`
- 新建：`routedev/tests/runtime/goal-runner-recovery.test.ts`
- 修改：`routedev/desktop/main/__tests__/chat-bridge.integration.test.ts`

**关联技术债：** TD-16（Critical）/ TD-01（High）

---

## 明确不做

- 不新建测试框架或自定义 mock 库
- 不重写 goal-runner 子模块以适配测试（测试适配代码，不反向改生产代码）
- 不增加端到端测试（仅单元 + 集成层）
- 不引入 Playwright / Spectron 等 Electron 测试框架（用进程内 mock IPC）
- 不追求 100% 覆盖率，聚焦边界条件与回归风险点

---

### Task 1：goal-runner-core.ts 单元测试（DAG 编排）

**文件：**
- 新建：`routedev/tests/runtime/goal-runner-core.test.ts`

- [ ] **Step 1：搭建测试 fixture 工厂**

创建 `makeGoalRunnerCtx()` 工厂，返回最小可运行的 GoalRunnerCtx mock：
- `deps: Partial<AppDependencies>` 注入 mock toolExecutor / logger / persistence
- `goal: Goal` 含 3 步骤 DAG（线性 + 分支 + 汇聚）
- `state: GoalState` 初始状态

不新建测试基类，工厂函数放测试文件顶部。

- [ ] **Step 2：覆盖正常流程**

测试用例：
- 单步骤线性执行 → 完成
- 多步骤 DAG 拓扑排序正确
- 分支步骤并行执行后汇聚
- 步骤产出正确传递给下游步骤

- [ ] **Step 3：覆盖异常恢复边界**

测试用例：
- 步骤抛异常 → 标记 failed，不崩溃
- 步骤超时 → 触发降级策略
- DAG 环检测 → 拒绝执行并报错
- 重复步骤 ID → 拒绝加载

- [ ] **Step 4：运行测试**

```powershell
pnpm test -- tests/runtime/goal-runner-core.test.ts --run
```

预期：零失败。

---

### Task 2：goal-runner-confirm.ts 单元测试（步骤确认）

**文件：**
- 新建：`routedev/tests/runtime/goal-runner-confirm.test.ts`

- [ ] **Step 1：覆盖确认流程**

测试用例：
- confirm 模式下步骤暂停等待用户确认
- auto 模式下步骤自动放行
- semi 模式按 autoApprovePatterns 判断
- 用户拒绝确认 → 步骤标记 skipped

- [ ] **Step 2：覆盖超时降级**

测试用例：
- 确认超时（60s）→ 按 autonomyMode fallback
- 超时后状态正确标记，不卡死后续步骤
- 多步骤同时等待确认 → 各自独立超时

- [ ] **Step 3：运行测试**

```powershell
pnpm test -- tests/runtime/goal-runner-confirm.test.ts --run
```

---

### Task 3：goal-runner-scheduler.ts 单元测试（调度）

**文件：**
- 新建：`routedev/tests/runtime/goal-runner-scheduler.test.ts`

- [ ] **Step 3：覆盖调度逻辑**

测试用例：
- 拓扑序调度：上游未完成时下游不启动
- 并行度控制：maxParallel 上限生效
- 步骤重试：失败步骤按 retryPolicy 重试
- 调度抢占：高优先级步骤插队

- [ ] **Step 2：覆盖状态持久化**

测试用例：
- 调度状态 snapshot 正确保存
- resume 后从 snapshot 恢复调度
- snapshot 与 GoalState 一致性

- [ ] **Step 3：运行测试**

```powershell
pnpm test -- tests/runtime/goal-runner-scheduler.test.ts --run
```

---

### Task 4：goal-runner-recovery.ts 单元测试（恢复 + 超时降级）

**文件：**
- 新建：`routedev/tests/runtime/goal-runner-recovery.test.ts`

- [ ] **Step 1：覆盖恢复路径**

测试用例：
- 步骤失败后触发恢复策略（retry / skip / abort）
- 恢复策略由 config 驱动，不硬编码
- 恢复后 GoalState 正确更新
- 多次恢复不累积副作用

- [ ] **Step 2：覆盖超时降级**

测试用例：
- 单步骤超时 → 降级为 skipped 或 failed（按 config）
- 整体 Goal 超时 → 标记 timeout 并停止调度
- 超时后清理资源（AbortController.abort）

- [ ] **Step 3：运行测试**

```powershell
pnpm test -- tests/runtime/goal-runner-recovery.test.ts --run
```

---

### Task 5：ChatBridge 集成测试基建扩展

**文件：**
- 修改：`routedev/desktop/main/__tests__/chat-bridge.integration.test.ts`

- [ ] **Step 1：扩展 setupBridge 支持 multi-request 场景**

现有 setupBridge 单 requestId，扩展为支持并发 requestId 隔离测试：
- 新增 `setupMultiRequestBridge()` 工厂，预置 2 个 requestId 的 mock
- 复用现有 mockAgentLoop，不新建 mock 体系

- [ ] **Step 2：requestId 隔离回归测试（G-004）**

测试用例：
- 并发 sendChat（不同 requestId）→ AbortController 互不影响
- stopGeneration(requestId-A) 仅中止 A，B 继续
- requestId 复用检测 → 旧 requestId 被新请求覆盖时自动 abort

- [ ] **Step 3：AbortController 生命周期测试**

测试用例：
- sendChat 启动 → AbortController 创建并注册
- 请求完成 → AbortController 从 Map 清理
- stopGeneration → AbortController.abort() 被调用
- 引擎热重载 → 所有 AbortController 被 abort 并清理

- [ ] **Step 4：跨进程通信回归测试**

测试用例：
- IPC 消息序列化不丢失字段
- 大消息（>1MB）分片传输
- 渲染层崩溃后 bridge 状态清理

- [ ] **Step 5：运行测试**

```powershell
pnpm test -- desktop/main/__tests__/chat-bridge.integration.test.ts --run
```

预期：现有 47 个测试 + 新增测试全部通过。

---

### Task 6：验收

- [ ] **Step 1：全量测试基线**

```powershell
rtk err pnpm test
```

预期：零新增失败。

- [ ] **Step 2：typecheck**

```powershell
rtk err pnpm typecheck
```

- [ ] **Step 3：更新技术债跟踪表**

将 TD-16 和 TD-01 从 §1 活跃清单移至 §3 历史区。

---

## 依赖关系

- 无前置依赖，可立即开始
- Phase-92 Task 1（goal-runner.ts 拆分）依赖本 Phase 完成（拆分后测试更容易维护）

## 验收标准

- goal-runner 4 个子模块各有独立单元测试文件，覆盖正常 + 异常 + 边界
- ChatBridge 集成测试覆盖 requestId 隔离 / AbortController 生命周期 / 跨进程通信
- 全量测试零新增失败
- typecheck 通过
