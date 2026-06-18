# RouteDev - 个人开发助手 Agent 设计文档

> 日期：2026-06-16 | 状态：需求确认 | 作者：用户 + AI 协作

## 1. 产品定位

基于 PilotDeck Router/tokenSaver 模块的**桌面端自主开发 Agent**。

**一句话描述**：按任务复杂度自动路由模型的个人开发助手，支持从对话到自主完成开发目标的全流程。

**核心价值**：
- **省钱**：简单任务用便宜模型，复杂任务才用贵模型
- **自主**：设定目标后可自动执行，关键步骤可配置确认点
- **安全**：容器沙箱隔离、检查点回滚、自动测试验证
- **可扩展**：MCP 工具生态 + 内置工具 + 自定义插件
- **多 Agent**：Orchestrator 动态调度 Worker 并行工作，自动处理文件冲突
- **可观测**：全链路 Trace + 成本归因 + 漂移检测

## 2. 目标用户

个人开发者，日常多类型项目开发，希望 AI 助手智能节省 token 并具备自主完成开发任务的能力。

## 3. 核心架构

```
┌──────────────────────────────────────────────────────┐
│              Desktop UI (Tauri 2.x)                   │
│  Chat 界面 + Notion 卡片编辑 + 侧边栏 + 配置向导       │
├──────────────────────────────────────────────────────┤
│                  Agent Layer                          │
│  Orchestrator 调度 / Worker 并行 / 目标分解            │
│  自主度控制 / 分支对话 / 冲突检测 / 持久化执行          │
├───────────────┬──────────────────────────────────────┤
│    Router     │           Harness                    │
│  场景分类      │  Docker 容器沙箱 / 检查点 / Hook      │
│  模型路由      │  自动测试 + 回滚                      │
│  Token 追踪   │  安全边界（目录/命令/敏感文件/网络）    │
├───────────────┴──────────────────────────────────────┤
│                 Tool Layer                            │
│  内置(搜索/文件/Shell/Git/代码搜索) + MCP + 插件       │
├──────────────────────────────────────────────────────┤
│                Memory Layer                           │
│  公共黑板 + 私有笔记 / 会话摘要 / 规则文件              │
│  上下文自动压缩 / 信息裁剪防幻觉传染                    │
├──────────────────────────────────────────────────────┤
│           Observability Layer                         │
│  LLM Trace / 成本归因 / 漂移检测 / 评估体系             │
└──────────────────────────────────────────────────────┘
```

## 4. 各层详细设计

### 4.1 Router 层

**来源**：从 PilotDeck 提取 `src/router/` 模块，适配独立运行。

**核心组件**：

| 组件 | 职责 |
|------|------|
| ScenarioClassifier | 分析用户意图，分类为 simple/medium/complex/reasoning |
| ModelRouter | 根据分类 + 配置，选择具体模型 |
| TokenTracker | 追踪 token 消耗数量（不计算费用） |
| RouterConfig | 路由策略配置 |

**路由流程**：
```
用户输入 → ScenarioClassifier → 场景等级 → ModelRouter → 选择模型 → 调用 API
                                                         ↓
                                              TokenTracker 更新消耗
                                                         ↓
                                              超预算？→ 自动降级到便宜模型
```

**路由策略**（初始实现四级分类，后续可迭代）：
- simple → 最便宜的快速模型（如 deepseek-v4-flash）
- medium → 中等模型（如 minimax-m3）
- complex → 强推理模型（如 qwen3.7-plus）
- reasoning → 最强模型（如 kimi-k2.7 / deepseek-v4-pro）

**降级策略**：
- 单次请求超 token 上限 → 降级到下一 tier
- 累计消耗超日预算 → 全部降级到最低 tier
- 模型调用失败 → 用户手动处理（不自动熔断）

**路由可见性**：
- 路由决策完全可见，用户可手动覆盖
- 静默切换 + 状态栏更新（不弹提示打断对话）
- 状态栏显示：当前模型、路由等级、降级状态

**模型信息展示**：
- 上下文窗口大小
- 能力标签（推理/代码/多模态）
- 延迟和可用性状态

**Token 预算**：
- 可配置严格度：仅统计显示 / 预算上限 + 降级
- 只显示 token 数量，不计算费用

### 4.2 Agent 层

**参考实现**：Codex CLI（目标驱动）、Claude Code（步骤编排）、Anthropic Orchestrator Workers 模式

**架构选择**：Orchestrator Workers（动态分解），而非固定 Supervisor

> **为什么选 Orchestrator 而非固定 Supervisor？**
> 固定 Supervisor 预定义 A 做 X、B 做 Y，适合流程确定的任务。
> Orchestrator 动态分析任务，自主决定拆成几个子任务、分别交给谁，
> Worker 数量可插拔（今天 3 个明天 5 个），适合复杂度不可预知的开发任务。
> 参考：Anthropic 白皮书推荐的 Orchestrator Workers 高级模式。

