# Phase 39 — 代码地图增强、Skill/Hook 自动生成与分支合并工作流

> **版本目标：** v3.1.0
> **前置依赖：** Phase 38 完成（v3.0.0）
> **新增测试要求：** ≥ 40 个
> **研究依据：** codegraph（colbymchenry/codegraph，53.6K⭐，MIT，TS/SQLite，8 MCP 工具）与 codebase-memory-mcp（DeusData/codebase-memory-mcp，12.7K⭐，MIT，纯 C 二进制，14 MCP 工具）官方 README 及文档站 codegraph.codes 实测调研；PRODUCT-INSIGHT-2026-06-24.md（市场调研与功能缺口分析）
> **核心命题：** RouteDev 的"省钱"定位已在 Phase 38 稳固，但三个用户可感知的能力缺口阻碍了从"能用"到"爱用"的跨越——(1) Agent 不懂项目结构，大项目里反复 grep 浪费大量 Token（codegraph 官方实测：VS Code 8000 文件仓库，无图 52 次调用 1m37s vs 有图 3 次调用 17s，94% 更少工具调用、82% 更快）；(2) Skill 和 Hook 配置门槛高，用户要手写 SKILL.md 和 Hook 脚本，90% 的用户不会写也不知道能干嘛；(3) 多 Agent 并行改同一代码目录容易互相覆盖，用户不敢开 auto 模式。本 Phase 以"让 AI 懂项目、让用户说规则、让变更可审查"为目标，补齐这三个缺口。
> **设计原则（桌面版优先）：** 桌面版以 UI 引导为主——按钮、菜单、对话框、侧边面板。斜杠命令仅保留给 CLI 用户和高级用户，桌面版不作为主要交互入口。

---

## 研究背景：三个能力缺口的来源

### 1. 代码地图"轻量但浅" — Agent 在大项目里迷路

**现状：** `repo-map.ts`（198 行）采用轻量正则方案，扫描 `.ts/.js/.tsx/.jsx` 文件，提取 `export` 符号和函数签名。零依赖、跨平台稳定，但能力边界明显：
- 只能识别简单 `export` 声明，无法处理多行签名、泛型、装饰器
- 没有 AST 级语义理解——知道"文件 A 导出了 foo"，不知道 foo 调用了 bar
- 没有调用关系图——无法回答"修改这个函数会影响哪些文件"
- 没有增量更新——每次全量扫描
- 和 Agent 的集成是手动的——需要 Agent 主动调用 `repo_map` 工具，而不是自动注入上下文

**行业对标（2026-06-24 实测调研）：**

| 维度 | codegraph (colbymchenry) | codebase-memory-mcp (DeusData) |
|------|--------------------------|--------------------------------|
| **Stars** | 53.6K | 12.7K |
| **语言** | TypeScript / Node.js | 纯 C（静态二进制，零依赖） |
| **解析引擎** | tree-sitter → AST → SQLite | vendored tree-sitter (158 语言) + Hybrid LSP (9 语言) |
| **支持语言** | 20+（TS/JS/Python/Go/Rust/Java/C#/Swift/Kotlin/PHP/Ruby/C/C++/Dart/Svelte/Vue/Liquid/Pascal/Lua/Luau） | 158（全量 tree-sitter）+ 9 语言深度类型解析（Python/TS/JS/PHP/C#/Go/C/C++/Java/Kotlin/Rust） |
| **MCP 工具数** | **8 个**（search/context/callers/callees/impact/node/files/status） | **14 个**（search_graph 含语义搜索/trace_path/query_graph Cypher/detect_changes/get_architecture/get_code_snippet/manage_adr 等） |
| **语义搜索** | ❌ 无（纯图遍历） | ✅ 内置 nomic-embed-code 嵌入（768维，编译进二进制，无需 API key/Ollama/Docker） |
| **语义边** | ❌ | ✅ SEMANTICALLY_RELATED（词汇不匹配）+ SIMILAR_TO（近克隆检测） |
| **跨仓库** | ❌ | ✅ CROSS_* 边链接多仓库节点 |
| **跨服务** | ❌ | ✅ HTTP 路由 ↔ 调用点匹配，gRPC/GraphQL/tRPC 检测，pub/sub 通道 |
| **实时更新** | ✅ 原生 OS 文件事件（FSEvents/inotify/ReadDirectoryChangesW）+ 2 秒 debounce | ✅ detect_changes 工具（手动触发） |
| **性能** | Swift Compiler 25874 文件 4 分钟索引 | Linux Kernel 28M LOC 75K 文件 3 分钟索引 → 481 万节点 772 万边；Cypher <1ms |
| **安装** | `npx @colbymchenry/codegraph`（交互式安装器，自动配置 Agent） | npm/curl/Scoop/Winget/Chocolatey/AUR/go install（多渠道分发） |
| **平台** | Windows / macOS / Linux | Windows / macOS / Linux |
| **安全认证** | MIT | MIT + SLSA 3 + VirusTotal 扫描 |
| **学术** | 无 | arXiv 2603.27277 论文 |
| **支持 Agent** | Claude Code/Cursor/Codex/OpenCode/Hermes/Gemini/Antigravity/Kiro (8) | Claude Code/Codex/Gemini CLI/Zed/OpenCode/Antigravity/Aider/KiloCode/VS Code/OpenClaw/Kiro (11) |

**关键实测数据（codegraph 官方基准）：**

| 代码库 | 有 CodeGraph | 无 CodeGraph | 提升 |
|--------|-------------|-------------|------|
| VS Code (TypeScript) | 3 调用 · 17s | 52 调用 · 1m37s | 94% 更少 · 82% 更快 |
| Excalidraw (TypeScript) | 3 调用 · 29s | 47 调用 · 1m45s | 94% 更少 · 72% 更快 |
| Claude Code (Python+Rust) | 3 调用 · 39s | 40 调用 · 1m8s | 93% 更少 · 43% 更快 |
| Alamofire (Swift) | 3 调用 · 22s | 32 调用 · 1m39s | 91% 更少 · 78% 更快 |
| Swift Compiler (25874 文件) | 6 调用 · 35s | 37 调用 · 2m8s | 84% 更少 · 73% 更快 |

**codebase-memory-mcp 的 Token 对比：** 5 个结构性查询，无图 ~412K tokens vs 有图 ~3.4K tokens，**约 120 倍差距**——直接命中 RouteDev"省钱"的核心定位。

**类比：** 现在的 RouteDev Agent 像一个新员工第一天上班，没有项目文档，只能一个个文件翻。codegraph/codebase-memory-mcp 像给这个新员工一份带目录、索引、交叉引用的完整项目手册——翻一下就知道东西在哪。

### 2. Skill/Hook 配置"程序员专属" — 普通用户用不起来

**现状：** RouteDev 已有完整的 Skill 格式（`.routedev/skills/<name>/SKILL.md`）和 HookRunner 生命周期钩子系统（8 种事件、优先级排序、异常隔离）。但：
- Skill 要用户手写 Markdown frontmatter + 规则正文，90% 的用户不会写
- Hook 要用户手写 TypeScript handler 函数，95% 的用户不会写
- 内置 Hook 只有 3 个（文件验证、会话日志），缺少工程化常用模板（自动格式化、commit 前测试、敏感信息检测等）
- 没有可视化配置界面——Settings 页面没有 Hook 管理入口
- **命令式交互门槛高**——桌面版用户不习惯敲斜杠命令，需要 UI 引导

