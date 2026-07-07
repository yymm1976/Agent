# Phase 74：RouteDev 前端交互优化计划

> **输入**：竞品调研报告（12 产品） × 项目前端代码现状报告（49 文件/约 15544 行，2026-07-07 实测） × TRAE Skills 市场调研（frontend-design + ui-ux-pro-max） × huashu-design 方法论
>
> **日期**：2026-07-07（v3 修订：基于死代码清理后的实测数据重新校准）
>
> **目标**：将 RouteDev 前端从"能用但简陋"升级为"信息密度高、交互直觉、视觉有辨识度"的 AI 编程助手工作台

---

## 一、现状诊断（交叉分析）

### 1.1 核心矛盾

| 矛盾 | 现状 | 竞品对标 |
|------|------|----------|
| **后端能力强 vs 前端展示弱** | branch.ts 支持分支树/CompactionNode/BranchSummaryNode，前端无分支可视化 | ChatGPT 用 `< >` 箭头切换分支 |
| **工具调用丰富 vs 展示信息密度低** | 12 种工具，折叠后仅一行小字摘要 | Cursor/Windsurf 步骤行 + 状态徽章 + 关键参数可见 |
| **双队列已实现 vs 视觉无区分** | follow-up 与排队队列都是 History 图标 + 折叠列表 | 无竞品有此功能（RouteDev 独有），但需要自证 UI 设计 |
| **1652 行巨石 vs 组件化需求** | ChatPage.tsx 含 10+ 内部子组件未拆分（已较 v2 减少 91 行，但仍超阈值） | Cursor/Cline 都按功能域拆分独立组件 |

### 1.2 问题分类（30+ 项，按影响度排序）

**P0 — 用户可感知的体验短板（8 项）**

1. 命令输出无 ANSI 颜色解析（`\x1b[31m` 显示为乱码）
2. file_edit diff 无行级 diff、无语法高亮、无 accept/reject
3. file_read 结果折叠后不可见文件内容
4. 代码块主题不随应用主题切换（硬编码 oneDark）
5. follow-up 队列与排队队列视觉无区分
6. 流式输出无"正在思考"视觉指示
7. 滚动条完全隐藏，用户不知是否能滚
8. 思考步骤不解析 Markdown（`**重点**` 显示为纯文本）

**P1 — 工作流面板信息架构问题（6 项）**

9. 工具卡片折叠态信息密度过低（"执行了 3 条命令"无状态徽章）
10. 工具参数折叠态不可见（file_path/command 需展开才看到）
11. 子 Agent 活动仅文本日志（无进度可视化）
12. ExecutionProcess 折叠树视觉单调（全灰小字）
13. 长命令输出只保留前 5 行（丢失尾部结果）
14. 生成产物（file_write）只在 TaskMonitorPanel 列路径，无内联预览

**P2 — 会话管理缺失（5 项）**

15. 无分支可视化（fork 后看不出从哪分叉）
16. 对话列表信息少（无最近活跃/消息数/状态）
17. 无跨对话搜索
18. 检查点时间轴与对话无关联
19. fork 仅 hover 触发，发现性低

**P3 — 视觉设计系统问题（7 项）**

20. 无统一设计系统文档
21. className 超长字符串未抽象
22. shadcn/ui 风格组件仅 11 个（缺 Tooltip/Dropdown/Toast/Tabs）
23. 4 套主题不跟随系统偏好
24. 字号/间距无规范（text-xs/text-sm 混用）
25. 进度条/状态徽章/折叠面板等高频模式无封装
26. 动画系统零散（定义了关键帧但用得少）

**P4 — 工程结构问题（4 项）**

27. ChatPage.tsx 1652 行巨石（v2 时 1743 行，死代码清理后已减 91 行，但仍需拆分）
28. SettingsPage.tsx 5465 行巨石（v2 时 5673 行，已拆出 11 个 SettingsXxxTab.tsx 至 components/settings/，主页面仍含布局编排 + 状态管理 + 表单逻辑混杂；**Phase 74 范围外**，计划 Phase 75 处理主体进一步拆分）
29. 无虚拟列表（长对话全量渲染）
30. useRouteDev hook 无 selector 优化

