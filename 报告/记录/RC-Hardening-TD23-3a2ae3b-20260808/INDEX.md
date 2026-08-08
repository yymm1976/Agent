# RC Hardening Mission — INDEX

> 持续更新。每发现 P0/P1、关闭项、Phase 完成、TD-23 capability 结论立即更新。

## Findings

| ID | Severity | Status | Area | Summary | Evidence |
|---|---|---|---|---|---|
| F-001 | P1 | FIXED | ordered-revision | id 变长 base36 字符串序错（'9' vs '10'） | tests/utils/ordered-revision.test.ts |
| F-002 | P1 | FIXED | executable-identity | parseCommand 反斜杠损坏 + .com 缺失 | tests/security/sandbox.test.ts A1 |
| F-003 | P1 | FIXED | destructive-policy | rm target 归一 '/etc/..' 折叠为空串漏拦 | tests/security/sandbox.test.ts A2 |
| F-004 | P1 | FIXED | profile-version | legacy timestamp vs new revision 跨数值域比较 | tests/agents/profiles-version.test.ts A3 |
| F-005 | P1 | FIXED | audit-chain | 链 head 内存态，logger 重建断链 | tests/harness/audit-logger.test.ts A5 |
| F-006 | P1 | FIXED | runstate | effort/autonomy 跨 Run 残留 | tests/agent/loop.test.ts B1 |

## 当前状态

- Open P0: 0
- Open P1: 0
- Closed P0: 0
- Closed P1: 6
- Real API requests used: 11 / 60
- Current CI state: 6 Job 全绿（e8995c3 完整确认：Core/Desktop×3/Android/Security 全 success）

## Phase 状态

| Phase | 状态 | 备注 |
|---|---|---|
| A1-A5 RC blockers | DONE | 全部关闭（59d9eeb + 本轮） |
| B RunState | DONE | |
| C Event model | DONE（矩阵） | |
| D Retry idempotency | DONE（at-most-once 文档化） | |
| E Cancellation | DONE（链 + R9 真实） | |
| F Error taxonomy | DONE | |
| G Filesystem/security | DONE（G1 已有覆盖核查） | |
| H Prompt injection | DONE（TRUST_MODEL + H2 测试） | |
| I Repo context | DONE（GAP 分析 WEAKER 记录） | |
| J Context budget | DONE（SOURCE_OF_TRUTH 相关） | |
| K Streaming FSM | DONE（R6 真实帧序 + 尾块守卫） | |
| L TD-23 real DeepSeek | DONE（R1-R9，11 请求） | |
| M Fault injection | DONE（矩阵） | |
| N Harness comparison | DONE（GAP_ANALYSIS） | |
| O Self review | DONE（SELF_REVIEW） | |
| Final gate | DONE（4057 绿 + Verdict: RC CANDIDATE） | |
