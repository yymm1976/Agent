# Agent 工作区 — 全局 Agent 约定

> 任何大模型 / Agent 接手本仓库前必读。  
> 主工程代码在 `routedev/`；详细代码索引见 `routedev/CODEMAP.md`；完整陷阱见 `routedev/.routedev/skills/pitfalls-guide/SKILL.md`（若本地存在）或 `routedev/AGENTS.md`。
> **路径权威表：** [docs/PATHS.md](docs/PATHS.md)（整理后旧路径已失效，禁止再引用根 CLI 脚手架 / 根级 sonetto）。

## 0. 30 秒决策树

```
任务是什么？
├─ 理解代码 / 找符号 / 调链路 / 评估改动影响
│   └─ 用 codebase MCP（codegraph 或 codebase-memory-mcp）
│       禁止一上来全库 grep / 盲读大文件
├─ 跑 shell（git / test / build / typecheck / 日志）
│   └─ 用 rtk 压缩输出，再读结果
│       禁止直接 dump 完整 vitest/tsc/pnpm 日志进上下文
├─ 字符串字面量 / 配置值 / 非代码文件 / MCP 结果不够
│   └─ 再允许 rtk grep 或受限文件读取
└─ 必须看完整原始输出（排障）
    └─ rtk proxy <cmd> 或裸命令，并说明原因
```

**默认组合：** `codebase MCP 定位` → `精确读代码` → `rtk 跑验证` → `必要时再搜字符串`。

---

## 1. 工具分层（必须遵守）

| 层级 | 工具 | 用途 | 不用于 |
|------|------|------|--------|
| L1 代码发现 | `codegraph` / `codebase-memory-mcp` | 符号、调用链、架构、影响面 | 查纯字符串、YAML/JSON 值 |
| L2 精确阅读 | Read / 打开 MCP 返回的文件片段 | 确认实现细节 | 漫无目的扫全文件 |
| L3 命令输出 | `rtk ...` | 压缩 git/test/build/log | 交互式 TTY、需要完整原始日志时 |
| L4 兜底搜索 | `rtk grep` / 项目内搜索 | 字面量、报错文案、配置键 | 当 L1 的替代品（能图就不搜） |

### 1.1 codebase MCP：何时用、怎么用

本机通常同时有：

- **codegraph**（stdio: `codegraph serve --mcp`）
- **codebase-memory-mcp**（stdio 二进制，图谱 + 索引）

**优先场景：**

1. 「X 在哪 / 怎么工作 / 谁调用谁」
2. 改函数/模块前的影响分析
3. 快速建立模块地图（比瞎读目录快）

**推荐调用顺序：**

1. `index_repository` / 确认索引可用（codebase-memory；首次或大改后）
2. `search_graph` / `codegraph_search` / `codegraph_explore` — 找符号或区域
3. `trace_path` / `codegraph_callers` / `codegraph_callees` — 调用关系
4. `get_code_snippet` / `codegraph_node` — 读关键函数体
5. `get_architecture` / `codegraph_impact` — 架构或改动波及面
6. 仍不够 → 再 `rtk grep` 或读具体文件

**不要：**

- 为找 `createAppDependencies` 这类符号去全库 `grep`
- 把整个 `src/` 目录树读进上下文
- 在 MCP 明确返回路径后，仍重复搜索同一符号

**要：**

- 用 MCP 结果里的 `file:line` 做后续精读
- 大改前先 impact / callers，再动手
- MCP 不可用时，在回复里说明，再降级到 `CODEMAP.md` + 受限搜索

### 1.2 rtk：何时用、怎么用

`rtk`（Rust Token Killer）= 命令输出过滤器，历史可省约 60–90% shell 输出 token。

**必须优先 rtk 的命令：**

```bash
rtk git status
rtk git diff
rtk git log
rtk err pnpm test
rtk err npm test
rtk vitest
rtk tsc --noEmit
rtk npm run build
rtk pnpm typecheck
rtk grep -n "exact-string" path
rtk docker ps
```

