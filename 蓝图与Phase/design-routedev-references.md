# RouteDev 竞品参考 - MiMo Code & ZCode

> 日期：2026-06-16 | 来源：公开评测文章

## MiMo Code (小米, 2026-06-11 开源)

### 核心定位
终端原生 AI 编程 Agent，MIT 协议开源，基于 OpenCode 二次开发。

### 三大核心差异化（可参考）

#### 1. 持久记忆系统（最值得参考）

**问题**：现有 AI 编程助手几乎都受困于"越用越忘"——对话一长，模型开始丢信息、忘约束、重复犯错。

**MiMo Code 方案**：
- 用**独立的子智能体（Writer sub-agent）**专门负责记忆维护
- 主 Agent 只管写代码，记忆维护完全外包
- 在上下文预算的 **20%、45%、70%** 三个位置触发 checkpoint（不是等窗口快满了才压缩）
- 每次 checkpoint 是对前一次的**增量更新**
- 主 Agent 唯一的写入通道是 `notes.md`（自由格式临时记事本），Writer 在 checkpoint 时读取、归类、清空

**四层记忆结构**：

| 层级 | 文件 | 用途 | 维护者 |
|------|------|------|--------|
| Session 记忆 | `checkpoint.md` | 当前会话工作状态快照 | Writer sub-agent |
| Project 记忆 | `MEMORY.md` | 跨会话架构决定、用户规则 | Writer sub-agent |
| Global 记忆 | 全局配置 | 用户级偏好，跨项目生效 | Writer sub-agent |
| History | SQLite 永久存档 | 每条消息和每次工具调用原文 | 自动记录 |

**Checkpoint 文件 11 个结构化字段**：
1. 当前意图
2. 下一步动作
3. 工作约束
4. 任务树
5. 当前工作文件
6. 涉及文件列表
7. 跨任务发现
8. 错误与修复
9. 运行时状态
10. 设计决策
11. 杂项笔记

**对 RouteDev 的启示**：
- RouteDev 当前的 Memory 层只有公共黑板 + 私有笔记，缺少**增量 checkpoint 机制**
- 建议增加 `CheckpointWriter` 组件，独立维护记忆
- 在 token 消耗达到 20%/45%/70% 时自动触发 checkpoint
- checkpoint 文件使用结构化格式（而非简单摘要）

#### 2. Compose 模式（可参考）

**设计**：按 Tab 键切换 Build/Plan/Compose 三种模式
- **Build**：默认开发模式，全权限
- **Plan**：只读分析模式
- **Compose**：编排模式，自动编排需求分析→编码→测试→审查全流程

**Compose 模式内置 13 个聚焦技能**：
- 测试类：TDD、Debug、Verify
- 协作类：Brainstorm、Plan、Execute、Dispatch、Review、Receive
- Git 类：Worktree、Finish
- 元开发类：Write Skill

**对 RouteDev 的启示**：
- RouteDev 的自主度模式（全自动/半自动/手动）可以扩展为**工作模式**（Build/Plan/Compose）
- Compose 模式可以作为 Phase 6 插件生态的一部分
- 技能系统可以作为插件的一种形式

#### 3. 自进化机制（可参考）

- `/dream` 命令：每 7 天自动触发，独立 Agent 读取历史会话，合并、去重、压缩记忆
- `/distill` 命令：每 30 天自动识别反复出现的工作模式，固化为可复用技能

**对 RouteDev 的启示**：
- RouteDev 的记忆压缩是自动的，但缺少**定期整理**机制
- 可以增加 `/dream` 类似的命令，定期整理项目记忆
- `/distill` 可以作为技能/插件的自动发现机制

#### 4. Goal 验证机制（可参考）

- 用 `/goal` 命令设定自然语言停止条件，如"所有测试通过且代码已提交"
- Agent 每次尝试终止时，用**独立的模型调用**审查完整对话历史，判断条件是否真正满足
- 独立裁判不参与实际工作，不存在"自我感觉良好"的认同偏差

**对 RouteDev 的启示**：
- RouteDev 当前的任务报告是完成后用户主动查看
- 可以增加 Goal 验证机制：独立 Agent 审查任务完成度
- 防止 Agent 过早终止（"自我感觉良好"）

#### 5. 语音输入（特色功能）

- `/voice` 命令激活实时流式语音识别
- 语音按停顿自动分段、增量转写进输入框
- 基于 TenVAD + MiMo ASR

**对 RouteDev 的启示**：
- RouteDev 已规划语音输入（Web Speech API）
- 可以参考 MiMo Code 的"按停顿自动分段"设计
- 但 MiMo Code 语音仅对登录用户开放，RouteDev 应考虑离线方案

#### 6. 安装与配置

- 一行命令安装：`curl -fsSL https://mimo.xiaomi.com/install | bash`
- 首次启动引导选择模型接入方式（4 个选项）
- `/init` 命令分析项目结构，创建 `AGENTS.md`
- 支持 75+ 家 LLM 提供商

**对 RouteDev 的启示**：
- RouteDev 的配置向导可以借鉴 MiMo Code 的首次启动引导
- `/init` 命令自动生成项目规则文件是个好设计
- 支持多提供商接入已规划

#### 7. 性能数据

- SWE-Bench Pro V2: MiMo Code 62% vs Claude Code 57%
- Terminal Bench 2: MiMo Code 73% vs Claude Code 68%
- 200 步以内胜率接近 50:50，超过 200 步后 MiMo Code 胜率升至 65%+
- **结论**：任务越复杂、轮次越多，持久记忆的优势越明显

