# Phase 45 — Pi 人格化交互与主动记忆落地

> **版本目标：** v3.6.0
> **前置依赖：** Phase 44（v3.5.0 消息节点化与分支化对话增强）完成
> **新增测试要求：** ≥ 30 个
> **研究依据：** Pi Agent（Inflection AI）产品分析；RouteDev 当前 ChatPage / SettingsPage / SetupWizard 实现；社区痛点调研中"AI 交互冷漠、重复确认、学习成本高"等反馈
> **核心命题：** RouteDev 当前在工具调用、代码执行、多 Agent 编排等功能层面已较为完整，但交互体验仍偏向"工具"而非"搭档"。Pi Agent 的核心启示是：在编程 Agent 这类高频、长时长、高认知负载的场景中，情感智能（EQ）与认知智能（IQ）同样能影响用户留存与任务成功率。本 Phase 将 Pi 可借鉴点按优先级落地为——高优先级：人格化系统提示词与发现页/快捷启动；中优先级：语音交互与主动个性化记忆。目标不是让 RouteDev 变成聊天机器人，而是在不降低专业能力的前提下，让 Agent 更懂用户当前状态、更少重复确认、更快进入心流。

---

## 项目现状审计与可行性结论

### 1. 已具备的实现基础

| 模块 | 当前状态 | 本 Phase 可复用度 |
|------|---------|------------------|
| `useRouteDevStore` / `ChatPage.tsx` | 消息流、发送、停止、工具卡片渲染 | 高（人格化输出与语音输入在此注入） |
| `SettingsPage.tsx` | Provider、模型、路由规则、Agent Profile 配置 | 高（新增 Persona / Memory / Voice Tab） |
| `SetupWizard.tsx` | 首次启动向导 | 高（扩展为发现页入口） |
| `tailwind.config.js` + `index.css` | 语义 token 设计系统、主题切换 | 高（Persona 主题色、记忆徽章、语音波形动画） |
| `src/agent/prompts/`（各 Phase 沉淀） | system prompt 模板体系 | 高（Persona Prompt 在此扩展） |
| `KnowledgeGraph` / `projectMemory`（Phase 38/43） | 项目记忆、实体关系、自动注入 | 高（主动记忆的存储与召回基础） |
| `TaskClassifier` / `Router`（Phase 03/31） | 任务分类与模型路由 | 中（用于选择轻量/复杂任务下的人格化强度） |
| `ToolCallCard.tsx` / `TaskMonitorPanel.tsx` | 工具调用与任务监控 UI | 中（语音模式时需要简化视觉反馈） |

### 2. 尚未落地的关键缺口

| 缺口 | 影响 | 本 Phase 处理方式 |
|------|------|------------------|
| 系统提示词无"人格"维度 | 所有回复语气一致，无法适配用户情绪或经验水平 | Task 1 人格化系统提示词引擎 |
| 启动后无快速入口 | 用户每次都要重新组织语言发第一条消息 | Task 2 发现页与快捷启动 |
| 无语音交互能力 | 长提示词输入、移动场景受限 | Task 3 语音输入与朗读 |
| 记忆只记录"事实"，不学习偏好 | 反复询问用户的技术栈、命名风格、确认偏好 | Task 4 主动个性化记忆 |
| 情绪/疲劳信号无感知 | 用户在复杂调试中容易烦躁，Agent 无法调整节奏 | Task 5 EQ 感知与节奏调节 |
| GUI 缺少人格化反馈元素 | 语气、头像、状态动效、记忆提示均缺失 | Task 6 GUI 人格化表达 |

### 3. 可行性总评

- **人格化系统提示词：** 高度可行。Pi 的实现路径（RLHF + 同理心微调）对闭源模型训练依赖重，但 RouteDev 可通过"基础人格 prompt + 动态语气片段 + 输出后处理"在应用层获得 80% 效果。
- **发现页/快捷启动：** 高度可行。`SetupWizard` 已完成步骤式引导，扩展为常驻"发现页"成本较低。
- **语音交互：** 可行。桌面端可使用 Web Speech API（限制多）或集成 Whisper.cpp / 系统 TTS；考虑到隐私与离线需求，优先采用本地 Whisper + 系统语音合成，API 语音为可选增强。
- **主动个性化记忆：** 可行。`KnowledgeGraph` 已支持实体与关系，`projectMemory` 已支持自动注入，本 Phase 只需增加"偏好推断"与"记忆置信度"机制。
- **EQ 感知与节奏调节：** 可行。通过规则 + 轻量分类模型识别用户情绪与任务挫败信号，调整回复长度、确认频率、解释深度。
- **GUI 人格化表达：** 高度可行。`tailwind.config.js` 设计系统已成熟，只需新增少量组件和动画。

