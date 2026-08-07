# FAULT INJECTION MATRIX — PHASE M

> 每个 meaningful fault 验证：final Run state / cleanup / persistence / audit / next Run health / retry decision / no duplicate side effect。
> 覆盖状态：✅ 已有测试；🔲 未覆盖（记录）；N/A 不适用。

## Provider faults

| Fault | Covered? | Where |
|---|---|---|
| 401 | ✅（circuit breaker 逻辑） | real-deepseek-eval.mjs L0.1（真实未触发） |
| 429 | ✅（退避逻辑） | real-deepseek-eval.mjs L0.1 |
| 500/502/503 | ✅（2 retry 指数退避） | real-deepseek-eval.mjs L0.1 + openai.ts withRetry |
| timeout | ✅ | openai.ts withRetry + loop error 注入 |
| connection reset | ✅ | stream 中断测试（deepseek-v4-flash-ga.test.ts #11） |
| truncated SSE | 🔲（parser 层无显式半行测试） | 记录：P2 |
| malformed JSON | ✅ | deepseek-v4-flash-ga.test.ts #9 |
| duplicate finish | 🔲 | 记录：P2（parser 幂等未测） |
| missing usage | ✅（K2 契约：usage 尾块丢失 → usageIncomplete 语义？） | **未定契约——记录 P2**（当前 done 时无 usage 则 usage 为 0，无 usageIncomplete 标志） |
| empty choices | ✅ | usage-only 尾块测试（choices=[] 守卫） |

## Persistence faults

| Fault | Covered? | Where |
|---|---|---|
| write failure（audit append） | ✅ | audit-logger A5（chain head 不推进） |
| truncated JSON / corrupt JSON | ✅ | version-manager A3（corrupt 跳过）+ audit restore |
| partial migration | ✅（tmp+rename 原子写） | version-manager A3 crash-safe |
| EACCES | 🔲 | 记录：P3（fail-open 各处有 warn） |

## Tool faults

| Fault | Covered? | Where |
|---|---|---|
| non-zero exit | ✅ | sandbox/shell 测试 |
| timeout | ✅ | hooks 进程树终止（第 7 轮） |
| grandchild remains | ✅ | hooks adapter（detached kill(-pid)） |
| stdout/stderr overflow | ✅ | sandbox maxOutputBytes |
| tool result serialization failure | 🔲 | 记录：P3 |

## Runtime faults

| Fault | Covered? | Where |
|---|---|---|
| cancel | ✅ | R9 真实 + loop cancel 测试 |
| Run A fails → Run B | ✅ | B1 跨 Run 测试（effort/boost/workspace） |
| tool side effect → crash | 🔲 | **D1 记录：无 resume 机制 → at-most-once（无重放路径）** |
| compaction failure | 🔲 | 记录：P3（compactor 失败 fail-open） |
| verification failure | ✅ | completion-gate 语义测试 |

## 关键缺口（P2）

1. **K2 usage tail 丢失契约**：finish 已到但 usage 尾块未到（网络断开）——当前 done 时 usage=0（无 usageIncomplete 标志）。建议：done 事件加 usageIncomplete 标志（GA 前）。
2. **truncated SSE 半行**：parser 无显式半行测试（真实 API 未出现）。
3. **tool side effect crash 恢复**：无 resume 机制（single-flight 下 crash 即终止 run）——at-most-once 语义已隐含，需文档化（D2 结论）。
