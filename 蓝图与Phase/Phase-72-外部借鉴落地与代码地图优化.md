# Phase 72：外部借鉴落地与代码地图优化

**目标：** 将 headroom / ponytail / hello-agents / Fugu-Fusion / codebase-memory-mcp 五个外部资源的可借鉴点落地为 RouteDev 的实际能力提升，同时对所有"应避免点"做一次现状审查，确认是否已踩坑或存在踩坑风险。代码地图模块按 5 项优化建议分阶段升级。所有新增配置/模块必须当场接入消费点，杜绝死代码。

**架构：** 四 Part 并行推进——① Agent Profile 模板扩充（Fugu 借鉴，小改）；② 上下文工程增强（headroom + hello-agents 借鉴）；③ 工具系统与可诊断性增强（ponytail + hello-agents 借鉴）；④ 代码地图 5 项优化（codebase-memory-mcp 借鉴）。避免点审查贯穿全程，作为每个 Task 的"反例清单"。

**涉及文件：** 新增约 8 文件，修改约 18 文件。

**前置依赖：** Phase 71（上下文工程增强）已完成；Phase 41/42 代码地图引擎已上线（Phase 71 已接通）；P0 死代码修复（Phase 50/51）已完成。

**严禁死代码原则（继承自 Phase 71）：**
1. 每个新增配置字段必须在同一次 PR 内接入消费点
2. 每个新增模块必须有至少一个调用方
3. 每个新增函数必须有测试覆盖
4. 子 Agent 审计时若发现"配置僵尸"或"孤立模块"，直接标 Critical 阻塞合入

---

## Part A：Agent Profile 模板扩充（Fugu 借鉴，最小改动）

### 背景与现状

RouteDev 已有三套内置 Profile 模板（[agents/profiles/builtin-templates.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/profiles/builtin-templates.ts)）：
- `researcher`：只读调研，产出 research_report
- `executor`：代码实现，产出 code_change
- `reviewer`：代码审查，产出 review_report

Fugu（SAKANA AI）的角色分工思想（thinker / worker / verifier）与 RouteDev 现有模板高度重合，无需大改。但实际多 Agent 协作中存在三类空白场景：任务拆解、独立验证、多源合成。本 Part 通过**新增 3 个模板**（非大改）补齐这些空白，复用现有 ProfileManager / AgentRole 机制。

### Task A1：新增 planner 模板（任务拆解专家）

**目标：** 填补"复杂任务→子任务拆解"的空白。planner 不写代码、不调研，只做任务分解与依赖分析，产出可执行的子任务清单。

**文件：**
- 修改：[src/agents/profiles/types.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/profiles/types.ts)（AgentRole union 扩展 `'planner'`）
- 修改：[src/agents/profiles/builtin-templates.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/profiles/builtin-templates.ts)（新增 PLANNER_PROFILE）
- 修改：[src/agents/profiles/manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/profiles/manager.ts)（注册新模板）
- 新增：`tests/agents/profiles/planner-template.test.ts`

- [ ] **Step 1: 扩展 AgentRole union**
  ```typescript
  // src/agents/profiles/types.ts
  export type AgentRole = 'researcher' | 'executor' | 'reviewer' | 'planner' | 'verifier' | 'synthesizer' | 'custom';
  ```

- [ ] **Step 2: 新增 PLANNER_PROFILE**
  ```typescript
  // src/agents/profiles/builtin-templates.ts
  export const PLANNER_PROFILE: AgentProfile = {
    id: 'builtin-planner',
    name: 'Planner',
    type: 'agent-profile',
    version: BUILTIN_VERSION,
    role: 'planner',
    modelId: 'default',
    description: '任务拆解子 Agent：把复杂目标分解为可执行的子任务序列，标注依赖关系与预估步数，不写代码、不调研细节。',
    systemPrompt: buildSystemPrompt({
      roleLabel: 'Planner（规划者）',
      roleMission: '负责将父 Agent 的复杂目标分解为有序的子任务清单，每个子任务必须可独立执行、可验证、有明确输入输出。',
      forbidden: [
        '禁止直接编写或修改代码。',
        '禁止执行任何有副作用的命令。',
        '禁止把任务拆得过细（单任务 < 5 分钟）或过粗（单任务 > 30 分钟）。',
        '禁止忽略依赖关系，子任务顺序必须可执行。',
      ],
      outputFormatDesc: [
        '输出 task_plan（Markdown）：',
        '1. **目标复述**：一句话确认理解的目标。',
        '2. **子任务清单**：编号列表，每条包含：',
        '   - 任务标题',
        '   - 输入（依赖什么）',
        '   - 输出（产出什么）',
        '   - 预估步数',
        '   - 负责角色（researcher / executor / reviewer）',
        '3. **依赖图**：用 `A → B` 形式标注执行顺序。',
        '4. **风险点**：可选，指出不确定的地方。',
      ].join('\n'),
    }),
    allowedTools: ['read_file', 'code_map_explore', 'analyze_impact'],
    forbiddenTools: ['file_write', 'file_edit', 'execute_command', 'run_tests', 'diff_view'],
    canChallenge: true,
    challengeSeverity: 'warning',
    outputFormat: 'custom',
    boundSkills: [],
    maxTokens: 24000,
    maxSteps: 12,
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
  };
  ```