---

## 二、设计方向（结合 huashu 三套逻辑 + frontend-design 反 slop）

### 2.1 设计哲学定位

RouteDev 是 **AI 编程助手工作台**，不是 SaaS 落地页。参考 huashu-design 的"信息密度分型"原则：

> 产品核心卖点是「智能 / 数据 / 上下文感知」时（AI 工具、Dashboard、Copilot），每屏需至少 3 处可见的产品差异化信息。

RouteDev 正是这一类型——**高密度信息型**，而非极简留白型。设计方向应追求：

- **信息密度 > 视觉留白**：但密度来自有内容的数据（工具状态、进度、参数），不是装饰性 icon
- **暗色为主**：开发者工具的默认选择，与代码编辑器视觉一致
- **一个 accent 色贯穿**：主色 `--rd-primary` 作为唯一强调色，状态色（绿/红/黄）仅用于状态指示
- **反 AI slop**（huashu-design + frontend-design 共同原则）：不用紫渐变、不用 emoji 图标、不用圆角卡片+左 border accent

### 2.2 三套设计方向（huashu Fallback 模式）

由于用户未指定具体风格参考，按 huashu-design 方法论给出 3 个差异化方向：

#### 方向 A：Terminal-Native（终端原生派）

- **参照案例**：Cursor + Warp Terminal
- **视觉 DNA**：等宽字体为主（JetBrains Mono）、暗色底、绿色 accent（终端感）、工具调用像 terminal 命令行输出
- **信息密度**：极高——每行都是有效信息，折叠态也展示关键参数
- **适合 RouteDev 的原因**：开发者受众、与代码编辑器视觉一致、工具调用天然适配 terminal 风格
- **风险**：过于硬核，非开发者用户门槛高

#### 方向 B：Structured-Panel（结构化面板派）

- **参照案例**：Windsurf Cascade + LangGraph Studio
- **视觉 DNA**：Thoughts/Actions 视觉分层、卡片化但非圆角、状态用边框颜色编码（非背景色）、右侧固定 Artifact 面板
- **信息密度**：中高——思考与动作分离，减少认知负担
- **适合 RouteDev 的原因**：已有 ToolCallCard/TaskMonitorPanel 基础、follow-up 队列天然适合面板化
- **风险**：面板过多可能拥挤

#### 方向 C：Conversation-First（对话优先派）

- **参照案例**：ChatGPT + Claude.ai
- **视觉 DNA**：对话流为核心、工具调用极简内联（一行摘要+展开）、分支用 `< >` 箭头、Artifacts 右侧面板
- **信息密度**：中——对话流干净，复杂信息按需展开
- **适合 RouteDev 的原因**：最接近用户已有的 ChatGPT/Claude 使用习惯
- **风险**：对多 Agent/多工具并行场景展示力不足

#### 推荐选择

**方向 B（Structured-Panel）** 作为主方向——RouteDev 有丰富的后端能力（双队列/分支树/多 Agent/检查点），需要面板化展示而非纯对话流。同时吸收方向 A 的 terminal 美学（暗色+等宽+高密度）和方向 C 的分支切换（`< >` 箭头）。

### 2.3 huashu-design 原则映射

| huashu 原则 | RouteDev 应用 |
|-------------|---------------|
| 反 AI slop | 不用紫渐变/emoji 图标/圆角卡片+左 border；用 lucide 线性图标 + 状态色编码 |
| Junior Designer 模式 | 先做 HTML 高保真原型 show 给用户，确认方向后再写 React 组件 |
| 3+ variations | 工具卡片/队列 UI/分支切换器各做 3 版变体对比 |
| 诚实 placeholder | 没有数据时显示"暂无"而非空卡片 |
| 一个细节做到 120% | 工具调用卡片做到极致（行级 diff + ANSI + 状态徽章 + 参数可见） |
| 高密度型信息密度 | 每屏 ≥ 3 处产品差异化信息（工具状态/进度/上下文 token） |

---

## 三、分阶段优化路线图

> **执行原则**：先建基础再造上层——先拆巨石（C）+ 先出最小设计 token（E-min），后续 Phase 在独立组件文件上操作，避免在 1652 行大文件里反复改。

