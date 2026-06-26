# RouteDev 外部生态导入指南

> RouteDev 不封闭生态：通过 `src/import/` 与 `src/mcp/claude-bridge.ts` 兼容 Anthropic Skills 目录、Claude Code Plugin 包、Codex Instructions 项目配置与 MCP 多协议桥接，让用户能直接复用 Claude / Codex / SonettoHere 等社区的现有资产。

## 目录

- [兼容范围](#兼容范围)
- [Anthropic Skills 目录兼容](#anthropic-skills-目录兼容)
- [Claude Code Plugin 结构](#claude-code-plugin-结构)
- [映射到 RouteDev 的对照表](#映射到-routedev-的对照表)
- [工具名映射](#工具名映射)
- [Codex Instructions 导入](#codex-instructions-导入)
- [MCP 桥接](#mcp-桥接)
- [配置项](#配置项)
- [安全策略](#安全策略)
- [陷阱引用](#陷阱引用)

---

## 兼容范围

RouteDev 通过四个独立模块覆盖外部生态来源，每个模块互不依赖，可单独启用：

| 来源 | 模块 | 入口 |
|------|------|------|
| Anthropic Skills 目录 | `AnthropicSkillsLoader` | `src/import/anthropic-skills-loader.ts` |
| Claude Code Plugin 包 | `ClaudePluginImporter` | `src/import/claude-plugin-importer.ts` |
| Codex Instructions | `CodexInstructionImporter` | `src/import/codex-importer.ts` |
| MCP 多协议配置 | `ClaudeMCPBridge` | `src/mcp/claude-bridge.ts` |

工具名翻译由 `src/import/tool-name-mapper.ts` 统一负责，把 Claude Code 遗留 slash command 中的工具调用翻译为 RouteDev 对应工具名。

---

## Anthropic Skills 目录兼容

RouteDev 直接扫描项目根下的 `anthropic_skills/` 目录，与内置 Skill 合并加载，复用 `SkillMdParser` 解析 `SKILL.md`，无需用户手动迁移。

### 目录结构

```
anthropic_skills/
├── unit-test/
│   └── SKILL.md
├── syntax-check/
│   └── SKILL.md
└── debug/
    └── SKILL.md
```

### 扫描与加载

`AnthropicSkillsLoader` 提供两个入口方法：

- `scan(projectRoot)`：递归查找 `anthropic_skills/**/SKILL.md`，返回 `LoadedSkill[]`（不读取 `autoEnable`）
- `load(projectRoot, { autoEnable })`：scan + 注入 `autoEnable` 标志，并收集 `errors`

`LoadedSkill` 在内置 `SkillData` 基础上扩展了三个字段：

```typescript
export interface LoadedSkill {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  content: string;        // SKILL.md 正文（已剥离 frontmatter）
  sourcePath: string;     // 原始 SKILL.md 绝对路径
  origin: 'anthropic-skills' | 'claude-plugin';
  autoEnable: boolean;    // 受 config.import.anthropicSkillsAutoEnable 控制
}
```

### 来源标注

所有从 `anthropic_skills/` 加载的 Skill 都带 `origin: 'anthropic-skills'` 标注，UI 中显示「来自 Anthropic Skills」。`frontmatter.name` 缺失或为 `unknown` 时回退到父目录名。

### 容错策略

- 目录不存在时静默返回空数组（不抛错）
- 单个 `SKILL.md` 解析失败时记入 `errors`，不影响其他 Skill 加载
- 内容为空时返回 `null`，由 `load()` 收集到 `errors`

---

## Claude Code Plugin 结构

`ClaudePluginImporter` 解析带元数据的 Claude Code Plugin 包，分类转换为 RouteDev 的 Skill / Agent Profile / MCP / Hook。

### 目录结构

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json          # 元数据（name/description/version/author/homepage/license）
├── .mcp.json                # MCP server 配置（可选）
├── commands/                # 遗留 slash command（*.md，可选）
├── skills/                  # SKILL.md 文件（可选）
├── agents/                  # Agent 定义（可选）
└── README.md
```

### 导入流程

`ClaudePluginImporter.importFromPath(pluginPath, { autoEnable, outputRoot })` 内部按 8 步执行：

1. 校验 plugin 根目录存在
2. 解析 `.claude-plugin/plugin.json` 元数据（缺失时用目录名回退并记 `errors`）
3. 解析 `skills/{name}/SKILL.md`（复用 `SkillMdParser`）
4. 解析 `commands/*.md`（legacy slash command → Skill，name 取自文件名）
5. 解析 `agents/*.md`（Agent Profile，name 取自文件名）
6. 解析 `.mcp.json`（动态加载 `ClaudeMCPBridge`；不可用时 warn 跳过）
7. 从 `plugin.json` 提取 `hooks` 声明（社区来源默认 `sandboxTrial: true`）
8. 写入输出目录 `${outputRoot}/.routedev/imported/claude/<plugin-name>/`

输出目录结构：

```
.routedev/imported/claude/<plugin-name>/
├── manifest.json        # 完整 PluginImportResult 序列化
├── skills/              # 每个 Skill 一个 .md 文件
├── commands/            # 每个 command 一个 .md 文件
├── agents/              # 每个 agent 一个 .md 文件
└── mcp/                 # MCP 配置（若存在）
```

### 导入结果

`PluginImportResult` 包含 `metadata` / `skills` / `agents` / `mcp` / `hooks` / `warnings` / `errors` / `outputDir` 八个字段。`ImportedSkill` 在 `LoadedSkill` 基础上扩展 `pluginName` 与 `sourceCommand`（仅 `commands/` 转换的 Skill 有 `sourceCommand`）。

---

## 映射到 RouteDev 的对照表

Claude Code Plugin 的各组件对应到 RouteDev 不同子系统，转换规则如下：

| Claude Code 组件 | RouteDev 对应物 | 转换说明 |
|------------------|----------------|---------|
| `.claude-plugin/plugin.json` | Skill 包元数据 | `name` / `description` / `version` / `author` / `homepage` / `license` 直接映射；缺失时用目录名回退 |
| `skills/{name}/SKILL.md` | RouteDev Skill | frontmatter + body 直接复用 `SkillMdParser`；`name` 为 `unknown` 时回退到目录名 |
| `commands/*.md` | RouteDev slash command（转换为 Skill） | `name` 取自文件名（去 `.md`），工具名经 `mapToolNames` 翻译；未映射工具生成 warning |
| `.mcp.json` | RouteDev MCP server 配置 | 通过 `ClaudeMCPBridge.convertFromClaudeConfig` 解析，字段映射见 [MCP 桥接](#mcp-桥接) |
| `agents/*.md` | RouteDev Agent Profile | `name` 取自文件名，`content` 为 md body（已剥离 frontmatter） |
| `hooks`（plugin.json 中声明） | RouteDev Hook | 社区来源默认 `sandboxTrial: true`，进入沙箱试用模式 |

---

## 工具名映射

Claude Code 遗留 slash command 使用首字母大写的工具名（如 `Read` / `Glob`），RouteDev 使用全小写带下划线的工具名（如 `read_file` / `list_directory`）。`tool-name-mapper.ts` 负责翻译。

### 映射表

| Claude Code 工具名 | RouteDev 工具名 | 说明 |
|-------------------|----------------|------|
| `Read` | `read_file` | 读取文件内容 |
| `Glob` | `list_directory` | 列出目录结构 |
| `Grep` | `search_code` | 代码搜索 |
| `Write` | `file_write` | 写文件 |
| `Edit` | `file_edit` | 编辑文件 |
| `Bash` | `execute_command` | 执行 shell 命令 |
| `WebFetch` | `web_fetch` | 抓取网页 |
| `WebSearch` | `web_search` | 网络搜索 |

映射表可通过 `getToolNameMap()` 获取副本，`reverseMapToolName()` 提供反向查询（仅供日志/调试）。

### API

```typescript
// 单名映射，未映射返回 null
export function mapToolName(name: string): string | null;

// 批量映射，返回 mapped + unmapped
export function mapToolNames(names: string[]): ToolNameMapResult;

// Skill 工具校验，未映射工具生成 warning
export function validateSkillTools(toolNames: string[]): SkillToolsValidation;
```

`ClaudePluginImporter.parseCommands` 通过 `detectToolMentions(content)` 从正文反引号包裹的标识符与已知工具名单词边界中检测工具调用，对未映射工具生成 warning，并把翻译后的工具列表以 HTML 注释形式追加到正文末尾。

> **陷阱 #132：** 未映射工具不能静默失败，必须收集到 `unmapped` 数组并生成 warning，由调用方决定是否禁用对应 Skill。

---

## Codex Instructions 导入

OpenAI Codex CLI 支持项目级 `.codex/` 目录，其中 `instructions.md` 是项目级 system instructions，`codex.md` 是部分版本的兼容文件。`CodexInstructionImporter` 负责扫描并按用户选择模式导入。

### 扫描规则

`scan(projectRoot)` 收集 `.codex/` 目录下所有 `.md` 文件，按文件名字母顺序合并，用 `\n\n---\n\n` 分隔。返回 `CodexScanResult`：

```typescript
export interface CodexScanResult {
  found: boolean;          // 是否找到 .codex/ 目录及至少一个 .md
  files: string[];         // 相对路径列表（按字母序）
  absolutePaths: string[]; // 绝对路径列表
  content: string;         // 合并后内容
  totalBytes: number;      // 合并后字节数
}
```

### 三种导入模式

`import({ projectRoot, mode, memoryTag })` 按用户选择的 `mode` 分流：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `system_prompt` | 返回 `systemPromptContent`，由上层追加到 `PromptManager` 的项目级 system prompt | 偏好强约束、内容较短 |
| `project_memory` | 按段落切分，每段打 `memoryTag`（默认 `codex-instruction`）标签，返回 `memoryEntries` | 默认推荐，避免 system prompt 过长 |
| `ignore` | 返回 `ignored: true`，不实际导入，记录用户选择 | 不想导入但仍要避免重复提示 |

`project_memory` 模式的段落切分优先级：

1. 按 `## 标题` 切分（每段包含标题行）
2. 无标题时按双换行切分
3. 单段超过 1000 字符时按句号（`。.!?`）二次切分，约 300 字符一段

### 更新检测

`hasUpdates(projectRoot, lastSeenMtimes)` 通过比较当前文件 `mtime` 与上次记录值判断是否需要重新提示用户：

- 任何文件 `mtime` 变化 → 返回 `true`
- 新增或删除文件 → 返回 `true`
- 全部一致 → 返回 `false`

> **陷阱 #130：** 导入时必须返回明确模式与数据，由上层决定写入策略，避免导入器直接覆盖已有项目记忆。`CodexInstructionImporter` 不直接调用 `ProjectMemoryManager`，只返回结构化数据。

---

## MCP 桥接

`ClaudeMCPBridge` 在 Claude Code `.mcp.json` 与 RouteDev `MCPConfig` 之间双向转换，覆盖 5 种传输协议与 3 种会话生命周期策略。

### 5 种传输协议

RouteDev 的 `MCPTransportType` 联合类型对齐 MCP 2025-03-26 规范与 SonettoHere / APIX 已验证的传输方式：

| 传输协议 | 来源/依据 | RouteDev transport | 必需字段 |
|---------|----------|-------------------|---------|
| `stdio` | Claude Code / SonettoHere | `stdio` | `command` + `args`（可选 `env` / `cwd`） |
| `http` | Claude Code / SonettoHere | `http` | `url`（可选 `headers`） |
| `sse` | SonettoHere / MCP 2025-03-26 | `sse` | `url`（可选 `headers`） |
| `streamable_http` | MCP 2025-03-26 / SonettoHere | `streamable_http` | `url`（可选 `headers`） |
| `websocket` | SonettoHere | `websocket` | `url`（可选 `headers`） |

### 3 种会话生命周期

受 APIX「可自定义会话生命周期」启发，`MCPLifecyclePolicy` 提供三种策略：

| 策略 | 行为 | 适用场景 |
|------|------|---------|
| `per-call` | 每次工具调用新建会话 | 无状态 server |
| `per-session` | 整个 RouteDev 会话期间保持连接 | 默认策略，需要上下文的 server |
| `persistent` | 应用级持久连接，可手动重连/断开 | 高频调用的 server |

导入时生命周期判定规则：

- Claude Code `.mcp.json` 未声明生命周期 → 默认 `per-session`
- SonettoHere YAML 声明 `persistent: true` → 映射为 `persistent`
- 用户可在 Settings > MCP 中修改每个 server 的生命周期策略

### 字段映射表

`ClaudeMCPBridge.importFromObject` 把 Claude Code server 配置转换为 `MCPServerConfig`：

| Claude Code `.mcp.json` | RouteDev MCPConfig | 说明 |
|------------------------|-------------------|------|
| `type: "http"` | `transport: "http"` + `url` | HTTP 请求-响应 |
| `type: "stdio"` | `transport: "stdio"` + `command` + `args` | 子进程通信 |
| `type: "sse"` | `transport: "sse"` + `url` | SSE 单向流 |
| `type: "streamable_http"` | `transport: "streamable_http"` + `url` | MCP 2025-03-26 双向流式 HTTP |
| `type: "websocket"` | `transport: "websocket"` + `url` | WebSocket 双向通信 |
| `headers` | `headers` | HTTP/SSE/Streamable/WebSocket 共用 |
| `env` | `env` | stdio 专用 |
| `timeout` | `connectTimeout` | 连接超时（毫秒） |
| `cwd` | `cwd` | stdio 子进程工作目录 |
| `persistent: true` | `lifecyclePolicy: "persistent"` | SonettoHere YAML 扩展字段 |

### ID 冲突处理

> **陷阱 #131：** 导入时必须重新生成唯一 ID，避免覆盖已有配置。

`resolveUniqueId(originalId, existing)` 按以下优先级生成唯一 ID：

1. 原 ID 不冲突 → 直接使用
2. 冲突 → 加 `claude-` 前缀（如 `myserver` → `claude-myserver`）
3. 仍冲突 → 追加 `-2`、`-3`... 后缀
4. 超过 99 次尝试 → 用时间戳兜底（`claude-myserver-<timestamp>`）

重命名记录写入 `BridgeImportResult.renamed`，UI 中标注「来自 Claude Code」。

### 自动发现

`discoverClaudeConfigs(projectRoot, homeDir?)` 按以下顺序扫描配置文件：

1. 项目级：`<projectRoot>/.mcp.json`
2. 用户级：`<homeDir>/.claude/.mcp.json`（默认 `os.homedir()`）

返回找到的所有配置文件绝对路径，供 UI 调用 `importFromClaudeConfig` 逐个导入。

### 反向导出

`exportToClaudeConfig(servers)` 把 RouteDev MCP 配置写回 Claude Code `.mcp.json` 格式：

- 仅支持 `stdio` 与 `http` 两种 transport（Claude Code 基础格式限制）
- `sse` / `streamable_http` / `websocket` 无法直接导出，记入 `skipped` 列表并说明原因
- `connectTimeout` 反向映射为 `timeout`
- 返回 JSON 字符串（pretty-printed）+ `skipped` 列表

---

## 配置项

外部生态导入配置位于 `config.import` 与 `config.mcp` 字段，由 `ImportConfigSchema` 与 `MCPConfigSchema` 定义（见 `src/config/schema.ts`）。

### `config.import`（ImportConfigSchema）

```typescript
export interface ImportConfig {
  anthropicSkillsAutoEnable: boolean;  // 默认 false
  claudePluginAutoEnable: boolean;     // 默认 false
  codexInstructions: 'system_prompt' | 'project_memory' | 'ignore';  // 默认 'project_memory'
  codexMemoryTag: string;              // 默认 'codex-instruction'
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `import.anthropicSkillsAutoEnable` | `false` | 是否自动启用 `anthropic_skills/` 目录下扫描到的 Skill。社区来源默认不启用，需用户确认 |
| `import.claudePluginAutoEnable` | `false` | 是否自动启用导入的 Claude Code Plugin。`false` 时 plugin 中的 Hook/MCP 进入沙箱试用模式 |
| `import.codexInstructions` | `project_memory` | Codex Instructions 导入模式，默认推荐 `project_memory` 避免 system prompt 过长 |
| `import.codexMemoryTag` | `codex-instruction` | `project_memory` 模式下写入项目记忆的标签 |

### `config.mcp`（MCPConfigSchema）

```typescript
export interface MCPConfig {
  servers: MCPServerEntry[];
  autoConnect: boolean;         // 默认 true
  autoReconnect: boolean;       // 默认 true
  connectTimeout: number;       // 默认 30000（毫秒，最小 1000）
  lifecyclePolicy: MCPLifecyclePolicy;  // 默认 'per-session'
}
```

`MCPLifecyclePolicySchema = z.enum(['per-call', 'per-session', 'persistent'])`，作为 `mcp.lifecyclePolicy` 全局默认值，单个 server 可在 `MCPServerEntry.lifecyclePolicy` 中覆盖。

---

## 安全策略

外部生态导入不是「照单全收」，所有外部来源必须经过 Schema 转换、工具名翻译、安全审查、来源标注、社区确认五道关卡。

### 社区来源默认不启用

- `import.anthropicSkillsAutoEnable` 默认 `false`：`anthropic_skills/` 下的 Skill 进市场但默认禁用
- `import.claudePluginAutoEnable` 默认 `false`：Plugin 中的 Hook 与 MCP 进入沙箱试用模式
- 用户在 Settings 或 `/plugin` 命令中显式确认后才启用

### Hook 进沙箱

`ClaudePluginImporter.extractHooks` 对从 `plugin.json` 提取的 Hook 应用以下策略：

- `autoEnable = true` → 直接启用，`sandboxTrial = false`
- `autoEnable = false` → 社区默认，`sandboxTrial = true`

> **陷阱 #129：** 社区来源的 Hook 可能包含危险操作（如 `git push --force`、文件删除）。沙箱试用期间敏感事件即使试用也需用户确认。

### 未映射工具禁用

`validateSkillTools` 对 Skill 中声明的工具名做校验：

- 已映射工具进入 `valid` 数组
- 未映射工具进入 `invalid` 数组，并为每个生成一条 warning
- 调用方据此决定是否禁用该 Skill 或仅警告

### MCP 部分失败容错

`ClaudeMCPBridge.importFromObject` 对每个 server 独立处理：

- 不支持的 transport 类型 → 记入 `failed`，不静默降级（陷阱 #137）
- 缺失必需字段（如 `stdio` 缺 `command`）→ 记入 `failed`
- 单个 server 桥接失败不影响其他 server 导入
- 文件读取或 JSON 解析失败时返回空 `servers` + `failed` 记录，不抛异常

---

## 陷阱引用

> **陷阱 #129：导入的 Claude Code Plugin 可能包含危险 Hook。**
> 社区来源的 Hook 必须进入沙箱试用模式（`sandboxTrial: true`），敏感事件（`git push`、文件删除）即使在试用期也需用户确认。`ClaudePluginImporter.extractHooks` 在 `autoEnable = false` 时强制开启沙箱试用。

> **陷阱 #130：Codex Instructions 可能与 RouteDev 项目记忆冲突。**
> 导入时必须提示用户选择 `system_prompt` / `project_memory` / `ignore` 三种模式，不能默默覆盖已有记忆。`CodexInstructionImporter.import` 不直接调用 `ProjectMemoryManager`，只返回结构化数据，由上层决定写入策略。

> **陷阱 #131：MCP server ID 冲突。**
> 导入时必须重新生成唯一 ID，避免覆盖已有配置。`resolveUniqueId` 按原 ID → `claude-` 前缀 → `-2` / `-3` 后缀 → 时间戳兜底的优先级生成新 ID，重命名记录写入 `BridgeImportResult.renamed`。

> **陷阱 #132：工具名映射不完整导致 Skill 不可用。**
> Claude Code 遗留命令工具名可能无法全部映射到 RouteDev。`mapToolNames` 与 `validateSkillTools` 把未映射工具收集到 `unmapped` / `invalid` 数组并生成 warning，由调用方决定是否禁用对应 Skill，绝不静默失败。

> **陷阱 #137：MCP 多协议导入后能力降级。**
> 若 RouteDev 自身只支持 stdio/http，却把 SonettoHere/APIX 的 SSE/WebSocket/Streamable HTTP server 导入为 http，会导致连接失败。`ClaudeMCPBridge` 对不支持的 transport 明确记入 `failed`，不静默降级；导出时无法表达的 transport 记入 `skipped` 并说明原因。