- [ ] **Step 3: 注册到 BUILTIN_PROFILES 并更新 manager**
  ```typescript
  export const BUILTIN_PROFILES: AgentProfile[] = [
    RESEARCHER_PROFILE,
    PLANNER_PROFILE,      // 新增
    EXECUTOR_PROFILE,
    REVIEWER_PROFILE,
  ];
  ```

- [ ] **Step 4: 更新 AgentRole → outputFormat 映射**
  在 [agents/profiles/types.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/profiles/types.ts) 的 `AgentOutputFormat` 中增加 `'task_plan'`，并在消费方（如 subagent-session.ts）补充对应渲染逻辑。

- [ ] **Step 5: 验证**
  - 测试：`planner-template.test.ts` 验证 profile 字段完整性 + allowedTools 不与 forbiddenTools 冲突
  - 接入测试：`/goal` 流程中可选用 planner 做前置拆解

### Task A2：新增 verifier 模板（独立验证者）

**目标：** 填补"结果验证"的空白。与 reviewer 区别：reviewer 审查代码质量（风格/可读性/安全性），verifier 只验证功能正确性（按契约跑测试、对照预期输出）。借鉴 Fugu 的 verifier 角色 + Fusion 的判官分析机制。

**文件：**
- 修改：[src/agents/profiles/builtin-templates.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/profiles/builtin-templates.ts)（新增 VERIFIER_PROFILE）
- 新增：`tests/agents/profiles/verifier-template.test.ts`

- [ ] **Step 1: 新增 VERIFIER_PROFILE**
  ```typescript
  export const VERIFIER_PROFILE: AgentProfile = {
    id: 'builtin-verifier',
    name: 'Verifier',
    type: 'agent-profile',
    version: BUILTIN_VERSION,
    role: 'verifier',
    modelId: 'default',
    description: '独立验证子 Agent：按委托契约跑测试、对照预期输出，产出验证报告，不做代码审查、不提改进建议。',
    systemPrompt: buildSystemPrompt({
      roleLabel: 'Verifier（验证者）',
      roleMission: '负责独立验证 Executor 产出的代码是否符合委托契约的功能契约，跑测试 + 对照预期，给出 pass/fail 结论。',
      forbidden: [
        '禁止提代码改进建议（那是 Reviewer 的工作）。',
        '禁止修改任何文件。',
        '禁止跳过测试直接 pass（除非契约明确豁免）。',
        '禁止仅凭"看起来对"就 pass，必须有测试或对照证据。',
      ],
      outputFormatDesc: [
        '输出 verification_report（Markdown）：',
        '1. **结论**：pass / fail / partial_pass。',
        '2. **验证清单**：每条契约项 → 测试命令 → 结果（pass/fail）。',
        '3. **失败详情**：fail 项必须附实际输出 vs 预期输出对比。',
        '4. **覆盖率**：列出未覆盖的契约项。',
      ].join('\n'),
    }),
    allowedTools: ['read_file', 'execute_command', 'run_tests', 'diff_view'],
    forbiddenTools: ['file_write', 'file_edit', 'code_map_explore', 'find_callers', 'find_callees', 'analyze_impact'],
    canChallenge: true,
    challengeSeverity: 'blocking',
    outputFormat: 'custom',
    boundSkills: [],
    maxTokens: 16000,
    maxSteps: 10,
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
  };
  ```

- [ ] **Step 2: 注册到 BUILTIN_PROFILES**
- [ ] **Step 3: 测试 + 接入 `/goal` 验证流程**

### Task A3：新增 synthesizer 模板（多源合成者）

**目标：** 填补"多 Agent 输出合成"的空白。借鉴 Fusion 的合成器角色——收集多个 Agent 的输出，找共识/矛盾/盲点，合成最终答案。与 reviewer 区别：reviewer 是单向审查，synthesizer 是融合多源。

**文件：**
- 修改：[src/agents/profiles/builtin-templates.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/profiles/builtin-templates.ts)（新增 SYNTHESIZER_PROFILE）
- 新增：`tests/agents/profiles/synthesizer-template.test.ts`