**多 Agent 三个反直觉真相**（来源：Bilibili BV13iV36sE9C）：
1. 单 Agent + 好工具 > 多 Agent + 烂协调 → 简单任务不上多 Agent
2. 多 Agent 成本可能是单 Agent 的 5~10 倍 → Router 降级策略至关重要
3. 幻觉会在 Agent 间传染 → 信息传递必须裁剪，只传关键信息

**何时启用多 Agent**（三个条件同时满足）：
- 角色清晰分离（搜索/编码/测试不能混在一个 prompt 里）
- 任务可拆成互不依赖的子任务
- 专长差异巨大（不同 Agent 需要完全不同的工具集合）

**核心组件**：

| 组件 | 职责 |
|------|------|
| OrchestratorAgent | 动态分解目标、调度 Worker、处理文件冲突、汇总结果 |
| WorkerAgent | 执行具体步骤，向 Orchestrator 汇报 |
| GoalParser | 解析 /goal 命令，拆分为可执行步骤 |
| StepExecutor | 执行单个步骤，调用 Tool Layer |
| AutonomyController | 控制自主度（全自动/半自动/手动） |
| ConflictDetector | 检测 Worker 间文件访问冲突 |
| BranchManager | 管理对话分支（ChatGPT 式） |
| GoalVerifier | 独立审查任务完成度，防止 Agent 过早终止 |
| CheckpointWriter | 增量检查点生成，维护结构化记忆（Phase 3） |
| DurableExecutor | 持久化执行：每步保存状态，失败从上次成功点恢复 |

**Orchestrator Workers 模式**：
```
/goal "重构入口模块" --verify "所有测试通过且代码已提交"
  → Orchestrator 分析任务，动态决定拆分策略
  → Orchestrator 检测文件冲突，规划 Worker 分配
  → Worker-A: 分析模块结构 [simple → flash]
  → Worker-B: 搜索相关测试 [simple → flash]  ← 与 A 无冲突，并行
  → Worker-A: 设计重构方案 [complex → qwen3.7]
  → Worker-A: 实施重构 [complex → qwen3.7]   ← 排队，等 B 完成
  → Worker-B: 运行测试验证 [simple → flash]
  → Orchestrator 汇总结果
  → GoalVerifier 独立审查：条件是否满足？
    → 满足：标记完成，生成任务报告
    → 不满足：返回 Orchestrator 继续执行

简单任务（如"解释这段代码"）→ 单 Agent 直接处理，不上多 Agent
```

**信息传递规则**（防止幻觉传染）：
- Worker 间不传完整历史，只传对方需要的关键信息
- Orchestrator 做上下文裁剪：提取结论，丢弃推理过程
- 公共黑板存共识信息（任务目标、已完成步骤），私有笔记存工作细节

**持久化执行**（Durable Execution）：
- 每完成一步都持久化状态到磁盘
- 失败后从上次成功的位置恢复，而非从头再来
- 适用场景：任务超过 5 分钟、涉及人工审批、需要跨天执行
- 参考：Temporal 的 Checkpoint 机制

**文件冲突检测**：
- Orchestrator 在调度 Worker 时预判文件访问冲突
- 有冲突的 Worker 排队执行，无冲突的并行执行
- 冲突检测基于文件路径 + 操作类型（读/写）

**Worker 可见性**：
- 默认显示结果汇总
- 可展开查看每个 Worker 的执行详情
- 可切换可见度级别

**自主度模式**：

| 模式 | 行为 | 代码修改审查 |
|------|------|-------------|
| 全自动 | 完全自主执行，完成后报告 | 先改后查，可回滚 |
| 半自动 | 关键步骤前暂停确认 | 修改前确认 |
| 手动 | 每步都需用户确认 | 修改前确认 |

**工作模式**（参考 MiMo Code Build/Plan/Compose）：

| 模式 | 权限 | 用途 |
|------|------|------|
| Build | 读写执行 | 默认开发模式，全权限 |
| Plan | 只读 | 只读分析模式，安全探索代码 |
| Compose | 编排 | 自动编排需求→编码→测试→审查全流程 |

> 工作模式与自主度模式正交：Build + 全自动 = 最高权限自主开发；Plan + 手动 = 安全探索每步确认。

**步骤编辑**：
- /goal 分解后展示 Notion 风格卡片列表
- 可删除、重排、编辑步骤内容
- 编辑后重新执行

**错误处理**：
- 步骤执行出错 → 暂停 + 展示错误 + 建议方案
- 用户选择：重试 / 跳过 / 回滚 / 修改步骤
- 单个 Worker 失败 → 降级处理，不导致整体崩溃

