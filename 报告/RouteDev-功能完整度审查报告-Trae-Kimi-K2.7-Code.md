# RouteDev 功能完整度审查报告

> **审查项目：** RouteDev（Electron 桌面 AI 编程助手）  
> **审查基线版本：** v4.5.4（Phase 60 发布版 + Phase 61-73 后续迭代）  
> **审查日期：** 2026-07-08  
> **审查执行：** Trae-Kimi-K2.7-Code  
> **审查类型：** 功能完整度审查（非代码质量审查）  
> **审查依据：** [RouteDev-功能完整度审查提示词.md](./RouteDev-功能完整度审查提示词.md) v1.0

---

## 审查总结

本次全量功能完整度审查覆盖 8 个维度、41 项核心发现。RouteDev 桌面端主对话链路与 /goal 执行链路基本完整，IPC 通道双向配对齐全，但存在大量**入口可达性缺口**（孤儿功能无 UI）、**配置项未消费**（僵尸配置）、**文档严重滞后**以及若干**错误路径断裂**问题。最突出的风险集中在：slash 命令入口与实现断链、计划编辑器 Promise 泄漏、配置/文档与实现脱节。

---

## Findings 明细

### 维度 1：设计文档 vs 实现一致性

- id: F-001
  level: Missing
  dimension: 维度1-设计文档一致性 / 维度8-文档完整性
  location:
    file: routedev/CODEMAP.md
    line: 55-96
  title: CODEMAP.md 列出多个已不存在的源文件
  problem: |
    CODEMAP.md 在“src/agent/ — Agent 引擎层”中把 8 个已删除或未创建的源文件描述为当前模块：
    dream-consolidator.ts、requirements-gatherer.ts、complexity-analyzer.ts、
    execution-orchestrator.ts、failure-report.ts、requirements-clarifier.ts、
    src/config/watcher.ts、memory/dream-to-graph.ts。Glob 与 Grep 均确认这些文件在磁盘上不存在。
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
  impact: 新接入的 Agent 会被 CODEMAP 误导到不存在或已退役的模块，降低定位效率并增加维护成本。
  recommendation: |
    1. 从 CODEMAP.md 移除已删除条目，或统一标注“已退役”。
    2. 将 CODEMAP.md 的“最后更新”日期与 Phase 72 后的代码状态同步。
  status: open

- id: F-002
  level: Missing
  dimension: 维度1-设计文档一致性
  location:
    file: routedev/src/config/watcher.ts
    line: 文件不存在
  title: 配置热重载 watcher 未实现
  problem: |
    CODEMAP.md 与核心功能清单 C4 均声称存在 `src/config/watcher.ts` 负责“配置文件热重载”。
    实际该文件不存在，且在 `src/config/`、`desktop/main/config-store.ts`、
    `desktop/main/engine-bridge.ts` 中均未使用 `fs.watch`、`chokidar` 等文件监听机制。
    当前仅能通过 `config:save`/`config:reload` IPC 手动触发重载。
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

### 维度 2：用户场景闭环完整性

- id: F-003
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/config/watcher.ts
    line: 文件不存在
  title: 配置变更闭环缺少文件级热重载
  problem: |
    场景七要求“save → reload → 通知”链路完整。当前 `config:save` 后会同步 `engine.updateConfig(config)`
    并通过 `config:reloaded` 事件通知渲染层；但用户直接修改磁盘上的 config.yaml 后，应用不会自动热重载，
    因为 `src/config/watcher.ts` 不存在。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 296-298
      text: "场景七：配置变更闭环 — ... watcher 检测变更 → 热重载 → 通知渲染层 ConfigReloadNotice"
    code_location:
      file: desktop/main/index.ts
      line: 419-428
      text: "config:save 仅调用 saveConfig + engine?.updateConfig(config)，无文件监听注册"
    search_performed:
      - pattern: "**/config/watcher.ts"
        scope: "routedev/"
        match_count: 0
      - pattern: "chokidar|fs.watch|watchFile"
        scope: "src/config/"
        match_count: 0
  impact: 用户无法通过直接编辑 YAML 文件实现热重载；SettingsPage 外的配置变更需要手动重启或点击“重新加载”。
  recommendation: |
    补全 src/config/watcher.ts，使用 fs.watch 或 chokidar 监听全局/项目配置文件变更；
    变更后调用 loadConfig + engine.reloadConfig + 发送 config:reloaded 事件到渲染层。
  status: open

- id: F-004
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/agent/task-orchestrator.ts
    line: 104-110
  title: TaskOrchestrator 未实际调用 RequirementsClarifier
  problem: |
    场景十一要求需求澄清闭环完整，但 TaskOrchestrator.handle 仅在 shouldSkipRequirements
    返回 false 时返回 pipeline_start，并未调用 RequirementsClarifier 生成追问并收集用户回答。
    `src/requirements-clarifier.ts` 或 `src/agent/requirements-clarifier.ts` 文件在磁盘上均不存在。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 301-302
      text: "场景十一：需求澄清闭环 — TaskOrchestrator 判定需澄清 → RequirementsClarifier 分析模糊度 → 生成追问 → 用户回答 → 继续/降级"
    code_location:
      file: src/agent/task-orchestrator.ts
      line: 104-110
      text: |
        if (this.shouldSkipRequirements(userInput, classification)) {
          this.stage = 'planning';
          return { type: 'pipeline_start', intent, input: userInput };
        }
        return { type: 'pipeline_start', intent, input: userInput };
    search_performed:
      - pattern: "requirements-clarifier"
        scope: "src/"
        match_count: 0
      - pattern: "RequirementsClarifier"
        scope: "src/agent/"
        match_count: 0
  impact: |
    需求澄清功能只有入口判断，没有生成追问和收集回答的实际执行，复杂任务可能在没有充分澄清的情况下直接进入规划/执行。
  recommendation: |
    在 TaskOrchestrator 中接入 RequirementsClarifier：当需要澄清时返回 clarification_needed action，
    由渲染层展示追问并回传答案后再进入 planning；如暂不需要完整实现，应将 autoRequirements 默认关闭并在文档中说明。
  status: open

- id: F-005
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/runtime/goal-runner.ts
    line: 1967-1969
  title: Goal 流程内多 Agent 编排路径已退化
  problem: |
    场景五要求多 Agent 协作闭环完整，但 goal-runner.ts 中 Phase 58 已删除
    executePlanWithMultiAgent，goal 流程内部不再显式 spawn 多个子 Agent 并行执行原始 plan 步骤，
    仅通过 DAG/Compose 路径实现并行。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 294-295
      text: "场景五：多 Agent 协作闭环 — 主 Agent 调用 spawn_agent → 子 Agent 创建 → 子 Agent 执行任务 → 结果回传 Blackboard → 主 Agent 汇总"
    code_location:
      file: src/runtime/goal-runner.ts
      line: 1967-1969
      text: "// Phase 58：executePlanWithMultiAgent（legacy 路径）已删除"
    search_performed:
      - pattern: "executePlanWithMultiAgent"
        scope: "src/"
        match_count: 0
  impact: |
    spawn_agent 工具本身可用，但 /goal 命令不再以“主 Agent spawn 多个子 Agent”的方式编排原始计划，
    多 Agent 协作的入口发生迁移，用户可能无法按预期触发。
  recommendation: |
    在文档中明确说明多 Agent 协作现在由 DAG/Compose 路径承载；如需保留 spawn_agent 主入口，
    应在 goal 流程中增加显式多 Agent 编排分支。
  status: open

