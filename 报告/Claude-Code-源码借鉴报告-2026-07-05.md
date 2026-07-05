# Claude Code 2.1.88 源码借鉴报告

> 仓库：`https://github.com/DURUII/claude-code-sourcemap`（restored-src，2.1.88）
> 方法：5 个并行子 Agent 实际抓取并阅读 50+ 源文件，汇集 93 个原始借鉴点
> 输出：按 12 个主题重组，对照 RouteDev 现状标注可应用性（★高/☆中/○低）与优先级（P0~P3）
> 生成日期：2026-07-05

---

## 优先级汇总

| 优先级 | 数量 | 含义 |
|---|---|---|
| **P0** | 16 项 | 立即可吸收：高价值 + 已有基础，落地难度低-中 |
| **P1** | 30+ 项 | 短期可吸收：中价值 + 中等难度 |
| **P2/P3** | 40+ 项 | 中长期或低优先级 |

---

## P0 项清单（立即可吸收）

| 编号 | 借鉴点 | RouteDev 已有基础 | 落地难度 |
|---|---|---|---|
| P0-1 | buildTool 工厂 + satisfies | ITool 接口 | 中 |
| P0-2 | ValidationResult 辨识联合 + errorCode | validateArgs 已有 | 低 |
| P0-3 | backfillObservableInput 防 hook 绕过 | checkPathBoundary 已有 | 低 |
| P0-4 | Fork 子 Agent prompt-cache-sharing | DualLoopOrchestrator 已有 | 中 |
| P0-5 | TodoWrite 验证 nudge | TodoWriteTool 已有 | 低 |
| P0-6 | 命令元数据 stub + load() 懒加载 | 命令系统已存在 | 中 |
| P0-7 | Skill 作为用户自定义命令 + frontmatter 契约 | 插件 SDK 已存在 | 中 |
| P0-8 | Skill 即 Prompt Command | 插件 SDK 已存在 | 中 |
| P0-9 | Bundled skill 安全文件抽取 | 插件加载已存在 | 中 |
| P0-10 | querySource-aware 重试 | RetryPolicy/CircuitBreaker 已有 | 中 |
| P0-11 | Analytics 队列 + 后挂 sink | OtelExporter 已有 | 中 |
| P0-12 | 嵌套消息 ⎿ 视觉语法 + Context 抑制 | 用户偏好直接对应 | 低 |
| P0-13 | Ratchet 高度棘轮防布局抖动 | 用户偏好直接对应 | 低 |
| P0-14 | graceful shutdown 注册式清理链 | 用户硬约束直接对应 | 中 |
| P0-15 | Hook 事件分类法（27 种事件） | PreCompact 已有事件 | 中 |
| P0-16 | 双层 stale-check 保证文件编辑原子性 | FileEditTool 已有 | 中 |

---

## 主题 1：工具系统设计

### 1.1 buildTool 工厂 + 配置对象 + satisfies 【P0-1】

**Claude Code**（`src/Tool.ts`、`src/tools/GlobTool/GlobTool.ts`）：工具不是抽象基类，而是 `buildTool({...} satisfies ToolDef<InputSchema, Output>)` 配置对象，扁平、可组合、可序列化。

**RouteDev 现状**：当前用 `class XxxTool implements ITool` 类继承模式，已有 `ITool` 接口但每个工具需手填大量字段。

**借鉴方向**：保留 ITool 接口，但新增一个 `defineTool(def: ToolDef)` 工厂函数 + `satisfies` 校验，新工具用工厂、旧工具兼容类。优势是后续支持 MCP/Skill 工具时可在同一类型下统一处理。

---

### 1.2 ValidationResult 辨识联合 + errorCode 【P0-2】

**Claude Code**（`src/Tool.ts`）：
```ts
type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number; behavior?: 'ask' }
```

**RouteDev 现状**：`validateArgs` 返回 `{ valid: boolean; errors: string[] }`，无 errorCode，无 ask 行为。

**借鉴方向**：扩展为辨识联合，errorCode 用于错误归因与自动修复（"errorCode 6 = 没读过文件，自动 Read 再 Edit"），`behavior: 'ask'` 让 harness 决定弹窗还是直接拒绝。

---

### 1.3 mapToolResultToToolResultBlockParam 序列化层 【P1】

**Claude Code**（`src/tools/GrepTool/GrepTool.ts`）：工具内部 Output 是结构化数据（numFiles/numMatches/durationMs/truncated），独立一层 `mapToolResultToToolResultBlockParam` 序列化给 LLM。UI 拿结构化数据展示"Found 3 files in 12ms"，LLM 拿精简文本。

**RouteDev 现状**：工具直接返回 `output: string`，UI 与 LLM 拿到同一字符串，UI 无法做"Found 3 files"等结构化展示。

**借鉴方向**：在 `ToolResult` 中新增可选 `metadata: Record<string, unknown>`（部分工具已有），后续 UI 渲染层逐步消费 metadata 实现折叠展示。

---

### 1.4 isConcurrencySafe + isReadOnly + interruptBehavior 【P1】

**Claude Code**（`src/Tool.ts`）：`isConcurrencySafe() → true` 的工具可并行执行（Grep/Glob/FileRead/WebSearch），写工具默认 false。`interruptBehavior() → 'cancel' | 'block'` 决定用户发新消息时是取消还是阻塞。

**RouteDev 现状**：Agent Loop 串行执行所有工具，长任务（如 build）期间用户输入只能等待。

**借鉴方向**：在 ITool 接口加 `isConcurrencySafe?(): boolean`，Agent Loop 按此分组并行执行只读工具。`interruptBehavior` 配合现有的中断机制实现。

---

### 1.5 searchHint + shouldDefer 延迟加载 【P1】

**Claude Code**（`src/Tool.ts` 注释、TodoWrite/WebSearch）：低频工具标 `shouldDefer: true`，system prompt 只注入 `searchHint`（3-10 词能力短语），模型通过 ToolSearch 按需加载完整定义。

