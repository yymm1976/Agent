# Phase 43 — 子 Agent 上下文控制与自主配置体系

> **版本目标：** v3.4.0
> **前置依赖：** Phase 42（v3.3.0 代码地图引擎落地、多 Agent 编排升级、Skill/Hook 市场、策略引擎）完成
> **新增测试要求：** ≥ 78 个
> **研究依据：** 与用户关于 Vibe Coding 中子 Agent 问题的三次讨论；RouteDev 当前多 Agent 实现（`src/agent/multi/*.ts`、`src/harness/experiment-*.ts`）；CUGA Agent 的 CugaSupervisor / Policy SDK / SKILL.md 设计；代码地图（Phase 41-42）作为共享上下文基础设施；OpenAI Codex `/goal` 命令的目标持久化、完成审计与 token 预算软停止设计
> **核心命题：** 当前大模型处理复杂问题时倾向于拆分子 Agent 并发执行，但子 Agent 既费 token（重复调研项目）又效果差（缺乏角色边界和上下文控制）。本 Phase 不否定子 Agent 的价值，而是把它从"父 Agent 的廉价分身"升级为"可自主配置、有明确角色、受委托契约约束的专家执行单元"。同时，本 Phase 将 `/goal` 命令从"自动分解后闷头执行"升级为"需求澄清 → 计划确认 → 结构化执行 → 独立审计 → 用户采纳"的完整目标生命周期；并将 Hook 从"简单的 shell 命令触发器"升级为"覆盖 /goal 全生命周期、支持函数型 Hook、可组合、可沙箱试用的可插拔监管体系"。关键是：共享上下文必须经过筛选而非全量复制；子 Agent 的模型、提示词、技能、工具集必须可在 RouteDev 设置页面中自定义；父 Agent 对子 Agent 的调用必须受到时机和契约约束；`/goal` 的目标完成必须由独立审计器判定而非模型自评。

---

## 项目现状审计与可行性结论

### 1. 已具备的实现基础

| 模块 | 当前状态 | 本 Phase 可复用度 |
|------|---------|------------------|
| `src/agent/multi/orchestrator.ts` | LLM 依赖分析 + 拓扑排序 + Worker 执行 | 高（作为委托门控和策略选择基础） |
| `src/agent/multi/blackboard.ts` | 共享内存、快照、格式化 | 高（扩展为分层共享上下文池） |
| `src/agent/multi/worker-executor.ts` | Worker 执行、上下文过滤、重试回滚 | 高（升级为子 Agent 执行器） |
| `src/agent/multi/branch-orchestrator.ts` | /goal → 分支任务 → 拓扑执行 | 高（接入委托契约和子 Agent Profile） |
| `src/agent/execution-orchestrator.ts` | 单/多 Agent 自适应执行 | 高（接入子 Agent 调用门控） |
| `src/skills/skill-generator.ts` + Skill 市场 | Skill 生成、市场、导入导出 | 高（Agent Profile 即一种 Skill） |
| `src/code-map/`（Phase 42） | tree-sitter + SQLite 代码知识图谱 | 高（作为上下文筛选的数据源） |
| `src/policies/`（Phase 42 Task 7） | Policy Engine | 高（约束父 Agent 委托行为） |
| `src/router/tracker.ts` | Token 追踪 | 高（统计子 Agent token 成本与效果） |

### 2. 尚未落地的关键缺口

| 缺口 | 影响 | 本 Phase 处理方式 |
|------|------|------------------|
| 无子 Agent Profile 体系 | 所有子 Agent 用同一模型/prompt，无法因材施教 | Task 1 在设置页面引入 Agent Profile 配置 |
| 子 Agent 继承父 Agent 全量上下文 | 上下文爆炸、token 浪费、噪声干扰 | Task 2 引入上下文筛选与打包机制 |
| 无委托契约 | 子 Agent 权限不清、可能擅自改目标/扩范围 | Task 3 定义 DelegationContract + 质疑机制 |
| 无内置角色模板 | 用户不知如何配置子 Agent | Task 4 内置 researcher / executor / reviewer 模板 |
| 父 Agent 随意创建子 Agent | 过度拆分、无效并发 | Task 5 引入委托门控（Delegation Gate） |
| 子 Agent 生命周期不可见 | 无法追踪、无法审计 | Task 6 接入图状态机和 Score Card |

### 3. 可行性总评

- **子 Agent Profile 体系：** 高度可行。RouteDev 已有 Skill 市场和 PromptManager，Agent Profile 可以复用同一套元数据、打包、加载机制。
- **上下文筛选与打包：** 可行。Phase 42 的自研代码地图引擎提供项目结构和符号级依赖；Blackboard 提供运行时事实；项目记忆提供历史经验。三者组合可生成精简的共享上下文包。
- **委托契约与质疑机制：** 可行。本质是 system prompt 约束 + Hook/状态机拦截，不需要引入复杂协议。
- **内置角色模板：** 高度可行。三种角色（调研/执行/审查）职责清晰，可直接作为默认配置内置。
- **委托门控：** 可行。可在 `BranchOrchestrator` / `ExecutionOrchestrator` 中增加前置检查，也可用 Phase 42 的 Policy Engine 实现。

---

## 核心设计原则

### 原则 1：子 Agent 是专家，不是分身

子 Agent 不是为了"替父 Agent 省上下文"而存在的廉价劳动力，而是**在特定边界内执行特定任务的专家**。每个子 Agent 必须有：
- 明确的角色（researcher / executor / reviewer / 自定义）
- 专属的模型、提示词、技能、工具集
- 受限的读写权限
- 清晰的交付物格式

### 原则 2：共享上下文必须筛选，不能全量复制

父 Agent 不能把整个对话历史、所有已读文件、所有中间思考都塞给子 Agent。共享上下文只应包含：
- **项目现状**：代码地图、关键文件结构
- **任务边界**：设计文档、可读写文件白名单
- **父 Agent 经验**：项目记忆、历史踩坑点、已知约束
- **必要事实**：与本次任务直接相关的符号、类型、接口契约

### 原则 3：服从是默认，质疑是例外

子 Agent 必须服从委托契约，但保留在以下情况停止并上报警告的权利：
- 设计文档与代码现实冲突
- 任务边界不清晰或不可能完成
- 需要超出授权范围的权限
- 发现安全/伦理风险

质疑只能反馈给父 Agent，子 Agent **不得擅自变更任务目标或扩大范围**。

### 原则 4：父 Agent 的委托权必须受约束

