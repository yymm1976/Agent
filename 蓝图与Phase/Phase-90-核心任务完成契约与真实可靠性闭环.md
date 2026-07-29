# Phase 90：核心任务完成契约与真实可靠性闭环

**目标：** 复用现有 CompletionGate，为 Chat 与 Goal 提供一致、诚实的完成状态；普通 Chat 仅在用户明确要求验证且本轮实际修改代码时运行验证。

**架构：** 不新增协调器、配置项、设置页或第二套验证系统。CompletionGate 从 `goalAdvanced` Pack 解耦为 Core 服务；在现有 GateResult 上增加最小完成状态映射，ChatBridge 追踪本轮文件写入并按用户请求复用 CompletionGate，GoalRunner 复用同一状态映射。

**Token 原则：** 普通问答不验证；只读任务不验证；代码修改但用户未要求验证时不验证；不调用 LLM 判断验证意图；使用本地关键词匹配；不增加 Reviewer 或 GoalVerifier 调用。

**涉及文件：**
- 修改：`routedev/src/agent/completion-gate.ts`
- 修改：`routedev/src/runtime/app-init-agent.ts`
- 修改：`routedev/src/runtime/goal-runner-recovery.ts`
- 修改：`routedev/src/runtime/goal-runner-scheduler.ts`
- 修改：`routedev/desktop/shared/ipc-types.ts`
- 修改：`routedev/desktop/main/bridges/chat-bridge.ts`
- 修改：`routedev/tests/agent/completion-gate.test.ts`
- 修改：`routedev/tests/runtime/app-init.test.ts`

---

## 明确不做

- 不新建 `TaskExecutionContract` 类、协调器、工厂或事件存储。
- 不增加用户配置项或设置 UI。
- 不自动验证所有 Chat 代码修改。
- 不新增跨语言命令发现系统。
- 不重写 GoalRunner、DualLoop、CheckpointManager 或 Recovery。
- 不使用 LLM 判断用户是否要求验证。
- 不增加自动 Git commit、自动回滚或新的 Token 消耗。

---

### Task 1：复用 GateResult 表达统一完成状态

**文件：**
- 修改：`routedev/src/agent/completion-gate.ts`
- 修改：`routedev/tests/agent/completion-gate.test.ts`

- [ ] **Step 1：新增最小 `CompletionStatus` 联合类型**

状态仅包含：

```typescript
export type CompletionStatus =
  | 'completed_verified'
  | 'completed_with_warnings'
  | 'completed_unverified'
  | 'verification_failed'
  | 'execution_failed'
  | 'cancelled'
  | 'blocked'
  | 'recovery_available';
```

- [ ] **Step 2：新增纯函数 `toCompletionStatus`**

规则：
- 执行失败 → `execution_failed`
- 未提供 GateResult → `completed_unverified`
- GateResult 失败 → `verification_failed`
- 有 skipped/warnings → `completed_with_warnings`
- 全部通过 → `completed_verified`

不得新建类或配置。

- [ ] **Step 3：增加一个表驱动单元测试**

覆盖上述五条实际使用规则。

- [ ] **Step 4：运行测试**

```powershell
pnpm test -- tests/agent/completion-gate.test.ts
```

预期：零失败。

---

### Task 2：将现有 CompletionGate 提升为 Core 服务

**文件：**
- 修改：`routedev/src/runtime/app-init-agent.ts`
- 修改：`routedev/tests/runtime/app-init.test.ts`

- [ ] **Step 1：移除 `packs.goalAdvanced.enabled` 对 CompletionGate 实例化的门控**

始终调用已有 `createCompletionGate`。保留 `optimization.safety.completionGate` 作为 Goal 是否执行验证的已有行为，不增加新开关。

- [ ] **Step 2：更新装配测试**

验证 `packs.goalAdvanced.enabled=false` 时 `deps.completionGate` 仍为 `CompletionGate`；高级 TaskOrchestrator 仍保持关闭。

- [ ] **Step 3：运行测试**

```powershell
pnpm test -- tests/runtime/app-init.test.ts
```

预期：零失败。

---

### Task 3：普通 Chat 按用户要求运行现有 CompletionGate

**文件：**
- 修改：`routedev/desktop/main/bridges/chat-bridge.ts`
- 修改：`routedev/desktop/shared/ipc-types.ts`

- [ ] **Step 1：在 ChatBridge 本轮执行中记录实际写入文件**

在 `tool_call_start` 事件中仅识别现有 `file_write` 与 `file_edit`，从 `args.path` 收集路径到 `Set<string>`。不扫描 Git，不读取全仓 diff。