**行业趋势：** 2026 年 Skill 正在标准化——Anthropic 的 `.claude/skills/`、OpenAI Codex 的 Skills、Cursor Rules 都在向统一格式收敛。但所有工具的 Skill 创建方式都是"手写文件"——没有一个工具做到"用户说规则，AI 自动生成配置"。

### 3. 多 Agent 改代码"黑盒不可控" — 用户不敢放手

**现状：** RouteDev 有完整的多 Agent 框架（Orchestrator + WorkerExecutor + Blackboard + ConflictDetector），但所有 Worker 在同一个工作目录操作，共享同一份代码。问题：
- Worker A 改了 `auth.ts`，Worker B 也在改 `auth.ts` → 冲突
- 用户看不到每个 Worker 改了什么 → 不敢开 auto 模式
- 一个 Worker 搞砸了可能影响其他 Worker → 不可靠
- 想撤销某个 Worker 的改动 → 分不清谁改了什么

`ExperimentManager`（Phase 37）已经实现了基于 Git Worktree 的实验分支管理（create/run/compare/adopt/discard），但：
- `runInExperiment()` 只是记录任务描述，实际执行未接入 Agent Loop
- 没有"主对话审查分支变更"的 UX
- adopt 是全量合并（`git merge --no-ff`），不支持选择性合并
- 没有和 `/goal` 工作流集成
- **没有桌面端 UI**——只有命令行接口

**用户需求（核心澄清）：** 用户要的不是"多个 Agent 并行干活"，而是 **git 式的"分支编辑 → 主对话审查 → 选择性合并"工作流**——像 git feature branch 一样，每个子任务在自己的分支上编辑代码，主对话作为"集成者"审查 diff，决定采纳/拒绝/要求重做。这比单纯子 Agent 更可控、更可靠：
- **隔离性**：每个子任务在自己的 worktree/分支，物理隔离，不可能互相覆盖
- **可控性**：用户审查每个分支的 diff，选择采纳
- **可靠性**：搞砸的分支直接 discard，不影响主线
- **透明度**：每个分支改了什么一目了然

---

## Task 1：代码地图增强 — 双轨制架构（≥ 12 测试）

### 1.1 问题定义

当前 `repo-map.ts` 的轻量正则方案在大项目中力不从心。直接引入 codegraph 或 codebase-memory-mcp 作为外部 MCP 依赖是最快路径，但需要考虑：
- RouteDev 的零依赖、Windows 原生、离线可用原则
- 不同用户项目规模差异巨大（100 文件 vs 10 万文件）
- 已有的 `repo_map` 工具和 KnowledgeGraph 不应被废弃

### 1.2 设计方向：双轨制

**核心决策：** 不重写 `repo-map.ts`，而是采用"内置轻量 + 外接增强"双轨制。

```
┌─────────────────────────────────────────────────────┐
│                   Agent 上下文                        │
│                                                      │
│  ┌─────────────┐    ┌──────────────────────────┐    │
│  │ 内置 Repo Map │    │ 外接 CodeGraph MCP       │    │
│  │ (正则, 零依赖) │    │ (tree-sitter + SQLite)   │    │
│  │              │    │                          │    │
│  │ • 默认启用    │    │ • 用户可选安装            │    │
│  │ • 小项目够用  │    │ • 大项目必需              │    │
│  │ • 秒级扫描    │    │ • 首次索引慢, 后续秒查    │    │
│  │ • 无调用关系  │    │ • 完整调用图 + 影响分析   │    │
│  │              │    │ • 实时文件监听自动更新    │    │
│  └──────┬──────┘    └────────┬─────────────────┘    │
│         │                    │                       │
│         └────────┬───────────┘                       │
│                  ▼                                    │
│         ┌────────────────┐                           │
│         │ ContextInjector │                           │
│         │ (自动注入上下文) │                           │
│         └────────────────┘                           │
└─────────────────────────────────────────────────────┘
```

### 1.3 轨道 A：内置 Repo Map 增强（保持零依赖）

在现有 `repo-map.ts` 基础上增强，不引入 tree-sitter 依赖：

**1.3.1 增强符号提取**

当前 `extractSignatures()` 只匹配 `export` 声明。增强为：
- 识别非导出函数声明（`function foo()`、`const foo = () =>`）
- 识别类成员方法（`class Foo { bar() {} }`）
- 识别 import 依赖（`import { foo } from './bar'`）→ 构建文件级依赖图
- 识别装饰器（`@Component`、`@Route`）→ 标注在符号上
- 多语言扩展：增加 `.py`（`def`/`class`/`import`）、`.java`（`public`/`private`）、`.go`（`func`/`type`）的正则规则

**1.3.2 文件级依赖图**

```typescript
// 新增：文件级依赖关系
export interface FileDependency {
  /** 依赖的文件相对路径 */
  target: string;
  /** 导入的符号列表 */
  symbols: string[];
}

export interface RepoMapFileEntry {
  path: string;
  exports: string[];
  signatures: string[];
  /** 新增：该文件依赖的其他文件 */
  dependencies?: FileDependency[];
  /** 新增：文件类型（用于多语言支持） */
  language?: string;
}
```

**1.3.3 增量更新与缓存**

```
缓存路径：.routedev/repo-map-cache.json

策略：
  1. 首次扫描：全量构建，写入缓存（含文件 mtime）
  2. 后续扫描：比对 mtime，只重新解析变更的文件
  3. 文件删除：从缓存中移除
  4. 大项目（>500 文件）：首次扫描显示进度提示
```

**1.3.4 影响分析（基于依赖图）**

```typescript
/**
 * 分析修改某个文件/符号的影响范围
 * 基于文件级依赖图做反向 BFS
 */
export function analyzeImpact(
  entries: RepoMapFileEntry[],
  targetFile: string,
): { affectedFiles: string[]; depth: number } {
  // 构建反向依赖图：被依赖文件 → 依赖它的文件列表
  // 从 targetFile 出发做 BFS，收集所有间接依赖者
}
```

### 1.4 轨道 B：外接 CodeGraph MCP 集成

**1.4.1 选择策略**

| 维度 | codegraph | codebase-memory-mcp | RouteDev 选择 |
|------|-----------|---------------------|--------------|
| 语言 | TypeScript | C（静态二进制） | **codegraph**（同栈，npm 安装无编译） |
| MCP 工具数 | 8 个（精简） | 14 个（丰富） | **codegraph**（8 个工具不会撑爆 system prompt，契合省钱定位） |
| 实时更新 | ✅ OS 文件事件自动增量 | ⚠️ 手动 detect_changes | **codegraph**（零配置始终新鲜） |
| 语义搜索 | ❌ | ✅ nomic-embed-code | codebase-memory-mcp 更强 |
| 跨仓库/跨服务 | ❌ | ✅ | codebase-memory-mcp 更强 |
| 安装 | `npx @colbymchenry/codegraph` | npm/scoop/winget 多渠道 | codegraph 更简单（一行命令+交互式配置） |
| Stars/生态 | 53.6K | 12.7K | codegraph 社区更大 |
| Windows | ✅ 原生支持 | ✅ 原生支持 | 两者均可 |