**RouteDev 现状**：所有工具定义全量注入 system prompt，工具数量增长时 prompt 膨胀。

**借鉴方向**：内置工具保留全量注入；MCP 工具和 Skill 工具超过阈值（如 30 个）时启用 ToolSearch 中间层。

---

### 1.6 backfillObservableInput 防 hook 绕过 【P0-3】

**Claude Code**（`src/tools/FileEditTool/FileEditTool.ts`）：调用工具前先用 `backfillObservableInput` 把 `~/foo`、`./foo` 展开为绝对路径，让 hook 白名单和权限规则始终基于绝对路径匹配，杜绝绕过。

**RouteDev 现状**：FileEditTool 用 `checkPathBoundary` 做了路径边界校验，但 hook 白名单匹配前未规范化输入。

**借鉴方向**：在 ITool 接口新增可选 `backfillObservableInput?(input)`，所有路径类工具在权限校验前调用，与 ConfigGuard、CommandSandbox 协同。

---

### 1.7 aliases 字段支持工具重命名 【P2】

**Claude Code**：`toolMatchesName(tool, name)` 同时匹配 `tool.name` 和 `tool.aliases`，工具改名后旧名仍可查到，旧 hook 规则、旧 transcript 不破坏。

**RouteDev 现状**：工具改名无向后兼容机制。

**借鉴方向**：低优先级，未来工具命名演化时启用。

---

## 主题 2：Agent Loop 与执行流

### 2.1 Fork 子 Agent 的 prompt-cache-sharing 【P0-4】

**Claude Code**（`src/tools/AgentTool/forkSubagent.ts`）：
- FORK_AGENT 用 `model: 'inherit'` + `permissionMode: 'bubble'`
- **不重新渲染 system prompt**，直接用父 Agent 已渲染的 `renderedSystemPrompt` 字节（避免 GrowthBook 冷热启动导致 cache bust）
- `buildForkedMessages` 构造字节一致前缀：保留父 Agent 完整 assistant message（含 tool_use），为每个 tool_use 生成**完全相同的 placeholder tool_result**，只在末尾追加 per-child directive

**RouteDev 现状**：子 Agent 各自重新构造 system prompt，无 prompt cache 友好性考虑。

**借鉴方向**：DualLoopOrchestrator 和 spawn_agent 工具复用此模式——父 Agent 的 `renderedSystemPrompt` 字节透传，directive 放消息末尾。这是降低多 Agent 成本的关键优化。

---

### 2.2 TodoWrite 验证 nudge —— 工具结果里注入条件性指令 【P0-5】

**Claude Code**（`src/tools/TodoWriteTool/TodoWriteTool.ts`）：关闭 3+ 任务且无 `/verif/i` 匹配项时，在 `mapToolResultToToolResultBlockParam` 追加 nudge 文本引导模型 spawn VERIFICATION_AGENT。

**RouteDev 现状**：所有规则写死在 system prompt，无基于上下文状态的条件性 nudge。

**借鉴方向**：在关键工具结果里注入条件性 nudge（如"测试通过但覆盖率下降→提示补充测试"、"提交前未跑 lint→提示跑 lint"、"3+ 任务关闭无验证→提示验证"）。比 system prompt 写死规则更精准，token 更省。

---

### 2.3 commandSemantics 按命令解释退出码 【P1】

**Claude Code**（`src/tools/BashTool/commandSemantics.ts`）：`grep` 退出 1 = "No matches"（非失败）；`diff` 退出 1 = "Files differ"；`test` 退出 1 = "Condition is false"。Map 表按命令名解释退出码。

**RouteDev 现状**：ShellExecTool 把所有非零退出码当作失败，模型可能反复重试"无匹配"场景。

**借鉴方向**：在 ShellExecTool 增加 `commandSemantics` Map，已知命令的退出码语义在 metadata 中标注，LLM 看到 "No matches found" 而非误判失败。

---

### 2.4 destructiveCommandWarning 纯展示层警告 【P1】

**Claude Code**（`src/tools/BashTool/destructiveCommandWarning.ts`）：正则模式库检测 `git reset --hard` / `git push --force` / `DROP TABLE` / `kubectl delete` / `terraform destroy` 等，返回纯提示字符串，注释明确"不影响权限逻辑，仅用于权限对话框展示"。

**RouteDev 现状**：CommandSandbox 已有 DANGEROUS_PATTERNS 拦截 rm -rf/format 等，但 `git push --force` 这类"用户可能合理使用但有风险"的命令无中间态展示。

**借鉴方向**：与 ConfigGuard 协同——硬拦截走 CommandSandbox，软警告走 destructiveCommandWarning 在权限对话框展示。两层解耦。

---

## 主题 3：命令系统

### 3.1 三种命令类型判别联合 【P1】

**Claude Code**（`src/types/command.ts`）：
```ts
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
// prompt: 喂给模型
// local: 同步执行返回 text/compact/skip
// local-jsx: 返回 React 节点在 TUI 渲染
```

**RouteDev 现状**：所有命令统一返回字符串或直接执行，UI 命令和 prompt 命令混在一起。

**借鉴方向**：定义 `RouteDevCommand = UiCommand | PromptCommand | ImmediateCommand`，UI 命令走 React 组件、Prompt 命令注入对话、Immediate 命令即时执行。

---

### 3.2 元数据 stub + load() 懒加载 【P0-6】

**Claude Code**（`src/commands/clear/index.ts`）：每个命令 `index.ts` 只 14 行元数据，唯一实现入口是 `load: () => import('./clear.js')`。`commands.ts` 顶部 import ~100 个 stub 几乎零成本。

**RouteDev 现状**：所有命令在 `src/cli/commands/` 下直接 export 完整实现，启动时全量加载。

**借鉴方向**：每个命令拆为 `index.ts`（元数据 + load 函数）和 `impl.ts`（实现），命令注册表只装 stub。带 React 组件或重服务的命令受益最大。

---

### 3.3 immediate 标志统一管控"打断 loop" 【P1】

