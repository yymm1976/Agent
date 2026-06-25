# RouteDev 全量代码审查报告

> **审查日期：** 2026-06-21
> **审查方法：** 5 个并行子 Agent 逐行审查（死代码/接线审计 + 核心逻辑审计 + 桌面端 UX 审计 + 安全/工具/基础设施审计 + CLI/命令审计）
> **审查范围：** 整个代码库（v2.8.0），约 150 源文件 + 45 桌面端文件 + 160 测试文件
> **审查人：** 架构师（QoderWork）
> **上次审计：** 2026-06-20（Phase 01-35 完成度核实，V2 版）

---

## 一、审查总览

| 维度 | 数量 |
|------|:----:|
| Critical（必须立即修复） | **16** |
| Important（发布前必须修复） | **26** |
| Minor（建议改进） | **23** |
| 性能问题 | **6** |
| 架构建议 | **5** |
| **总计** | **76** |

**安全评分：6.0 / 10** — 架构设计层面安全性较好（SSRF 防护、7 层 bash 安全、时序安全签名、结果脱敏、读后写强制），但实现完整度有明显缺口（Windows 路径规则缺失、MCP 环境变量泄露、权限引擎配置漏洞等）。

**一句话判断：** RouteDev 的核心架构成熟、测试覆盖良好（1735+ 测试），但存在三个系统性问题——(1) Phase 37 新增的 3 个命令（experiment/schedule/clarify）完全未注册到 App.tsx，用户无法使用；(2) Desktop 端 SettingsPage 155KB 单文件和 ChatPage 55KB 单文件是技术债最集中的地方；(3) 安全层对 Windows 平台的适配严重不足。

---

## 二、Critical 级问题（16 项）

### 核心逻辑（3 项）

#### C-01. loop.ts 并行模式下 ask_user 工具未被拦截

**文件：** `src/agent/loop.ts`（并行工具执行分支）
**问题：** ReAct 循环在并行模式下执行 `Promise.all` 时，`ask_user` 工具应该被拦截并返回确认提示给用户，但当前代码只拦截了串行路径的 `ask_user`，并行路径直接执行了该工具。
**影响：** 并行模式下 Agent 调用 `ask_user` 时，用户不会看到确认提示，交互流程断裂。
**修复方向：** 在并行执行前对 `approvedCalls` 做 `ask_user` 检查，命中时提取出来单独处理。

#### C-02. openai.ts tool_result 消息丢失

**文件：** `src/router/llm/openai.ts`
**问题：** OpenAI 协议适配中，`tool_result` 类型的消息在转换为 OpenAI 格式时被静默丢弃。多轮工具调用对话中，LLM 看不到之前工具返回的结果。
**影响：** 使用 OpenAI 协议的模型在多轮工具调用场景下，上下文不完整，LLM 会重复调用已完成的工具或产生错误推理。
**修复方向：** 在消息转换逻辑中正确处理 `role: 'tool'` + `tool_call_id` 映射。

#### C-03. KnowledgeGraph PPR 传播方向错误

**文件：** `src/agent/memory/graph.ts`
**问题：** Personalized PageRank 算法沿出边传播权重，但正确语义应该沿入边传播（"谁指向该节点"而非"该节点指向谁"）。
**影响：** 知识图谱的相关性排序完全反转——被引用最多的节点（应该是高分）反而得到低分。
**修复方向：** 将 PPR 的边遍历方向从出边改为入边。

### 安全漏洞（4 项）

#### C-04. 权限引擎 auto-file-wildcard 规则静默放行文件写操作

**文件：** `src/tools/permission-engine.ts`
**问题：** `auto-file-wildcard` 规则自动批准所有匹配 `file_write`/`file_edit` 的请求，绕过了这两个工具声明的 `requiresApproval: true`。一行配置变更就能修复。
**影响：** Agent 的文件写操作实际上不需要用户确认，安全策略形同虚设。
**修复方向：** 修改 auto-file-wildcard 规则，排除 write/edit 操作或收窄匹配范围。

