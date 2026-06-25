# Phase 36 — 上下文智能增强与工程方法论集成

> **版本目标：** v2.8.0
> **前置依赖：** Phase 32 完成（v2.4.0）—— **不依赖 Phase 33、34 或 35**
> **新增测试要求：** ≥ 16 个
> **研究依据：** SWE-Pruner 论文（arXiv:2601.16746）、codebase-memory-mcp、Ponytail、ECC、Superpowers、费曼学AI视频系列（8 个 B 站视频文稿）
> **核心命题：** RouteDev 的上下文管理是"无差别压缩"（5 级 compaction 只看 token 数不看内容），代码检索是"轻量正则扫描"（RepoMapTool 不理解语义结构），Skill 系统缺少工程方法论指导。本 Phase 从 5 个外部资源中提取经过验证的思路，补上这三个短板。

---

## 并行执行分析：与 33/34/35 的关系

Phase 36 与 33/34/35 共享同一个前置（Phase 32），核心修改面互不重叠：

| Phase | 核心修改面 | 与 36 的交叉 |
|-------|-----------|:---:|
| 33（设置补全） | SettingsPage.tsx、desktop renderer | 无 |
| 34（交互+检索） | CLI 渲染、Repo Map、AuditLogger | **见下方"替代关系"** |
| 35（执行基础设施） | worker-executor.ts、hooks.ts、durable-executor.ts | Task 2 增强 |
| 36（上下文智能） | MCP 集成、KnowledgeGraph、Skill 文件、worker-executor.ts | 自身 |

**替代关系（Phase 34 Task 4 ↔ Phase 36 Task 1）：** Phase 34 Task 4 设计了三种 Repo Map 技术选型（TS Compiler API / CodeGraph MCP / 正则扫描）。Phase 36 Task 1 提供了第四种——直接集成 codebase-memory-mcp（纯 C 零依赖的 MCP 服务器，tree-sitter 解析 158 种语言，已开源）。**如果 34 和 36 并行执行，建议 Phase 34 Task 4 的执行暂停，等待 Phase 36 Task 1 的集成结果。** 因为 codebase-memory-mcp 已经实现了比三种方案都更完整的功能（14 个 MCP 工具、SQLite 知识图谱、BM25+向量双检索），从零自建是重复劳动。

**增强关系（Phase 35 Task 1 ↔ Phase 36 Task 2）：** Phase 35 Task 1 设计了三种 Worker 上下文过滤策略（Tail+Blackboard / 关键词 / Token 预算）。Phase 36 Task 2 在这三种策略之上增加一个"关注点声明"步骤——来自 SWE-Pruner 论文的核心洞察。两者是叠加关系而非替代，Phase 35 Task 1 先实现基础过滤，Phase 36 Task 2 再增强。如果 35 和 36 并行，Task 2 需要等 Phase 35 Task 1 的 `filterContext()` 方法签名确定后再开发。

---

## 研究背景：6 个来源的核心洞察

> 以下从 1 篇论文 + 4 个开源项目 + 8 个视频文稿中提取。不是标准答案，是思考素材。

### SWE-Pruner：任务感知的上下文裁剪

SWE-Pruner 解决了一个关键问题：当前的上下文压缩工具（包括 RouteDev 的 5 级 compaction）只看 token 数量，不看内容是否和当前任务相关。它的做法是让 Agent 先声明"我这次关注什么"（如"focus on error handling"），然后用一个 0.6B 参数的小模型根据关注点动态裁剪上下文。在 SWE-Bench Verified 上实现 23-54% token 削减，同时提升成功率。

**我们不需要训练 0.6B 模型。** SWE-Pruner 的核心洞察是"有意识的裁剪优于无差别压缩"。这个洞察可以用更轻量的方式落地：Worker 从 task.description 中提取 3-5 个关键词作为关注点声明，然后用关键词相关性做过滤——本质上是 Phase 35 Task 1 "策略 B"的理论加强版。

### codebase-memory-mcp：125 倍 token 节省的代码智能

纯 C 实现、零依赖、tree-sitter 解析 158 种语言。把代码索引成 SQLite 知识图谱（函数/类/调用链/路由）。关键数据：5 次结构查询约 3,400 tokens，对比逐文件搜索的 412,000 tokens——125 倍节省。支持 TypeScript，支持 git diff 影响分析、死代码检测、Louvain 社区发现。提供 14 个 MCP 工具，通过 stdio 传输连接。

**这是 Phase 34 Task 4（Repo Map）的现成替代品。** RouteDev 已有 MCP 客户端（Phase 8），直接把这个服务器加入配置就行。不需要从零写 tree-sitter 解析器。

### Ponytail：6 层极简优先级