**Claude Code**：`CommandBase.immediate?: boolean` 让 `/model`、`/fast`、`/exit`、`/status`、`/mcp`、`/hooks` 绕过 turn 队列直接执行，避免"切模型还要等当前回复跑完"。

**RouteDev 现状**：命令在 Agent Loop 队列中等待，无 immediate 概念。

**借鉴方向**：命令 schema 加 `immediate?: boolean`，dispatcher 检查此标志立即执行。

---

### 3.4 LocalJSXCommandOnDone 回调协议 【P1】

**Claude Code**（`src/types/command.ts`）：
```ts
type LocalJSXCommandOnDone = (result?, options?: {
  display?: 'skip' | 'system' | 'user'
  shouldQuery?: boolean  // 是否触发模型推理
  nextInput?: string; submitNextInput?: boolean  // 链式输入
}) => void
```

**RouteDev 现状**：UI 命令完成后由 dispatcher 统一决定后续行为，命令自身无法控制。

**借鉴方向**：UI 类 slash 命令（如 /settings、/model）增加 onDone 回调，特别是 `shouldQuery`（命令完成后自动续接对话）和 `nextInput`（链式填入下一条输入）。

---

### 3.5 Skill 作为用户自定义命令 + frontmatter 契约 【P0-7】

**Claude Code**（`src/skills/loadSkillsDir.ts`）：`SKILL.md` + frontmatter 定义自定义命令，字段包括 `name/description/when_to_use/allowed-tools/arguments/argument-hint/model/effort/context/hooks/paths/shell/version`。

**RouteDev 现状**：插件 SDK 已存在，但无用户可写的 SKILL.md 格式；用户自定义命令需写 TS 代码。

**借鉴方向**：定义 `SKILL.md` 格式，至少支持 `description/when_to_use/allowed-tools/arguments/paths`。`when_to_use` 字段注入 system prompt 影响 skill 触发概率；`paths` 字段实现按文件路径自动激活。

---

### 3.6 参数替换系统 【P1】

**Claude Code**（`src/utils/argumentSubstitution.ts`）：`$ARGUMENTS` / `$0` / `$1` / 命名参数 `$foo`（按 `arguments: foo bar` 顺序映射），用 `tryParseShellCommand` 做 shell-quote 解析。

**RouteDev 现状**：无参数替换机制。

**借鉴方向**：自定义命令支持这套占位符语法，特别是命名参数。

---

### 3.7 prompt 内联 shell 执行 `!`...`` 【P2】

**Claude Code**（`src/commands/commit.ts`）：prompt 字符串里 `!`git status`` 在命令加载时执行，结果内联到 prompt 文本。`/init`、`/commit` 用此机制动态注入仓库上下文。

**RouteDev 现状**：无内联 shell 机制。

**借鉴方向**：本地 skill 允许内联 shell 预处理，市场下载的 skill 默认禁用（远程不可信）。降低 skill 代码复杂度。

---

### 3.8 memoize 分层缓存策略 【P2】

**Claude Code**（`src/commands.ts`）：`COMMANDS()` memoize 模块级常量；`loadAllCommands(cwd)` memoize by cwd（重 I/O）；`getCommands(cwd)` 不缓存（每次重跑过滤逻辑反映 auth 变更）。

**RouteDev 现状**：命令发现无分层缓存。

**借鉴方向**：磁盘扫描按 cwd memoize，过滤逻辑每次重算。

---

## 主题 4：Skills 系统

### 4.1 Skill 即 Prompt Command 【P0-8】

**Claude Code**（`src/skills/bundledSkills.ts`）：skill 实现 `type: 'prompt'` 的 Command。调用 skill = 把 `getPromptForCommand` 返回的 text block 注入对话，副作用统一由 Bash/Edit/Agent 工具承担。skill 与工具系统完全解耦。

**RouteDev 现状**：技能系统已规划但未实现，用户期望"研发流程模板"。

**借鉴方向**：把"按 PR 模板写代码"、"跑回归脚本"做成 prompt-only skill，skill 仓库可声明 `allowedTools` 白名单配合权限系统做到"这个 skill 只能读不能写"。

---

### 4.2 `${CLAUDE_SKILL_DIR}` 占位符 + 跨平台路径处理 【P1】

**Claude Code**（`src/skills/loadSkillsDir.ts` 第 326-376 行）：prompt 模板支持 `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` 占位符；Windows 下反斜杠转正斜杠避免 shell 转义。

**RouteDev 现状**：无占位符机制。

**借鉴方向**：在 prompt 模板里支持 `${ROUTEDEV_SKILL_DIR}` / `${ROUTEDEV_PROJECT_ROOT}` / `${ROUTEDEV_BRANCH}` 等占位符。

---

### 4.3 Bundled skill 的安全文件抽取 【P0-9】

**Claude Code**（`src/skills/bundledSkills.ts`）：用 `O_NOFOLLOW | O_EXCL | O_CREAT` + `0o600` 写入；路径校验绝对路径或含 `..` 一律拒绝；并发调用通过 memoize promise 共享；per-process nonce 是主防线，文件模式是兜底。

**RouteDev 现状**：插件加载无此级防御。

**借鉴方向**：skill marketplace 下载的 skill 若需解压附件，必须用相同策略，不能简单 `fs.writeFile`。

---

### 4.4 写一次注册器打破循环依赖 【P1】

**Claude Code**（`src/skills/mcpSkillBuilders.ts`）：纯类型叶子模块，`loadSkillsDir.ts` 初始化时调 `registerMCPSkillBuilders(b)`，MCP skill 加载时 `getMCPSkillBuilders()` 取出。

**RouteDev 现状**：用变量路径动态 import 绕过（`const p = '../xxx.js'; import(p)`），TS 静态解析不稳定。

**借鉴方向**：出现"A 模块需要 B 的工厂，B 又需要 A 的类型"时，抽一个纯类型叶子模块做写一次注册器。

---

### 4.5 Skill prompt 作为"带解析规则的指令手册" 【P1】