---

## ZCode 3.0 (智谱 AI, 2026-06-13 发布)

### 核心定位
全功能 Agentic 开发环境（ADE），围绕 GLM-5.2 深度联调，专为长周期开发任务设计。

### 五大核心亮点（可参考）

#### 1. 自研 Agent 内核 + 模型深度联调

**设计**：
- 完全围绕自研 GLM-5.2 做全链路优化
- 不是套壳通用 Agent，而是专门为开发场景自研
- 围绕「任务→权限→上下文→工具调用→提交验收」打造统一工作流

**对 RouteDev 的启示**：
- RouteDev 提取自 PilotDeck，是通用框架
- 如果未来要深度优化某个模型（如 DeepSeek），可以参考这种"模型+Agent 协同优化"思路
- 但 RouteDev 的核心价值是**多模型路由**，不应绑定单一模型

#### 2. 多端协同（特色）

**设计**：
- 桌面端：本地深度开发
- Remote 手机端：查看进度、补充指令
- 飞书/微信 Bot：直接 @Bot 派任务、看进度

**对 RouteDev 的启示**：
- RouteDev 当前只规划了桌面端（Tauri）
- 多端协同可以作为远期扩展，但不是 Phase 1-6 的优先级
- 飞书/微信 Bot 适配国内办公生态是 ZCode 的差异化优势

#### 3. 安全管控（可参考）

**设计**：
- 所有高权限操作、关键命令、核心文件修改，执行前触发安全确认流程
- 全流程可追溯
- 企业级安全

**对 RouteDev 的启示**：
- RouteDev 已规划安全边界（目录边界、命令黑白名单、敏感文件保护）
- 可以加强"执行前确认"的 UI 体验（如 ZCode 的弹窗确认）
- 增加操作日志和追溯能力

#### 4. 工作区 + 任务管理（可参考）

**设计**：
- 分组式任务工作区，支持拖拽折叠、跨区迁移和批量管理
- Zread 模块自动生成结构化项目文档
- 可视化 Git 分支图谱
- AI 自动生成变更审查

**对 RouteDev 的启示**：
- RouteDev 的 Notion 卡片编辑器可以扩展为**工作区**概念
- 可视化 Git 分支可以作为 UI 增强
- AI 自动生成变更审查已规划（任务报告）

#### 5. 快捷指令系统（可参考）

**设计**：
- `@文件名`：引用指定文件
- `/命令`：调用内置工具命令
- `$技能`：调用预设专业技能
- `#对话`：关联历史对话

**对 RouteDev 的启示**：
- RouteDev 已有 `/goal`、`/auto` 等命令
- 可以增加 `@文件名` 快捷引用（类似 Trae 的 `@` 功能）
- `$技能` 可以作为插件/技能的快捷调用方式

---

## 综合对比与 RouteDev 定位

| 维度 | MiMo Code | ZCode 3.0 | RouteDev（规划） |
|------|-----------|-----------|-----------------|
| 形态 | 终端 Agent | 桌面 IDE + 多端 | 桌面应用（Tauri） |
| 开源 | MIT | 闭源 | AGPL-3.0 |
| 模型 | MiMo-V2.5 为主 | GLM-5.2 深度绑定 | 多模型路由（省钱） |
| 记忆 | 四层 + 增量 checkpoint | 长上下文稳定 | 公共黑板 + 私有笔记 |
| 多 Agent | Writer sub-agent | 自研 Agent 内核 | Orchestrator Workers |
| 自主度 | Build/Plan/Compose | 全自主闭环 | 可配置（auto/semi/manual） |
| 特色 | 持久记忆、自进化 | 多端协同、深度联调 | 智能路由、省钱 |
| 目标用户 | 终端重度用户 | 国内团队/企业 | 个人开发者 |

### RouteDev 的差异化策略

1. **多模型路由是核心壁垒**：MiMo Code 和 ZCode 都绑定自家模型，RouteDev 的跨模型智能路由是独特价值
2. **持久记忆需补强**：MiMo Code 的增量 checkpoint 机制比 RouteDev 当前设计更先进，建议吸收
3. **自进化可作为远期特性**：`/dream` 和 `/distill` 是 nice-to-have，不是 MVP 必需
4. **Goal 验证建议加入**：防止 Agent 过早终止，提升可靠性
5. **工作区概念可扩展**：Notion 卡片编辑器 + 工作区 = 更强大的任务管理
6. **快捷指令系统可丰富**：`@` 引用文件、`$` 调用技能

### 建议纳入 RouteDev 设计的新特性

| 优先级 | 特性 | 来源 | 说明 |
|--------|------|------|------|
| 高 | 增量 Checkpoint 机制 | MiMo Code | 在 20%/45%/70% token 消耗时触发，独立 Writer 维护 |
| 高 | Goal 验证机制 | MiMo Code | 独立 Agent 审查任务完成度 |
| 中 | 工作模式切换 | MiMo Code | Build/Plan/Compose 或类似 |
| 中 | `/dream` 记忆整理 | MiMo Code | 定期整理项目记忆 |
| 中 | 快捷指令系统 | ZCode | `@文件`、`$技能`、`#对话` |
| 低 | 自进化技能发现 | MiMo Code | `/distill` 自动发现工作模式 |
| 低 | 多端协同 | ZCode | 手机 Remote、Bot 集成 |
| 低 | 模型深度联调 | ZCode | 绑定特定模型优化（与 RouteDev 理念冲突） |