不是任何任务都值得拆分子 Agent。父 Agent 创建子 Agent 前必须通过门控检查：
- 是否有明确的设计文档
- 任务是否正交
- 当前并行子 Agent 数量是否超限
- 是否已提供足够的共享上下文

---

## Task 1：子 Agent Profile 自主配置体系（≥ 10 测试）

### 1.1 Agent Profile 即 Skill

把子 Agent 配置作为一种特殊的 Skill 类型，复用现有 Skill 市场和生命周期：

```markdown
<!-- .routedev/skills/agents/executor/SKILL.md -->
---
name: executor
type: agent-profile
version: 1.0.0
role: executor
model: qwen-coder-32b
description: 专注代码实现的子 Agent
allowedTools:
  - read_file
  - file_write
  - file_edit
  - execute_command
  - run_tests
forbiddenTools:
  - delete_file
  - git_op
canChallenge: true
challengeSeverity: blocking
outputFormat: code_change
memory:
  - "项目使用 TypeScript，注释必须用中文"
  - "写完后必须运行 typecheck 和相关测试"
---

你是执行子 Agent。你的任务是按父 Agent 提供的设计文档高质量地实现代码。

【绝对规则】
- 你必须严格遵循设计文档，不得偏离接口契约
- 你只能修改父 Agent 明确授权的文件
- 写完后必须运行 typecheck 和相关测试
- 如果发现设计不可行，使用 challenge() 上报父 Agent，停止执行

【禁止事项】
- 不得修改任务目标
- 不得擅自重构无关代码
- 不得跳过测试
```

### 1.2 设置页面 UI

在 RouteDev 设置中新增 **"子 Agent 配置"** 页面：

```
Settings > Sub Agents
├── 内置配置
│   ├── researcher （可查看/复制/重置）
│   ├── executor   （可查看/复制/重置）
│   └── reviewer   （可查看/复制/重置）
├── 我的配置
│   ├── my-executor
│   └── [+] 新建
└── 市场
    ├── 官方精选 Agent Profile
    └── 导入...
```

**每个 Profile 可配置项：**
- 名称、角色、描述
- 模型选择（下拉框，来自已配置的 providers）
- System Prompt 编辑器
- 工具白名单/黑名单
- 输出格式
- 是否允许质疑、质疑级别
- 专属 Skill 绑定
- Token 预算上限
- 最大执行步数

### 1.3 Profile 解析与加载

新增 `src/agents/profiles/` 模块：

```typescript
// src/agents/profiles/types.ts
export interface AgentProfile {
  id: string;
  name: string;
  type: 'agent-profile';
  version: string;
  role: AgentRole;
  modelId: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  forbiddenTools: string[];
  canChallenge: boolean;
  challengeSeverity: 'blocking' | 'warning';
  outputFormat: AgentOutputFormat;
  boundSkills: string[];
  maxTokens: number;
  maxSteps: number;
}

// src/agents/profiles/manager.ts
export class AgentProfileManager {
  async listProfiles(): Promise<AgentProfile[]>;
  async getProfile(id: string): Promise<AgentProfile | null>;
  async saveProfile(profile: AgentProfile): Promise<void>;
  async loadBuiltinProfiles(): Promise<AgentProfile[]>;
  async resolveProfileForTask(role: AgentRole, task: Task): Promise<AgentProfile>;
}
```

### 1.4 与 PromptManager 集成

`PromptManager` 加载 Agent Profile 时：
1. 读取 `SKILL.md` 中的 frontmatter 作为配置。
2. 把 Markdown 内容作为 system prompt。
3. 把绑定的 Skill 追加到 system prompt 末尾。
4. 把工具白名单传给 `ToolProvider` 做过滤。

### 1.5 测试要求

- 内置 researcher / executor / reviewer 三个 Profile 能正确加载。
- 用户在设置页面修改 Profile 后下次创建子 Agent 生效。
- Profile 中 forbiddenTools 的工具不会被注册到子 Agent。
- Profile 绑定 Skill 后，子 Agent system prompt 包含 Skill 内容。
- 新建自定义 Profile 能保存到 `.routedev/skills/agents/`。
- Profile 版本升级后旧版本标记为 deprecated。
- 从市场导入 Agent Profile 后能正确解析。

---

## Task 2：共享上下文筛选与打包（≥ 8 测试）

### 2.1 问题定义

父 Agent 不能把全部上下文传给子 Agent。需要一种机制，根据子 Agent 角色和任务，从多个来源筛选出最相关的上下文，打包成一份"上下文包"。

### 2.2 上下文来源

```typescript
interface ContextSources {
  // 1. 项目现状（来自代码地图）
  codeMap: {
    relevantSymbols: CodeMapNode[];
    relevantFiles: string[];
    impactGraph: ImpactResult;
  };
  // 2. 任务边界（来自父 Agent 规划）
  taskBoundary: {
    designDoc: string;
    readFiles: string[];
    writeFiles: string[];
    goal: string;
    constraints: string[];
  };
  // 3. 父 Agent 经验（来自项目记忆）
  memory: {
    projectLessons: string[];
    historicalPitfalls: string[];
    codingStandards: string[];
  };
  // 4. 运行时事实（来自 Blackboard）
  facts: Map<string, string>;
  // 5. 父 Agent 的中间结论（可选）
  parentReasoning: string;
}
```

### 2.3 上下文筛选策略

不同角色拿到不同的上下文子集：

| 角色 | codeMap | taskBoundary | memory | facts | parentReasoning |
|------|---------|--------------|--------|-------|-----------------|
| researcher | 高（全局符号） | 中（问题范围） | 低 | 低 | 低 |
| executor | 高（相关符号源码） | 高（设计文档+可写清单） | 中（编码规范） | 中 | 低 |
| reviewer | 中（变更影响范围） | 高（设计文档+diff） | 中 | 低 | 中 |

### 2.4 上下文打包器

新增 `src/agents/context-packer.ts`：

```typescript
export interface ContextPackage {
  role: AgentRole;
  taskId: string;
  tokenBudget: number;
  sections: ContextSection[];
  metadata: {
    totalFiles: number;
    totalSymbols: number;
    estimatedTokens: number;
    sourceSnapshot: string;   // 用于一致性校验
  };
}

export class ContextPacker {
  async pack(options: {
    role: AgentRole;
    task: Task;
    sources: ContextSources;
    budgetTokens: number;
  }): Promise<ContextPackage>;
}
```

