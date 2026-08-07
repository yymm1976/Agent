# CANCELLATION_CHAIN — PHASE E

> 追踪 cancellation 从 UI/API 到资源的传播链。Cline 参考：abort 是完整 resource settlement，不是信号。

```
UI / API cancellation
  ↓ kernel.abort(sessionId) → AbortController.abort()（kernel-native）
  ↓ ReActAgentLoop.run 的 params.signal
  ↓ LLM 调用：openai.ts withRetry/stream 透传 signal（SDK requestOptions.signal → HTTP abort）
  ↓ SSE parser：流中断 → normalizeError → loop error 处理
  ↓ ReAct 迭代：signal.aborted 检查（loop 各迭代点）
  ↓ Tool executor：callOptions.signal → 工具（shell_exec child.kill、file 工具等）
  ↓ child process：signal 监听 kill（hooks/adapter 进程树终止 8 轮已做）
  ↓ CompletionGate：runCommandAsync signal 透传？
  ↓ persistence / final state：loop finally（agent_end reason=cancelled）
```

## 现状核查

| 环节 | 传播 | 证据 |
|---|---|---|
| kernel → loop signal | ✓ | kernel-native runReAct/run 创建 controller，params.signal |
| loop → LLM | ✓ | callLLMStream options.signal |
| openai adapter → HTTP | ✓ | SDK requestOptions.signal（V2-021） |
| loop → tool | ✓ | callOptions.signal（并行/串行分支） |
| tool → child process | ✓ | shell-exec signal kill（8 轮 hooks 修复同类） |
| hooks → process tree | ✓ | detached kill(-pid) + taskkill /T（第 7 轮） |
| CompletionGate → runCommandAsync | ⚠️ **需核查**：runCommandAsync spawn 无 signal 参数——gate 执行中 abort 是否传播？ |
| 中间件 hooks（mwRunner） | ⚠️ 需核查 |

## 结论

主干传播完整（kernel→LLM→tool→process）；**CompletionGate 命令执行未接 signal**（P2：gate 运行中取消只能等命令自然结束）——记录为 P2 项，RC 非 blocker（gate 有 timeout 兜底）。
