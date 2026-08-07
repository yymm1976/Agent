# ROUTEDEV_GAP_ANALYSIS — PHASE N

> 与成熟 Harness 代码级对比（只列 failure mode，不因"他有所以我要"）。

| # | Capability | RouteDev current | Reference behavior | Failure mode solved | Verdict | Should change now? |
|---|---|---|---|---|---|---|
| 1 | Run ownership | NativeAgentKernel 互斥 + scheduler 全局 FIFO（single-flight） | OpenHands conversation lease（谁拥有 execution 权） | 过期 executor 写他人 conversation | BETTER（single-flight 更简单，无竞争） | 否（TD-22 GA 前） |
| 2 | Generation fencing | 无显式 generation token；single-flight 下 stale writer 不可能（互斥） | OpenHands generation fencing（旧 executor 失去 ownership 后 guarded write） | 取消后慢回调写 B state | PARITY（互斥天然防）——但取消后慢 async 回调仍可写共享 ctx | 是（P2：E2 stale executor 测试） |
| 3 | Message idempotency | 无 message ID 幂等（single-flight 无重放路径） | OpenCode durable admission（相同 message ID retry 幂等） | crash 后重放 | INTENTIONALLY DIFFERENT（无 resume 机制 → at-most-once） | 否（文档化 D2） |
| 4 | Side-effect replay prevention | 无 resume → 无重放路径（隐含 at-most-once） | OpenCode 不自动重执行 running tool | crash 后重复副作用 | PARITY（无重放即防） | 否（文档化） |
| 5 | Cancellation settlement | AbortController 传播链完整（kernel→LLM→tool→process tree）；CompletionGate 未接 signal | Cline 显式 cleanup 生命周期 | 取消后资源残留 | WEAKER（gate 命令不中断） | 是（P2：gate signal） |
| 6 | Audit chain | per-day 链 + canonical hash 全覆盖 + 事务性 head | （无直接参考——RouteDev 审计链更强） | 篡改检测 | BETTER | 否 |
| 7 | Executable identity | normalizeExecutableIdentity 唯一权威 + structured policy | Codex exec policy（approval 分类） | 参数冒充/路径拼写绕过 | PARITY | 否（GA 前加 approval 分类） |
| 8 | Repo context | repo_map（DB PageRank）+ code_search + tool_search | Aider repo-map（tree-sitter defs/refs + 图重要性） | 关键 symbol 被挤出 context | WEAKER（无 tree-sitter 符号图） | 否（P2：I2 轻量 symbol score） |
| 9 | Compaction provenance | 分阶段压缩 + 恢复清单 + context_compacted 事件 | OpenCode compaction（锚定摘要） | 压缩丢失关键约束 | PARITY | 否 |
| 10 | Error taxonomy | 结构化 tool error vs run error（部分）；401 无专门分类 | OpenHands typed event（error 分类） | 错误退化 string warning | WEAKER（401/invariant 无专门类型） | 是（P2：AuthError） |
| 11 | Prompt injection | ToolResultSanitizer 注入检测 + TRUST_MODEL | Aider architect→editor trust boundary | untrusted 内容提升权限 | PARITY | 否 |
| 12 | Event source of truth | EngineEventV1 + trace（append-only）但 conversation 无完整轨迹 | OpenHands append-only event log | 多系统重复表达 | WEAKER（TD-21） | 否（GA 前 Phase 1） |

## 结论

- **BETTER/ PARITY**：Run ownership（single-flight 简化为安全）、审计链、executable identity、取消主干、注入防护
- **WEAKER（GA 前建议）**：CompletionGate signal、401 错误分类、TD-21 event log Phase 1、repo context 符号图（P2）
- **RC 判定**：以上 WEAKER 项均非 RC blocker（single-flight 下无并发竞争；gate 有 timeout 兜底；401 真实 eval 中未触发）