**分支对话**（ChatGPT 式）：
- 可编辑或删除任意位置的已发送消息
- 编辑后自动生成新分支，旧分支保留
- 可在分支间切换

**后台任务**：
- 后台搜索：代码/文件搜索，结果推送到主任务上下文
- 后台项目分析：分析项目结构，生成上下文摘要
- 后台测试/构建：运行测试或构建，结果通知主任务
- 文件监控：外部修改文件后自动感知更新上下文

### 4.3 Harness 层

**参考实现**：Codex CLI（沙箱）、Claude Code（权限控制）

**核心组件**：

| 组件 | 职责 |
|------|------|
| Sandbox | Docker 容器隔离执行 |
| CheckpointManager | 基于 git 的快照管理 |
| HookRunner | 生命周期 Hook 执行器 |
| TestRunner | 自动测试 + 结果判断 |
| SecurityGuard | 安全边界守卫 |

**容器沙箱**：
- Docker 容器隔离执行代码
- 限制文件系统访问范围
- 限制网络访问

**检查点机制**：
- 每个步骤执行前自动创建 git commit 快照
- 支持回滚到任意检查点
- 检查点列表在 UI 中可视化展示

**生命周期 Hook**：
```
pre-step  → 执行前（如：锁定关键文件、备份）
post-step → 执行后（如：格式化、lint）
on-error  → 出错时（如：自动回滚、通知）
on-complete → 目标完成时（如：运行全量测试、生成报告）
```

**自动测试**：
- 步骤执行后自动检测项目测试框架
- 运行相关测试，失败则自动回滚到上一个检查点
- 可配置跳过测试

**安全边界**：
- **目录边界**：限制 Agent 只能操作项目目录内文件
- **命令黑白名单**：可配置，禁止危险 Shell 命令（rm -rf 等）
- **敏感文件保护**：可配置，.env/credentials 等只读或禁止访问
- **网络请求确认**：Agent 发起网络请求前需确认

### 4.4 Tool 层

**开箱即用的内置工具**：

| 工具 | 功能 |
|------|------|
| web_search | 网络搜索（接入搜索引擎 API） |
| file_read | 读取文件内容 |
| file_write | 写入/创建文件 |
| file_search | 按内容/名称搜索文件 |
| shell_exec | 执行 Shell 命令 |
| git_op | Git 操作（diff, log, status, add, commit, push, branch） |
| code_search | 基础代码搜索 + 可选接入 CodeGraph 增强 |

**工具权限**：
- 危险操作（删除文件、Shell 执行）需确认
- 安全操作（读取、搜索）自动执行

**MCP 客户端**：
- 兼容 MCP 协议，动态加载 MCP Server
- UI 管理界面 + 配置文件导入导出
- 类似 Trae 的 MCP 管理体验

**自定义插件**（参考 Codex 插件系统）：
- 主题插件：自定义界面主题、布局、颜色
- 工具插件：自定义工具（类似 MCP 但更轻量）
- Hook 插件：自定义生命周期 Hook 脚本
- 路由插件：自定义路由策略（替换默认路由逻辑）

### 4.5 Memory 层

**参考 PilotDeck 实现 + MiMo Code 增量 Checkpoint 机制**，混合记忆模式：

> **为什么用混合模式？**
> 共享记忆：所有 Agent 看同一份历史 → 信息不丢，但 context 爆炸且互相污染
> 独立记忆：每个 Agent 只看自己的 → 轻量，但信息孤岛
> **混合模式**：公共黑板存共识信息 + 私有笔记存工作细节 → 最佳实践

**存储结构**：

```
AppData/RouteDev/
├── config.yaml           # 全局配置
├── providers.json        # API 提供商配置
└── projects/
    └── {project-hash}/
        ├── rules.md          # 项目规则
        ├── context.json      # 项目上下文
        ├── decisions.jsonl   # 历史决策记录
        ├── blackboard.json   # 公共黑板（共识信息：任务目标、已完成步骤）
        ├── MEMORY.md         # 项目记忆（跨会话架构决策，MiMo Code 风格）
        └── sessions/
            └── {session-id}/
                ├── checkpoint.md   # 增量检查点（MiMo Code 风格）
                ├── notes.md        # 临时记事本（自由格式，Writer 定期清理）
                ├── summary.md      # 会话摘要
                ├── progress.json   # 任务进度
                └── workers/
                    └── {worker-id}/
                        └── notes.json  # Worker 私有笔记
```