**选择 codegraph 作为默认外接方案的理由：**
- **TypeScript 同栈**：与 RouteDev 同技术栈，npm 安装无需编译 C 代码，Windows 友好
- **8 个精简 MCP 工具**：search/context/callers/callees/impact/node/files/status——刚好覆盖 RouteDev 需要的"符号搜索、调用关系、影响分析"核心能力，不会像 14 个工具那样增加 system prompt 负担
- **实时文件监听**：原生 OS 文件事件（FSEvents/inotify/ReadDirectoryChangesW）+ 2 秒 debounce，零配置始终新鲜——codebase-memory-mcp 需要手动调用 detect_changes
- **交互式安装器**：`npx @colbymchenry/codegraph` 自动检测并配置 Agent 的 MCP 连接，RouteDev 可以借鉴这个体验
- **53.6K stars**：社区生态更大，长期维护风险更低

**codebase-memory-mcp 作为高级用户可选替代：**
- 在 Settings > Advanced 中提供选项，允许用户切换到 codebase-memory-mcp
- 适用场景：超大型项目（>10 万文件）、需要语义搜索（"找到所有做类似事情的函数"）、跨仓库分析、微服务架构（HTTP/gRPC 路由追踪）

**1.4.2 集成方式**

codegraph 本身是一个 MCP Server，RouteDev 已有 MCP 客户端（`src/tools/mcp/client.ts`）。集成方式：

```yaml
# config.yaml 新增 codegraph 配置
codegraph:
  enabled: false  # 默认关闭，用户显式启用
  workspace: "."  # 工作区路径
  autoIndex: true # 启动时自动索引（如果 .codegraph/ 不存在）
```

**1.4.3 桌面端 UI 引导（非命令式）**

codegraph 的集成完全通过 UI 引导，不需要用户敲命令：

```
场景 1：首次打开大项目时主动引导
  ┌──────────────────────────────────────────────────┐
  │  💡 检测到您的项目有 1,200 个代码文件              │
  │                                                   │
  │  启用 CodeGraph 代码知识图谱可以：                 │
  │  • 减少 90%+ 的代码检索 Token 消耗                │
  │  • 让 AI 立即知道项目结构和函数调用关系            │
  │  • 修改代码时自动分析影响范围                      │
  │                                                   │
  │  [立即启用]  [稍后]  [不再提示]                    │
  └──────────────────────────────────────────────────┘

场景 2：Settings > 代码地图 页面
  ┌──────────────────────────────────────────────────┐
  │  代码地图                                          │
  │                                                   │
  │  内置代码地图（轻量正则）                          │
  │  ● 已启用  ○ 已禁用                                │
  │  适合小项目，零依赖，秒级扫描                       │
  │                                                   │
  │  CodeGraph 增强引擎（tree-sitter + SQLite）        │
  │  ○ 已启用  ● 已禁用  [安装 CodeGraph]              │
  │  适合大项目，完整调用图 + 影响分析 + 实时更新       │
  │  支持 20+ 语言                                     │
  │                                                   │
  │  索引状态：未索引  [开始索引]                       │
  │  上次更新：—                                       │
  │  索引文件数：—                                     │
  │                                                   │
  │  高级：codebase-memory-mcp 替代方案 [了解详情]      │
  └──────────────────────────────────────────────────┘
```

**1.4.4 自动检测与引导逻辑**

```
启动时检测：
  1. 检查 .codegraph/ 目录是否存在且有效
  2. 如果存在 → 自动连接 codegraph MCP Server，注册 8 个工具
  3. 如果不存在但 config.codegraph.enabled = true → 后台自动运行 `npx @colbymchenry/codegraph` 初始化
  4. 如果用户项目 > 500 文件且 codegraph 未启用 → 在桌面端弹出引导卡片（如上场景 1）
  5. CLI 模式下，打印建议信息（不弹窗）
```

**1.4.5 与内置 Repo Map 的协同**

```
Agent 上下文注入逻辑：
  1. 如果 codegraph 可用 → 优先使用 codegraph 的工具（更精确）
  2. 如果 codegraph 不可用 → 回退到内置 repo_map（正则方案）
  3. 内置 repo_map 始终作为"快速概览"工具保留（codegraph 不提供"项目结构概览"功能）
```

### 1.5 ContextInjector：自动注入代码地图上下文

**核心改动：** 让 Agent 不用手动调用 `repo_map` 工具就能感知代码地图。

**1.5.1 注入时机**

```
注入点 1：会话启动时
  - 扫描项目生成 repo map 摘要（前 50 个文件的符号列表）
  - 注入到 system prompt 的"项目结构"段落
  - Token 预算：≤ 2000 tokens

注入点 2：用户消息处理时
  - 从用户消息提取关键词
  - 在 repo map / KnowledgeGraph 中召回相关文件
  - 将最相关的 5-10 个文件符号注入到 user message 前缀
  - Token 预算：≤ 1000 tokens

注入点 3：/goal 分解时
  - 自动扫描项目结构，让 GoalParser 知道"项目有哪些模块"
  - 分解出的步骤可以引用具体文件路径
```

**1.5.2 实现：作为 onSystemPrompt 中间件**

利用 Phase 38 激活的中间件管道，新增 `CodeMapContextMiddleware`：

```typescript
// 注册到 onSystemPrompt 阶段
// 在 system prompt 构建前，注入代码地图摘要
class CodeMapContextMiddleware {
  onSystemPrompt(context: MiddlewareContext): MiddlewareResult {
    const repoMapSummary = this.getRepoMapSummary();
    const relatedFiles = this.findRelatedFiles(context.userQuery);
    
    return {
      action: 'modify',
      systemPromptAppendix: this.formatContextBlock(repoMapSummary, relatedFiles),
    };
  }
}
```

### 1.6 思考引导

- codegraph 的 8 个 MCP 工具是否全部暴露给 Agent？还是只暴露核心的 search/context/impact 三个？（工具定义本身也消耗 system prompt token，8 个工具约 500-800 tokens。建议全部暴露——codegraph 官方设计就是 8 个精简工具，已经做过优化）
- 增量缓存的 mtime 比对在 Windows 上是否可靠？（Windows NTFS 的 mtime 精度是 100ns，足够。但跨时区的 git checkout 可能导致 mtime 混乱）
- 影响分析 `analyzeImpact()` 的深度限制？（BFS 深度 3 层？全量？对于 import 链很深的项目，全量 BFS 可能返回整个项目）
- ContextInjector 注入的文件列表是否需要去重？（如果用户消息关键词匹配到 20 个文件，但 Token 预算只够 10 个，怎么排序和截断？按 PPR 分数？按文件大小？按最近修改时间？）
- codegraph 的 SQLite 索引文件（`.codegraph/`）是否应该加入 `.gitignore`？（应该。codegraph init 时会自动处理。RouteDev 的 `ensureGitignore()` 逻辑可以参考）
- codebase-memory-mcp 作为高级替代方案时，其 14 个工具是否需要做筛选？（可能只需要 search_graph/trace_path/get_architecture 三个核心工具，避免 prompt 膨胀）

---