**打包流程：**
1. 根据角色确定各来源的权重。
2. 从代码地图中召回相关符号和文件（使用 Phase 42 的 `CodeMapEngine`）。
3. 对源码片段做 token 估算，按重要性排序。
4. 在预算内选择最相关的片段，超过预算时截断并记录。
5. 生成结构化的 `ContextPackage`。

### 2.5 踩坑点和父 Agent 经验的注入

项目记忆中的踩坑点需要显式注入：

```typescript
// 从 KnowledgeGraph / ProjectMemory 中提取与本次任务相关的经验
const relevantLessons = await projectMemory.query({
  topic: task.topic,
  tags: task.tags,
  role: profile.role,
  limit: 5,
});
```

例如：
- "本项目 `Level` 对象禁止 cast 为 `ServerLevel`"
- "Attribute trim 效果需要每 100 ticks 验证 modifier"
- "容器插入逻辑必须集中到一个静态工具方法"

### 2.6 测试要求

- researcher 拿到全局代码地图但不拿到设计文档细节？不，应拿到问题范围。
- executor 拿不到无关文件的源码。
- 上下文包 token 数不超过预算。
- 代码地图相关符号按 PageRank 排序后截断。
- 项目记忆中的踩坑点按任务主题召回。
- 同一任务多次打包结果一致（缓存生效）。
- 子 Agent 基于打包上下文工作，不需要再重新读取项目文件。

---

## Task 3：委托契约与质疑机制（≥ 8 测试）

### 3.1 DelegationContract 定义

```typescript
interface DelegationContract {
  taskId: string;
  parentAgentId: string;
  childAgentId: string;
  profileId: string;
  
  grant: {
    readFiles: string[];
    writeFiles?: string[];
    allowedTools: string[];
    maxTokens: number;
    maxSteps: number;
    canChallenge: boolean;
  };
  
  obligation: {
    mustFollowDesign: boolean;
    mustReportProgress: boolean;
    mustNotAlterGoal: boolean;
    challengeChannel: 'parent_only';
  };
  
  deliverable: {
    format: AgentOutputFormat;
    successCriteria: string[];
    failureCriteria: string[];
  };
}
```

### 3.2 契约注入 System Prompt

子 Agent 的 system prompt 中必须包含契约摘要：

```markdown
【委托契约】
- 你的角色：{{role}}
- 允许读取的文件：{{readFiles}}
- 允许修改的文件：{{writeFiles}}
- 允许使用的工具：{{allowedTools}}
- Token 预算：{{maxTokens}}
- 最大步数：{{maxSteps}}

【服从义务】
- 你必须完成父 Agent 委托的任务
- 你必须严格遵循设计文档和边界
- 你无权修改任务目标、范围或优先级

【质疑权利】
- 如果你发现设计冲突、信息不足、权限不够或任务不可行
- 请使用 challenge() 工具向父 Agent 反馈
- 在父 Agent 回应前，你必须停止执行
```

### 3.3 Challenge 机制

```typescript
interface ChallengeRequest {
  taskId: string;
  role: AgentRole;
  type: 'design_conflict' | 'missing_info' | 'out_of_scope' | 'tool_unavailable' | 'ethical_concern';
  severity: 'blocking' | 'warning';
  description: string;
  evidence: string[];
  proposedOptions?: string[];
}

type ParentResponse =
  | { action: 'clarify'; newInstructions: string }
  | { action: 'revise_design'; newDesignDoc: string }
  | { action: 'proceed'; reason: string }
  | { action: 'abort'; reason: string };
```

**流程：**
1. 子 Agent 调用 `challenge()` 工具。
2. `WorkerExecutor` 暂停该子 Agent。
3. 父 Agent 收到 challenge 通知。
4. 父 Agent 选择回应方式。
5. 子 Agent 根据回应继续、重试或终止。

### 3.4 越权行为拦截

通过 Hook 和 Profile 工具白名单双重约束：

```typescript
// src/hooks/builtin/delegation-enforcer.ts
export function createDelegationEnforcer(contract: DelegationContract) {
  return {
    beforeToolCall(toolName: string, args: unknown) {
      if (!contract.grant.allowedTools.includes(toolName)) {
        throw new AgentError(`子 Agent 无权调用工具 ${toolName}`);
      }
      if (isWriteOperation(toolName)) {
        const targetFile = args?.path as string;
        if (!contract.grant.writeFiles?.includes(targetFile)) {
          throw new AgentError(`子 Agent 无权修改文件 ${targetFile}`);
        }
      }
    },
  };
}
```

### 3.5 测试要求

- 子 Agent 调用未授权工具时被拦截。
- 子 Agent 修改未授权文件时被拦截。
- 子 Agent challenge 后父 Agent 收到通知。
- 父 Agent 回应 clarify 后子 Agent 继续执行。
- 父 Agent 回应 abort 后子 Agent 终止。
- 子 Agent 无权修改任务目标的 system prompt 约束生效。
- 契约中的 maxSteps 到达后子 Agent 强制终止。
- 契约中的 maxTokens 到达后子 Agent 触发预算警告。

---

## Task 4：三个内置子 Agent 模板（≥ 8 测试）

### 4.1 Researcher（调研者）

**职责：** 只读调研，输出结构化事实报告。

```yaml
name: researcher
role: researcher
model: reasoning-strong
allowedTools: [read_file, code_map_explore, find_callers, find_callees, analyze_impact]
canWrite: false
canChallenge: true
outputFormat: research_report
```

**专用提示词要点：**
- 你只能读取，禁止修改
- 输出必须包含：事实、来源、置信度、缺失信息
- 遇到矛盾信息必须 challenge

**调用时机：**
- 父 Agent 需要了解未知模块
- 做 impact analysis 前
- 验证某个实现假设

### 4.2 Executor（执行者）

**职责：** 按设计文档写代码，可写但受白名单约束。

```yaml
name: executor
role: executor
model: coding-fast
allowedTools: [read_file, file_write, file_edit, execute_command, run_tests]
canWrite: true
canChallenge: true
outputFormat: code_change
```

**专用提示词要点：**
- 严格遵循设计文档
- 只能修改授权文件
- 写完后必须跑 typecheck 和测试
- 发现不可行时 challenge

**调用时机：**
- 设计文档已确认
- 任务边界清晰
- 文件修改范围明确

### 4.3 Reviewer（审查者）

**职责：** 审查代码变更，输出报告，不改代码。