- id: F-006
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/agent/loop.ts
    line: 154
  title: Follow-up 队列无持久化与崩溃恢复
  problem: |
    场景十要求检查队列持久化与崩溃恢复。ReActAgentLoop 的 followUpQueue 是纯内存数组，
    进程重启后丢失，无写入磁盘或会话恢复逻辑。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 300-301
      text: "场景十：Follow-up 插话闭环 — ... 检查队列持久化与崩溃恢复"
    code_location:
      file: src/agent/loop.ts
      line: 154
      text: "private followUpQueue: FollowUpMessage[] = [];"
    search_performed:
      - pattern: "followUpQueue"
        scope: "src/agent/loop.ts"
        match_count: 12
      - pattern: "session-state|follow-up.*persist|writeFile.*follow"
        scope: "src/"
        match_count: 0
  impact: 应用崩溃或重启后，用户之前排队的 follow-up 任务全部丢失。
  recommendation: |
    可选：将 follow-up 队列持久化到 .routedev/session-state.json，启动时恢复；
    或在 UI 层提示用户 follow-up 为当前会话级别。
  status: open

### 维度 3：功能入口可达性

- id: F-007
  level: Broken
  dimension: 维度3-功能入口可达性 / 维度6-IPC通道完整性
  location:
    file: desktop/renderer/src/components/chat/InputArea.tsx
    line: 154-158
  title: 命令补全中的 slash 命令未实际触发 command:execute
  problem: |
    InputArea 的命令补全列出 /clear、/status、/mcp、/compact、/help、/skill、/skills 等命令，
    但用户提交后走的是 onSubmit → sendMessage → chat:send → engine.sendChat。engine.sendChat 中
    仅对 /goal 做拦截并调用 executeCommand；其余 slash 命令被当作普通文本发给 LLM，未通过
    command:execute IPC 执行。command:execute 仅在 clearMessages / executeCommand 两个 store action
    中调用，而这两个 action 在渲染层没有任何组件消费。
  evidence:
    claim_source:
      file: desktop/renderer/src/components/chat/InputArea.tsx
      line: 18
      text: "const STATIC_COMMANDS = ['/clear', '/status', '/mcp', '/compact', '/help', '/skill', '/skills', '/goal'];"
    code_location:
      file: desktop/renderer/src/store/useRouteDevStore.ts
      line: 206-240
    search_performed:
      - pattern: "executeCommand\\(|clearMessages\\("
        scope: "desktop/renderer/src/"
        match_count: 0
      - pattern: "window\\.routedev\\.command\\.execute"
        scope: "desktop/renderer/src/"
        match_count: 2
  impact: 用户通过命令补全选择的 /clear、/status 等命令不会执行任何本地功能，而是作为普通聊天内容发给模型。
  recommendation: |
    在 sendMessage 或 InputArea 的 handleSubmit 中识别 slash 命令前缀，将其路由到
    window.routedev.command.execute；同时增加命令执行结果的 UI 展示。
  status: open

- id: F-008
  level: Partial
  dimension: 维度3-功能入口可达性
  location:
    file: desktop/renderer/src/components/chat/InputArea.tsx
    line: 18
  title: /compress 命令未加入命令补全列表
  problem: |
    engine-bridge.ts 的 executeCommand 支持 /compress（与 /compact 同分支处理），但 InputArea 的
    STATIC_COMMANDS 中只包含 /compact，未包含 /compress。用户无法通过命令补全发现该命令。
    即便手动输入，受 F-007 影响也不会执行。
  evidence:
    claim_source:
      file: desktop/main/engine-bridge.ts
      line: 685
      text: "if (cmd === '/compact' || cmd === '/compress') {"
    code_location:
      file: desktop/renderer/src/components/chat/InputArea.tsx
      line: 18
    search_performed:
      - pattern: "/compress"
        scope: "desktop/renderer/src/components/chat/InputArea.tsx"
        match_count: 0
  impact: 用户无法通过 UI 发现 /compress 命令。
  recommendation: 将 '/compress' 加入 STATIC_COMMANDS 和 COMMAND_DESCRIPTIONS。
  status: open

- id: F-009
  level: Orphan
  dimension: 维度3-功能入口可达性 / 维度6-IPC通道完整性
  location:
    file: desktop/renderer/src/components/settings/SettingsMcpTab.tsx
    line: 87-180
  title: MCP 连接/断开/状态查询无 UI 入口
  problem: |
    preload 暴露了 mcp.status / mcp.connect / mcp.disconnect，main 也实现了对应 handler，
    但渲染层没有任何调用点。SettingsMcpTab 仅提供服务器配置开关与插件市场安装，没有“连接”“断开”“刷新状态”按钮。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 46
      text: "status: () => ipcRenderer.invoke('mcp:status'),"
    code_location:
      file: desktop/main/index.ts
      line: 459-514
    search_performed:
      - pattern: "window\\.routedev\\.mcp\\.(status|connect|disconnect)"
        scope: "desktop/renderer/src/"
        match_count: 0
  impact: 用户无法在 GUI 中手动连接/断开 MCP 服务器或查看实时连接状态，与功能清单 D1/D6/D7 声称的能力不符。
  recommendation: 在 SettingsMcpTab 中为每个 MCP 服务器添加状态指示器、连接/断开按钮，并在安装后调用 connect。
  status: open

- id: F-010
  level: Orphan
  dimension: 维度3-功能入口可达性 / 维度6-IPC通道完整性
  location:
    file: desktop/renderer/src/components/settings/SettingsExperimentTab.tsx
    line: 1-82
  title: 实验分支管理无 UI 入口
  problem: |
    preload 暴露了 experiment.list / adopt / discard / getDiff，main 实现了对应 handler，
    但渲染层没有任何调用点。SettingsExperimentTab 仅提供并行实验配置开关，没有实验列表、采纳、丢弃、查看 diff 的界面。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 81-85
      text: "experiment: { list: () => ..., adopt: ..., discard: ..., getDiff: ... }"
    code_location:
      file: desktop/main/index.ts
      line: 704-734
    search_performed:
      - pattern: "window\\.routedev\\.experiment\\.(list|adopt|discard|getDiff)"
        scope: "desktop/renderer/src/"
        match_count: 0
  impact: 用户无法通过 GUI 管理实验分支，与功能清单 G1-G5 声称的能力不符。
  recommendation: 新增实验分支管理页面/Tab，或从 preload 与 main 中移除未使用的实验 IPC 通道。
  status: open