在写新代码之前按 6 层优先级穷尽已有方案：丢弃 → 标准库 → 原生能力 → 已有依赖 → 单行 → 最小实现。安全/信任边界/数据丢失/可访问性永远不在砍价清单上。技术债记录机制确保延后的优化不被遗忘。

### ECC：持续学习的置信度 + 聚类

从编码会话自动提取模式，给每条模式打分（置信度），相似的模式聚类合并。多条独立观察合并成一条更可信的知识，而非堆叠成 N 条独立记录。

### Superpowers：4 阶段根因分析

症状 → 假设 → 验证 → 修复。Agent 出错时不是直接重试，而是先分析根因再修复。RouteDev 的 FailureReport 已有错误分类，但缺少"假设 → 验证"环节。

### 费曼学AI 视频系列：Agent 记忆系统的设计铁律

> 来源：B 站 UP 主"费曼学AI"的"造物工坊/造物车间"系列，共 8 个视频文稿（Agent 记忆系统 7 步设计、100 行代码造 Agent、意图路由 3 层漏斗、多 Agent 编排与生产化、12 种注入攻击与五层防御、LLM API 5 个认知颠覆、Prompt 工程化 5 原则、RAG 七层架构）。以下只提取与 Phase 36 直接相关的洞察。

**洞察一：信息三分类（该扔/该缓存/该存）。** 来自《7 步设计 Agent 记忆系统》。真实案例：memory.md 从 200 行涨到 800 行，Agent 只读前 200 行，一条修过三次的 bug 修正记录被埋在第 650 行，导致重复犯错。根因是没有分类系统。三条铁律：能从外部重新推导的信息绝不存（该扔）；当前任务上下文跟着 session 走、session 结束就清（该缓存）；不可推导的决策、发现、原因才值得持久化（该存）。80% 的人一上来就装向量数据库，相当于搬家时不先决定什么扔掉什么带走，直接订一辆卡车——结果什么都不想扔，全部塞进去。

**洞察二：过时记忆的三时间戳（created_at / valid_until / superseded_by）。** 同视频。真实案例：三个月前用 `frameRange` 参数渲染视频，后来改成了 `frames`，但旧记录没标记过期，三个月后 Agent 翻出旧记录当正确参数用，制造了一次完整的生产事故。解法：每条记忆加三个时间戳，不过时标记只标记 `superseded`。这意味着你可以问两个不同的问题——"现在什么是真的"和"去年这个时候什么是真的"。后者对审计和复盘至关重要。过时记忆不是没用，是毒药。

**洞察三：归纳层是搜索精度的防火墙。** 同视频。真实案例：Agent 用语义搜索找到 5 条高度相关的"渲染崩溃修复"记录，但它们来自不同 episodes 的不同 bug，Agent 混合输出了三种不同修复方案的合成答案。如果有归纳层，5 条里 4 条会被标记为"已修复"，仅保留最新一条作为教训。归纳不是奢侈品，是搜索精度的防火墙。

**洞察四：Tool Schema 描述决定 80% 效果。** 来自《100 行代码造 Agent》。实测：同一个天气查询工具，description 写"获取天气"→ 准确率 60%；写"当用户询问某个城市的当前温度、天气状况或未来预报时，使用此工具"→ 准确率 92%。差距 30 个百分点，就因为 description 写法不同。Description 写给大模型看，不是写给人看。

**洞察五：熔断模式。** 来自《7 种意图 3 层漏斗》。同一个 session 里连续 3 次低置信度（<0.6），关闭 L2 层 5 次请求，只保留 L0+L1，5 次之后再放回 L2 验证是否恢复正常。这是 Netflix Hystrix 的断路器模式搬到 Agent 路由。对 Worker 上下文过滤同样适用——连续失败时应降级到最安全的策略。

**不整合的内容：** Prompt 工程化五原则（RouteDev 已有 PromptTemplateManager）、RAG 七层架构（RouteDev 不是 RAG 系统）、12 种注入攻击（Phase 8 已覆盖 MCP 注入检测）、Frozen Snapshot 前缀缓存（与 4 个 Task 无直接关联，留作未来素材）、评估集三层设计（与 Phase 35 Task 4 TrajectoryExporter 关联更紧密）。

---

## Task 1：codebase-memory-mcp 集成（替代 Phase 34 Task 4）

### 现状问题

RouteDev 的代码检索有两个内置工具：
- `code-search.ts`（ripgrep-first，JS fallback）——内容搜索，不理解语义结构
- `repo-map.ts`（轻量正则扫描）——提取 `.ts/.js/.tsx/.jsx` 文件的函数签名，不支持其他语言，不持久化索引