**Claude Code**（`src/skills/bundled/loop.ts`）：`/loop` skill 把参数解析规则、单位换算表、动作步骤全用结构化 Markdown 写进 prompt，让 LLM 解析自然语言输入后调 `cron_create` 工具。skill 不写解析代码。

**RouteDev 现状**：命令参数解析用 argparse 风格代码。

**借鉴方向**：对"参数形态多变"的命令，与其写复杂 argparse，不如把解析规则写成 prompt 表，让 LLM 解析后调结构化工具。降低 skill 代码复杂度，提升容错。

---

### 4.6 /batch 并行 worktree agent 编排 【P1】

**Claude Code**（`src/skills/bundled/batch.ts`）：coordinator 拆解 5-30 个独立单元 → 每个 unit 派 background agent（`isolation: "worktree"`）→ worker 自闭环（simplify/test/e2e/commit/PR）→ 约定输出格式 `PR: <url>` 让 coordinator 解析。

**RouteDev 现状**：多 Agent 已实现 DAG/CompositionalRouter，但无 worktree 隔离和 PR 约定解析。

**借鉴方向**：批量任务 skill 复用此模式，`isolation: "worktree"` 是关键保证子任务互不污染。

---

### 4.7 skill 的 paths 字段（路径触发） 【P1】

**Claude Code**（`src/skills/loadSkillsDir.ts` `parseSkillPaths`）：`paths: src/components/**` 用 gitignore 风格模式，配合 `ignore` 库做路径匹配。skill 只在编辑匹配路径下文件时注入上下文。

**RouteDev 现状**：所有 skill 全程占用 context。

**借鉴方向**：定义"上下文 skill"——编辑 `src/components/*.tsx` 时自动加载 React 规范 skill，编辑 `*.go` 时加载 Go 规范 skill。比让用户手动 `/skill` 切换体验好得多。

---

### 4.8 skill 的 deduplication 用 realpath 【P2】

**Claude Code**：用 realpath 而非 inode（虚拟/容器/NFS 文件系统 inode 不可靠）做去重。

**RouteDev 现状**：无多源 skill 加载。

**借鉴方向**：未来支持多源 skill 时使用。

---

## 主题 5：服务层与韧性

### 5.1 多 Provider 客户端工厂 + 动态 import 【P1】

**Claude Code**（`src/services/api/client.ts`）：4 种后端（Anthropic 1P/Bedrock/Vertex/Foundry）通过 `getAnthropicClient()` 统一入口，各 provider 走独立动态 import，共享 `defaultHeaders/timeout/fetchOptions/maxRetries` 基础参数。

**RouteDev 现状**：已有 `createLLMClient` 支持 OpenAI/Gemini/DeepSeek/Qwen/Ollama clientType 分发，但各 client 分散实现。

**借鉴方向**：收敛到单一工厂入口，基础参数在工厂层统一注入。

---

### 5.2 querySource-aware 重试 【P0-10】

**Claude Code**（`src/services/api/withRetry.ts`）：`FOREGROUND_529_RETRY_SOURCES` 白名单（repl_main_thread/sdk/agent:custom/compact/verification_agent 等），后台任务（summary/title/suggestion/classifier）529 时直接 bail，避免级联风暴。

**RouteDev 现状**：RetryPolicy/CircuitBreaker 已存在，但无 querySource 区分。

**借鉴方向**：给每次 LLM 调用打 `querySource` 标签，重试策略按标签分桶——用户阻塞型任务全力重试，后台任务快速失败。

---

### 5.3 Fast Mode Cache-Aware Fallback 【P1】

**Claude Code**：fast mode 与 standard mode 是不同 model name，切换会让 prompt cache 全破。短 retry-after 保持 fast mode 等待；长 retry-after 进入最小 cooldown floor 防 flip-flop。

**RouteDev 现状**：模型路由熔断器已实现，但无 cache 友好性考虑。

**借鉴方向**：多档位模型路由时，把"cache 友好性"作为重试策略输入——短延迟保持当前档，长延迟切档但加最小 cooldown 防抖。

---

### 5.4 Context Overflow 自适应调整 max_tokens 【P1】

**Claude Code**：400 context overflow 时不直接报错，把 `max_tokens` 收缩到 `contextLimit - input - 1000`，让 retry 自我修复。

**RouteDev 现状**：context overflow 直接报错。

**借鉴方向**：重试不是简单重复——错误响应里的可用上下文信息作为下一次请求的参数输入。

---

### 5.5 错误 cause chain 解析 + actionable hint 【P1】

**Claude Code**（`src/services/api/errorUtils.ts`）：沿 `error.cause` 链最多走 5 层，匹配 OpenSSL SSL 错误码集（15 个），给企业代理用户输出 `NODE_EXTRA_CA_CERTS` 建议。

**RouteDev 现状**：错误展示裸 message。

**借鉴方向**：错误展示层做 cause chain 遍历 + 错误码分类表 + actionable hint。

---

### 5.6 VCR 测试 fixture 录制/回放 【P1】

**Claude Code**（`src/services/vcr.ts`）：input sha1 作文件名缓存输出，CI 严格模式（缺 fixture 即报错），`VCR_RECORD=1` 录制。`dehydrate/hydrate` 把非确定性 value（UUID、timestamp）替换为确定性占位。

**RouteDev 现状**：评估用例集（Smoke 10 + Regression 30）已存在，但 LLM 调用无 fixture 录制。

**借鉴方向**：为 LLM 集成做测试 fixture 系统，CI 严格模式（缺 fixture 即报错），序列化时分离确定性/非确定性字段。

---

### 5.7 防止系统休眠的引用计数 + 自愈 timeout 【P2】

**Claude Code**（`src/services/preventSleep.ts`）：`caffeinate -i -t 300` + 4 分钟重启 + `unref()` + `registerCleanup`。

**RouteDev 现状**：无防休眠机制。

**借鉴方向**：CLI 长任务场景使用，引用计数 + 自愈 timeout 子进程管理。