**记忆类型**：
- **公共黑板**：任务目标、已完成步骤、共识信息（所有 Agent 共享）
- **私有笔记**：各 Agent 的工作细节、中间推理（仅自己可见）
- **项目级**：规则、约定、架构决策（跨会话持久）
- **会话级**：当前对话上下文、任务进度（会话内有效）
- **摘要**：长对话自动压缩，保留关键信息，可调整保留策略

**信息传递规则**：
- Orchestrator 从 Worker 私有笔记提取结论，写入公共黑板
- 不传完整历史，只传对方需要的关键信息
- 防止幻觉传染：裁剪推理过程，只保留结论和依据

**增量 Checkpoint 机制**（参考 MiMo Code）：

> **为什么需要增量 checkpoint？**
> MiMo Code 在 80+ 轮对话中全程稳定，Claude Code 第 40 轮开始丢信息。
> 原因是 MiMo 在上下文消耗的 **20%、45%、70%** 三个节点主动触发 checkpoint，
> 而不是等快满了才被动压缩。这是从架构层面根治 AI 健忘。

**CheckpointWriter 组件**：
- 独立的子 Agent，专门负责记忆维护
- 主 Agent 只管写代码，记忆维护完全外包
- 主 Agent 唯一的写入通道是 `notes.md`（自由格式临时记事本）
- Writer 在 checkpoint 时读取 `notes.md`、归类、清空

**三档触发机制**：
- **20%**：首次 checkpoint，建立基础快照
- **45%**：中期 checkpoint，增量更新
- **70%**：晚期 checkpoint，准备压缩
- 每次 checkpoint 是对前一次的**增量更新**，不是全量重写

**Checkpoint 结构化字段**（11 个）：
1. 当前意图（Current Intent）
2. 下一步动作（Next Action）
3. 工作约束（Working Constraints）
4. 任务树（Task Tree）
5. 当前工作文件（Current Working Files）
6. 涉及文件列表（Involved Files）
7. 跨任务发现（Cross-task Discoveries）
8. 错误与修复（Errors & Fixes）
9. 运行时状态（Runtime State）
10. 设计决策（Design Decisions）
11. 杂项笔记（Misc Notes）

**记忆编辑**：UI 内编辑 + 可导出为文件

**上下文管理**：
- 超出模型窗口时自动压缩旧消息
- 用户可调整保留策略
- 压缩时优先从结构化 checkpoint 重建，而非从零拼接历史
- 公共黑板定期清理已完成任务的信息

### 4.6 UI 层

**技术选型**：Tauri 2.x + React + TypeScript

**交互风格**：鼠标 + 语音输入为主，常用快捷键辅助

**界面布局**：

```
┌──────────────────────────────────────────────────────┐
│  RouteDev                                ⚙️ 设置     │
├──────────────┬───────────────────────────────────────┤
│              │                                        │
│  📁 项目     │  Chat 主界面（Codex 风格）              │
│  ├─ 项目A   │                                        │
│  ├─ 项目B ◄ │  对话气泡 + 执行卡片                    │
│  └─ + 添加  │  分支切换标签                           │
│              │                                        │
│  💬 对话     │  ┌─ 执行面板 ─────────────────────┐    │
│  ├─ 重构入口 │  │ ✓ 读取 3 个文件     [+12 -0]   │    │
│  ├─ 修复Bug │  │ ⟳ 重构模块... [kimi-k2.7]       │    │
│  └─ + 新对话│  │ ○ 运行测试                       │    │
│              │  └─────────────────────────────────┘    │
│  📊 Token    │                                        │
│  本轮: 1.2k  │  ┌─ Notion 卡片编辑器 ─────────────┐   │
│  累计: 8.5k  │  │ ⋮⋮ 1. 分析模块结构 [simple]     │   │
│  预算: 开放  │  │ ⋮⋮ 2. 设计重构方案 [complex]    │   │
│              │  │ ⋮⋮ 3. 实施重构 [complex]  ✏️ 🗑️  │   │
│  🔧 模型     │  │ ⋮⋮ 4. 运行测试 [simple]         │   │
│  当前: K2.7  │  └─────────────────────────────────┘   │
│  路由: complex│                                       │
│              │  ┌─────────────────────────────────┐   │
│  🔔 状态     │  │ 🎤 语音 / ⌨️ 输入 /goal 命令...  │   │
│  ● 运行中   │  └─────────────────────────────────┘   │
└──────────────┴───────────────────────────────────────┘
```

**关键 UI 特征**：
- **Chat 为主界面**：对话气泡 + 执行卡片，Codex 现代化风格
- **代码变更**：默认只显示增删行数（+12 -3），可切换 Diff 视图
- **执行卡片**：每个步骤以卡片展示，可展开详情
- **Notion 卡片编辑器**：步骤列表可拖拽排序、编辑内容、删除
- **分支对话**：ChatGPT 式分支，编辑消息生成新分支，可切换
- **实时状态栏**：左侧显示 token 消耗、当前模型、路由等级
- **语音输入**：底部输入框支持语音输入
- **提示音**：完成=清脆音，异常=警告音，询问确认=提示音

