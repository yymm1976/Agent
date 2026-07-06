# Pi 开源项目深度调研报告

> **项目地址**：https://github.com/earendil-works/pi
> **官网**：https://pi.dev
> **调研日期**：2026-07-06
> **当前版本**：v0.80.3（241 releases，4831 commits）

---

## 一、项目概览

| 维度 | 数据 |
|------|------|
| Stars | 67.9k |
| Forks | 8.3k |
| 语言 | TypeScript 93.7%，JavaScript 5.6% |
| 协议 | MIT |
| 主要作者 | Mario Zechner（vegarsti / badlogicgames） |
| 组织 | earendil-works |
| 包管理 | npm workspaces monorepo |
| 构建 | tsc + biome（lint/format） |
| 测试 | vitest |

Pi 是一套 AI Agent 工具包，核心产品是一个终端编码代理（coding agent CLI）。但它不只是一个 CLI——而是一个分层架构的 Agent Harness（代理框架），从底层 LLM API 到上层交互式编码代理全覆盖。

---

## 二、Monorepo 架构（5 个包）

```
earendil-works/pi
├── packages/ai              ← 统一多 Provider LLM API
├── packages/agent           ← Agent 运行时（工具调用 + 状态管理 + 事件流）
├── packages/coding-agent    ← 交互式编码代理 CLI（核心产品）
├── packages/tui             ← 终端 UI 库（差分渲染）
└── packages/orchestrator    ← 实验性：RPC 进程编排
```

### 2.1 @earendil-works/pi-ai（统一 LLM API）

统一 30+ Provider 的 LLM 调用层：
- 订阅模式：Anthropic Claude Pro/Max、OpenAI ChatGPT Plus/Pro（Codex）、GitHub Copilot
- API Key 模式：Anthropic、OpenAI、Azure OpenAI、DeepSeek、Google Gemini/Vertex、Amazon Bedrock、Mistral、Groq、Cerebras、xAI、OpenRouter、Kimi、MiniMax、小米 MiMo 等 30+
- 支持 SSE / WebSocket 两种传输
- 模型目录自动生成（`models.generated.ts`，由脚本维护）
- 自定义 Provider 支持（通过 `~/.pi/agent/models.json`）

### 2.2 @earendil-works/pi-agent-core（Agent 运行时）

独立于编码代理的通用 Agent 框架，核心设计：

**消息流**：
```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                  (可选，裁剪/注入)                   (必需，过滤UI消息)
```

**事件流**：
```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { userMessage }
├─ message_end     { userMessage }
├─ message_start   { assistantMessage }     ← LLM 开始响应
├─ message_update  { streaming chunks }     ← 流式输出
├─ message_end     { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end        { message, toolResults }
├─ turn_start                                        ← 下一轮（工具结果触发）
├─ message_start   { assistantMessage }
├─ ...
└─ agent_end
```

**关键特性**：
- **AgentMessage vs LLM Message 分离**：AgentMessage 支持自定义消息类型（通过 declaration merging），`convertToLlm` 负责转换为 LLM 能理解的标准消息
- **工具执行模式**：`parallel`（默认，并发执行）/ `sequential`（逐个执行），支持 per-tool 覆盖
- **Steering（转向）**：工具执行期间可注入中断消息，当前 turn 的工具调用完成后生效
- **Follow-up（后续）**：Agent 完成所有工作后注入的排队消息
- **beforeToolCall / afterToolCall 钩子**：可拦截/审计/修改工具调用
- **terminate hint**：工具可返回 `terminate: true` 跳过后续 LLM 调用
- **shouldStopAfterTurn**：低级 API，在 turn 结束后决定是否停止（如上下文压缩前停止）
- **Proxy 支持**：`streamProxy` 供浏览器应用通过后端代理调用 LLM
- **低级 API**：`agentLoop()` / `agentLoopContinue()` 提供无 Agent 类的直接控制

### 2.3 @earendil-works/pi-coding-agent（核心产品）

交互式终端编码代理，4 种运行模式：

| 模式 | 用途 |
|------|------|
| Interactive（默认） | 终端交互式对话 |
| Print（`-p`） | 非交互，输出结果后退出 |
| JSON（`--mode json`） | 所有事件以 JSON Lines 输出 |
| RPC（`--mode rpc`） | stdin/stdout JSONL 协议，供非 Node.js 集成 |
| SDK | `createAgentSession()` 嵌入其他应用 |

**内置工具**（仅 4 个 + 3 个辅助）：`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`

**会话管理**：
- JSONL 树结构存储（每个 entry 有 `id` + `parentId`）
- 原地分支（`/tree` 导航到任意点继续）
- Fork（`/fork` 从历史消息创建新会话）
- Clone（`/clone` 复制当前分支）
- 自动压缩（compaction，上下文溢出时触发）
- 导入/导出/分享（HTML/JSONL/GitHub Gist）