---

## 核心设计原则

### 原则 1：人格化是"调味剂"，不是"替代品"

RouteDev 首先是编程 Agent，必须保证代码正确性、安全性、可观测性。人格化只影响：
- 回复的语气与解释详细度
- 确认的频率与表达方式
- 错误/失败时的安抚与引导
不牺牲：工具调用的准确性、安全护栏、代码审查标准。

### 原则 2：用户始终能关闭人格化

所有人格化功能默认"温和"开启，并在设置中提供显式开关：
- 人格强度：`none` / `low` / `medium` / `high`
- 语音：`off` / `input only` / `output only` / `full duplex`
- 主动记忆：`off` / `prompt only` / `auto`
不允许人格化干扰专业输出或造成困扰。

### 原则 3：主动记忆必须可解释、可审查

记忆不是黑盒。系统需要：
- 告诉用户"我记住了什么"
- 允许用户查看、编辑、删除记忆
- 记忆变更必须写入审计日志

### 原则 4：EQ 感知只调节交互节奏，不替代用户决策

EQ 感知的结果（用户可能疲惫/困惑/急躁）只用于：
- 缩短回复、减少确认步骤
- 主动提供摘要或下一步建议
- 放缓复杂操作，先解释意图
不用于：绕过安全确认、自动执行高风险操作、替用户做价值判断。

---

## Task 1：人格化系统提示词引擎（≥ 8 测试）

### 1.1 人格维度模型

将"人格"从单一 prompt 拆分为可组合维度：

```typescript
interface PersonaConfig {
  id: string;
  name: string;                 // 如 "协作者" / "导师" / "极客"
  tone: 'supportive' | 'concise' | 'playful' | 'mentor';
  explanationDepth: 1 | 2 | 3;  // 1=极简，2=适中，3=详细
  emojiUsage: 'none' | 'sparse' | 'moderate';
  confirmationStyle: 'ask' | 'suggest' | 'inform'; // 操作前是否询问
  verbosity: number;            // 0.0 ~ 1.0，影响回复长度
  systemPromptAddendum: string; // 追加到基础 system prompt 的人格片段
}
```

内置三种人格模板：
- **协作者（Collaborator）**：默认。友好、支持性、会简要解释每一步意图，适合大多数开发者。
- **导师（Mentor）**：对初学者更耐心，解释详细，主动提供学习链接与最佳实践。
- **极客（Hacker）**：简洁、直接、减少寒暄，适合资深开发者，默认关闭 emoji。

### 1.2 动态人格片段注入

在 `callLLMStream` 之前，根据当前上下文组装 system prompt：

```typescript
function buildPersonaFragment(
  persona: PersonaConfig,
  userSignals: UserInteractionSignals,
): string {
  // 用户多次打断 → 切换为更简洁模式
  // 用户连续询问基础问题 → 切换为导师模式
  // 代码出现多次错误 → 增加安抚语气
}
```

注入位置：紧跟基础 system prompt 之后、工具说明之前。确保人格片段不会覆盖安全与格式约束。

### 1.3 与 TaskClassifier 联动

简单任务可搭配"高人格化 + 低确认"以提升流畅感；复杂架构任务搭配"低人格化 + 高信息密度"以保持专业。分类器输出增加 `personaIntensity` 建议字段。

### 1.4 测试要求

- 三种内置人格生成的回复在语气、长度、解释深度上可区分。
- 动态人格片段根据用户信号正确切换。
- 人格片段不会覆盖工具调用格式要求。
- 用户选择 `none` 人格后，系统不注入任何额外语气片段。
- 人格配置持久化并在重启后恢复。
- 不同人格下确认频率符合配置。
- 人格化开关在运行时切换无需重启。
- 人格片段注入对 token 消耗的增加可量化（≤ 5%）。

---

## Task 2：发现页与快捷启动（≥ 6 测试）

### 2.1 发现页入口

将 `SetupWizard` 完成后直接进主界面的逻辑扩展为：首次启动或点击"发现"时显示 `DiscoveryPage`：

