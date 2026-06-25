# Phase 48 — 引用系统与外部生态兼容层

> **版本目标：** v3.9.0
> **前置依赖：** Phase 47（v3.8.0 开发者工作流产品化）完成
> **新增测试要求：** ≥ 55 个
> **研究依据：** 用户关于"右键引用"和"Codex / Claude Code 插件复用"的讨论；对 SonettoHere（`github.com/Miso2233/SonettoHere`）的源码精读（`web/src/utils/references.ts`、`web/src/components/ChatInput.vue`、`web/src/components/ChatWindow.vue`、`web/src/components/MessageBubble.vue`、`web/src/composables/useChat.ts`、`api/routes/skills.py`、`tools/mcp.py`）；对 APIX（`github.com/JJJJSTIYYYY/Apix`，Version 2.1.1）的产品特性研读；Claude Code 的 Anthropic Skills 目录规范；OpenAI Codex CLI 的 `.codex/instructions.md` 项目级配置；RouteDev 当前 `desktop/renderer/src/pages/ChatPage.tsx`、`src/agent/branch.ts`、`src/code-map/`、`src/skills/`、`src/hooks/`、`src/config/schema.ts` MCPConfig、`src/agent/profiles/` 实现
> **核心命题：** SonettoHere 证明了"引用系统"能显著提升对话精度，但它的实现停留在前端糖衣层：引用被序列化为 `__refs__{json}__/refs__` 块拼在消息末尾，后端并不结构化解析，AI 能否理解引用完全取决于 system prompt 是否训练过该格式。RouteDev 要借鉴其标签 UI、右键引用、`@/#/!` 触发器、粘贴 URL 自动识别等交互，但必须在后端真正解析引用，把文件引用变成自动/半自动的 `read_file`、把文本引用注入带标注的上下文、把 Skill/Tool 引用变成该消息可用的工具约束。APIX 则进一步证明：消息节点化管理（编辑/删除历史消息并自动分支）和多协议 MCP 兼容已是同类产品的基线能力；RouteDev 的引用系统必须把这种"节点可变性"纳入设计——引用不能假设目标消息一成不变，必须处理目标被编辑、删除、分支隔离后的失效与重建问题。同时，RouteDev 的生态不应封闭：要兼容 Claude Code 的 Anthropic Skills 目录结构，导入 `.codex/instructions.md`，桥接 MCP 配置（并覆盖 APIX 已支持的 SSE/WebSocket/Streamable HTTP 等传输），并引入 SonettoHere 式的轻量 Macro 系统。

---

## 项目现状审计与可行性结论

### 1. 已具备的实现基础

| 模块 | 当前状态 | 本 Phase 可复用度 |
|------|---------|------------------|
| `desktop/renderer/src/pages/ChatPage.tsx` | 桌面端聊天主页面 | 高（引用标签 UI 的载体） |
| `src/cli/components/ChatView.tsx` + `InputBox.tsx` | CLI 消息渲染、输入框 | 中（CLI 后续补充） |
| `src/agent/branch.ts` | 消息节点树（Phase 25/44） | 高（引用历史消息节点） |
| `src/code-map/`（Phase 42） | 代码地图引擎 | 高（引用文件/符号的语义来源） |
| `src/skills/market-manager.ts` + `skill-md-parser.ts` | Skill 市场、SKILL.md 解析 | 高（兼容 anthropic_skills） |
| `src/hooks/` | Hook 生成、执行、安全审查、沙箱试用 | 高（社区来源 Hook 的安全策略复用） |
| `src/config/schema.ts` MCPConfig | MCP server 配置（stdio/http） | 高（桥接 `.mcp.json` / YAML） |
| `src/agent/profiles/`（Phase 43） | Agent Profile 体系 | 中（导入 Claude Code agents） |
| `src/prompts/manager.ts` | Prompt 管理、项目级 system prompt | 高（导入 Codex instructions） |
| `src/tools/registry.ts` + `permission-engine.ts` | 工具注册与权限 | 高（引用触发的工具约束） |

### 2. 尚未落地的关键缺口

| 缺口 | 影响 | 本 Phase 处理方式 |
|------|------|------------------|
| GUI 输入框无引用能力 | 用户只能复制粘贴，无法精准引用 | Task 1 引用系统核心 |
| 无 `@`/`#`/`!` 触发器 | 无法快速引用 Skill/Tool/Macro | Task 1.4 触发器补全 |
| 后端不解析引用 | 引用只是文本装饰，AI 不一定理解 | Task 1.8 后端引用解析器 |
| 无法引用历史消息节点 | 用户想追问某条消息的某句话，只能复述 | Task 1.5 消息引用 |
| 引用的消息被编辑/删除后无失效处理 | 消息节点化后目标可变，引用可能指向过期内容 | Task 1.5 引用版本与失效 |
| MCP 仅支持基础 stdio/http | APIX 已支持 SSE/WebSocket/Streamable HTTP 等多协议 | Task 4.1 多协议 MCP 支持 |
| 无法复用 Claude Code Skill 生态 | anthropic_skills/ 目录被忽略 | Task 2 Anthropic Skills 兼容 |
| 无法复用 Codex 项目级配置 | `.codex/instructions.md` 被忽略 | Task 3 Codex Instructions 导入 |
| MCP 配置不互通 | Claude Code 和 RouteDev 各配一套 | Task 4 MCP 桥接 |
| 无 Macro 系统 | 用户无法固化轻量工作流 | Task 5 Macros 系统 |