- id: F-011
  level: Orphan
  dimension: 维度3-功能入口可达性 / 维度6-IPC通道完整性
  location:
    file: desktop/renderer/src/pages/ChatPage.tsx
    line: 281-294
  title: Follow-up 队列清空与状态查询无 UI 入口
  problem: |
    preload 暴露了 agent.clearAllQueues 和 agent.getQueueStatus，但渲染层没有调用点。
    ChatPage 的队列浮层只展示了 followUpQueue、removeFollowUp、setFollowUpMode，没有“清空所有队列”按钮，也没有使用 queueStatus。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 108-110
      text: "clearAllQueues: () => ipcRenderer.send('agent:clearAllQueues'),"
    code_location:
      file: desktop/main/index.ts
      line: 818-843
    search_performed:
      - pattern: "window\\.routedev\\.agent\\.(clearAllQueues|getQueueStatus|queueStatus)"
        scope: "desktop/renderer/src/"
        match_count: 0
  impact: 用户无法清空 steering/follow-up 队列或查询队列状态（功能清单 K2/K4 不可达）。
  recommendation: 在 PendingQueue / FollowUpQueue 组件中增加“清空队列”按钮，并在需要时调用 getQueueStatus。
  status: open

- id: F-012
  level: Orphan
  dimension: 维度3-功能入口可达性 / 维度6-IPC通道完整性
  location:
    file: desktop/renderer/src/pages/ChatPage.tsx
    line: 175-178
  title: 文件读取 IPC 无调用点，拖拽文件未实现
  problem: |
    preload 暴露了 fs.read 并注释为“用于渲染进程读取本地文件，如拖拽图片预览等”，但渲染层没有任何调用点。
    ChatPage 的 handleDrop 仅阻止默认行为并关闭拖拽遮罩，没有读取/处理文件内容。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 66
      text: "read: (filePath: string) => ipcRenderer.invoke('fs:read', filePath),"
    code_location:
      file: desktop/renderer/src/pages/ChatPage.tsx
      line: 175-178
    search_performed:
      - pattern: "window\\.routedev\\.fs\\.read|\\.fs\\.read\\(|fs\\.read\\("
        scope: "desktop/renderer/src/"
        match_count: 0
  impact: 拖拽文件到对话窗口不会产生任何效果，fs:read 暴露无实际用途。
  recommendation: 实现拖拽文件处理逻辑（调用 fs.read 读取内容或展示预览），或移除 fs.read 暴露。
  status: open

### 维度 4：错误路径完整性

- id: F-013
  level: Broken
  dimension: 维度4-错误路径完整性
  location:
    file: desktop/main/engine-bridge.ts
    line: 278-284
  title: sendChat provider 不可用时未发送 done 事件
  problem: |
    维度 4.1 要求 LLM 调用失败后用户可见反馈并终止 loading。engine-bridge.sendChat 在 provider
    不可用时发送 error 后直接 return，没有发送 chat:stream 的 done 事件。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 419
      text: "chat:send → chat:stream 事件链是否完整 — send 触发后，main 是否在所有路径（成功/失败/中止）都发送 chat:stream 的 done/error 事件，否则渲染层会永久 loading"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 278-284
      text: |
        if (!client || !client.isReady()) {
          this.options.onStream({ type: 'error', error: `提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。` });
          return;
        }
    search_performed:
      - pattern: "onStream\\(\\{ type: 'done' \\}\\)"
        scope: "desktop/main/engine-bridge.ts"
        match_count: 1
  impact: 渲染层在 provider 不可用时收到 error 后可能永久显示 loading，无法自动退出等待状态。
  recommendation: 在 engine-bridge.ts L284 返回前补发 this.options.onStream({ type: 'done' })。
  status: open

- id: F-014
  level: Broken
  dimension: 维度4-错误路径完整性 / 维度6-IPC通道完整性
  location:
    file: desktop/main/engine-bridge.ts
    line: 240-244
  title: chat:send 在引擎未就绪路径缺少 chat:stream done 事件
  problem: |
    RouteDevEngine.sendChat 在 deps/classifier/modelRouter/tracker/clientManager 为 null 时只发送了 {type: 'error'}，
    没有发送 {type: 'done'}。main/index.ts 的 chat:send handler 仅检查 engine 是否存在，不检查 engine 内部依赖是否初始化完成，
    因此该路径可达。渲染层收到 error 后等待 done 来关闭 isProcessing，缺失 done 会导致 UI 永久 loading。
  evidence:
    claim_source:
      file: desktop/main/engine-bridge.ts
      line: 241-244
      text: |
        if (!this.deps || !this.classifier || !this.modelRouter || !this.tracker || !this.clientManager) {
          this.options.onStream({ type: 'error', error: '引擎未初始化' });
          return;
        }
    code_location:
      file: desktop/main/index.ts
      line: 331-348
    search_performed:
      - pattern: "sendChatStream\\(\\{ type: 'done' \\}\\)"
        scope: "desktop/main/index.ts"
        match_count: 3
  impact: 引擎初始化失败后用户发送消息，界面会卡在“生成中”无法恢复。
  recommendation: 在 engine-bridge.ts 第 244 行 return 前追加 `this.options.onStream({ type: 'done' });`。
  status: open

- id: F-015
  level: Broken
  dimension: 维度4-错误路径完整性
  location:
    file: desktop/main/engine-bridge.ts
    line: 761-781 / 511-517
  title: pendingPlanEditResolvers 存在 Promise 泄漏风险
  problem: |
    维度 4.10 要求检查用户关闭 StepEditor 未响应时是否会导致 Promise 永久挂起。
    engine-bridge.executeGoalCommand 中的 requestPlanEdit 将 resolver 存入
    pendingPlanEditResolvers，只有 resolvePlanEdit 被调用时才删除。若用户关闭 StepEditor
    或渲染进程崩溃，goal-runner 将永久等待。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 362-363
      text: "pendingPlanEditResolvers 泄漏 — 用户关闭 StepEditor 未响应时，pendingPlanEditResolvers Map 中的 Promise 是否会永久挂起 goal-runner"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 778-781
      text: |
        const edited = await new Promise<...>((resolve) => {
          this.pendingPlanEditResolvers.set(requestId, resolve);
          this.options.onPlanEditRequest!(requestId, planSnapshot);
        });
    code_location_2:
      file: desktop/main/engine-bridge.ts
      line: 511-517
      text: |
        resolvePlanEdit(requestId: string, steps: ...) {
          const resolver = this.pendingPlanEditResolvers.get(requestId);
          if (resolver) {
            this.pendingPlanEditResolvers.delete(requestId);
            resolver(steps);
          }
        }
    search_performed:
      - pattern: "pendingPlanEditResolvers"
        scope: "desktop/main/engine-bridge.ts"
        match_count: 6
  impact: 用户关闭计划编辑器后，/goal 流程卡住，后续 /goal 命令也无法执行（goalRunner 被占用）。
  recommendation: |
    为 pendingPlanEditResolvers 添加超时机制（如 5 分钟），超时后 resolve(null) 并删除；
    在窗口关闭或会话重置时清空 Map。
  status: open