---

## 主题 6：可观测性与遥测

### 6.1 Analytics 队列 + 后挂 sink 模式 【P0-11】

**Claude Code**（`src/services/analytics/index.ts`）：模块加载时 `sink = null`，`logEvent` 进 `eventQueue`，`attachAnalyticsSink` 在 app 启动时挂载并 `queueMicrotask` 排空队列。零依赖，避免 analytics→sink→analytics import cycle。

**RouteDev 现状**：OtelExporter 已存在，但所有模块直接 import，启动期加载 OpenTelemetry 依赖。

**借鉴方向**：把 analytics API 设计成零依赖纯函数 + 队列，sink 可插拔，启动时挂载。所有模块能在任意阶段调用 `logEvent`。

---

### 6.2 PII 双层路由 + 类型强制自检 【P1】

**Claude Code**：
```ts
type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never
```
`_PROTO_*` 前缀 key 只进 1P（特权列），Datadog fanout 前 `stripProtoFields` 一次剥离所有。

**RouteDev 现状**：无 PII 路由分层。

**借鉴方向**：用"自检式类型名"作为隐私审查工具——任何要进遥测的字符串都得 cast，cast 时打字一遍声明"我确认这不是代码/路径"。

---

### 6.3 1P Event Exporter 文件队列 + 二次 backoff 【P1】

**Claude Code**（`src/services/analytics/firstPartyEventLoggingExporter.ts`）：失败事件追加到 JSONL 文件（session+batchUuid 隔离），启动时 `retryPreviousBatches()`，二次 backoff（base 500ms / max 30s / 8 attempts），killswitch 每次循环检查。

**RouteDev 现状**：遥测失败即丢弃。

**借鉴方向**：遥测 export 失败时落盘到 JSONL 文件，下次启动重试。

---

### 6.4 profileCheckpoint 全链路启动插桩 【P1】

**Claude Code**：从 bin 入口到 init 完成，每个阶段 `profileCheckpoint(name)` 打点，`profileReport` 输出各阶段耗时。

**RouteDev 现状**：无启动性能插桩。

**借鉴方向**：实现轻量 `profileCheckpoint(name)`（基于 `performance.now()`），在 bin 入口、配置加载、认证、插件注册、MCP 连接、TUI 渲染打点。配合 `--profile` flag 输出耗时报告。

---

### 6.5 Gateway 指纹检测 【P2】

**Claude Code**（`src/services/api/logging.ts`）：响应头前缀（`x-litellm-` / `helicone-` / `x-portkey-` / `cf-aig-`）和 host 后缀识别 AI Gateway，用于分析报表分组。

**RouteDev 现状**：无 gateway 检测。

**借鉴方向**：未来支持多 gateway 部署时使用。

---

## 主题 7：MCP 集成

### 7.1 MCP InProcessTransport 同进程通信 【P1】

**Claude Code**（`src/services/mcp/InProcessTransport.ts`）：`createLinkedTransportPair()` 返回一对通过 `queueMicrotask` 异步投递的 transport，让 MCP server 和 client 同进程运行无需 spawn。

**RouteDev 现状**：MCPClientManager 已存在，但仅支持 stdio/SSE/HTTP 传输。

**借鉴方向**：为 plugin/extension 系统提供 in-process transport 作为开发期/测试期/轻量场景的传输，与 stdio/HTTP 传输同接口。

---

### 7.2 MCP 配置内容签名去重 【P1】

**Claude Code**（`src/services/mcp/config.ts`）：`getMcpServerSignature` 计算 `stdio:<cmd-json>` 或 `url:<unwrapped-url>` 作为去重 key，manual 优先于 plugin。

**RouteDev 现状**：无 MCP 配置去重。

**借鉴方向**：多源配置合并时基于内容签名而非 name 去重。

---

### 7.3 MCPTool 骨架 + 运行时覆盖 【P1】

**Claude Code**（`src/tools/MCPTool/MCPTool.ts`）：`isMcp: true` 标志，name/schema/description/prompt/call 全部 "Overridden in mcpClient.ts"，`passthrough` 权限行为由外层运行时决定。

**RouteDev 现状**：MCP 工具硬编码每个工具。

**借鉴方向**：学习"骨架 + 运行时覆盖"模式，`isMcp` 标志位让 harness 知道这个工具的权限/错误处理走 MCP 协议。

---

### 7.4 跨 Channel 权限中继短 ID 【P2】

**Claude Code**：FNV-1a 哈希压缩 toolUseID 成 5 字母短码（25 字母表排除 `l`），24 词脏话 blocklist + salt re-hash，避免给用户手机发"fuck"等不雅 ID。

**RouteDev 现状**：无跨 channel 权限中继。

**借鉴方向**：未来移动端批准流程使用。

---

### 7.5 跨 Channel 权限——结构化事件而非文本 regex 【P1】

**Claude Code**：用户回复"yes tbxkq"由 server 端解析文本并 emit 结构化 notification `notifications/claude/channel/permission`，CC 只做 ID 匹配。

**RouteDev 现状**：无跨 channel 权限。

**借鉴方向**：跨端批准/确认流程用结构化事件协议，文本输入由可信 server 端解析；客户端只做 ID 匹配，文本消息本身永远不构成授权。

---

## 主题 8：认证与企业特性

### 8.1 OAuth PKCE 本地 HTTP server 捕获 redirect 【P1】

**Claude Code**（`src/services/oauth/auth-code-listener.ts`）：`http.createServer` + OS-assigned port(0) 监听本地 callback，state 参数防 CSRF，存 pendingResponse 以便后续把浏览器重定向到 success 页。

**RouteDev 现状**：无 OAuth 流程。

**借鉴方向**：未来支持 OAuth 登录时使用。

---

### 8.2 远程管理设置 ETag + 跨语言 checksum 【P2】

**Claude Code**：`sortKeysDeep` + 紧凑分隔符模仿 Python `json.dumps(sort_keys=True, separators=(",", ":"))`，sha256 作 ETag，304 时不传 body。