### 3. 可行性总评

- **引用系统前端：** 高度可行。RouteDev 桌面端已有 ChatPage/InputBox，可仿照 SonettoHere 的 `file-refs-bar` + `ReferenceChip` + `AutocompletePanel` 实现。
- **引用系统后端：** 可行。RouteDev 已有工具执行链和 PromptManager，只需在 `sendUserMessage` 前插入 `CiteResolver`，把引用解析为工具调用/上下文注入。
- **Anthropic Skills 兼容：** 高度可行。`anthropic_skills/<name>/SKILL.md` 结构与 RouteDev Skill 完全一致，直接复用 `SkillMdParser`。
- **Codex Instructions 导入：** 高度可行。`.codex/instructions.md` 是纯文本，可直接作为项目级 system prompt 或项目记忆。
- **MCP 桥接：** 高度可行。MCP 是标准协议，Claude Code 的 `.mcp.json` 与 RouteDev `MCPConfig` 字段直接映射；SonettoHere 的 `tools/mcp.py` 已验证 SSE、WebSocket、Streamable HTTP 等传输的可行性，RouteDev 可直接对齐。
- **Macros 系统：** 高度可行。SonettoHere 的 Macro 就是 `macros/<name>/MACRO.md`，RouteDev 已有 Skill 体系，Macro 是 Skill 的轻量子集。
- **消息引用与节点可变性：** 可行但需小心。RouteDev 的 `BranchNode`（`src/agent/branch.ts`）目前没有 `refs` 字段，但消息节点树已成熟；给节点追加 `refs` 并在 fork/edit/delete 时维护引用版本，是 APIX 已验证的产品路径。

---

## 核心设计原则

### 原则 1：前端糖衣 + 后端引擎

借鉴 SonettoHere 的前端交互，但**绝不做"只拼字符串"的引用**。引用必须被后端解析：
- 文件/文件夹引用 → 自动/半自动读取内容，注入上下文
- 文本引用 → 作为 `[用户引用的原文]` 注入用户消息
- Skill 引用 → 将该 Skill 的 system prompt 追加到本次请求
- Tool 引用 → 本次请求仅允许使用该 Tool（或提升其优先级）
- Macro 引用 → 将 Macro 内容作为 system prompt 追加
- URL 引用 → 自动/半自动 `web_fetch`，注入网页摘要
- 消息引用 → 注入被引用消息的内容和索引

### 原则 2：引用标签是视觉独立的"框"

与 SonettoHere 一致，引用内容在输入框上方以胶囊标签展示：
- 图标 + 名称 + 类型徽章 + 删除按钮
- 长文本截断显示，悬浮显示全文
- 被安全策略阻挡的文件显示红色 `blocked` 徽章
- 多个标签可换行排列，有入场/退场动画

### 原则 3：引用随消息持久化，但不绑定到节点树

- 每条用户消息携带 `refs: CiteItem[]`，显示在消息气泡下方
- 切换分支/会话时，已发送消息的引用仍然可见
- 当前输入框的引用是临时的，发送后清空；引用本身不成为消息节点树的一部分

### 原则 4：外部生态兼容不是"照单全收"

导入外部 Skill/Macro/MCP/Instructions 时，必须经过：
1. **Schema 转换** → 映射到 RouteDev 的数据结构
2. **工具名翻译**（仅 Claude Code commands）→ 遗留工具名映射到 RouteDev 对应工具
3. **安全审查** → Hook/MCP/工具权限检查
4. **来源标注** → 导入后显示"来自 Anthropic Skills / Codex / 社区"
5. **社区确认** → 非官方来源默认不直接启用，需用户确认或沙箱试用

### 原则 5：CLI 与 GUI 能力对齐，但 GUI 优先

- 引用功能先在 GUI 实现（右键、拖拽、触发器）
- CLI 后续补充键盘选择模式和 `/cite` 命令
- 两者底层共用同一套 `CiteManager` 和 `CiteResolver`

---

## Task 1：引用系统核心（≥ 16 测试）

### 1.1 引用数据结构

```typescript
// src/cite/types.ts
export type CiteType = 'file' | 'folder' | 'text' | 'skill' | 'tool' | 'macro' | 'url' | 'message';

export interface CiteItem {
  id: string;
  type: CiteType;
  /** 来源标识：文件路径、Skill 名、消息节点 ID、URL 等 */
  source: string;
  /** 标签上显示的摘要文本 */
  label: string;
  /** 引用的完整内容（text/url/message 类型可选；file/folder 类型不存内容，由后端读取） */
  content?: string;
  /** 行号范围（file/message/symbol 类型） */
  range?: { start: number; end: number };
  /** 消息引用专用：目标节点版本戳（应对节点编辑） */
  targetVersion?: number;
  /** 消息引用专用：目标节点所在分支 ID（应对分支隔离） */
  targetBranchId?: string;
  /** 引用当前状态：正常 / 过期 / 不可见 / 已删除 */
  status?: 'ok' | 'outdated' | 'unreachable' | 'deleted';
  /** 是否被安全策略阻挡 */
  blocked?: boolean;
  blockedReason?: string;
  /** 引用生成时间 */
  createdAt: number;
  /** 来源标注 */
  origin: 'user-select' | 'trigger' | 'drag' | 'paste' | 'imported';
}
```

