# RouteDev 功能完整度审查提示词

> **版本：** v1.1（2026-07-10）
> **适用项目：** RouteDev（Electron 桌面 AI 编程助手）
> **审查类型：** 功能完整度审查（非代码质量审查）
> **审查基线代码版本：** v4.5.4（Phase 60 发布版 + Phase 61-77 后续迭代）

---

## 审查目标

本次审查聚焦于 **"功能是否完整"**，而非代码质量。具体回答以下五个核心问题：

1. **声称已实现的功能是否真的都有完整实现？**（防止"文档撒谎"）
2. **每个核心用户场景是否能从头到尾走通？**（防止"半成品断链"）
3. **已实现的代码功能是否都有 UI/命令入口可达？**（防止"孤儿功能"）
4. **配置项、IPC 通道、Schema 字段是否都有消费方？**（防止"僵尸配置/僵尸通道"）
5. **文档（AGENTS.md / CHANGELOG.md / CODEMAP.md / docs/）描述的功能是否与代码一致？**（防止"文档漂移"）

### 与现有审查的区别

| 审查类型 | 关注点 | 不关注 |
|---------|--------|--------|
| 全量审查提示词 | 类型安全/架构/性能/安全等代码质量 | 功能是否完整 |
| 死代码审查提示词 | 未使用的代码 | 功能入口可达性 |
| **本审查（功能完整度）** | **功能完整性/场景闭环/入口可达/配置消费** | **代码写得好不好** |

### 本次审查不评判的内容

- 代码风格、命名、注释质量（归全量审查）
- 性能瓶颈、内存泄漏（归全量审查）
- 类型安全 strict 程度（归全量审查）
- 是否有更优雅的实现方式（归全量审查）
- 死代码清理（归死代码审查）

---

## 审查前置准备

审查者开始前**必须**先读取以下文件，建立"应该有什么"的基线认知：

### 必读文件（建立功能全貌）

| 顺序 | 文件 | 用途 |
|-----|------|------|
| 1 | `AGENTS.md` | 技术栈 + 关键入口 + Top 10 核心陷阱 + 已退役功能 |
| 2 | `CODEMAP.md` | 代码库索引，了解所有模块职责 |
| 3 | `CHANGELOG.md`（v4.5.4 / v4.5.3 / v4.0.2 / v4.0.1 / v4.0.0 / v3.9.0 / v3.0.0 七个版本） | 功能变更历史，识别"声称已加/已删"的功能 |
| 4 | `desktop/preload/index.ts` | IPC 暴露面（前端能调什么） |
| 5 | `desktop/main/index.ts` | IPC 实现面（后端实现什么） |
| 6 | `desktop/main/engine-bridge.ts` | 引擎桥接，slash 命令分发 |
| 7 | `src/config/schema.ts`（全文） | 所有配置项定义 |
| 8 | `src/config/defaults.ts` | 默认值（识别 `*Integration.enabled: false` 幽灵功能） |
| 9 | `desktop/renderer/src/pages/SettingsPage.tsx` | UI 设置页入口 |
| 10 | `desktop/renderer/src/pages/ChatPage.tsx` | 对话页（主交互入口） |

### 参考文件（按需查阅）

- `docs/ARCHITECTURE.md` — 架构总览
- `docs/DEAD_CODE_AUDIT.md` — 已清理的死代码记录
- `docs/CONFIGURATION.md` — 配置说明
- `.routedev/skills/pitfalls-guide/SKILL.md` — 84 条陷阱（按 Phase 分章）
- `package.json` — 依赖与脚本
- `action.yml` + `.github/workflows/routedev-example.yml` — GitHub Action 集成

### 建立审查基线

读完上述文件后，审查者应在脑中/笔记中列出：
- **RouteDev 声称拥有的全部功能清单**（从 CHANGELOG / AGENTS / CODEMAP 提取）
- **preload 暴露的全部 IPC API 清单**（从 preload/index.ts 提取）
- **schema.ts 定义的全部配置字段清单**（从 schema.ts 提取）
- **GUI 设置页提供的全部 Tab 入口清单**（从 SettingsPage 提取）
- **engine-bridge 支持的全部 slash 命令清单**（从 executeCommand 提取）

---

## RouteDev 核心功能清单（审查基线）

> 以下清单从 CODEMAP / CHANGELOG / preload / schema 提取，作为"应该有什么"的基线。
> 审查时逐项核对实现完整性。

### A. 对话与交互核心

| 编号 | 功能 | 入口 | 关键实现 |
|-----|------|------|---------|
| A1 | 普通对话（含流式输出） | ChatPage 输入框 | `engine-bridge.sendChat` |
| A2 | /goal 命令（目标分解+执行+验证+迭代闭环） | `/goal` slash 命令 | `goal-runner.handleGoalCommand` |
| A3 | 工具调用与确认 | Agent Loop 自动触发 | `chat:confirm-tool` IPC |
| A4 | 停止生成 | ChatPage 停止按钮 | `chat:stop` IPC |
| A5 | 对话历史持久化与同步 | 自动 | `chat:sync-history` IPC |
| A6 | 自动生成对话标题 | 首条消息后 | `chat:generate-title` IPC |
| A7 | 上下文压缩 | `/compact` `/compress` | `ContextManager.compress` |
| A8 | 项目工作目录切换 | 设置页/文件夹选择 | `project:set-cwd` IPC |

### B. Slash 命令（GUI 支持）

`/clear` `/status` `/mcp` `/compact` `/compress` `/skill` `/skills` `/help` `/goal`