在本仓库（RouteDev / Electron + pnpm + vitest）尤其高价值：

| 命令意图 | 推荐 | 原因 |
|----------|------|------|
| 看改动 | `rtk git status` / `rtk git diff` | 文件多、diff 大 |
| 跑测 | `rtk err pnpm test` 或 `rtk vitest` | 日志极长，只要失败 |
| 类型检查 | `rtk tsc --noEmit` 或包一层 `rtk err pnpm typecheck` | 错误可压缩分组 |
| 构建 | `rtk npm run build` / 对应 pnpm 脚本 | 刷屏输出 |
| 字符串搜 | `rtk grep ...` | 仅 L4 兜底 |

**不要用 rtk 时：**

- 需要完整原始日志定位罕见 bug → `rtk proxy <cmd>`
- 交互式程序 / TUI
- 输出本来就很短（`node -v` 等）
- 过滤可能藏关键一行时，先 proxy 复核

**Codex 注意：** Codex 不会像 Claude Code 那样自动 hook 改写命令；你必须**主动**写 `rtk ...` 前缀。

**元命令：**

```bash
rtk gain              # 查看节省统计
rtk rewrite "git status"  # 预览改写
rtk proxy pnpm test   # 不压缩执行
```

---

## 2. 标准工作流（教会下一任模型）

### A. 实现功能 / 修 bug

```
1. codebase MCP：定位模块与调用链
2. 精读 1–3 个关键文件片段（不是整仓）
3. 小步修改
4. rtk 跑验证：typecheck / 相关测试
5. rtk git diff 自审
6. 需要提交时再按 Conventional Commits 处理
```

### B. 代码审查

```
1. rtk git status / rtk git diff（或 PR diff）
2. 对每个高风险改动点：MCP callers/impact
3. 只深读风险相关实现
4. 结论按严重级别输出（正确性 > 安全 > 回归 > 风格）
```

### C. 调查「为什么挂了」

```
1. rtk err <原测试/构建命令>   # 先压缩失败信号
2. 从报错符号/文件 → MCP 定位定义与调用方
3. 精读 + 最小复现
4. 修复后再次 rtk err 验证
```

### D. 陌生模块上手

```
1. 读 routedev/AGENTS.md + CODEMAP.md 对应章节
2. MCP get_architecture / explore 该目录
3. 再进具体文件
```

---

## 3. 反模式（禁止）

1. **先 grep 后思考**：符号/架构问题先 MCP。  
2. **整份 vitest 日志进上下文**：用 `rtk err` / `rtk vitest`。  
3. **无目标 `Read` 大文件**：先 snippet / node / 限定行号。  
4. **MCP 与 rtk 混用目标反了**：MCP 不负责压缩 shell；rtk 不负责理解架构。  
5. **隐藏工具失败**：MCP/rtk 不可用要明确说，并降级，不要假装查过。  

---

## 4. 仓库地图（给模型定向）

| 路径 | 含义 |
|------|------|
| `routedev/` | **唯一主工程**（TypeScript / Electron / pnpm） |
| `routedev/AGENTS.md` | 工程约定、陷阱、Core 不做清单 |
| `routedev/CODEMAP.md` | 模块索引 |
| `routedev/src/` | 引擎与运行时核心 |
| `routedev/desktop/` | Electron 主进程 + 渲染层 |
| `docs/` | 工作区文档；`docs/AGENT_TOOLING.md`、`docs/tools/` |
| `蓝图与Phase/` | 设计与 Phase 文档（非运行时） |
| `报告/` | 分析 / 审查 / 验证报告 |
| `design-demos/` | 原型 HTML |
| `refs/sonetto-here-ref/` | 外部参考实现，**只读**，不要当主开发树改 |
| `archive/` | 根目录清理归档（旧 CLI 脚手架、一次性脚本），非产品代码 |
| `README.md` | 人类可读的工作区导航 |