### 1.2 CiteManager（前后端共用）

```typescript
// src/cite/manager.ts
export class CiteManager {
  private items: CiteItem[] = [];

  add(item: CiteItem): void;
  remove(id: string): void;
  clear(): void;
  list(): readonly CiteItem[];
  /** 生成发送给后端的结构化引用列表 */
  toJSON(): CiteItem[];
  /** 生成 UI 标签数据 */
  formatForUI(): CiteTag[];
}

export interface CiteTag {
  id: string;
  type: CiteType;
  label: string;       // 截断后的显示文本
  fullLabel?: string;  // 完整文本（悬浮显示）
  color: string;       // 标签背景色
  icon: string;        // 标签图标
  status?: 'ok' | 'outdated' | 'unreachable' | 'deleted';
  blocked?: boolean;
  removable: boolean;  // 是否可删除（始终为 true）
}
```

### 1.3 引用类型详解

| 类型 | 触发方式 | 标签样式 | 后端行为 |
|------|---------|---------|---------|
| **file** | 拖拽文件到输入框 / 附件按钮选择 / 右键文件路径 | 📎 蓝色 | `CiteResolver` 调用 `read_file` 读取内容注入上下文 |
| **folder** | 拖拽文件夹 / 附件按钮选择文件夹 | 📁 蓝色 | 列出目录结构，注入文件树摘要 |
| **text** | 右键选中文本 → "引用" / 未选中文本右键消息 → 引用整条 | 💬 紫色 | 原文注入用户消息，标注为"用户引用" |
| **skill** | 输入 `@` → 补全列表 → 选择 | ⚡ 绿色 | 追加 Skill 的 system prompt 到本次请求 |
| **tool** | 输入 `#` → 补全列表 → 选择 | 🔧 橙色 | 本次请求仅允许/优先使用该 Tool |
| **macro** | 输入 `!` → 补全列表 → 选择 | 📋 青色 | 追加 Macro 内容到本次请求的 system prompt |
| **url** | 粘贴 URL 自动识别 / 链接输入框 | 🔗 蓝色 | `CiteResolver` 调用 `web_fetch` 注入网页摘要 |
| **message** | 右键历史消息 → "引用此消息" | 💬 灰色 | 注入被引用消息内容，标注消息索引；解析时校验 `targetVersion` 与 `targetBranchId`，不一致时标记 `outdated`/`unreachable` |

### 1.4 触发器补全

在输入框中输入特定字符时，弹出补全列表（位置通过 mirror div 计算光标像素坐标）：

- `@` → 弹出所有已安装的 Skill 列表（名称 + 描述）
- `#` → 弹出所有已注册的 Tool 列表（名称 + 描述）
- `!` → 弹出所有 Macro 列表（名称 + 描述）

补全列表支持：
- 方向键导航
- 输入过滤（前缀匹配优先）
- Tab/Enter 确认
- Esc 取消
- 确认后删除触发字符，插入引用标签

### 1.5 右键菜单

在消息区域右键时：

- **选中了文字**：菜单项"引用选中文字" / "复制"
- **未选中文字**：菜单项"引用此消息" / "复制"
- **右键文件路径链接**：菜单项"引用此文件" / "打开文件" / "复制路径"

"引用此消息"会生成 `message` 类型引用，其 `source` 为节点 ID，`label` 为消息前 30 字摘要，并记录当前节点版本（见 1.6）。

### 1.6 消息引用的版本与失效处理（受 APIX 消息节点化管理启发）

APIX 支持任意编辑/删除历史消息并自动生成新分支，但 v2.1.1 才修复"编辑后上下文构建错误"的问题。RouteDev 的引用系统必须 preemptively 处理这种节点可变性：

- **节点版本戳：** 每个 `BranchNode` 在创建/编辑后生成单调递增的 `version`（或直接用 `timestamp`）。`message` 引用保存 `targetNodeId + targetVersion`。若 Phase 44 的 `BranchNode` 尚未实现 `version` 字段，本 Phase 需向后兼容：无版本时只比较内容哈希，有版本时优先使用版本。
- **解析时校验：** `CiteResolver` 解析 `message` 引用前，检查目标节点当前版本是否与引用中记录的版本一致。
  - 一致：正常注入该消息内容。
  - 不一致：标签显示 `outdated` 徽章，并提示用户"该消息已被编辑，是否更新引用？"。
- **分支隔离：** 引用中保存的 `branchId` 用于判断目标消息是否在当前分支的可见路径上。若用户切换到目标消息不可见的分支，引用标记为 `unreachable`。
- **删除处理：** 若目标节点被删除（软删除或归档），引用标记为 `deleted`，不再注入上下文，仅在标签上显示"引用已失效"。
- **用户选项：** 对 `outdated` 引用提供"更新到最新版本" / "保持原引用" / "删除引用"三个选项。

### 1.7 标签 UI

引用标签区域位于输入框上方，仿照 SonettoHere 的 `file-refs-bar`：

```
┌─────────────────────────────────────────────┐
│ [📎 src/agent/branch.ts file ×] [💬 "BranchManager..." cite ×]  │
├─────────────────────────────────────────────┤
│ [输入框]                                     │
│ 输入消息…… @技能 · #工具 · !宏                │
└─────────────────────────────────────────────┘
```