### C. 配置管理

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| C1 | 读取配置 | `config:get` |
| C2 | 保存配置 | `config:save` |
| C3 | 重新加载配置 | `config:reload` |
| C4 | 配置热重载（文件变更） | `src/config/watcher.ts` |
| C5 | Zod Schema 校验 | `src/config/schema.ts` |
| C6 | 环境变量替换（fail-fast） | `replaceEnvVars` |
| C7 | 设置页 12 个 Tab | `SettingsPage.tsx` |

### D. MCP 生态

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| D1 | MCP 状态查询 | `mcp:status` |
| D2 | MCP 工具列表 | `mcp:tools` |
| D3 | MCP 目录浏览 | `mcp:catalog:list` |
| D4 | MCP 目录搜索 | `mcp:catalog:search` |
| D5 | MCP 安装 | `mcp:install` |
| D6 | MCP 连接 | `mcp:connect` |
| D7 | MCP 断开 | `mcp:disconnect` |
| D8 | 5 种传输协议 | stdio/http/sse/streamable_http/websocket |
| D9 | 3 种生命周期 | per-call/per-session/persistent |
| D10 | Claude .mcp.json 桥接 | `ClaudeMCPBridge` |

### E. Skill 系统

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| E1 | Skill 列表 | `skill:list` |
| E2 | Skill 预览 | `skill:preview` |
| E3 | Skill 启用/禁用 | `skill:toggle` |
| E4 | Skill 创建 | `skill:create` |
| E5 | Skill 删除 | `skill:delete` |
| E6 | Skill 重新加载 | `skill:reload` |
| E7 | Skill 路由（按任务匹配） | `skill:route` |
| E8 | 三级优先级（项目>用户>内置） | `PromptManager` |
| E9 | Skill 安全校验 | `phase53Integration.skillSecurityGate` |

### F. 文件系统

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| F1 | 读取文件 | `fs:read` |
| F2 | 选择文件夹 | `fs:select-folder` |
| F3 | 在资源管理器中打开 | `fs:open-folder` |

### G. 实验分支管理（Phase 37/39）

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| G1 | 实验列表 | `experiment:list` |
| G2 | 采纳实验 | `experiment:adopt` |
| G3 | 丢弃实验 | `experiment:discard` |
| G4 | 查看 diff | `experiment:get-diff` |
| G5 | Git Worktree 后端 | `ExperimentManager` |

### H. Hook 管理（Phase 39）

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| H1 | Hook 列表 | `hook:list` |
| H2 | Hook 启用/禁用 | `hook:toggle` |
| H3 | Hook 创建 | `hook:create` |
| H4 | Hook 删除 | `hook:delete` |
| H5 | 内置钩子（文件变更验证/会话日志） | `src/hooks/built-in.ts` |

### I. Checkpoint 时间轴（Phase 47 Task 6）

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| I1 | Checkpoint 列表 | `checkpoint:list` |
| I2 | Checkpoint 回滚 | `checkpoint:rollback` |
| I3 | 时间轴 UI 组件 | `CheckpointTimeline.tsx` |
| I4 | 工作区干净检查 | `CheckpointManager.rollback` |

### J. 计划编辑（Phase 54/71）

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| J1 | 计划编辑响应 | `plan:edit-response` |
| J2 | 计划修订历史 | `plan:get-revisions` |
| J3 | 遗漏点检查 | `plan:check-omissions` |
| J4 | StepEditor UI | 渲染层组件 |

### K. Steering / Follow-up（Phase 73 Part C）

| 编号 | 功能 | IPC 通道 |
|-----|------|---------|
| K1 | 发送 Follow-up | `agent:followUp` |
| K2 | 清空所有队列 | `agent:clearAllQueues` |
| K3 | 设置 Follow-up 模式 | `agent:setFollowUpMode` |
| K4 | 队列状态查询 | `agent:queueStatus` |
| K5 | 获取 Follow-up 队列 | `agent:getFollowUpQueue` |
| K6 | 移除指定 Follow-up | `agent:removeFollowUp` |

### L. 核心引擎能力

| 编号 | 功能 | 关键模块 |
|-----|------|---------|
| L1 | ReAct Agent Loop | `src/agent/loop.ts` |
| L2 | 目标分解 | `goal-parser.ts` |
| L3 | 目标验证（含对抗性） | `goal-verifier.ts` |
| L4 | 迭代闭环（验证失败自动补救） | `GoalVerifierConfig.iterative` |
| L5 | 多 Agent 协作 | `multi/orchestrator.ts` + `worker-executor.ts` + `blackboard.ts` + `conflict.ts` |
| L6 | 分支对话管理 | `branch.ts` |
| L7 | 上下文五阶段压缩 | `context-compaction.ts` |
| L8 | 知识图谱（PPR+社区检测） | `memory/graph.ts` |
| L9 | 项目记忆（.routedev/） | `memory/project-memory.ts` |
| L10 | 三层权限引擎 | `tools/permission-engine.ts` |
| L11 | 安全检查（路径/命令/网络） | `tools/security.ts` |
| L12 | 先读后写强制 | `tools/read-tracker.ts` |
| L13 | 工具结果净化 | `tools/result-sanitizer.ts` |
| L14 | 模型路由（分类+降级链） | `router/router.ts` + `classifier.ts` |
| L15 | Token 追踪与预算 | `router/tracker.ts` |
| L16 | OpenAI/Anthropic/Gemini 客户端 | `router/llm/` |
| L17 | 中间件五阶段管线 | `agent/middleware.ts` |
| L18 | 循环检测中间件 | `middleware/loop-detection.ts` |
| L19 | 钩子运行器 | `agent/hooks.ts` |
| L20 | 插件系统（四种类型） | `plugins/` |
| L21 | Trace 收集 | `harness/trace-collector.ts` |
| L22 | Audit 日志 | `harness/audit-logger.ts` |
| L23 | 工作模式（build/plan/compose） | `agent/work-modes.ts` |
| L24 | 需求澄清 | `requirements-clarifier.ts` |
| L25 | 任务复杂度分析 | `complexity-analyzer.ts` |
| L26 | 统一审查器 | `unified-reviewer.ts` |
| L27 | 完成验证门 | `completion-gate.ts` |
| L28 | 失败报告 | `failure-report.ts` |
| L29 | 路径路由（single/dag/compose） | `path-router.ts` |
| L30 | 自动更新 | `desktop/main/updater.ts` |
| L31 | 系统托盘 | `desktop/main/tray.ts` |
| L32 | 单实例锁 | `desktop/main/index.ts` |
| L33 | doctor 环境健康检查 | `runtime/doctor.ts` |
| L34 | 优雅关闭 | `runtime/graceful-shutdown.ts` |