这意味着 Agent 在处理大型项目时只能"盲搜"——每次都要逐文件读取，token 消耗巨大。codebase-memory-mcp 已经解决了这个问题，且通过 MCP 协议与 RouteDev 天然兼容。

### 设计方向

**第一步：作为 MCP 服务器集成**

codebase-memory-mcp 是一个独立的 MCP 服务器（stdio 传输），RouteDev 的 MCP 客户端可以直接连接。集成工作包括：
1. 在 `config.example.yaml` 中添加 codebase-memory-mcp 的预置配置（stdio transport + 自动安装脚本）
2. 编写一个安装辅助脚本 `scripts/setup-codebase-memory.sh`（检测系统架构、下载对应二进制文件、设置执行权限）
3. 在 SettingsPage 的 MCP 标签页中添加"推荐 MCP 服务器"快捷安装按钮（或直接在 config 中预配置）

**第二步：确保工具调用链路正确**

MCPClientManager 会自动发现和注册 codebase-memory-mcp 的 14 个工具（命名空间为 `mcp__codebase-memory__<toolName>`）。需要验证：
- `ToolResultSanitizer` 的注入检测不会误判代码智能工具的返回内容
- MCP 工具的 `requiresApproval: true` 对于查询类工具（如 `codegraph_search`、`codegraph_node`）是否可以设为 `false`（减少审批摩擦）
- 工具返回的结构化数据（JSON 格式的调用链、函数签名）是否会被智能截断破坏

**第三步：编写 Skill 引导 Agent 使用**

创建一个 `.routedev/skills/codebase-intelligence/SKILL.md`，引导 Agent 在以下场景使用代码智能工具而非内置搜索：
- 需要了解函数调用链时（用 `codegraph_callers` / `codegraph_callees`）
- 需要评估代码变更影响范围时（用 `codegraph_impact`）
- 需要理解模块依赖关系时（用 `codegraph_explore`）
- 需要查找死代码时（用 `codegraph_search` + 特定查询）

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| MCPClientManager.connect() | `(entry: MCPServerEntry) => Promise<MCPConnectionInfo>` | client.ts:47 | ✅ 已验证 |
| MCPServerEntry 类型 | `{ id, name, enabled, config: MCPServerConfig, connectTimeout? }` | types.ts:27-33 | ✅ 已验证 |
| MCPStdioConfig | `{ transport: 'stdio', command: string, args: string[], env?, cwd? }` | types.ts:8-14 | ✅ 已验证 |
| MCPTool 注册 | 命名空间 `mcp__${serverId}__${toolName}`，自动发现 inputSchema | client.ts:207-214 | ✅ 已验证 |
| RepoMapTool（现有） | 轻量正则扫描，仅 .ts/.js/.tsx/.jsx，无持久化 | repo-map.ts | ✅ 已验证 |
| CodeSearchTool（现有） | ripgrep-first + JS fallback | code-search.ts:12 | ✅ 已验证 |

### 需要你决定的

1. **预配置 vs 用户手动安装：** codebase-memory-mcp 是一个二进制文件（约 15MB），需要下载。是在 RouteDev 的安装脚本中自动下载（用户体验好但增加安装时间），还是提供"一键安装"按钮让用户按需安装（更轻量但需要用户知道这个工具的存在）？建议看 `scripts/` 目录中现有的辅助脚本风格来决定。

2. **查询类工具的审批策略：** MCPTool 构造时默认 `requiresApproval: true`（mcp-tool.ts:28）。对于纯读取的代码智能查询（如 `codegraph_search`、`codegraph_node`），每次都弹确认框会打断 Agent 的工作流。是否需要在 MCPClientManager 中增加一个"工具白名单"机制——白名单内的 MCP 工具自动设为 `requiresApproval: false`？还是接受审批摩擦作为安全代价？

3. **与现有 RepoMapTool 的关系：** codebase-memory-mcp 集成后，现有的 `repo-map.ts` 是否保留作为 fallback（MCP 服务器未连接时使用）？还是直接弃用，统一走 MCP？保留 fallback 增加了代码维护成本，但保证了无 MCP 环境下的基本功能。

### 验收标准

- [ ] codebase-memory-mcp 可通过 MCP stdio 连接到 RouteDev
- [ ] 14 个 MCP 工具自动注册并可在 Agent Loop 中调用
- [ ] 安装辅助脚本可自动下载对应平台的二进制文件
- [ ] `.routedev/skills/codebase-intelligence/SKILL.md` 引导 Agent 使用
- [ ] ≥ 4 个测试（MCP 连接配置验证、工具注册验证、Skill 路由验证）

---

## Task 2：任务感知上下文裁剪（增强 Phase 35 Task 1）