**RouteDev 现状**：无远程配置同步。

**借鉴方向**：企业版远程配置同步使用。

---

### 8.3 远程设置资格预检查 + 避免循环依赖 【P2】

**Claude Code**：provider/环境/订阅类型筛选，`skipRetrievingKeyFromApiKeyHelper: true` 防止 `getSettings()` → 远程设置 → `getAnthropicApiKeyWithSource()` → `apiKeyHelper` → `getSettings()` 循环。

**RouteDev 现状**：无远程设置。

**借鉴方向**：循环依赖高发区（apiKey 加载）显式提供 `skipXxx` 选项让调用方主动断环。

---

## 主题 9：TUI 设计

### 9.1 嵌套消息的 ⎿ 视觉语法 + Context 抑制 【P0-12】

**Claude Code**（`src/components/MessageResponse.tsx`）：`  ⎿  ` 前缀缩进表达子结果，`MessageResponseContext` 默认 false 包裹子树，已在 MessageResponse 内部就不再渲染前缀避免 `⎿ ⎿ ⎿`。`<NoSelect>` 让装饰字符不被选中。

**RouteDev 现状**：用户偏好"工具调用 UI 最小化占用空间，最终输出显示在工具记录下方"——天然适合此模式。

**借鉴方向**：渲染工具调用结果、子 agent 输出、思考链时套这个模式——一层 `⎿` + Context 抑制 + NoSelect。

---

### 9.2 Ratchet 高度棘轮防布局抖动 【P0-13】

**Claude Code**（`src/components/design-system/Ratchet.tsx`）：记录历史最大高度，元素一旦离开视口就 `setMinHeight`，后续内容只能更高不能更低。`lock='offscreen'` 比 `lock='always'` 更友好——视口内允许自然伸缩，滚出去才锁定。

**RouteDev 现状**：流式输出时内容长度先涨后缩（spinner 转完变静态行），无锁定机制导致后续内容上下跳。

**借鉴方向**：任何"先流式再定格"的组件（命令输出、测试进度、agent 思考）都该套 Ratchet。

---

### 9.3 Spinner 的人感反馈聚合 【P1】

**Claude Code**（`src/components/Spinner.tsx`）：聚合当前 todo（`activeForm`/`subject`）+ 随机动词 + token 预算（含 ETA）+ 思考时长（最少 2s 防 jank）+ 闲时 tips（30s 提示 `/btw`、18min 提示 `/clear`）+ 卡顿检测（3 秒无新 token 变红）。

**RouteDev 现状**：用户偏好"动态效果指示任务运行状态（spinners/progress bars/time counters）"——直接对应。

**借鉴方向**：长任务进度组件套这套——动词来自任务 `activeForm`、超时阈值触发 tips、ETA 基于实时速率、空闲态显式区分"我真没事"vs"我在等子任务"。

---

### 9.4 设计系统 Pane/Divider/Dialog 分工 【P1】

**Claude Code**（`src/components/design-system/Pane.tsx`）：三种容器分工明确——`Pane`（slash 命令屏，顶部分隔线 + padding）、`Dialog`（确认/取消，自带键绑定）、`Panel`（圆角卡片）。modal 内自动去边框避免双层框。

**RouteDev 现状**：用户偏好"独立的 modal 设置页面"、"无多余框/盒"——天然适合此模式。

**借鉴方向**：定义 3 种容器原语并写清楚"何时用哪个"的注释，让所有屏复用同一套容器。

---

### 9.5 Divider 的居中标题 + stringWidth 处理 CJK 【P1】

**Claude Code**（`src/components/design-system/Divider.tsx`）：`stringWidth` 正确处理 CJK 全角字符宽度，`<Ansi>` 解析标题里的 ANSI 转义，`dimColor={!color}` 让无色时退化为暗淡。

**RouteDev 现状**：用户使用中文，分隔线标题可能偏移。

**借鉴方向**：任何"画分隔线"的组件都要用 `stringWidth` 而不是 `.length`，否则中文标题会偏。

---

### 9.6 TextInput 可访问性 + 状态光标 【P1】

**Claude Code**（`src/components/TextInput.tsx`）：光标三态——录音时显示音量波形（静音变灰、有声色相循环），可访问性模式完全隐藏光标，未聚焦终端也不显示。EMA 平滑让数值动画不抖动。

**RouteDev 现状**：用户偏好"主题色定制（默认紫色）"——光标可承载主题色。

**借鉴方向**：输入框光标可以承载状态——录音、命令模式、vim 模式、只读。可访问性环境变量 + reduced motion 是必做的无障碍基线。

---

### 9.7 LogSelector fuzzy 搜索 + 多维过滤 + 懒加载 【P1】

**Claude Code**（`src/components/LogSelector.tsx`）：元数据全量 + 详情懒加载，title 快搜 + 内容 snippet 深搜两层，snippet 带上下文高亮，多维过滤组合（tag/branch/worktree），`useDeferredValue` 让搜索输入不卡顿。

**RouteDev 现状**：会话历史列表简单。

**借鉴方向**：任何"历史记录列表"都该做这套模式。

---

### 9.8 屏的状态机切换 + 子屏渲染父屏 【P2】

**Claude Code**（`src/screens/ResumeConversation.tsx`）：`loading`/`resuming`/`crossProjectCommand`/`resumeData`/正常选择态，每态返回不同 `<Box>` 树。屏切换不是路由，是"子屏渲染父屏"——ResumeConversation 恢复完会话后直接 `<REPL initialMessages=...>`。

**RouteDev 现状**：CLI 屏切换无统一模式。

**借鉴方向**：CLI 屏切换用"组件状态机 + 嵌套渲染"而非路由库。

---

### 9.9 Doctor 屏诊断分区 + Suspense 异步数据 【P2】

**Claude Code**（`src/screens/Doctor.tsx`）：8 个独立区块（Diagnostics/Updates/Sandbox/MCP/Keybindings/EnvVars/VersionLocks/Agents/Plugins/ContextWarnings），每块独立 fetch、独立渲染、出错不影响其他块。`Suspense + use` 比手动 `useEffect + useState` 更简洁。