### M. 内置工具

`file_read` `file_write` `file_search` `shell_exec` `git_op` `web_search` `code_search` `spawn_agent`

### N. 外部生态兼容（Phase 48）

| 编号 | 功能 | 模块 |
|-----|------|------|
| N1 | 引用系统（8 种引用类型） | `src/cite/` |
| N2 | Anthropic Skills 导入 | `src/import/anthropic-skills-loader.ts` |
| N3 | Claude Code Plugin 导入 | `src/import/claude-plugin-importer.ts` |
| N4 | Codex Instructions 导入 | `src/import/codex-importer.ts` |
| N5 | Macros 系统（4 个内置宏） | `src/macros/` |

### O. GitHub Action 集成（Phase 47 Task 9）

| 编号 | 功能 | 文件 |
|-----|------|------|
| O1 | Action 入口（Base64 config） | `scripts/action-entry.ts` + `action.yml` |
| O2 | 示例 workflow | `.github/workflows/routedev-example.yml` |

---

## 审查维度与检查清单

### 维度 1：设计文档 vs 实现一致性

**审查目标：** 对照 AGENTS.md / CHANGELOG.md / CODEMAP.md 中声称的功能，验证每个声称是否与代码实现一致。

#### 检查项

- [ ] 1.1 **CODEMAP.md 中列出的每个模块文件是否真实存在**（CODEMAP 声称的 `src/xxx/yyy.ts` 路径是否在磁盘上能找到）
- [ ] 1.2 **CODEMAP.md 中列出的每个模块是否仍在被装配**（在 `app-init.ts` 或 `engine-bridge.ts` 中是否有实例化/注入点；仅 `import type` 引用不算装配）
- [ ] 1.3 **CHANGELOG.md 中 "Added" 条目声称新增的功能是否有对应代码**（逐条核对最近 7 个版本的 Added 项）
- [ ] 1.4 **CHANGELOG.md 中 "Removed" 条目声称删除的功能是否真的从代码中消失了**（在 `src/` 与 `desktop/` 下搜索已删模块名，应无匹配）
- [ ] 1.5 **AGENTS.md "关键入口"表中列出的文件是否都承担所述职责**（例如 `goal-runner.ts` 是否真的处理 /goal）
- [ ] 1.6 **AGENTS.md "Top 10 核心陷阱"中描述的行为是否与代码一致**（例如陷阱 #18 "Rollback 前置工作区检查" 是否在 `CheckpointManager.rollback` 中有 `git status` 检查）
- [ ] 1.7 **CODEMAP.md 中标注"已退役"的模块是否真的不存在**（如 `dream-consolidator.ts` / `eq-detector.ts` / `self-evolution/`）
- [ ] 1.8 **docs/ 下文档描述的功能是否与代码一致**（`ARCHITECTURE.md` 第 2.2/6.1/6.4/7 节、`PLUGIN_GUIDE.md`、`CONFIGURATION.md`）
- [ ] 1.9 **AGENTS.md 中"已退役陷阱"标注的功能是否真的已删除**（#135 exec-runner / #139 custom-commands）

#### 证据要求

每项需提供：
- 声称来源（文件:行号 + 原文摘录）
- 实际代码位置（文件:行号）
- 一致 / 不一致 / 部分一致的判定

---

### 维度 2：用户场景闭环完整性

**审查目标：** 列出核心用户场景，检查每个场景是否能从入口到完成走通，场景间衔接是否有断点。

#### 检查项