#### C-05. 文件工具缺少内部路径边界检查

**文件：** `src/tools/builtin/file-read.ts`, `file-write.ts`, `file-edit.ts`, `list-directory.ts`
**问题：** 四个文件工具完全依赖 `executor.ts` 的外层安全检查，自身不做路径边界验证。违反纵深防御原则——如果未来有其他入口绕过 executor，文件操作将不受任何保护。
**影响：** 安全架构仅依赖单层防护。
**修复方向：** 在每个文件工具内部添加 `SecurityChecker.checkPath()` 调用。

#### C-06. MCP 子进程继承完整 process.env

**文件：** `src/tools/mcp/client.ts`
**问题：** MCP 服务器子进程启动时继承父进程的完整 `process.env`，包含所有 API Key 和 Secret。而 `shell-exec.ts` 正确使用了环境变量白名单。
**影响：** MCP 服务器可能通过环境变量读取到用户的 API Key、数据库密码等敏感信息。
**修复方向：** MCP 启动时仅传递配置中声明的 `env` 字段 + 安全白名单变量。

#### C-07. web_search 缺少 SSRF 防护和响应大小限制

**文件：** `src/tools/builtin/web-search.ts`
**问题：** 与 `web-fetch.ts`（有 SSRF 防护和响应大小限制）不同，`web-search.ts` 既没有内网 IP 过滤也没有响应体大小限制。
**影响：** Agent 可能被引导搜索内网地址，或收到超大响应导致内存问题。
**修复方向：** 复用 web-fetch 的 SSRF 检查逻辑和响应截断机制。

### Desktop 端（4 项）

#### C-08. Skill/MCP 状态栏隐藏后无法恢复

**文件：** `desktop/renderer/src/pages/ChatPage.tsx:1176`
**问题：** `setShowSkillBar(false)` 执行后，没有任何 UI 入口将其设回 `true`。用户关闭 Skill/MCP 状态栏后永远无法重新打开。
**影响：** Phase 37 新功能带着交互死胡同上线。
**修复方向：** 添加"显示 Skill 面板"按钮或菜单项。

#### C-09. mainWindow 非空断言导致退出崩溃

**文件：** `desktop/main/index.ts:453`
**问题：** `before-quit` 处理中使用 `mainWindow!` 非空断言，但此时 `mainWindow` 可能已为 `null`（窗口已关闭）。
**影响：** 用户在关闭窗口后通过托盘退出应用时，可能触发崩溃。
**修复方向：** 改为 `mainWindow?.hide()` 可选链调用。

#### C-10. 4 处 browser confirm() 阻塞渲染进程

**文件：** `desktop/renderer/src/pages/ChatPage.tsx:965, 970, 1009, 1014`
**问题：** 桌面应用中使用浏览器原生 `confirm()` 弹窗，会阻塞整个渲染进程。代码重复 2 遍。
**影响：** 确认期间 UI 完全冻结，且外观与 Electron 应用不协调。
**修复方向：** 统一替换为应用内 Modal 组件。

#### C-11. 需求澄清回答映射错误 — 所有问题共享同一回答

**文件：** `src/cli/App.tsx:550-554`
**问题：** RequirementsClarifier 提出多个澄清问题时，用户的单次输入被 `.map()` 复制给所有问题。
**影响：** 3 个澄清问题全部得到相同回答，需求分析严重失真。
**修复方向：** 实现逐问题收集机制，或解析用户的分段回答。

### CLI 层（5 项）

#### C-12. 三个命令已定义但从未注册到 App.tsx

**文件：** `src/cli/App.tsx:32-42` (import) 和 `:143` (register)
**问题：** `experimentCommand`、`scheduleCommand`、`clarifyCommand` 在 `commands/index.ts` 正确导出，但 `App.tsx` 的 import 和注册语句完全遗漏了它们。
**影响：** 用户输入 `/experiment`、`/schedule`、`/clarify` 时收到"未知命令"错误，这三个功能模块完全不可达。
**修复方向：** 在 import 和注册数组中添加这三个命令。