```tsx
<DiscoveryPage
  recentProjects={projects}
  suggestedTasks={suggestedTasks}
  quickActions={quickActions}
  onSelectTask={(text) => sendMessage(text)}
/>
```

发现页内容：
- **继续对话**：最近 3 个项目/对话
- **推荐任务**：基于当前项目类型生成（如"给这个项目添加单元测试"、"生成 README"）
- **快捷操作**：新建任务、打开设置、查看分支实验、查看 token 消耗
- **学习路径**：针对首次用户展示"3 分钟了解 RouteDev"卡片

### 2.2 推荐任务生成

推荐任务来源（优先级从高到低）：
1. 项目记忆 / KnowledgeGraph 中识别的缺口（如"项目缺少错误处理中间件"）
2. 通用模板（按项目语言：TypeScript/Python/Java 等）
3. 用户最近未完成的目标

避免在用户未选择项目时推荐与代码相关的任务。

### 2.3 快捷启动命令

在 ChatPage 输入框上方增加快捷芯片（chips）：

```tsx
<QuickStartChips
  chips={[
    { label: '解释当前文件', prompt: '请解释当前项目的核心架构' },
    { label: '添加测试', prompt: '为最近修改的模块添加单元测试' },
    { label: '审查代码', prompt: '审查当前分支的代码变更' },
  ]}
/>
```

用户点击后自动填入输入框并发送（或仅填入，等待用户编辑）。

### 2.4 测试要求

- 首次完成 SetupWizard 后显示发现页。
- 发现页可跳过并在设置中重新打开。
- 推荐任务基于当前项目类型正确生成。
- 快捷芯片点击后正确触发 sendMessage。
- 最近对话列表按时间排序。
- 发现页在窄屏下可正常滚动。

---

## Task 3：语音交互（≥ 6 测试）

### 3.1 语音输入

桌面端实现"按住说话"或"点击说话"：

```tsx
<VoiceInputButton
  onTranscript={(text) => setInput(text)}
  provider='whisper-local' // 或 'web-speech' / 'openai-whisper'
/>
```

实现策略：
- **默认本地**：集成 whisper.cpp Node binding 或调用本地 Ollama  speech 扩展，保证离线可用。
- **可选云端**：用户可在设置中切换到 OpenAI Whisper API，获得更高准确率。
- **隐私保护**：语音数据不离开本地（本地模式），或明确提示云端模式。

### 3.2 语音朗读（TTS）

对 Assistant 的最终回复提供朗读按钮：

```tsx
<TTSButton content={finalAssistantContent} />
```

实现策略：
- 优先使用操作系统 TTS（Windows SAPI / macOS say / Linux espeak）。
- 可选云端 TTS（OpenAI / ElevenLabs）。
- 只朗读"最终回复"，不朗读工具调用过程、思考过程。

### 3.3 语音模式下的 UI 简化

当用户启用语音输入/输出时：
- ToolCallCard 默认折叠，仅显示状态图标
- TaskMonitorPanel 显示为精简时间线
- 语音输入时显示波形动画，让用户感知正在收音

### 3.4 测试要求

- 语音输入正确转录中文与英文代码术语。
- 本地模式下不发起网络请求。
- 语音朗读只朗读最终回复。
- 语音模式切换时 UI 正确简化。
- 语音输入失败时提供文本输入回退。
- 语音功能开关持久化。

---

## Task 4：主动个性化记忆（≥ 6 测试）

### 4.1 偏好类型

从用户交互中推断并记忆以下偏好：

```typescript
interface UserPreference {
  id: string;
  category: 'tech_stack' | 'coding_style' | 'communication' | 'workflow' | 'security';
  key: string;
  value: string;
  confidence: number;      // 0.0 ~ 1.0
  source: 'explicit' | 'inferred';
  updatedAt: number;
}
```

示例：
- `tech_stack:preferred_language = TypeScript`（从项目文件推断）
- `coding_style:comments = Chinese`（从用户编辑行为推断）
- `communication:detail_level = concise`（从用户频繁缩短回复推断）
- `workflow:auto_confirm = read-only`（从用户历史确认行为推断）
- `security:never_push = true`（从用户拒绝推送行为推断）

### 4.2 推断触发点