```yaml
name: reviewer
role: reviewer
model: reasoning-strong
allowedTools: [read_file, diff_view, run_tests]
canWrite: false
canChallenge: true
outputFormat: review_report
```

**专用提示词要点：**
- 你只能审查，不能修改
- 报告必须具体：问题、原因、建议
- 给出明确的 approval / conditional / rejected 结论

**调用时机：**
- 代码变更完成后
- 合并前

### 4.4 模板的可自定义性

用户可以在设置页面：
- 复制内置模板为自定义模板
- 修改模型、提示词、工具集
- 导出/导入模板
- 重置为官方默认

### 4.5 测试要求

- researcher 只读，尝试写文件被拦截。
- researcher 输出包含事实来源和置信度。
- executor 按设计文档修改授权文件。
- executor 写完后自动运行测试。
- reviewer 输出 approval / conditional / rejected 结论。
- reviewer 能发现设计文档与代码实现的偏差。
- 用户复制内置模板后修改生效。
- 重置内置模板后恢复默认配置。

---

## Task 5：父 Agent 委托门控（≥ 6 测试）

### 5.1 门控规则

新增 `src/agents/delegation-gate.ts`：

```typescript
interface DelegationGateRules {
  researcher: {
    when: ('need_facts' | 'impact_analysis' | 'unknown_domain')[];
    maxParallel: number;
    requires: ['task_description'];
  };
  executor: {
    when: ('design_confirmed' | 'task_isolated')[];
    maxParallel: number;
    requires: ['design_doc', 'write_file_list'];
  };
  reviewer: {
    when: ('after_execution' | 'before_merge')[];
    maxParallel: number;
    requires: ['diff', 'design_doc'];
  };
}
```

### 5.2 门控检查函数

```typescript
export function checkDelegationEligibility(
  parent: ParentAgent,
  role: AgentRole,
  task: Task,
  contextPackage: ContextPackage,
): Result<DelegationContract, string> {
  const rules = GATE_RULES[role];
  
  // 检查当前并行数量
  if (parent.activeSubAgents.filter(a => a.role === role).length >= rules.maxParallel) {
    return Err(`${role} 并行数量已达上限`);
  }
  
  // 检查必需输入
  for (const req of rules.requires) {
    if (!task[req]) {
      return Err(`创建 ${role} 需要 ${req}`);
    }
  }
  
  // 检查上下文包是否足够
  if (contextPackage.metadata.estimatedTokens < 100) {
    return Err('共享上下文包过小，子 Agent 无法有效工作');
  }
  
  return Ok(buildContract(parent, role, task, contextPackage));
}
```

### 5.3 用 Policy Engine 约束父 Agent

Phase 42 Task 7 的 Policy Engine 可以增加默认 Playbook：

```yaml
name: 子 Agent 委托约束
type: playbook
trigger:
  keywords: ["create_sub_agent", "delegate", "spawn"]
action:
  injectPrompt: |
    你在创建子 Agent。请遵守委托门控：
    1. researcher：只有需要事实/影响分析时创建，最多 3 个并行
    2. executor：必须有已确认的设计文档和可写文件清单
    3. reviewer：必须有 diff 和设计文档
    4. 必须生成 DelegationContract
    5. 必须调用 ContextPacker 筛选上下文，禁止全量复制父 Agent 上下文
```

### 5.4 测试要求

- 缺少设计文档时无法创建 executor。
- 缺少 diff 时无法创建 reviewer。
- researcher 并行超过 3 个时被拒绝。
- 上下文包过小时拒绝委托。
- Policy Engine 命中委托约束后父 Agent prompt 包含门控规则。
- 门控失败时返回明确的错误信息给父 Agent。

---

## Task 6：生命周期与状态机集成（≥ 6 测试）

### 6.1 子 Agent 状态

扩展 Phase 42 Task 3 的图状态机：

```typescript
type SubAgentStatus =
  | 'pending'      // 已创建，等待启动
  | 'running'      // 执行中
  | 'challenged'   // 已发起质疑，等待父 Agent 回应
  | 'completed'    // 完成
  | 'failed'       // 失败
  | 'aborted'      // 被父 Agent 中止
  | 'blocked';     // 被门控阻塞
```

### 6.2 状态转换

```text
pending → running → completed
          ↓
          challenged → [parent_response] → running / failed / aborted
          ↓
          failed
```

### 6.3 Score Card 扩展

```typescript
interface SubAgentScoreCard {
  taskId: string;
  role: AgentRole;
  profileId: string;
  modelId: string;
  tokenUsage: TokenUsageInfo;
  contextTokens: number;       // 上下文包大小
  redundantReads: number;      // 重复读取文件数（应接近 0）
  challengeCount: number;
  contractViolations: number;  // 越权次数
  deliverableQuality: number;  // 父 Agent 评分
  parentSatisfaction: 'accepted' | 'rejected' | 'edited';
}
```

### 6.4 反滥用策略

QualityAggregator 基于 Score Card 数据：
- 如果某类子 Agent 频繁 challenge，提示用户检查设计质量
- 如果子 Agent 重复读取文件多，提示优化 ContextPacker
- 如果子 Agent token 成本高但效果差，自动建议减少并行、改用主 Agent 串行

### 6.5 测试要求

- 子 Agent 状态转换符合预期。
- challenge 状态等待父 Agent 回应期间不消耗 token。
- Score Card 记录 contextTokens 和 redundantReads。
- 频繁 challenge 触发反滥用提示。
- 子 Agent 完成结果自动同步到父 Agent Blackboard。
- 被中止的子 Agent 资源正确释放。

---

## Task 7：集成测试与文档同步（≥ 4 测试）

### 7.1 端到端测试

1. **子 Agent 配置端到端：** 用户在设置页面创建自定义 executor Profile → 保存 → /goal 创建子 Agent → 子 Agent 使用自定义模型和提示词。
2. **上下文筛选端到端：** 复杂任务 → 父 Agent 调用 ContextPacker → 生成精简上下文包 → 子 Agent 基于包执行 → 不重新读取无关文件。
3. **委托契约端到端：** 创建 executor → 子 Agent 尝试修改未授权文件 → 被拦截 → challenge 上报 → 父 Agent 调整授权 → 继续执行。
4. **内置模板端到端：** researcher 调研 → executor 实现 → reviewer 审查 → 父 Agent 汇总结果。
5. **委托门控端到端：** 父 Agent 无设计文档时尝试创建 executor → 门控拒绝 → 父 Agent 先生成设计文档 → 再创建 executor。
6. **/goal 生命周期端到端：** 模糊 goal → 触发澄清问题 → 用户回答 → 生成五段式规范 → 用户确认 plan → 步骤执行 → 独立审计 → 用户采纳。
7. **Hook 增强端到端：** 用户描述生成 Hook → 进入试用模式 → 触发多次后无异常 → 启用拦截 → /goal 生命周期事件触发 Hook。
8. **查漏补缺端到端：** tree-sitter 加载失败 → 自动回退正则代码地图 → ContextPacker 仍可使用 → 子 Agent 正常执行 → Policy 与 Skill 冲突时 Policy 优先 → 仲裁结果记录审计日志。