### Phase 74-C：ChatPage 拆分 + 组件化 + 性能基座（P4，最先执行）

**目标**：1652 行巨石拆分为 ≤300 行的独立组件；同步建立虚拟滚动基座和细粒度状态订阅

**为什么最先执行**：后续所有 Phase（74-A 改 ToolCallCard、74-B 改队列 UI、74-D 加分支切换器）都需要在独立组件文件上操作。在 1652 行巨石里改组件，合并冲突和回归风险极高。先拆后改，效率和安全都更好。

**拆分方案**：

```
desktop/renderer/src/components/chat/
├── TaskBlock.tsx           — 单次任务的消息分组（~200 行）
├── MessageBubble.tsx       — 用户/助手消息气泡（~150 行）
├── ExecutionProcess.tsx    — 思考层 + 动作层折叠树（~250 行）
├── ToolCallCard.tsx        — 工具调用卡片（已在 components/ 下，461 行，保持位置，不移动）
├── InputArea.tsx           — 输入区 + 命令补全 + 自主度切换（~300 行）
├── FollowUpQueue.tsx       — Follow-up 队列 UI（~150 行）
├── PendingQueue.tsx        — 排队队列 UI（~100 行）
├── StreamIndicator.tsx     — 流式输出指示器（~50 行）
├── BranchSwitcher.tsx      — 分支切换器占位（为 74-D 预留，~30 行）
└── ScrollToBottom.tsx      — 跳到底部浮动按钮（~30 行）
```

ChatPage.tsx 仅保留布局编排 + 状态注入（目标 ≤ 300 行）

> **注**：ToolCallCard.tsx 当前已在 `components/ToolCallCard.tsx`（461 行），不在 ChatPage 内部，74-C 不需要"移入"，只需在 74-A 阶段直接在该文件上重构。74-C 拆分重点是 ChatPage 内部的 TaskBlock/MessageBubble/ExecutionProcess/InputArea/队列/指示器等子组件。

**性能基座（同步完成）**：

| # | 改动 | 说明 |
|---|------|------|
| C-V1 | TaskBlock 设计为虚拟滚动兼容结构 | 每个 TaskBlock 固定可测量高度，提供 `onVisible` 回调，为后续引入 `@tanstack/virtual` 或 `react-window` 做准备 |
| C-V2 | useRouteDev 细粒度 selector | 拆分后的子组件各自用 selector 订阅所需状态（如 `useRouteDev(state => state.followUpQueue)`），避免每次 store 变化全组件重渲染。当前无 selector 优化，长对话+流式输出场景下每次 token 推送都会触发全树 re-render |
| C-V3 | 拆分后逐组件回归验证 | 拆分前截图关键页面状态（空对话/长对话/多工具调用/双队列共存），拆分后逐组件对比验证渲染一致性 |

**huashu 验证方式**：拆分是纯重构，不涉及视觉变化，无需 huashu 原型。但拆分后应立即跑一轮视觉回归截图对比。

---

### Phase 74-E-min：最小设计 Token 集（P3 子集，与 74-C 并行）

**目标**：为后续 Phase 提供基础组件和 token，避免每个 Phase 各自内联 Tailwind 拼凑

**为什么提前到最前面**：74-A 的 StatusBadge、74-B 的队列卡片、74-D 的分支切换器都要用到 StatusBadge / FoldableSection / ToolIcon 等基础组件。如果先做 A/B 再补 E，等于先写业务代码再造轮子。

**改动清单（仅最小集）**：

| # | 改动 | 文件 |
|---|------|------|
| E1 | 抽象 StatusBadge（success/error/pending/running 四态） | components/ui/status-badge.tsx |
| E2 | 抽象 FoldableSection（可折叠面板，支持 header slot） | components/ui/foldable-section.tsx |
| E3 | 抽象 ToolIcon（按工具类型着色，lucide 图标映射） | components/ui/tool-icon.tsx |
| E4 | 设计 token CSS 变量补全（字号/间距/状态色） | index.css |
| E5 | 滚动条从完全隐藏改为细半透明条 | index.css |

**Phase 74-E 剩余项（完整版，在后续阶段按需执行）**：