#### C-13. /help 命令始终返回"命令注册表不可用"

**文件：** `src/cli/App.tsx:209-239` + `src/cli/commands/help.ts:13-17`
**问题：** `createServiceContext()` 调用时未传入 `commandRegistry`，导致 `ctx.commandRegistry` 始终为 `undefined`。
**影响：** `/help` 命令永远返回错误消息，新用户无法发现可用命令。
**修复方向：** 在 deps 中添加 `commandRegistry: commandRegistryRef.current`。

#### C-14. ConfirmDialog 倒计时因回调不稳定而可能永不超时

**文件：** `src/cli/App.tsx:729-734` + `src/cli/components/ConfirmDialog.tsx:77-86`
**问题：** `onConfirm`/`onDeny` 是内联箭头函数，每次渲染创建新引用。ConfirmDialog 的 useEffect 将 `onDeny` 列入依赖数组，流式输出期间频繁重渲染会不断重置 30 秒倒计时。
**影响：** 安全策略（超时自动拒绝）在流式输出期间失效。
**修复方向：** 使用 `useCallback` 包裹回调，或在 ConfirmDialog 内部用 `useRef` 持有最新引用。

#### C-15. useEffect 依赖 ref.current 无法触发重渲染

**文件：** `src/cli/App.tsx:134-136`
**问题：** `conversationHistoryRef.current.length` 作为 useEffect 依赖项，但 ref 变更不触发重渲染，effect 只在其他原因触发的重渲染时运行。
**影响：** BranchManager 初始化不会随对话历史变化自动更新。
**修复方向：** 使用同步 state 变量作为 effect 依赖。

#### C-16. Windows 系统目录未纳入 deny 规则

