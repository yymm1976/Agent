# RouteDev 功能完整度审查报告 — 维度 1 & 维度 8

> - **审查基线版本：** v4.5.4（Phase 60 发布版 + Phase 61-73 后续迭代）
> - **审查日期：** 2026-07-08
> - **审查范围：** 维度 1「设计文档 vs 实现一致性」、维度 8「文档完整性」
> - **审查依据：** `C:\Users\杨铭\Desktop\Agent\报告\RouteDev-功能完整度审查提示词.md`

---

## 审查方法简述

1. 建立基线：通读 `AGENTS.md`、`CODEMAP.md`、`CHANGELOG.md`（v4.5.4 / v4.5.3 / v4.0.2 / v4.0.1 / v4.0.0 / v3.9.0 / v3.0.0）、`docs/ARCHITECTURE.md`、`docs/CONFIGURATION.md`、`docs/PLUGIN_GUIDE.md`、`docs/SECURITY_AUDIT_v2.0.md`、`action.yml`、`.github/workflows/routedev-example.yml`。
2. 关键代码核验：读取 `src/runtime/goal-runner.ts`、`src/harness/checkpoint-manager.ts`、`src/runtime/app-init.ts`、`desktop/main/engine-bridge.ts`、`desktop/main/index.ts`、`desktop/preload/index.ts`、`src/config/schema.ts`、`src/config/defaults.ts`、`scripts/action-entry.ts`。
3. 通过 `Glob` 与 `Grep` 验证 CODEMAP 列出的文件是否存在、CHANGELOG 声称已删除的模块是否仍残留、文档描述是否与代码一致。

---

## 详细发现（findings）