**主题**：深色/浅色可切换，中/英界面可切换

**配置向导**（首次启动）：
```
Step 1: 欢迎 + 选择 API 提供商（预配置，用户填 API Key / 模型 ID / URL）
Step 2: 测试连接 + 自动检测可用模型
Step 3: 设置路由偏好（默认 tier、预算策略）
Step 4: 关联项目目录
Step 5: 完成 → 进入主界面
```

**对话历史**：
- 分项目，项目下分多个对话
- 可搜索标题，标题可编辑
- 点击展开查看历史对话

**任务报告**：
- /goal 完成后可查看任务报告（目标、步骤、结果、token 消耗）
- 不自动弹出，用户主动查看

**导出**：Markdown、JSON（含元数据和 token 统计）

## 5. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 桌面壳 | Tauri 2.x | Rust 后端，轻量 |
| 前端 | React + TypeScript | Chat UI + 配置向导 |
| Agent 核心 | TypeScript | 从 PilotDeck 提取，Node.js 运行 |
| 沙箱 | Docker API | 容器隔离执行 |
| MCP | @modelcontextprotocol/sdk | MCP 客户端 |
| Git | isomorphic-git | 检查点管理 |
| 存储 | AppData 目录 | JSON + Markdown |
| 语音 | Web Speech API | 语音输入 |

## 6. 渐进式开发路线

### Phase 1：核心 Router + CLI 对话
- 从 PilotDeck 提取 Router/tokenSaver 模块
- 适配独立运行（去除 PilotDeck 框架依赖）
- CLI 界面：基本对话 + 路由选择
- YAML 配置文件管理模型和路由
- **交付物**：可路由的 CLI Agent

### Phase 2：工具系统
- 实现内置工具（网络搜索、文件读写、Shell 执行、Git 操作、代码搜索）
- 集成 MCP 客户端
- 工具执行框架（权限控制、超时管理、安全边界）
- **交付物**：可操作文件和执行命令的 Agent

### Phase 3：自主模式 + 检查点
- 实现 /goal 命令和目标分解
- Notion 风格卡片步骤编辑器
- 三种自主度模式（全自动/半自动/手动）
- 基于 git 的检查点系统（手动回滚用）
- **CheckpointWriter 增量检查点**（20%/45%/70% 三档触发，可配置阈值）
  - 独立子 Agent 维护记忆，主 Agent 只管写代码
  - notes.md 临时记事本 + 11 字段结构化 checkpoint
- 回滚功能
- 分支对话（ChatGPT 式）
- /init 命令（自动生成项目规则文件）
- /dream 命令（整理项目记忆）
- **交付物**：可自主完成开发目标的 Agent + 长会话记忆稳定

### Phase 4：多 Agent + Harness
- Leader + Worker 多 Agent 架构
- 文件访问冲突检测
- **GoalVerifier 任务验证**（独立 Agent 审查任务完成度）
- Docker 容器沙箱执行
- 生命周期 Hook 系统
- 自动测试 + 回滚
- 后台任务（搜索、分析、监控、测试）
- **交付物**：多 Agent 并行 + 任务完成度验证 + 安全可控的 Agent

### Phase 5：Tauri 桌面 UI
- Tauri 应用壳
- Chat 主界面（Codex 风格）
- Notion 卡片编辑器
- 配置向导
- 侧边栏（项目/Token/模型状态）
- 语音输入
- 提示音系统
- 主题切换（深/浅）
- 中/英切换
- **交付物**：完整桌面应用

### Phase 6：插件生态
- 自定义插件系统（主题/工具/Hook/路由）
- 参考 Codex 插件体系
- 插件市场（可选）
- **交付物**：可扩展的插件生态

## 7. 命令系统

| 命令 | 功能 |
|------|------|
| /goal \<description\> [--verify \<condition\>] | 设定目标，自动分解并执行。可选 `--verify` 指定完成条件 |
| /auto | 切换到全自动模式 |
| /semi | 切换到半自动模式 |
| /manual | 切换到手动模式 |
| /build | 切换到 Build 工作模式 |
| /plan | 切换到 Plan 工作模式 |
| /compose | 切换到 Compose 工作模式 |
| /rollback [step] | 回滚到指定检查点 |
| /status | 查看当前任务进度和 token 消耗 |
| /model \<name\> | 手动切换模型（覆盖路由） |
| /config | 打开配置界面 |
| /memory | 查看/编辑项目记忆 |
| /init | 分析项目结构，自动生成规则文件（参考 MiMo Code） |
| /dream | 整理项目记忆，合并去重（参考 MiMo Code） |
| /undo | 撤销上一步操作 |
| /retry | 重新执行上一步 |
| /pause | 暂停当前任务 |
| /skip | 跳过当前步骤 |