### 7.2 文档同步

- **SUB_AGENTS.md：** 新增子 Agent 架构、Profile 配置、委托契约、上下文打包、生命周期说明。
- **GOAL.md：** 新增 /goal 目标生命周期、五段式规范、计划确认、独立审计、用户采纳说明。
- **HOOKS.md：** 新增 Hook 生命周期扩展、函数型 Hook、Hook 沙箱、Hook 组合说明。
- **SETTINGS.md：** 新增子 Agent 设置页面、/goal 偏好、Hook 市场说明。
- **MULTI_AGENT.md：** 补充子 Agent 状态机和 Score Card 扩展。
- **SKILLS.md：** 补充 Agent Profile 作为特殊 Skill 类型。
- **CHANGELOG.md：** v3.4.0 条目。
- **CODEX_BRANCH_COMPARISON.md：** 新增 Codex 分支编辑与 RouteDev 分支合并的对比分析（Task 10.4）。
- **EXECUTION_ORDER.md：** 新增 Phase 41-43 跨 Phase 执行顺序与依赖说明（Task 10.8）。
- **BENCHMARK.md：** 新增代码地图 golden repo 基准测试说明（Task 10.1）。
- **config schema：** 新增 `subAgents.enabled`、`subAgents.maxParallel`、`subAgents.profiles`、`subAgents.gateRules`、`goal.clarify`、`goal.requireConfirmation`、`goal.auditMode`、`hook.sandbox`、`hook.functionHooks`、`market.registryUrl`、`market.registryToken` 等。

---

## Task 8：/goal 目标生命周期进化（≥ 15 测试）

### 8.1 现状问题

当前 `/goal`（`src/cli/goal-runner.ts`、`src/agent/goal-parser.ts`）已具备：
- GoalParser 把用户描述拆成步骤
- GoalVerifier 用独立 LLM 验证完成度
- CompletionGate 跑 typecheck/lint/tests
- GoalGateManager 冻结验收标准

但缺少你强调的两个关键点：
1. **首：需求澄清不彻底。** `RequirementsClarifier` 已存在（`src/agent/requirements-clarifier.ts`），但 `/goal` 命令没有强制接入。模糊目标直接执行。
2. **尾：完成判定不够独立。** GoalVerifier 仍是 LLM 自评，没有 reviewer 子 Agent 或外部审计器按 `Done when` 清单逐项验证。

另外参考 Codex `/goal` 的优秀设计：
- Goal 应独立于对话历史持久化（`/compact` 不丢）
- 支持 resume 续跑
- Token 预算到上限时应软停止并输出进度报告

### 8.2 Goal Prompt Builder：五段式规范

用户输入 `/goal "实现登录功能"` 后，父 Agent 先把它扩展为五段式规范：

```markdown
Goal: 实现登录功能
Scope: 只修改 src/auth/ 目录，不碰注册/找回密码
Constraints:
- 使用 bcrypt 做密码哈希
- 必须返回 JWT
- 注释用中文
Done when:
1. /api/login POST 接口存在并通过测试
2. 密码错误时返回 401
3. JWT 有效期 24 小时
4. typecheck 和 tests 全部通过
Stop if:
- 发现现有 auth 模块结构无法扩展
- 需要引入未授权的第三方依赖
Use a token budget of 50000 tokens.
```

**实现：** 新增 `src/agent/goal-prompt-builder.ts`，调用 LLM 把用户描述转化为五段式规范。

### 8.3 强制需求澄清

**核心原则：只要用户 goal 存在任何模糊性，就必须追问；默认猜测需求的成本远高于多问几个问题。**

在 `/goal` 命令入口（`src/cli/commands/goal.ts` → `goal-runner.ts`）强制接入 `RequirementsClarifier`：

```typescript
async function handleGoalCommand(rawInput: string) {
  // 1. 澄清
  const clarification = await clarifier.clarify(rawInput);
  if (clarification.needsClarification) {
    // UI 展示问题，等待用户回答
    const answers = await ui.askQuestions(clarification.questions);
    rawInput = await clarifier.enrichGoal(rawInput, answers);
  }

  // 2. 生成五段式规范
  const spec = await goalPromptBuilder.build(rawInput);

  // 3. 生成 GoalPlan
  const plan = await goalParser.parse(spec);

  // 4. 用户确认计划
  if (config.goal.requireConfirmation) {
    const confirmed = await ui.confirmPlan(plan);
    if (!confirmed) return;
  }

  // 5. 执行
  await executeGoalPlan(plan);
}
```

**追问维度必须包括，缺一不可：**
- **实现细节**（用什么算法/库/模式）
- **必要决策**（是否改接口、是否新增依赖、方案选型）
- **完成标准**（怎么算做完、验收测试是什么、失败条件）
- **范围边界**（哪些不改、哪些不碰、是否允许扩展新功能）

其中**完成标准**是后续独立审计的唯一依据，必须在澄清阶段就让用户确认，不能留到执行后再由模型自行解释。

### 8.4 计划确认 UI

新增 `GoalPlanConfirmation` 组件：

```tsx
<GoalPlanConfirmation
  spec={fivePartSpec}
  plan={goalPlan}
  onConfirm={() => executeGoalPlan(plan)}
  onEditStep={(stepId, newDescription) => ...}
  onAddStep={(afterStepId) => ...}
  onRemoveStep={(stepId) => ...}
  onReorder={(stepIds) => ...}
/>
```

用户可以：
- 查看五段式规范
- 查看/编辑每个步骤的描述
- 增删步骤
- 调整步骤顺序/依赖
- 修改 `Done when` 和 `Stop if`

### 8.5 目标持久化与续跑

GoalPlan 应持久化到 `.routedev/goals/<goalId>.json`，独立于对话历史：