- [ ] **Step 1: 新增 SYNTHESIZER_PROFILE**
  ```typescript
  export const SYNTHESIZER_PROFILE: AgentProfile = {
    id: 'builtin-synthesizer',
    name: 'Synthesizer',
    type: 'agent-profile',
    version: BUILTIN_VERSION,
    role: 'synthesizer',
    modelId: 'default',
    description: '多源合成子 Agent：收集多个 Agent 的输出，分析共识/矛盾/盲点，合成最终答案。',
    systemPrompt: buildSystemPrompt({
      roleLabel: 'Synthesizer（合成者）',
      roleMission: '负责把多个子 Agent 的输出合成为一份最终答案，重点处理共识（采纳）、矛盾（裁定）、盲点（补全）。',
      forbidden: [
        '禁止简单投票决定（已烂大街）。',
        '禁止忽略矛盾点，矛盾必须显式裁定。',
        '禁止新增任何超出输入范围的信息（不能编造）。',
      ],
      outputFormatDesc: [
        '输出 synthesis_report（Markdown）：',
        '1. **最终答案**：合成的结论。',
        '2. **共识点**：多 Agent 一致的部分。',
        '3. **矛盾裁定**：分歧点 + 裁定理由。',
        '4. **盲点补全**：所有 Agent 都未覆盖但必要的部分。',
        '5. **来源标注**：每条结论标注来自哪个 Agent 的输出。',
      ].join('\n'),
    }),
    allowedTools: ['read_file'],
    forbiddenTools: ['file_write', 'file_edit', 'execute_command', 'run_tests', 'diff_view', 'code_map_explore'],
    canChallenge: true,
    challengeSeverity: 'blocking',
    outputFormat: 'custom',
    boundSkills: [],
    maxTokens: 32000,
    maxSteps: 15,
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
  };
  ```

- [ ] **Step 2: 注册 + 接入 `multi/orchestrator.ts`**
  在 [agent/multi/orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) 的协作流程末尾，当多个 worker 产出冲突时，自动派生 synthesizer 做合成。

- [ ] **Step 3: 测试**

### Part A 避免点审查

| 避免点 | RouteDev 现状 | 审查结论 |
|---|---|---|
| Fugu 简单投票机制 | `multi/blackboard.ts` 未用投票 | ✅ 未踩坑 |
| Fusion 风险对冲变省钱凑合 | modelRouter 有降级机制，未盲目追求多模型 | ✅ 未踩坑 |
| 角色膨胀（模板过多）| 当前 3 个，本 Phase 后 6 个 | ⚠️ 需观察：6 个已是上限，后续若再加必须删除或合并现有模板 |
| 模板与 multi orchestrator 耦合 | synthesizer 必须由 orchestrator 触发，不能让用户手动调用 | 已在 Step 2 体现 |

---

## Part B：上下文工程增强（headroom + hello-agents 借鉴）

### Task B1：CacheAligner 前缀稳定化（headroom 借鉴）

**目标：** 让 Anthropic `cache_control` / OpenAI prefix cache 真正命中。把 system prompt 中的动态部分（日期/UUID/session token/工作目录）抽到尾部，让前缀字节稳定。

**文件：**
- 修改：[src/agent/context/system-prompt-builder.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context/system-prompt-builder.ts)（出口加 dynamic-tail 抽离）
- 新增：`tests/agent/context/system-prompt-stability.test.ts`

- [ ] **Step 1: 识别动态片段**
  扫描 system prompt 中的动态字段：当前日期、session_id、cwd、用户偏好中的时间戳、route_decision（每轮不同）。

- [ ] **Step 2: 重排 prompt 结构**
  ```
  [静态前缀]
  - 角色定位
  - 工具列表
  - 上下文工程纪律
  - Skill 内容
  [动态尾部]
  - 当前日期 / cwd / session_id
  - route_decision
  - 用户偏好（含时间戳）
  ```

- [ ] **Step 3: 验证 prefix cache 命中率**
  对比重排前后同一会话内连续 5 轮请求的 prompt 前缀哈希，命中率应 ≥ 90%。

### Task B2：ContentRouter 按内容类型分派压缩（headroom 借鉴）

**目标：** 当前 `tool-output-pipeline.ts` 一刀切文本压缩。改为按内容类型分派：JSON 走统计采样、代码走 AST 摘要、散文走现有 ksentence-compressor。<200 token 直通。

**文件：**
- 修改：[src/agent/memory/tool-output-pipeline.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/tool-output-pipeline.ts)
- 新增：`src/agent/memory/content-router.ts`（内容类型检测 + 分派）
- 新增：`src/agent/memory/compressors/json-sampler.ts`（JSON 统计采样）
- 新增：`src/agent/memory/compressors/code-ast-summary.ts`（代码 AST 摘要）

- [ ] **Step 1: 实现 ContentRouter**
  ```typescript
  // 检测策略：先尝试 JSON.parse → JSON 路径；含 file extension 标记 → 代码路径；否则 → 散文
  export function routeCompress(content: string, toolName: string): CompressStrategy {
    if (content.length < 200) return 'passthrough';
    if (toolName === 'file_read' && looksLikeJson(content)) return 'json-sampler';
    if (toolName === 'file_read' && looksLikeCode(content)) return 'code-ast-summary';
    return 'ksentence'; // 现有策略
  }
  ```

- [ ] **Step 2: 实现 json-sampler**
  对 JSON 工具结果做统计采样：保留 top-level keys + 数组长度 + 数组前后各 3 项 + 数值字段统计（min/max/avg）。