**快捷引用系统**（参考 ZCode）：

| 快捷方式 | 功能 |
|----------|------|
| @\<filename\> | 引用指定文件，自动注入文件内容到上下文 |
| @\<symbol\> | 引用代码符号（函数/类/变量），自动定位定义 |
| #\<conversation\> | 关联历史对话，注入相关上下文 |
| $\<skill\> | 调用预设专业技能（如 $tdd、$refactor） |

> 注：命令系统持续迭代，后续补充更多快捷方式。

## 8. 安全设计

| 层面 | 策略 | 可配置 |
|------|------|--------|
| 目录边界 | 限制 Agent 只能操作项目目录内文件 | 是 |
| 命令控制 | 黑白名单，禁止危险 Shell 命令 | 是 |
| 敏感文件 | .env/credentials 只读或禁止访问 | 是 |
| 网络请求 | Agent 发起网络请求前需确认 | 是 |
| 容器沙箱 | Docker 隔离执行 | 否 |
| 工具权限 | 危险操作需确认 | 是 |

### 8.1 操作审计日志（参考 ZCode）

> ZCode 强调"全流程可追溯"。RouteDev 同样记录所有高权限操作的完整审计链。

**审计内容**：
- 时间戳、Agent ID、操作类型、目标文件/命令
- 操作前后的状态对比（如文件修改前后的 diff）
- 用户确认记录（谁、何时、是否批准）
- 模型路由决策（哪个模型、为什么选它）

**审计日志格式**：
```
AppData/RouteDev/audit/
└── {date}/
    └── {session-id}.audit.jsonl
```

**审计日志用途**：
- 安全回溯：谁、何时、对什么做了什么
- 问题排查：操作失败时的上下文
- 合规报告：企业用户的审计需求
- 用户可见：UI 中可查看最近操作历史

## 9. 数据存储

所有数据统一存储在 AppData 目录：

```
AppData/RouteDev/
├── config.yaml           # 全局配置
├── providers.json        # API 提供商（预配置模板 + 用户 Key）
├── plugins/              # 插件目录
├── mcp-config.json       # MCP Server 配置
├── logs/                 # 调试日志
├── audit/                # 操作审计日志（参考 ZCode）
└── projects/
    └── {project-hash}/
        ├── rules.md
        ├── context.json
        ├── decisions.jsonl
        └── sessions/
```

仅本地存储，无云同步。

## 10. 平台与更新

- **目标平台**：先 Windows（.exe/.msi），后续跨平台
- **更新策略**：手动确认更新
- **调试**：详细调试日志（路由决策、模型请求/响应、工具调用详情）

## 11. 与 PilotDeck 的关系

- **提取而非 Fork**：只提取 Router/tokenSaver 核心逻辑
- **独立代码库**：新建项目，不依赖 PilotDeck 源码
- **协议兼容**：AGPL-3.0（PilotDeck 许可证），衍生作品同样开源

## 12. 开放问题

1. **路由策略细节**：四级分类的阈值如何设定？动态预算路由是否在后续 Phase 实现？
2. **Codex 插件体系**：需调研 Codex 的具体插件 API 设计
3. **语音输入**：Web Speech API 精度和离线支持情况
4. **Docker 依赖**：用户是否需要预装 Docker Desktop？是否提供轻量替代？

## 13. 可观测性与成本治理

> 来源：Bilibili BV13iV36sE9C - 多Agent编排+评估监控全体系

### 13.1 LLM Trace（全链路追踪）

不可观测 = 不可维护。传统 APM 不够用，需要大模型专属 Trace。

**追踪内容**：
- 一次完整执行的全链路：用户输入 → 路由决策 → 模型调用 → 工具执行 → 结果返回
- 每个 Worker 的调用关系图
- 每步的输入/输出 token 数、延迟、模型选择

**UI 展示**：
- 侧边栏可展开 Trace 面板
- 每个 Worker 的执行时间线
- 跨 Worker 的调用关系图

### 13.2 成本治理三板斧

| 措施 | 说明 |
|------|------|
| 预算熔断 | 超过配置的 token/金额上限，自动停止或降级 |
| 成本归因 | 追踪每美元花在哪个 Agent/步骤上 |
| ROI 评估 | 定量测量多 Agent 比单 Agent 好了多少 |

**成本归因维度**：
- 按 Agent：Orchestrator / Worker-A / Worker-B 各消耗多少
- 按步骤：分析 / 编码 / 测试 各消耗多少
- 按模型：flash / pro / kimi 各消耗多少
- 按任务：每个 /goal 的总消耗