### 现状问题

Phase 35 Task 1 的三种过滤策略（Tail+Blackboard / 关键词 / Token 预算）都是"无意识"的——过滤逻辑不知道 Worker 当前要做什么。SWE-Pruner 论文证明，即使是最轻量的"关注点声明"也能显著提升过滤质量——Agent 先生成一句"我这次关注 error handling"，然后裁剪器据此保留相关代码段。

### 设计方向

在 `WorkerExecutor.execute()` 的 `filterContext()` 调用之前，依次增加两个步骤：

**步骤零：信息价值分类 `classifyInfoValue()`**

来自《7 步设计 Agent 记忆系统》的核心洞察——在裁剪之前，先对 `conversationHistory` 中的每条消息做三分类：

| 分类 | 判断标准 | 处理 |
|------|---------|------|
| 该扔 | 能从外部重新推导的信息（搜索结果原文、一次性中间输出、已被工具结果替代的查询） | 直接丢弃，不进入后续过滤 |
| 该缓存 | 短期高价值（当前任务上下文、最近几步的工具输出、本 session 的活跃状态） | 保留，参与后续关键词相关性计算 |
| 该存 | 不可推导的信息（架构决策、bug 根因发现、方案选定原因） | 保留并标记为高优先级，不参与裁剪 |

实现方式：基于消息的 `role` 和 `toolResult` 字段做规则判断（tool 返回的原始数据 → 该扔；assistant 的推理中间步骤 → 该缓存；user 的决策性指令和 assistant 的结论性输出 → 该存）。不需要 LLM 调用。

**为什么需要这一步：** 视频中的真实案例——memory.md 从 200 行涨到 800 行，Agent 只读前 200 行，一条修过三次的 bug 修正记录被埋在第 650 行。根因是没有分类系统，"该扔"的信息挤占了"该存"的空间。三分类是过滤前的第一道关卡，确保后续裁剪不会因为大量"该扔"信息而干扰判断。

**步骤一：关注点声明 `declareFocus()`**

1. 从 `task.description` 中提取关注点关键词（不需要 LLM 调用——用简单的 NLP 提取：分词 → 去停用词 → 取 TF 最高的 3-5 个词）
2. 将关注点声明附加到 `WorkerTask` 上：`task.focusKeywords: string[]`
3. `filterContext()` 使用 `focusKeywords` 对 `conversationHistory` 中的每条消息计算相关性分数，保留分数高于阈值的消息

**为什么不需要 LLM 调用：** SWE-Pruner 用 0.6B 模型做语义提取，但我们的场景更简单——Worker 的 task.description 通常只有 1-3 句话，关键词提取用分词就够了。引入 LLM 调用会增加延迟和 token 成本，与"节省 token"的初衷矛盾。

**与 Phase 35 Task 1 策略 B（关键词相关性）的区别：** 策略 B 的关键词来源未定义。Task 2 明确了关键词来源（从 task.description 提取）和提取方式（TF 排序，非 LLM）。这是策略 B 的具体落地方案。

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| WorkerExecutor.execute() | `(task: WorkerTask, llmClient, routeDecision, conversationHistory, baseSystemPrompt, signal?, onConfirmTool?) => Promise<WorkerResult>` | worker-executor.ts:39-47 | ✅ 已验证 |
| WorkerTask 类型 | `{ stepId, description, role, rolePrompt?, blackboardSnapshot }` | execution-orchestrator.ts | ✅ 已验证 |
| conversationHistory 传递 | 直接透传，无过滤 | worker-executor.ts:74-82 | ✅ 已验证 |

### 需要你决定的

1. **关键词提取方式：** 中文和英文的分词方式不同。英文可以直接空格分词，中文需要分词库（如 `segmentit`）或者更简单的方式——按字符 n-gram。你的项目主要面向中文用户还是英文用户？如果主要是中文项目，可能需要一个轻量的中文分词方案。但也可以用最简单的方式：按标点符号分句 → 取最长的 3 个名词短语。

2. **相关性分数计算：** 消息和关键词的相关性怎么算？最简单的方案：消息文本中包含 N 个关键词中的 M 个，分数 = M/N。更精细的方案：考虑关键词在消息中的位置（标题/正文/代码块）和频率。建议先做最简单的，实测后再决定是否需要精细化。

3. **WorkerTask 类型扩展：** 给 WorkerTask 加 `focusKeywords?: string[]` 字段是否需要修改 `execution-orchestrator.ts` 中构造 WorkerTask 的代码？还是让 WorkerExecutor 在 `execute()` 内部自行提取，不修改上游类型？后者侵入性更小。