```typescript
interface PersistedGoal {
  id: string;
  spec: FivePartGoalSpec;
  plan: GoalPlan;
  status: GoalPlanStatus;
  checkpointIds: string[];
  createdAt: number;
  updatedAt: number;
  tokenUsed: number;
  tokenBudget: number;
}
```

- `/compact` 不清理 goal 状态
- `/resume` 可以列出未完成的 goal 并选择续跑
- 应用启动时检测可恢复 goal（已存在但未 complete/failed）

### 8.6 步骤间结构化 handoff

当前 `executeGoalPlan` 中每个步骤从空 `conversationHistory` 开始，导致步骤间信息丢失。改为：

```typescript
// 步骤完成后把关键事实写入 Blackboard
blackboard.addCompletedStep({
  stepId: step.id,
  result: step.result,
  modifiedFiles: step.modifiedFiles,
  newSymbols: extractNewSymbols(step.modifiedFiles),
  changedInterfaces: extractChangedInterfaces(step.modifiedFiles),
});

// 下一步骤开始前从 Blackboard 读取相关上下文
const handoffContext = blackboard.formatForPrompt();
```

### 8.7 独立目标审计

完成判定不能由模型自评。引入三层审计：

```typescript
interface GoalAuditLayer {
  layer: 'completion_gate' | 'verifier_llm' | 'reviewer_agent';
  passed: boolean;
  evidence: string[];
}
```

1. **CompletionGate**：typecheck / lint / tests 全部通过
2. **GoalVerifier LLM**：按 `Done when` 清单逐项检查
3. **Reviewer 子 Agent**（Phase 43 Task 4）：独立审查实现是否符合设计文档

只有三层都通过，或者用户显式覆盖，才算完成。

### 8.8 Token 预算软停止

借鉴 Codex：

```typescript
if (taskSpent > taskBudget * 0.9) {
  addSystemMessage('⚠️ 任务 token 预算即将耗尽，正在收尾...');
  // 触发收尾模式：保存进度、输出报告、不再创建新步骤
  plan.status = 'paused';
  plan.progressReport = await generateProgressReport(plan);
  await persistGoal(plan);
}
```

用户看到进度报告后，可以选择：
- 增加预算继续
- 接受当前结果
- 放弃

### 8.9 测试要求

- 模糊 goal 触发澄清问题；明确 goal（如"查看 git 状态"）不触发无意义追问。
- 澄清问题必须同时覆盖实现细节、必要决策、完成标准三类。
- 完成标准在澄清阶段确认并写入 `Done when`，作为审计唯一依据。
- 用户回答后 goal 文本被增强。
- 五段式规范包含 Goal/Scope/Constraints/Done when/Stop if。
- 计划确认 UI 允许编辑步骤。
- GoalPlan 持久化后 `/compact` 不丢失。
- `/resume` 能列出并恢复未完成的 goal。
- 步骤完成后 Blackboard 记录修改文件和新符号。
- 下一步骤能读取到上一步的结构化 handoff。
- CompletionGate + GoalVerifier + reviewer 子 Agent 三层审计。
- 未完成时给出具体缺失项和改进建议。
- Token 预算到 90% 时触发软停止并输出进度报告。
- 用户可增加预算继续执行。
- 用户可在确认 UI 中修改 `Done when` 和 `Stop if`。
- Codex 风格的 `/goal` 持久化与 `continuation.md` 提示词注入。

---

## Task 9：Hook 增强与生命周期扩展（≥ 10 测试）

### 9.1 现状问题

当前 Hook 系统（`src/agent/hooks.ts`、`src/hooks/generator.ts`、`src/hooks/registry.ts`）已支持：
- 9 种事件触发
- 模板匹配 + LLM 生成
- 安全审查（正则黑名单）
- 注册表持久化

但存在明显缺口：
- Hook 只能执行 shell 命令
- Hook 模板是 JSON，与 Skill/Agent Profile 市场不统一
- 安全审查太浅（只有正则）
- 没有试用/沙箱模式
- Hook 事件没有覆盖 `/goal` 生命周期
- Hook 之间无法组合

### 9.2 /goal 生命周期 Hook 事件扩展

在现有事件基础上新增：

```typescript
type HookEvent =
  | 'pre-step'
  | 'post-step'
  | 'on-error'
  | 'on-complete'
  | 'pre-tool-call'
  | 'post-tool-call'
  | 'on-session-start'
  | 'on-session-end'
  | 'on-model-call'
  // 新增
  | 'post-plan'           // GoalPlan 生成后
  | 'pre-step-execution'  // 步骤执行前（已确认计划后）
  | 'post-step-execution' // 步骤执行后
  | 'pre-adopt'           // 结果采纳/合并前
  | 'on-goal-complete'    // 目标完成时
  | 'on-goal-failed'      // 目标失败时
  | 'on-goal-paused';     // 目标因预算等原因暂停时
```

### 9.3 Hook 模板迁移到 SKILL.md 标准

当前 `src/hooks/templates/*.json` 应迁移为 `src/hooks/templates/*/SKILL.md`：

```markdown
---
name: auto-format
type: hook
version: 1.0.0
event: post-tool-call
condition:
  toolName: file_write
command: npx prettier --write {{filePath}}
failBehavior: warn
---

在文件写入后自动运行 prettier 格式化。
```

这样 Hook 可以复用：
- `SkillMdParser`
- `SkillMarketManager`（或扩展为统一的 MarketManager）
- 版本管理
- 导入导出

### 9.4 Hook 沙箱与试用模式

用户生成/安装 Hook 后，默认进入 7 天试用模式：

```typescript
interface HookTrial {
  hookId: string;
  status: 'trial' | 'enabled' | 'disabled';
  triggeredCount: number;
  lastTriggeredAt: number;
  anomalies: string[];
}
```

试用期间：
- Hook 正常触发
- 记录行为日志
- **不执行 block/abort**（只记录 "would block"）
- 7 天后或触发 N 次后无异常，自动转为 enabled
- 期间发现异常则转为 disabled 并提示用户

### 9.5 函数型 Hook（JS/TS）

支持用户编写 JS/TS 函数作为 Hook：

```typescript
// .routedev/hooks/my-hook/hook.ts
import type { HookContext, HookResult } from 'routedev/hooks';

export default async function myHook(ctx: HookContext): Promise<HookResult> {
  if (ctx.event === 'post-tool-call' && ctx.toolName === 'file_write') {
    // 可以访问 AST、调用内部服务、读取状态
    const ast = await ctx.parseAst(ctx.toolArgs.path);
    if (hasUnusedImport(ast)) {
      return {
        action: 'continue',
        message: '检测到未使用 import，建议清理',
      };
    }
  }
  return { action: 'continue' };
}
```