- id: F-016
  level: Missing
  dimension: 维度4-错误路径完整性
  location:
    file: src/agent/failure-report.ts
    line: 文件不存在
  title: /goal 失败结构化报告模块缺失
  problem: |
    维度 4.3 要求 /goal 执行中失败时通过 failure-report.ts 生成结构化报告。但 src/agent/failure-report.ts
    在磁盘上不存在，goal-runner.ts 中各失败点仅设置 plan.status = 'failed' 并调用 addSystemMessage
    输出文本错误，无法生成包含失败步骤、原因分类、建议行动、回滚指引的结构化报告。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 355-356
      text: "/goal 执行中失败路径 — GoalParser 失败 / 某步骤执行失败 / GoalVerifier 失败，是否都能通过 failure-report.ts 生成结构化报告"
    code_location:
      file: src/runtime/goal-runner.ts
      line: 1673-1695
      text: "步骤失败仅设置 step.error 和 gateManager.updateGate，无 FailureReporter 调用"
    search_performed:
      - pattern: "failure-report"
        scope: "src/"
        match_count: 0
      - pattern: "FailureReporter|generateFailureReport"
        scope: "src/"
        match_count: 0
  impact: /goal 失败时用户只能看到零散文本错误，无法获得结构化失败报告，不利于复盘和恢复。
  recommendation: |
    实现 src/agent/failure-report.ts，在 executeGoalPlan 的异常/失败出口调用 FailureReporter.generate(plan)，
    并通过 addSystemMessage 或 goal:event 推送给渲染层。
  status: open

- id: F-017
  level: Partial
  dimension: 维度4-错误路径完整性
  location:
    file: src/agent/loop.ts
    line: 1263-1276 / 1501-1517
  title: 工具执行开始后无法被 abort 立即中断
  problem: |
    维度 4.9 要求 abortController 中止路径能正确中止正在执行的 LLM 调用和工具调用。当前 AbortSignal
    只在 LLM stream 迭代中检查，已经开始执行的 shell_exec 等工具不会因为 abort 而立即被 kill。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 361
      text: "abortController 中止路径 — 用户点停止 / abortControllerRef.abort() 后，正在执行的 LLM 调用和工具调用是否都正确中止"
    code_location:
      file: src/agent/loop.ts
      line: 1263-1276
      text: "并行工具执行使用 Promise.allSettled，未传入 AbortSignal"
    code_location_2:
      file: src/agent/loop.ts
      line: 1501-1517
      text: "串行工具执行使用 await this.toolExecutor.executeToolStructured/executeTool(...)，未传入 signal"
    search_performed:
      - pattern: "executeTool\\(.*signal"
        scope: "src/"
        match_count: 0
  impact: |
    用户点击“停止”后，若当前正在执行长时间 shell 命令，UI 虽已停止接收流，但底层命令仍继续运行，可能产生意外副作用。
  recommendation: |
    将 signal 透传到 toolExecutor.executeTool / executeToolStructured，在支持的工具（如 shell_exec）内部
    监听 signal.aborted 并 kill 子进程。
  status: open

- id: F-018
  level: Partial
  dimension: 维度4-错误路径完整性
  location:
    file: 多个可选模块装配/调用点
    line: 详见 evidence
  title: fail-open 安全模块失败用户不可感知
  problem: |
    维度 4.12 要求 Phase 59 安全模块装配失败时用户能感知到安全模块未生效。代码中各可选模块失败时
    普遍仅 logger.warn / console.warn，没有向渲染层发送事件。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 364
      text: "fail-open 守卫的可观测性 — Phase 59 五个安全模块装配失败仅 logger.warn，用户是否能感知到安全模块未生效"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 1136-1139
      text: "createSecurityGateFromConfig catch 仅 console.warn，返回 undefined"
    code_location_2:
      file: src/agent/loop.ts
      line: 600
      text: "Hook execution failed, continuing — 仅 logger.error"
    code_location_3:
      file: src/agent/loop.ts
      line: 1589-1601
      text: "BudgetMonitor alert / check failed — 仅 logger.warn"
    code_location_4:
      file: src/agent/multi/worker-executor.ts
      line: 243-245
      text: "熔断器检查异常 catch { } 空处理"
    search_performed:
      - pattern: "security:module-failed|guard:failed"
        scope: "src/"
        match_count: 0
  impact: 当安全/监控模块未成功装配时，用户和 UI 都不知道保护已失效，可能误以为安全策略生效。
  recommendation: |
    定义统一的 security:module-failed 或 guard:failed 事件，在关键安全模块装配/调用失败时通过 IPC
    推送到渲染层，由设置页或状态栏显示警告。
  status: open

- id: F-019
  level: Partial
  dimension: 维度4-错误路径完整性
  location:
    file: desktop/main/index.ts
    line: 804-837
  title: Follow-up/Steering 单向 IPC 错误未反馈到渲染层
  problem: |
    维度 4.4 要求 IPC handler 的 try-catch 完整。agent:followUp、agent:clearAllQueues、
    agent:setFollowUpMode 等 ipcMain.on 通道在引擎未初始化或参数无效时仅 console.warn，
    没有通知渲染层。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 357-358
      text: "IPC 通道失败路径 — ipcMain.handle 中每个 handler 的 try-catch 是否完整，引擎未初始化时是否返回友好错误而非崩溃"
    code_location:
      file: desktop/main/index.ts
      line: 809-813
      text: "引擎未初始化时仅 console.warn('[agent:followUp] 引擎未初始化，调用被忽略')"
    code_location_2:
      file: desktop/main/index.ts
      line: 827-837
      text: "模式无效时仅 console.warn('[agent:setFollowUpMode] 无效 mode，调用被忽略')"
    search_performed:
      - pattern: "agent:queueStatus.*send|chat:stream.*error.*follow"
        scope: "desktop/main/index.ts"
        match_count: 0
  impact: 用户排队 follow-up 失败时看不到任何提示，可能误以为已入队。
  recommendation: |
    在单向 IPC 处理失败时发送 agent:queueStatus 或 chat:stream error 事件到渲染层，给出明确反馈。
  status: open

### 维度 5：配置项完整性

- id: F-020
  level: Orphan
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 354-369
  title: config.ui.components 7 个组件开关无运行时消费
  problem: |
    schema.ts 定义了 ui.components（branchSwitcher / resumePicker / progressBar / tracePanel /
    disclosureLevel / diffView / configReloadNotice），defaults.ts 也给出默认值，但在 desktop/renderer/src/
    中没有任何 `config.ui.components` 或 `ui.components.xxx` 的读取点。用户在设置页切换这些开关无任何效果。
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 354-369
      text: "components: { branchSwitcher: z.boolean().default(true), ... }"
    code_location:
      file: src/config/defaults.ts
      line: 149-157
    search_performed:
      - pattern: "config\\.ui\\.components|ui\\.components\\."
        scope: "desktop/renderer/src/"
        match_count: 0
  impact: 7 个 UI 组件开关成为僵尸配置，用户无法通过配置控制这些功能显示/隐藏。
  recommendation: 在渲染层接入这些布尔开关，或从 schema 中移除。
  status: open

