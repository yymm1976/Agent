# FINAL_RC_REVIEW — Overnight RC Hardening Mission

- **时间**：2026-08-08
- **Baseline**：`3a2ae3b` → 最终 HEAD：`6926301`（含全部提交）
- **Committs**：`59d9eeb`（A1/A2/A4 security）→ `0bfbbe5`（B1/H2 + 文档）→ `6926301`（TD-23 eval + 证据）

## P0 findings

无（本轮未发现未修复 P0；前几轮 P0 已全部关闭）。

## P1 findings（全部关闭）

| ID | Area | Summary | Fix |
|---|---|---|---|
| F-001 | ordered-revision | id 变长 base36 字符串序错 | fixed-width 10+6 + crypto random |
| F-002 | executable-identity | parseCommand 反斜杠损坏 + .com 缺失 | normalizeExecutableIdentity 唯一权威 |
| F-003 | destructive-policy | rm target '/etc/..' 折叠为空串漏拦 | 段折叠归一 |
| F-004 | profile-version | legacy timestamp 与 revision 跨数值域比较 | ensureRevisions 正式迁移 |
| F-005 | audit-chain | 链 head 内存态，logger 重建断链 | restoreChainHead（per-day 语义） |
| F-006 | runstate | effort/autonomy 跨 Run 残留 | finally 清理 |

## P2 findings（记录，非 RC blocker）

1. Audit chain canonical hash 升级后**历史链验证失败**（migration 风险，GA 前需迁移或文档化）
2. CompletionGate 命令执行未接 abort signal（有 timeout 兜底）
3. provider retry 不可观测（TD-21 Phase 1 应加 retry 事件）
4. K2：finish 后 usage 尾块丢失契约未定（建议 done.usageIncomplete 标志）
5. 401 错误无专门类型（L0.1 已实现停止逻辑，类型化 GA 前）
6. repo context 无 tree-sitter 符号图（P2 轻量 symbol score）

## False positives

- R4 真实 API 两次 400：均为 eval 脚本消息格式错误（非 RouteDev 协议 bug），修正后 PASS

## System invariants established

1. **executable identity 唯一权威**：allow/deny/dangerous 只认 canonicalName（.exe/.cmd/.bat/.com 归一）
2. **危险命令不依赖路径拼写**：/sbin/shutdown 与 shutdown 等价
3. **rm 目标归一**：/、/./、//、/x/..、$HOME 折叠后指向根即拒绝
4. **OrderedRevision 唯一 comparator**：wallTimeMs → sequence → id（fixed-width 字符串序一致）
5. **profile revision 单调**：list/rollback/retention 只用 revision（migration 后）
6. **audit 链 per-day 语义**：文件即链边界；重建恢复 head；append 成功才推进
7. **run 结束后无残留**：loop finally 清理全部 run 级状态（workspace/capability/toolSurface/effort/autonomy/boost）
8. **TD-23 真实协议**：usage 尾块在 done 前；reasoning_content 回传必需；取消后下次请求正常

## RunState ownership findings

- single-flight contract 确认（kernel 互斥 + scheduler FIFO）；B1 修复 effort/autonomy 残留
- workspaceId 仅元数据（已文档化，TD-22 保持 OPEN）

## Retry / idempotency findings

- LLM 层 withRetry（有限）；tool 层无重试（execute 一次）→ **at-most-once 语义**（无 resume 机制即无重放路径，D1/D2 文档化）
- provider retry 不可观测（P2）

## Cancellation findings

- 主干传播完整（kernel→LLM→tool→process tree，R9 真实验证）
- CompletionGate 未接 signal（P2，timeout 兜底）

## Security findings

- A1/A2 结构化策略（6 个 P1 安全修复）
- H2 注入检测验证（ToolResultSanitizer 标记不提升权限）
- TRUST_MODEL：无角色提升路径

## Prompt-injection / trust findings

- 12 类输入源信任级别表；repo/tool/web/MCP/sub-agent 输出均为 untrusted data
- adversarial 测试通过（注入被检测标记）

## Context / compaction findings

- 压缩恢复清单 + 事件已有（前几轮）；SOURCE_OF_TRUTH 记录 conversation 无完整轨迹（TD-21）

## Provider streaming findings