- [ ] **Step 3: 实现 code-ast-summary**
  复用 `code-map/extractor.ts` 的 tree-sitter 解析，提取函数签名 + 类结构 + import 列表，丢弃函数体。

- [ ] **Step 4: 接入 tool-output-pipeline**
  在 pipeline 入口调用 `routeCompress`，按策略分派到不同压缩器。

### Task B3：CCR 可逆压缩落 SQLite + ccr-retrieve 工具接通（headroom 借鉴）

**目标：** 当前 `ccr-cache.ts` 是内存 Map（maxSize=50，进程退出即丢），且 `tools/builtin/ccr-retrieve.ts` 是占位死代码。改为 SQLite 持久化 + 接通 retrieve 工具。

**文件：**
- 修改：[src/agent/memory/ccr-cache.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/ccr-cache.ts)（存储层换 SQLite）
- 修改：[src/tools/builtin/ccr-retrieve.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/ccr-retrieve.ts)（接通实际调用）
- 新增：`tests/agent/memory/ccr-cache-sqlite.test.ts`

- [ ] **Step 1: CCR 存储层迁移到 SQLite**
  ```typescript
  // 用 node:sqlite 在 ~/.routedev/ccr.db 创建 ccr_cache 表
  // 字段：marker (TEXT PK) / original_content (TEXT) / created_at (INTEGER) / token_count (INTEGER)
  // LRU 淘汰：按 created_at 升序删除超出 maxSize 的记录
  ```

- [ ] **Step 2: ccr-retrieve 工具接通**
  ```typescript
  // tools/builtin/ccr-retrieve.ts
  // 从占位死代码改为实际调用 ccrCache.retrieve(marker)
  ```

- [ ] **Step 3: 测试 + 接入 Agent Loop**
  Agent 在压缩工具结果时收到 marker，需要时主动调用 ccr_retrieve 工具取回原始内容。

### Task B4：System Prompt 分区模板 + reserve_ratio（hello-agents 第九章借鉴）

**目标：** system-prompt-builder 输出固定骨架 [Role&Policies / Task / State / Evidence / Context / Output]，budget-monitor 为 system 预留 20%。

**文件：**
- 修改：[src/agent/context/system-prompt-builder.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context/system-prompt-builder.ts)
- 修改：[src/agent/memory/budget-monitor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/budget-monitor.ts)（reserve_ratio 字段）

- [ ] **Step 1: 分区模板**
  ```typescript
  export interface SystemPromptSections {
    roleAndPolicies: string;   // 角色 + 绝对规则 + 禁止事项
    task: string;              // 当前任务描述
    state: string;             // 会话状态（已完成的步骤、当前位置）
    evidence: string;          // 证据（代码地图、文件内容摘要）
    context: string;           // 上下文（用户偏好、Skill、记忆）
    output: string;            // 输出格式要求
  }
  export function buildSectionedPrompt(s: SystemPromptSections): string {
    return [
      '# 角色与策略', s.roleAndPolicies,
      '# 任务', s.task,
      '# 状态', s.state,
      '# 证据', s.evidence,
      '# 上下文', s.context,
      '# 输出', s.output,
    ].join('\n\n');
  }
  ```

- [ ] **Step 2: reserve_ratio 预留**
  budget-monitor 增加 `reserveRatio: number`（默认 0.2），计算可用预算时 `available = total * (1 - reserveRatio)`，预留部分只给 system prompt 用。

### Task B5：ContextPacket 评分选择（hello-agents 第九章借鉴）

**目标：** 当前 `token-aware-slicer.ts` 是纯顺序裁剪（保留最新 N 条）。改为评分选择：relevance 0.7 + recency 0.3。

**文件：**
- 修改：[src/agent/memory/token-aware-slicer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/token-aware-slicer.ts)
- 新增：`tests/agent/memory/context-packet-scoring.test.ts`

- [ ] **Step 1: 定义 ContextPacket**
  ```typescript
  interface ContextPacket {
    content: string;
    timestamp: number;
    tokenCount: number;
    relevanceScore: number;  // 0-1，基于与当前 query 的语义相关度
  }
  function scorePacket(p: ContextPacket, now: number): number {
    const recency = Math.exp(-(now - p.timestamp) / 3600000); // 1小时衰减
    return p.relevanceScore * 0.7 + recency * 0.3;
  }
  ```

- [ ] **Step 2: 替换纯顺序裁剪**
  在 token-aware-slicer 的 slice 函数中，先按 scorePacket 排序，再从高到低选取直到预算耗尽。

### Part B 避免点审查