- 用户显式声明："我喜欢用中文注释" → 直接写入，confidence=1.0
- 用户连续 3 次拒绝某类确认 → confidence 逐步提升
- 用户手动修改 Agent 输出后保留特定风格 → 记录为偏好
- 项目首次加载时分析文件推断 tech_stack 偏好

### 4.3 记忆注入策略

将高置信度偏好以结构化方式注入 context：

```text
用户已知偏好：
- 技术栈：TypeScript + React + NeoForge
- 注释语言：中文
- 沟通风格：简洁
- 低风险读取操作可自动放行
```

注入位置：system prompt 末尾或每轮 user message 的 prefix。优先采用 system prompt 方式，避免污染用户输入。

### 4.4 记忆审查 UI

在 SettingsPage 增加"我的偏好"子页面：
- 列表展示所有记忆偏好
- 支持编辑、删除、一键导出
- 显示每个偏好的来源与置信度
- 提供"暂停自动学习"开关

### 4.5 测试要求

- 显式声明的偏好立即写入并注入上下文。
- 推断偏好的置信度随证据增加而提升。
- 低置信度偏好不注入，避免误导 Agent。
- 用户删除偏好后，下一轮对话不再注入。
- 偏好变更写入审计日志。
- 多项目之间共享全局偏好，项目级偏好覆盖全局。

---

## Task 5：EQ 感知与节奏调节（≥ 4 测试）

### 5.1 信号采集

从交互中采集 EQ 信号：

```typescript
interface UserInteractionSignals {
  consecutiveEdits: number;       // 用户连续手动修改次数
  consecutiveRollbacks: number;   // 连续回退次数
  interruptionCount: number;      // 主动打断生成次数
  repeatedPrompts: number;        // 重复发送相似指令次数
  responseLatencyTrend: 'up' | 'down' | 'stable'; // 用户等待时长趋势
  lastErrorSeverity?: 'low' | 'medium' | 'high';
}
```

### 5.2 节奏调节规则

基于信号触发调节：
- `consecutiveRollbacks >= 2` → 增加确认步骤、先展示影响范围再执行
- `interruptionCount >= 2` → 缩短中间思考输出、提高回复信息密度
- `repeatedPrompts >= 2` → 主动询问"我是否理解错了你的需求？"
- `consecutiveEdits >= 3` → 提示"是否需要我换一种实现方式？"

### 5.3 与 Persona 联动

EQ 信号优先影响"当前轮次"的人格强度，而不是永久修改人格配置。例如：
- 检测到用户急躁 → 当前轮切换为 concise 语气
- 检测到用户困惑 → 当前轮切换为 mentor 语气并增加解释

### 5.4 测试要求

- 连续回退信号触发影响范围预览。
- 连续打断信号触发中间输出折叠。
- 重复指令信号触发澄清询问。
- EQ 调节不绕过安全确认。

---

## Task 6：GUI 人格化表达（≥ 6 测试）

### 6.1 Agent 头像与状态动效

在 ChatPage 中为 Assistant 消息增加小型头像/标识：
- 不同人格显示不同主题色与图标
- 思考中显示柔和脉冲动画，避免"死机感"
- 生成完成时短暂显示成功 micro-animation

### 6.2 记忆提示徽章

当 Agent 使用了用户的某个偏好时，在消息末尾显示小型徽章：

```tsx
<MemoryBadge category='coding_style' key='comments' />
// 显示：📝 已按你的偏好使用中文注释
```

点击徽章可跳转到"我的偏好"设置页。

### 6.3 语音波形与输入反馈

语音输入时显示实时波形；语音转写完成后显示"你说：..."确认条，用户可在发送前编辑。

### 6.4 发现页视觉

发现页使用大卡片、圆角、柔和阴影、主题色渐变，符合用户偏好中"大按钮带文字标签、圆角整体、浅灰/蓝主题"。

### 6.5 测试要求

- 不同人格下 Assistant 头像/标识正确变化。
- 思考动画在生成期间持续显示。
- 记忆徽章只在实际使用了对应偏好时显示。
- 语音波形在收音时显示，停止后消失。
- 发现页在 white/gray/blue 主题下视觉一致。
- 所有新增组件遵循 `rd-*` 语义 token。

---

## Task 7：集成测试与文档同步（≥ 4 测试）

### 7.1 端到端测试