- [ ] 2.1 **场景一：普通对话闭环** — 用户输入 → sendChat → 分类 → 路由选模型 → LLM 调用 → 流式回传 → 工具调用确认（如触发）→ 完成。检查每个环节是否有实现，是否存在"分类后路由不到模型"的断点
- [ ] 2.2 **场景二：/goal 全流程闭环** — `/goal <描述>` → GoalParser 分解 → 计划确认（semi/manual） → PathRouter 选路径（single/dag/compose） → 执行（含 spawn_agent 多 Agent） → GoalVerifier 验证 → 迭代闭环（失败补救） → 人工验收 → 完成。检查 `executeGoalCommand` → `handleGoalCommand` → `executeGoalPlan` 整条链路是否完整
- [ ] 2.3 **场景三：工具调用确认闭环** — Agent 决定调用 confirm 工具 → `onToolConfirmRequest` 回调 → IPC 推送到渲染层 → 用户在 UI 确认/拒绝 → `chat:confirm-tool` 回传 → 继续执行。检查双向 IPC 是否对称，拒绝路径是否能恢复
- [ ] 2.4 **场景四：计划编辑闭环** — semi/manual 模式触发 `requestPlanEdit` → `onPlanEditRequest` 推送 planSnapshot → 渲染层 StepEditor 显示 → 用户编辑/取消 → `plan:edit-response` 回传 → resolver resolve → goal-runner 继续执行。检查 pendingPlanEditResolvers Map 是否有泄漏（未 resolve 的 Promise）
- [ ] 2.5 **场景五：多 Agent 协作闭环** — 主 Agent 调用 `spawn_agent` → 子 Agent 创建（registry.clone + 移除 spawn_agent） → 子 Agent 执行任务 → 结果回传 Blackboard → 主 Agent 汇总。检查 Blackboard 写入/读取是否对称，子 Agent 异常是否隔离
- [ ] 2.6 **场景六：分支实验闭环** — 用户创建实验 → ExperimentManager（Git Worktree） → 执行 → `experiment:get-diff` 查看 → `experiment:adopt` 采纳 / `experiment:discard` 丢弃。检查采纳后 worktree 是否清理
- [ ] 2.7 **场景七：配置变更闭环** — 用户在 SettingsPage 修改 → `config:save` → 写 config.yaml → watcher 检测变更 → 热重载 → 通知渲染层 `ConfigReloadNotice`。检查 save → reload → 通知的链路是否完整
- [ ] 2.8 **场景八：MCP 集成闭环** — `mcp:catalog:list` 浏览 → `mcp:install` 安装 → `mcp:connect` 连接 → 工具注册到 Registry → Agent 可调用 → `mcp:disconnect` 断开。检查连接失败是否有 UI 反馈
- [ ] 2.9 **场景九：Checkpoint 回滚闭环** — Agent 执行中触发 Checkpoint → `checkpoint:list` 查看 → 用户选择 → `checkpoint:rollback` → 工作区干净检查 → git checkout → 恢复。检查工作区不干净时是否中止并提示
- [ ] 2.10 **场景十：Follow-up 插话闭环** — Agent 执行中用户输入 → `agent:followUp` → 入队 → `agent:queueStatus` 查询 → 按模式（all/one-at-a-time）投递 → `agent:removeFollowUp` 撤销。检查队列持久化与崩溃恢复
- [ ] 2.11 **场景十一：需求澄清闭环** — TaskOrchestrator 判定需澄清 → RequirementsClarifier 分析模糊度 → 生成追问 → 用户回答 → 继续/降级。检查 `skipIfConfident` 路径是否真的跳过
- [ ] 2.12 **场景十二：迭代验证闭环** — GoalVerifier 验证失败 → `iterative.enabled` 触发 → GoalParser 生成补救步骤 → 继续执行 → 再次验证 → 达 maxRounds 终止。检查 maxRounds 边界是否生效
- [ ] 2.13 **场景衔接：对话 → /goal 切换** — 普通对话中输入 `/goal ...` 是否能正确切换到 goal 流程，切换时 conversationHistory 是否正确处理
- [ ] 2.14 **场景衔接：/goal → 工具确认 → 恢复** — goal 执行中触发工具确认，确认后是否能恢复到正确的 goal 步骤（而非误入 sendChat 路径）

#### 证据要求

每项需提供：
- 场景入口代码位置（文件:行号）
- 链路上每个环节的代码位置
- 断点位置（若有）+ 断点原因
- 是否存在恢复路径

---

### 维度 3：功能入口可达性

**审查目标：** 检查所有已实现的功能是否都有 UI 入口或命令入口可达，识别"实现了但用户无法触达"的孤儿功能。

#### 检查项

- [ ] 3.1 **preload 暴露的每个 API 是否都在渲染层被调用**（在 `desktop/renderer/src/` 下搜索 `window.routedev.xxx.yyy`，每个 preload API 都应有至少一处调用）
- [ ] 3.2 **ipcMain 注册的每个 handler 是否都有对应的 preload 暴露**（反向核对：后端实现了但前端没暴露的 IPC）
- [ ] 3.3 **engine-bridge 中实现的每个 slash 命令是否都在 UI 有触发途径**（用户如何输入 `/goal`？是否有命令补全？）
- [ ] 3.4 **schema.ts 中每个配置字段是否都在 SettingsPage 有对应控件**（12 个 Tab 是否覆盖全部配置项）
- [ ] 3.5 **src/ 下实现的每个用户可见功能模块是否都有入口**（例如 `requirements-clarifier.ts` 是否真的被 TaskOrchestrator 调用，还是只被 import 但未执行）
- [ ] 3.6 **内置工具是否都注册到 ToolRegistry**（`file_read`/`file_write`/`file_search`/`shell_exec`/`git_op`/`web_search`/`code_search`/`spawn_agent` 在 app-init 是否都 register）
- [ ] 3.7 **内置钩子是否都注册到 HookRunner**（`src/hooks/built-in.ts` 中的 3 个钩子是否在 app-init 被调用）
- [ ] 3.8 **Agent Profile 模板是否可达**（`src/agents/profiles/builtin-templates.ts` 中的模板是否能通过 spawn_agent 的 subagentType 触达）
- [ ] 3.9 **Macros 系统 4 个内置宏是否可达**（用户如何触发 `!macro-name`？UI 是否有宏列表入口？）
- [ ] 3.10 **外部生态导入功能是否可达**（Anthropic Skills / Claude Plugin / Codex Instructions 导入——用户如何触发？是自动扫描还是有命令？）
- [ ] 3.11 **doctor 环境健康检查是否可达**（用户如何运行 doctor？是否有 UI 入口或命令？）
- [ ] 3.12 **trajectory 导出功能是否可达**（`TrajectoryExporter` 是否有 UI 入口或自动触发点）
- [ ] 3.13 **/review 子代理功能是否可达**（AGENTS.md 陷阱 #137 提到 /review 子代理，用户如何触发？）
- [ ] 3.14 **phase53Integration 五个安全模块是否真的被消费**（policyEngine / auditChain / mcpSecurityScan / skillSecurityGate / configGuard 在 app-init 装配后是否有运行时调用点）

#### 证据要求

每项需提供：
- 功能实现位置（文件:行号）
- 入口位置（UI 组件 / IPC 调用点 / 命令分发点）
- 若无入口：标注为 Orphan + 建议补入口或删除