| # | 改动 | 文件 | 执行时机 |
|---|------|------|----------|
| E6 | 补齐 shadcn/ui 组件（Tooltip / Dropdown / Toast / Tabs / Popover） | components/ui/ | 按需随 A/B/D/F 补充 |
| E7 | 设计 token 文档化（完整规范文档） | 新建设计-token.md | 所有 Phase 完成后统一整理 |
| E8 | 主题跟随系统偏好（prefers-color-scheme） | useTheme.ts | 可独立执行 |
| E9 | className 超长字符串抽象为复合组件或 @apply | 全局 | 随各 Phase 顺带清理 |
| E10 | 流式输出加"正在思考"脉动指示器 | StreamIndicator.tsx | 随 74-A 的 A9 一起 |
| E11 | 加载态从单 spinner 升级为 Skeleton | components/ui/ | 按需 |

**额外收益（v3 修订补充）**：当前 `components/settings/` 下已有 11 个 SettingsXxxTab.tsx 子组件（SettingsGoalTab/SettingsPersonaTab/SettingsDelegationTab/SettingsExperimentTab/SettingsConversationTab/SettingsReviewerTab/SettingsVoiceTab/SettingsConfigLayeringTab/SettingsPhase52IntegrationTab/SettingsPhase53IntegrationTab/SettingsResultSchemaTab）。E1/E2 抽象完成后，可顺带让这些 Tab 组件复用 StatusBadge / FoldableSection，统一它们内部的状态展示与折叠模式（目前各 Tab 内联实现，存在重复）。此清理可作为 74-E-min 的可选项，不阻塞后续 Phase。

---

### Phase 74-A：工具调用卡片重构（P0+P1，最高用户感知 ROI）

**目标**：工具调用从"一行小字"升级为"信息密度高、可操作、视觉有层次"的卡片

**前提**：74-C 拆分完成（在独立的 ToolCallCard.tsx 上操作）、74-E-min 完成（使用 StatusBadge / ToolIcon / FoldableSection）

**改动清单**：

| # | 改动 | 文件 | 对标竞品 |
|---|------|------|----------|
| A1 | 命令输出加 ANSI 颜色解析 | ToolCallCard.tsx / CommandOutput | Cline |
| A2 | 命令输出改为头尾保留（头 3 行 + 尾 5 行 + 中段折叠） | ToolCallCard.tsx / CommandOutput | Windsurf/Cursor |
| A3 | file_edit diff 升级为行级 diff + 语法高亮 | ToolCallCard.tsx / FileEditDiff | Cline/Windsurf |
| A4 | file_edit 每个 diff 加 accept/reject 按钮 | ToolCallCard.tsx / FileEditDiff + **新 IPC + engine-bridge.ts** | Windsurf/Cline |
| A5 | 折叠态加状态徽章（✓ 3 / ✗ 1 / ⟳ 2） | ToolCallCard.tsx / ActionSummaryRow（复用 E1 StatusBadge） | Cursor |
| A6 | 折叠态显示关键参数（file_path / command 预览） | ToolCallCard.tsx / ActionSummaryRow | Cursor/Windsurf |
| A7 | 工具图标按类型着色（read=蓝/edit=橙/shell=绿/agent=紫） | ToolCallCard.tsx（复用 E3 ToolIcon） | Windsurf |
| A8 | 执行中加 shimmer 边框动效 | ToolCallCard.tsx + index.css | Windsurf |
| A9 | 思考步骤解析 Markdown | ExecutionProcess.tsx ThinkingStepRow | - |
| A10 | 代码块主题跟随应用主题 | MarkdownRenderer.tsx | - |

**A4 后端依赖说明**：

accept/reject 不是纯前端改动。需要：
- 后端新增 IPC channel：`file-edit:apply-diff` 和 `file-edit:revert-diff`（接受单条 diff 或拒绝单条 diff）
- engine-bridge.ts 新增对应 handler：需要访问文件系统，处理文件已被外部修改的冲突场景（先检查文件 hash 是否与 diff 基线一致）
- 前端在 accept/reject 后需要刷新 diff 显示（标记已应用/已拒绝的状态）