### 13.3 监控指标

| 指标 | 说明 |
|------|------|
| 延迟 | 首 token 时间、端到端时间 |
| 成本 | 每请求、每用户、每功能 |
| 质量 | 在线 LLM-as-Judge 抽样打分 |
| 错误率 | API 错、解析错、工具调用错 |
| 安全 | 越狱尝试、注入攻击、毒性输出 |
| 用户反馈 | 点赞/差评、从事率、停留时长 |
| 漂移 | 质量随时间变化 |

### 13.4 漂移检测

大模型应用的独特问题：AI 在偷偷变差。

**三种漂移**：
- **模型漂移**：模型升级后行为微变（如 Claude 3 → 3.5 后特定场景准确率下降）
- **输入漂移**：新用户群的问题分布不同
- **用户漂移**：老用户需求升级

**检测方法**：
- 定期重跑评估集，对比历史分数
- 用户反馈的滑动窗口分析
- 输入分布的统计检验

## 14. 评估体系

> 来源：Bilibili BV13iV36sE9C - 多Agent编排+评估监控全体系

### 14.1 三层评估集

| 层级 | 数量 | 用途 | 频率 |
|------|------|------|------|
| Smoke Set | 30 条 | PR 门禁，快速跑 | 每次提交 |
| Regression Set | 100 条 | 防退化 | 每日 |
| Comprehensive Set | 500 条 | 全面评估 | 每周 |

**评估集来源**：
- 真实用户日志
- 大模型合成
- 竞品对比
- 人工构造的对抗样本

**评估集生命周期**：持续收集 → 定期标注 → 版本管理 → 演进更新

### 14.2 五维评估指标

| 维度 | 指标 |
|------|------|
| 质量 | 正确性、忠实度、相关性、完整性 |
| 格式 | Schema 合规、长度、风格 |
| 安全 | 毒性、偏见、PII 泄漏、幻觉 |
| 体验 | 延迟、首 token 时间、顺畅度 |
| 业务 | 任务成功率、用户满意度 |

### 14.3 LLM-as-Judge

用强模型评判弱模型的输出质量。

**五大陷阱**：
1. 位置偏差：先看到的总觉得好
2. 长度偏差：长回答得分高
3. 自我偏好：Claude 评自己比评 GPT 宽松
4. 风格偏差：偏好某种表达风格
5. 缺少 ground truth 的臆断

**对抗技术**：
- 双向评测：A 和 B 换位置再评一次
- Rubric 设计：给 judge 明确的评分标准

**Rubric 五要素**：
1. 标准明确可操作
2. 能区分优劣
3. 有正反事例
4. 有边界说明
5. Chain-of-thought：judge 解释为什么打这个分

### 14.4 CI 评估门禁

- 工程师改 prompt → 提 PR → GitHub Actions 自动跑评估
- 结果对比 baseline，通过才能合并
- 门禁指标：总体通过率不低于 baseline -2%，无新增 P0 失败
- 快速集 30 条跑 PR 门禁，2 分钟内出结果

## 15. 高级模式

> 来源：Anthropic 白皮书 + Bilibili BV13iV36sE9C

### 15.1 Evaluator-Optimizer（评估-优化循环）

```
Generator 生成内容 → Evaluator 评分 + 改进建议 → Generator 根据反馈改进 → 循环直到质量达标
```

- 适合：写作、代码优化、文档改进
- 类似作者和编辑的关系：写完交编辑 → 编辑提意见 → 作者修改 → 来回几轮

### 15.2 Orchestrator Workers（动态分解）

已在 4.2 节详述。核心区别：
- Supervisor 是固定的（A 做 X，B 做 Y）
- Orchestrator 是动态的（分析任务后决定拆几个、交给谁）
- Worker 可插拔（今天 3 个明天 5 个）

## 16. 端到端用户旅程

### 16.1 首次启动

```
启动应用 → 配置向导（5 步）
  → Step 1: 选择 API 提供商（预配置列表）
  → Step 2: 输入 API Key + 测试连接
  → Step 3: 自动检测可用模型 + 配置路由
  → Step 4: 设置 Token 预算（仅统计 / 强制限制）
  → Step 5: 选择项目目录
→ 进入主界面
```

### 16.2 首次进入项目

```
进入项目 → 检测 .routedev.yaml 是否存在
  → 不存在：提示运行 /init
    → /init 分析项目结构
    → 生成 rules.md（技术栈、目录结构、代码约定）
    → 用户确认或编辑
  → 已存在：加载配置
→ 侧边栏显示项目信息 + Token 统计
→ 底部输入框就绪
```

### 16.3 简单对话（单 Agent）

