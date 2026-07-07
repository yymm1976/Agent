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

### Phase 74-G：SettingsPage 主体拆分（P4，原 Phase 75 范围移入）

**目标**：5465 行主体拆分为 ≤400 行的编排页 + 独立 Tab 组件 + 状态 hook，与 74-C 同构但独立执行

**为什么从 Phase 75 移入**：用户明确要求不留技术债到下一 Phase。SettingsPage 已部分拆分（11 个 Tab 抽出），但主体仍含 5343 行主组件 + 110 行 ArchivedConversationsPanel，单文件行数远超健康阈值。继续推迟只会让债务滚雪球。

**前提**：74-E-min 完成（StatusBadge / FoldableSection 可被新 Tab 复用）；与 74-C/A/B/D/F 完全独立，可在任意阶段并行启动

**实测结构分析**（基于子 Agent 调研，2026-07-07）：

| 区段 | 行号范围 | 行数 | 职责 |
|------|----------|------|------|
| import + 类型 + 常量 | 1–216 | 216 | 28 个 Tab id 联合类型、AgentProfileUI、3 个内置 Profile、9 个搜索引擎等 |
| 主组件 `SettingsPage` | 218–5561 | 5343 | 40 个 useState + 10 个 useEffect + 50 个 update* 函数 + 15 个 IPC handler + 28 个 Tab 内容 JSX |
| └ 状态声明 | 219–290 | 72 | 40 个 useState + 4 个 useRef，**0 个 useMemo/0 个 useCallback** |
| └ 副作用 | 293–373 | 81 | 10 个 useEffect（自动保存 700ms 防抖 / 主题预览 / Tab 懒加载） |
| └ Skills/Hooks 异步 handler | 376–562 | 187 | 11 个 handler 直接调 `window.routedev.skill.* / hook.*` |
| └ `update*` 系列 patch 函数 | 564–1002 | 439 | 50 个 `setDraft({ ...draft, xxx: { ...patch } })` 样板 |
| └ handleExport/Import/Save | 1014–1160 | 147 | 含 58 行清理逻辑（过滤空 provider/model、修复路由规则） |
| └ mainTabs/advancedTabs 定义 | 1142–1176 | 35 | 20 + 10 个 Tab 元数据 |
| └ 渲染 JSX | 1178–5560 | 4382 | header(25) + toast(18) + nav(60) + 28 个 Tab 内容区 |
| 底部 `ArchivedConversationsPanel` | 5563–5673 | 110 | 独立 function，已与主组件解耦，仅物理位置同文件 |

**现有 11 个抽离 Tab 调用模式**：全部 "props 传整个 draft + updateDraft 回调"，无各自 hook 订阅，无 `React.memo`。新抽 Tab 沿用此契约，渐进迁移。

**拆分方案**：