预估后端工作量：~100 行 engine-bridge.ts 代码 + 新 IPC 定义。建议在 74-A 开工前先完成后端 IPC 部分。

**新依赖（已选定）**：

| 库 | 版本建议 | 选择理由 |
|----|----------|----------|
| `diff-match-patch`（Google） | latest | 纯计算库（~50KB），不绑定 React 渲染，UI 可完全自定义（适配 Terminal 或 Card 风格）。`react-diff-viewer-continued` 自带 UI 但定制成本高，不适合多风格需求 |
| `ansi_up` | latest | 更小（~8KB）、默认 XSS 安全、零依赖、活跃维护。`ansi-to-html` 体积更大且无 XSS 防护 |

**无障碍要求**：

- 所有新增交互元素（accept/reject 按钮、折叠展开切换、状态徽章）必须有 `aria-label`
- accept/reject 按钮支持键盘 Tab 聚焦 + Enter/Space 触发
- 折叠面板使用 `aria-expanded` 属性
- 工具卡片整体使用 `role="group"` + `aria-label` 描述工具类型和状态

**huashu 验证方式**：先用 huashu-design 做 3 版工具卡片 HTML 原型（Terminal 风格 / Card 风格 / Hybrid 风格），用户选定后再实现 React 组件

**预计影响**：ToolCallCard.tsx 从 461 行拆分为 `ToolCallCard / FileEditDiff / CommandOutput / ToolStatusBadge` 4 个独立文件（74-C 已完成拆分），74-A 在此基础上增强各子组件

---

### Phase 74-B：Follow-up 队列视觉重构（P0）

**目标**：follow-up 队列与排队队列视觉明确区分，出队模式直觉化

**前提**：74-C 拆分完成（在独立的 FollowUpQueue.tsx / PendingQueue.tsx 上操作）

> **注意**：B1-B6 为纯前端视觉改动，不依赖 InputArea 拆分（74-C 已完成）。B7 需要新 IPC，标注为 B 阶段末尾单独处理。

**改动清单**：

| # | 改动 | 文件 | 依赖 |
|---|------|------|------|
| B1 | follow-up 队列换图标（GitBranch / ListPlus 替代 History） | FollowUpQueue.tsx | 无 |
| B2 | follow-up 队列条目卡片化（左侧色条 + 序号 + 文本 + 删除） | FollowUpQueue.tsx | 无 |
| B3 | 排队队列与 follow-up 分区展示（"待发送" vs "Agent 完成后接续"） | ChatPage.tsx 布局层 | 无 |
| B4 | 出队模式切换器加说明文案 + tooltip | InputArea.tsx | E6 Tooltip 组件 |
| B5 | 队列空时加引导文案（"Agent 工作时输入即可加入后续队列"） | FollowUpQueue.tsx / PendingQueue.tsx | 无 |
| B6 | "加入后续"按钮位置调整（与"停止"分开，加视觉区分） | InputArea.tsx | 无 |
| B7 | follow-up 队列条目支持编辑（与排队队列行为一致） | FollowUpQueue.tsx + **新 IPC** | 需后端支持 |

**B7 后端依赖说明**：编辑队列条目需要新 IPC channel 允许前端更新队列中指定条目的文本内容。预估 ~30 行后端代码。

**无障碍要求**：

- 队列条目使用 `role="listitem"`，支持键盘 Tab 导航 + Delete 键删除
- 空队列引导文案使用 `aria-live="polite"` 在状态变化时通知屏幕阅读器
- 出队模式切换器使用 `role="radiogroup"` + `aria-label`

**huashu 验证方式**：用 huashu-design 做 3 版队列 UI 布局（侧边栏式 / 浮层式 / 内联式）

---

### Phase 74-D：分支可视化 + 会话管理（P2）

**目标**：后端分支能力前端可见化

**分支定义澄清**：本节"分支"特指 **对话分支**（branch.ts 后端的 BranchNode/CompactionNode/BranchSummaryNode，由用户 fork 消息产生），**不是多 Agent 分支编排**。后者（branch-orchestrator.ts）已于 Phase 74 前置清理中删除（commit bad0859），与本节无关。

**前提**：74-C 拆分完成（BranchSwitcher.tsx 已预留占位）