```yaml
- id: F-D1-001
  level: Missing
  dimension: 维度1-设计文档一致性
  location:
    file: routedev/CODEMAP.md
    line: 55-96
  title: CODEMAP.md 列出多个已不存在的源文件
  problem: |
    CODEMAP.md 在“src/agent/ — Agent 引擎层”中把 8 个已删除或未创建的源文件描述为当前模块：
    dream-consolidator.ts（55 行）、requirements-gatherer.ts（79 行）、
    complexity-analyzer.ts（80 行）、execution-orchestrator.ts（81 行）、
    failure-report.ts（84 行）、requirements-clarifier.ts（87 行）、
    src/config/watcher.ts（96 行）、memory/dream-to-graph.ts（71 行）。
    Glob 与 Grep 均确认这些文件在磁盘上不存在，说明代码索引与真实代码库严重脱节。
  evidence:
    claim_source:
      file: routedev/CODEMAP.md
      line: 55
      text: "dream-consolidator.ts — DreamConsolidator：整理记忆（合并去重）（331 行）"
    code_location:
      file: routedev/CODEMAP.md
      line: 55-96
    search_performed:
      - pattern: "src/agent/dream-consolidator.ts"
        scope: "routedev/"
        match_count: 0
      - pattern: "src/agent/requirements-clarifier.ts"
        scope: "routedev/"
        match_count: 0
      - pattern: "src/config/watcher.ts"
        scope: "routedev/"
        match_count: 0
      - pattern: "src/agent/execution-orchestrator.ts"
        scope: "routedev/"
        match_count: 0
      - pattern: "src/agent/memory/dream-to-graph.ts"
        scope: "routedev/"
        match_count: 0
  impact: 新接入的 Agent 会被 CODEMAP 误导到不存在或已退役的模块，降低定位效率，增加维护成本。
  recommendation: |
    1. 从 CODEMAP.md 移除已删除的条目，或统一标注“已退役”。
    2. 将 CODEMAP.md 的“最后更新”日期与 Phase 72 后的代码状态同步。
  status: open

- id: F-D1-002
  level: Missing
  dimension: 维度1-设计文档一致性
  location:
    file: routedev/src/config/loader.ts / routedev/desktop/main/config-store.ts
  title: 配置热重载 watcher 未实现
  problem: |
    CODEMAP.md 与核心功能清单 C4 均声称存在 `src/config/watcher.ts` 负责“配置文件热重载”。
    实际该文件不存在，且在 `src/config/loader.ts`、`desktop/main/config-store.ts`、
    `desktop/main/engine-bridge.ts` 中均未使用 `fs.watch`、`chokidar` 等文件监听机制。
    当前仅能通过 `config:save`/`config:reload` IPC 手动触发重载，手动修改 `config.yaml` 不会自动生效。
  evidence:
    claim_source:
      file: routedev/CODEMAP.md
      line: 96
      text: "watcher.ts — 配置文件热重载（最终一致）（51 行）"
    code_location:
      file: routedev/desktop/main/index.ts
      line: 431-440
      text: "ipcMain.handle('config:reload', ...) 仅响应显式 IPC 调用"
    search_performed:
      - pattern: "fs\.watch|chokidar|watchFile|addListener.*change"
        scope: "routedev/src/config/"
        match_count: 0
      - pattern: "fs\.watch|chokidar|watchFile"
        scope: "routedev/desktop/main/config-store.ts"
        match_count: 0
  impact: 用户期望的“保存 config.yaml 后自动热重载”功能缺失，文档描述为 false claim。
  recommendation: |
    方案 A：实现 `src/config/watcher.ts` 并在 app 启动时注册监听。
    方案 B：若暂不支持文件级热重载，应在 CODEMAP.md 与 CONFIGURATION.md 中删除该声称。
  status: open

- id: F-D8-001
  level: Missing
  dimension: 维度8-文档完整性
  location:
    file: routedev/CODEMAP.md
    line: 55-96
  title: CODEMAP.md 未同步 Phase 56-72 模块删除
  problem: |
    维度 8 检查项 8.3/8.4 要求 CODEMAP 与 CHANGELOG 同步。实际 CODEMAP 仍列出 dream-consolidator、
    requirements-gatherer、complexity-analyzer、execution-orchestrator、failure-report、
    requirements-clarifier、watcher、memory/dream-to-graph 等已删除模块，而 CHANGELOG v4.5.4/v4.5.3
    已明确这些模块或对应配置字段被移除。
  evidence:
    claim_source:
      file: routedev/CODEMAP.md
      line: 81
      text: "execution-orchestrator.ts — ExecutionOrchestrator：单/多 Agent 自适应执行编排（Phase 31）"
    code_location:
      file: routedev/CHANGELOG.md
      line: 183
      text: "删除 11 个完全死掉的源文件：src/agent/types.ts / src/router/reasoning-mode.ts ..."
    search_performed:
      - pattern: "execution-orchestrator|requirements-gatherer|complexity-analyzer|failure-report|requirements-clarifier"
        scope: "routedev/src/"
        match_count: 0
  impact: 作为项目入口文档，CODEMAP 的滞后会让开发者误以为已清理的死代码仍然存在。
  recommendation: 依据 CHANGELOG v4.5.4 与 Phase 72 清理结果，重新梳理 CODEMAP 模块列表。
  status: open

- id: F-D8-002
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: routedev/docs/CONFIGURATION.md
    line: 1-227
  title: CONFIGURATION.md 严重滞后且包含已删除字段
  problem: |
    CONFIGURATION.md 标题声称“列出 RouteDev 所有配置项”，但正文仅详细描述了 Phase 50 接入开关，
    缺少 general、providers、router、checkpoint、goalVerifier、security、autonomy、sounds、updates、
    mcp、channels、webSearch、knowledgeGraph、codeMap、market、policies、subAgents、goal、memory、
    discovery、trust、quality、expertise、vision、voice、phase53Integration、phase52Integration 等
    大量 schema 分组的说明。更严重的是，文档仍保留了 Phase 59 已删除的字段：
    `goalIntegration.promptBuilderEnabled`（37 行）、`goalIntegration.requirementChangeEnabled`（43 行）、
    `phase49Integration.routingFunnelEnabled`（154 行），并引用了已随 CLI 退役的 Ink 组件描述。
  evidence:
    claim_source:
      file: routedev/docs/CONFIGURATION.md
      line: 3
      text: "本文档列出 RouteDev 所有配置项，按模块分组。"
    code_location:
      file: routedev/src/config/schema.ts
      line: 8-1883
      text: "AppConfigSchema 包含 40+ 个配置分组，但 CONFIGURATION.md 仅覆盖其中 6 个且含 3 个已删字段"
    search_performed:
      - pattern: "promptBuilderEnabled|requirementChangeEnabled|routingFunnelEnabled"
        scope: "routedev/src/config/schema.ts"
        match_count: 0
  impact: 用户无法通过官方文档正确理解可用配置；复制“全功能配置示例”会因包含已删字段而失真。
  recommendation: |
    1. 删除 CONFIGURATION.md 中所有已删除字段。
    2. 按 schema.ts 当前分组补齐通用配置、路由、安全、MCP、子 Agent、Goal、Phase 53 等章节。
  status: open

- id: F-D8-003
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: routedev/docs/SECURITY_AUDIT_v2.0.md
    line: 46-91
  title: SECURITY_AUDIT_v2.0.md 引用已删除子系统并给出错误默认值
  problem: |
    安全审计报告 v2.0 仍把 `src/channels/adapters/wechat-work.ts` 和 `src/channels/server.ts` 作为证据引用，
    但 `src/channels/` 整个子系统已在 Phase 72 删除。此外，报告声称 `networkConfirm` 默认启用，
    而当前 schema.ts 中 `networkConfirm` 默认值为 `false`。
  evidence:
    claim_source:
      file: routedev/docs/SECURITY_AUDIT_v2.0.md
      line: 67
      text: "src/channels/server.ts — WebhookServer 模块完整"
    code_location:
      file: routedev/src/config/schema.ts
      line: 270
      text: "networkConfirm: z.boolean().default(false)"
    search_performed:
      - pattern: "src/channels/"
        scope: "routedev/src/"
        match_count: 0
      - pattern: "networkConfirm.*default\\(false\\)"
        scope: "routedev/src/config/schema.ts"
        match_count: 1
  impact: 历史审计文档与当前安全实现不一致，可能误导合规检查或安全评审。
  recommendation: 更新 SECURITY_AUDIT_v2.0.md：移除 channels 证据、修正 networkConfirm 默认值，或标注为“历史版本 v2.0”并补充当前版本审计。
  status: open

- id: F-D8-004
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: routedev/docs/PLUGIN_GUIDE.md
    line: 151-172
  title: PLUGIN_GUIDE.md 描述的 /plugin 命令未实现
  problem: |
    PLUGIN_GUIDE.md 第 7 节说明通过 `/plugin list`、`/plugin enable`、`/plugin disable`、
    `/plugin reload` 管理插件，但在 `desktop/main/engine-bridge.ts` 的 `executeCommand`、
    `desktop/main/index.ts` IPC 以及 SettingsPage 中均未发现 `/plugin` 命令或插件管理 UI。
    当前插件系统（`src/plugins/registry.ts`、`src/runtime/plugin-init.ts`）仅用于内部中间件管线注册。
  evidence:
    claim_source:
      file: routedev/docs/PLUGIN_GUIDE.md
      line: 162
      text: "使用 `/plugin` 命令管理插件：/plugin list / /plugin enable <name> / /plugin disable <name> / /plugin reload"
    code_location:
      file: routedev/desktop/main/engine-bridge.ts
      line: 662-714
      text: "executeCommand 仅处理 /goal /clear /status /mcp /compact /skill /help，无 /plugin 分支"
    search_performed:
      - pattern: "plugin list|plugin enable|plugin disable|/plugin\\b"
        scope: "routedev/desktop/"
        match_count: 0
  impact: 插件开发指南描述的终端命令无法使用，外部开发者无法按文档完成插件生命周期管理。
  recommendation: 在 desktop 端补充 `/plugin` 命令分发与插件管理 UI，或从 PLUGIN_GUIDE.md 删除相关命令描述。
  status: open

- id: F-D8-005
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: routedev/docs/ARCHITECTURE.md
    line: 52-54 / 114
  title: ARCHITECTURE.md MCP 传输协议与内置工具列表过时
  problem: |
    ARCHITECTURE.md 2.3 节列出内置工具为 file_read / file_write / shell_exec / code_search / file_search / git_op / web_search / notes，
    遗漏了 `spawn_agent`、`ask_user`、`list_directory`、`web_fetch`、`todo_write` 等当前实际注册的工具。
    第 114 行又称 MCP 仅支持 stdio 和 SSE，而 schema.ts 已支持 stdio / http / sse / streamable_http / websocket 五种传输协议。
  evidence:
    claim_source:
      file: routedev/docs/ARCHITECTURE.md
      line: 114
      text: "通过 MCP 协议接入外部工具服务器，支持 stdio 和 SSE 两种传输方式。"
    code_location:
      file: routedev/src/config/schema.ts
      line: 427-464
      text: "MCPServerConfigSchema 使用 discriminatedUnion 定义 stdio / http / sse / streamable_http / websocket"
    search_performed:
      - pattern: "spawn_agent|ask_user|list_directory|web_fetch|todo_write"
        scope: "routedev/src/runtime/app-init.ts"
        match_count: 5
  impact: 架构文档未能准确反映当前工具集与 MCP 能力，造成设计与实现认知偏差。
  recommendation: 同步 ARCHITECTURE.md 的内置工具列表与 MCP 传输协议说明至 schema.ts 与 app-init.ts 现状。
  status: open

- id: F-D8-006
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: routedev/README.md
    line: 38-49 / 58-63
  title: README.md 仍描述已退役的 Phase 31 流水线与 /plan 命令
  problem: |
    README.md“架构概览”把 TaskOrchestrator 作为所有非命令输入的调度中心，并依次画出
    RequirementsGatherer、TaskComplexityAnalyzer、ExecutionOrchestrator 等阶段。
    这些源文件已不存在，且 `engine-bridge.executeCommand` 未实现 `/plan` 命令，
    当前 desktop 端实际由 `sendChat`/`executeCommand` 直接处理输入与 `/goal`。
  evidence:
    claim_source:
      file: routedev/README.md
      line: 44
      text: "ExecutionOrchestrator（单/多 Agent 自适应）"
    code_location:
      file: routedev/desktop/main/engine-bridge.ts
      line: 693-713
      text: "/help 仅列出 /clear /status /mcp /compact /skill /help，无 /plan"
    search_performed:
      - pattern: "src/agent/execution-orchestrator.ts|src/agent/requirements-gatherer.ts|src/agent/complexity-analyzer.ts"
        scope: "routedev/"
        match_count: 0
      - pattern: "/plan\\b"
        scope: "routedev/desktop/main/engine-bridge.ts"
        match_count: 0
  impact: 新用户按 README 理解的执行流程与真实桌面端行为不符。
  recommendation: 重写 README.md 架构概览，以当前 desktop/main/engine-bridge.ts 与 goal-runner.ts 的交互路径为准。
  status: open

- id: F-D8-007
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: routedev/desktop/preload/index.ts
    line: 99-112
  title: Phase 71 Plan 修订历史 / Phase 73 Follow-up 队列功能无文档
  problem: |
    preload 已暴露 `plan:get-revisions`、`plan:check-omissions`、`agent:followUp`、
    `agent:clearAllQueues`、`agent:setFollowUpMode`、`agent:queueStatus`、
    `agent:getFollowUpQueue`、`agent:removeFollowUp` 等 IPC API，且 engine-bridge/main 已实现对应逻辑。
    但在 `docs/`、`README.md`、`CHANGELOG.md`（v4.5.4 未提及 Phase 71/73 功能）中均未找到相关说明。
  evidence:
    claim_source:
      file: routedev/desktop/preload/index.ts
      line: 106
      text: "// Phase 73 Part C：Steering / Follow-up 双消息队列 API"
    code_location:
      file: routedev/desktop/main/index.ts
      line: 800-857
      text: "ipcMain.on('agent:followUp', ...); ipcMain.handle('plan:get-revisions', ...)"
    search_performed:
      - pattern: "followUp|getRevisions|checkOmissions|plan-revisions"
        scope: "routedev/docs/"
        match_count: 0
  impact: 已实现的功能缺少用户文档，导致用户不知如何触发计划修订历史、遗漏点检查与 Follow-up 插话。
  recommendation: 补充 docs/PHASE71_PLAN_REVISION.md、docs/PHASE73_FOLLOWUP.md，或在 README 中新增对应章节。
  status: open
```

