# RouteDev 引用系统（Cite System）

> 引用系统让用户在输入框中以标签形式精准引用文件、文件夹、文本、Skill、Tool、Macro、URL、历史消息 8 类对象；前端展示糖衣，后端 `CiteResolver` 真正把引用解析为 preflight 工具调用、上下文注入与工具白名单。

## 目录

- [设计原则](#设计原则)
- [8 种引用类型](#8-种引用类型)
- [触发器补全](#触发器补全)
- [右键菜单](#右键菜单)
- [消息引用的版本与失效处理](#消息引用的版本与失效处理)
- [标签 UI](#标签-ui)
- [后端 CiteResolver 解析流程](#后端-citeresolver-解析流程)
- [配置项](#配置项)
- [与 SonettoHere / APIX 的差异](#与-sonettohere--apix-的差异)
- [陷阱引用](#陷阱引用)

---

## 设计原则

引用系统借鉴 SonettoHere 的前端交互与 APIX 的消息节点可变性思路，但在后端实现上走得更远：引用不只是 UI 装饰，而是被结构化解析为可执行的上下文与工具调用。

1. **前端糖衣 + 后端引擎**：前端以胶囊标签呈现引用，后端 `CiteResolver` 把 file/folder 引用转化为 `read_file` / `list_directory` preflight 调用，把 skill/macro 引用转化为追加 system prompt，把 url 引用转化为 `web_fetch` 调用，把 tool 引用转化为工具白名单，把 message 引用转化为带版本校验的上下文注入。
2. **引用标签是视觉独立的"框"**：标签区域位于输入框上方，与正文不混排；图标 + 名称 + 类型徽章 + `×` 删除按钮；被阻挡的引用显示红色 `blocked` 徽章。
3. **引用随消息持久化，但不绑定到节点树**：每条已发送的用户消息携带 `refs: CiteItem[]`，切换分支/会话时仍可见；当前输入框的引用是临时的，发送或切换分支后清空，不成为消息节点树的一部分。

---

## 8 种引用类型

`CiteType` 联合类型枚举了所有引用种类，每种类型对应不同的触发方式、标签样式与后端行为。

```typescript
export type CiteType = 'file' | 'folder' | 'text' | 'skill' | 'tool' | 'macro' | 'url' | 'message';
```

| 类型 | 触发方式 | 标签样式 | 后端行为 |
|------|---------|---------|---------|
| **file** | 拖拽文件到输入框 / 附件按钮选择 / 右键文件路径链接 | 📎 蓝色 | `CiteResolver` 生成 `read_file` preflight，自动读取内容注入上下文（支持 `range` 行号范围） |
| **folder** | 拖拽文件夹 / 附件按钮选择文件夹 | 📁 蓝色 | 生成 `list_directory` preflight，注入文件树摘要 |
| **text** | 右键选中文本 → "引用选中文字" / 未选中时右键消息 → 引用整条 | 💬 紫色 | 原文截断到 `cite.maxTextCiteLength` 后，作为 `[用户引用的原文]` 注入用户消息 |
| **skill** | 输入 `@` → 补全列表 → 选择 | ⚡ 绿色 | 读取 `SKILL.md`，将正文追加到 `skillPrompts`，本次请求激活该 Skill |
| **tool** | 输入 `#` → 补全列表 → 选择 | 🔧 橙色 | 把工具名加入 `allowedTools` 白名单，本次请求仅允许/优先使用该 Tool |
| **macro** | 输入 `!` → 补全列表 → 选择 | 📋 青色 | 读取 `MACRO.md`，将正文追加到 `macroPrompts`；若宏声明 `preferredProfile` 则联动切换 Profile |
| **url** | 粘贴 URL 自动识别 / 链接输入框 | 🔗 蓝色 | 生成 `web_fetch` preflight，抓取网页摘要后注入上下文 |
| **message** | 右键历史消息 → "引用此消息" | 💬 灰色 | 校验 `targetVersion` / `targetBranchId`，一致时注入消息内容；不一致时标记 `outdated` / `unreachable` / `deleted` |

标签样式由 `TAG_STYLES` 静态映射表统一分配，可通过 `getTagStyle(type)` 查询。

---

## 触发器补全

输入框中输入特定字符触发补全列表，光标像素位置通过 mirror div 计算：

- `@` → 弹出所有已安装的 Skill（名称 + 描述）
- `#` → 弹出所有已注册的 Tool（名称 + 描述）
- `!` → 弹出所有 Macro（名称 + 描述）

补全列表交互：

- 方向键导航
- 前缀过滤（name 前缀匹配优先，其次 keywords、description）
- Tab / Enter 确认
- Esc 取消
- 确认后删除触发字符并插入引用标签

> **陷阱 #134：** `@` / `#` / `!` 可能与用户正常输入冲突（如邮箱地址）。需要判断触发字符后是否紧跟字母且在补全列表中匹配到候选，避免误触发。

---

## 右键菜单

消息区域右键时按上下文提供菜单项：

- **选中了文字**：「引用选中文字」/「复制」→ 生成 `text` 引用
- **未选中文字**：「引用此消息」/「复制」→ 生成 `message` 引用（`source` 为节点 ID，`label` 为消息前 30 字摘要，记录当前节点版本）
- **右键文件路径链接**：「引用此文件」/「打开文件」/「复制路径」→ 生成 `file` 引用

---

## 消息引用的版本与失效处理

RouteDev 的消息节点树支持编辑、删除、分支隔离，因此 `message` 引用必须 preemptively 处理目标可变性（APIX v2.1.1 曾因未处理该问题导致上下文构建错误）。

`CiteItem` 上携带两个版本字段：

```typescript
/** 消息引用专用：目标节点版本戳（应对节点编辑） */
targetVersion?: number;
/** 消息引用专用：目标节点所在分支 ID（应对分支隔离） */
targetBranchId?: string;
/** 引用当前状态：正常 / 过期 / 不可见 / 已删除 */
status?: 'ok' | 'outdated' | 'unreachable' | 'deleted';
```

解析时 `CiteResolver` 通过依赖注入的 `messageNodeProvider(nodeId)` 获取目标节点当前信息（`MessageNodeInfo`），按下列优先级判定状态：

| 校验顺序 | 条件 | 结果状态 | 行为 |
|---------|------|---------|------|
| 1 | 节点不存在或 `node.deleted === true` | `deleted` | 标签显示「引用已失效」，不再注入上下文 |
| 2 | `item.targetBranchId !== sessionContext.currentBranchId` | `unreachable` | 标签显示「分支不可见」，提示切换到目标分支 |
| 3 | `item.targetVersion !== node.version` | `outdated` | 标签显示「已过期」，提示用户选择「更新到最新版本」/「保持原引用」/「删除引用」 |
| 4 | 上述全部通过 | `ok` | 正常注入消息内容（按 `maxTextCiteLength` 截断） |

状态徽章文本由 `getStatusBadge(status)` 返回：`已过期` / `分支不可见` / `已删除`。

---

## 标签 UI

引用标签区域位于输入框上方，借鉴 SonettoHere 的 `file-refs-bar` 布局：

```
┌─────────────────────────────────────────────┐
│ [📎 src/agent/branch.ts file ×] [💬 "BranchManager..." cite ×]  │
├─────────────────────────────────────────────┤
│ [输入框]                                     │
│ 输入消息…… @技能 · #工具 · !宏                │
└─────────────────────────────────────────────┘
```

`CiteManager.formatForUI()` 返回的 `CiteTag` 包含 UI 渲染所需的全部字段：

```typescript
export interface CiteTag {
  id: string;          // 对应 CiteItem.id
  type: CiteType;
  label: string;       // 截断后的显示文本（默认 30 字符）
  fullLabel?: string;  // 完整文本（悬浮显示，未截断时为 undefined）
  color: string;       // 标签背景色
  icon: string;        // 标签图标
  status?: CiteStatus; // message 引用的过期/不可见/已删除徽章
  blocked?: boolean;   // 红色 blocked 徽章
  removable: boolean;  // 始终为 true，预留扩展
}
```

UI 行为细则：

- 标签胶囊：图标 + 名称 + 类型徽章 + `×` 删除
- 长文本截断显示，悬浮显示 `fullLabel` 全文
- 被安全策略阻挡的标签显示红色 `blocked` 徽章
- 多标签换行排列，支持 `ref-tag-enter` / `ref-tag-leave` / `ref-tag-move` 动画
- 已发送消息的引用以 chips 形式展示在消息气泡下方

---

## 后端 CiteResolver 解析流程

`CiteResolver` 是 RouteDev 超越 SonettoHere 的关键组件：它把引用列表结构化解析为 `CiteResolution`，调用方按需自动执行 preflight、注入上下文、追加 prompts、约束工具白名单。

```typescript
export interface CiteResolution {
  injectedContext: string;          // 注入到 user message 前的引用摘要（Markdown）
  preflightTools: PreflightToolCall[]; // 需自动调用的工具（read_file / list_directory / web_fetch）
  skillPrompts: string[];           // 追加到本次 system prompt 的 Skill 提示
  macroPrompts: string[];           // 追加到本次 system prompt 的 Macro 提示
  allowedTools?: string[];          // 工具白名单（仅 Tool 引用触发时存在）
  blocked: CiteItem[];              // 被安全策略阻挡的引用列表
}
```

`CiteResolver.resolve({ items, autoRunPreflight, sessionContext })` 内部按以下 8 步流程处理：

1. **敏感文件检查**：对 `file` / `folder` 引用做 glob 模式匹配（`DEFAULT_SENSITIVE_PATTERNS` 或 `sessionContext.sensitivePatterns`），命中时标记 `blocked` 并跳过后续步骤。
2. **按类型分发**：遍历每个 `CiteItem`，根据 `type` 分发到对应处理器（`resolveFileCite` / `resolveFolderCite` / `resolveTextCite` / `resolveSkillCite` / `resolveMacroCite` / `resolveUrlCite` / `resolveToolCite` / `resolveMessageCite`）。
3. **file / folder**：生成 `read_file` / `list_directory` preflight 调用，参数含 `path` 与可选 `startLine` / `endLine`；同时生成上下文摘要片段。
4. **url**：生成 `web_fetch` preflight 调用，参数为 `{ url: item.source }`。
5. **skill / macro**：通过 `deps.readSkillOrMacro(name, kind)` 读取 `SKILL.md` / `MACRO.md`，用 `SkillMdParser` 解析，把正文加入 `skillPrompts` / `macroPrompts`；读取失败时记 warn 不中断。
6. **text**：从 `item.content` 或 `item.label` 取原文，按 `maxTextCiteLength` 截断，作为「用户引用的文本」片段加入 `injectedContext`。
7. **tool**：把 `item.source` 加入 `allowedTools` 集合，标记 `hasToolCite`，最终在 `CiteResolution.allowedTools` 中输出。
8. **message**：通过 `deps.messageNodeProvider(nodeId)` 查询节点信息，按上文「版本与失效处理」表格的 4 级优先级判定 `deleted` / `unreachable` / `outdated` / `ok`，正常时注入节点内容（按 `maxTextCiteLength` 截断）。

最后用 `assembleInjectedContext(chunks)` 把所有上下文片段拼接为：

```markdown
---
引用上下文:
📎 文件 [src/agent/branch.ts]
   <将自动调用 read_file 读取内容>

💬 用户引用的文本:
"BranchManager 已经具备消息节点树..."

⚡ 技能 [code-reviewer] 已激活
   来源：code-reviewer
   预览：...

🔗 链接 [example.com]
   <将自动调用 web_fetch 抓取网页摘要>
```

`CiteResolver` 通过 `CiteResolverDeps` 注入外部依赖（`readSkillOrMacro` / `messageNodeProvider`），便于单元测试与跨环境运行。

---

## 配置项

引用系统配置位于 `config.cite` 字段，由 `CiteConfigSchema` 定义（见 `src/config/schema.ts`）。

```typescript
export interface CiteConfig {
  enabled: boolean;             // 是否启用引用系统，默认 true
  maxTags: number;              // 单次最多引用标签数（1-20，默认 10）
  maxTextCiteLength: number;    // text 引用最大字符数（100-10000，默认 2000）
  maxPreflightTokens: number;   // preflight 结果 token 上限（1000-50000，默认 8000）
  autoRunPreflight: boolean;    // 是否自动执行 preflight 工具，默认 true
}
```

| 字段 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `cite.enabled` | `true` | boolean | 关闭后输入框不显示引用区域，`@` / `#` / `!` 不触发补全 |
| `cite.maxTags` | `10` | 1-20 | 单次引用上限，超限时 `CiteManager.add` 抛 `CiteLimitExceededError` |
| `cite.maxTextCiteLength` | `2000` | 100-10000 | text 与 message 引用注入上下文时的字符截断阈值 |
| `cite.maxPreflightTokens` | `8000` | 1000-50000 | preflight 工具调用结果的 token 上限，超过时只读取前 N token 并提示 |
| `cite.autoRunPreflight` | `true` | boolean | 关闭时仅生成 preflight 调用描述，由用户确认后执行 |

`CiteManager` 构造函数接收 `maxTags` 参数；`CiteResolver` 构造函数接收 `Partial<CiteConfig>` 与 `CiteResolverDeps`，缺省值由 `DEFAULT_CITE_CONFIG` 提供。

---

## 与 SonettoHere / APIX 的差异

RouteDev 的引用系统不是 SonettoHere 的复刻，而是补齐其后端短板并整合 APIX 的节点可变性设计。

| 维度 | SonettoHere | APIX | RouteDev |
|------|-------------|------|----------|
| 引用序列化 | `__refs__{json}__/refs__` 块拼在消息末尾 | 无独立引用系统 | `CiteItem[]` 结构化字段，前后端共用类型 |
| 后端解析 | 无，AI 是否理解引用取决于 system prompt 训练 | 无 | `CiteResolver` 真正解析为 preflight 工具调用 + 上下文注入 + 工具白名单 |
| 文件引用 | 前端读文件内容拼到消息 | 无 | 后端 `read_file` preflight，按 `maxPreflightTokens` 截断 |
| URL 引用 | 前端拼字符串 | 无 | 后端 `web_fetch` preflight 注入摘要 |
| Skill/Tool 引用 | 仅装饰 | 无 | Skill 追加 system prompt；Tool 生成 `allowedTools` 白名单 |
| 消息引用 | 无 | 支持但 v2.1.1 才修复编辑后引用不一致 bug | preemptive 保存 `targetVersion` + `targetBranchId`，校验失效 |
| 消息节点可变性 | 不支持 | 支持（编辑/删除/分支） | 基于 Phase 44 节点树，引用版本字段保持一致 |

核心命题：**RouteDev 的引用不只是拼字符串**——`CiteResolver.resolve()` 返回的 `CiteResolution` 是结构化的工具调用与上下文片段，由调用方按需自动执行，AI 不需要靠 system prompt 训练来理解引用格式。

---

## 陷阱引用

> **陷阱 #125：引用沦为复制粘贴。**
> 如果后端不解析引用，只把引用 JSON 拼在消息末尾，引用就只剩 UI 装饰。RouteDev 通过 `CiteResolver` 把 file/skill/url 等引用真正转化为 preflight 工具调用、`skillPrompts` / `macroPrompts` 追加、`allowedTools` 白名单，确保引用被结构化执行而非文本拼接。

> **陷阱 #126：引用标签过多导致输入框被挤压。**
> 标签区域必须有最大高度限制（如 3 行），超过时折叠为「已引用 N 项，点击展开」。`CiteManager.maxTags`（默认 10，上限 20）从源头限制数量，超限时 `add()` 抛 `CiteLimitExceededError`。

> **陷阱 #127：引用内容过长导致上下文膨胀。**
> text 引用通过 `cite.maxTextCiteLength`（默认 2000）截断，超限时 `CiteResolver` 在上下文中标注 `<已截断到 N 字符>`；文件 preflight 通过 `cite.maxPreflightTokens`（默认 8000）限制读取量，超过时只读取前 N token 并提示，而非静默截断。

> **陷阱 #128：引用持久化导致 localStorage / 消息历史膨胀。**
> 历史消息携带完整 `CiteItem[]`，长期对话会占用大量存储。file/folder 引用只保存元数据（path/name），不存内容；text/url/message 引用保存摘要或哈希引用，原文由后端 `CiteResolver` 在解析时重新读取。

> **陷阱 #134：`@` / `#` / `!` 触发器与用户输入冲突。**
> 用户可能正常输入 `@` 符号（如邮箱 `user@example.com`）。需要判断触发字符后是否紧跟字母且在补全列表中匹配到候选，避免误触发补全 UI。

> **陷阱 #135：CiteResolver 自动读取文件可能绕过权限。**
> preflight 工具调用必须经过 `PermissionEngine` 审批，不能因为「是引用触发的」就跳过审批流程。`cite.autoRunPreflight` 设为 `false` 时仅生成调用描述，由用户确认后执行。

> **陷阱 #136：消息引用与节点编辑不一致。**
> 若引用只保存节点 ID 而不保存版本戳，目标消息被编辑后引用会指向错误内容（APIX v2.1.1 已踩坑）。`CiteItem.targetVersion` 与 `targetBranchId` 强制记录引用时的版本快照，`CiteResolver` 解析时校验当前节点版本是否一致，不一致时标记 `outdated` 并提示用户更新。