## Task 2：Skill/Hook AI 自动生成（≥ 10 测试）

### 2.1 问题定义

RouteDev 有完整的 Skill 格式和 HookRunner，但创建方式是"程序员手写文件"。90% 的用户不会写 SKILL.md，95% 的用户不会写 Hook handler 函数。需要让用户用自然语言描述需求，AI 自动生成配置文件并注册。

**桌面版设计原则：** 所有操作通过 Settings 页面的 UI 完成，不依赖斜杠命令。CLI 命令仅作为高级用户的快捷方式保留。

### 2.2 桌面端 UI 设计（主要交互入口）

**2.2.1 Settings > Skills 标签页**

```
┌──────────────────────────────────────────────────────┐
│  Skills                                              │
│                                                      │
│  [+ 创建新 Skill]    [从代码学习]                     │
│                                                      │
│  已安装的 Skill：                                     │
│  ┌────────────────────────────────────────────────┐  │
│  │ 📝 极简编码优先级                    [启用 ●]  │  │
│  │ 当准备编写新代码时，优先考虑...                  │  │
│  │                                    [编辑] [删除] │  │
│  ├────────────────────────────────────────────────┤  │
│  │ 🇨🇳 中文注释规范                    [启用 ●]  │  │
│  │ 所有代码注释使用中文，简洁但...                  │  │
│  │                                    [编辑] [删除] │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**点击"创建新 Skill" → 弹出对话框：**

```
┌──────────────────────────────────────────────────────┐
│  创建新 Skill                                         │
│                                                      │
│  描述你的编码规范或工作流，AI 会自动生成 Skill 配置：   │
│  ┌────────────────────────────────────────────────┐  │
│  │ 我们项目要求：中文注释、先写测试再写代码、        │  │
│  │ 函数不超过30行、所有API接口要做输入校验...       │  │
│  │                                                  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [生成 Skill]                                         │
└──────────────────────────────────────────────────────┘
```

**AI 生成后展示确认界面：**

```
┌──────────────────────────────────────────────────────┐
│  确认 Skill 配置                                      │
│                                                      │
│  AI 根据你的描述生成了以下 Skill：                     │
│                                                      │
│  名称：项目编码规范                                    │
│  关键词：编码, 规范, 注释, 测试, 校验                  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ # 项目编码规范                                   │  │
│  │                                                  │  │
│  │ ## 注释                                          │  │
│  │ - 所有代码注释使用中文                            │  │
│  │ - 简洁但不可省略                                  │  │
│  │                                                  │  │
│  │ ## 测试                                          │  │
│  │ - 先写测试再写代码（TDD）                         │  │
│  │                                                  │  │
│  │ ## 函数                                          │  │
│  │ - 函数体不超过30行                                │  │
│  │ - 所有API接口做输入校验                           │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [保存并启用]  [编辑内容]  [重新描述]                   │
└──────────────────────────────────────────────────────┘
```

**点击"从代码学习" → 自动分析流程：**

```
┌──────────────────────────────────────────────────────┐
│  从代码学习                                           │
│                                                      │
│  正在分析项目代码...                                   │
│  ████████████████████████░░░░ 80%                    │
│                                                      │
│  已检测到：                                           │
│  ✓ 注释语言：中文                                     │
│  ✓ 引号习惯：单引号                                   │
│  ✓ 缩进风格：2 空格                                   │
│  ✓ 命名规范：camelCase                                │
│  ✓ 测试框架：Vitest                                   │
│  ⏳ 正在提取常用工具函数...                            │
└──────────────────────────────────────────────────────┘
```

**2.2.2 Settings > Hooks 标签页**

```
┌──────────────────────────────────────────────────────┐
│  Hooks                                               │
│                                                      │
│  [+ 创建新 Hook]                                      │
│                                                      │
│  模板库（一键启用）：                                   │
│  ┌────────────────────────────────────────────────┐  │
│  │ ✨ 自动格式化              [启用 ○]             │  │
│  │ 保存文件后自动运行 prettier/eslint --fix        │  │
│  ├────────────────────────────────────────────────┤  │
│  │ 🧪 提交前测试              [启用 ●]             │  │
│  │ commit 前自动跑测试，失败则阻止提交              │  │
│  ├────────────────────────────────────────────────┤  │
│  │ 🔒 敏感信息检测            [启用 ●]             │  │
│  │ 检测 apiKey=/password= 等敏感信息并警告          │  │
│  ├────────────────────────────────────────────────┤  │
│  │ 🚫 危险命令确认            [启用 ○]             │  │
│  │ rm -rf/format/git push --force 额外确认         │  │
│  ├────────────────────────────────────────────────┤  │
│  │ 📝 自动中文注释            [启用 ○]             │  │
│  │ 检测新增函数无注释自动补中文注释                  │  │
│  ├────────────────────────────────────────────────┤  │
│  │ ... 更多模板                                     │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  自定义 Hook：                                        │
│  ┌────────────────────────────────────────────────┐  │
│  │ 📋 commit信息生成          [启用 ●]             │  │
│  │ 触发：pre-step | 作用：自动生成语义化commit      │  │
│  │                                    [编辑] [删除] │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**点击"创建新 Hook" → 弹出对话框：**

```
┌──────────────────────────────────────────────────────┐
│  创建新 Hook                                          │
│                                                      │
│  描述你想要的自动化规则，AI 会自动生成 Hook 配置：      │
│  ┌────────────────────────────────────────────────┐  │
│  │ 每次保存TypeScript文件后自动跑类型检查，         │  │
│  │ 如果有类型错误就警告我                           │  │
│  │                                                  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [生成 Hook]                                          │
└──────────────────────────────────────────────────────┘
```

**AI 生成后展示确认界面（含安全审查）：**

```
┌──────────────────────────────────────────────────────┐
│  确认 Hook 配置                                       │
│                                                      │
│  AI 根据你的描述生成了以下 Hook：                      │
│                                                      │
│  名称：TypeScript 类型检查                             │
│  触发时机：文件保存后（post-tool-call: file_write）    │
│  触发条件：.ts / .tsx 文件                             │
│  执行命令：tsc --noEmit {{filePath}}                  │
│  失败行为：在对话中显示类型错误警告                     │
│                                                      │
│  ⚠️ 安全审查：命令安全，未检测到危险操作               │
│                                                      │
│  [保存并启用]  [编辑配置]  [重新描述]                   │
└──────────────────────────────────────────────────────┘
```

### 2.3 Skill 自动生成器

**2.3.1 生成流程**

```
步骤 1：理解需求
  - 用户在 UI 对话框输入自然语言描述
  - 调用轻量模型（分类等级 simple）解析需求
  - 输出：结构化的规则列表

步骤 2：生成 SKILL.md 草稿
  - 根据规则列表生成 Markdown frontmatter + 规则正文
  - 格式兼容 Anthropic SKILL.md 标准
  - 自动提取 keywords（用于触发匹配）

步骤 3：用户确认（UI 确认界面）
  - 在对话框中展示生成的 SKILL.md 内容
  - 用户可以：保存并启用 / 编辑内容 / 重新描述
  - 确认后保存到 .routedev/skills/<skill-name>/SKILL.md

步骤 4：自动注册
  - PromptManager 自动加载新 Skill
  - 在当前会话立即生效（注入到 system prompt）
  - Settings > Skills 页面刷新列表
```