函数型 Hook 运行在受限上下文中：
- 不允许网络请求（除非用户显式授权）
- 不允许文件系统写操作（只读）
- 超时 5 秒
- 崩溃不影响主流程

### 9.6 Hook 组合与链式执行

支持把多个 Hook 组合成一个 Hook Group：

```yaml
---
name: quality-gates
type: hook-group
hooks:
  - auto-format
  - type-check
  - pre-commit-test
sequence: sequential
onFailure: abort
---
```

执行语义：
- `sequential`：按顺序执行，前一个失败则停止
- `parallel`：并行执行
- `onFailure: abort`：任一失败则中止操作
- `onFailure: warn`：记录警告但继续

### 9.7 安全审查增强

当前正则黑名单太弱。应引入：

1. **命令静态分析**：解析 shell 命令，识别管道、子 shell、编码命令
2. **行为白名单**：函数型 Hook 只能调用白名单 API
3. **沙箱执行**：在独立 worker 线程中运行，限制资源
4. **敏感操作确认**：涉及删除、网络、git push 等操作时要求用户确认

### 9.8 测试要求

- `/goal` 生命周期新增事件能正确触发 Hook。
- Hook 模板 SKILL.md 解析正确。
- Hook 市场可以发布/安装/回滚 SKILL.md 格式的 Hook。
- 试用模式不执行 block，只记录 "would block"。
- 试用期满无异常后自动启用。
- 函数型 Hook 能访问 AST 等内部服务。
- 函数型 Hook 的文件系统写操作被拦截。
- Hook Group 顺序执行，失败时按配置 abort/warn。
- 安全审查能识别 base64 编码命令和管道链。
- 危险 Hook 安装时要求用户确认。

---

## Task 10：Phase 41 / 42 查漏补缺（≥ 8 测试）

Phase 41 和 42 作为前置 Phase，规划完整但存在若干"纸面完成、工程未完成"的缺口。本 Task 在 Phase 43 内以查漏补缺方式补齐，避免这些缺口在子 Agent、/goal、Hook 等新能力上线后被放大。

### 10.1 代码地图验收基准与迁移路径

Phase 41 提出"精度 ≥ Aider、查询 ≥ CodeGraph"，但没有给出可执行的验收标准。本项补齐：

- 建立 **golden repo 基准测试集**：至少 3 个不同规模/语言的真实项目快照（小型 TS 工具、中型 Python 项目、大型多语言 monorepo）。
- 定义 **expected symbols/edges**，与 Aider `repomap.py` 和 CodeGraph 输出做 diff，计算 precision/recall。
- 明确 `src/tools/repo-map.ts` → `src/code-map/` 的迁移路径：
  - `repo-map.ts` 保留为 `engine: 'regex'` 的 fallback。
  - `CodeMapEngine` 内部根据 `config.codeMap.engine` 选择实现。
  - 正则方案不再增强，仅修复致命 bug。

### 10.2 Windows / Electron 原生模块兜底方案

Phase 41 陷阱 #74、Phase 42 陷阱 #83 都提到 `tree-sitter` 原生模块风险，但缺少具体实现。本项补齐：

- 在 `src/code-map/parser.ts` 中封装 `tryLoadTreeSitter()`，加载失败时返回 `null`。
- 启动时自动检测，失败则切换 `codeMap.engine = 'regex'` 并提示用户。
- Electron 打包脚本把 `tree-sitter/prebuilds/` 加入 `asarUnpack`。
- CI 增加 Windows 安装包 smoke test，验证安装后首次启动不崩溃。

### 10.3 多 worktree 代码地图隔离

Phase 41 Task 6 和 Phase 42 陷阱 #84 都提到隔离，但无具体实现。本项补齐：

- 每个 worktree 的 code-map 数据库存放在各自 `.routedev/code-map/code-map.db`。
- 主工作区不感知 worktree 的 code-map；合并后由主工作区重新索引。
- `CodeMapEngine` 初始化时根据 `process.cwd()` 自动定位数据库路径。

### 10.4 Codex 分支编辑功能对比与 RouteDev 差异化

Phase 42 Task 5 写了分支合并 UI，但没有与 Codex 做对标分析。本项补齐：

- 调研 Codex CLI 的 worktree / branch 实现（`codex-rs` 中的 sandbox / apply 机制）。
- 明确 RouteDev 差异化：
  - Codex：单分支实验，自动 apply。
  - RouteDev：多步骤多分支 + 独立 reviewer 子 Agent + 用户 cherry-pick 采纳。
- 将对比结论写入 `docs/research/codex-branch-comparison.md`，并在分支审查 UI 文案中体现差异化卖点。

### 10.5 策略冲突仲裁规则

Phase 42 Task 7.4 说明了 Skill / Policy / Hook 的关系，但没有定义冲突仲裁。本项补齐：

- 定义优先级：**`Policy（安全） > Skill（长期规则） > Hook（事件响应）`**。
- Policy 内部按 `priority` 字段排序；priority 重复时按加载顺序生效并给出警告。
- 当 Policy `block` 与 Skill `injectPrompt` 冲突时，Policy 优先。
- 所有仲裁结果记录到审计日志。

### 10.6 远程市场 Registry 接口预留

Phase 42 Task 4 只做本地市场，思考引导 #4 说远程市场后续决定。本项预留接口：

- 在 `MarketManager` 中抽象 `RegistryClient` 接口：
  ```typescript
  interface RegistryClient {
    listSkills(): Promise<MarketItem[]>;
    listHooks(): Promise<MarketItem[]>;
    downloadPackage(name: string, version: string): Promise<Buffer>;
  }
  ```
- 新增配置项：`market.registryUrl`、`market.registryToken`。
- 默认实现返回空列表，避免后续 breaking change。

### 10.7 HCGS 成本评估与回退策略

Phase 42 Task 2.2 的 HCGS 依赖 LLM 生成摘要，缺少成本控制。本项补齐：

- 摘要生成使用 `fast` tier 廉价模型。
- 摘要失败或超时时回退到原始符号列表。
- 后台异步生成，不阻塞首次索引。
- 记录每次摘要消耗的 token，超过预算时自动关闭 HCGS。

### 10.8 跨 Phase 执行顺序与依赖对齐

Phase 42 思考引导 #10 的执行顺序与任务依赖不一致。本项给出 Phase 43 内的推荐执行顺序：