- 标签胶囊样式：图标 + 名称 + 类型徽章 + `×` 删除
- 长文本标签截断显示，悬浮显示全文
- 被阻挡文件显示红色 `blocked` 徽章
- 多个标签可换行排列
- 有 `ref-tag-enter` / `ref-tag-leave` / `ref-tag-move` 动画

### 1.7 消息气泡中的引用展示

借鉴 SonettoHere 的 `MessageBubble`，已发送消息的气泡下方显示引用 chips：

```vue
<div v-if="refs?.length" class="ref-chips">
  <ReferenceChip v-for="(r, idx) in refs" :key="idx" :chip="r" />
</div>
```

### 1.8 后端 CiteResolver

这是 RouteDev 超越 SonettoHere 的关键：

```typescript
// src/cite/resolver.ts
export interface CiteResolution {
  /** 注入到 user message 前面的引用摘要 */
  injectedContext: string;
  /** 需要自动调用的工具（如 read_file / web_fetch） */
  preflightTools: Array<{ name: string; args: unknown }>;
  /** 本次请求可用的 Skill 追加提示 */
  skillPrompts: string[];
  /** 本次请求可用的 Macro 追加提示 */
  macroPrompts: string[];
  /** 本次请求允许使用的工具白名单（Tool 引用） */
  allowedTools?: string[];
  /** 被阻挡的引用列表 */
  blocked: CiteItem[];
}

export class CiteResolver {
  async resolve(options: {
    items: CiteItem[];
    /** 是否自动执行 preflight 工具 */
    autoRunPreflight: boolean;
    sessionContext: SessionContext;
  }): Promise<CiteResolution>;
}
```

解析流程：
1. 检查每个引用是否被安全策略阻挡（敏感文件、目录边界）。
2. 对 message 引用：校验 `targetVersion` 与 `targetBranchId`；不一致的标记 `outdated`/`unreachable`，一致的读取节点内容。
3. 对 file/folder 引用：生成 `read_file` / `list_directory` 的 preflight 工具调用。
4. 对 url 引用：生成 `web_fetch` 的 preflight 工具调用。
5. 对 skill/macro 引用：读取对应 SKILL.md / MACRO.md，提取 system prompt；macro 若含 `preferredProfile`，追加到 `macroPrompts` 并通知上下文切换。
6. 对 text 引用：收集原文。
7. 对 tool 引用：生成 allowedTools 白名单。
8. 组装 `injectedContext`：

```markdown
[用户输入的正文]

---
引用上下文:
📎 文件 [src/agent/branch.ts] 内容摘要:
<read_file 结果>

💬 用户引用的文本:
"BranchManager 已经具备消息节点树..."

⚡ 技能 [code-reviewer] 已激活

🔗 链接 [example.com] 摘要:
<web_fetch 结果>
```

### 1.9 文件引用行为

- **不展开文件内容到输入框**：用户引用文件后，输入框只显示标签
- **后端自动读取**：`CiteResolver` 调用 `read_file` 读取内容，注入上下文
- **产物标注**：引用的文件会标注类型（代码/配置/文档），帮助模型判断
- **大文件截断**：超过 `cite.maxPreflightTokens` 时，只读取前 N token 并提示

### 1.10 文本引用长度处理

- **默认上限 2000 字符**：可配置 `cite.maxTextCiteLength`
- 超过上限时提示用户："引用文本较长，是否只保留前 2000 字符？"
- 输入框标签截断显示，悬浮显示全文
- 发送时按上限注入上下文

### 1.12 引用持久化与清空

- 已发送消息的引用保存在该消息对象中
- 切换分支/会话时，历史消息的引用仍然可见
- 当前输入框的引用：
  - 发送成功后清空
  - 切换分支时清空
  - 不绑定到消息节点树

### 1.12 安全阻挡状态

借鉴 SonettoHere 的 `blocked` 字段：
- 引用文件后异步检查路径是否被敏感文件策略阻挡
- 被阻挡的标签显示红色 `blocked` 徽章
- 发送前检查：如有被阻挡引用，提示用户并阻止发送

### 1.14 测试要求

- 右键选中文本后"引用选中文字"正确创建标签。
- 右键未选中文字"引用此消息"正确引用整条消息。
- 右键文件路径链接"引用此文件"正确创建文件标签。
- `@` 触发 Skill 补全列表，选择后创建 Skill 标签。
- `#` 触发 Tool 补全列表，选择后创建 Tool 标签。
- `!` 触发 Macro 补全列表，选择后创建 Macro 标签。
- 粘贴 URL 自动创建链接引用标签（含协议和无协议域名）。
- 拖拽文件到输入框创建文件引用标签。
- 选择文件夹创建文件夹引用标签。
- 标签 `×` 按钮正确删除引用。
- 长文本标签截断显示，悬浮显示全文。
- 多个标签混合排列正确。
- `CiteResolver` 正确解析 file 引用并生成 `read_file` preflight。
- `CiteResolver` 正确解析 skill 引用并提取 Skill system prompt。
- `CiteResolver` 对敏感文件引用标记 blocked 并阻止发送。
- 已发送消息的引用显示在消息气泡下方。
- 引用的消息被编辑后，`message` 引用显示 `outdated` 徽章并提示更新。
- 引用的消息所在分支不可见时，`message` 引用显示 `unreachable` 徽章。
- 引用的消息被删除后，`message` 引用显示 `deleted` 徽章且不注入上下文。