**2.3.2 从现有代码自动学习**

```
触发方式：Settings > Skills > [从代码学习] 按钮

流程：
  1. 扫描 src/ 下的代码文件（复用 repo-map 的 walkDir）
  2. 提取特征：
     - 注释语言（中文/英文/混合）→ 检测注释行的字符集
     - 引号习惯（单引号/双引号）→ 统计出现频率
     - 缩进风格（2/4 空格/tab）→ 检测行首空白
     - 命名规范（camelCase/snake_case/kebab-case）→ 检测变量名模式
     - 常用工具函数 → 识别被多次 import 的内部模块
     - 错误处理方式 → 检测 try-catch / Promise.catch / Result 类型
     - 测试框架 → 检测 package.json devDependencies
  3. 在 UI 中展示分析进度和检测结果
  4. 生成 Skill 初稿
  5. 用户确认后保存
```

### 2.4 Hook 自动生成器

**2.4.1 生成流程**

```
步骤 1：理解需求
  - 用户在 UI 对话框输入自然语言描述
  - AI 判断需要哪个生命周期事件：
    "保存后格式化" → post-tool-call (file_write)
    "commit前跑测试" → pre-step (特定条件)
    "检测敏感信息" → post-tool-call (file_write/file_edit)
    "会话开始时通知" → on-session-start

步骤 2：模板匹配优先
  - 先在预置模板库中做关键词匹配
  - 匹配成功 → 直接使用模板（零 LLM 调用，省钱）
  - 匹配失败 → 调用 LLM 生成自定义 Hook 配置

步骤 3：安全审查
  - 对生成的 shell 命令做黑名单检查
  - 检测 rm -rf / format / del 等危险命令
  - 在确认界面显示安全审查结果

步骤 4：用户确认（UI 确认界面）
  - 展示生成的 Hook 配置
  - 解释触发时机和作用
  - 显示安全审查结果
  - 用户确认后保存到 .routedev/hooks/<name>.json

步骤 5：自动注册
  - HookRunner 动态注册新 Hook
  - 立即生效（不需要重启）
  - Settings > Hooks 页面刷新列表
```

### 2.5 预置 Hook 模板库

内置 10 个常用 Hook 模板，用户在 Settings > Hooks 页面一键启用：

| # | 名称 | 触发时机 | 作用 | 模板匹配关键词 |
|---|------|---------|------|--------------|
| 1 | auto-format | post-tool-call (file_write) | 保存后自动跑 prettier/eslint --fix | "格式化"/"format"/"prettier" |
| 2 | pre-commit-test | pre-step | commit 前自动跑测试，失败阻止 | "commit前"/"提交前"/"测试" |
| 3 | secret-detect | post-tool-call (file_write/file_edit) | 检测 apiKey=/password=/token= 等敏感信息 | "敏感"/"secret"/"密钥"/"泄露" |
| 4 | no-console | post-tool-call (file_write) | 检测新增 console.log 并警告 | "console"/"调试输出" |
| 5 | import-check | post-tool-call (file_write) | 检测未使用的 import | "import"/"未使用" |
| 6 | type-check | post-tool-call (file_write) | 改完 .ts 文件后跑 tsc --noEmit | "类型检查"/"typecheck"/"tsc" |
| 7 | danger-cmd-confirm | pre-tool-call (shell_exec) | rm -rf/format/git push --force 额外确认 | "危险命令"/"确认" |
| 8 | auto-comment | post-tool-call (file_write) | 检测新增函数无注释自动补中文注释 | "注释"/"comment" |
| 9 | session-notify | on-session-end | 会话结束时桌面通知 | "通知"/"notify" |
| 10 | token-alert | on-model-call | 单次 LLM 调用超预算时警告 | "预算"/"token"/"超限" |

**模板格式：** 每个 Hook 模板是一个 JSON 文件，放在 `src/hooks/templates/` 目录。用户通过 UI 创建 Hook 时，先尝试关键词匹配模板，匹配成功则直接使用模板（零 LLM 调用），匹配失败才调用 LLM 生成自定义 Hook。

### 2.6 CLI 命令（高级用户保留）

以下命令仅保留给 CLI 用户和高级用户，桌面版不作为主要入口：

```
/skill create [描述]       ← CLI 快捷创建
/skill list                ← CLI 列表查看
/skill enable <name>       ← CLI 启用
/skill disable <name>      ← CLI 禁用
/hook create [描述]        ← CLI 快捷创建
/hook list                 ← CLI 列表查看
/hook enable <name>        ← CLI 启用
/hook disable <name>       ← CLI 禁用
```

### 2.7 思考引导

- Skill 自动生成时，如何避免生成过于宽泛或矛盾的规则？（如用户说"代码要简洁"但没说具体标准——AI 应该追问还是自行设定默认值？）
- 从现有代码自动学习时，如果项目代码风格不统一（部分文件用单引号、部分用双引号），怎么处理？（取众数？还是标注"风格不统一，建议统一为 X"？）
- Hook 模板的关键词匹配应该多精确？（"格式化"匹配 auto-format，但"格式化输出"不应该匹配——需要上下文理解还是简单关键词就够？）
- 自定义 Hook 生成的 shell 命令是否需要安全审查？（`prettier --write {{filePath}}` 是安全的，但如果 AI 生成了 `rm -rf {{filePath}}` 呢？需要命令黑名单检查——已在流程步骤 3 中加入）
- Skill 和 Hook 的关系——一个 Skill 能否触发 Hook 的创建？（如 Skill "TDD 开发"可以自动创建"改完跑测试"的 Hook。但这增加了复杂度，是否值得？）

---

## Task 3：分支编辑-审查-合并工作流（≥ 12 测试）

### 3.1 问题定义

用户要的不是"多个 Agent 并行干活"，而是 **git 式的"分支编辑 → 主对话审查 → 选择性合并"工作流**。RouteDev 已有 `ExperimentManager`（Git Worktree 管理）和 `BranchManager`（对话分支），但两者没有打通，且 `ExperimentManager.runInExperiment()` 只是记录任务，未接入 Agent Loop。

**桌面版设计原则：** 分支创建、审查、采纳/丢弃全部通过 ChatPage 的 UI 面板完成。`/experiment` 系列命令仅保留给 CLI 用户。

### 3.2 架构梳理

**核心概念：**

