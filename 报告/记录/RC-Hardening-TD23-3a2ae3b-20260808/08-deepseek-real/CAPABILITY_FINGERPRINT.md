# TD-23 CAPABILITY_FINGERPRINT — DeepSeek V4 Flash Official

- **时间**：2026-08-08（UTC 2026-08-07T18:xx）
- **Provider**：DeepSeek Official（https://api.deepseek.com/v1）
- **Model requested/returned**：deepseek-v4-flash / deepseek-v4-flash
- **Gateway**：DeepSeek Official

## 观察到的能力（真实 API 验证）

| Capability | Observed | Evidence |
|---|---|---|
| thinking 字段 | reasoning_content 流式到达（R3/R4/R8 多次） | R3-thinking.jsonl |
| reasoning_content present | 是（thinking 模式默认开启） | R3 PASS |
| tool calls shape | 标准 OpenAI tool_calls（id/name/arguments） | R4 PASS（两轮 replay） |
| finish_reason values | stop / tool_use | R2/R4 |
| stream usage shape | **独立 usage 尾块（choices=0）在 done 前到达** | R6-usage-tail.jsonl（usage → done 顺序） |
| cache fields | prompt_cache_hit_tokens/miss_tokens 字段存在（本次 hit=0） | R7 INCONCLUSIVE |
| max context observed | 配置 131072（官方 1M——配置值待同步） | eval-config |
| tool_choice | 未发送（V4 thinking 模式拒绝——脚本未传，PASS） | R4 |
| assistant content 非 null | 空字符串（非 null）✓（R4 round2 用空文本兜底） | R4 PASS |

## 真实帧序（R6 捕获）

```text
reasoning_delta × N
text_delta × N
usage { inputTokens:89, outputTokens:21, cacheHitTokens:0, cacheMissTokens:89 }   ← choices=[] 尾块
done { finishReason:'stop' }
```

与 RouteDev parser 的 mock 假设**一致**（第 8 轮修复的尾块读取逻辑被真实协议确认）。

## 取消行为（R9）

- stream 开始 300ms 后 abort：parser settle、无后续请求
- 取消后下一次 complete 正常工作（PASS）

## 请求预算

- 已用：12 / 60（R1-R9）
- retry：0 / 429：0 / 5xx：0