路径细节与旧→新对照见 [docs/PATHS.md](docs/PATHS.md)。

**工作目录：始终优先 `routedev/`。**  
禁止在仓库根执行 `pnpm install` / `pnpm test`（根脚手架已迁到 `archive/root-cli-scaffold/`）。

## 5. 验证命令速查（一律倾向 rtk）

索引重建见 [docs/PATHS.md](docs/PATHS.md) §6。codebase-memory 项目名：`C-tmp-routedev-idx`（junction `C:/tmp/routedev-idx` → `routedev/`）。


```bash
# 在 routedev 目录
rtk err pnpm test
rtk err pnpm typecheck
rtk git status
rtk git diff

# 仅看失败信号的通用包法
rtk err <any-noisy-command>
```

---

## 6. 给下一任模型的最小检查清单

开始改代码前：

- [ ] 已读本文件 + `routedev/AGENTS.md` 相关部分  
- [ ] 代码定位走了 MCP，而不是全库搜  
- [ ] 噪声命令走了 rtk  
- [ ] 知道如何 `rtk proxy` 拿全文  
- [ ] 改完用压缩后的 test/typecheck 验证  

结束任务前：

- [ ] 说明用了哪些 MCP 工具 / 关键路径  
- [ ] 验证命令与结果（可用 rtk 摘要）  
- [ ] 未把无关大日志粘进最终回复  

---

## 7. 与全局 Codex 配置的关系

用户全局可能还有：

- `~/.codex/AGENTS.md`（codebase-memory 提醒 + RTK 引用）
- `~/.codex/RTK.md`
- MCP：`codegraph`、`codebase-memory-mcp`

**本文件是仓库级强制约定**；与全局冲突时，**以本仓库 `AGENTS.md` + `routedev/AGENTS.md` 为准**。

---

## 8. 当前工作状态交付快照（2026-08-01）

> 本节为跨 Harness / 跨会话交接而临时追加，保存当前进行中的工作状态。任务完成后可由后续维护者移除本节。
> 计划文档：`报告/Proma借鉴落地计划-Phase97.md`。

### 8.1 主线任务：Phase 97（Proma 借鉴落地）

9 个 Part 渐进推进：A 统一执行上下文与事件生命周期 →（C 全局中断、D 工作区并行）→（B 联合回滚、E 子会话、G 输入框引用并行）→（F 自动化、H Agent Island），I 极简记忆穿插。

**实现完成度（独立子 Agent 审查结论）：**

| Part | 内容 | 完成度 | 结论 |
|------|------|--------|------|
| A | 执行上下文/事件生命周期/Kernel | 2/3 | ⚠️ 类型层全落地，运行时链路休眠 |
| B | TurnSnapshot 联合回滚 | 2/2 | ✅ 主链路完整，UI 入口缺 |
| C | 全局中断队列 | 2/2 | ✅ 完整（60s 超时 + abort） |
| D | 工作区能力边界 | 2/2 | ✅ 完整，配置段有偏差 |
| E | 子会话可见性 | 2/2 | ⚠️ 主进程完整，renderer 零消费 |
| F | 自动化调度 + 自我迭代 | 1/2 | ⚠️ 调度器完整，evolution 孤立 |
| G | ComposerReference | 2/2 | ⚠️ 解析器完整，renderer 未接入 |
| H | Agent Island | 2/2 | ✅ 完整 |
| I | 极简记忆 | 3/3 | ⚠️ 记录侧完整，淘汰侧未接线 |

**关键缺口（审查发现）：**
- A3 AgentKernel 无生产实现（仅测试 MockKernel）——Critical
- F2 automation-evolution 整个模块孤立（仅测试引用）——Critical
- EngineEventV1 事件发射无 sink 调用方（`setEngineEventSink` 无消费者）——事件恒短路
- AgentExecutionContext 触发来源未透传（恒为兜底 `'user'`）
- 三组 IPC（composer / 子会话 / turn 回滚）主进程完整但 renderer 无调用方