- id: F-021
  level: Orphan
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 601-611
  title: optimization.clarification 配置未被 RequirementsClarifier 读取
  problem: |
    schema.ts 定义了 optimization.clarification（enabled / threshold / maxQuestions / skipIfConfident），
    但 src/ 与 desktop/ 中没有任何 `config.optimization.clarification` 读取点。需求澄清模块无法通过配置控制。
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 601-611
      text: "clarification: z.object({ enabled: z.boolean().default(true), ... })"
    code_location:
      file: src/config/defaults.ts
      line: 190-196
    search_performed:
      - pattern: "config\\.optimization\\.clarification|optimization\\.clarification"
        scope: "src/"
        match_count: 0
  impact: threshold / maxQuestions / skipIfConfident 等字段无法影响需求澄清行为。
  recommendation: 将 ClarificationConfig 注入 RequirementsClarifier（或实现该模块），或删除该配置段。
  status: open

- id: F-022
  level: Partial
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 529-542
  title: optimization.workflow 部分字段未消费
  problem: |
    optimization.workflow 定义了 unifiedPipeline / autoRequirements / reviewOnComplete / reviewMode /
    reviewModel / reviewStrictness。其中 autoRequirements、reviewOnComplete、reviewMode 有消费点，
    但 unifiedPipeline、reviewModel、reviewStrictness 在 src/ 与 desktop/ 中无读取点。
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 529-542
      text: "workflow: z.object({ unifiedPipeline: z.boolean().default(true), ... })"
    code_location:
      file: src/agent/task-orchestrator.ts
      line: 159
    search_performed:
      - pattern: "config\\.optimization\\.workflow\\.unifiedPipeline|unifiedPipeline"
        scope: "src/"
        match_count: 0
      - pattern: "reviewModel|reviewStrictness"
        scope: "src/"
        match_count: 0
  impact: 统一流水线/审查模型/严格度配置失效。
  recommendation: 在 TaskOrchestrator / UnifiedReviewer 中读取，或删除字段。
  status: open

- id: F-023
  level: Orphan
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 259
  title: security.directoryBoundary 未实施
  problem: |
    schema.ts 定义了 security.directoryBoundary（目录边界限制），但除 schema/defaults 外无任何读取点。
    SecurityChecker / PermissionEngine 中未实现对应检查。
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 259
      text: "directoryBoundary: z.boolean().default(true), // 目录边界限制"
    code_location:
      file: src/config/defaults.ts
      line: 63
    search_performed:
      - pattern: "directoryBoundary"
        scope: "src/"
        match_count: 2
  impact: “目录边界限制”安全策略未生效。
  recommendation: 在 SecurityChecker / permission-engine 中实现，或移除字段。
  status: open

- id: F-024
  level: Orphan
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 180-198
  title: channels 配置无运行时消费方
  problem: |
    schema.ts 定义了 channels（wechat-work / telegram / slack webhook 配置），但 src/ 中除 config/loader.ts
    解析配置外没有任何运行时 consumer。`src/channels/` 子系统已不存在。
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 180-198
      text: "entries: z.array(ChannelEntrySchema).default([]), port: z.number().positive().int().default(9800)"
    code_location:
      file: src/config/loader.ts
      line: 1-200
    search_performed:
      - pattern: "config\\.channels|channels\\.entries|channels\\.port"
        scope: "src/"
        match_count: 2
  impact: wechat-work / telegram / slack 渠道集成只有 UI 设置，没有 webhook 服务端/客户端实现。
  recommendation: 实现渠道运行时或从 schema 删除。
  status: open

- id: F-025
  level: Orphan
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 484
  title: mcp.lifecyclePolicy 全局默认值未传递
  problem: |
    schema.ts 定义了 mcp.lifecyclePolicy（per-call / per-session / persistent），defaults.ts 默认 per-session，
    但 app-init.ts 未将该值传给 ClaudeMCPBridge / MCPClientManager，代码中无 `config.mcp.lifecyclePolicy` 读取点。
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 484
      text: "lifecyclePolicy: z.enum(['per-call', 'per-session', 'persistent']).default('per-session')"
    code_location:
      file: src/config/defaults.ts
      line: 126
    search_performed:
      - pattern: "config\\.mcp\\.lifecyclePolicy|lifecyclePolicy"
        scope: "src/"
        match_count: 0
  impact: 全局默认生命周期策略不生效，各 MCP server 配置必须自行声明生命周期。
  recommendation: 在创建 ClaudeMCPBridge 时传入 defaultLifecycle，或删除全局字段。
  status: open

- id: F-026
  level: Orphan
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 340-345 / 407-408 / 493-495 / 1945 / 1950
  title: 多个配置段仅设置页编辑、无运行时效
  problem: |
    sounds / updates / prompts / persona / voice 等配置段在 SettingsPage 中通过 draft.xxx 编辑，
    但在 src/ 或 desktop/main 中没有对应 `config.xxx` 的运行时消费点：
    - sounds：无提示音播放实现
    - updates：desktop/main/updater.ts 不读取配置
    - prompts：PromptTemplateManager 未读取
    - persona：PersonaEngine 未实例化
    - voice：无 STT/TTS 实现
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 340-345
      text: "sounds: z.object({ enabled: z.boolean().default(true), ... })"
    code_location:
      file: desktop/renderer/src/components/settings/SettingsGeneralTab.tsx
      line: 1-300
    search_performed:
      - pattern: "config\\.sounds|sounds\\.enabled|config\\.updates|config\\.prompts|config\\.persona|config\\.voice"
        scope: "src/"
        match_count: 0
  impact: 用户在设置页修改这些选项后，应用行为不会发生变化。
  recommendation: 实现对应运行时消费点，或从 schema 与设置页中移除这些未生效的选项。
  status: open

- id: F-027
  level: Orphan
  dimension: 维度5-配置项完整性
  location:
    file: src/config/schema.ts
    line: 692-710 / 322 / 541 / 557 / 532 / 1932 / 1888 / 1904
  title: 多个配置段完全无消费方
  problem: |
    以下配置段在 schema.ts 中定义，但在 src/ 与 desktop/ 中无任何运行时读取点：
    - knowledgeGraph：ContextManager 内部使用硬编码路径
    - market：无 SkillMarket 之外的市场实现
    - errorDisplay / modelDisplay / configLayering：无消费点
    - reasoningMode：router.ts 注释明确说明未接入后端
    - llmProviders：便捷配置未实现
    - scheduler：可选调度器未实现
  evidence:
    claim_source:
      file: src/config/schema.ts
      line: 692-710
      text: "knowledgeGraph: z.object({ persistence: ..., autoForget: ..., recall: ... })"
    code_location:
      file: src/config/defaults.ts
      line: 215-228
    search_performed:
      - pattern: "config\\.knowledgeGraph|config\\.market|config\\.errorDisplay|config\\.modelDisplay|config\\.configLayering|config\\.reasoningMode|config\\.llmProviders|config\\.scheduler"
        scope: "src/"
        match_count: 0
  impact: schema 持续膨胀，用户看到的配置项与实际能力不匹配。
  recommendation: 统一清理无消费方的配置段，或补全实现并在文档中说明。
  status: open