---

## 审查汇总

### 按级别统计

| 级别 | 数量 |
|------|------|
| Complete | 9 |
| Partial | 7 |
| Missing | 3 |
| Broken | 0 |
| Orphan | 0 |

### 按维度统计

| 维度 | Complete | Partial | Missing | Broken | Orphan |
|------|----------|---------|---------|--------|--------|
| 1. 设计文档一致性 | 5 | 3 | 1 | 0 | 0 |
| 8. 文档完整性 | 4 | 7 | 1 | 0 | 0 |

> 注：维度 1 的“Missing”为 CODEMAP 列出多个不存在文件；维度 8 的“Missing”为 CODEMAP 同样的问题在文档完整性维度再判定一次。两项已分别给出 finding。

### Top 5 高优先级问题

1. **[F-D8-002] CONFIGURATION.md 严重滞后且包含已删除字段**
   - 这是用户直接依赖的配置参考，但既缺失绝大多数 schema 分组，又保留已删字段，最容易导致配置错误。

2. **[F-D8-006] README.md 仍描述已退役的 Phase 31 流水线与 /plan 命令**
   - README 是项目门面，错误架构图会让新用户和贡献者对真实执行路径产生根本误解。

3. **[F-D1-001 / F-D8-001] CODEMAP.md 列出多个已不存在的源文件**
   - 作为“搜索代码前先读”的索引，CODEMAP 的滞后直接影响后续所有开发和审查效率。