4. **三分类的判断粒度：** `classifyInfoValue()` 目前基于 `role` 和 `toolResult` 字段做规则判断。但"该存"和"该缓存"的边界可能模糊——assistant 的一条推理输出到底是"短期高价值的中间步骤"还是"不可推导的决策发现"？是宁严勿松（更多归入"该存"，减少误删风险但可能保留太多）还是宁松勿严（更多归入"该缓存"，过滤更激进但可能丢掉重要信息）？建议先做最保守的版本（只有纯工具原始输出归入"该扔"，其余全部归入"该缓存"），实测后再细化。

### 验收标准

- [ ] `WorkerExecutor` 在过滤前先执行 `classifyInfoValue()` 对消息做三分类
- [ ] "该扔"类消息被直接丢弃，不进入后续过滤流程
- [ ] `WorkerExecutor` 在过滤前从 `task.description` 提取关注点关键词
- [ ] 关键词提取不调用 LLM（纯文本处理）
- [ ] `filterContext()` 使用关键词计算消息相关性分数
- [ ] 相关性低于阈值的消息被过滤，阈值可配置
- [ ] ≥ 5 个测试（三分类正确性、关键词提取、相关性计算、过滤结果验证、空 description 边界）

---

## Task 3：极简编码优先级 Skill（Ponytail 6 层）

### 现状问题

RouteDev 的 Anti-Yes-Engineer（`<anti_yes_engineer>` 区块）告诉 Agent "不要无脑同意"，但没有告诉它"在写代码之前应该怎么思考"。Agent 经常直接写新代码，而不是先检查是否有标准库/已有依赖/原生能力可以复用。Ponytail 的 6 层优先级正好填补这个空白。

### 设计方向

创建一个内置 Skill `.routedev/skills/minimalist-coding/SKILL.md`，内容为 Ponytail 的 6 层决策树：

```
层级 1：这个功能真的需要吗？（丢弃不必要的需求）
层级 2：标准库/语言原生能力能解决吗？
层级 3：项目已有的依赖能解决吗？
层级 4：已安装的包能解决吗？
层级 5：能用一行代码解决吗？
层级 6：写最小必要的代码

红线：以下永远不在砍价清单上——
- 信任边界验证
- 数据丢失处理
- 安全性检查
- 可访问性
```

Skill 的 `description` 和 `keywords` 应包含触发匹配的词：`新建功能、添加依赖、安装、实现、编码、写代码、create、implement、add dependency`。

**同时增加一个 `/tech-debt` 命令**（扩展 `command-registry.ts`），功能：
- `/tech-debt add <描述>` — 记录一条技术债到 `.routedev/tech-debt.json`
- `/tech-debt list` — 列出所有未解决的技术债
- `/tech-debt resolve <id>` — 标记为已解决
- 数据格式：`{ id, description, addedAt, resolvedAt?, context? }`

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| SkillDefinition 类型 | `{ name, description, routingKeywords, content, sourcePath }` | filesystem-discovery.ts:62-73 | ✅ 已验证 |
| SKILL.md 格式 | YAML frontmatter（description + keywords）+ Markdown body | filesystem-discovery.ts:256-263 | ✅ 已验证 |
| SkillsRouter.route() | `(taskDescription: string, maxSkills?: number) => SkillDefinition[]` | filesystem-discovery.ts:107 | ✅ 已验证 |
| CommandRegistry.register() | 注册命令的入口 | command-registry.ts | ✅ 已验证 |

### 需要你决定的

1. **Skill vs agents.md 规则：** 6 层优先级是写成 Skill（按需加载、token 消耗 low）还是直接写入 agents.md（每次对话都加载、token 消耗 zero 但增加 prompt 长度）？如果写入 agents.md，它变成一条永远生效的规则；如果写成 Skill，只有在 Agent 准备写代码时才被触发加载。后者更符合"渐进式披露"原则。

2. **技术债的存储位置：** `.routedev/tech-debt.json` 还是 `notes.md`（RouteDev 已有的临时笔记系统）？notes.md 是自由文本，tech-debt 需要结构化存储（id、时间戳、状态）。建议用独立的 JSON 文件。

3. **是否需要 `/audit` 和 `/efficiency` 命令：** Ponytail 还提供了代码审计和效率指标命令。这些对 RouteDev 有用但优先级低于核心 6 层 Skill。是否纳入本 Task 还是推迟？

### 验收标准

- [ ] `minimalist-coding` Skill 可被 SkillsRouter 正确匹配
- [ ] Skill 内容包含 6 层优先级决策树 + 红线规则
- [ ] `/tech-debt` 命令支持 add/list/resolve 三个子命令
- [ ] 技术债数据持久化到 `.routedev/tech-debt.json`
- [ ] ≥ 3 个测试（Skill 路由匹配、tech-debt CRUD、边界条件）