### 维度 6：IPC 通道完整性

- id: F-028
  level: Complete
  dimension: 维度6-IPC通道完整性
  location:
    file: desktop/preload/index.ts / desktop/main/index.ts
    line: 1-140
  title: 50 条 Renderer → Main 通道与 7 条 Main → Renderer 通道双向配对完整
  problem: |
    未发现“后端实现但前端未暴露”的 orphan backend 通道；50 条 R→M 通道与 7 条 M→R 通道均已完成双向配对。
    listenerMap on/off 解绑实现正确，无内存泄漏风险。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 1-140
      text: "ipcRenderer.send/invoke 暴露 50 条通道"
    code_location:
      file: desktop/main/index.ts
      line: 331-857
      text: "ipcMain.on/handle 注册 50 条 handler，webContents.send 发送 7 条事件"
    search_performed:
      - pattern: "ipcMain\\.(on|handle)\\(['\"]"
        scope: "desktop/main/index.ts"
        match_count: 50
      - pattern: "ipcRenderer\\.(send|invoke)\\(['\"]"
        scope: "desktop/preload/index.ts"
        match_count: 50
  impact: 无 — IPC 暴露面与实现面一致。
  recommendation: 无需修复。
  status: open

> 注：维度 3 中 F-009 至 F-012 已覆盖“通道已配对但渲染层无调用点”的孤儿入口问题，此处不再重复计数。

### 维度 7：测试覆盖完整性

- id: F-029
  level: Partial
  dimension: 维度7-测试覆盖完整性
  location:
    file: tests/integration/ipc-bridge.test.ts
    line: 1-200
  title: IPC handler 测试覆盖不全
  problem: |
    tests/integration/ipc-bridge.test.ts 仅覆盖 Experiment / Hook 等少量通道，共约 15 个用例。
    chat:*、config:*、mcp:*、skill:*、checkpoint:*、plan:*、agent:followUp 等大量 IPC 通道无测试。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 440
      text: "7.1 每个 IPC handler 是否有测试（tests/integration/ipc-bridge.test.ts 是否覆盖全部 IPC 通道）"
    code_location:
      file: tests/integration/ipc-bridge.test.ts
      line: 1-200
    search_performed:
      - pattern: "chat:send|config:save|mcp:connect|skill:list|checkpoint:list|plan:edit-response|agent:followUp"
        scope: "tests/integration/ipc-bridge.test.ts"
        match_count: 0
  impact: IPC 通道新增/变更时容易引入回归，且主进程异常路径无法被自动验证。
  recommendation: 扩展 ipc-bridge.test.ts，覆盖全部 invoke/on 通道的正常路径与错误路径。
  status: open

- id: F-030
  level: Missing
  dimension: 维度7-测试覆盖完整性
  location:
    file: desktop/main/engine-bridge.ts
    line: 662-714
  title: engine-bridge slash 命令无测试
  problem: |
    executeCommand 处理 /clear /status /mcp /compact /skill /help /goal 等命令，但 tests/ 下无专门测试文件，
    rtk grep 未命中 slash 命令测试。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 441
      text: "7.2 engine-bridge 的每个 slash 命令是否有测试"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 662-714
    search_performed:
      - pattern: "executeCommand|/clear|/status|/mcp|/compact|/skill|/help|/goal"
        scope: "tests/"
        match_count: 0
  impact: slash 命令行为（含 F-007 发现的断链）无法被自动化测试捕获。
  recommendation: 新增 tests/desktop/engine-bridge-slash.test.ts，覆盖每个命令的输入输出与副作用。
  status: open

- id: F-031
  level: Missing
  dimension: 维度7-测试覆盖完整性
  location:
    file: desktop/main/engine-bridge.ts / src/runtime/goal-runner.ts
    line: 258 / 511-517
  title: Plan 修订历史与遗漏点检查无测试
  problem: |
    Phase 71 的 plan:get-revisions、plan:check- omissions 及 savePlanRevision 在 tests/ 中找不到对应用例。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 446
      text: "7.7 Phase 71 plan:get-revisions / plan:check-omissions 是否有测试"
    code_location:
      file: src/runtime/goal-runner.ts
      line: 258
      text: "function savePlanRevision(...)"
    search_performed:
      - pattern: "get-revisions|check-omissions|getRevisions|checkOmissions|revisionHistory"
        scope: "tests/"
        match_count: 0
  impact: 计划修订历史功能变更时无回归保护。
  recommendation: 新增 tests/integration/plan-revisions.test.ts 或 tests/agent/plan-diff.test.ts。
  status: open

- id: F-032
  level: Missing
  dimension: 维度7-测试覆盖完整性
  location:
    file: src/runtime/goal-runner.ts
    line: 796-877
  title: 迭代闭环 maxRounds 边界无测试
  problem: |
    config.goalVerifier.iterative.maxRounds 控制验证失败后的最大补救轮数，但 tests/ 中无针对 maxRounds 边界、
    iterative.enabled 开关的测试。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 448
      text: "7.9 迭代闭环（maxRounds 边界）是否有测试"
    code_location:
      file: src/runtime/goal-runner.ts
      line: 796-877
      text: "legacyIterativeLoop"
    search_performed:
      - pattern: "maxRounds|iterative"
        scope: "tests/integration/goal-flow.test.ts"
        match_count: 0
  impact: 迭代闭环边界行为变更时无回归保护。
  recommendation: 在 tests/integration/goal-flow.test.ts 中补充 iterative 开关与 maxRounds 边界用例。
  status: open

- id: F-033
  level: Missing
  dimension: 维度7-测试覆盖完整性
  location:
    file: src/config/watcher.ts
    line: 文件不存在
  title: 配置热重载无测试
  problem: |
    审查提示词要求测试配置热重载，但 src/config/watcher.ts 不存在，tests/config/ 下只有 loader.test.ts、
    schema.test.ts 等，无 watcher / hot-reload 测试。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 451
      text: "7.12 配置热重载是否有测试（tests/config/ 下 watcher 测试）"
    code_location:
      file: tests/config/
      line: 1-100
    search_performed:
      - pattern: "watcher|hot.?reload|config.*reload"
        scope: "tests/config/"
        match_count: 0
  impact: 配置热重载功能缺失，相关测试也无从谈起。
  recommendation: 先实现 watcher.ts，再补充 tests/config/watcher.test.ts。
  status: open