---

### 维度 4：错误路径完整性

**审查目标：** 检查每个功能的错误处理路径是否完整，失败后用户能否恢复/重试。

#### 检查项

- [ ] 4.1 **LLM 调用失败路径** — 超时 / API Key 错误 / 限流 / 网络断开，每种错误是否都有用户可见反馈 + 降级链触发
- [ ] 4.2 **工具执行失败路径** — 文件不存在 / 权限拒绝 / 命令超时 / 熔断器打开，是否都有错误返回给 Agent 而非崩溃
- [ ] 4.3 **/goal 执行中失败路径** — GoalParser 失败 / 某步骤执行失败 / GoalVerifier 失败，是否都能通过 `failure-report.ts` 生成结构化报告
- [ ] 4.4 **IPC 通道失败路径** — `ipcMain.handle` 中每个 handler 的 try-catch 是否完整，引擎未初始化时是否返回友好错误而非崩溃
- [ ] 4.5 **MCP 连接失败路径** — 5 种传输协议各自的连接失败是否都有反馈，`mcp:connect` 失败后 UI 是否显示
- [ ] 4.6 **Checkpoint 回滚失败路径** — 工作区不干净 / git checkout 失败 / hash 不匹配，是否都中止并提示
- [ ] 4.7 **配置加载失败路径** — Zod 校验失败 / 环境变量缺失（fail-fast）/ 文件不存在，是否都有可恢复的错误提示
- [ ] 4.8 **子 Agent 异常隔离** — WorkerExecutor 中子 Agent 抛错是否隔离，是否影响主 Agent 和其他 Worker
- [ ] 4.9 **abortController 中止路径** — 用户点停止 / abortControllerRef.abort() 后，正在执行的 LLM 调用和工具调用是否都正确中止
- [ ] 4.10 **pendingPlanEditResolvers 泄漏** — 用户关闭 StepEditor 未响应时，pendingPlanEditResolvers Map 中的 Promise 是否会永久挂起 goal-runner
- [ ] 4.11 **迭代闭环达 maxRounds 后** — 是否有明确的"验证未通过，已达最大迭代次数"反馈，而非静默失败
- [ ] 4.12 **fail-open 守卫的可观测性** — Phase 59 五个安全模块装配失败仅 `logger.warn`，用户是否能感知到安全模块未生效

#### 证据要求

每项需提供：
- 错误触发条件
- 错误处理代码位置（文件:行号）
- 用户可见反馈方式（UI 提示 / 日志 / 静默）
- 恢复路径（重试 / 中止 / 手动干预）

---

### 维度 5：配置项完整性

**审查目标：** 检查 `config/schema.ts` 中定义的配置项是否都有消费方，识别"定义了配置但代码不读取"的僵尸配置。

#### 检查项

- [ ] 5.1 **schema.ts 中每个 Schema 字段是否都在代码中被读取**（搜索 `config.xxx.yyy` / `config\.xxx\?\.yyy`，每个字段至少有一处运行时读取）
- [ ] 5.2 **defaults.ts 中每个默认值是否对应 schema 中的字段**（defaults 与 schema 字段一一对应，无孤儿默认值）
- [ ] 5.3 **`*Integration.enabled: false` 字段是否都有"启用后接入何处"的装配点**（Phase 59 已清理 6 个，检查剩余的 `*Integration` 字段是否都有装配块）
- [ ] 5.4 **`phase49Integration` 6 个开关启用后是否真的激活对应模块**（SkillFlowEngine / DualLoopOrchestrator / SkillQualityGate / ContextUsagePanel / EvaluationFramework / RoutingFunnel——注意 RoutingFunnel 已在 Phase 59 删除）
- [ ] 5.5 **`phase48Integration` 字段是否消费**（CiteResolver / ClaudePluginImporter / CodexInstructionImporter / MacroManager / ClaudeMCPBridge）
- [ ] 5.6 **`ui.components` 7 个开关是否都消费**（BranchSwitcher / ResumePicker / ProgressBar / TracePanel / DisclosureLevel / DiffView / ConfigReloadNotice——注意 CLI 退役后这些组件是否还存在于 desktop/renderer）
- [ ] 5.7 **`optimization.clarification` 配置是否被 RequirementsClarifier 读取**
- [ ] 5.8 **`optimization.workflow` 4 个字段（unifiedPipeline / autoRequirements / reviewOnComplete / reviewMode）是否都在 TaskOrchestrator 中消费**
- [ ] 5.9 **`optimization.safety` 4 个字段（readBeforeWrite / maxToolOutputChars / completionGate / gateTimeout）是否都被对应模块读取**
- [ ] 5.10 **`security` 配置中 sandbox / approval / ssrfProtection / strictBashMode / httpsOnly / integrityCheck 等是否都有运行时检查点**
- [ ] 5.11 **`autonomy.defaultMode` 是否真的通过 `AUTONOMY_BEHAVIOR` 映射影响 goal-runner 行为**
- [ ] 5.12 **`goalVerifier.iterative` 配置是否在 goal-runner 中被 if 守卫消费**
- [ ] 5.13 **`mcp.lifecyclePolicy` 三种策略是否都有实现分支**（per-call / per-session / persistent）
- [ ] 5.14 **`channels` 配置（webhook 通知）是否还有消费方**（Phase 13 渠道配置，AGENTS.md 未提退役，确认是否还活着）
- [ ] 5.15 **`sounds` 配置是否在桌面端被消费**（CLI 退役后提示音是否还有触发点）

#### 证据要求

每项需提供：
- schema 字段定义位置（schema.ts:行号）
- 默认值位置（defaults.ts:行号）
- 消费点位置（文件:行号 + 读取代码）
- 若无消费点：标注为僵尸配置 + 建议删除或补消费点