```
desktop/renderer/src/
├── pages/
│   └── SettingsPage.tsx           — 仅保留布局编排 + Tab 路由 + 全局状态注入（目标 ≤ 400 行）
├── components/settings/
│   ├── [现有 11 个 SettingsXxxTab.tsx 保持不变]
│   ├── SettingsHeader.tsx          — 顶部工具栏（标题+关闭+导入/导出+saving 指示，~30 行）
│   ├── SettingsNav.tsx             — 左侧 Tab 导航（mainTabs + advancedTabs 折叠，~100 行）
│   ├── SaveToast.tsx               — 保存提示浮层（3s 消失，~25 行）
│   ├── SettingsProvidersTab.tsx    — 模型配置（~220 行）+ ModelEditorModal.tsx
│   ├── SettingsRouterTab.tsx       — 路由规则（~240 行）
│   ├── SettingsSecurityTab.tsx     — 安全设置（~460 行，最大块之一）
│   ├── SettingsCommandsTab.tsx     — 命令与工具黑白名单（~220 行）
│   ├── SettingsOptimizationTab.tsx — 可观测性（~180 行）
│   ├── SettingsExecutionTab.tsx    — 执行配置（~170 行）
│   ├── SettingsMemoryTab.tsx       — 记忆与检查点（~290 行）
│   ├── SettingsMcpTab.tsx          — MCP + 插件市场（~430 行）+ McpMarketModal.tsx
│   ├── SettingsSkillsTab.tsx       — Skills 管理（~310 行）+ SkillAiGenerateDialog.tsx
│   ├── SettingsChannelsTab.tsx     — 渠道集成（~300 行）+ ChannelCredsEditor.tsx
│   ├── SettingsAppearanceTab.tsx   — 外观（~310 行）
│   ├── SettingsHooksTab.tsx        — Hooks 管理（~140 行）+ HookAiGenerateDialog.tsx
│   ├── SettingsCodemapTab.tsx      — 代码地图（~130 行）
│   ├── SettingsPoliciesTab.tsx     — 策略引擎（~120 行）
│   ├── SettingsSubAgentsTab.tsx    — 子 Agent Profile（~550 行，最大块，可再拆 ProfileCard/GateRules）
│   ├── SettingsArchivedTab.tsx     — 归档对话（物理迁移 ArchivedConversationsPanel，~110 行）
│   └── [小块合并] SettingsAboutTab.tsx + SettingsSoundsTab.tsx + SettingsExpertiseTab.tsx + SettingsMarketTab.tsx（各 50–95 行）
└── hooks/
    ├── useSettingsDraft.ts         — 50 个 update* 函数收到此 hook，返回 { draft, setDraft, updateDraft, updateProvider, ... }（~450 行）
    ├── useSkillsManager.ts         — Skills 7 个异步 handler 封装 window.routedev.skill.*（~90 行）
    ├── useHooksManager.ts          — Hooks 5 个异步 handler 封装 window.routedev.hook.*（~120 行）
    ├── useMcpCatalog.ts            — MCP catalog 3 个 handler 封装（~60 行）
    └── useAutoSave.ts              — 自动保存 700ms 防抖 + 主题预览 + Tab 懒加载副作用（~80 行）
```

**纯函数迁移到 settings-helpers.ts**（已有 266 行，继续扩展）：

| # | 改动 | 说明 |
|---|------|------|
| G-H1 | `cleanDraftForSave(draft)` | 从 handleSave 抽出 58 行清理逻辑（过滤空 provider/model、修复路由规则 modelId、过滤 fallbackChain），最易单测 |
| G-H2 | `constructProviderEntry / constructModelEntry` | Provider/Model 表单→config 构造（与现有 constructMcpServer 同模式） |
| G-H3 | `validateDraft(draft)` | 保存前校验（provider 必填 name、model 必填 modelId 等） |

**改动清单**：