---

## Task 4：KnowledgeGraph 模式聚类与置信度

### 现状问题

KnowledgeGraph 的 GraphNode 有 `validatedCount` 字段（用户确认次数 / 引用次数），但：
- **没有内容相似性聚类：** 多条描述同一知识的节点独立存在，不会被合并。随着 Session 积累，图谱会膨胀。
- **没有置信度评分：** `validatedCount` 只记录引用次数，不综合考虑时间衰减和多源验证。一条 30 天前被引用 10 次的知识 vs 一条今天被引用 2 次的知识，哪个更可信？
- **DreamConsolidator 和 KnowledgeGraph 是独立的：** Dream 只做 CheckpointData 的压缩/去重，不向 KnowledgeGraph 写入。两个记忆系统之间没有信息流。

### 设计方向

**4a：内容相似性聚类**

在 KnowledgeGraph 中增加 `clusterSimilarNodes()` 方法：
- 对同一 `type` 的节点（如都是 `fact`），计算内容相似性（Jaccard 相似度 on 分词后的词集，或更简单的——共享关键词比例）
- 相似度 > 阈值的节点合并：保留 `validatedCount` 最高的节点，将其 `content` 扩展为合并后的版本，其他节点标记为 `deprecated: true`
- 合并后创建 `supersedes` 边指向被合并的节点

**4b：置信度评分**

增加 `confidenceScore` 字段到 GraphNode：
```
confidence = validatedCount * timeDecay * corroborationBonus
timeDecay = exp(-λ * daysSinceUpdate)    // λ 可配置，默认 0.01（半衰期 ~70 天）
corroborationBonus = 1 + 0.1 * distinctSources  // 不同来源的验证加分
```

`recall()` 方法的排序改为综合 PPR 分数和置信度：`finalScore = pprScore * 0.6 + normalizedConfidence * 0.4`

**4b2：过时标记（valid_until / superseded_by）**

来自《7 步设计 Agent 记忆系统》的洞察——仅靠时间衰减降权不够，过时知识应被显式标记。增加两个可选字段到 GraphNode：

```typescript
validUntil?: number       // 时间戳，过了此时间该知识被视为过时
supersededBy?: string     // 如果有新知识替代了本条，指向新知识的 nodeId
```

行为：
- `recall()` 查询时，默认排除 `validUntil < Date.now()` 且 `supersededBy` 有值的节点
- 提供 `recall({ includeSuperseded: true })` 选项，允许"时间旅行"查询（"三个月前这个决策基于什么？"）
- 当新知识写入并明确替代旧知识时，旧节点的 `supersededBy` 被设置，`validUntil` 被设为当前时间
- 这与已有的 `supersedes` EdgeType（graph.ts:10）天然兼容——`supersededBy` 字段是 `supersedes` 边的反向指针，加速查找

**为什么不只靠 confidenceScore：** 一条 30 天前的 API 参数知识，confidenceScore 可能仍然不低（被引用多次、衰减不多），但它已经过时了。confidenceScore 衡量"有多可信"，validUntil/supersededBy 衡量"是否还活着"。两者是正交的维度。

**4c：Dream → KnowledgeGraph 信息流（含归纳层）**

在 DreamConsolidator 中增加可选的 KnowledgeGraph 注入，并在注入前做归纳：

来自《7 步设计 Agent 记忆系统》的洞察——没有归纳层的记忆系统是"垃圾山"而非"知识库"。真实案例：Agent 用语义搜索找到 5 条高度相关的"渲染崩溃修复"记录，但它们来自不同 bug 的不同修复方案，Agent 混合输出了一个错误的合成答案。如果归纳层把已修复的 4 条标记为 superseded，只保留最新一条作为教训，这个错误不会发生。归纳不是奢侈品，是搜索精度的防火墙。

`ingestToGraph(dreamResult, graph)` 函数的完整流程：

1. **提取：** Dream 执行后，从合并结果中提取关键 facts/decisions
2. **归纳三步（新增）：**
   - **合并同类：** 对提取出的每条知识，检查 KnowledgeGraph 中是否已有相似节点（用 Task 4a 的 Jaccard 相似度）。已有 → 不是创建新节点，而是将内容合并到已有节点，`validatedCount++`
   - **冲突检测：** 如果新旧知识存在矛盾（如旧知识说"用 frameRange 参数"，新知识说"用 frames 参数"），保留新的、标记旧的为 `superseded`，设置 `supersededBy` 指向新节点
   - **时效淘汰：** 超过 30 天没被引用的节点（`validatedCount` 未增长），降级为归档存储（标记 `deprecated: true`）