| 避免点 | RouteDev 现状 | 审查结论 |
|---|---|---|
| 把所有信息丢长上下文窗口（>100k token）| auto-compact-guardian 在 80% 触发压缩 | ✅ 未踩坑 |
| 幻觉摘要被反复引用 | 摘要无校验机制 | ⚠️ 风险点：B2 的 code-ast-summary 必须保留原始签名 verbatim，不能 LLM 重写 |
| 上下文隔离不足 | multi/branch-orchestrator 提供物理隔离 | ✅ 未踩坑 |
| ML 模型依赖（headroom 坑）| RouteDev 纯 TS，无 ML 模型 | ✅ 未踩坑，B2/B3 保持纯统计/AST，禁止引入 ML |
| Python+Rust+TS 三语言双轨（headroom 坑）| 单 TS | ✅ 未踩坑，本 Part 不引入新语言 |

---

## Part C：工具系统与可诊断性增强（ponytail + hello-agents 借鉴）

### Task C1：工具返回 status 三态化（hello-agents Extra09 借鉴）

**目标：** file-edit / grep / glob 等工具返回值统一为 `{status, data, error}`，区分 NOT_FOUND / CONFLICT / PARTIAL，让模型针对性纠错而非瞎猜重试。

**文件：**
- 修改：[src/tools/builtin/file-edit.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/file-edit.ts)
- 修改：[src/tools/builtin/grep.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/grep.ts)（或 file-search.ts）
- 修改：[src/tools/builtin/glob.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/glob.ts)（或 file-search.ts）
- 新增：`src/tools/types.ts`（ToolResult 三态类型定义）

- [ ] **Step 1: 定义三态类型**
  ```typescript
  // src/tools/types.ts
  export type ToolStatus = 'success' | 'partial' | 'error';
  export type ToolErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNKNOWN';
  export interface StructuredToolResult {
    status: ToolStatus;
    data?: unknown;
    error?: { code: ToolErrorCode; message: string };
  }
  ```

- [ ] **Step 2: file-edit 返回 CONFLICT**
  file-edit 在文件被并发修改时返回 `{status: 'error', error: {code: 'CONFLICT', message: '文件已被修改，请重新读取'}}`。

- [ ] **Step 3: grep/glob 返回 NOT_FOUND**
  无匹配时返回 `{status: 'partial', error: {code: 'NOT_FOUND', message: '无匹配结果'}}`，让模型知道该换查询条件而非重试。

- [ ] **Step 4: 测试 + 验证 Agent 纠错率提升**

### Task C2：Read→Edit 乐观锁（hello-agents Extra09 借鉴）

**目标：** file-edit 注入 `file_mtime_ms` + `file_size_bytes`，CONFLICT 时强制重读。防并发修改导致"半改"文件。

**文件：**
- 修改：[src/tools/builtin/file-read.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/file-read.ts)（返回值附 mtime/size）
- 修改：[src/tools/builtin/file-edit.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/file-edit.ts)（校验 mtime/size）
- 新增：`tests/tools/builtin/file-edit-optimistic-lock.test.ts`

- [ ] **Step 1: file-read 返回附 mtime/size**
  ```typescript
  // file-read.ts execute 返回值新增元数据
  return {
    content: fileContent,
    metadata: { mtimeMs: stat.mtimeMs, sizeBytes: stat.size },
  };
  ```

- [ ] **Step 2: file-edit 校验 mtime/size**
  ```typescript
  // file-edit.ts execute 入参增加 expectedMtimeMs / expectedSizeBytes（可选）
  // 若提供且与当前文件不匹配，返回 CONFLICT
  if (args.expectedMtimeMs && args.expectedMtimeMs !== currentStat.mtimeMs) {
    return { status: 'error', error: { code: 'CONFLICT', message: '文件已被修改' } };
  }
  ```

### Task C3：5 级决策阶梯嵌入代码任务 system prompt（ponytail 借鉴）

**目标：** ponytail 的 7 级决策阶梯简化为 5 级，嵌入代码任务 system prompt：YAGNI → 复用现有 → stdlib/native → 已装依赖 → 最小实现。

**文件：**
- 修改：[src/agent/context/system-prompt-builder.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context/system-prompt-builder.ts)（代码任务分支注入阶梯）
- 新增：`src/agent/context/lazy-coder-ladder.ts`（阶梯 prompt 片段）

- [ ] **Step 1: 定义阶梯片段**
  ```typescript
  // src/agent/context/lazy-coder-ladder.ts
  export const LAZY_CODER_LADDER = `
  # 代码实现决策阶梯（按顺序判断，命中即停）
  1. **YAGNI**：这个功能真的需要存在吗？能否用注释占位延后实现？
  2. **复用现有**：codebase 中是否已有类似功能可调用？先 grep 再写。
  3. **stdlib / native**：能否用语言标准库 / 内置 API 实现？
  4. **已装依赖**：package.json 中已有的依赖能否满足？
  5. **最小实现**：必须新增代码时，写最少行数、最少抽象的版本。

  # 永不裁剪清单（即使省 token 也不能删）
  - 安全边界校验（输入验证、权限检查、SQL 注入防护）
  - 防数据丢失的错误处理（事务、备份、回滚）
  - 可访问性（a11y）
  - 并发安全（锁、原子操作）
  `;
  ```