- id: F-034
  level: Partial
  dimension: 维度7-测试覆盖完整性
  location:
    file: tests/mcp/claude-bridge.test.ts / tests/tools/mcp.test.ts
    line: 1-300
  title: MCP 五种传输协议连接测试不完整
  problem: |
    claude-bridge 测试覆盖 5 种传输的**配置解析**；tools/mcp.test.ts 以 stdio 为主，http 仅有少量用例，
    sse / streamable_http / websocket 无真实连接测试。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 443
      text: "7.5 五种 MCP 传输协议是否有测试（stdio / http / sse / streamable_http / websocket）"
    code_location:
      file: tests/tools/mcp.test.ts
      line: 1-300
    search_performed:
      - pattern: "streamable_http|websocket|sse"
        scope: "tests/tools/mcp.test.ts"
        match_count: 0
  impact: MCP 非 stdio 传输的连接/断开/错误路径缺乏回归保护。
  recommendation: 为 http/sse/streamable_http/websocket 增加传输层 mock 或集成测试。
  status: open

- id: F-035
  level: Partial
  dimension: 维度7-测试覆盖完整性
  location:
    file: tests/tools/config-guard.test.ts / tests/skills/security-gate.test.ts
    line: 1-200
  title: fail-open 守卫集成路径无统一测试
  problem: |
    单模块 fail-open 有测试，但 app-init.ts 中 5 个安全模块（mcpSecurityScan / auditChain / configGuard /
    skillSecurityGate / policyEngine）装配失败时不阻塞主流程的集成路径无统一测试。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 449
      text: "7.10 fail-open 守卫是否有测试（五个安全模块装配失败时不阻塞主流程）"
    code_location:
      file: src/runtime/app-init.ts
      line: 497-2219
    search_performed:
      - pattern: "fail.?open|security.*gate|module.*fail"
        scope: "tests/runtime/"
        match_count: 0
  impact: 安全模块装配失败后的降级行为无法被自动化验证。
  recommendation: 新增 tests/runtime/app-init-failopen.test.ts，模拟各模块装配失败并断言主流程继续。
  status: open

### 维度 8：文档完整性

- id: F-036
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: docs/CONFIGURATION.md
    line: 1-227
  title: CONFIGURATION.md 严重滞后且包含已删除字段
  problem: |
    CONFIGURATION.md 标题声称“列出 RouteDev 所有配置项”，但正文仅详细描述了 Phase 50 接入开关，
    缺少 general、providers、router、checkpoint、goalVerifier、security、autonomy、sounds、updates、
    mcp、channels、webSearch、knowledgeGraph、codeMap、market、policies、subAgents、goal、memory、
    discovery、trust、quality、expertise、vision、voice、phase53Integration、phase52Integration 等
    大量 schema 分组的说明。更严重的是，文档仍保留了 Phase 59 已删除的字段：
    goalIntegration.promptBuilderEnabled、goalIntegration.requirementChangeEnabled、
    phase49Integration.routingFunnelEnabled。
  evidence:
    claim_source:
      file: docs/CONFIGURATION.md
      line: 3
      text: "本文档列出 RouteDev 所有配置项，按模块分组。"
    code_location:
      file: src/config/schema.ts
      line: 8-1883
      text: "AppConfigSchema 包含 40+ 个配置分组"
    search_performed:
      - pattern: "promptBuilderEnabled|requirementChangeEnabled|routingFunnelEnabled"
        scope: "src/config/schema.ts"
        match_count: 0
  impact: 用户无法通过官方文档正确理解可用配置；复制“全功能配置示例”会因包含已删字段而失真。
  recommendation: |
    1. 删除 CONFIGURATION.md 中所有已删除字段。
    2. 按 schema.ts 当前分组补齐通用配置、路由、安全、MCP、子 Agent、Goal、Phase 53 等章节。
  status: open

- id: F-037
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: docs/SECURITY_AUDIT_v2.0.md
    line: 46-91
  title: SECURITY_AUDIT_v2.0.md 引用已删除子系统并给出错误默认值
  problem: |
    安全审计报告 v2.0 仍把 src/channels/adapters/wechat-work.ts 和 src/channels/server.ts 作为证据引用，
    但 src/channels/ 整个子系统已不存在。此外，报告声称 networkConfirm 默认启用，
    而当前 schema.ts 中 networkConfirm 默认值为 false。
  evidence:
    claim_source:
      file: docs/SECURITY_AUDIT_v2.0.md
      line: 67
      text: "src/channels/server.ts — WebhookServer 模块完整"
    code_location:
      file: src/config/schema.ts
      line: 270
      text: "networkConfirm: z.boolean().default(false)"
    search_performed:
      - pattern: "src/channels/"
        scope: "routedev/src/"
        match_count: 0
      - pattern: "networkConfirm.*default\\(false\\)"
        scope: "src/config/schema.ts"
        match_count: 1
  impact: 历史审计文档与当前安全实现不一致，可能误导合规检查或安全评审。
  recommendation: 更新 SECURITY_AUDIT_v2.0.md：移除 channels 证据、修正 networkConfirm 默认值，或标注为“历史版本 v2.0”并补充当前版本审计。
  status: open

- id: F-038
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: docs/PLUGIN_GUIDE.md
    line: 151-172
  title: PLUGIN_GUIDE.md 描述的 /plugin 命令未实现
  problem: |
    PLUGIN_GUIDE.md 第 7 节说明通过 /plugin list、/plugin enable、/plugin disable、/plugin reload 管理插件，
    但在 desktop/main/engine-bridge.ts 的 executeCommand、desktop/main/index.ts IPC 以及 SettingsPage 中
    均未发现 /plugin 命令或插件管理 UI。当前插件系统仅用于内部中间件管线注册。
  evidence:
    claim_source:
      file: docs/PLUGIN_GUIDE.md
      line: 162
      text: "使用 `/plugin` 命令管理插件：/plugin list / /plugin enable <name> / /plugin disable <name> / /plugin reload"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 662-714
      text: "executeCommand 仅处理 /goal /clear /status /mcp /compact /skill /help，无 /plugin 分支"
    search_performed:
      - pattern: "plugin list|plugin enable|plugin disable|/plugin\\b"
        scope: "routedev/desktop/"
        match_count: 0
  impact: 插件开发指南描述的终端命令无法使用，外部开发者无法按文档完成插件生命周期管理。
  recommendation: 在 desktop 端补充 /plugin 命令分发与插件管理 UI，或从 PLUGIN_GUIDE.md 删除相关命令描述。
  status: open

