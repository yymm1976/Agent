# SOURCE_OF_TRUTH_MATRIX — TD-21 Event Model Readiness

> PHASE C。分析 RouteDev 各事实的权威 owner / 持久化 / 可重放性 / 重复表达。

| Fact | Authoritative owner | Persisted? | Append-only? | Replayable? | Duplicated state? | Projection? | Can drift? |
|---|---|---|---|---|---|---|---|
| user message | chat-bridge conversationHistory | 是（JSONL 持久化） | 是 | 部分（仅最终文本，工具轨迹丢失） | 否 | trace/audit 部分重复 | 是（slice(-20) 截断） |
| assistant response | chat-bridge conversationHistory | 是 | 是 | 部分 | 否 | trace | 是（截断） |
| reasoning | loop messages（run 内）+ conversationHistory（无，A3 已移除拼接） | 否（run 内） | — | 否 | trace engine 事件含？ | — | 是 |
| tool requested | loop messages | run 内 | — | 否 | trace tool_call span | — | 是 |
| tool started/completed/failed | trace（ToolSpan）+ audit（tool_call_start/complete） | 是 | 是 | 是（trace replay） | 是（trace+audit 双写） | 是 | 可能（双写一致性无校验） |
| user approval/rejection | audit（approval.*） | 是 | 是 | 是 | 否 | — | 低 |
| provider retry | 未记录（openai.ts withRetry 无事件） | 否 | — | 否 | 否 | — | **缺口**（retry 不可观测） |
| run started/completed | EngineEventV1（agent_start/agent_end）→ trace | 是（trace） | 是 | 是 | 部分（desktop 事件） | — | 低 |
| run interrupted | EngineEventV1（agent_end reason=cancelled） | 是 | 是 | 是 | — | — | 低 |
| usage | TokenTracker + trace | 是 | 是 | 是 | 是（tracker+usage 事件） | — | 低 |
| context compaction | EngineEventV1（context_compacted） | 是 | 是 | 是 | — | — | 低 |
| checkpoint/rollback | checkpoint-manager metadata | 是 | 是 | 是 | — | — | 低 |
| verification | audit（completion_gate）+ gate result | 是 | 是 | 是 | — | — | 低 |

## 关键缺口

1. **provider retry 不可观测**：withRetry 无事件/审计——429/5xx 重试次数无法从 trace 重建（TD-23 需要 retry count）
2. **tool 状态双写无校验**：trace span 与 audit 记录同一工具调用，无交叉校验
3. **conversation 仅最终文本**：工具轨迹/reasoning 不持久化（TD-21 核心）
4. **run 内状态无事件化**：compaction 有事件，但 tool 执行细节（参数）仅 trace

## TD-21 判定

PARTIALLY ADDRESSED——EngineEventV1 + trace 已是 append-only 事件基座；缺：retry 事件、conversation 完整轨迹、跨系统一致性校验。RC 非 blocker（单机 single-flight 下状态一致），GA 前建议落地 Phase 1（RunEvent/ConversationEvent typed envelope）。
