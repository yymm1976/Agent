# ERROR_TAXONOMY — PHASE F

> 检查是否把不同错误退化成 string warning。每类定义 retryable/terminal/model-visible/user-visible/final-status/audit-severity。

| Error class | retryable? | terminal? | model-visible? | user-visible? | final status | audit severity | RouteDev 现状 |
|---|---|---|---|---|---|---|---|
| Provider transport error | 是（有限 retry） | 否 | 是（注入上下文） | 是 | execution_failed（重试耗尽） | high | withRetry + loop error 注入 ✓ |
| Provider protocol error (400) | 否（400 多为请求问题） | 是 | 是 | 是 | execution_failed | high | normalizeError ✓ |
| Rate limit (429) | 是（退避） | 否 | 是 | 是 | 重试后 | high | withRetry ✓ |
| Authentication (401/403) | 否 | 是 | 是 | 是 | execution_failed | critical | 无专门分类（L0.1 要求立即停止） |
| Tool execution error | 否（工具级） | 否 | 是（tool_result isError） | 是 | 继续 run | medium | structured isError ✓ |
| Tool rejected (policy) | 否 | 否 | 是 | 是 | 继续 run | high | security checker ✓ |
| User denial | 否 | 否 | 是 | 是 | 继续 run | medium | approval_resolved ✓ |
| Verification failure | 是（重试 gateRetry） | 否 | 是 | 是 | verification_failed | medium | CompletionGate ✓ |
| Run cancellation | 否 | 是 | 否 | 是 | cancelled | info | EngineEventV1 ✓ |
| Timeout | 部分 | 部分 | 是 | 是 | 按上下文 | medium | hooks/gate/shell ✓ |
| Internal invariant | 否 | 是 | 否 | 是 | execution_failed | critical | 散落（缺统一） |
| Persistence error | 是（重试） | 部分 | 否 | 是 | 按上下文 | high | fail-open 多处 ✓ |

## 缺口

1. **401/403 无专门分类**：L0.1 要求立即停止全部 real eval——需要 AuthError 类型供 circuit breaker 识别
2. **Internal invariant 无统一入口**：各类 invariant violation 直接 throw
3. **tool error 与 conversation fatal 的区分**：已通过 tool_result isError 结构化区分 ✓（B-04 后）

## 判定

PARTIALLY ADDRESSED——核心区分（tool vs run、retryable vs terminal）已结构化；401 分类与 invariant 统一入口为 P2 项（GA 前）。