- id: F-039
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: docs/ARCHITECTURE.md
    line: 52-54 / 114
  title: ARCHITECTURE.md MCP 传输协议与内置工具列表过时
  problem: |
    ARCHITECTURE.md 2.3 节列出内置工具为 file_read / file_write / shell_exec / code_search / file_search / git_op / web_search / notes，
    遗漏了 spawn_agent、ask_user、list_directory、web_fetch、todo_write 等当前实际注册的工具。
    第 114 行又称 MCP 仅支持 stdio 和 SSE，而 schema.ts 已支持 stdio / http / sse / streamable_http / websocket 五种传输协议。
  evidence:
    claim_source:
      file: docs/ARCHITECTURE.md
      line: 114
      text: "通过 MCP 协议接入外部工具服务器，支持 stdio 和 SSE 两种传输方式。"
    code_location:
      file: src/config/schema.ts
      line: 427-464
      text: "MCPServerConfigSchema 使用 discriminatedUnion 定义 stdio / http / sse / streamable_http / websocket"
    search_performed:
      - pattern: "spawn_agent|ask_user|list_directory|web_fetch|todo_write"
        scope: "routedev/src/runtime/app-init.ts"
        match_count: 5
  impact: 架构文档未能准确反映当前工具集与 MCP 能力，造成设计与实现认知偏差。
  recommendation: 同步 ARCHITECTURE.md 的内置工具列表与 MCP 传输协议说明至 schema.ts 与 app-init.ts 现状。
  status: open

- id: F-040
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: README.md
    line: 38-49 / 58-63
  title: README.md 仍描述已退役的 Phase 31 流水线与 /plan 命令
  problem: |
    README.md“架构概览”把 TaskOrchestrator 作为所有非命令输入的调度中心，并依次画出
    RequirementsGatherer、TaskComplexityAnalyzer、ExecutionOrchestrator 等阶段。
    这些源文件已不存在，且 engine-bridge.executeCommand 未实现 /plan 命令，
    当前 desktop 端实际由 sendChat/executeCommand 直接处理输入与 /goal。
  evidence:
    claim_source:
      file: README.md
      line: 44
      text: "ExecutionOrchestrator（单/多 Agent 自适应）"
    code_location:
      file: desktop/main/engine-bridge.ts
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

- id: F-041
  level: Partial
  dimension: 维度8-文档完整性
  location:
    file: desktop/preload/index.ts
    line: 99-112
  title: Phase 71 Plan 修订历史 / Phase 73 Follow-up 队列功能无文档
  problem: |
    preload 已暴露 plan:get-revisions、plan:check-omissions、agent:followUp、agent:clearAllQueues、
    agent:setFollowUpMode、agent:queueStatus、agent:getFollowUpQueue、agent:removeFollowUp 等 IPC API，
    且 engine-bridge/main 已实现对应逻辑。但在 docs/、README.md、CHANGELOG.md（v4.5.4 未提及 Phase 71/73 功能）
    中均未找到相关说明。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 106
      text: "// Phase 73 Part C：Steering / Follow-up 双消息队列 API"
    code_location:
      file: desktop/main/index.ts
      line: 800-857
      text: "ipcMain.on('agent:followUp', ...); ipcMain.handle('plan:get-revisions', ...)"
    search_performed:
      - pattern: "followUp|getRevisions|checkOmissions|plan-revisions"
        scope: "routedev/docs/"
        match_count: 0
  impact: 已实现的功能缺少用户文档，导致用户不知如何触发计划修订历史、遗漏点检查与 Follow-up 插话。
  recommendation: 补充 docs/PHASE71_PLAN_REVISION.md、docs/PHASE73_FOLLOWUP.md，或在 README 中新增对应章节。
  status: open

---

## 审查汇总

### 按级别统计

| 级别 | 数量 |
|------|------|
| Complete | 1 |
| Partial | 18 |
| Missing | 7 |
| Broken | 4 |
| Orphan | 11 |
| **合计** | **41** |

### 按维度统计

| 维度 | Complete | Partial | Missing | Broken | Orphan |
|------|----------|---------|---------|--------|--------|
| 1. 设计文档一致性 | 0 | 0 | 2 | 0 | 0 |
| 2. 用户场景闭环 | 0 | 4 | 0 | 0 | 0 |
| 3. 功能入口可达性 | 0 | 1 | 0 | 1 | 4 |
| 4. 错误路径完整性 | 0 | 3 | 1 | 3 | 0 |
| 5. 配置项完整性 | 0 | 1 | 0 | 0 | 7 |
| 6. IPC 通道完整性 | 1 | 0 | 0 | 0 | 0 |
| 7. 测试覆盖完整性 | 0 | 3 | 4 | 0 | 0 |
| 8. 文档完整性 | 0 | 6 | 0 | 0 | 0 |

> 注：
> - F-001 同时影响维度 1 与维度 8；F-007 同时影响维度 3 与维度 6；F-014 同时影响维度 4 与维度 6。
> - 维度 6 中除 F-028 为 Complete 外，其余孤儿入口问题已在维度 3 中统计（F-009 至 F-012），避免重复计数。
> - 部分 finding 同时属于多个维度时，在“按维度统计”中只计入最核心维度，因此总数与按级别统计一致。

---

## Top 5 高优先级问题

1. **[F-007] slash 命令补全不执行（Broken / 维度3）**
   - 命令补全列出 /clear /status /mcp /compact 等命令，但提交后仅作为普通文本发给 LLM，未调用 command:execute。用户可见入口与实现断链，直接影响核心交互体验。

2. **[F-015] pendingPlanEditResolvers 存在 Promise 泄漏风险（Broken / 维度4）**
   - 用户关闭 StepEditor 或渲染进程崩溃后，/goal 流程中的 Promise 永久挂起，goalRunner 被占用，后续 /goal 命令无法执行。属于核心目标执行路径的卡死风险。

3. **[F-036] CONFIGURATION.md 严重滞后且包含已删除字段（Partial / 维度8）**
   - 官方配置文档缺失绝大多数 schema 分组说明，同时保留已删除字段，最容易导致用户配置错误，且是项目门面对外文档。

4. **[F-013] sendChat provider 不可用时未发送 done 事件（Broken / 维度4）**
   - 基础对话路径的错误处理断裂，provider 不可用时渲染层可能永久 loading，体验崩坏。

5. **[F-001] CODEMAP.md 列出多个已不存在的源文件（Missing / 维度1+8）**
   - 作为“搜索代码前先读”的项目入口索引，CODEMAP 与真实代码库严重脱节，会系统性误导后续开发与审查。

---

## 审查者自检声明

- [x] 已读取审查提示词及全部 10 个必读前置文件，建立功能基线。
- [x] 已按 8 个维度逐项判定，未跳过检查项。
- [x] 每条 finding 均附带了代码/文档位置与搜索证据。
- [x] 未将已知排除项（CLI 残留、已退役功能、默认关闭的实验性功能）误报为问题。
- [x] 未将代码质量/风格/性能问题混入本审查。
- [x] 已按级别和维度给出统计表。
- [x] 已列出 Top 5 高优先级问题并说明优先级理由。

---

*本报告由 Trae-Kimi-K2.7-Code 生成，依据 RouteDev-功能完整度审查提示词.md v1.0 执行全量功能审查。*