```
主工作区（main workspace）
  │
  ├── 主对话（Main Conversation）
  │     │
  │     ├── 用户下达任务："实现登录功能"
  │     │
  │     ├── 主 Agent 分解任务：
  │     │     ├── 子任务 A：后端 API → 创建分支 branch-A
  │     │     ├── 子任务 B：数据库模型 → 创建分支 branch-B
  │     │     └── 子任务 C：前端页面 → 创建分支 branch-C
  │     │
  │     ├── 各子任务在独立 worktree 中执行（物理隔离）
  │     │
  │     ├── 桌面端右侧"分支面板"自动展示进度：
  │     │     ┌──────────────────────────────────────┐
  │     │     │ 📋 分支任务                            │
  │     │     │                                       │
  │     │     │ ✅ 后端 API          [审查]           │
  │     │     │    src/api/auth.ts (+45 -3)           │
  │     │     │                                       │
  │     │     │ ✅ 数据库模型        [审查]           │
  │     │     │    src/db/user.sql (+12 -0)           │
  │     │     │                                       │
  │     │     │ ⚠️ 前端页面          [审查]           │
  │     │     │    src/pages/login.tsx (+78 -10)     │
  │     │     │    测试失败：3 个用例未通过            │
  │     │     └──────────────────────────────────────┘
  │     │
  │     ├── 用户点击[审查] → 弹出 Diff 审查模态框：
  │     │     ┌──────────────────────────────────────┐
  │     │     │ 审查：后端 API                        │
  │     │     │                                       │
  │     │     │ ┌─────────────┬─────────────┐        │
  │     │     │ │  原始代码    │  修改后代码  │        │
  │     │     │ │              │              │        │
  │     │     │ │ - import...  │ + import...  │        │
  │     │     │ │              │ + function   │        │
  │     │     │ │              │ +   login()  │        │
  │     │     │ └─────────────┴─────────────┘        │
  │     │     │                                       │
  │     │     │ 变更文件：                            │
  │     │     │ ☑ src/api/auth.ts (+45 -3)           │
  │     │     │ ☑ src/api/auth.test.ts (+28 -0)      │
  │     │     │                                       │
  │     │     │ [采纳选中文件]  [全部采纳]            │
  │     │     │ [要求重做]     [丢弃]                 │
  │     │     └──────────────────────────────────────┘
  │     │
  │     ├── 用户操作后：
  │     │     ├── 采纳 A、B → git merge 到主分支
  │     │     ├── C 要求重做 → 在 branch-C 的 worktree 中重新执行
  │     │     └── 或丢弃 C → git worktree remove + branch -D
  │     │
  │     └── 合并后继续主对话
  │
  └── .routedev/experiments/
        ├── exp-001/ (worktree for branch-A)
        ├── exp-002/ (worktree for branch-B)
        └── exp-003/ (worktree for branch-C)
```

**与现有模块的关系：**

| 模块 | 职责 | 本 Task 改动 |
|------|------|-------------|
| `ExperimentManager` | Git Worktree 创建/删除/采纳/丢弃 | 增强：接入 Agent Loop 执行、选择性合并 |
| `BranchManager` | 对话分支管理（内存中的消息树） | 不改动（对话分支和代码分支是两个概念） |
| `Orchestrator` | 多 Agent 任务分解和依赖分析 | 增强：分解时为每个子任务创建实验分支 |
| `WorkerExecutor` | 单步骤执行 | 增强：在指定 worktree 中执行 |
| `CheckpointManager` | Git 检查点和回滚 | 不改动（检查点针对主工作区） |
| `ConflictDetector` | 文件访问冲突检测 | 增强：基于分支的冲突检测（不同分支改同一文件） |

### 3.3 设计方向

**3.3.1 ExperimentManager 增强：接入 Agent Loop**

当前 `runInExperiment()` 只是记录任务描述。改为真正在 worktree 中执行 Agent 任务：

```typescript
/**
 * 在实验分支的 worktree 中执行 Agent 任务
 * 
 * 执行流程：
 *   1. 在 worktreePath 中创建独立的 Agent Loop 实例
 *   2. Agent 的 workingDirectory 设置为 worktreePath
 *   3. Agent 在 worktree 中读写文件、执行命令
 *   4. 完成后返回执行结果和变更文件列表
 *   5. 主工作区不受影响
 */
async runInExperiment(
  expId: string,
  task: string,
  options?: {
    agentType?: 'general' | 'coder';  // 子 Agent 类型
    maxIterations?: number;            // 最大迭代次数
    onProgress?: (progress: TaskProgress) => void;  // 进度回调
  },
): Promise<ExperimentRunResult>
```

**ExperimentRunResult：**
```typescript
interface ExperimentRunResult {
  success: boolean;
  result: string;              // Agent 执行摘要
  tokenUsage?: number;
  modifiedFiles: string[];     // 变更文件列表（相对路径）
  error?: string;
}
```

**关键设计决策：worktree 中的 Agent 隔离**

```
worktree 中的 Agent 实例：
  1. workingDirectory = worktreePath（不是主工作区）
  2. allowedDirectories = [worktreePath]（不能访问主工作区）
  3. ToolRegistry 是主 Agent 的子集（移除 spawn_agent、experiment 等工具）
  4. 独立的 ContextManager（不继承主对话历史）
  5. 独立的 TokenTracker（但汇总到主会话的 Token 统计）
  6. 共享 LLM 客户端和模型路由（复用连接池）
  7. 继承主 Agent 的 Skill（编码规范是项目级的）
  8. 不继承主对话历史（上下文隔离）
```

**3.3.2 选择性合并（Selective Merge）**

当前 `adoptExperiment()` 是全量 `git merge --no-ff`。增强为支持选择性合并：

```typescript
/**
 * 选择性采纳实验变更
 * 
 * @param expId 实验 ID
 * @param options.fileFilter 只采纳指定文件（不传则全量合并）
 * @param options.strategy 合并策略
 */
async adoptExperiment(
  expId: string,
  options?: {
    fileFilter?: string[];      // 只合并这些文件（相对路径）
    strategy?: 'merge' | 'cherry-pick';  // merge = git merge, cherry-pick = 逐文件 checkout
  },
): Promise<AdoptResult>
```

**两种合并策略：**

```
策略 1：merge（默认，全量合并）
  git merge --no-ff <branch>
  → 适用于：采纳整个分支的所有变更

策略 2：cherry-pick（选择性合并）
  对 fileFilter 中的每个文件：
    git checkout <branch> -- <file>
  然后 git add + git commit
  → 适用于：只采纳部分文件变更
  → 注意：不做真正的 cherry-pick（那是 commit 级别的），
     而是文件级别的 checkout（更简单、更可控）
```

**3.3.3 桌面端 UI：分支面板（主要交互入口）**

ChatPage 右侧新增可折叠的"分支面板"侧边栏：

```
分支面板状态：

1. 执行中：
   ┌──────────────────────────────────────┐
   │ 📋 分支任务 (2/3 完成)                 │
   │                                       │
   │ ✅ 后端 API          45s | 3.2K tokens│
   │    2 个文件变更                        │
   │    [审查]                              │
   │                                       │
   │ 🔄 数据库模型        执行中...         │
   │    正在生成迁移脚本...                  │
   │                                       │
   │ ⏳ 前端页面          等待依赖           │
   │    依赖：后端 API                      │
   └──────────────────────────────────────┘

2. 全部完成（有待审查）：
   ┌──────────────────────────────────────┐
   │ 📋 分支任务 (3/3 完成)                 │
   │                                       │
   │ ✅ 后端 API          [审查]           │
   │ ✅ 数据库模型        [审查]           │
   │ ⚠️ 前端页面          [审查]           │
   │                                       │
   │ [全部采纳]  [逐个审查]                 │
   └──────────────────────────────────────┘

3. 无活跃分支时：面板折叠/隐藏
```

**点击[审查] → 弹出 Diff 审查模态框：**