---

### 维度 6：IPC 通道完整性

**审查目标：** 检查 preload 暴露的 API 是否都有 main 进程实现，反向检查是否有"前端调用但后端没实现"或"后端实现但前端没暴露"的通道。

#### 检查项

- [ ] 6.1 **preload 中每个 `ipcRenderer.send` / `ipcRenderer.invoke` 是否都有对应的 `ipcMain.on` / `ipcMain.handle`**（逐个核对通道名）
- [ ] 6.2 **ipcMain 中每个 handler 是否都有对应的 preload 暴露**（反向核对）
- [ ] 6.3 **`ipcRenderer.on` 监听的事件是否都有 main 进程的 `webContents.send` 发送方**（如 `chat:stream` / `token:profile` / `trace:event` / `goal:event`）
- [ ] 6.4 **invoke 通道是否都返回 Promise**（`ipcMain.handle` 必须返回值，否则前端 await 会挂起）
- [ ] 6.5 **send 通道（单向）是否都不需要返回值**（确认 `chat:send` / `chat:stop` / `chat:sync-history` / `project:set-cwd` / `window:*` / `plan:edit-response` / `agent:followUp` / `agent:clearAllQueues` / `agent:setFollowUpMode` 都是单向语义）
- [ ] 6.6 **chat:send → chat:stream 事件链是否完整** — send 触发后，main 是否在所有路径（成功/失败/中止）都发送 `chat:stream` 的 done/error 事件，否则渲染层会永久 loading
- [ ] 6.7 **tool:execute 通道是否被使用** — preload 暴露了 `tool.execute`，检查渲染层是否有调用点（可能仅用于手动触发工具测试）
- [ ] 6.8 **plan:edit-response → resolver 链路** — `plan:edit-response` IPC 触发时是否能正确找到 pendingPlanEditResolvers 中的 resolver 并 resolve
- [ ] 6.9 **listenerMap 解绑是否正确** — preload 中 `off` 是否能正确移除 `on` 注册的 listener（防止内存泄漏）

#### 证据要求

每项需提供：
- 通道名
- preload 端代码位置（preload/index.ts:行号）
- main 端代码位置（main/index.ts:行号）
- 配对情况（配对 / 仅前端 / 仅后端）

---

### 维度 7：测试覆盖完整性

**审查目标：** 检查核心功能是否有测试覆盖，识别"有实现但无测试"的功能模块。

#### 检查项

- [ ] 7.1 **每个 IPC handler 是否有测试**（`tests/integration/ipc-bridge.test.ts` 是否覆盖全部 IPC 通道）
- [ ] 7.2 **engine-bridge 的每个 slash 命令是否有测试**（/clear /status /mcp /compact /skill /help /goal）
- [ ] 7.3 **/goal 全流程是否有端到端测试**（`tests/integration/goal-flow.test.ts` 或类似）
- [ ] 7.4 **多 Agent 协作模块是否有测试**（orchestrator / worker-executor / blackboard / conflict-detector）
- [ ] 7.5 **五种 MCP 传输协议是否有测试**（stdio / http / sse / streamable_http / websocket）
- [ ] 7.6 **Phase 73 Follow-up 队列功能是否有测试**（agent:followUp / clearAllQueues / setFollowUpMode / queueStatus / getFollowUpQueue / removeFollowUp）
- [ ] 7.7 **Phase 71 plan:get-revisions / plan:check-omissions 是否有测试**
- [ ] 7.8 **Checkpoint 回滚（含工作区不干净中止）是否有测试**（`tests/harness/checkpoint-rollback` 类似）
- [ ] 7.9 **迭代闭环（maxRounds 边界）是否有测试**
- [ ] 7.10 **fail-open 守卫是否有测试**（五个安全模块装配失败时不阻塞主流程）
- [ ] 7.11 **abortController 中止路径是否有测试**
- [ ] 7.12 **配置热重载是否有测试**（`tests/config/` 下 watcher 测试）
- [ ] 7.13 **缺失测试的功能模块清单** — 列出所有"有实现但无对应测试文件"的模块

#### 证据要求

每项需提供：
- 功能模块位置
- 测试文件路径（若有）
- 测试用例数（若有）
- 若无测试：标注为"无测试覆盖" + 风险评估

---

### 维度 8：文档完整性

**审查目标：** 检查 AGENTS.md / README / docs/ / CHANGELOG 中描述的功能是否与代码一致，识别"文档描述的功能已不存在"或"代码有但文档未提"。

#### 检查项