3. **注入：** 经过归纳后的知识写入 KnowledgeGraph（创建新节点或更新已有节点）

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| GraphNode 类型 | `{ id, type, content, embedding?, validatedCount, createdAt, updatedAt, deprecated }` | graph.ts:12-23 | ✅ 已验证 |
| NodeType 类型 | `'fact' \| 'decision' \| 'skill' \| 'event'` | graph.ts:9 | ✅ 已验证 |
| EdgeType 类型 | `'relates_to' \| 'derived_from' \| 'supersedes' \| 'conflicts_with'` | graph.ts:10 | ✅ 已验证 |
| recall() 方法 | `(query: string, options?) => Array<{ node, score, path }>` | graph.ts:207 | ✅ 已验证 |
| detectCommunities() | `(maxIterations?) => Map<string, string[]>` | graph.ts:301 | ✅ 已验证 |
| personalizedPageRank() | `(seedNodeIds, options?) => Array<{ node, score }>` | graph.ts:112 | ✅ 已验证 |
| DreamConsolidator | `consolidate(checkpoint: CheckpointData) => Promise<DreamResult>` | dream-consolidator.ts:51 | ✅ 已验证 |

### 需要你决定的

1. **相似性度量的选择：** Jaccard 相似度简单但粗糙（"函数 A 接受 string 参数" vs "函数 B 接受 string 参数"可能被判为高相似但实际是不同函数）。更精确的方案需要 embedding 向量（GraphNode 已有 `embedding?` 字段），但生成 embedding 需要额外 LLM 调用。建议先用 Jaccard 做 MVP，同时在 GraphNode 写入时可选生成 embedding，为未来切换到向量相似度做准备。

2. **聚类的触发时机：** 每次写入新节点时检查？定期批量执行？还是只在 `/dream` 命令执行时触发？每次写入都检查会增加写入延迟；定期批量需要定时器；只在 `/dream` 时触发最简单但聚类不够及时。

3. **Dream → KnowledgeGraph 是否需要 LLM 提取：** Dream 的输出是 `DreamResult.consolidated`（一个 CheckpointData 对象，包含 11 个字段）。从这 11 个字段中提取"值得长期保存的 facts/decisions"是否需要 LLM 判断？还是用规则提取（如 `designDecisions` 字段直接映射为 `decision` 类型节点，`crossTaskDiscoveries` 映射为 `fact` 类型）？后者更确定但可能提取质量不够。

4. **时间衰减的半衰期：** `λ=0.01` 意味着约 70 天半衰期——一条知识 70 天后置信度减半。这对编码项目的知识更新速度是否合理？前端框架的知识可能 30 天就过时了，而底层架构决策可能 1 年仍然有效。是否需要按 NodeType 设置不同的衰减率？

### 验收标准

- [ ] KnowledgeGraph 有 `clusterSimilarNodes()` 方法，可合并相似节点
- [ ] GraphNode 增加 `confidenceScore` 字段，综合 validatedCount + 时间衰减 + 多源验证
- [ ] GraphNode 增加 `validUntil?` 和 `supersededBy?` 字段，过时知识被显式标记而非仅降权
- [ ] `recall()` 排序综合 PPR 分数和置信度，默认排除已 superseded 的节点
- [ ] `ingestToGraph()` 在注入前执行归纳三步（合并同类 → 冲突检测 → 时效淘汰）
- [ ] DreamConsolidator 可选地将结果注入 KnowledgeGraph
- [ ] ≥ 4 个测试（聚类正确性、置信度计算、recall 排序、Dream 归纳+注入）

---

## Task 5：集成测试与文档同步

### 测试矩阵

| 测试文件 | 测试内容 | 数量 |
|----------|---------|:---:|
| `tests/phase36/mcp-codebase-integration.test.ts` | codebase-memory-mcp 连接配置、工具注册、Skill 路由 | ≥ 4 |
| `tests/phase36/focus-aware-pruning.test.ts` | 三分类正确性、关键词提取、相关性计算、过滤结果验证 | ≥ 5 |
| `tests/phase36/minimalist-skill.test.ts` | Skill 路由匹配、tech-debt CRUD | ≥ 3 |
| `tests/phase36/knowledge-clustering.test.ts` | 聚类正确性、置信度计算、recall 排序、Dream 注入 | ≥ 4 |

### 文档同步

- **AGENTS.md 陷阱更新：** 新增 #49-54（见下方"陷阱预告"）
- **CODEMAP.md：** 新增 `src/tools/mcp/codebase-integration.ts`（如有）、`.routedev/skills/minimalist-coding/`、`.routedev/skills/codebase-intelligence/`
- **CHANGELOG.md：** v2.8.0 条目
- **package.json：** 版本号升级到 v2.8.0

