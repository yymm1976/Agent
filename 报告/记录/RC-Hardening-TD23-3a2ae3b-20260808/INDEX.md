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
- Real API requests used: 0 / 60
- Current CI state: 6 Job 全绿（3a2ae3b）

## Phase 状态

| Phase | 状态 | 备注 |
|---|---|---|
| A1-A5 RC blockers | DONE | 全部关闭（59d9eeb + 本轮） |
| B RunState | pending | |
| C Event model | pending | |
| D Retry idempotency | pending | |
| E Cancellation | pending | |
| F Error taxonomy | pending | |
| G Filesystem/security | pending | |
| H Prompt injection | pending | |
| I Repo context | pending | |
| J Context budget | pending | |
| K Streaming FSM | pending | |
| L TD-23 real DeepSeek | pending | |
| M Fault injection | pending | |
| N Harness comparison | pending | |
| O Self review | pending | |
| Final gate | pending | |
