# RC Hardening Mission — Baseline

- **时间**：2026-08-08
- **Commit**：`3a2ae3b`（feat(infra): 第九轮复审——OrderedRevision 原语与 ExecutionPolicy V2）
- **工作树**：干净（仅 .reasonix/ 未跟踪，工具状态，不提交）
- **Node**：v22.19.0 / **pnpm**：11.7.0 / **platform**：win32
- **已知 debt**：TD-21（Authoritative Event Log）、TD-22（RunState 无状态化）、TD-23（真实 DeepSeek 基线——本任务执行）、TD-24（Worktree Completion Gate parity）

## 当前关键架构组件（第九轮后）

| 组件 | 状态 |
|---|---|
| DeepSeek V4 thinking/tool-call 协议 | reasoning_content 回传 + usage 尾块读取 + provider 参数隔离 |
| ExecutionPolicy V2 | 结构化 executable identity（validateExecution）+ 危险策略 basename 归一 |
| OrderedRevision | 唯一排序原语（wallTimeMs/sequence/id） |
| Profile VersionManager | 单调 revision |
| AuditEnvelope V2 | canonical hash 全覆盖 + 事务性 chain head |
| Tool Surface | resolver 单一真相源 + boost run 边界清理 |
| Scheduler | workspaceId 元数据（仍全局 FIFO，loop 单例） |
| CI | 6 Job 全绿（3a2ae3b 触发的最新 Run） |

## 本次 scope

按任务文档 27 节执行：
- PHASE A（A1-A5 RC blockers）
- PHASE B（RunState/TD-22 审查 + 跨 Run 泄漏）
- PHASE C（TD-21 event model 就绪度）
- PHASE D（retry idempotency）
- PHASE E（cancellation propagation）
- PHASE F（error taxonomy）
- PHASE G（filesystem/security）
- PHASE H（prompt injection/trust）
- PHASE I（repo context）
- PHASE J（context budget/compaction）
- PHASE K（provider streaming FSM）
- PHASE L（TD-23 真实 DeepSeek V4 Flash）
- PHASE M（fault injection matrix）
- PHASE N（mature harness 对比）
- PHASE O（自我复审）
- 最终 Gate + Verdict

## 保密要求

- API key 仅经环境变量传递，绝不写入任何报告/日志/fixture/git diff
- HTTP trace 一律 sanitized（Authorization: [REDACTED]）