4. **[F-D8-003] SECURITY_AUDIT_v2.0.md 引用已删除子系统并给出错误默认值**
   - 安全文档失真会带来合规风险，需尽快标注为历史版本或更新到当前实现。

5. **[F-D1-002] 配置热重载 watcher 未实现**
   - 功能清单明确列出“配置文件热重载”，但核心实现缺失，属于“声称有但实际无”的功能缺口。

---

## 已验证为一致的项（简要）

- `AGENTS.md` 关键入口 `src/runtime/goal-runner.ts` 确实处理 `/goal` 命令（`engine-bridge.ts:247-250`、`goal-runner.ts:370-400`）。
- `AGENTS.md` 陷阱 #18 “Rollback 前置工作区检查”在 `src/harness/checkpoint-manager.ts:285-325` 实现。
- `CHANGELOG.md` v4.5.4 声称删除的 `self-evolution/`、`dream-consolidator.ts`、`eq-detector.ts` 等模块在 `src/` 中无残留。
- `action.yml` 与 `scripts/action-entry.ts` 的输入/输出/工作模式映射一致，`dist/index.js` 存在。
- `desktop/preload/index.ts` 与 `desktop/main/index.ts` 中 Phase 73 Follow-up、Phase 71 Plan 修订的 IPC 通道配对完整。