**RouteDev 现状**：无诊断屏。

**借鉴方向**："环境检查"类屏按区块拆分，每块独立异步、独立错误处理。

---

### 9.10 TreeSelect 树形选择器契约 【P2】

**Claude Code**（`src/components/ui/TreeSelect.tsx`）：泛型 `TreeNode<T>` 让 value 承载业务数据，`onFocus` 回调支持预览，`isNodeExpanded` 受控展开状态，`parentPrefix` 可定制父节点前缀。

**RouteDev 现状**：文件树、agent 树、任务树各自实现。

**借鉴方向**：用同一套 TreeSelect，泛型 value 承载业务数据，onFocus 触发侧边预览。

---

## 主题 10：启动与初始化

### 10.1 快速路径参数嗅探分发 【P1】

**Claude Code**（`src/entrypoints/cli.tsx`）：`--version`、`ps`、`logs`、`kill` 等十余种命令做参数嗅探，命中后动态 import 对应 handler 并 return，完全跳过 main.tsx 加载。

**RouteDev 现状**：所有命令加载完整 CLI。

**借鉴方向**：设计极薄 bin 分发层，运维命令（`--version`、`mcp list`、`ps`、`kill`）零加载。

---

### 10.2 顶层副作用并行化启动 【P1】

**Claude Code**（`src/main.tsx` 第 1-17 行）：在所有 import 语句之前执行 `startMdmRawRead()` + `startKeychainPrefetch()`，让阻塞 IO 与 ~135ms 的模块求值并行。配合 `ensureXxxPrefetchCompleted()` 在真正需要结果时 await。

**RouteDev 现状**：启动串行。

**借鉴方向**：在入口文件顶层启动耗时 IO 子进程（配置读取、凭据刷新、Git 仓库检测、插件清单扫描），与模块求值并行。

---

### 10.3 memoized 单次初始化 + 阶段插桩 【P1】

**Claude Code**（`src/entrypoints/init.ts`）：`lodash.memoize` 包装 `init()`，每个阶段 `profileCheckpoint('init_xxx')`。

**RouteDev 现状**：app-init.ts 单一长函数。

**借鉴方向**：用 `memoize` 包装 init，每个阶段插入 profileCheckpoint，输出启动火焰图。

---

### 10.4 信任门控两阶段环境变量注入 【P1】

**Claude Code**：trust dialog 之前只调 `applySafeConfigEnvironmentVariables()`，trust 建立后才调 `applyConfigEnvironmentVariables()` 注入完整变量。遥测在 trust + 配置加载后初始化。

**RouteDev 现状**：所有 env 变量启动即注入。

**借鉴方向**：项目级配置（.routedev/settings.json）可注入 env 变量时，区分"安全变量"和"敏感变量"，后者需用户显式 trust 后才生效。

---

### 10.5 preconnect 重叠网络握手 【P1】

**Claude Code**（`src/entrypoints/init.ts`）：配置加载完后立即 `preconnectAnthropicApi()`，将 ~100-200ms 的 TCP+TLS 握手与 ~100ms 的 action-handler 工作重叠。

**RouteDev 现状**：首条消息发送时才建立连接。

**借鉴方向**：初始化末尾立即 preconnect 到 LLM API endpoint，首条用户消息发送时连接已就绪，显著降低首 token 延迟。

---

### 10.6 遥测分层延迟加载 【P1】

**Claude Code**：1P 事件日志和 GrowthBook 用 `Promise.all` + `void` fire-and-forget；OpenTelemetry（~400KB）在 `setMeterState` 内动态 import；gRPC exporters（~700KB）在 instrumentation.ts 内进一步 lazy-load。三层延迟。

**RouteDev 现状**：OtelExporter 启动期加载。

**借鉴方向**：遥测 SDK 分层延迟加载——第一层 init 末尾 fire-and-forget，第二层 trust 后 await，第三层首次上报时才加载。

---

### 10.7 早期输入捕获避免打字丢失 【P1】

**Claude Code**（`src/entrypoints/cli.tsx` 第 268-271 行）：`startCapturingEarlyInput()` 在 REPL 还没初始化之前捕获用户按键，REPL 就绪后 `seedEarlyInput()` 注入。

**RouteDev 现状**：启动期间打字丢失。

**借鉴方向**：TUI 启动若有可感知延迟（>200ms），应在加载主模块前就启动 stdin 捕获。

---

### 10.8 graceful shutdown 注册式清理链 【P0-14】

**Claude Code**：`setupGracefulShutdown()` + `registerCleanup(fn)` 注册表，各子系统（MCP 客户端、LSP server、子 Agent 进程、临时文件、Git worktree）注册自己的清理函数。SIGINT/SIGTERM/正常退出时按注册逆序执行，支持异步。

**RouteDev 现状**：用户硬约束"应用关闭时自动终止所有后台线程（无残留进程）"——直接对应。

**借鉴方向**：建立 `registerCleanup(fn)` 注册表，比散落在各处的 `process.on('exit', ...)` 更可控。

---

### 10.9 循环依赖 lazy require 模式 【P2】

**Claude Code**：`const getXxx = () => require('./xxx.js') as typeof import('./xxx.js')` thunk 打破循环依赖，配合 `as typeof import` 保留类型安全。

**RouteDev 现状**：用变量路径动态 import 绕过（不稳定）。

**借鉴方向**：出现入口模块与状态管理/工具模块循环依赖时使用。

---

## 主题 11：SDK 与外部协议

### 11.1 Hook 事件分类法 【P0-15】

**Claude Code**（`src/entrypoints/sdk/coreTypes.ts`）：27 种 HOOK_EVENTS 覆盖工具调用前后、会话生命周期、压缩、权限、子 Agent、任务、配置变更：
```
PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit,
SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged,
FileChanged
```