### 验收标准

- [ ] 全部测试通过（≥ 16 个）
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] AGENTS.md 新增陷阱 #49-54
- [ ] CODEMAP.md / CHANGELOG.md 已更新

---

## 陷阱预告（写入 AGENTS.md）

**#49 codebase-memory-mcp 工具名含命名空间前缀：** 所有 codebase-memory-mcp 的工具注册后名称为 `mcp__codebase-memory__<originalName>`（如 `mcp__codebase-memory__codegraph_search`）。Agent 调用时必须使用完整命名空间名称，不能使用原始工具名。SkillsRouter 的 SKILL.md 中引用工具名时也要用完整名称。

**#50 关注点关键词提取不调用 LLM：** `declareFocus()` 从 `task.description` 提取关键词使用纯文本处理（分词 + TF 排序），禁止在此处引入 LLM 调用。目的是零额外 token 成本。如果未来需要更精准的语义提取，应作为独立的实验性功能（默认关闭）而非替换纯文本提取。

**#51 KnowledgeGraph.confidenceScore 是计算字段不是存储字段：** `confidenceScore` 通过 `validatedCount * timeDecay * corroborationBonus` 实时计算，不持久化到磁盘。因为时间衰减依赖当前时间，持久化会导致过期分数被读取。Graph 序列化时只存储 `validatedCount` 和 `updatedAt`，读取时重新计算 confidenceScore。

**#52 DreamConsolidator 与 KnowledgeGraph 的信息流是可选的：** `DreamConsolidator.consolidate()` 的签名不变，KnowledgeGraph 注入通过独立的 `ingestToGraph(dreamResult, graph)` 函数实现。调用方（如 `/dream` 命令）决定是否同时调用两者。禁止在 DreamConsolidator 内部硬编码 KnowledgeGraph 依赖——它们是两个独立的记忆系统，通过显式调用桥接。

**#53 连续失败触发熔断（来自费曼学AI"意图路由 3 层漏斗"）：** 当 `classifyInfoValue()` 或 `filterContext()` 导致 Worker 执行结果异常（如连续 3 次 Worker 输出为空或错误），应触发熔断降级——暂时关闭过滤逻辑，回退到"全量传递"模式（Phase 35 Task 1 的默认行为），5 次请求后重新尝试过滤。这是 Netflix Hystrix 的断路器模式。目的是防止过滤策略的 bug 导致所有 Worker 全部失败。熔断状态记录在 WorkerExecutor 实例上（内存），不持久化。

**#54 Tool/Skill 的 description 写法决定 80% 匹配效果（来自费曼学AI"100 行代码造 Agent"）：** 实测数据——同一个工具，description 写"获取天气"→ 准确率 60%，写"当用户询问某个城市的当前温度、天气状况或未来预报时，使用此工具"→ 准确率 92%。差距 30 个百分点。写 SKILL.md 的 `description` 和 `routingKeywords` 时同理：描述必须写给模型看（包含触发场景、适用条件），不是写给人看的简短标题。`codebase-intelligence` 和 `minimalist-coding` 两个 Skill 的 description 都应遵循此原则。

---

## 思考引导汇总

以下是需要执行人读代码后做出判断的问题清单（不强制答案）：

| # | 问题 | 关联 Task | 建议阅读的代码 |
|---|------|:---:|------|
| 1 | codebase-memory-mcp 预配置还是用户手动安装？ | Task 1 | scripts/ 目录现有脚本风格 |
| 2 | MCP 查询类工具是否可以免审批？ | Task 1 | mcp-tool.ts:28 requiresApproval |
| 3 | 中文关键词提取用什么分词方案？ | Task 2 | task.description 的实际语言分布 |
| 4 | 三分类的判断粒度——宁严勿松还是宁松勿严？ | Task 2 | conversationHistory 的实际消息分布 |
| 5 | 6 层优先级写 Skill 还是写 agents.md？ | Task 3 | SkillsRouter.route() 触发条件 |
| 6 | 相似性度量用 Jaccard 还是 embedding？ | Task 4 | graph.ts 的 embedding? 字段使用现状 |
| 7 | Dream → KnowledgeGraph 用规则提取还是 LLM 提取？ | Task 4 | dream-consolidator.ts 输出格式 |
| 8 | 时间衰减半衰期按 NodeType 区分还是一刀切？ | Task 4 | 实际 GraphNode 的 type 分布 |
| 9 | validUntil 默认值怎么设？哪些知识类型需要显式过期时间？ | Task 4 | 实际 GraphNode 的 type 分布和内容特征 |