- K1：真实帧序确认（reasoning→text→usage 尾块→done）；usage-only 尾块 choices=[] 守卫
- K2：usage 尾块丢失契约未定（P2）

## TD-23 R1–R10（真实 DeepSeek V4 Flash Official）

| R | Result | 证据 |
|---|---|---|
| R1 基础 | PASS | R1-basic.jsonl |
| R2 流式 | PASS | R2-stream.jsonl |
| R3 思考 | PASS | R3-thinking.jsonl |
| R4 Thinking+Tool replay | PASS | R4-round1/2.jsonl（reasoning 回传 400 防御实测） |
| R5 多工具 | SKIP | 有限次数不强制 |
| R6 Usage tail | PASS | R6-usage-tail.jsonl（真实帧序） |
| R7 缓存 | PASS | R7-cache.jsonl（hit=512/514） |
| R8 tool_search 全 loop | PASS | R8-toolsearch.jsonl（真实 harness） |
| R9 取消 | PASS | R9-cancel.jsonl |
| R10 压缩 | SKIP | 预算优先（R4/R8 长上下文覆盖） |

- **Real request count**：11 / 60（预算内）
- **Retry**：0 / **429**：0 / **5xx**：0
- **Cache observations**：prompt_cache_hit_tokens/miss_tokens 字段存在；第二次相同前缀命中 512/514
- **Observed reasoning schema**：streaming reasoning_content（thinking 模式默认开启）
- **Observed usage-tail ordering**：usage（choices=[] 尾块）→ done
- **All secrets redacted**：是（trace 无 Authorization、无 content 全文）

## Mature Harness comparison

ROUTEDEV_GAP_ANALYSIS.md：12 项对比——ownership（BETTER single-flight）、audit chain（BETTER）、executable identity（PARITY）、cancellation（WEAKER gate signal）、event log（WEAKER TD-21）。

## TD-21 / TD-22 / TD-24 status

| TD | Status | RC blocker? | GA blocker? | Why |
|---|---|---|---|---|
| TD-21 Event Log | PARTIALLY ADDRESSED | 否 | 是（GA 前 Phase 1） | EngineEventV1+trace 已 append-only；conversation 完整轨迹缺失 |
| TD-22 Stateless RunState | OPEN | 否 | 是（若承诺并行） | single-flight 明确；B1 残留已修 |
| TD-24 Worktree Completion Gate | OPEN | 否 | 否（RC 不承诺 worktree production） | 若宣称 worktree production-ready 则 GA blocker |

## Fault injection matrix

09-fault-injection/MATRIX.md：provider/persistence/tool/runtime 四类；✅ 覆盖大部分，P2 缺口记录（truncated SSE、duplicate finish、usage 丢失契约）。

## Full CI Run

**已确认**：最终提交 `e8995c3` 的 GitHub Actions 6 Job 全部 success（Core typecheck/tests、Desktop Windows/Ubuntu/macOS typecheck+tests+build、Android test+lint+assembleDebug、Dependency/Security audit）。Run ID 31230858090。

## Remaining RC blockers

**无**（P0=0；P1 全部关闭；确认且未解决的 P1 runtime/security/data-integrity/protocol = 0）。

## Remaining GA blockers

1. TD-21 Phase 1（conversation 完整轨迹 + retry 事件）
2. TD-22（若承诺并行 worktree）
3. Audit chain migration（历史链 canonical hash 重签/文档化）
4. CompletionGate abort signal
5. K2 usageIncomplete 契约
6. 401 错误类型化

## Post-GA debt

- repo context 符号图（tree-sitter）、Eval Level 2/3、truncated SSE/duplicate finish 测试、多 logger 并发写链分叉（P3）

---

# FINAL VERDICT

## **RC CANDIDATE**

理由：
- P0 = 0；P1 runtime/security/data-integrity/protocol 全部关闭（F-001~F-006 有测试证据）
- TD-23 mandatory 门（R1/R2/R3/R4/R6/R8/R9）真实 API 全部 PASS
- Offline Gate：4057 测试通过（仅 doctor 既有 Windows 环境失败）/ 双端 tsc 0 / audit 0
- 系统不变量均有测试或真实证据

不授予 RC1：GA blocker 清单（TD-21/TD-22/audit migration/gate signal/K2/401 类型）未完成；RC1 判定需完整 CI 全绿 + GA blocker 收敛。