**Provider 支持**：30+ provider，订阅 + API key 双模式

### 2.4 @earendil-works/pi-tui（终端 UI）

独立终端 UI 库，差分渲染。可用于构建自定义 TUI 应用。

### 2.5 @earendil-works/pi-orchestrator（实验性）

RPC 进程编排，允许多个 pi 实例协同工作。标注为实验性，API 不稳定。

---

## 三、核心设计哲学

Pi 的设计理念可以用一句话概括：**极简内核 + 激进扩展**。

### 3.1 六个"不做"

| 不做 | 原因 | 替代方案 |
|------|------|----------|
| **No MCP** | 认为 CLI 工具 + README 更简单 | Skills（Agent Skills 标准）或扩展添加 MCP |
| **No sub-agents** | 实现方式太多，不设标准 | tmux spawn pi 实例 / 扩展自建 / 安装包 |
| **No permission popups** | 安全边界应由环境决定 | 容器化 / 扩展自建确认流 |
| **No plan mode** | 不应强制特定工作流 | 写文件 / 扩展自建 / 安装包 |
| **No built-in to-dos** | 模型会被 to-do 列表干扰 | 用 TODO.md 文件 |
| **No background bash** | 需要可观测性和直接交互 | 用 tmux |

### 3.2 四种扩展机制

| 机制 | 类型 | 位置 | 用途 |
|------|------|------|------|
| **Extensions** | TypeScript 模块 | `~/.pi/agent/extensions/` 或 `.pi/extensions/` | 自定义工具/命令/UI/事件处理/权限/压缩/MCP/子代理 |
| **Skills** | Markdown 文件（Agent Skills 标准） | `~/.pi/agent/skills/` 或 `.agents/skills/` | 按需能力包，`/skill:name` 调用 |
| **Prompt Templates** | Markdown 文件 | `~/.pi/agent/prompts/` | 可复用提示词，`/name` 展开 |
| **Themes** | JSON 文件 | `~/.pi/agent/themes/` | 热重载主题 |

### 3.3 Pi Packages（包分发）

通过 npm 或 git 分发扩展包：
```bash
pi install npm:@foo/pi-tools          # npm 包
pi install git:github.com/user/repo   # git 仓库
pi install https://github.com/user/repo
```