- [ ] **Step 2：用本地关键词判断用户是否明确要求验证**

复用一个文件内私有函数，匹配明确动作词：
- 中文：验证、测试、检查构建、运行构建、类型检查、lint
- 英文：verify、test、typecheck、lint、build

不得调用 LLM，不增加配置。

- [ ] **Step 3：满足双条件时运行验证**

仅当：

```text
modifiedFiles.size > 0 && 用户明确要求验证 && Agent Loop 未报错
```

调用：

```typescript
deps.completionGate.verify({
  modifiedFiles: [...modifiedFiles],
  projectPath: options.cwd,
  planDescription: text,
});
```

验证发生在 Chat `done` 事件之前。失败不自动触发第二次 LLM 修复，避免额外 Token；只返回诚实状态与错误摘要。

- [ ] **Step 4：扩展现有 `ChatStreamPayload`**

给 `done` 增加可选 `completionStatus`，不新增事件类型，不修改设置页。未要求验证的代码修改返回 `completed_unverified`；普通问答也保持兼容，字段可选。

- [ ] **Step 5：检查失败语义**

- 验证通过 → `completed_verified`
- 有 skipped/warnings → `completed_with_warnings`
- 验证失败 → `verification_failed`
- 未要求验证 → `completed_unverified`
- Agent Loop 出错 → `execution_failed`

- [ ] **Step 6：运行桌面类型检查**

```powershell
pnpm typecheck:desktop
```

预期：零错误。

---

### Task 4：Goal 使用同一完成状态映射

**文件：**
- 修改：`routedev/src/runtime/goal-runner-recovery.ts`
- 修改：`routedev/src/runtime/goal-runner-scheduler.ts`

- [ ] **Step 1：让 `runCompletionGate` 返回现有 `GateResult | undefined`**

保留现有 plan 状态修改、系统消息、GoalAuditor 缓存和 DualLoop 行为，只把已经取得的 GateResult 返回给调用方，不重复执行验证。

- [ ] **Step 2：在 Goal 主流程保存最近一次 GateResult**

按现有 `auditMode` 调用顺序接收结果，不增加验证次数。

- [ ] **Step 3：Goal done 事件附带统一完成状态**

使用 Task 1 的纯函数映射：
- plan failed → `execution_failed` 或 `verification_failed`
- Gate 未运行 → `completed_unverified`
- Gate 通过/警告 → 对应统一状态

保留现有 `success` 字段兼容 UI。

- [ ] **Step 4：运行 Goal 相关测试**

```powershell
pnpm test -- tests/runtime/goal-integration.test.ts tests/runtime/goal-recovery.test.ts
```

预期：零失败。

---

### Task 5：全量验证

- [ ] **Step 1：类型检查**

```powershell
pnpm typecheck
pnpm typecheck:desktop
```

预期：零错误。

- [ ] **Step 2：运行核心测试**

```powershell
pnpm test -- tests/agent/completion-gate.test.ts tests/runtime/app-init.test.ts tests/runtime/goal-integration.test.ts tests/runtime/goal-recovery.test.ts
```

预期：零失败。

- [ ] **Step 3：构建**

```powershell
pnpm build
```

预期：构建成功。

---

## 边界条件

- 用户要求验证但没有修改文件：不运行 CompletionGate，避免无意义命令和等待。
- 用户修改文件但没要求验证：不运行 CompletionGate，返回 `completed_unverified`。
- 验证超时或 skipped：不得报告 `completed_verified`。
- CompletionGate 自身异常：Chat 返回 `completed_with_warnings`，不额外调用 LLM；Goal 保留现有 fail-open 行为但状态不得伪装为已验证。
- Agent Loop 已失败：不再运行验证。
- `/goal`：继续交给现有 GoalRunner，不走 Chat 的验证分支。
- 非代码普通对话：不增加任何额外工具调用或 Token 消耗。

## 完成标准

1. CompletionGate 不再依赖 `goalAdvanced` Pack 才能实例化。
2. 普通 Chat 仅在“明确要求验证 + 实际写入文件”时运行 CompletionGate。
3. Chat 验证路径不产生额外 LLM 调用。
4. Chat 与 Goal 共用同一个 `CompletionStatus` 映射。
5. 未验证、跳过验证和验证失败不会被展示为已验证完成。
6. 不增加配置项、设置 UI、新依赖或新编排器。
7. `pnpm typecheck`、`pnpm typecheck:desktop`、核心测试与 `pnpm build` 全部通过。