- [ ] **Step 2: 在 system-prompt-builder 检测代码任务时注入**
  当用户消息含"实现/修改/编写/修复 + 代码"关键词时，把 `LAZY_CODER_LADDER` 追加到 task 分区。

### Task C4：BFCL 风格工具调用评估 + irrelevance 用例（hello-agents 第十二章借鉴）

**目标：** evaluation/ 增加 AST 匹配评估器，专门测"不该调工具时能否拒绝"。衡量 skill 路由准确性，防工具滥用。

**文件：**
- 新增：`src/evaluation/bfcl-tool-evaluator.ts`
- 新增：`src/evaluation/cases/irrelevance-cases.ts`
- 新增：`tests/evaluation/bfcl-tool-evaluator.test.ts`

- [ ] **Step 1: 定义 irrelevance 用例**
  ```typescript
  // 不该调工具的场景：
  // - 用户闲聊（"今天天气不错"）→ 期望 0 工具调用
  // - 用户问知识（"什么是闭包"）→ 期望 0 工具调用
  // - 用户表达情绪（"这个 bug 烦死了"）→ 期望 0 工具调用
  ```

- [ ] **Step 2: 实现 AST 匹配评估器**
  对每个用例，记录 Agent 实际调用的工具列表，与期望列表做 AST 匹配（工具名 + 关键参数）。

- [ ] **Step 3: 接入 evaluation/runner.ts**
  作为新评估维度，输出 `tool_call_accuracy` + `irrelevance_rejection_rate`。

### Part C 避免点审查

| 避免点 | RouteDev 现状 | 审查结论 |
|---|---|---|
| 一步到位堆砌多智能体 + Plan-Execute + 多层记忆 | Phase 31 已有 work-modes ≤3 档 | ✅ 未踩坑 |
| shell-exec 开绿灯允许任意管道走主链路 | 需确认 shell-exec.ts 是否禁管道 | ⚠️ 需审查：C1 完成后补一个 shell-exec 管道白名单检查 |
| 模式膨胀（ponytail 4 档 × 多平台）| work-modes.ts 单点定义 | ✅ 未踩坑 |
| 纯 prompt 无工具落地（ponytail 坑）| C3 阶梯是纯 prompt，但有 C1/C2 工具层强制 | ✅ 已对冲 |
| 工具过度原子化（hello-agents Extra09 坑）| 当前工具粒度合理 | ⚠️ 需定期跑 granularity-auditor（如已存在）|

---

## Part D：代码地图 5 项优化（codebase-memory-mcp 借鉴）

### Task D1：Team-Shared Graph Artifact（最高 ROI）

**目标：** 借鉴 codebase-memory-mcp 的 `.codebase-memory/graph.db.zst` 模式。索引完成后 `VACUUM INTO` + zstd 压缩导出 `.routedev/code-map.db.zst`，提交到 repo。新机器先导入 artifact 再补 diff，避免全量重建。

**文件：**
- 修改：[src/code-map/indexer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/indexer.ts)（新增 exportArtifact / importArtifact）
- 新增：`src/code-map/artifact.ts`（zstd 压缩 + VACUUM INTO）
- 新增：`.gitattributes`（`merge=ours` for `.routedev/code-map.db.zst`）
- 新增：`tests/code-map/artifact.test.ts`

- [ ] **Step 1: 实现 exportArtifact**
  ```typescript
  // 全量索引完成后调用
  export async function exportArtifact(db: Database, repoRoot: string): Promise<void> {
    const artifactPath = path.join(repoRoot, '.routedev', 'code-map.db.zst');
    // 1. VACUUM INTO 临时文件（去掉碎片）
    const tmpPath = artifactPath + '.tmp';
    await db.exec(`VACUUM INTO '${tmpPath}'`);
    // 2. zstd 压缩（用 @mongodb-js/zstd 或 zlib）
    await zstdCompress(tmpPath, artifactPath);
    await fs.unlink(tmpPath);
  }
  ```

- [ ] **Step 2: 实现 importArtifact**
  ```typescript
  // 新机器首次启动时调用
  export async function importArtifact(repoRoot: string): Promise<Database | null> {
    const artifactPath = path.join(repoRoot, '.routedev', 'code-map.db.zst');
    if (!await pathExists(artifactPath)) return null;
    const dbPath = path.join(repoRoot, '.routedev', 'code-map.db');
    await zstdDecompress(artifactPath, dbPath);
    // 后续 incrementalIndex 会补 diff
    return openDatabase(dbPath);
  }
  ```

- [ ] **Step 3: 接入 indexer.ts**
  fullIndex 完成后自动调 exportArtifact；启动时先尝试 importArtifact，失败再 fullIndex。

- [ ] **Step 4: .gitattributes 配置**
  ```
  .routedev/code-map.db.zst merge=ours
  ```

### Task D2：BM25 + camelCase/snake_case 感知分词