**改动清单**：

| # | 改动 | 文件 | 对标竞品 |
|---|------|------|----------|
| D1 | 分支消息顶部加 `< >` 箭头切换器 + "分支 2/3" | BranchSwitcher.tsx（74-C 已预留） | ChatGPT |
| D2 | 对话列表加最近活跃时间 + 消息数 | ProjectSidebar.tsx | Cursor |
| D3 | fork 入口从 hover 改为消息右键菜单 + 工具栏按钮 | MessageBubble.tsx 的 ContextMenu | - |
| D4 | 检查点时间轴关联到具体消息（点击消息高亮对应检查点） | CheckpointTimeline.tsx | Roo Code |
| D5 | 对话列表加"分支自 xxx"标识 | ProjectSidebar.tsx | - |

**huashu 验证方式**：用 huashu-design 做 3 版分支切换器（箭头式 / Tab 式 / 面包屑式）

---

### Phase 74-F：生成产物面板（P1，差异化能力）

**目标**：file_write 生成的代码/HTML/Markdown 右侧面板实时预览

**前提**：74-E-min 的 FoldableSection 可用；74-A 的工具卡片已完成

**改动清单**：

| # | 改动 | 文件 | 对标竞品 |
|---|------|------|----------|
| F1 | 新建 ArtifactPanel 组件（右侧可折叠面板） | 新建 ArtifactPanel.tsx | Claude Artifacts |
| F2 | file_write 工具结果在 ArtifactPanel 中预览（代码高亮/HTML 渲染/Markdown 渲染） | ArtifactPanel.tsx | Claude/v0 |
| F3 | 同一文件多次编辑时按版本 tab 切换 | ArtifactPanel.tsx | Claude |
| F4 | Artifact 支持 copy / download / open-in-editor | ArtifactPanel.tsx + IPC（open-in-editor 需后端） | Claude |
| F5 | TaskMonitorPanel "产物" tab 与 ArtifactPanel 联动 | TaskMonitorPanel.tsx | - |

**F4 后端依赖说明**：`open-in-editor` 功能需要新 IPC channel 调用系统默认编辑器打开指定文件+行号（`shell.openPath` 或 VS Code `--goto` 参数）。

---

## 四、执行优先级与依赖关系

```
Phase 74-C（ChatPage 拆分 + 性能基座）
    ↓
Phase 74-E-min（最小设计 Token 集）← 与 74-C 并行
    ↓
Phase 74-A（工具卡片重构）+ Phase 74-B（队列 UI 重构）← 并行，均在独立组件上操作
    ↓
Phase 74-D（分支可视化）+ Phase 74-E 完整版（设计系统补全）← 并行
    ↓
Phase 74-F（产物面板）
```

**推荐执行顺序**：

1. **74-C + 74-E-min**（并行：拆巨石 + 出最小设计 token）— 建基础
2. **74-A + 74-B**（并行：工具卡片 + 队列 UI）— 最高用户感知 ROI
3. **74-D + 74-E 完整版**（并行：分支可视化 + 设计系统补全）— 差异化功能
4. **74-F**（产物面板）— 锦上添花

**每步前置条件检查**：

| 步骤 | 前置条件 | 验证方式 |
|------|----------|----------|
| 74-C | ChatPage.tsx 构建通过 + 应用启动正常 | `npm run build` + 手动启动验证 |
| 74-E-min | 74-C 拆分完成 | 组件文件存在 + import 无报错 |
| 74-A | 74-C 完成 + A4 后端 IPC 就绪 | IPC handler 单元测试通过 |
| 74-B | 74-C 完成 | FollowUpQueue.tsx / PendingQueue.tsx 独立存在 |
| 74-D | 74-C 完成 + BranchSwitcher 占位就绪 | 占位组件可渲染 |
| 74-F | 74-A 完成 + FoldableSection 可用 | ArtifactPanel 挂载无报错 |

---

## 五、huashu-design 验证流程

每个 Phase 实现前，用 huashu-design 做 HTML 高保真原型验证：

### 5.1 工具卡片原型（Phase 74-A）

