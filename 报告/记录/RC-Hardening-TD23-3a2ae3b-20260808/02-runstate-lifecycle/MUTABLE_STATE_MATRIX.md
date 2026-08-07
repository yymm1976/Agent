# MUTABLE_STATE_MATRIX — Agent Loop / Scheduler / ChatBridge

> PHASE B（TD-22 系统审查）。列出所有 meaningful mutable state 与跨 Run 泄漏风险。

## ReActAgentLoop（src/agent/loop.ts）实例字段

| Field | Owner | Lifecycle | Init at | Mutated at | Cleanup success | Cleanup error | Cleanup cancel | Persisted? | Leak to next Run? | Concurrency owner |
|---|---|---|---|---|---|---|---|---|---|---|
| currentContext | loop | run | run() | run() | finally → null | finally → null | finally → null | 否 | 否（finally 清） | kernel 互斥 |
| currentConfirmTool | loop | run | run() | run() | finally → null | finally → null | finally → null | 否 | 否 | kernel 互斥 |
| currentAutonomyMode | loop | run | run() | run() | **未清理** | 未清理 | 未清理 | 否 | **是（残留到下一 run 直到被覆盖）** | kernel 互斥 |
| currentTurnId | loop | run | beginEngineTurn | finishEngineTurn | finally → null | finally → null | finally → null | 否 | 否 | kernel 互斥 |
| currentMessageId | loop | run | beginEngineTurn | finishEngineTurn | finally → null | finally → null | finally → null | 否 | 否 | kernel 互斥 |
| engineSeq | loop | run | run() | emitEngineEvent | finally → null | finally → null | finally → null | 否 | 否 | kernel 互斥 |
| engineSink | loop | run | setEngineEventSink | — | finally → null | finally → null | finally → null | 否 | 否 | kernel |
| engineEndReason | loop | run | run() | 各退出路径 | finally 发射后保留 | 保留 | 保留 | 否 | 否（下一 run 覆盖） | kernel 互斥 |
| engineTurnEnded | loop | run | run() | begin/finishEngineTurn | finally → false | finally → false | finally → false | 否 | 否 | kernel 互斥 |
| engineTurnRequestId | loop | run | run() | — | finally → null | finally → null | finally → null | 否 | 否 | kernel 互斥 |
| currentCapability | loop | run | run() | — | finally → null | finally → null | finally → null | 否 | 否 | kernel 互斥 |
| currentWorkspace | loop | run | run() | — | finally → undefined | finally → undefined | finally → undefined | 否 | 否 | kernel 互斥 |
| currentReasoningEffort | loop | run | run() | — | **未清理** | 未清理 | 未清理 | 否 | **是（残留到下一 run 直到被覆盖）** | kernel 互斥 |
| currentMaxTokens | loop | run | run() | — | **未清理**（默认 4096，下一 run 覆盖） | 未清理 | 未清理 | 否 | 低（默认值覆盖） | kernel 互斥 |
| currentToolSurface | loop | run | run() | — | finally → undefined | finally → undefined | finally → undefined | 否 | 否 | kernel 互斥 |
| compactor | loop | 注入 | setCompactor | — | — | — | — | 否 | 否（构造级） | kernel 互斥 |
| virtualFS | loop | 构造 | 构造 | — | — | — | — | 否 | 是（跨 run 共享 VFS——VFS 是 run 级还是会话级需确认） | kernel 互斥 |
| planState | loop | 注入 | — | — | — | — | — | 否 | 待确认 | kernel 互斥 |

## 跨 Run 泄漏风险汇总

1. **currentAutonomyMode 未在 finally 清理**（run() 开头覆盖，泄漏窗口 = run 间隙）——低风险但违反"run 结束后无残留"不变量
2. **currentReasoningEffort 未清理**——同上（下一 run 无 params.reasoningEffort 时残留上一 run 的值！**这是真实泄漏**——Run A 传 effort=max，Run B 不传 → 仍用 max）
3. **virtualFS 跨 run 共享**——VFS 内容是否 run 级需确认

## ChatBridge（desktop/main/bridges/chat-bridge.ts）

| Field | Owner | Leak risk |
|---|---|---|
| ctx.conversationHistory | engine ctx | 跨 run 共享（会话级，预期） |
| pendingWrites/pendingTodoActions | run 局部 | run 内声明，无泄漏 |
| ctx.getAbortController(requestId) | engine ctx | 按 requestId 清理（G-004） |
| ctx.pendingConfirmations | engine ctx | 按 requestId 清理 |

## Scheduler（run-scheduler.ts）

| Field | Owner | 说明 |
|---|---|---|
| queue/active/states | scheduler | 全局单队列；workspaceId 仅元数据；active 单条——**single-flight contract** |

## 结论（B2 问题回答）

- **RouteDev 当前谁拥有 Run？** NativeAgentKernel（runReAct/run 显式互斥 runningSessionId）+ scheduler 全局 FIFO——single-flight，无并行。
- **过期 Run 是否可能在 cancellation 后继续写？** kernel abort 只 signal；loop 内 async 回调（工具 child process、hook）依赖 signal 传播——PHASE E 验证。
- **未来并发 worktree 是否 Promise.all 改同一文件？** 当前 single-flight 不成立；TD-22 记录。
- **scheduler workspaceId = ownership？** 否——仅审计元数据（已文档化）。