1. Task 1（Profile 体系 + 设置页面）
2. Task 2（ContextPacker）
3. Task 3（委托契约）
4. **Task 10.1-10.3**（代码地图查漏补缺）
5. **Task 10.5-10.6**（Policy / 市场查漏补缺）
6. Task 4-6（内置模板、委托门控、生命周期 / Score Card）
7. Task 8（/goal 进化，依赖 Task 4 的 reviewer 和 Task 6 的状态机）
8. Task 9（Hook 增强，依赖 Task 8 的 /goal 生命周期事件）
9. Task 7（集成测试与文档同步）

### 10.9 测试要求

- golden repo 基准测试可运行，输出 precision / recall 指标。
- `tree-sitter` 加载失败时自动切换到正则方案。
- worktree 中代码地图数据库路径正确隔离。
- Policy 与 Skill 冲突时 Policy 优先生效。
- 远程 registry stub 接口可调用，默认返回空列表。
- HCGS 摘要失败时回退到原始节点列表。
- Codex 分支机制调研文档写入 `docs/research/codex-branch-comparison.md`。
- 执行顺序文档更新到 `docs/execution-order.md`。

---

## 新增陷阱警告

**97. 子 Agent Profile 配置错误会导致所有子 Agent 行为异常：** 必须对 Profile 做 schema 校验，非法配置在保存时提示，不能带病运行。

**98. 上下文包过小会让子 Agent 无法工作：** ContextPacker 应设置最小 token 阈值，低于阈值时拒绝委托而不是让子 Agent 盲猜。

**99. 父 Agent 可能把上下文包当"全量上下文"使用：** 必须在 system prompt 中明确告知子 Agent"这是你收到的全部上下文，不要再主动读取项目文件"。

**100. 子 Agent 的 challenge 可能形成死循环：** 父 Agent 对同一 challenge 最多回应 3 次，超过则强制终止，避免无限踢皮球。

**101. 自定义 Profile 的模型可能不可用：** 创建子 Agent 前检查模型配置是否存在，不存在时回退到默认模型并提示用户。

**102. 并发子 Agent 可能产生资源竞争：** 多个 executor 同时写不同文件时没问题，但写同一文件必须加锁或串行化。

**103. Score Card 的 redundantReads 统计可能误导：** 子 Agent 读取父 Agent 未提供的文件才算 redundant；读取已授权文件的不同部分不算。

**104. /goal 的需求澄清可能过度追问：** 简单目标（如"查看 git 状态"）不应触发澄清。`skipIfConfident` 阈值必须合理，且允许用户一键跳过。

**105. 计划确认 UI 成为流程瓶颈：** 简单任务应允许自动确认（`requireConfirmation: false`），只有复杂任务才强制确认。

**106. Goal 持久化文件可能膨胀：** 长期运行会生成大量 `.routedev/goals/*.json`，需要自动归档或清理策略。

**107. 三层审计可能互相矛盾：** CompletionGate 通过但 reviewer 拒绝，或反之。必须定义仲裁规则（默认以 CompletionGate 为准，但高严重度 reviewer 质疑可推翻）。

**108. Hook 函数型沙箱逃逸风险：** 即使限制 API，用户仍可能通过 prototype pollution 或 eval 逃逸。必须用 vm2/QuickJS 等真沙箱，不能仅靠白名单。

**109. Hook 试用模式可能被恶意利用：** 试用期间不 block，危险 Hook 可以"观察"系统。敏感事件（如 git push、文件删除）即使在试用期也应强制确认。

**110. Hook Group 组合可能形成循环依赖：** Group A 包含 B，B 又包含 A。加载时必须检测循环并拒绝。

---

## 思考引导总结

1. **子 Agent 是否越多越好？** 不是。子 Agent 数量应由任务正交性和委托门控决定，不是由上下文长度决定。

2. **上下文包是否越大越好？** 不是。过大的上下文包会淹没关键信息。ContextPacker 的目标是在预算内保留"必要且相关"的信息。

3. **researcher / executor / reviewer 是否够用？** 对大多数场景够用，但用户可以通过设置页面创建自定义角色（如 `documenter`、`refactorer`、`security_auditor`）。

4. **父 Agent 的全量上下文如何处理？** 父 Agent 保留完整上下文做决策，但只有筛选后的 ContextPackage 传给子 Agent。两者不是复制关系，而是"主记忆 + 分发摘要"关系。

5. **委托契约是否会增加系统复杂度？** 会，但这是必要的复杂度。它把隐式的"子 Agent 行为规范"变成显式的可校验契约，长期降低调试成本。

6. **/goal 为什么要先澄清再确认？** 因为 LLM 猜错需求的成本远高于多问几个问题。用户确认计划后再执行，能避免大量返工。

7. **完成判定为什么必须是三层审计？** 模型自评容易过拟合。CompletionGate 保证代码质量，GoalVerifier 保证目标覆盖，reviewer 子 Agent 保证设计一致性。

8. **Hook 为什么要从 shell 扩展到函数型？** shell 适合简单外部调用，但无法做 AST 分析、状态访问、复杂决策。函数型 Hook 让 RouteDev 的监管体系更深度。

9. **与 Phase 42 的边界：** Phase 42 建立代码地图、编排框架、策略引擎、Skill/Hook 市场；Phase 43 在此基础上专门解决子 Agent 上下文控制、/goal 生命周期进化、Hook 深度增强。不修改 Phase 42 文档，Phase 43 引用并扩展 Phase 42。

10. **为什么还要在 Phase 43 补 Phase 41/42 的漏？** 因为代码地图、策略引擎、市场是子 Agent 和 /goal 的基础设施。如果 engine 没有验收基准、Policy 没有仲裁规则、市场没有远程接口、worktree 没有隔离，Phase 43 的新能力会建立在不稳地基上。Task 10 就是把这些地基补牢。

11. **执行顺序建议：** Task 1（Profile 体系 + 设置页面）→ Task 2（上下文打包）→ Task 3（委托契约）→ **Task 10.1-10.3（代码地图查漏补缺）** → **Task 10.5-10.6（Policy / 市场查漏补缺）** → Task 4（内置模板）→ Task 5（委托门控）→ Task 6（生命周期/Score Card）→ Task 8（/goal 进化）→ Task 9（Hook 增强）→ Task 7（集成测试）。Task 1 和 Task 2 是基础，必须先做；Task 10 是基础中的基础，不能拖到后面。