---

## Task 2：Anthropic Skills 与 Claude Code 生态兼容（≥ 6 测试）

### 2.1 兼容范围调整

SonettoHere 本身并没有"Plugin 导入"机制，它只是直接兼容 Anthropic 的 `anthropic_skills/<name>/SKILL.md` 目录结构。RouteDev 的实际可落地路径是：

1. **直接兼容 `anthropic_skills/` 目录**：用户把 Claude Code / SonettoHere 的 skills 放到项目 `anthropic_skills/` 下，RouteDev 自动扫描加载。
2. **Claude Code Plugin 超集导入**：支持带 `plugin.json` + `agents/` + `.mcp.json` 的 Claude Code Plugin 包，转换为 RouteDev 的 Skill/Agent Profile/MCP/Hook。

### 2.2 Anthropic Skills 目录兼容

用户项目下新增 `anthropic_skills/` 目录：

```
anthropic_skills/
├── unit-test/
│   └── SKILL.md
├── syntax-check/
│   └── SKILL.md
└── debug/
    └── SKILL.md
```

RouteDev 启动时扫描 `anthropic_skills/**/*.SKILL.md`，与 `.routedev/skills/` 下的 Skill 合并加载，但来源标注为"来自 Anthropic Skills"。

### 2.3 Claude Code Plugin 结构

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json          # 元数据
├── .mcp.json                # MCP server 配置（可选）
├── commands/                # 遗留 slash command（*.md，可选）
├── skills/                  # SKILL.md 文件（可选）
├── agents/                  # Agent 定义（可选）
└── README.md
```

### 2.4 映射到 RouteDev

| Claude Code 组件 | RouteDev 对应物 | 转换说明 |
|------------------|----------------|---------|
| `plugin.json` | Skill 包元数据 | name/description/author 直接映射 |
| `skills/*/SKILL.md` | RouteDev Skill | frontmatter + body 直接复用 |
| `commands/*.md` | RouteDev slash command | legacy 格式，转换为 Skill |
| `.mcp.json` | RouteDev MCP server 配置 | 字段映射见 Task 4 |
| `agents/` | RouteDev Agent Profile | 映射 role/model/tools |
| hooks（plugin.json 中声明） | RouteDev Hook | 进入沙箱试用 |

### 2.5 工具名映射（仅 legacy commands）

Claude Code 的遗留命令工具名（如 `Read`、`Glob`、`Grep`、`Write`、`Edit`）需映射到 RouteDev 对应工具：

```typescript
// src/import/tool-name-mapper.ts
const TOOL_NAME_MAP: Record<string, string> = {
  'Read': 'read_file',
  'Glob': 'list_directory',
  'Grep': 'search_code',
  'Write': 'file_write',
  'Edit': 'file_edit',
  'Bash': 'execute_command',
  'WebFetch': 'web_fetch',
  'WebSearch': 'web_search',
};
```

无法映射的工具在导入时给出警告并禁用该 Skill/Command。

### 2.6 导入命令

```
/plugin import-from-claude <path-or-git-url>
```

流程：
1. 下载/定位 Claude Code Plugin
2. 解析 `plugin.json`
3. 分类转换：Skill / Command / MCP / Agent / Hook
4. 工具名翻译
5. 安全扫描（Hook/MCP 标记为待审查）
6. 来源判断：
   - 官方市场（`anthropics/claude-plugins-official`）→ 自动启用
   - 社区来源 → 默认进入沙箱试用模式
7. 生成 RouteDev 兼容包到 `.routedev/imported/claude/<plugin-name>/`
8. 在 Skill/Hook/MCP/Agent 市场中显示为"来自 Claude Code"

### 2.7 版本更新策略

- 启动时检查来源仓库是否有新版本
- **patch 版本**（如 1.0.1 → 1.0.2）：自动更新
- **minor 版本**（如 1.0.x → 1.1.0）：提示用户确认
- **major 版本**（如 1.x → 2.0.0）：必须手动确认

### 2.8 测试要求

- 项目 `anthropic_skills/` 目录下的 SKILL.md 被自动扫描加载。
- 本地 Claude Code Plugin 目录能正确导入。
- `skills/*/SKILL.md` 转换为 RouteDev Skill。
- `commands/*.md` 转换为 RouteDev slash command。
- `.mcp.json` 转换为 RouteDev MCP server 配置。
- 社区来源的 Hook 默认进入沙箱试用模式。

---

## Task 3：Codex Instructions 导入（≥ 6 测试）

### 3.1 Codex 项目级配置

Codex CLI 支持项目级 `.codex/` 目录：
- `.codex/instructions.md` — 项目级 system instructions
- `.codex/codex.md` — 项目文档（部分版本）

### 3.2 导入策略

```typescript
// src/import/codex-importer.ts
export class CodexInstructionImporter {
  async scan(projectRoot: string): Promise<{
    found: boolean;
    files: string[];
    content: string;
  }>;

  async import(options: {
    projectRoot: string;
    mode: 'system_prompt' | 'project_memory' | 'ignore';
  }): Promise<void>;
}
```

### 3.3 与 RouteDev 的集成

- `system_prompt` 模式：将 `.codex/instructions.md` 追加到 `PromptManager` 的项目级 system prompt
- `project_memory` 模式：将内容按段落写入项目记忆，打标签 `codex-instruction`
- `ignore` 模式：记录用户选择，不再提示（除非文件更新）

### 3.4 检测时机

- 项目初始化时扫描 `.codex/` 目录
- 检测到时在设置页面提示："发现 Codex 项目配置，是否导入？"
- 用户选择后记录到 `.routedev/config.yaml` 的 `import.codexInstructions`

### 3.5 测试要求

- 检测到 `.codex/instructions.md` 时提示用户导入。
- 导入为 system prompt 后，后续 LLM 调用包含该内容。
- 导入为项目记忆后，内容按主题分段存储。
- 用户选择"忽略"后不再提示（除非文件更新）。
- 多个 `.codex/*.md` 文件按字母顺序合并。
- 导入失败时给出明确错误。

---

## Task 4：MCP 生态桥接（≥ 8 测试）

### 4.1 MCP 传输协议覆盖

Claude Code 的 `.mcp.json` 只定义了两种基础类型：

```json
{
  "server-name": {
    "type": "http",
    "url": "https://mcp.example.com/api"
  },
  "local-server": {
    "type": "stdio",
    "command": "node",
    "args": ["server.js"]
  }
}
```

但 APIX 与 SonettoHere 都已验证 MCP 2025-03-26 规范中的更多传输方式。RouteDev 的 MCP 桥接应直接覆盖以下协议，避免导入后能力降级：

| 传输协议 | 来源/依据 | RouteDev transport |
|---------|----------|-------------------|
| stdio | Claude Code / SonettoHere | `stdio` |
| HTTP(SSE) | Claude Code / SonettoHere | `http` / `sse` |
| Streamable HTTP | MCP 2025-03-26 / SonettoHere | `streamable_http` |
| WebSocket | SonettoHere | `websocket` |

### 4.2 桥接到 RouteDev MCPConfig

```typescript
// src/mcp/claude-bridge.ts
export class ClaudeMCPBridge {
  async importFromClaudeConfig(path: string): Promise<MCPServerEntryConfig[]>;
  async exportToClaudeConfig(servers: MCPServerEntryConfig[]): Promise<string>;
}
```

字段映射：

| Claude Code `.mcp.json` | RouteDev MCPConfig |
|------------------------|-------------------|
| `type: "http"` | `transport: "http"` + `url` |
| `type: "stdio"` | `transport: "stdio"` + `command` + `args` |
| `headers` | `headers` |
| `env` | `env` |
| `timeout` | `timeout` |
| `cwd` | `cwd` |

对 `streamable_http` / `websocket` / `sse` 类型，若来源配置不是 Claude Code 格式而是标准 MCP JSON（如 SonettoHere 的 `mcp_servers.yaml`），则通过统一的 `MCPTransportConfig` 解析器转换，不再单独写 bridge。

### 4.3 会话生命周期管理（受 APIX 启发）

APIX 强调"可自定义会话生命周期"。RouteDev 的 MCP 客户端当前可能是长连接或每次调用新建会话，桥接导入后必须让用户能选择生命周期策略，避免不同来源的 server 行为不一致：

- **per-call：** 每次工具调用新建会话（与 SonettoHere `tools/mcp.py` 注释一致，适合无状态 server）。
- **per-session：** 整个 RouteDev 会话期间保持连接（适合需要上下文的 server）。
- **persistent：** 应用级持久连接，可手动重连/断开（适合高频调用）。

导入时：
- Claude Code `.mcp.json` 未声明生命周期 → 默认 `per-session`。
- SonettoHere YAML 若声明 `persistent: true` → 映射为 `persistent`。
- 用户在 Settings > MCP 中可修改每个 server 的生命周期策略。

### 4.4 自动发现

在 `Settings > MCP` 页面新增按钮：
- "从 Claude Code 导入 MCP servers"：扫描 `~/.claude/.mcp.json` 或项目级 `.mcp.json`
- "从 SonettoHere 导入 MCP servers"：扫描 `config/mcp_servers.yaml`
- "导出到 Claude Code"：把 RouteDev 的 MCP 配置写回 `.mcp.json`

### 4.5 ID 冲突处理

Claude Code 和 RouteDev 的 MCP server 命名空间不同，导入时：
- 重新生成唯一 ID（如 `claude-<original-id>`）
- 若 ID 已存在，追加 `-2`、`-3` 后缀
- 在 UI 中标注"来自 Claude Code"

### 4.6 测试要求

- HTTP MCP server 配置正确导入。
- stdio MCP server 配置正确导入。
- SSE MCP server 配置正确导入。
- Streamable HTTP MCP server 配置正确导入。
- WebSocket MCP server 配置正确导入。
- 导入时检测重复 ID 并自动生成新 ID。
- 导出到 `.mcp.json` 格式正确。
- 自动发现能扫描默认 Claude Code 配置路径。
- 桥接失败的 server 不影响其他 server 导入。
- 会话生命周期策略在导入后保持可配置。

---

## Task 5：Macros 系统（≥ 8 测试）

### 5.1 Macro 定义

借鉴 SonettoHere 的设计，Macro 是比 Skill 更轻量的流程指引：

```markdown
<!-- .routedev/macros/review-pr/MACRO.md -->
---
name: review-pr
type: macro
version: 1.0.0
author: user
keywords: [review, pr, code]
description: 审查 PR 的标准流程
category: code-quality
---

## 适用场景
当你需要审查一个 Pull Request 时使用此宏。

## 工作流程
1. 读取 PR 的 diff
2. 检查代码风格
3. 检查测试覆盖
4. 检查安全风险
5. 输出审查报告

## 输出格式
- 结论：approval / conditional / rejected
- 问题列表
- 建议
```

### 5.2 Macro 与 Skill 的关系

- Macro 是 Skill 的轻量子集
- Macro 不含脚本或外部依赖，纯 Markdown
- Macro 通过 `!` 触发器引用
- 任何 Skill 都可以作为 Macro，但 Macro 不能替代 Skill 的全部能力
- Macro 适合固化个人工作流（如"每天早上检查邮件"）

### 5.3 Macro 与 Agent Profile/角色卡的联动（受 APIX 角色卡启发）

APIX 的角色卡允许自定义助手身份和行为。RouteDev 的 Agent Profile（Phase 43）已经是更工程化的角色定义，Macro 引用时应能继承当前 Profile 的上下文：

- **绑定 Profile：** Macro 的 YAML frontmatter 支持可选字段 `preferredProfile`，引用该 Macro 时自动切换到对应 Agent Profile（若用户未锁定当前 Profile）。
- **追加角色约束：** 若 Macro 未指定 Profile，则把当前激活 Profile 的 `systemPrompt` 片段追加到 `macroPrompts`，让宏执行时保持角色一致性。
- **冲突处理：** 若多个引用的 Macro 要求不同 Profile，按最后引用的为准，并在 UI 提示"多个宏要求不同角色，已使用最后一个"。

### 5.4 Macro 生成

用户可以说"把这个流程写成宏"，AI 引用内置的 `macro-creator`（meta-macro）引导用户完成创建：

1. 在 `macros/` 下创建子目录 `macros/<macro-name>/`
2. 生成 `MACRO.md`，包含 YAML frontmatter + 正文
3. 保存后即可在输入框中用 `!<宏名称>` 触发

### 5.5 内置 Macro

- `macro-creator`：关于宏的宏，引导用户创建新宏
- `daily-standup`：每日站会汇报模板
- `code-review`：代码审查标准流程
- `commit-message`：生成规范提交信息

### 5.6 测试要求

- `!` 触发 Macro 补全列表。
- 选择 Macro 后创建引用标签。
- Macro 文件正确解析 YAML frontmatter。
- 用户通过 `macro-creator` 创建新宏。
- 内置 Macro 可正确加载。
- Macro 目录不存在时自动创建。
- Macro 版本升级后提示更新。
- 无效的 Macro 文件给出错误提示。
- 引用带 `preferredProfile` 的 Macro 时，当前请求切换到对应 Profile。

---

## Task 6：集成测试与文档同步（≥ 5 测试）

### 6.1 端到端测试

1. **引用 + Anthropic Skill 联动端到端：** 用户 `@unit-test` 引用 Skill → 发送"帮我测试这个文件" + file 引用 → `CiteResolver` 读取文件并注入 Skill 的 system prompt → AI 按 Skill 流程执行单元测试。
2. **Codex Instructions + Macro 联动端到端：** 项目存在 `.codex/instructions.md` → 导入为项目记忆 → 用户用 `!daily-standup` 引用宏 → 宏执行时包含 Codex instructions 的约束。
3. **MCP 桥接 + 工具引用联动端到端：** 从 Claude Code 导入 MCP server → 用户用 `#<serverId_toolName>` 引用 MCP 工具 → 该工具在本次请求中可用。
4. **引用持久化端到端：** 用户发送一条带 file + text 引用的消息 → 切换分支 → 切回原分支 → 消息气泡下方仍显示引用 chips。
5. **消息引用版本失效端到端：** 用户发送消息 A → 用户发送消息 B 并引用消息 A → 编辑消息 A → 消息 B 的 `message` 引用显示 `outdated` → 用户选择"更新到最新版本" → 后续追问基于消息 A 的最新内容。

### 6.2 文档同步

- **CITE.md：** 引用系统架构、八种引用类型、触发器、右键菜单、标签 UI、后端 `CiteResolver`、消息引用版本与失效处理、与 SonettoHere/APIX 的差异。
- **IMPORT.md：** 外部生态导入指南（anthropic_skills、Claude Code Plugin、Codex Instructions、MCP 桥接、多协议与会话生命周期）。
- **MACROS.md：** Macro 系统说明、创建流程、内置宏列表、与 Agent Profile 的联动。
- **CHANGELOG.md：** v3.9.0 条目。
- **config schema：** 新增 `cite.enabled`、`cite.maxTags`、`cite.maxTextCiteLength`、`cite.maxPreflightTokens`、`cite.autoRunPreflight`、`import.anthropicSkillsAutoEnable`、`import.claudePluginAutoEnable`、`import.codexInstructions`、`macros.enabled`、`macros.dir`、`mcp.lifecyclePolicy`。

---

## 新增陷阱警告

**125. 引用沦为复制粘贴：** 如果后端不解析引用，只把引用 JSON 拼在消息末尾，引用就只剩 UI 装饰。必须确保 `CiteResolver` 把 file/skill/url 等引用真正转化为上下文或工具调用。

**126. 引用标签过多导致输入框被挤压：** 标签区域必须有最大高度限制（如 3 行），超过时折叠为"已引用 N 项，点击展开"。

**127. 引用内容过长导致上下文膨胀：** 文本引用设置默认上限（2000 字符），文件 preflight 设置 token 上限，超过时提示用户而非静默截断。

**128. 引用持久化导致 localStorage/消息历史膨胀：** 历史消息携带完整引用对象，长期对话会占用大量存储。引用内容只保存元数据（path/name/url），大文本引用保存摘要或哈希引用。

**129. 导入的 Claude Code Plugin 可能包含危险 Hook：** 社区来源的 Hook 必须进入沙箱试用模式，敏感事件（git push、文件删除）即使在试用期也需确认。

**130. Codex Instructions 可能与 RouteDev 项目记忆冲突：** 导入时必须提示用户选择"追加"、"替换"或"忽略"，不能默默覆盖已有记忆。

**131. MCP server ID 冲突：** 导入时必须重新生成唯一 ID，避免覆盖已有配置。

**132. 工具名映射不完整导致 Skill 不可用：** Claude Code 的遗留命令工具名可能无法全部映射到 RouteDev，未映射的工具必须禁用并提示，不能静默失败。

**133. Macro 文件可能包含恶意指令：** Macro 虽然是纯 Markdown，但可能包含误导模型的指令。社区导入的 Macro 需经过安全审查。

**134. `@`/`#`/`!` 触发器与用户输入冲突：** 用户可能正常输入 `@` 符号（如邮箱），需要判断 `@` 后是否紧跟字母且在补全列表中匹配，避免误触发。

**135. `CiteResolver` 自动读取文件可能绕过权限：** preflight 工具调用必须经过 `PermissionEngine`，不能因为"是引用触发的"就跳过审批。

**136. 消息引用与节点编辑不一致（APIX v2.1.1 已踩坑）：** 若引用只保存节点 ID 而不保存版本戳，目标消息被编辑后引用会指向错误内容。必须给 `BranchNode` 加版本字段，并让 `message` 引用携带 `targetVersion`。

**137. MCP 多协议导入后能力降级：** 若 RouteDev 自身只支持 stdio/http，却把 SonettoHere/APIX 的 SSE/WebSocket/Streamable HTTP server 导入为 http，会导致连接失败。导入前必须校验 transport 是否被当前运行时支持，不支持的 transport 要明确提示并禁用。

**138. Macro 与 Profile 联动导致角色漂移：** 多个 Macro 要求不同 `preferredProfile` 时，若静默切换可能让用户困惑。必须在 UI 明确提示当前因 Macro 引用切换到的 Profile，并允许用户一键锁定。

---

## 思考引导总结

1. **引用系统先做 GUI 还是 CLI？** 先做 GUI。CLI 后续用键盘选择 + `/cite` 命令补充。两者共用 `CiteManager` 和 `CiteResolver`。

2. **引用标签放在输入框上方还是内联？** 上方。标签是独立区域，不混入正文，视觉清晰。

3. **文件引用要不要自动读取内容？** 要。由后端 `CiteResolver` 调用 `read_file` 读取并注入上下文，而不是让模型自己从文本里识别。

4. **Claude Code Plugin 导入后放哪里？** 放在 `.routedev/imported/claude/<plugin-name>/`，作为只读源；启用后复制到 Skill/Hook/MCP/Agent 各自目录。

5. **Codex Instructions 是 system prompt 还是项目记忆？** 两种都支持，默认推荐项目记忆，避免 system prompt 过长。

6. **Macro 和 Skill 什么关系？** Macro 是 Skill 的轻量子集，纯 Markdown，通过 `!` 触发。适合固化个人工作流。

7. **外部 Agent 调用桥接（把 Codex CLI 作为子 Agent）做不做？** 本 Phase 不做。它是实验性能力，且 RouteDev 已有完整的子 Agent 体系（Phase 43）。

8. **与 Phase 43/44/47 的边界：** Phase 43 建立 Agent Profile、Hook 沙箱；Phase 44 建立消息节点树；Phase 47 建立自定义命令和权限双旋钮；Phase 48 在此基础上做引用系统和外部生态兼容。不修改前序 Phase 文档。

9. **执行顺序建议：** Task 1（引用系统前端 + 后端解析器）→ Task 5（Macros，可被 `@`/`!` 引用）→ Task 4（MCP 桥接）→ Task 2（Anthropic Skills / Claude Code Plugin 导入）→ Task 3（Codex Instructions 导入）→ Task 6（集成测试）。引用系统是用户体验的核心，优先落地。

10. **与 SonettoHere 的核心差异：** 我们不只学它的标签 UI，更要补齐它的后端短板——让引用真正被解析、被执行、被约束。

11. **从 APIX 学到什么？** APIX 证明消息节点可编辑+自动分支是用户预期行为，但也暴露了"编辑后引用/上下文不一致"的修复成本。RouteDev 的 `message` 引用必须 preemptively 保存版本戳，避免重蹈 v2.1.1 的覆辙。

12. **MCP 桥接的边界：** 桥接不只是字段映射，还要对齐传输协议与会话生命周期。只导入 Claude Code 的 http/stdio 会导致从 SonettoHere/APIX 迁移来的用户失望，必须覆盖 SSE/WebSocket/Streamable HTTP。