- [ ] 8.1 **AGENTS.md "关键入口"表的每个文件是否真的承担所述职责**
- [ ] 8.2 **AGENTS.md "已退役陷阱"标注的功能是否真的已删除**（#135 exec-runner / #139 custom-commands）
- [ ] 8.3 **CODEMAP.md 是否有"已删模块仍被列出"的情况**（CODEMAP 最后更新 2026-07-05，核对此后删除的模块是否已从 CODEMAP 移除）
- [ ] 8.4 **CHANGELOG.md 中"Removed"条目是否在 CODEMAP 中也已移除对应描述**（CHANGELOG 与 CODEMAP 同步性）
- [ ] 8.5 **docs/ARCHITECTURE.md 描述的架构是否与当前代码一致**（特别是 Phase 56-60 花架子去除后的架构变更）
- [ ] 8.6 **docs/CONFIGURATION.md 是否覆盖 schema.ts 中所有配置项**（每个 schema 字段是否在 CONFIGURATION.md 有说明）
- [ ] 8.7 **docs/PLUGIN_GUIDE.md 描述的插件 API 是否与 `src/plugins/` 实现一致**
- [ ] 8.8 **docs/SECURITY_AUDIT_v2.0.md 的安全措施是否都还在**（v2.0 后可能有变更）
- [ ] 8.9 **.routedev/skills/*/SKILL.md 中描述的 Skill 功能是否与代码一致**
- [ ] 8.10 **README.md（若存在）是否与当前功能一致**
- [ ] 8.11 **action.yml + 示例 workflow 是否与 scripts/action-entry.ts 实现一致**
- [ ] 8.12 **是否有"代码有但文档未提"的重要功能**（如 Follow-up 队列、Plan 修订历史等新功能是否在文档中有说明）

#### 证据要求

每项需提供：
- 文档位置（文件:行号 + 原文摘录）
- 代码位置（文件:行号）
- 一致 / 不一致 / 文档缺失 / 代码缺失 的判定

---

## 输出格式要求

### findings 数组格式

每条 finding 必须包含以下字段：

```yaml
- id: F-001                          # 序号
  level: Missing                      # 级别（见下方定义）
  dimension: 维度1-设计文档一致性     # 所属维度
  location:                           # 问题位置
    file: src/agent/xxx.ts
    line: 123-145
  title: 一句话标题                    # 简明标题
  problem: |                          # 问题描述（详细）
    详细说明功能声称有什么、实际有什么、差距是什么。
  evidence:                           # 证据
    claim_source:                     # 声称来源
      file: CHANGELOG.md
      line: 207
      text: "SkillFlow 引擎 — 5 种节点类型..."
    code_location:                    # 实际代码位置
      file: src/skills/skill-flow-engine.ts
      line: 1-50
    search_performed:                 # 搜索验证（若有）
      - pattern: "SkillFlowEngine"
        scope: "src/"
        match_count: 0
  impact: 用户无法使用 SkillFlow 功能  # 影响
  recommendation: |                   # 修复建议
    1. 补充实现 / 2. 或从文档移除声称
  status: open                        # open / fixed / wontfix
```

### 汇总报告格式

审查结束后必须输出汇总表：

```markdown
## 审查汇总

### 按级别统计
| 级别 | 数量 |
|------|------|
| Complete | XX |
| Partial | XX |
| Missing | XX |
| Broken | XX |
| Orphan | XX |

### 按维度统计
| 维度 | Complete | Partial | Missing | Broken | Orphan |
|------|----------|---------|---------|--------|--------|
| 1. 设计文档一致性 | | | | | |
| 2. 用户场景闭环 | | | | | |
| 3. 功能入口可达性 | | | | | |
| 4. 错误路径完整性 | | | | | |
| 5. 配置项完整性 | | | | | |
| 6. IPC 通道完整性 | | | | | |
| 7. 测试覆盖完整性 | | | | | |
| 8. 文档完整性 | | | | | |

### Top 5 高优先级问题
1. [F-XXX] ...
2. [F-XXX] ...
3. [F-XXX] ...
4. [F-XXX] ...
5. [F-XXX] ...
```

---

## 级别定义

| 级别 | 含义 | 判定标准 |
|------|------|---------|
| **Complete** | 功能完整实现 | 入口可达 + 主路径工作 + 错误路径处理 + 有测试 + 配置消费完整 |
| **Partial** | 功能部分实现，有缺口 | 主路径工作但有断点 / 错误路径缺失 / 无测试 / 配置未消费 / 文档未同步 中的 1-2 项 |
| **Missing** | 功能声称已实现但实际不存在 | CHANGELOG/AGENTS/CODEMAP 声称有，但代码中找不到实现或只有空壳 |
| **Broken** | 功能存在但不能正常工作 | 代码存在但链路断裂 / 抛错 / 返回错误结果 / IPC 不配对 |
| **Orphan** | 功能已实现但无入口可达 | 代码完整但无 UI 入口 / 无命令入口 / 无 IPC 暴露 / 无装配点 |

### 判定优先级

1. **Missing 优先于 Broken** — 找不到实现比实现坏了更严重
2. **Broken 优先于 Orphan** — 坏了比无法触达更严重
3. **Orphan 优先于 Partial** — 完全无法触达比部分实现更严重
4. **Partial 是最低严重问题级别** — 至少能用，但不完整

---

## 已知排除项

> 以下功能是"有意不实现"或"已退役"，审查时**不应报告为问题**，避免误报。

### 已退役功能（CLI 时期，AGENTS.md 已标注）

- **CLI 交互层** — 终端 UI 已退役，`src/cli/` 目录下的代码仅保留兼容，不再维护（CODEMAP 2026-07-05 已清理）
- **`exec-runner.ts`** — CLI 退役后已删除（陷阱 #135 已废弃）
- **`custom-commands.ts`** — CLI 退役后已删除（陷阱 #139 已废弃）
- **`/dream` 命令** — Phase 60 删除 deprecated alias，改用 `/consolidate-memory`

### Phase 56-60 花架子去除工程已删功能

- **`self-evolution/` 模块**（selfEvolution / godelProposer / selfHarness 配置字段已移除）
- **`dream-consolidator.ts`**（无入口模块）
- **`eq-detector.ts`**（接口不匹配）
- **`vision` 默认关闭** — 需显式 `vision.enabled: true`（不算缺失）
- **`executionRouter.mode: 'legacy'`** — 已移除，自动迁移为 `'auto'`
- **已删配置字段** — routingFunnelEnabled / processEvaluation / archAwareMetrics / saturationMonitor / promptBuilderEnabled / requirementChangeEnabled / phase52Integration.mcpSecurity
- **`ExecutionRoute` 类型** — 从 `'single' | 'dag' | 'compose' | 'legacy'` 收窄为 `'single' | 'dag' | 'compose'`

### 有意默认关闭的功能（不算缺失）

- **`vision` 模块** — 默认关闭，需显式启用
- **`conciseThinking`** — 实验性，默认关闭
- **`optimization.contentRouting`** — Phase 72 实验性，默认关闭
- **`ui.components.tracePanel`** — 默认关闭
- **`adversarial` 对抗性验证** — 默认关闭（`enabled: false`）
- **`phase49Integration` 6 个开关** — 默认 false，属实验性功能（注意：若开启后应工作，开启后不工作算 Broken）
- **调度器（scheduler）** — `SettingsCommandsTab.tsx` 中调度器 Card 已禁用并标注"预留功能，当前不生效"，调度器引擎未接入运行时，不算缺失
- **`directoryBoundary`** — 默认 false（Phase 77 审查后调整），路径校验由 hookConfigPath 统一处理，不算缺失

### Phase 77 新增能力（已实现，不要报告为 Missing）

- **Trace 回放**（`src/harness/trace-replayer.ts`）— 通过 `/replay` 命令触发，UI 在 `ReplayView.tsx`
- **评分卡**（`src/harness/scorecard.ts`）— 通过 `/scorecard` 命令触发，UI 在 `ScorecardView.tsx`
- **冷启动恢复**（`src/runtime/goal-recovery.ts`）— 启动时自动检测未完成 goal，UI 在 `RecoveryPrompt.tsx`
- **会话状态卡**（`src/agent/session-status-aggregator.ts`）— UI 在 `SessionStatusCard.tsx`

### 配置默认值已修正（不要报告漂移）

- `goalIntegration.persistenceEnabled` — 默认 true（已修正，文档与 schema 一致）
- `goalIntegration.auditEnabled` — 默认 true（已修正）
- `delegationIntegration` 5 个开关 — 全部默认 true（已修正）

### 评估指标（学术性，无用户可见产物）

- **`src/evaluation/` 四个活模块** — `mi-cross-scorer` / `saturation-monitor` / `architecture-aware-metrics` / `process-defect-ontology` 保留为类型契约引用，无独立 UI 入口是有意设计

### 注意事项

- **`src/cli/` 残留代码** — CLI 退役后可能有残留，不应作为"功能完整度"问题报告（归死代码审查）
- **`tests/` 下的 phase-specific 测试** — 历史 Phase 测试保留为回归测试，不算冗余

---

## 审查者自检清单

> 审查者完成审查后，必须逐项自检，确保审查质量。

- [ ] **S1** 我已读取全部 10 个必读前置文件，并建立了"应该有什么"的基线
- [ ] **S2** 我列出了 RouteDev 声称拥有的全部功能清单（基线 A-O）
- [ ] **S3** 我对 8 个维度的每个检查项都给出了判定（Complete/Partial/Missing/Broken/Orphan/N/A），没有跳过
- [ ] **S4** 每条 finding 都附带了证据（文件:行号 + 代码/文档摘录），而非主观断言
- [ ] **S5** 我没有把"已知排除项"中的功能报告为问题
- [ ] **S6** 我没有把"代码质量"问题混入本审查（如命名/性能/类型安全——这些归全量审查）
- [ ] **S7** 我没有把"死代码"问题混入本审查（归死代码审查），但我可以报告"有实现但无入口"的孤儿功能
- [ ] **S8** 我对每个 Missing/Broken 级别的问题都给出了影响评估和修复建议
- [ ] **S9** 我对"声称已实现"的判断基于文档原文，而非个人推测
- [ ] **S10** 我对"实际是否实现"的判断基于代码搜索结果（含搜索 pattern 和匹配数），而非"我大概记得"
- [ ] **S11** 我检查了场景间的衔接断点（维度 2.13/2.14），而不仅是单个场景内部
- [ ] **S12** 我检查了 IPC 通道的双向配对（维度 6），而不仅是单向
- [ ] **S13** 我检查了配置字段的消费点（维度 5），而不仅是定义点
- [ ] **S14** 我在汇总报告中按级别和维度给出了统计表
- [ ] **S15** 我列出了 Top 5 高优先级问题，并说明了优先级理由

---

## 附：审查执行建议

### 推荐执行顺序

1. **先建立基线** — 读完 10 个必读文件，列出功能清单
2. **维度 1（文档一致性）** — 先做这步，识别"声称有什么"
3. **维度 3（入口可达性）** — 再做这步，识别"实际有什么入口"
4. **维度 6（IPC 完整性）** — 桌面应用核心，机械核对
5. **维度 5（配置完整性）** — 与维度 3 交叉验证
6. **维度 2（场景闭环）** — 深度审查，需理解代码流程
7. **维度 4（错误路径）** — 与维度 2 交叉验证
8. **维度 7（测试覆盖）** — 机械核对
9. **维度 8（文档完整性）** — 最后做，综合前 7 个维度的发现

### 高效搜索技巧

- 用 `Grep` 搜索 `ipcRenderer.invoke\(['"]xxx['"]` 找前端调用点
- 用 `Grep` 搜索 `ipcMain.handle\(['"]xxx['"]` 找后端实现点
- 用 `Grep` 搜索 `config\.xxx` 找配置消费点
- 用 `Glob` 验证文件是否存在
- 用 `SearchCodebase` 找"按意图"的代码（如"哪里触发了 GoalVerifier"）

### 避免误报

- **不要**因为某个模块在 `src/` 下存在就报 Complete —— 要验证它被装配和调用
- **不要**因为某个配置字段默认 false 就报 Orphan —— 要检查启用后是否有消费点
- **不要**因为某个 IPC 通道前端没调用就报 Orphan —— 可能是测试通道或预留
- **不要**把 CLI 残留代码报为 Missing —— CLI 已退役（见已知排除项）
- **不要**把实验性功能默认关闭报为 Broken —— 需显式启用（见已知排除项）

---

**审查提示词版本：** v1.1
**最后更新：** 2026-07-10
**维护者：** RouteDev 审查提示词设计师