1. 用 huashu-design 做一个 HTML 页面，展示 3 种风格的工具调用卡片：
   - Terminal 风格：等宽字体 + 暗底 + ANSI 色彩 + 状态点
   - Card 风格：圆角卡片 + 图标着色 + 状态徽章 + 参数预览
   - Hybrid 风格：Card 外壳 + Terminal 内核（折叠展开后是 terminal 风格）
2. 每种风格包含：file_read / file_edit / shell_exec / spawn_agent 4 种工具的展示
3. 每种工具包含：折叠态 + 展开态 + 执行中 + 错误 4 种状态
4. 用户选定后，用该风格实现 React 组件

### 5.2 队列 UI 原型（Phase 74-B）

1. 用 huashu-design 做 3 种队列布局：
   - 侧边栏式：队列在输入区右侧垂直列表
   - 浮层式：队列在输入区上方浮层卡片
   - 内联式：队列在对话流中以内联卡片展示
2. 包含：空队列 / 1 条 / 3 条 / 双队列共存 4 种状态

### 5.3 分支切换器原型（Phase 74-D）

1. 用 huashu-design 做 3 种分支 UI：
   - 箭头式：`< 分支 2/3 >`（ChatGPT 风格）
   - Tab 式：`[原始] [分支 1] [分支 2]`（Cursor 风格）
   - 面包屑式：`对话 > 分支 2 > 当前`

---

## 六、Skills 市场参考

### 6.1 Anthropic frontend-design skill

- **来源**：https://github.com/anthropics/skills/tree/main/skills/frontend-design
- **核心理念**：反 AI slop、独特美学方向、生产级代码、每个设计都不一样
- **可借鉴点**：
  - "Choose a clear conceptual direction and execute it with precision" → RouteDev 选择 Structured-Panel 方向并精确执行
  - "Dominant colors with sharp accents outperform timid, evenly-distributed palettes" → 一个主色 + 状态色，不要彩虹
  - "One well-orchestrated page load creates more delight than scattered micro-interactions" → 一次编排好的加载动画 > 散落的微交互

### 6.2 ui-ux-pro-max skill

- **来源**：https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- **核心理念**：跨平台 UI/UX 规范、色彩系统、字体搭配、UX 规范
- **可借鉴点**：
  - 色彩系统分层（主色/辅色/状态色/背景色）
  - 字体配对规范（display + body）
  - 间距/圆角/阴影的 token 化

### 6.3 huashu-design skill（本地已有）

- **路径**：`c:\Users\杨铭\.trae-cn\skills\huashu-design`
- **核心理念**：HTML 高保真原型、三套逻辑变体探索、反 AI slop、5 维度评审
- **使用方式**：
  - 每个 Phase 实现前，调用 huashu-design 做 HTML 原型
  - 用"设计方向顾问"模式产出 3 版变体
  - 用"5 维度评审"模式验证实现质量

---

## 七、成功度量

| 指标 | 现状（v3 实测） | 目标 |
|------|------|------|
| ChatPage.tsx 行数 | 1652 | ≤ 300（拆分后） |
| renderer 总文件数 | 49 | 60+（含拆分+新增） |
| shadcn/ui 组件数 | 11 | 18+（补齐 Tooltip/Dropdown/Toast/Tabs/Popover/Skeleton） |
| settings/ Tab 子组件数 | 11（已抽离） | 11（保持，复用 E1/E2 抽象） |
| 工具卡片信息密度（折叠态可见字段） | 1（摘要文字） | 4+（摘要+状态徽章+参数预览+工具图标） |
| ANSI 颜色支持 | 否 | 是 |
| 行级 diff | 否 | 是 |
| accept/reject 按钮 | 否 | 是 |
| 分支可视化 | 否 | 是（`< >` 箭头，对话分支非多Agent分支） |
| 主题跟随系统 | 否 | 是 |
| 滚动条可见 | 否 | 是（细半透明） |
| 产物预览面板 | 否 | 是 |
| 长对话（200+ 消息）滚动帧率 | 未测量（全量渲染） | ≥ 30fps（虚拟滚动启用后） |
| 流式输出时不必要 re-render | 全树 re-render | 仅目标子组件 re-render（selector 优化后） |

---

## 八、风险与约束