```
┌──────────────────────────────────────────────────────┐
│  审查：后端 API                                  ✕    │
│  状态：完成 ✅ | 耗时 45s | Token 3.2K               │
│                                                      │
│  变更文件（勾选要采纳的文件）：                         │
│  ☑ src/api/auth.ts           (+45 -3)                │
│  ☑ src/api/auth.test.ts      (+28 -0)                │
│                                                      │
│  Diff 预览（src/api/auth.ts）：                       │
│  ┌──────────────────────┬──────────────────────┐    │
│  │ 原始代码              │ 修改后代码             │    │
│  │                       │                       │    │
│  │ - import { old } from │ + import { new } from │    │
│  │                       │ +                     │    │
│  │                       │ + function login() {  │    │
│  │                       │ +   // 新增登录函数    │    │
│  │                       │ + }                   │    │
│  └──────────────────────┴──────────────────────┘    │
│                                                      │
│  ⚠️ 关联提示：auth.test.ts 依赖 auth.ts 的变更        │
│                                                      │
│  [采纳选中文件]  [全部采纳]  [要求重做]  [丢弃]        │
└──────────────────────────────────────────────────────┘
```

**3.3.4 与 /goal 工作流集成**

```
/goal "实现登录功能"

执行流程：
  1. GoalParser 分解任务 → [后端API, 数据库, 前端页面]
  2. Orchestrator 分析依赖：
     - 数据库（B）无依赖 → 可并行
     - 后端API（A）依赖数据库 → 等 B 完成后开始
     - 前端页面（C）依赖后端API → 等 A 完成后开始
  3. 桌面端弹出确认对话框（非自动执行）：
     ┌──────────────────────────────────────────────────┐
     │  任务分解完成                                     │
     │                                                   │
     │  将创建 3 个独立分支并行/顺序执行：                │
     │  1. 数据库模型（无依赖，立即开始）                 │
     │  2. 后端 API（依赖 1，完成后开始）                 │
     │  3. 前端页面（依赖 2，完成后开始）                 │
     │                                                   │
     │  每个分支在独立的 Git Worktree 中执行，            │
     │  互不干扰，完成后你可以逐个审查并选择采纳。         │
     │                                                   │
     │  [开始执行]  [取消]                               │
     └──────────────────────────────────────────────────┘
  4. 用户点击[开始执行]后，为每个子任务创建实验分支
  5. 按依赖顺序在各自 worktree 中执行
  6. 分支面板实时更新进度
  7. 每个子任务完成后，分支面板显示[审查]按钮
  8. 用户审查后采纳/拒绝
  9. 全部采纳后，主对话汇总结果
```

**3.3.5 冲突检测增强**

当前 `ConflictDetector` 基于文件路径检测（两个 Worker 改同一文件 → 冲突）。在分支模式下，冲突检测逻辑变化：

```
分支模式下的冲突场景：
  1. 分支间冲突：分支 A 和分支 B 都改了 auth.ts
     → 采纳 A 后，采纳 B 时 git merge 可能冲突
     → 检测时机：创建分支时（如果目标文件已被其他 active 分支修改，警告）
  
  2. 分支与主线冲突：分支 A 改了 auth.ts，用户在主工作区也改了 auth.ts
     → 采纳 A 时 git merge 可能冲突
     → 检测时机：adopt 前检查主工作区脏状态（已有逻辑）

  3. 依赖冲突：分支 B 依赖分支 A 的变更，但 A 被丢弃
     → B 的代码可能引用了 A 新增的函数/类型
     → 检测时机：采纳 B 前检查其依赖的分支是否已采纳
```

### 3.4 CLI 命令（高级用户保留）

以下命令仅保留给 CLI 用户和高级用户，桌面版通过分支面板 UI 替代：

```
/experiment start <任务描述>          ← CLI 创建实验分支
/experiment review [expId]            ← CLI 审查变更
/experiment adopt <expId> [--files f1,f2]  ← CLI 采纳
/experiment redo <expId> [新指令]     ← CLI 要求重做
/experiment discard <expId>           ← CLI 丢弃
/experiment list                      ← CLI 列表
/experiment diff <expId>              ← CLI 查看 Diff
/experiment compare <expA> <expB>     ← CLI 对比两个实验
```

### 3.5 思考引导

- worktree 中的 Agent 执行失败（如 LLM 超时、工具执行异常）时，实验分支应该怎么处理？（标记为 `failed` 状态，保留 worktree 供调试？还是自动 discard？建议保留，分支面板显示 ❌ 状态和错误信息）
- 多个实验分支有依赖关系时（B 依赖 A），如果 A 被丢弃，B 怎么办？（自动标记 B 为 `blocked`？还是让用户手动决定？建议在分支面板显示⚠️并提示"依赖的分支已丢弃"）
- 选择性合并（cherry-pick 文件级）是否会导致代码不一致？（如采纳了 auth.ts 但没采纳 auth.test.ts，测试可能跑不过。需要"关联文件"提示——已在 UI 中加入）
- worktree 的磁盘空间管理——每个 worktree 是一份完整的代码副本，大项目可能占用大量空间。需要定期清理 discarded 实验的 worktree 吗？（设置上限：`experiments.maxActiveWorktrees` 默认 5，超过时在分支面板提示清理）
- 子 Agent 在 worktree 中执行时，是否应该继承主 Agent 的项目记忆和 Skill？（应该继承 Skill——编码规范是项目级的；不应该继承对话历史——上下文隔离）
- `redo` 操作是否应该在原有 worktree 上重新执行，还是创建新的实验分支？（原有 worktree 上 `git reset --hard <baseCommit>` 后重新执行，保留实验 ID 不变。但如果用户想对比两次尝试的结果，应该创建新分支）
- 桌面端分支面板和主对话的关系——分支执行时主对话是否阻塞？（建议非阻塞：分支在后台执行，用户可以在主对话继续做其他事。分支完成后面板通知用户审查。但 /goal 触发的分支任务建议阻塞，因为子任务通常是主任务的一部分）

---

## Task 4：集成测试与文档同步（≥ 6 测试）

### 4.1 集成测试

- **代码地图端到端测试**：验证 ContextInjector 在会话启动时注入 repo map 摘要、用户消息处理时召回相关文件、/goal 分解时引用项目结构。验证 codegraph MCP 集成（如果安装了 codegraph，8 个工具自动注册；如果未安装，回退到内置 repo_map）
- **Skill 自动生成端到端测试**：验证 UI 对话框输入 → AI 生成 SKILL.md → 用户确认 → 保存到 .routedev/skills/ → PromptManager 加载 → system prompt 包含规则。验证从现有代码自动学习（扫描项目 → 提取特征 → 生成 Skill）
- **Hook 自动生成端到端测试**：验证 UI 对话框输入 → 模板匹配/LLM 生成 → 安全审查 → 用户确认 → HookRunner 注册 → file_write 后触发。验证模板一键启用（Settings 页面开关 → 立即生效）
- **分支合并工作流端到端测试**：验证 /goal 分解 → 确认对话框 → 创建 worktree → 子 Agent 在 worktree 中执行 → 分支面板显示进度 → 审查模态框显示 Diff → 采纳合并到主分支。验证选择性合并（只采纳部分文件）。验证冲突检测（两个分支改同一文件时警告）
- **依赖顺序执行测试**：验证 /goal 分解的子任务按依赖顺序在不同 worktree 中执行（B 依赖 A → A 完成后 B 才开始）
- **回滚安全性测试**：验证实验分支的 discard 不影响主工作区。验证 adopt 失败（合并冲突）时主工作区状态不变