**已确认的处理决策（用户拍板）：**
1. 两个 Critical 孤立模块：**全部补接线保留**（不删除）——kernel.ts 补 routedev-native 薄适配装配到 app-init；automation-evolution.ts 接入 scheduler 执行闭环
2. 三组休眠 IPC 的 renderer UI：**本轮全做**——InputArea composer 引用提示（/ @ & ~ + 拖拽）、子会话面板、对话回滚入口

### 8.2 已完成的改动（全部未提交）

**Phase 97 本体：**
- Part A：`src/agent/execution-context.ts`、`src/harness/event-types.ts`、`src/agent/kernel.ts`（接口，待接线）；loop.ts 发射 agent/turn/message 生命周期 + sequence
- Part B：`src/harness/turn-snapshot.ts` TurnSnapshotManager（capture/restore，hash+边界校验）；chat-bridge 每 turn capture
- Part C：`src/agent/interruption.ts` + `interruption-broker.ts`（submit/resolve/reject/reclaim/abort + 60s 超时）；renderer `useGlobalInterruptions.ts` 顶层挂载
- Part D：`src/workspace/types.ts` + `manager.ts`（CRUD + validateAttachments + isPathAllowed 接入权限引擎）
- Part E：`src/agents/subagent-registry.ts`、`desktop/main/bridges/agent-bridge.ts`、spawn-agent 携带 childSessionId、delegation 增加 permissionCeiling（执行期强制）
- Part F：`src/runtime/automation-scheduler.ts`（cron/迁移/tick/runTask）+ `automation-evolution.ts`（待接线）
- Part G：`src/agent/context/composer-reference.ts`（/ & ~ @ 前缀 + accessScope）；chat-bridge 结构化注入 systemBlocks
- Part H：`desktop/main/agent-status-service.ts` + `AgentIsland.tsx`（常驻顶部轮询 agent:get-status）
- Part I：`src/memory/user-profile.ts`、`hit-stat.ts`、`src/skills/coach.ts`；skill-lifecycle 增 suggestSkillFromWorkflows
- 装配：`src/runtime/app-init-agent-loop.ts` / `app-init-agent-middleware.ts` / `app-init-agent-trust.ts`（由 app-init-agent.ts 调用）

**收尾修复：**
1. preload/index.ts 两处重复 `agent` 段合并（follow-up + getStatus）
2. desktop/main/index.ts Phase 97 handler 补 `async`；`chat:restore-turn` 修正 Multi 用法（1 个类型参数，handler 首参是 event）
3. tests/harness/audit-logger.test.ts flaky 测试加 10ms 间隔
4. **typecheck:desktop 存量错误清零**（46 → 0）：chat-bridge finalUsage 标注 TokenUsageInfo；config-bridge getModels 可选调用；index.ts `Electron.AppName`→`Parameters<typeof app.getPath>[0]`、isActive→isFocused、engine:start/stop/restart 改日志 stub；profile-bridge.test.ts 夹具补字段；gateway-server removeListener 类型；ProfileVersionPanel.test.tsx fieldChanges 对象化 + jest-dom import；useRouteDevStore `as unknown as GoalEvent`

### 8.3 验证状态（截至 2026-08-01）

| 检查 | 结果 |
|------|------|
| `pnpm typecheck`（tsc --noEmit） | ✅ exit 0 |
| `pnpm typecheck:desktop` | ✅ exit 0（存量错误已清零） |
| `pnpm test` | ✅ 284 文件通过，3775 测试通过，160 跳过 |

注意：以上为收尾修复后状态；待办接线与 UI 改动完成后必须重跑全部验证。

### 8.4 待办清单（按优先级）