| 风险 | 缓解措施 |
|------|----------|
| 拆分 ChatPage 引入回归 | 拆分前截图 4 种关键页面状态（空对话/长对话/多工具/双队列），拆分后逐组件视觉回归对比 |
| 新依赖增加 bundle 体积 | diff-match-patch（~50KB gzipped ~15KB）/ ansi_up（~8KB gzipped ~3KB）影响可控 |
| Electron 34 兼容性 | 已验证构建通过 + 应用启动正常 |
| huashu 原型与 React 实现差距 | 原型仅验证视觉方向，实现时以现有 Tailwind + shadcn 体系为准 |
| 用户可能不满意方向 B | 三套方向原型先行，用户选定后再实现 |
| A4/F4/B7 需要后端 IPC | 在每个前端 Phase 开工前，先完成后端 IPC 部分（预估 A4 ~100 行、B7 ~30 行、F4 ~20 行） |
| SettingsPage.tsx 5465 行（已拆出 11 个 Tab，主体仍为巨石；本轮不处理） | 记录为 Phase 75 范围，本轮不触碰 SettingsPage 主体代码；74-E-min 抽象的 StatusBadge/FoldableSection 可顺带被 settings/ Tab 复用 |

---

## 九、Phase 74 范围外（记录备忘）

| 项目 | 说明 | 计划处理 |
|------|------|----------|
| SettingsPage.tsx 5465 行主体 | 已拆出 11 个 Tab 至 components/settings/，主体仍含布局+状态+表单逻辑混杂；改动频率低、用户感知弱 | Phase 75 |
| 完整无障碍审计 | 新增交互元素在 74 内做基本 ARIA，全量审计延后 | Phase 75 |
| 跨对话搜索（P2 #17） | 需要全文索引基础设施 | Phase 75+ |

---

## 十、v3 修订摘要（2026-07-07）

本次修订基于死代码清理（commit eb2528b + bad0859）后的实测数据，对 v2 计划进行校准。变更点：

1. **行数数据全面更新**（实测 2026-07-07）：
   - ChatPage.tsx：1743 → 1652（-91 行，死代码清理收益）
   - ToolCallCard.tsx：499 → 461（-38 行）
   - SettingsPage.tsx：5673 → 5465（-208 行）
   - renderer 总文件数：42 → 49（含 settings/ 11 个 Tab 子组件）
   - 总行数：14874 → 约 15544（文件数增加但单文件行数减少，整体略增）

2. **74-D 分支定义澄清**：明确"分支"指对话分支（branch.ts 的 BranchNode/CompactionNode/BranchSummaryNode，fork 产生），不是多 Agent 分支编排。后者（branch-orchestrator.ts）已于 commit bad0859 删除。

3. **74-C 拆分方案修正**：ToolCallCard.tsx 当前已在 `components/ToolCallCard.tsx`（461 行），不在 ChatPage 内部，74-C 不需要"从 components/ 移入"，保持位置即可。74-C 拆分重点是 ChatPage 内部的 TaskBlock/MessageBubble/ExecutionProcess/InputArea/队列/指示器等子组件。

4. **74-E-min 额外收益补充**：当前 `components/settings/` 下已有 11 个 SettingsXxxTab.tsx 子组件，E1/E2 抽象完成后可顺带让这些 Tab 复用 StatusBadge / FoldableSection，统一内联实现。

5. **P4 第 28 项更新**：SettingsPage.tsx 已部分拆分（11 个 Tab），主体仍为巨石，Phase 75 处理主体进一步拆分。

6. **成功度量表更新**：增加"settings/ Tab 子组件数"指标，明确分支可视化指对话分支。

---

*本计划基于：竞品调研（12 产品）× 项目现状（49 文件/约 15544 行，2026-07-07 实测）× Skills 市场（frontend-design + ui-ux-pro-max）× huashu-design 方法论综合制定。v2 修订：优化执行顺序（先拆后改）、提前设计 token、补充后端 IPC 依赖、补充性能指标、补充无障碍要求。v3 修订：基于死代码清理后的实测数据重新校准行数与文件数、明确分支定义、修正 74-C 拆分方案、补充 settings/ Tab 复用收益。*