### 4.2 文档同步

- **CODEMAP.md**：新增 `src/hooks/templates/`（Hook 模板库）、`src/agent/code-map-context-middleware.ts`（ContextInjector 中间件）、ExperimentManager 增强说明
- **CHANGELOG.md**：v3.1.0 条目
- **package.json**：版本号升级至 3.1.0
- **config schema**：新增 `codegraph` 配置段、`experiments.maxActiveWorktrees` 配置项

---

## 新增陷阱警告

**65. worktree 中的 Agent 工作目录必须设置为 worktreePath：** 子 Agent 的 `workingDirectory` 和 `allowedDirectories` 都必须是 worktree 路径，不能是主工作区路径。否则子 Agent 的文件操作会落到主工作区，破坏隔离性。在创建子 Agent 时强制校验。

**66. codegraph 的 8 个 MCP 工具全部暴露，不做动态筛选：** codegraph 官方设计的 8 个工具（search/context/callers/callees/impact/node/files/status）已经做过精简优化，全部暴露给 Agent 即可。不需要像 codebase-memory-mcp 的 14 个工具那样做筛选。如果切换到 codebase-memory-mcp，才需要考虑工具筛选（建议只暴露 search_graph/trace_path/get_architecture 三个核心工具）。

**67. 选择性合并（cherry-pick 文件级）不做依赖检查：** `git checkout <branch> -- <file>` 是纯文件级操作，不会检查被采纳的文件是否依赖被丢弃的文件中的变更。如采纳了 `auth.ts`（调用了 `verifyPassword`）但丢弃了 `password-utils.ts`（定义了 `verifyPassword`），编译会失败。在 UI 审查模态框中给出"关联文件"提示，但不强制阻止——用户可能有理由只采纳部分文件。

**68. Skill 自动生成的内容必须经过用户确认：** AI 生成的 SKILL.md 可能包含过于严格或不合理的规则（如"所有函数不超过 5 行"），如果直接启用会严重影响 Agent 行为。生成后必须在 UI 确认界面展示给用户确认，用户可以编辑后再保存。不能"生成即启用"。

**69. Hook 模板的关键词匹配是近似匹配，不是精确语义理解：** UI 对话框输入"格式化输出"可能错误匹配到 auto-format 模板（因为包含"格式化"），但用户的意思可能是"格式化 console 输出"而不是"保存后格式化代码"。匹配后在确认界面展示模板内容让用户确认，而不是直接安装。

**70. 实验分支的 worktree 不会自动清理：** discarded 实验的 worktree 会留在磁盘上（`discardExperiment()` 会清理，但如果程序异常退出，worktree 可能残留）。启动时检查 `.routedev/experiments/` 下是否有 registry 中不存在的目录，在分支面板提示用户清理。

**71. codegraph 的 `.codegraph/` 和 RouteDev 的 `.routedev/repo-map-cache.json` 都必须加入 `.gitignore`：** codegraph 的 SQLite 索引和 RouteDev 的缓存都是机器生成的、平台相关的，不应该提交到仓库。`ensureGitignore()` 逻辑应该扩展到也检查这两项。

**72. 桌面端 UI 操作和 CLI 命令必须共享同一套底层 API：** Settings 页面的"创建 Skill"按钮和 `/skill create` 命令必须调用同一个 `SkillGenerator.generate()` 方法。不能 UI 走一套逻辑、CLI 走另一套——否则行为不一致。UI 只是 CLI 的可视化封装，底层是同一个服务层。

**73. 分支面板的状态更新必须实时且准确：** 子 Agent 在 worktree 中执行时，进度回调（onProgress）必须实时更新到分支面板 UI。如果 UI 状态滞后（如显示"执行中"但实际已完成），用户会困惑。使用事件驱动（EventEmitter）而非轮询。

---

## 思考引导总结

以下问题供执行人在实现时思考，不是强制要求：

1. **代码地图双轨制的降级策略是否足够健壮？** 如果 codegraph 安装了但索引损坏（SQLite 文件被删了一半），RouteDev 应该自动回退到内置 repo_map 还是报错？检测 codegraph 可用性的逻辑应该多严格？

2. **ContextInjector 注入的文件列表和 KnowledgeGraph recall 的结果是否应该合并？** 用户问"帮我改登录功能"时，repo map 召回了 `auth.ts`（因为文件名匹配），KnowledgeGraph 召回了"上次决定用 JWT 做认证"（因为内容匹配）。两者应该合并去重后注入，还是分别注入到不同位置？

3. **Skill 从现有代码自动学习时，如何处理项目中的第三方代码？** `node_modules/`、`vendor/`、`dist/` 目录的代码不应该被分析。复用 `isIgnoredPath()` 过滤，但是否需要更智能的判断（如检测到某个目录是生成的代码就跳过）？

4. **Hook 自动生成时，AI 生成的 shell 命令如何做安全审查？** 模板库里的命令是安全的（预定义的），但自定义 Hook 的命令是 AI 生成的。需要复用 `SecurityChecker` 的命令黑名单检查吗？还是单独做一个 Hook 命令审查器？

5. **分支合并工作流中，子 Agent 在 worktree 中执行时，主对话是否应该阻塞等待？** /goal 触发的分支任务建议阻塞（子任务是主任务的一部分）。但用户手动创建的分支任务（通过分支面板的"新建分支任务"按钮）可以非阻塞。是否需要区分两种模式？

6. **实验分支的命名是否需要更语义化？** 当前是 `experiment/exp-001`，用户看到 `exp-001` 不知道是什么任务。是否应该用任务描述生成语义化分支名（如 `experiment/login-backend`）？但语义化分支名可能冲突（两个"后端"任务），需要加序号后缀。

7. **/goal 自动创建实验分支时，桌面端必须弹出确认对话框：** 不能静默创建多个 worktree——用户会困惑"突然多了几个目录"。必须在 UI 中展示"将为每个子任务创建独立分支"的说明，让用户确认后执行。

8. **codebase-memory-mcp 作为高级替代方案时的工具筛选：** codebase-memory-mcp 有 14 个 MCP 工具，全部暴露会增加 system prompt 约 1000-1500 tokens。建议只暴露核心的 3-5 个（search_graph/trace_path/get_architecture/detect_changes），在 Settings > Advanced 中允许用户自定义工具集。

9. **Hook 模板库是否应该支持用户自定义模板？** 用户可能想把自己的 Hook 配置保存为模板，在其他项目中复用。但这增加了复杂度——第一阶段先只做内置模板，后续考虑用户自定义模板。

10. **分支合并工作流和 Phase 38 的 spawn_agent 工具化是什么关系？** spawn_agent 是"在同一个工作目录中派遣子 Agent"，分支合并是"在不同 worktree 中派遣子 Agent"。两者可以并存——spawn_agent 用于轻量级子任务（如"帮我查一下这个函数的用法"），分支合并用于重量级子任务（如"实现这个模块"）。是否需要在 spawn_agent 中增加 `useWorktree: boolean` 选项来统一入口？