**Critical（补接线保留）：**
- [ ] k1 kernel.ts 接线：补 routedev-native 薄适配（包装 ReActAgentLoop），装配到 `src/runtime/app-init.ts`，保证 getSessionState/abort 有生产消费点；更新 `tests/agent/kernel.test.ts`
- [ ] k2 automation-evolution 接线：AutomationScheduler.runTask 后将结果转 AutomationFeedback → 定期 buildSuggestion → SuggestionApprovalQueue（人工审批后应用，不自动写）；更新测试

**Warning（代码层）：**
- [ ] k3 EngineEventV1 sink 接通：给 loop.setEngineEventSink 找生产调用方（trace-collector 或 chat-bridge）；trace 携带 sequence/turnId
- [ ] k4 AgentExecutionContext 透传：chat-bridge 传 'user'、automation executor 传 'automation'、delegation 传 'delegation'、remote 传 'remote'
- [ ] k5 导出即死函数接入：evaluateBatchCompletion、isAllowedByAllowlist + allowlist 字段、validateUserProfile、HitStat.evaluateLowHits

**UI（本轮全做）：**
- [ ] u1 InputArea 接入 composer 引用提示（/ @ & ~ 前缀 + 拖拽文件解析）
- [ ] u2 子会话面板（listSubagents/getSubagent/stopSubagent）
- [ ] u3 对话回滚入口（listTurnSnapshots/restoreTurn）

**收尾：**
- [ ] v1 重跑 pnpm typecheck / typecheck:desktop / pnpm test 全绿
- [ ] v2 双轴代码审查（standards + spec）
- [ ] 提交到 main 分支（当前领先 origin/main 94 提交未推送；用户要求提交时才提交）

### 8.5 关键文件索引

| 领域 | 文件 |
|------|------|
| 执行上下文 | `src/agent/execution-context.ts` |
| 事件协议 | `src/harness/event-types.ts` |
| Kernel 接口 | `src/agent/kernel.ts`（待接线） |
| Turn 快照 | `src/harness/turn-snapshot.ts` |
| 中断队列 | `src/agent/interruption.ts` / `src/agent/interruption-broker.ts` |
| 工作区 | `src/workspace/types.ts` / `src/workspace/manager.ts` |
| 子会话 | `src/agents/subagent-registry.ts` / `desktop/main/bridges/agent-bridge.ts` |
| 自动化 | `src/runtime/automation-scheduler.ts` / `src/runtime/automation-evolution.ts`（待接线） |
| 引用解析 | `src/agent/context/composer-reference.ts` |
| Agent 状态 | `desktop/main/agent-status-service.ts` / `desktop/renderer/src/components/agent/AgentIsland.tsx` |
| 记忆 | `src/memory/user-profile.ts` / `src/memory/hit-stat.ts` |
| Skills 沉淀 | `src/skills/coach.ts` / `src/skills/skill-lifecycle.ts` |
| 装配 | `src/runtime/app-init.ts` / `src/runtime/app-init-agent-loop.ts` 等 |

### 8.6 陷阱与注意事项

1. Zod schema preprocess 兜底：数组 schema 的 preprocess 兜底必须是 `[]` 而非 `{}`（已修复 automations 段）
2. createValidatedHandlerMulti：只接受 1 个类型参数 `<TResult>`；handler 首参是 `event`
3. createValidatedHandler：handler 必须返回 `Promise<TResult>`，同步回调要加 `async`
4. BrowserWindow 没有 `isActive()`，用 `isFocused()`
5. `Electron.AppName` 不存在，用 `Parameters<typeof app.getPath>[0]`
6. git status：`main...origin/main [ahead 94]`，大量文件未提交；提交前确认范围
7. typecheck:desktop 输出很长，用 `Select-String -Pattern "error TS"` 过滤
8. 死代码审查发现 `KernelBinding` 全仓零引用，接线时注意
9. 严格死代码原则：新增配置/模块/函数必须有消费点，孤立模块标 Critical 阻塞合入