**RouteDev 现状**：Hook 系统已规划，PreCompact 已有 onPreCompact/offPreCompact 事件。

**借鉴方向**：参考此分类法设计完整 hook 事件体系。重点保留：`PreToolUse`/`PostToolUse`（工具调用拦截）、`UserPromptSubmit`（用户输入预处理）、`PreCompact`/`PostCompact`、`SessionStart`/`SessionEnd`、`PermissionRequest`/`PermissionDenied`。

---

### 11.2 SDK JSON-RPC 控制协议 【P2】

**Claude Code**（`src/entrypoints/sdk/controlSchemas.ts`）：`initialize`（注册 hooks + 传递配置）、`query`、`cancel`、`hook_callback`。Zod schema 定义消息格式，SDK 构建者按 schema 生成代码。

**RouteDev 现状**：无 SDK 控制协议。

**借鉴方向**：未来提供 SDK 供其他语言/进程调用时使用。

---

## 主题 12：安全与权限

### 12.1 PermissionRule 多来源 + 三行为规则 【P1】

**Claude Code**（`src/types/permissions.ts`）：8 种 source（userSettings/projectSettings/localSettings/flagSettings/policySettings/cliArg/command/session），每规则 `allow/deny/ask` 三行为，`alwaysAskRules` 中间态"明确要求询问"。

**RouteDev 现状**：SecurityChecker + ConfigGuard 已存在，但无多 source 聚合和 ask 中间态。

**借鉴方向**：团队版/企业版权限系统吸收"分层 source + 三行为规则 + 上下文感知（是否可弹窗）"模型。

---

### 12.2 PermissionAskDecision 携带 suggestions 【P1】

**Claude Code**：权限询问不是"是/否"二元，而是带**一键加白名单建议**。`PermissionUpdate` 支持 6 种操作（addRules/replaceRules/removeRules/setMode/addDirectories/removeDirectories），5 种 destination。

**RouteDev 现状**：权限对话框是/否二元。

**借鉴方向**：权限对话框加入"始终允许该工具/始终允许该工具+该路径"按钮，把建议规则写回对应 destination。

---

### 12.3 双层 stale-check 保证文件编辑原子性 【P0-16】

**Claude Code**（`src/tools/FileEditTool/FileEditTool.ts`）：`validateInput` + `call` 双层检查，写之前再检查一次，注释明确"staleness check 与 writeTextContent 之间不能 yield"。Windows mtime 误报用内容比较兜底。

**RouteDev 现状**：FileEditTool 无 stale 检测。

**借鉴方向**：吸收"validate + call 双层检查 + 临界区内不 yield + 内容兜底"完整方案，特别是 Windows 平台兼容性。

---

### 12.4 SandboxManager 多源配置去重 + 跨用户 prompt 标准化 【P1】

**Claude Code**（`src/tools/BashTool/prompt.ts`）：写入 prompt 前去重（~150-200 token/请求），per-UID 的 temp dir 字面量替换成 `$TMPDIR`，让 prompt 跨用户字节一致命中全局 prompt cache。

**RouteDev 现状**：CommandSandbox 已实现，但 prompt 含用户特定字面量。

**借鉴方向**：跨用户/跨会话的 prompt 模板剔除用户特定字面量（UID、home 路径），用环境变量占位符替代，配合 prompt cache 节省成本。

---

## 与 RouteDev 已有特性的差异

RouteDev 在以下维度**已超越或独立设计**，无需照搬 Claude Code：

- **DualLoopOrchestrator + DualLoop 探索**：Claude Code 是单 loop + verification agent，RouteDev 双循环已更先进
- **Plan Attestation + 难度路由（L1-L5）**：Claude Code 无此机制
- **CCR 可逆压缩 + CCRCache**：Claude Code 是单向 compact，RouteDev 已更先进
- **CompositionalRouter + DAG 引擎**：Claude Code 是单 Agent + fork，RouteDev 多 Agent 调度已更先进
- **CodeGraph MCP 集成**：Claude Code 无代码图谱
- **CommandSandbox**：Claude Code 的 BashTool 沙箱更复杂但 RouteDev 已有基础
- **Hook 模板迁移到 SKILL.md**：Claude Code skills 不支持 hook 模板迁移

RouteDev 可重点吸收 Claude Code 在**工具系统类型化**、**TUI 视觉语法**、**启动性能**、**遥测韧性**、**Skill 作为 prompt command**这五个维度的成熟设计。

---

## 落地路线图

### 阶段一：P0 全部落地（16 项）

按依赖顺序：
1. **基础工具系统改造**（P0-1/P0-2/P0-3/P0-16）：buildTool 工厂、ValidationResult、backfillObservableInput、stale-check
2. **Agent 协作优化**（P0-4/P0-5）：Fork prompt-cache-sharing、TodoWrite nudge
3. **命令与 Skill 系统**（P0-6/P0-7/P0-8/P0-9）：stub+load、SKILL.md frontmatter、Skill 即 PromptCommand、安全文件抽取
4. **服务层韧性**（P0-10/P0-11）：querySource-aware 重试、Analytics 队列+后挂 sink
5. **TUI 与生命周期**（P0-12/P0-13/P0-14/P0-15）：⎿ 视觉语法、Ratchet 棘轮、graceful shutdown、Hook 事件分类

### 阶段二：P1 短期可吸收（30+ 项）

按主题分批：工具系统（1.3/1.4/1.5）、Agent Loop（2.3/2.4）、命令系统（3.1/3.3/3.4/3.6）、Skills（4.2/4.4/4.5/4.6/4.7）、服务层（5.1/5.3/5.4/5.5/5.6）、可观测性（6.2/6.3/6.4）、MCP（7.1/7.2/7.3/7.5）、TUI（9.3/9.4/9.5/9.6/9.7）、启动（10.1/10.2/10.3/10.4/10.5/10.6/10.7）、安全（12.1/12.2/12.4）

### 阶段三：P2/P3 中长期（40+ 项）

按业务需求驱动选型。

---

*报告完*