**目标：** 当前 `getNodeByName` 是精确匹配，符号搜索弱。借鉴 codebase-memory-mcp 的 `cbm_camel_split` 分词器，给 SQLite FTS5 表加 BM25 索引。

**文件：**
- 修改：[src/code-map/database.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/database.ts)（新增 nodes_fts 虚拟表）
- 修改：[src/code-map/querier.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/querier.ts)（searchBySymbolName 用 FTS5）
- 新增：`src/code-map/camel-split-tokenizer.ts`（自定义分词器）

- [ ] **Step 1: 注册自定义分词器**
  ```typescript
  // node:sqlite 支持注册 JS 分词器
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      name,
      qualified_name,
      tokenize = 'javascript camel_split'
    );
  `);
  ```

- [ ] **Step 2: 实现 camel_split 分词器**
  ```typescript
  // 把 getFileStructure → ['get', 'file', 'structure']
  // 把 get_file_structure → ['get', 'file', 'structure']
  // 用户搜 "file structure" 也能命中
  ```

- [ ] **Step 3: 索引时写入 FTS5**
  extractor 提取节点后，同步写入 nodes_fts。

- [ ] **Step 4: querier.searchBySymbolName 改用 FTS5**
  ```sql
  SELECT * FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts) LIMIT 20
  ```

### Task D3：git diff 影响分析带风险分级

**目标：** 当前 `analyzeImpact` 只列出受影响符号。借鉴 codebase-memory-mcp 的 `detect_changes`，按「调用方数量 / 是否 entry point / 是否跨包」做 risk classification。

**文件：**
- 修改：[src/code-map/querier.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/querier.ts)（analyzeImpact 输出加 risk 字段）

- [ ] **Step 1: 定义风险分级规则**
  ```typescript
  // high：调用方 > 10 或 是 entry point（如 main / exported function）或 跨包
  // medium：调用方 3-10 或 同包内跨文件
  // low：调用方 < 3 或 仅同文件内
  function classifyRisk(node: GraphNode, callers: GraphNode[]): 'high' | 'medium' | 'low' {
    if (callers.length > 10 || node.isEntryPoint || node.crossPackage) return 'high';
    if (callers.length >= 3) return 'medium';
    return 'low';
  }
  ```

- [ ] **Step 2: analyzeImpact 输出加 risk**
  每个受影响符号附带 risk 字段，输出按 risk 降序排列。

### Task D4：Hybrid 类型解析（聚焦 TS/Python）

**目标：** 当前 `resolveCrossFileCalls` 只做名称匹配。借鉴 codebase-memory-mcp 的 Hybrid LSP 思路（但不引入 LSP 二进制），用轻量 TS AST 解析做跨文件类型解析。**只做 TS/Python 两种语言**，不追求 11 语言。

**文件：**
- 新增：`src/code-map/type-resolver.ts`
- 修改：[src/code-map/extractor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/extractor.ts)（提取后调 type-resolver refine CALLS 边）

- [ ] **Step 1: TS 跨文件 symbol table**
  用 web-tree-sitter 解析 import 语句，建立 file → exported symbols 映射。

- [ ] **Step 2: refine CALLS 边**
  对每个 CALLS 边，如果 target 是 imported symbol，解析到具体文件的 definition 节点，更新 edge.target 为节点 ID（而非字符串）。

- [ ] **Step 3: Python 跨文件 symbol table**
  用 tree-sitter-python 解析 from...import 语句，同 Step 2。

- [ ] **Step 4: 测试跨文件调用解析率**
  对 RouteDev 自身代码库跑一遍，对比 refine 前后 CALLS 边的 resolved 率（target 是节点 ID 而非字符串的比例）。

### Task D5：openCypher 查询子集（长期，可选）

**目标：** 当前 querier.ts 是固定函数式 API，复杂查询写不出来。借鉴 `query_graph` 暴露 openCypher 只读子集（MATCH / WHERE / EXISTS / 变量长路径），让 Agent 自己组合查询。

**文件：**
- 新增：`src/code-map/cypher/lexer.ts`
- 新增：`src/code-map/cypher/parser.ts`
- 新增：`src/code-map/cypher/planner.ts`
- 新增：`src/tools/builtin/code-graph-cypher.ts`（高阶工具）
- 新增：`tests/code-map/cypher/*.test.ts`

- [ ] **Step 1: 实现 lexer**
  支持 MATCH / WHERE / EXISTS / RETURN / ORDER BY / 变量长路径 `[*1..3]`。

- [ ] **Step 2: 实现 parser**
  生成 AST。

- [ ] **Step 3: 实现 planner**
  AST → SQL 查询计划（在现有 nodes/edges 表上执行）。

- [ ] **Step 4: 注册为 Agent 工具**
  ```typescript
  // tools/builtin/code-graph-cypher.ts
  // 参数：query (Cypher 字符串)
  // 返回：节点 + 边列表
  ```

- [ ] **Step 5: 标注为可选**
  本 Task 复杂度高，建议作为 Phase 72 的 stretch goal，优先完成 D1-D4。

### Part D 避免点审查

| 避免点 | RouteDev 现状 | 审查结论 |
|---|---|---|
| 照搬纯 C 静态二进制架构 | TS + node:sqlite + web-tree-sitter | ✅ 未踩坑，D1-D5 保持 TS |
| 追求 158 语言全覆盖 | 当前 4 语言 | ✅ 未踩坑，D4 只加 TS/Python 深度解析 |
| 引入内嵌向量模型做语义搜索 | PageRank + 符号结构 | ✅ 未踩坑，D2 用 BM25 即可，不引入向量模型 |
| 团队共享 artifact 体积膨胀 | 无 artifact | ⚠️ 需预防：D1 的 zstd 压缩比应 ≥ 8:1，否则不提交 repo |
| 自定义分词器跨平台兼容 | node:sqlite JS 分词器 | ⚠️ 需测试：D2 的 camel_split 在 Windows/Linux 表现一致 |

---

## 全局避免点审查（跨 Part）

以下避免点来自所有外部资源，统一审查 RouteDev 现状：

| 避免点 | 来源 | RouteDev 现状 | 审查结论 |
|---|---|---|---|
| ML 模型依赖 | headroom | 纯 TS，无 ML | ✅ Phase 72 全程禁止引入 ML |
| 三语言双轨 | headroom | 单 TS | ✅ 禁止引入 Rust crate |
| 多平台 manifest 强耦合 | ponytail | skills/ + import/ 单源→多目标 | ✅ 坚持单源生成 |
| 模式膨胀 | ponytail | work-modes ≤3 档 | ✅ 不新增模式 |
| 简单投票 | Fugu/Fusion | blackboard 无投票 | ✅ synthesizer 必须裁定不能投票 |
| 长上下文窗口解决一切 | hello-agents | auto-compact 80% 触发 | ✅ 未踩坑 |
| 一步到位堆多智能体 | hello-agents | Phase 31 已有 | ✅ 未踩坑 |
| 工具过度原子化 | hello-agents | 当前合理 | ⚠️ 需定期跑 granularity-auditor |
| 纯 C 二进制 | codebase-memory-mcp | TS | ✅ 保持 TS |
| 158 语言全覆盖 | codebase-memory-mcp | 4 语言 | ✅ 聚焦 6-8 语言做深 |
| 内嵌向量模型 | codebase-memory-mcp | PageRank | ✅ 不引入向量模型 |

---

## 执行顺序与依赖

```
Part A（Profile 模板）        独立，可先做
  └─ A1 planner → A2 verifier → A3 synthesizer

Part B（上下文工程）          A 完成后做（B 用 synthesizer）
  └─ B1 CacheAligner → B2 ContentRouter → B3 CCR SQLite
     B4 分区模板（独立）→ B5 ContextPacket（依赖 B4）

Part C（工具系统）            独立，可与 A/B 并行
  └─ C1 三态化 → C2 乐观锁（依赖 C1）
     C3 阶梯（独立）
     C4 BFCL 评估（独立）

Part D（代码地图）            独立，可与 A/B/C 并行
  └─ D1 Artifact（最高优先）
     D2 BM25（独立）
     D3 风险分级（独立）
     D4 类型解析（依赖 D2）
     D5 Cypher（stretch goal，可选）
```

## 验收标准

每个 Task 完成后子 Agent 审查清单：
1. 新增配置字段是否有消费点？
2. 新增模块是否有调用方？
3. 新增函数是否有测试？
4. 是否引入了"避免点"中的坑？
5. 是否保持纯 TS（无 ML / 无 Rust / 无 C 二进制）？
6. Profile 模板是否 ≤6 个（A 完成后）？
7. 工作模式是否 ≤3 档？

## 里程碑

- **M1（Part A 完成）**：6 个内置 Profile 模板上线，`/goal` 可选用 planner/verifier/synthesizer
- **M2（Part B 完成）**：prefix cache 命中率 ≥90%，CCR 支持 SQLite 持久化 + retrieve 工具
- **M3（Part C 完成）**：工具返回三态化，file-edit 支持乐观锁，BFCL 评估上线
- **M4（Part D 完成）**：代码地图支持 team-shared artifact，BM25 符号搜索，风险分级
- **M5（全部完成）**：子 Agent 终审通过，无死代码，无避免点踩坑

---

## 参考资源

- [headroom GitHub](https://github.com/headroomlabs-ai/headroom)
- [ponytail GitHub](https://github.com/DietrichGebert/ponytail)
- [hello-agents GitHub](https://github.com/datawhalechina/hello-agents)
- [codebase-memory-mcp GitHub](https://github.com/DeusData/codebase-memory-mcp)
- Fugu/Fusion 编排秘密 SRT（本地文件：`C:\Users\杨铭\Desktop\AI Note\便宜模型组合打败 Fable 5？Fugu 和 Fusion 的编排秘密.srt`）