| # | 改动 | 文件 | 优先级 |
|---|------|------|--------|
| G1 | 物理迁移 `ArchivedConversationsPanel` 到独立文件 | 新建 SettingsArchivedTab.tsx | P0（最易，已自包含） |
| G2 | 抽 `cleanDraftForSave` 纯函数到 settings-helpers | settings-helpers.ts | P0（最易单测） |
| G3 | 抽 `useSettingsDraft` hook（50 个 update* 函数） | hooks/useSettingsDraft.ts | P0（消除 439 行样板） |
| G4 | 抽 `useAutoSave` hook（自动保存 + 主题预览 + Tab 懒加载） | hooks/useAutoSave.ts | P1 |
| G5 | 抽 `useSkillsManager` / `useHooksManager` / `useMcpCatalog` | hooks/*.ts | P1（封装 15 处 IPC） |
| G6 | 抽 `SettingsHeader` / `SettingsNav` / `SaveToast` 三件套 | components/settings/*.tsx | P1（消除 138 行布局内联） |
| G7 | 抽 7 个大型 Tab（subagents/security/mcp/skills/appearance/channels/memory，共 ~2595 行） | components/settings/*.tsx | P1（抽完后主体减半） |
| G8 | 抽 8 个中小型 Tab（providers/router/commands/optimization/execution/hooks/codemap/policies） | components/settings/*.tsx | P2 |
| G9 | 抽 4 个小块 Tab（sounds/about/expertise/market） | components/settings/*.tsx | P2（可合并到一个 SettingsMiscTabs.tsx） |
| G10 | 11 个现有 Tab 复用 74-E-min 的 StatusBadge / FoldableSection | components/settings/SettingsXxxTab.tsx | P2（与 74-E-min 联动） |

**huashu 验证方式**：拆分是纯重构，不涉及视觉变化，无需 huashu 原型。但拆分后应立即跑一轮视觉回归截图对比（与 74-C 的 C-V3 同模式）。

**预计影响**：SettingsPage.tsx 从 5465 行降至 ≤ 400 行；新增 19+ 个 Tab 组件 + 5 个 hook + settings-helpers 扩展 ~100 行。总代码行数因样板消除略减（预估 -300 行）。

**风险与缓解**：

| 风险 | 缓解 |
|------|------|
| 50 个 update* 函数迁移到 hook 后行为变化 | 抽离后逐函数对比 `setDraft` 调用前后状态，保留旧函数签名向后兼容 |
| 15 处 window.routedev.* 调用迁移到 hook 后时机变化 | hook 内 useEffect 依赖数组严格对齐原 SettingsPage，不引入新触发点 |
| 大量 Tab 抽离后 Tab 切换视觉抖动 | 沿用现有 `absolute inset-0 overflow-y-auto` 容器，保持切换动画一致 |
| ArchivedConversationsPanel 物理迁移后 zustand store 引用断裂 | 仅改 import 路径，不改 store 订阅逻辑 |

---

### Phase 74-H：跨对话搜索（P2 #17，原 Phase 75+ 范围移入）

**目标**：在 ProjectSidebar 加搜索框，支持跨项目/跨对话的关键词搜索 + 结果列表 + 高亮跳转

**为什么从 Phase 75+ 移入**：用户明确要求不留技术债到下一 Phase。调研确认此功能可纯渲染层实现，零新增依赖、零 IPC 改动、零主进程修改，工作量 1–2 人日。

**前提**：与 74-D 的对话列表增强（D2/D5）协同，建议在 74-D 完成后启动；不依赖 74-C

**实测基础设施分析**（基于子 Agent 调研，2026-07-07）：

| 项 | 现状 | 评估 |
|----|------|------|
| 数据源 | `useProjectsStore.projects[].conversations[].messages[]` 已在渲染层内存（localStorage 反序列化） | ✅ 就绪 |
| 检索算法 | `src/memory/bm25-index.ts`（Phase 65，138 行）含 CJK bigram 分词 + 标准 BM25 公式 | ✅ 可复用 |
| UI 落点 | ProjectSidebar.tsx 顶部"设置/标题/缩进"行下方天然有插入空间 | ✅ 清晰 |
| IPC 通道 | 无 `conversation:search` 通道，但**纯渲染层实现不需要** | ✅ 零改动 |
| npm 包 | 未安装 lunr/fuse.js/flexsearch，但 BM25Index 已自研 | ✅ 零新增 |

**拆分方案**：

```
desktop/renderer/src/
├── store/
│   └── useSearchStore.ts          — 新建搜索 store（搜索结果状态 + searchConversations action，~120 行）
├── components/
│   └── SearchInput.tsx            — 搜索输入框 + 200ms debounce + 结果列表渲染（~180 行）
└── [复用] src/memory/bm25-index.ts — 直接 import BM25Index + tokenize（不动）
```

**改动清单**：

| # | 改动 | 文件 | 依赖 |
|---|------|------|------|
| H1 | 新建 `useSearchStore`：定义 `SearchResultHit` 类型 + `searchConversations(query, options)` action | store/useSearchStore.ts | 无 |
| H2 | 实现 BM25 索引 + 搜索：遍历 projects → conversations → messages，拼装 `BM25Doc[]`，索引 + search top 50 | store/useSearchStore.ts | bm25-index.ts |
| H3 | snippet 截取：命中前后 60 字上下文，`String.prototype.split` + `RegExp.escape` | store/useSearchStore.ts | 无 |
| H4 | ProjectSidebar 顶部插入搜索输入框（聚焦+有内容时替换 projects.map 为搜索结果列表） | components/ProjectSidebar.tsx | E6 Input 组件（已有） |
| H5 | 搜索结果项渲染：`项目名 / 对话标题` + `<mark>` 高亮 snippet | components/ProjectSidebar.tsx | 无 |
| H6 | 点击结果 → `selectConversation(projectId, convId)` + `onNavigateToChat()` + 清空搜索 | components/ProjectSidebar.tsx | 无 |
| H7 | 200ms debounce（useEffect + setTimeout，不引入 lodash） | components/ProjectSidebar.tsx | 无 |
| H8 | 索引缓存：`useMemo` 缓存 BM25Index 实例，仅在 projects 变化时重建 | store/useSearchStore.ts | 无 |

**降级方案**：若 BM25 索引性能不达预期（>1000 对话时），降级为 `content.toLowerCase().includes(query.toLowerCase())` 纯字符串匹配。

**无障碍要求**：

- 搜索输入框 `role="searchbox"` + `aria-label="搜索对话"`
- 结果列表 `role="listbox"`，每项 `role="option"` + `aria-selected`
- 输入框支持 `Esc` 清空、`↑↓` 选择、`Enter` 跳转

**huashu 验证方式**：用 huashu-design 做 3 版搜索 UI（顶部搜索栏 / 命令面板式 ⌘K / 侧边栏折叠式）

**预计影响**：ProjectSidebar.tsx 从 432 行增至 ~500 行（+搜索 UI）；新建 useSearchStore.ts ~120 行；零新增依赖。

**范围限定（Phase 74 不做）**：

- ❌ 不搜 `branch-persistence.ts` 落盘的 `tree.jsonl`（需新增 IPC + 数据源映射，留给后续）
- ❌ 不做 Web Worker 异步索引（当前规模无必要）
- ❌ 不做中文分词增强（jieba-wasm 等，CJK bigram 已够用）
- ❌ 不迁移 localStorage 到主进程文件存储（独立基础设施演进项）

---

### Phase 74-I：完整无障碍审计与修复（P3，原 Phase 75 范围移入）

**目标**：对 74-A/B/D/F/G/H 新增的所有交互元素做完整 ARIA 审计 + 键盘导航验证 + 屏幕阅读器测试

**为什么从 Phase 75 移入**：74 各子 Phase 已在改动清单中标注"基本 ARIA"，但分散实现易遗漏。统一审计作为收尾步骤，确保整个 Phase 74 交付物达到 WCAG 2.1 AA 基线。

**前提**：74-A/B/D/F/G/H 全部完成

**改动清单**：

| # | 改动 | 范围 | 验证方式 |
|---|------|------|----------|
| I1 | 审计 74-A 工具卡片的 accept/reject/折叠/状态徽章 ARIA | ToolCallCard.tsx 及子组件 | 键盘 Tab 遍历 + NVDA/VoiceOver 朗读 |
| I2 | 审计 74-B 队列条目的 role/键盘导航/Delete 键 | FollowUpQueue.tsx / PendingQueue.tsx | 同上 |
| I3 | 审计 74-D 分支切换器与对话列表的 aria-selected/aria-current | BranchSwitcher.tsx / ProjectSidebar.tsx | 同上 |
| I4 | 审计 74-F ArtifactPanel 的 role="region" + 版本 Tab 的 role="tablist" | ArtifactPanel.tsx | 同上 |
| I5 | 审计 74-G SettingsPage 拆分后 28 个 Tab 的 role="tab" + role="tabpanel" | SettingsPage.tsx + 19+ Tab 组件 | 同上 |
| I6 | 审计 74-H 搜索框的 role="searchbox" + 结果列表 role="listbox" | ProjectSidebar.tsx | 同上 |
| I7 | 全局焦点管理：模态/抽屉打开时焦点陷阱（focus trap）、关闭时焦点回归 | Dialog.tsx / ArtifactPanel.tsx / 各 Modal | Tab 循环验证 |
| I8 | 全局颜色对比度验证（状态色 vs 背景至少 4.5:1） | index.css + 所有状态徽章 | axe-core 或 Lighthouse Accessibility 报告 |
| I9 | 键盘快捷键一致性（Esc 关闭、Enter 确认、Space 切换） | 全局 | 键盘走查 |

**工具支持**：

- 自动扫描：`@axe-core/playwright` 或 Lighthouse Accessibility audit
- 手动验证：NVDA（Windows）/ VoiceOver（macOS）屏幕阅读器朗读
- 键盘走查：纯键盘完成所有核心流程（发送消息 / 切换 Tab / accept diff / 搜索对话 / 切换分支）

**预计影响**：新增/修复 ARIA 属性约 50 处；可能新增 1–2 个 focus trap 工具组件；无功能变化。

---

## 四、执行优先级与依赖关系

```
Phase 74-C（ChatPage 拆分 + 性能基座）          Phase 74-G（SettingsPage 主体拆分）
    ↓                                                ↓
Phase 74-E-min（最小设计 Token 集）              74-G 独立于 C/A/B/D/F，可与任意阶段并行
    ↓                                            前提仅 74-E-min（StatusBadge/FoldableSection 复用）
Phase 74-A（工具卡片重构）+ Phase 74-B（队列 UI 重构）← 并行
    ↓
Phase 74-D（分支可视化）+ Phase 74-E 完整版（设计系统补全）← 并行
    ↓                                                ↓
Phase 74-H（跨对话搜索，依赖 74-D 的对话列表增强）   Phase 74-F（产物面板）
    ↓                                                ↓
                   Phase 74-I（完整无障碍审计，收尾）
```

**推荐执行顺序**：

1. **74-C + 74-E-min + 74-G**（三并行：拆 ChatPage 巨石 + 出最小设计 token + 拆 SettingsPage 巨石）— 建基础，三块互不阻塞
2. **74-A + 74-B**（并行：工具卡片 + 队列 UI）— 最高用户感知 ROI
3. **74-D + 74-E 完整版 + 74-F**（并行：分支可视化 + 设计系统补全 + 产物面板）— 差异化功能
4. **74-H**（跨对话搜索，依赖 74-D 完成）— P2 收尾
5. **74-I**（完整无障碍审计）— 全 Phase 收尾，确保 WCAG 2.1 AA 基线

**每步前置条件检查**：

| 步骤 | 前置条件 | 验证方式 |
|------|----------|----------|
| 74-C | ChatPage.tsx 构建通过 + 应用启动正常 | `npm run build` + 手动启动验证 |
| 74-E-min | 74-C 拆分完成（实际可独立启动，仅 StatusBadge/FoldableSection 需先出） | 组件文件存在 + import 无报错 |
| 74-G | 74-E-min 完成（StatusBadge/FoldableSection 可复用）；与 74-C 完全独立 | SettingsPage 构建通过 |
| 74-A | 74-C 完成 + A4 后端 IPC 就绪 | IPC handler 单元测试通过 |
| 74-B | 74-C 完成 | FollowUpQueue.tsx / PendingQueue.tsx 独立存在 |
| 74-D | 74-C 完成 + BranchSwitcher 占位就绪 | 占位组件可渲染 |
| 74-F | 74-A 完成 + FoldableSection 可用 | ArtifactPanel 挂载无报错 |
| 74-H | 74-D 完成（D2 对话列表增强 + D5 分支标识就绪，便于搜索结果跳转后展示完整信息） | ProjectSidebar 搜索框可输入并返回结果 |
| 74-I | 74-A/B/D/F/G/H 全部完成 | 自动扫描 + 手动键盘走查通过 |

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

### 5.4 SettingsPage 拆分视觉回归（Phase 74-G）

74-G 是纯重构不涉及视觉变化，**无需 huashu 原型**。但需做视觉回归验证：

1. 拆分前截图 28 个 Tab 的关键状态（默认值 / 已填写 / 校验错误 / 加载中）
2. 拆分后逐 Tab 对比截图，差异仅允许来自 StatusBadge / FoldableSection 复用后的统一化
3. 重点关注：Tab 切换动画、自动保存 toast、Header 工具栏位置

### 5.5 跨对话搜索原型（Phase 74-H）

1. 用 huashu-design 做 3 种搜索 UI：
   - 顶部搜索栏：ProjectSidebar 顶部固定输入框，结果替换对话列表
   - 命令面板式：⌘K 唤起居中浮层，结果下拉列表（VS Code 风格）
   - 侧边栏折叠式：搜索按钮展开侧边搜索面板
2. 包含：空输入 / 1 条结果 / 10+ 条结果 / 无结果 4 种状态
3. 高亮样式：`<mark>` 黄色背景 + 命中前后 60 字 snippet

### 5.6 无障碍审计（Phase 74-I）

74-I 是审计修复而非新设计，**无需 huashu 原型**。验证方式见 74-I 改动清单的"验证方式"列（axe-core 自动扫描 + NVDA/VoiceOver 手动朗读 + 键盘走查）。

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
| ChatPage.tsx 行数 | 1652 | ≤ 300（74-C 拆分后） |
| SettingsPage.tsx 行数 | 5465 | ≤ 400（74-G 拆分后） |
| renderer 总文件数 | 49 | 80+（含 74-C/G 拆分 + 74-A/B/D/F/H 新增） |
| shadcn/ui 组件数 | 11 | 18+（补齐 Tooltip/Dropdown/Toast/Tabs/Popover/Skeleton） |
| settings/ Tab 子组件数 | 11（已抽离） | 30+（74-G 抽出 19+ 个新 Tab） |
| settings/ 自定义 hook 数 | 0 | 5（useSettingsDraft/useAutoSave/useSkillsManager/useHooksManager/useMcpCatalog） |
| 工具卡片信息密度（折叠态可见字段） | 1（摘要文字） | 4+（摘要+状态徽章+参数预览+工具图标） |
| ANSI 颜色支持 | 否 | 是 |
| 行级 diff | 否 | 是 |
| accept/reject 按钮 | 否 | 是 |
| 分支可视化 | 否 | 是（`< >` 箭头，对话分支非多Agent分支） |
| 跨对话搜索 | 否 | 是（BM25 + 高亮 + 跳转） |
| 主题跟随系统 | 否 | 是 |
| 滚动条可见 | 否 | 是（细半透明） |
| 产物预览面板 | 否 | 是 |
| 长对话（200+ 消息）滚动帧率 | 未测量（全量渲染） | ≥ 30fps（虚拟滚动启用后） |
| 流式输出时不必要 re-render | 全树 re-render | 仅目标子组件 re-render（selector 优化后） |
| WCAG 2.1 AA 基线达成 | 否 | 是（74-I 审计后） |

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
| SettingsPage.tsx 5465 行（已拆出 11 个 Tab，主体仍为巨石） | 74-G 拆分与 74-C 同构但独立执行；优先抽 ArchivedConversationsPanel/cleanDraftForSave/useSettingsDraft 三件套，主体立即减半 |
| 74-G 50 个 update* 函数迁移风险 | 抽离后逐函数对比 setDraft 调用前后状态，保留旧函数签名向后兼容；先抽 useSettingsDraft hook 再拆 Tab，避免接口爆炸 |
| 74-H localStorage 单 key 配额（5–10MB）长对话被截断 | 与搜索无关，是已存在的基础设施短板；搜索不依赖主进程数据；74-H 范围限定不迁移 localStorage |
| 74-I 完整无障碍审计耗时 | 分两阶段：先 axe-core 自动扫描出报告（1 天），再手动修复高优先级问题（1–2 天）；低优先级可延后但需记录 |

---

## 九、Phase 74 范围外（记录备忘）

> v3 修订：原计划列入 Phase 75/75+ 的三项技术债（SettingsPage 主体拆分 / 跨对话搜索 / 完整无障碍审计）已全部移入 Phase 74（74-G / 74-H / 74-I）。本节仅保留真正需要后续 Phase 处理的基础设施演进项。

| 项目 | 说明 | 计划处理 |
|------|------|----------|
| localStorage 单 key 配额演进 | 渲染层 localStorage（5–10MB）长对话被截断，应迁移到主进程文件存储或 IndexedDB | Phase 76+（独立基础设施演进项，不阻塞 74-H 搜索功能） |
| 搜索 branch-persistence.ts 落盘的 tree.jsonl | 74-H 仅搜渲染层 useProjectsStore；搜 Agent 重度任务的分支树历史需新增 IPC + 数据源映射 | Phase 76+（74-H 已预留扩展点） |
| Web Worker 异步搜索索引 | 74-H 同步 BM25 索引在 1000+ 对话时可能卡 UI；当前规模无必要 | 按需，达到 500 对话阈值时启动 |
| 中文分词增强（jieba-wasm） | 74-H 复用的 BM25Index 用 CJK bigram，长中文查询精度有损 | 按需，根据用户反馈启动 |
| SettingsPage 拆分后的性能优化（useMemo/useCallback/React.memo） | 74-G 优先完成结构拆分，性能优化（避免 draft 引用变化全 Tab 重渲染）作为后续增强 | Phase 76+ |
| 完整无障碍审计的剩余低优先级问题 | 74-I 聚焦高优先级 ARIA + 键盘导航；颜色对比度、屏幕阅读器边缘 case 等低优先级项延后 | Phase 76+ |

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

5. **P4 第 28 项更新**：SettingsPage.tsx 已部分拆分（11 个 Tab），主体仍为巨石，原计划 Phase 75 处理。

6. **成功度量表更新**：增加"settings/ Tab 子组件数"指标，明确分支可视化指对话分支。

### v3.1 修订追加（同日，用户要求"不留技术债到 Phase 75"）

7. **新增 Phase 74-G：SettingsPage 主体拆分**（原 Phase 75 范围移入）：
   - 基于子 Agent 调研，实测 5465 行主体含 40 个 useState + 10 个 useEffect + 50 个 update* 函数 + 15 处 IPC + 28 个 Tab 内容 JSX
   - 拆分方案：≤400 行编排页 + 19+ 个新 Tab 组件 + 5 个自定义 hook + settings-helpers 扩展
   - 优先级：P0 三件套（ArchivedConversationsPanel 物理迁移 + cleanDraftForSave 纯函数 + useSettingsDraft hook）→ P1 七大 Tab 抽离 → P2 中小 Tab + 现有 Tab 复用

8. **新增 Phase 74-H：跨对话搜索**（原 Phase 75+ 范围移入）：
   - 子 Agent 调研确认：数据源（useProjectsStore）+ 算法（BM25Index，Phase 65 已自研）+ UI 落点（ProjectSidebar 顶部）全部就绪
   - 零新增依赖、零 IPC 改动、零主进程修改，工作量 1–2 人日
   - 范围限定：不搜 tree.jsonl、不做 Web Worker、不做中文分词增强、不迁移 localStorage

9. **新增 Phase 74-I：完整无障碍审计与修复**（原 Phase 75 范围移入）：
   - 收尾步骤，对 74-A/B/D/F/G/H 全部新增交互元素做 ARIA 审计 + 键盘导航 + 屏幕阅读器测试
   - 工具：axe-core 自动扫描 + NVDA/VoiceOver 手动朗读 + 键盘走查
   - 目标：WCAG 2.1 AA 基线

10. **执行优先级图重画**：从"4 步串并行"扩展为"5 步串并行"，74-G 与 74-C/E-min 三并行启动，74-H 依赖 74-D，74-I 作为全 Phase 收尾。

11. **成功度量表扩展**：增加 SettingsPage 行数、settings/ Tab 子组件数、自定义 hook 数、跨对话搜索、WCAG 2.1 AA 基线 5 项指标。

12. **风险表扩展**：增加 74-G 50 个 update* 函数迁移风险、74-H localStorage 配额、74-I 审计耗时 3 项风险与缓解措施。

13. **Phase 74 范围外章节重写**：原 3 项技术债已全部移入 Phase 74，本节仅保留真正需要后续 Phase 处理的基础设施演进项（localStorage 演进、tree.jsonl 搜索、Web Worker、jieba-wasm、SettingsPage 性能优化、无障碍低优先级问题）。

---

*本计划基于：竞品调研（12 产品）× 项目现状（49 文件/约 15544 行，2026-07-07 实测）× Skills 市场（frontend-design + ui-ux-pro-max）× huashu-design 方法论综合制定。v2 修订：优化执行顺序（先拆后改）、提前设计 token、补充后端 IPC 依赖、补充性能指标、补充无障碍要求。v3 修订：基于死代码清理后的实测数据重新校准行数与文件数、明确分支定义、修正 74-C 拆分方案、补充 settings/ Tab 复用收益。v3.1 修订：应用户要求"不留技术债到 Phase 75"，将原 Phase 75/75+ 的三项技术债（SettingsPage 拆分 / 跨对话搜索 / 完整无障碍审计）全部移入 Phase 74（74-G / 74-H / 74-I），新增 9 个子 Phase 改动清单与依赖关系。*