```
用户输入："解释一下 src/main/Entry.java 的入口逻辑"
  → ScenarioClassifier 分类 → simple
  → ModelRouter 选择 deepseek-v4-flash
  → 单 Agent 直接处理（不上多 Agent）
  → 调用 file_read 工具读取文件
  → 生成解释
  → TokenTracker 记录消耗
  → 状态栏更新：当前模型 flash / 路由 simple / +350 tokens
```

### 16.4 复杂目标（多 Agent + Checkpoint + GoalVerifier）

```
用户输入：/goal "重构 Entry.java，提取公共逻辑到 Utils 类" --verify "所有测试通过且无编译错误"
  → Orchestrator 分析目标
  → 判断需要多 Agent（角色分离 + 任务可拆 + 专长差异）
  → 分解步骤：
    1. 分析 Entry.java 结构 [simple → flash]
    2. 识别可提取的公共逻辑 [medium → minimax-m3]
    3. 设计重构方案 [complex → qwen3.7-plus]
    4. 实施重构 [complex → qwen3.7-plus]
    5. 运行测试验证 [simple → flash]
  → ConflictDetector 检测文件冲突
    → 步骤 3、4 都写 Entry.java → 排队
    → 步骤 1、2 无冲突 → 可并行
  → 展示 Notion 卡片步骤列表（可编辑）
  → 用户确认执行

执行过程：
  → 步骤 1、2 并行执行
  → CheckpointWriter 在 token 消耗 20% 时触发首次 checkpoint
  → 步骤 3 执行（依赖 1、2 结果）
  → 步骤 4 执行（依赖 3 结果）
  → CheckpointWriter 在 45% 时触发增量 checkpoint
  → 步骤 5 执行测试
  → 所有步骤完成

验证阶段：
  → GoalVerifier 独立审查
    → 检查：测试是否全部通过？
    → 检查：是否有编译错误？
    → 通过 → 标记完成，生成任务报告
    → 不通过 → 返回 Orchestrator 继续修复

完成：
  → 侧边栏显示任务报告（可点击查看）
  → 提示音：完成（清脆音）
  → TokenTracker 汇总：本轮消耗 8500 tokens
```

### 16.5 错误恢复流程

```
步骤执行出错（如 Worker 崩溃）：
  → Orchestrator 收到 task_error 消息
  → 暂停该 Worker
  → 通知用户：
    → 展示错误信息
    → 提供建议方案（重试 / 跳过 / 回滚 / 修改步骤）
  → 用户选择：
    → 重试：重新执行该步骤
    → 跳过：标记为 skipped，继续下一步
    → 回滚：CheckpointManager 回滚到上一个检查点
    → 修改步骤：编辑步骤内容后重新执行
```

### 16.6 记忆整理

```
/dream 命令触发（手动或每 7 天自动）：
  → CheckpointWriter 扫描近期会话记录
  → 提取可持久化的知识
  → 合并去重，清理过时条目
  → 写入 MEMORY.md（项目记忆）
  → 输出整理报告：合并 N 条，删除 M 条，新增 K 条洞察
```

## 17. 性能预算

### 17.1 元操作 Token 预算

| 操作 | 预算上限 | 计入总预算 | 说明 |
|------|---------|-----------|------|
| ScenarioClassifier | 200 tokens | 是 | 用最便宜模型分类 |
| CheckpointWriter（单次） | 500 tokens | 是 | 可配置 |
| GoalVerifier（单次） | 1000 tokens | 是 | 可配置 |
| /init 项目分析 | 2000 tokens | 是 | 一次性 |
| /dream 记忆整理 | 1500 tokens | 是 | 定期触发 |
| Evaluator（单次） | 800 tokens | 是 | Evaluator-Optimizer 模式 |

### 17.2 延迟预算

| 操作 | 目标延迟 | 说明 |
|------|---------|------|
| 场景分类 | < 1s | 用最便宜快速模型 |
| Checkpoint 生成 | < 2s | 后台异步，不阻塞主流程 |
| GoalVerifier | < 3s | 任务完成后触发 |
| 工具调用 | < 10s | 文件读写、Shell 执行 |
| 端到端（简单任务） | < 5s | 从输入到输出 |
| 端到端（复杂任务） | 无硬性限制 | 取决于任务复杂度 |

### 17.3 资源限制

| 资源 | 限制 | 说明 |
|------|------|------|
| 单次请求 token | 模型上下文窗口的 80% | 预留输出空间 |
| 日 token 上限 | 可配置（默认 500k） | 超出后降级或暂停 |
| 审计日志保留 | 30 天 | 超出后自动清理 |
| Checkpoint 保留 | 最近 10 个 | 超出后自动清理最旧的 |
| 后台任务并发 | 最多 3 个 | 防止资源耗尽 |