**文件：** `src/tools/security.ts`
**问题：** Deny 规则只覆盖 Unix 路径（`/etc/`、`/proc/`），完全缺少 Windows 系统目录（`C:\Windows\`、`C:\Program Files\` 等）。
**影响：** Windows 用户面临系统目录被 Agent 误操作的风险。
**修复方向：** 添加 Windows 系统路径的 deny 规则。

---

## 三、Important 级问题（26 项）

### 核心逻辑（8 项）

| 编号 | 文件 | 问题 |
|------|------|------|
| I-01 | `classifier.ts` | 关键词分类器优先级高于 LLM 分类器，简单关键词（如 "fix"）可能误判任务复杂度 |
| I-02 | `tracker.ts` | Token 记录数组无限增长，无清理机制，长时间运行后内存持续膨胀 |
| I-03 | `compose-pipeline.ts` | 多步骤管道缺少 `context` 参数传递，步骤间上下文断裂 |
| I-04 | `checkpoint-writer.ts` | 加载 checkpoint 时未校验 JSON 结构完整性，损坏文件可能导致运行时崩溃 |
| I-05 | `micro-summary.ts` | 正则提取 `<decision>` 标签过宽（非贪婪但跨行），可能捕获到嵌套标签内容 |
| I-06 | `token-counter.ts` | 同一消息在重试场景下被重复计算 token |
| I-07 | `graph.ts` | 节点间可能产生重复边（无去重），PPR 计算权重被放大 |
| I-08 | `context-manager.ts` | 错误信息数组无上限，极端场景下无限增长 |

### 安全/工具（5 项）

| 编号 | 文件 | 问题 |
|------|------|------|
| I-09 | `file-write.ts` | 写入路径未规范化（`..` 路径可绕过），依赖外层 executor 检查 |
| I-10 | `web-fetch.ts` | SSRF 检查仅过滤 localhost/127.0.0.1，缺少对 `0.0.0.0`、`169.254.169.254`（云元数据）等的过滤 |
| I-11 | `shell-exec.ts` | 环境变量白名单虽正确，但缺少对 `NO_PROXY`/`HTTP_PROXY` 等代理变量的处理 |
| I-12 | `config/schema.ts` | 部分配置项的 Zod schema 缺少 `.min()`/`.max()` 约束，可能接受不合理值 |
| I-13 | `plugins/registry.ts` | 插件加载错误被 try-catch 静默吞掉，用户不知道插件加载失败 |

### Desktop 端（5 项）

| 编号 | 文件 | 问题 |
|------|------|------|
| I-14 | `ChatPage.tsx` | 消息列表无虚拟化，长对话（100+ 消息）渲染性能严重退化 |
| I-15 | `engine-bridge.ts` | IPC 消息处理缺少背压机制，高频事件（如流式输出）可能堆积 |
| I-16 | `SettingsPage.tsx` | 配置保存后无"已保存"视觉反馈，用户不确定修改是否生效 |
| I-17 | `useRouteDevStore.ts` | Store 状态与 IPC 状态可能不同步（如 config 被外部修改后 store 未更新） |
| I-18 | `ChatPage.tsx` | 自动滚动到最新消息的逻辑在用户手动滚动查看历史时会强行拉回底部 |

### CLI 层（8 项）

| 编号 | 文件 | 问题 |
|------|------|------|
| I-19 | `completion.ts` | Tab 补全列表仅 18 个命令，遗漏 16 个（experiment/schedule/clarify/output-style/tech-debt/permissions/config/cost 等） |
| I-20 | `chat-runner.ts` | 工具确认期间 `setIsProcessing(false)` 启用 InputBox，用户可在确认等待期提交新输入 |
| I-21 | `commands/diff.ts` | `/diff apply` 语义混乱——显示的是已有变更，apply 尝试重复应用导致冲突 |
| I-22 | `App.tsx:131` | `registerPermissionMiddleware` 在渲染阶段调用（非 useEffect），违反 React 纯渲染原则 |
| I-23 | `App.tsx:153-169` | `commandBridge` 每次渲染重建导致 `useCallback` 链失效，流式输出期间性能退化 |
| I-24 | `App.tsx:566` | `developmentContextRef.current` 在需求确认中被过早清空 |
| I-25 | `commands/experiment.ts:91` | `/experiment run` 和 `/experiment adopt` 缺少 try-catch 错误处理 |
| I-26 | 8 个命令文件 | `/branch`、`/checkpoint`、`/dream`、`/history`、`/cost`、`/status` 等命令缺少错误处理 |

---

## 四、Minor 级问题（23 项）

| 编号 | 文件 | 问题 |
|------|------|------|
| M-01 | `loop.ts` | 未使用变量 `systemMessage` |
| M-02 | `cache-optimizer.ts` | 死代码：`evictLeastUsed()` 函数从未被调用 |
| M-03 | `checkpoint-writer.ts` | 使用同步 `fs.writeFileSync` 阻塞主线程 |
| M-04 | `token-counter.ts` | 分词质量低（简单 split(' ')），与真实 tokenizer 差距大 |
| M-05 | `concise-thinking.ts` | lint 范围过宽（`/\[lint\]/i` 匹配日志中的 lint 关键词而非仅 lint 工具） |
| M-06 | `defaults.ts` | 默认模型名硬编码为 `gpt-4o`，应跟随配置中的 provider 列表 |
| M-07 | `graph.ts` | 节点 ID 碰撞风险（基于内容哈希，长文本可能碰撞） |
| M-08 | `dream-to-graph.ts` | 缺少目标目录创建（`mkdirSync` 未调用） |
| M-09 | `dream-consolidator.ts` | 正则错误检测对中文日志的 `错误` 关键词过于敏感 |
| M-10 | `file-write.ts` | 缺少 `mkdir -p` 语义（写入嵌套路径时不自动创建父目录） |
| M-11 | `wizard.tsx:355` | 变量 `path` 遮蔽了 `node:path` 模块导入 |
| M-12 | `commands/experiment.ts` | 4 处 catch 使用 `error: any` 而非 `unknown` |
| M-13 | `App.tsx:356-376` | useEffect 缩进不一致（后期插入代码痕迹） |
| M-14 | `commands/channels.ts` | handler 忽略 ctx 参数 |
| M-15 | `goal-progress.ts:77` | 步骤描述硬截断到 80 字符，不适应宽终端 |
| M-16 | `ChatView.tsx:64` | 消息列表无虚拟化，长对话性能问题 |
| M-17 | `App.tsx:76-77` | `messageIdCounter` 模块级可变变量，跨实例共享 |
| M-18 | `splash.ts`/`args.ts` | 重复的 `require('node:module').createRequire()` 模式 |
| M-19 | `SettingsPage.tsx` | 多处 `console.log` 残留（生产环境不应输出日志） |
| M-20 | `ToolCallCard.tsx` | 工具参数显示未做 JSON 美化（大 JSON 对象难以阅读） |
| M-21 | `ProjectSidebar.tsx` | 项目列表无搜索/过滤功能（项目多时难以定位） |
| M-22 | `NewTaskPage.tsx` | 缺少"最近使用的提示词"快捷入口 |
| M-23 | `TokenPage.tsx` | 图表缺少时间范围选择器 |

---

## 五、性能问题（6 项）

| 编号 | 文件 | 问题 | 影响 |
|------|------|------|------|
| P-01 | `SettingsPage.tsx` | 3199 行单文件，React 渲染整个 Settings 页面时所有 13 个 Tab 内容被解析 | 初始渲染慢 |
| P-02 | `ChatPage.tsx` | 消息列表使用 `messages.map()` 无虚拟化，100+ 消息时 DOM 节点过多 | 长对话滚动卡顿 |
| P-03 | `engine-bridge.ts` | IPC 事件无批量处理，每个 token delta 独立发送 IPC 消息 | 高频 IPC 通信开销 |
| P-04 | `useRouteDevStore.ts` | Zustand store 未做 selector 优化，组件订阅整个 store 导致不必要重渲染 | 全局渲染开销 |
| P-05 | `App.tsx` | 空闲提示 useEffect 4 个依赖项，流式输出期间 interval 不断重建 | GC 压力 |
| P-06 | `TracePanel.tsx` | Trace 数据全量渲染，大型任务可能产生 1000+ 个 span | 渲染卡顿 |

---

## 六、架构建议（5 项）

| 编号 | 建议 | 当前状态 | 建议方向 |
|------|------|---------|---------|
| A-01 | SettingsPage 按 Tab 拆分为独立组件文件 | 155KB 单文件 | 拆为 `SettingsGeneralTab.tsx`、`SettingsModelsTab.tsx`、`SettingsSecurityTab.tsx` 等 13 个文件 |
| A-02 | ChatPage 拆分消息渲染与输入逻辑 | 55KB 单文件 | 提取 `MessageList.tsx`、`MessageInput.tsx`、`ChatToolbar.tsx` |
| A-03 | CLI 命令注册从硬编码改为自动发现 | App.tsx 手动 import 34 个命令 | `commands/index.ts` 统一导出数组，App.tsx 一行注册 |
| A-04 | 统一 Confirm/Modal 系统 | Desktop 用 browser confirm()，CLI 用 ConfirmDialog | 抽象 `ConfirmationService` 接口，两端各自实现 |
| A-05 | Tab 补全从 CommandRegistry 动态生成 | completion.ts 硬编码 18 个命令 | `CommandRegistry.listCommands()` 自动生成候选列表 |

---

## 七、死代码与模块接线状态

### Phase 31 八个模块最终接线状态（继承上次审计，本次确认未变化）

| 模块 | 状态 | 说明 |
|------|------|------|
| ReadTracker | ✅ 完全接线 | `work-modes.ts` 调用 `markRead()` + `checkReadBeforeWrite()` |
| ToolResultSanitizer | ✅ 完全接线 | `loop.ts` 通过 `setSanitizer` 接入 |
| CompletionGate | ✅ 完全接线 | `goal-runner.ts:370` 调用 `verify()` |
| TaskOrchestrator | ⚠️ 部分接线 | 入口骨架已接入，但完整流水线阶段未驱动 |
| RequirementsGatherer | ❌ 死代码 | 实例化后 `gather()`/`generateQuestions()` 从未被调用 |
| TaskComplexityAnalyzer | ❌ 死代码 | 实例化后 `analyze()` 从未被调用 |
| ExecutionOrchestrator | ❌ 死代码 | 实例化后 `execute()` 从未被调用 |
| UnifiedReviewer | ❌ 死代码 | 实例化后 `review()` 从未被调用 |

### Phase 37 新增命令接线状态（本次新发现）

| 命令 | 状态 | 说明 |
|------|------|------|
| `/experiment` | ❌ 未注册 | 命令已实现，但未在 App.tsx import/注册 |
| `/schedule` | ❌ 未注册 | 命令已实现，但未在 App.tsx import/注册 |
| `/clarify` | ❌ 未注册 | 命令已实现，但未在 App.tsx import/注册 |
| `/rollback` | ✅ 已注册 | 已正确接入 |
| `/tech-debt` | ✅ 已注册 | 已正确接入 |

### 其他死代码

| 文件 | 函数/模块 | 说明 |
|------|---------|------|
| `cache-optimizer.ts` | `evictLeastUsed()` | 已定义从未调用 |
| `declarative-context.ts` | 整个模块 | Phase 30 陷阱 #22 明确标注"当前为死代码未接入生产路径" |
| `entity-state.ts` | `toPromptBlock()` | Phase 30 陷阱 #22 明确标注"当前为死代码未接入生产路径" |
| `TokenTracker` | `startTask()`/`recordTaskUsage()`/`endTask()` | 已定义但生产代码零调用（仅测试调用） |

---

## 八、前端交互体验优化点（重点）

以下汇总了用户在审查要求中特别强调的交互体验优化点：

### 必须修复（影响功能）

1. **Skill/MCP 状态栏关闭后无法重新打开**（ChatPage.tsx:1176）— 交互死胡同
2. **4 处 browser confirm() 阻塞 UI**（ChatPage.tsx）— 桌面应用使用浏览器弹窗
3. **SettingsPage 配置保存无视觉反馈** — 用户不知道修改是否生效
4. **自动滚动与手动查看历史冲突** — 新消息到来时强行拉回底部

### 强烈建议（提升体验）

5. **消息列表无虚拟化** — 长对话渲染性能差
6. **Tab 补全缺失一半命令** — 命令发现效率低
7. **工具确认期间 InputBox 状态混乱** — 用户不理解为什么输入被当作 y/n
8. **8 个命令缺少错误处理** — 异常时用户看到堆栈而非友好消息
9. **5 个组件缺少 Loading 状态** — DiffView/BranchSwitcher/TracePanel/ResumePicker/StatusBar
10. **ProjectSidebar 项目列表无搜索** — 项目多时难以定位
11. **NewTaskPage 缺少"最近使用的提示词"** — 重复输入相同任务描述
12. **TokenPage 图表缺少时间范围选择器** — 无法查看特定时间段的用量

---

## 九、与上次审计（2026-06-20）的差异

| 维度 | 上次审计 | 本次审计 | 变化 |
|------|---------|---------|------|
| 审查范围 | Phase 完成度核实 | 全量代码质量审查 | 从"是否实现"到"实现得如何" |
| Critical 问题 | 4 个死代码模块 | 16 项（含 4 个安全漏洞） | 深度不同 |
| Phase 31/32 | 确认 4 模块死代码 | 确认未变化 | 遗留问题仍在 |
| Phase 34 | 86%（Desktop 未适配） | 确认 Desktop 端问题更多 | 新增 5 个 Desktop 交互问题 |
| Phase 37 | 未审查（设计文档阶段） | 3 个命令未注册 | 新发现 |
| 安全层 | 未深入审查 | 6.0/10 评分，9 个安全问题（4 Critical + 5 Important） | 首次全面安全审查 |

---

## 十、修复优先级路线图

### 第一优先级（P0）— 阻塞性问题，立即修复

| 序号 | 编号 | 问题 | 预计工作量 |
|------|------|------|---------|
| 1 | C-12 | 3 个命令未注册（experiment/schedule/clarify） | 10 分钟（3 行 import + 3 行注册） |
| 2 | C-13 | /help 命令失效 | 5 分钟（1 行 deps 添加） |
| 3 | C-08 | Skill/MCP 状态栏无法恢复 | 15 分钟（添加入口按钮） |
| 4 | C-09 | mainWindow 非空断言 | 5 分钟（改可选链） |
| 5 | C-04 | 权限引擎 auto-file-wildcard | 10 分钟（配置修改） |

### 第二优先级（P1）— 发布前必须修复

| 序号 | 编号 | 问题 | 预计工作量 |
|------|------|------|---------|
| 6 | C-01 | loop.ts 并行模式 ask_user 拦截遗漏 | 1 小时 |
| 7 | C-02 | openai.ts tool_result 消息丢失 | 1 小时 |
| 8 | C-03 | PPR 传播方向 | 30 分钟 |
| 9 | C-05 | 文件工具内部路径边界检查 | 1 小时 |
| 10 | C-06 | MCP 环境变量泄露 | 1 小时 |
| 11 | C-07 | web_search SSRF 防护 | 1 小时 |
| 12 | C-15 | useEffect 依赖 ref.current | 30 分钟 |
| 13 | C-16 | Windows deny 规则 | 30 分钟 |
| 14 | C-14 | ConfirmDialog 倒计时不稳定 | 1 小时 |
| 15 | C-11 | 需求澄清回答映射 | 2 小时 |

### 第三优先级（P2）— 近期迭代修复

| 序号 | 编号 | 问题 | 预计工作量 |
|------|------|------|---------|
| 16 | C-10 | browser confirm() 替换 | 3 小时（含 Modal 组件） |
| 17 | A-01 | SettingsPage 拆分 | 1 天 |
| 18 | A-02 | ChatPage 拆分 | 半天 |
| 19 | I-19 | Tab 补全动态化 | 1 小时 |
| 20 | I-14/I-18 | 消息列表虚拟化 + 自动滚动优化 | 半天 |

---

## 十一、正面评价（值得肯定的设计）

1. **安全架构层次清晰** — SSRF 防护、7 层 bash 安全命令解析、时序安全签名验证、结果脱敏管道、读后写强制执行
2. **Token 追踪多维归因** — 按 Agent/步骤/模型/任务/会话 五个维度归因，粒度精细
3. **检查点双系统设计** — Git 快照（回滚用）+ 增量 Checkpoint（记忆用），职责分离
4. **配置验证严格** — Zod schema + 环境变量替换 fail-fast + 向后兼容预处理
5. **测试覆盖优秀** — 1735+ 测试，Phase 34 单个 Phase 就贡献了 68 个测试
6. **CSP 头配置完整** — Desktop 端的 Content Security Policy 正确配置
7. **contextIsolation + sandbox 正确启用** — Electron 安全最佳实践到位
8. **fs:read 三重防护** — 路径边界 → symlink 解析重校验 → 敏感文件过滤

---

> **审查结论：** RouteDev 的架构成熟度处于中上水平，核心能力（路由、Agent Loop、检查点、MCP）设计扎实。当前最大的系统性问题是"写好了但没接线"——Phase 31 的 4 个死代码模块和 Phase 37 的 3 个未注册命令都属于此类。建议下一个 Phase 的首要任务是修复 P0 级的 5 个阻塞性问题（预计总工作量不超过 1 小时），然后推进 SettingsPage/ChatPage 的拆分重构。