`package.json` 中声明 `pi` key：
```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

---

## 四、工程实践亮点

### 4.1 供应链安全（值得借鉴）

Pi 对 npm 依赖安全极其重视：

- 直接外部依赖**精确版本锁定**（`save-exact=true`）
- `min-release-age=2`：拒绝发布不到 2 天的依赖
- `package-lock.json` 是依赖真实来源，pre-commit 阻止意外提交
- 发布的 CLI 包含 `npm-shrinkwrap.json`（从根 lockfile 生成）
- CI 使用 `npm ci --ignore-scripts`，定时运行 `npm audit`
- 依赖生命周期脚本有显式 allowlist，新脚本需审查
- 发布前 smoke test：Node + Bun 双环境，从 repo 外安装测试

### 4.2 TypeScript 严格模式

- **只用可擦除语法**（Node strip-only mode）：禁止 `enum`、`namespace`、`parameter properties`、`import =`、`export =`
- 显式字段 + 构造器赋值（不用 parameter properties）
- **禁止 inline import**（`await import()` / `import("pkg").Type`）——只用 top-level import
- biome 做 lint + format

### 4.3 Agent 自举（.pi 目录）

Pi 用自己的 agent 配置开发自己：
- `.pi/` 目录包含 agent 的工作提示词
- `AGENTS.md` 定义开发规则（给人和 agent 看）
- commit 消息格式：`{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`

### 4.4 会话分享（OSS session data）

鼓励用户分享编码 agent 会话到 Hugging Face，用于改进模型和评估：
- `badlogic/pi-share-hf` 工具发布会话
- 作者自己发布 `pi-mono` 开发会话到 `huggingface.co/datasets/badlogicgames/pi-mono`

---

## 五、与 RouteDev 的对比

| 维度 | Pi | RouteDev |
|------|-----|----------|
| **架构理念** | 极简内核 + 激进扩展 | 全功能内置 |
| **内置工具** | 4+3 个 | 20+ 个 |
| **LLM Provider** | 30+（独立 pi-ai 包） | ~5 个（内嵌） |
| **扩展机制** | 4 种（Extensions/Skills/Prompts/Themes）+ Pi Packages | 插件系统 + Skills |
| **子代理** | 不做（靠扩展/tmux） | 内置 spawn-agent + delegation |
| **权限系统** | 不做（靠容器） | PolicyEngine + sandbox |
| **Plan 模式** | 不做（靠扩展） | 内置 goal-runner + DAG |
| **会话管理** | JSONL 树结构 + 分支 | 线性 + goal 模式 |
| **运行时** | 独立 agent-core 包 | loop.ts 嵌在主代码 |
| **UI** | TUI（终端） | Electron + React（桌面） |
| **安全模型** | 容器化 / Gondolin micro-VM | sandbox + PolicyEngine |
| **上下文压缩** | 内置 compaction | ContextCompactor + stateExternalization |
| **供应链安全** | 极严格（pin/age-gate/shrinkwrap） | 标准 |

---

## 六、值得 RouteDev 借鉴的点

### 6.1 高优先级

1. **AgentMessage vs LLM Message 分离**：Pi 的 `convertToLlm` 设计允许在 Agent 层面有自定义消息类型（如 UI 通知、状态变更），只在实际调用 LLM 时转换为标准消息。RouteDev 目前消息类型与 LLM 消息耦合较紧。

2. **工具并行执行 + per-tool 模式覆盖**：Pi 默认并行执行工具（preflight → 并发执行 → 按序返回结果），同时允许每个工具指定 `executionMode: "sequential"`。RouteDev 的工具执行是串行的。

3. **Steering / Follow-up 消息队列**：Pi 允许在 Agent 工作期间排队消息——Steering 在当前 turn 工具完成后注入（中断方向），Follow-up 在 Agent 完全停止后注入。RouteDev 目前没有这种机制。

4. **会话树结构**：Pi 的 JSONL 会话用 `id`/`parentId` 实现原地分支，不需要创建新文件。RouteDev 的会话是线性的。

5. **供应链安全**：Pi 的 `save-exact` + `min-release-age=2` + shrinkwrap 策略值得 RouteDev 采用。

### 6.2 中优先级

6. **Extension 热重载**：Pi 的主题热重载 + `/reload` 命令重载扩展/技能/提示词。RouteDev 目前需要重启。

7. **Agent Skills 标准**：Pi 遵循 [agentskills.io](https://agentskills.io/) 标准，Skill 就是 Markdown 文件（`SKILL.md`），不需要代码。RouteDev 的 Skills 系统更复杂。

8. **低级 API**：Pi 提供 `agentLoop()` / `agentLoopContinue()` 无 Agent 类的直接控制，适合嵌入。RouteDev 的 loop.ts 与 Agent 状态耦合。

9. **RPC 模式**：Pi 的 `--mode rpc` 通过 stdin/stdout JSONL 协议供非 Node.js 应用集成。RouteDev 有 IPC 但绑定 Electron。

### 6.3 设计反思

10. **"不做"哲学**：Pi 明确拒绝在内核中实现 MCP/子代理/权限/Plan/To-do/后台 bash，全部交给扩展。这保持了内核极简，但也意味着开箱即用体验不如 RouteDev。两种路线各有取舍——Pi 适合深度定制用户，RouteDev 适合开箱即用。

11. **独立 agent-core 包**：Pi 的 Agent 运行时是完全独立的包，不依赖编码代理。RouteDev 可以考虑将 loop.ts + 工具系统抽成独立包，提高复用性。

12. **Pi Packages 分发**：通过 npm/git 分发扩展包的模型很成熟。RouteDev 的插件系统目前没有包分发机制。

---

## 七、技术决策分析

### 7.1 为什么 Pi 不用 MCP？

作者写了一篇博客 [What if you don't need MCP?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) 解释。核心观点：CLI 工具 + README（即 Skills）比 MCP 更简单——不需要协议、不需要 server、不需要序列化。模型直接调用 `bash` 执行 CLI 工具即可。

### 7.2 为什么 Pi 用树结构会话？

Pi 的会话是 JSONL 文件，每个 entry 有 `id` + `parentId`。这样可以：
- 原地分支（不需要新文件）
- 任意点继续（`/tree` 导航）
- 分支切换（所有历史保留）
- Fork/Clone（从任意点创建新会话）

### 7.3 为什么 Pi 禁止 inline import？

AGENTS.md 明确写："No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only."

原因：
- Node strip-only mode 只擦除类型 import，不转换动态 import
- 动态 import 在测试中难以 mock
- 静态分析友好

这与 RouteDev 大量使用动态 import 的做法相反——RouteDev 用动态 import 实现 fail-open 模式，Pi 用扩展机制替代。

---

## 八、总结

Pi 是目前最成熟的开源编码 Agent 框架之一，67.9k Stars 反映了其社区认可度。其核心价值在于：

1. **分层架构清晰**：pi-ai（LLM API）→ pi-agent-core（Agent 运行时）→ pi-coding-agent（编码代理），每层可独立使用
2. **扩展生态系统完善**：4 种扩展机制 + Pi Packages 分发，内核保持极简
3. **工程实践扎实**：供应链安全、TypeScript 严格模式、测试策略、发布流程
4. **设计哲学鲜明**：6 个"不做"明确了边界，把选择权交给用户

对 RouteDev 最有价值的借鉴是 AgentMessage 分离、工具并行执行、Steering/Follow-up 队列、会话树结构和供应链安全策略。