1. **人格化端到端：** 用户选择"导师"人格 → 询问基础问题 → 回复包含详细解释与最佳实践 → 切换为"极客"人格 → 回复显著变短。
2. **主动记忆端到端：** 用户声明"我用中文注释" → Agent 后续生成代码使用中文注释 → 用户在设置中删除该偏好 → 后续代码恢复默认。
3. **发现页端到端：** 首次启动完成 SetupWizard → 显示发现页 → 点击"添加测试" → 自动发送对应 prompt → Agent 执行测试生成。
4. **EQ 节奏调节端到端：** 用户连续回退两次 → 下一次 Agent 执行多文件修改前展示影响范围预览 → 用户确认后才执行。

### 7.2 文档同步

- **PERSONA.md：** 新增人格化系统提示词架构、内置人格模板、动态注入规则。
- **MEMORY.md：** 补充主动个性化记忆的类型、推断规则、注入策略、审查 UI。
- **VOICE.md：** 新增语音输入/输出实现、本地/云端模式、隐私说明。
- **UI.md：** 新增 `DiscoveryPage`、`VoiceInputButton`、`TTSButton`、`MemoryBadge`、`PersonaSelector` 组件说明。
- **CHANGELOG.md：** v3.6.0 条目。
- **config schema：** 新增 `persona`、`voice`、`memory.inference`、`discovery` 配置段。

---

## 新增陷阱警告

**118. 人格化 prompt 不能覆盖安全约束：** 人格片段追加在基础 system prompt 之后，安全护栏和工具格式要求必须具有更高优先级，防止"过度友好"导致绕过确认。

**119. 主动记忆的低置信度偏好必须隔离：** confidence < 0.7 的推断偏好不得注入上下文，只能作为候选展示给用户确认，避免 Agent 被错误假设带偏。

**120. 语音模式不能泄露思考过程：** TTS 只朗读最终 assistant content，工具调用、reasoning、未完成的流式片段不得朗读。

**121. EQ 感知不能用于绕过权限确认：** 即使用户表现出急躁，高风险操作（删除、推送、网络请求）仍需确认，EQ 只能影响表达方式和信息密度。

**122. 人格化不是默认高甜腻：** 默认人格必须是"协作者"而非"过度热情"，避免资深开发者反感。emoji 默认 sparse。

**123. 发现页推荐必须考虑隐私：** 基于项目文件推断任务时，不能将敏感文件名或 API Key 暴露到 UI 推荐卡片中。

**124. 语音本地模型必须做回退：** 本地 Whisper 加载失败时，必须自动回退到文本输入，不能卡死。

**125. 人格化配置需要与 Sub-Agent 解耦：** 子 Agent（researcher/executor/reviewer）应使用自己的专业人格，不受主 Agent 娱乐化设置影响，避免降低代码质量。

---

## 思考引导总结

1. **Pi 的 RLHF 训练路径能否在 RouteDev 复现？** 不能直接复现，但可以在应用层通过"基础人格 prompt + 动态片段 + 输出后处理"获得大部分体验收益，且成本可控。

2. **人格化会不会让代码变"水"？** 关键在于分层：人格只影响 system prompt 的"语气与解释"部分，不影响工具调用格式、安全规则、代码生成指令。子 Agent 使用独立的专业人格。

3. **主动记忆和项目记忆的区别？** 项目记忆记录"项目是什么"（结构、API、决策）；主动记忆记录"用户是谁"（偏好、风格、习惯）。两者都注入上下文，但来源与生命周期不同。

4. **语音交互优先本地还是云端？** 默认本地，优先保障隐私与离线；云端作为可选增强。这与 RouteDev 桌面端 + 本地模型的差异化优势一致。

5. **EQ 感知用规则还是模型？** 先用规则实现 MVP（阈值触发），复杂场景（情绪识别）可后续引入轻量分类模型，避免过度消耗 token。

6. **发现页和 NewTaskPage 的关系？** `NewTaskPage` 是用户主动创建任务的表单；`DiscoveryPage` 是被动推荐的快捷入口。两者可以共存：发现页中的"新建自定义任务"跳转到 `NewTaskPage`。

7. **执行顺序建议：** Task 1（人格化引擎） → Task 4（主动记忆） → Task 6（GUI 表达） → Task 2（发现页） → Task 5（EQ 感知） → Task 3（语音交互） → Task 7（集成测试）。人格化是基础，语音实现成本最高，放后。
