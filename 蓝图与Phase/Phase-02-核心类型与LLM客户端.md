# Phase 2：核心类型定义 + LLM 客户端（双协议 + 流式）

**回应**：Phase 1 CONCERN 裁决

| # | 级别 | 裁决 | 说明 |
|---|------|------|------|
| 1 | RISK | **Accept** | TS 6.x 兼容方案合理。`ignoreDeprecations: "6.0"` 是正确的过渡策略。蓝图暂不更新版本号——待 TS 7 发布时统一重审 |
| 2 | RISK | **Accept** | Zod 4 的 `z.preprocess` 方案可行。注意：后续 Phase 如需更复杂的默认值逻辑，考虑提取 helper 函数 |
| 3 | RISK | **Accept** | pnpm 11 的 `allowBuilds` 迁移已正确执行。已记录到踩坑清单 |
| 4 | RISK | **Accept** | `packageManager` caret 问题已修复。预防规则合理 |
| 5 | RISK | **Accept** | `types: ["node"]` 修复正确 |
| 6 | RISK | **Accept** | `console.warn` 在 loader 中有合理解释。**Phase 4 时统一改用 logger.warn**（届时 logger 初始化时序已确定） |
| 7 | SUGGEST | **Accept** | 当前场景等价，不过度优化。记录备用 |

**对蓝图的建议回复**：
- 建议 1（版本范围列）：暂不更新。当前 Phase 1 的兼容性处理已经够用，蓝图不应绑定具体版本号
- 建议 2（配置迁移策略）：Phase 1 的 `version: 1` 已足够。待 Phase 6+ 出现配置破坏性变更时再实现 migration
- 建议 3（子 Agent 评估）：同意，Phase 1-3 直接执行即可

---

**目标**：定义 Router / Agent / Tool 三层的核心 TypeScript 类型，实现 LLM 客户端的双协议抽象（OpenAI + Anthropic），支持流式输出（SSE）和非流式模式。

**蓝图参考**：第三节（技术栈）、第四节（文件结构）、第五节决策 1/5/7、第六节（Router 层）、design-routedev-spec.md（§1 Router 层接口、§2 Agent 层接口）、design-routedev-spec2.md（§1 Tool 层接口）

---

## 具体任务

### Task 1：安装新依赖

- [ ] **Step 1：安装 LLM SDK**

```powershell
pnpm add openai @anthropic-ai/sdk
```

依赖说明：
- `openai`：OpenAI 协议 SDK（也用于兼容 OpenAI 协议的第三方 API，如 opencode-go）
- `@anthropic-ai/sdk`：Anthropic 协议 SDK

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL（新依赖不影响已有代码）

- [ ] **Step 3：提交**

```powershell
git add package.json pnpm-lock.yaml
git commit -m "chore: add openai and anthropic SDK dependencies"
```

---

### Task 2：Router 层类型定义

**文件：**
- 创建：`src/router/types.ts`

这些类型是 Router 层的核心数据结构。它们与 `src/config/schema.ts` 的 Zod schema 是**平行关系**——Zod schema 用于配置文件验证，这些类型用于运行时逻辑。

- [ ] **Step 1：创建 Router 层类型**

```typescript
// src/router/types.ts
// Router 层核心类型定义
// 与 config/schema.ts 的关系：schema 定义配置文件的验证规则，这里定义运行时使用的类型

// ===== 场景等级 =====

/** 四级场景分类：简单/中等/复杂/推理 */
export type ScenarioTier = 'simple' | 'medium' | 'complex' | 'reasoning';

/** 场景等级的数字权重（用于比较和降级） */
export const TIER_WEIGHT: Record<ScenarioTier, number> = {
  simple: 1,
  medium: 2,
  complex: 3,
  reasoning: 4,
} as const;

/** 模型能力标签 */
export type ModelCapability = 'reasoning' | 'code' | 'multimodal' | 'fast' | 'cheap';

// ===== 模型配置 =====

/** 模型运行时配置（从 config 映射而来） */
export interface ModelConfig {
  id: string;                      // 模型唯一标识，如 "deepseek-v4-flash"
  name: string;                    // 显示名称，如 "DeepSeek V4 Flash"
  providerId: string;              // 所属提供商 ID，如 "opencode-go"
  tier: ScenarioTier;              // 默认归属等级
  contextWindow: number;           // 上下文窗口大小（token 数）
  capabilities: ModelCapability[]; // 能力标签
  latencyMs: number;               // 平均延迟（毫秒）
  available: boolean;              // 当前是否可用
  fallbackModelId?: string;        // 同 tier 备选模型 ID
}

// ===== 提供商配置 =====

/** API 协议类型 */
export type Protocol = 'openai' | 'anthropic';

/** 提供商运行时配置 */
export interface ProviderConfig {
  id: string;                      // 提供商唯一标识
  name: string;                    // 显示名称
  protocol: Protocol;              // API 协议
  baseUrl: string;                 // API 基础 URL（注意：不含 /chat/completions 等路径）
  apiKey: string;                  // API Key（已从环境变量解析）
  models: ModelConfig[];           // 该提供商下的模型列表
}

// ===== 路由规则 =====

/** 路由规则：场景等级 → 模型的映射 */
export interface RouterRule {
  tier: ScenarioTier;
  modelId: string;                 // 默认模型 ID
  fallbackModelId?: string;        // 降级模型 ID
  maxTokensPerRequest?: number;    // 单次请求 token 上限
}

// ===== Token 预算 =====

/** Token 预算模式 */
export type BudgetMode = 'track_only' | 'enforce';

/** Token 预算配置 */
export interface TokenBudget {
  mode: BudgetMode;
  dailyLimit: number;              // 日 token 上限
  perRequestLimit?: number;        // 单次请求上限
  degradationThreshold: number;    // 触发降级的阈值（0-1，日消耗百分比）
}

// ===== 路由决策 =====

/** 路由选项（调用方传入） */
export interface RouteOptions {
  forceModelId?: string;           // 用户手动指定模型
  maxTokens?: number;              // 本次请求 token 预算
  excludeModels?: string[];        // 排除的模型（如已失败的）
}

/** 路由决策结果 */
export interface RouteDecision {
  modelId: string;                 // 选中的模型 ID
  providerId: string;              // 选中模型所属提供商 ID
  tier: ScenarioTier;              // 场景等级
  isOverride: boolean;             // 是否为手动覆盖（用户用 /model 指定）
  isDegraded: boolean;             // 是否已降级（原模型不可用）
  originalModelId?: string;        // 降级前的原始模型 ID
  reason: string;                  // 路由决策理由（用于可观测性）
}

/** 路由状态（状态栏显示用） */
export interface RouterStatus {
  currentModel: string;            // 当前模型 ID
  currentTier: ScenarioTier;       // 当前场景等级
  isDegraded: boolean;             // 是否已降级
  todayTokensUsed: number;         // 今日已用 token
  todayTokensLimit?: number;       // 今日 token 上限
  recentDecisions: RouteDecision[]; // 最近 N 次路由决策（默认保留 10 条）
}

// ===== 场景分类 =====

/** 分类器输入 */
export interface ClassifyInput {
  userMessage: string;             // 用户消息
  conversationContext: ConversationContextMessage[]; // 最近 N 条消息摘要
  projectContext?: string;         // 项目上下文摘要（可选）
}

/** 对话上下文消息（分类器用的精简版） */
export interface ConversationContextMessage {
  role: 'user' | 'assistant';
  content: string;                 // 截断后的内容（最多 200 字）
}

/** 分类器输出 */
export interface ClassifyResult {
  tier: ScenarioTier;              // 场景等级
  confidence: number;              // 置信度 0-1
  reasoning: string;               // 分类理由（调试用）
  suggestedModelId?: string;       // 建议的模型（可选，如用户手动覆盖时）
}

// ===== LLM 客户端抽象 =====

/** LLM 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** LLM 消息 */
export interface LLMMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;             // tool 角色时的工具调用 ID
  toolCalls?: ToolCallInfo[];      // assistant 角色时可能附带的工具调用
}

/** 工具调用信息（模型返回的 function calling 请求） */
export interface ToolCallInfo {
  id: string;                      // 工具调用 ID
  name: string;                    // 函数名
  arguments: string;               // JSON 字符串格式的参数
}

/** LLM 请求参数 */
export interface LLMRequestOptions {
  model: string;                   // 模型 ID
  messages: LLMMessage[];          // 消息列表
  maxTokens?: number;              // 最大生成 token 数
  temperature?: number;            // 温度（0-2）
  stream?: boolean;                // 是否流式输出
  tools?: LLMToolDefinition[];     // 可用工具列表（function calling）
  stop?: string[];                 // 停止序列
  timeout?: number;                // 超时（毫秒，默认 30000）
}

/** 给模型看的工具定义（function calling schema） */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema 格式
}

/** LLM 响应（非流式） */
export interface LLMResponse {
  content: string;                 // 模型生成的文本
  toolCalls?: ToolCallInfo[];      // 工具调用（如果有）
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: TokenUsageInfo;           // token 使用量
  modelId: string;                 // 实际使用的模型 ID
}

/** Token 使用量信息 */
export interface TokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** 流式事件类型 */
export type StreamEventType =
  | 'text_delta'                   // 文本增量
  | 'tool_call_start'              // 工具调用开始
  | 'tool_call_delta'              // 工具调用参数增量
  | 'tool_call_end'                // 工具调用结束
  | 'usage'                        // token 使用量
  | 'done'                         // 流结束
  | 'error';                       // 错误

/** 流式事件 */
export interface StreamEvent {
  type: StreamEventType;
  data: string;                    // 事件数据（text_delta 时为文本片段，tool_call 时为 JSON）
  usage?: TokenUsageInfo;          // 仅在 type='usage' 或 type='done' 时有值
  error?: string;                  // 仅在 type='error' 时有值
}

/** LLM 客户端统一接口 */
export interface LLMClient {
  /** 非流式调用 */
  chat(options: LLMRequestOptions): Promise<LLMResponse>;

  /** 流式调用，返回 AsyncGenerator */
  chatStream(options: LLMRequestOptions): AsyncGenerator<StreamEvent>;

  /** 获取客户端支持的协议 */
  readonly protocol: Protocol;

  /** 检查客户端是否就绪（API Key 已配置等） */
  isReady(): boolean;
}

/** LLM 客户端配置 */
export interface LLMClientConfig {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  defaultTimeout?: number;         // 默认超时（毫秒）
  maxRetries?: number;             // 最大重试次数（默认 0，不自动重试）
}

// ===== LLM 错误 =====

/** LLM 调用错误 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly modelId?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'LLMError';
  }

  /** 是否为速率限制（429） */
  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  /** 是否为认证错误（401/403） */
  get isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  /** 是否为超时 */
  get isTimeout(): boolean {
    return this.statusCode === undefined && this.message.includes('timeout');
  }
}
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL

- [ ] **Step 3：提交**

```powershell
git add src/router/types.ts
git commit -m "feat(router): define core types for router, model, LLM client abstractions"
```

---

### Task 3：Agent 层 + Tool 层类型定义

**文件：**
- 创建：`src/agent/types.ts`
- 创建：`src/tools/types.ts`

Agent 和 Tool 的类型在本 Phase 只定义接口骨架，实际实现在后续 Phase。但这些类型从 Day 1 就要定义好，确保各层之间接口一致。

- [ ] **Step 1：创建 Tool 层类型**

```typescript
// src/tools/types.ts
// Tool 层核心类型定义
// 工具注册表、工具执行器、工具定义都使用这些类型

// ===== 工具来源 =====

/** 工具来源：内置 / MCP 插件 / 外部插件 */
export type ToolSource = 'builtin' | 'mcp' | 'plugin';

/** 工具权限级别 */
export type ToolPermission = 'auto' | 'confirm' | 'deny';

/** 工具执行状态 */
export type ToolExecStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'timeout';

// ===== 工具结果 =====

/** 工具执行结果 */
export interface ToolResult {
  toolName: string;                // 工具名称
  status: ToolExecStatus;          // 执行状态
  output: string;                  // 输出内容
  error?: string;                  // 错误信息（status=error 时）
  duration: number;                // 执行耗时（毫秒）
  tokensUsed?: number;             // 工具内部消耗的 token（如果有）
  artifacts?: ToolArtifact[];      // 产出物（文件、截图等）
}

/** 工具产出物 */
export interface ToolArtifact {
  type: 'file_created' | 'file_modified' | 'file_deleted' | 'image' | 'url';
  path?: string;                   // 文件路径
  url?: string;                    // URL
  description: string;             // 描述
}

// ===== 工具定义 =====

/** 工具参数定义 */
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
  enum?: string[];                 // 可选值列表
  default?: unknown;
}

/** 工具执行上下文（handler 接收的上下文信息） */
export interface ToolExecutionContext {
  projectId: string;
  projectPath: string;             // 项目根目录绝对路径
  agentId: string;                 // 调用方 Agent ID
  stepId: string;                  // 当前步骤 ID
  timeout: number;                 // 超时时间（毫秒）
}

/** 工具执行函数签名 */
export type ToolHandler = (
  params: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

/** 工具完整定义（注册到 ToolRegistry 的结构） */
export interface ToolDefinition {
  id: string;                      // 唯一标识，如 "builtin.file_read"
  name: string;                    // 显示名称
  description: string;             // 工具描述（给模型看的，要精确）
  source: ToolSource;
  permission: ToolPermission;
  parameters: ToolParameter[];
  handler: ToolHandler;
  /** 是否为并发安全（只读、无副作用的工具可并行） */
  concurrentSafe?: boolean;
}

// ===== 工具调用 =====

/** 工具调用请求（模型返回的 function calling 转成） */
export interface ToolCall {
  id: string;                      // 调用 ID
  toolId: string;                  // 工具 ID（如 "builtin.file_read"）
  parameters: Record<string, unknown>;
  requestedAt: number;             // 请求时间戳
}

// ===== Function Schema（给模型看的） =====

/** 模型 function calling 的 JSON Schema */
export interface FunctionSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema 格式
}

// ===== 权限决策 =====

/** 权限检查结果 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;   // 是否需要用户确认
}

// ===== 安全策略（Harness 层接口，Tool 层引用） =====

/** 安全策略 */
export interface SecurityPolicy {
  directoryBoundary: {
    enabled: boolean;
    allowedPaths: string[];
    deniedPaths: string[];
  };
  commandControl: {
    blacklist: string[];
    whitelist: string[];
    mode: 'blacklist' | 'whitelist' | 'both';
  };
  sensitiveFiles: {
    patterns: string[];
    policy: 'readonly' | 'deny';
  };
  networkConfirm: {
    enabled: boolean;
    allowedDomains: string[];
    deniedDomains: string[];
  };
}

/** 安全检查结果 */
export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
  overrideAvailable: boolean;      // 用户是否可以手动覆盖
}
```

- [ ] **Step 2：创建 Agent 层类型**

```typescript
// src/agent/types.ts
// Agent 层核心类型定义
// 这些类型在 Phase 5（Agent Loop）才会被实际使用，
// 但从 Day 1 定义好，确保各层接口一致

import type { ScenarioTier, TokenUsageInfo } from '../router/types.js';
import type { ToolCall, ToolResult, SecurityPolicy } from '../tools/types.js';

// ===== Agent 身份与状态 =====

/** Agent 角色 */
export type AgentRole = 'orchestrator' | 'coder' | 'searcher' | 'tester' | 'reviewer';

/** Agent 状态 */
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting_approval' | 'error' | 'done';

/** 自主度模式 */
export type AutonomyMode = 'auto' | 'semi' | 'manual';

/** 工作模式 */
export type WorkMode = 'build' | 'plan' | 'compose';

/** 步骤状态 */
export type StepStatus = 'pending' | 'running' | 'paused' | 'done' | 'error' | 'skipped';

/** 文件操作类型 */
export type FileOpType = 'read' | 'write' | 'delete' | 'execute';

// ===== 对话消息 =====

/** 对话消息（会话内的完整消息结构） */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  modelId?: string;
  tier?: ScenarioTier;
  tokensUsed?: number;
  branchId: string;                // 所属分支
  parentId?: string;               // 父消息 ID（用于分支）
  toolCalls?: ToolCall[];          // assistant 消息的工具调用
  toolResults?: ToolResult[];      // tool 消息的工具结果
  metadata?: Record<string, unknown>;
}

// ===== 步骤计划 =====

/** 文件访问声明 */
export interface FileAccess {
  path: string;                    // 文件路径（相对项目根目录）
  opType: FileOpType;
}

/** 步骤计划中的单个步骤 */
export interface PlanStep {
  id: string;
  description: string;
  agentRole: AgentRole;
  tier: ScenarioTier;
  fileAccess: FileAccess[];
  dependencies: string[];          // 依赖的步骤 ID
  status: StepStatus;
  result?: StepResult;
}

/** 冲突组（文件访问冲突的步骤） */
export interface ConflictGroup {
  conflictingStepIds: string[];
  conflictFiles: string[];
  resolution: 'parallel' | 'sequential';
}

/** 完整步骤计划 */
export interface StepPlan {
  id: string;
  goal: string;
  steps: PlanStep[];
  conflictGroups: ConflictGroup[];
  estimatedTiers: ScenarioTier[];
  useMultiAgent: boolean;
}

// ===== 执行结果 =====

/** 步骤执行结果 */
export interface StepResult {
  stepId: string;
  status: StepStatus;
  output: string;
  filesModified: string[];
  linesAdded: number;
  linesDeleted: number;
  tokensUsed: number;
  duration: number;
  error?: StepError;
}

/** 步骤错误 */
export interface StepError {
  type: 'model_error' | 'tool_error' | 'conflict' | 'timeout' | 'approval_rejected';
  message: string;
  suggestion: string;
  recoverable: boolean;
}

/** 整体执行结果 */
export interface ExecutionResult {
  planId: string;
  status: 'success' | 'partial' | 'failed';
  completedSteps: number;
  totalSteps: number;
  results: StepResult[];
  totalTokensUsed: number;
  duration: number;
}

// ===== Agent 通信协议（Phase 14 多 Agent 时使用） =====

/** Agent 间消息类型 */
export type MessageType =
  | 'task_assign'
  | 'task_result'
  | 'task_error'
  | 'approval_request'
  | 'approval_response'
  | 'cancel'
  | 'status_query'
  | 'status_response';

/** Agent 间消息 */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: number;
}

// ===== Agent Trace（可观测性） =====

/** Agent 执行追踪步骤 */
export interface TraceStep {
  timestamp: number;
  type: 'model_call' | 'tool_call' | 'decision' | 'state_change';
  input: string;
  output: string;
  duration: number;
  tokensUsed?: TokenUsageInfo;
  modelId?: string;
  toolName?: string;
}

/** Agent 执行追踪 */
export interface AgentTrace {
  agentId: string;
  steps: TraceStep[];
}

// ===== ReAct Agent Loop 事件（Phase 5 实现） =====

/** Agent Loop 输出的事件类型 */
export type AgentEventType =
  | 'thinking'                     // 模型正在思考
  | 'text_delta'                   // 文本输出增量
  | 'tool_call_start'              // 开始调用工具
  | 'tool_call_result'             // 工具返回结果
  | 'step_complete'                // 步骤完成
  | 'error'                        // 错误
  | 'done';                        // Agent Loop 结束

/** Agent Loop 事件 */
export interface AgentEvent {
  type: AgentEventType;
  data: string;                    // 事件数据
  toolCall?: ToolCall;             // tool_call_start 时附带
  toolResult?: ToolResult;         // tool_call_result 时附带
  stepResult?: StepResult;         // step_complete 时附带
  error?: string;                  // error 时附带
  usage?: TokenUsageInfo;          // 可选的 token 使用量
}

// ===== 审批决策 =====

/** 用户审批决策 */
export type ApprovalDecision = 'approve' | 'reject' | 'modify';
```

- [ ] **Step 3：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL

- [ ] **Step 4：提交**

```powershell
git add src/agent/types.ts src/tools/types.ts
git commit -m "feat(types): define core types for agent layer and tool layer"
```

---

### Task 4：Token 计数工具

**文件：**
- 创建：`src/utils/token-counter.ts`

Token 计数有两种场景：
1. **精确计数**：API 返回的 `usage` 字段（input_tokens + output_tokens），这是最准确的
2. **预估计数**：在发送请求前估算消息的 token 数，用于预算检查

本 Phase 先实现精确计数（记录 API 返回的 usage），预估计数用简单启发式（1 token ≈ 4 英文字符 / 2 中文字符），后续可替换为 tiktoken。

- [ ] **Step 1：创建 Token 计数模块**

```typescript
// src/utils/token-counter.ts
// Token 计数工具
// 精确计数：来自 API 返回的 usage 字段
// 预估计数：简单启发式（1 token ≈ 4 英文字符 / 2 中文字符）

import type { TokenUsageInfo } from '../router/types.js';

/**
 * 启发式预估文本的 token 数
 * 规则：英文约 4 字符/token，中文约 2 字符/token，取中间值 3 字符/token
 * 这是粗略估计，实际 API 返回的 usage 更准确
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 统计中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const otherChars = text.length - chineseChars;

  // 中文约 1.5 字符/token，英文约 4 字符/token
  const chineseTokens = Math.ceil(chineseChars / 1.5);
  const otherTokens = Math.ceil(otherChars / 4);

  return chineseTokens + otherTokens;
}

/**
 * 从 API 返回的 usage 对象提取 TokenUsageInfo
 * 兼容 OpenAI 和 Anthropic 的 usage 格式
 */
export function normalizeUsage(usage: {
  prompt_tokens?: number;          // OpenAI 格式
  completion_tokens?: number;      // OpenAI 格式
  total_tokens?: number;           // OpenAI 格式
  input_tokens?: number;           // Anthropic 格式
  output_tokens?: number;          // Anthropic 格式
}): TokenUsageInfo {
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);

  return { inputTokens, outputTokens, totalTokens };
}

/**
 * 累加多个 TokenUsageInfo
 */
export function sumUsage(usages: TokenUsageInfo[]): TokenUsageInfo {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

/**
 * 格式化 token 数为人类可读字符串
 * 例：1234 → "1.2K"，1234567 → "1.2M"
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
```

- [ ] **Step 2：创建测试**

```typescript
// tests/utils/token-counter.test.ts
import { describe, it, expect } from 'vitest';
import { estimateTokens, normalizeUsage, sumUsage, formatTokenCount } from '../../src/utils/token-counter.js';

describe('Token Counter', () => {
  it('estimateTokens: 纯英文', () => {
    // "hello world" = 11 字符 ≈ 3 tokens
    const result = estimateTokens('hello world');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(10);
  });

  it('estimateTokens: 纯中文', () => {
    // "你好世界" = 4 中文字符 ≈ 3 tokens
    const result = estimateTokens('你好世界');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(10);
  });

  it('estimateTokens: 空字符串', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('normalizeUsage: OpenAI 格式', () => {
    const result = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it('normalizeUsage: Anthropic 格式', () => {
    const result = normalizeUsage({
      input_tokens: 200,
      output_tokens: 80,
    });
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
    expect(result.totalTokens).toBe(280);
  });

  it('sumUsage: 累加多个 usage', () => {
    const result = sumUsage([
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    ]);
    expect(result.totalTokens).toBe(45);
  });

  it('formatTokenCount: 格式化', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(1234)).toBe('1.2K');
    expect(formatTokenCount(1234567)).toBe('1.2M');
  });
});
```

- [ ] **Step 3：运行测试**

```powershell
pnpm test
```

预期：所有测试通过（Phase 1 的 6 个 + 新增 7 个 = 共 13 个）

- [ ] **Step 4：提交**

```powershell
git add src/utils/token-counter.ts tests/utils/token-counter.test.ts
git commit -m "feat(utils): add token counter with estimation and normalization"
```

---

### Task 5：LLM 客户端基类（统一抽象）

**文件：**
- 创建：`src/router/llm/base.ts`

基类实现公共逻辑：超时控制、错误标准化、日志记录。子类只需实现协议特定的请求构造和响应解析。

- [ ] **Step 1：创建 LLM 客户端基类**

```typescript
// src/router/llm/base.ts
// LLM 客户端抽象基类
// 公共逻辑：超时控制、错误标准化、日志记录
// 子类实现：协议特定的请求构造和响应解析

import type {
  LLMClient,
  LLMClientConfig,
  LLMRequestOptions,
  LLMResponse,
  StreamEvent,
  Protocol,
} from '../types.js';
import { LLMError } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * LLM 客户端抽象基类
 * 子类必须实现：
 *   - doChat(options): 执行非流式请求
 *   - doChatStream(options): 执行流式请求，返回 AsyncGenerator
 */
export abstract class BaseLLMClient implements LLMClient {
  readonly protocol: Protocol;

  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly defaultTimeout: number;
  protected readonly maxRetries: number;

  constructor(config: LLMClientConfig) {
    this.protocol = config.protocol;
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // 去除末尾斜杠
    this.apiKey = config.apiKey;
    this.defaultTimeout = config.defaultTimeout ?? 30000;
    this.maxRetries = config.maxRetries ?? 0;
  }

  /** 非流式调用（带超时和错误标准化） */
  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const timeout = options.timeout ?? this.defaultTimeout;
    const startTime = Date.now();

    logger.debug('LLM chat request', {
      protocol: this.protocol,
      model: options.model,
      messageCount: options.messages.length,
      stream: false,
    });

    try {
      const response = await this.withTimeout(
        this.doChat(options),
        timeout,
        options.model,
      );

      const duration = Date.now() - startTime;
      logger.debug('LLM chat response', {
        model: options.model,
        duration,
        tokens: response.usage.totalTokens,
        finishReason: response.finishReason,
      });

      return response;
    } catch (error) {
      throw this.normalizeError(error, options.model);
    }
  }

  /** 流式调用（带超时和错误标准化） */
  async *chatStream(options: LLMRequestOptions): AsyncGenerator<StreamEvent> {
    const timeout = options.timeout ?? this.defaultTimeout;

    logger.debug('LLM stream request', {
      protocol: this.protocol,
      model: options.model,
      messageCount: options.messages.length,
      stream: true,
    });

    try {
      // 流式请求的超时应用在首个事件上（连接超时），
      // 后续事件由 AsyncGenerator 自然处理
      yield* this.doChatStream(options, timeout);
    } catch (error) {
      const normalized = this.normalizeError(error, options.model);
      yield {
        type: 'error',
        data: '',
        error: normalized.message,
      };
      throw normalized;
    }
  }

  /** 检查客户端是否就绪 */
  isReady(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  // ===== 子类必须实现的方法 =====

  /** 执行协议特定的非流式请求 */
  protected abstract doChat(options: LLMRequestOptions): Promise<LLMResponse>;

  /** 执行协议特定的流式请求 */
  protected abstract doChatStream(
    options: LLMRequestOptions,
    timeout: number,
  ): AsyncGenerator<StreamEvent>;

  // ===== 公共工具方法 =====

  /** 带超时的 Promise 包装 */
  protected withTimeout<T>(promise: Promise<T>, timeout: number, modelId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new LLMError(`LLM request timeout after ${timeout}ms`, undefined, modelId));
      }, timeout);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /** 将各种错误统一为 LLMError */
  protected normalizeError(error: unknown, modelId: string): LLMError {
    if (error instanceof LLMError) return error;

    if (error instanceof Error) {
      // 检查是否有 HTTP 状态码（SDK 通常会附加）
      const statusCode = (error as unknown as { status?: number }).status
        ?? (error as unknown as { statusCode?: number }).statusCode;

      return new LLMError(error.message, statusCode, modelId, error);
    }

    return new LLMError(String(error), undefined, modelId);
  }
}
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

- [ ] **Step 3：提交**

```powershell
git add src/router/llm/base.ts
git commit -m "feat(router): add LLM client abstract base class with timeout and error normalization"
```

---

### Task 6：OpenAI 协议客户端

**文件：**
- 创建：`src/router/llm/openai.ts`

- [ ] **Step 1：实现 OpenAI 客户端**

```typescript
// src/router/llm/openai.ts
// OpenAI 协议 LLM 客户端
// 使用 openai SDK，兼容所有 OpenAI 兼容的 API（opencode-go、OpenRouter 等）
// 注意：openai SDK 会自动在 baseUrl 后拼接 /chat/completions，
//       所以 baseUrl 不要包含这个路径

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { BaseLLMClient } from './base.js';
import type {
  LLMClientConfig,
  LLMRequestOptions,
  LLMResponse,
  LLMMessage,
  StreamEvent,
  ToolCallInfo,
} from '../types.js';
import { LLMError } from '../types.js';
import { normalizeUsage } from '../../utils/token-counter.js';
import { logger } from '../../utils/logger.js';

export class OpenAIClient extends BaseLLMClient {
  private client: OpenAI;

  constructor(config: LLMClientConfig) {
    super({ ...config, protocol: 'openai' });

    this.client = new OpenAI({
      baseURL: this.baseUrl,       // SDK 会自动拼接 /chat/completions
      apiKey: this.apiKey,
      maxRetries: 0,               // 我们自己控制重试
    });
  }

  /** 执行非流式请求 */
  protected async doChat(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.convertMessages(options.messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: false,
      tools: tools && tools.length > 0 ? tools : undefined,
      stop: options.stop,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new LLMError('Empty response from OpenAI API', undefined, options.model);
    }

    const toolCalls = this.extractToolCalls(choice.message.tool_calls);

    return {
      content: choice.message.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: normalizeUsage(response.usage ?? {}),
      modelId: response.model,
    };
  }

  /** 执行流式请求 */
  protected async *doChatStream(
    options: LLMRequestOptions,
    timeout: number,
  ): AsyncGenerator<StreamEvent> {
    const messages = this.convertMessages(options.messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
      stream_options: { include_usage: true }, // 让 API 在流结束时返回 usage
      tools: tools && tools.length > 0 ? tools : undefined,
      stop: options.stop,
    }, {
      timeout,
    });

    // 追踪工具调用的累积数据
    const toolCallBuffers: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) {
        // 流结束时检查 usage
        if (chunk.usage) {
          yield {
            type: 'usage',
            data: '',
            usage: normalizeUsage(chunk.usage),
          };
        }
        continue;
      }

      // 文本增量
      if (delta.content) {
        yield {
          type: 'text_delta',
          data: delta.content,
        };
      }

      // 工具调用增量
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallBuffers.has(idx)) {
            // 新的工具调用开始
            toolCallBuffers.set(idx, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: '',
            });
            yield {
              type: 'tool_call_start',
              data: JSON.stringify({ id: tc.id, name: tc.function?.name }),
            };
          }

          // 累积参数
          if (tc.function?.arguments) {
            const buffer = toolCallBuffers.get(idx)!;
            buffer.arguments += tc.function.arguments;
            yield {
              type: 'tool_call_delta',
              data: tc.function.arguments,
            };
          }
        }
      }
    }

    // 发送工具调用结束事件
    for (const [, buffer] of toolCallBuffers) {
      yield {
        type: 'tool_call_end',
        data: JSON.stringify({
          id: buffer.id,
          name: buffer.name,
          arguments: buffer.arguments,
        }),
      };
    }

    // 流结束
    yield { type: 'done', data: '' };
  }

  // ===== 内部转换方法 =====

  /** 将通用 LLMMessage 转换为 OpenAI SDK 的 ChatCompletionMessageParam */
  private convertMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      switch (msg.role) {
        case 'system':
          return { role: 'system' as const, content: msg.content };
        case 'user':
          return { role: 'user' as const, content: msg.content };
        case 'assistant': {
          const result: ChatCompletionMessageParam = {
            role: 'assistant' as const,
            content: msg.content,
          };
          // 如果 assistant 消息附带工具调用
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            (result as { tool_calls?: unknown[] }).tool_calls = msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));
          }
          return result;
        }
        case 'tool':
          return {
            role: 'tool' as const,
            content: msg.content,
            tool_call_id: msg.toolCallId ?? '',
          };
        default:
          return { role: 'user' as const, content: msg.content };
      }
    });
  }

  /** 将通用工具定义转换为 OpenAI SDK 的 ChatCompletionTool */
  private convertTools(tools: LLMRequestOptions['tools']): ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /** 提取工具调用信息 */
  private extractToolCalls(
    toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
  ): ToolCallInfo[] {
    if (!toolCalls || toolCalls.length === 0) return [];

    return toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
  }

  /** 映射 finish_reason */
  private mapFinishReason(
    reason: string | null,
  ): 'stop' | 'tool_calls' | 'length' | 'error' {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      default: return 'stop';
    }
  }
}
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL

- [ ] **Step 3：提交**

```powershell
git add src/router/llm/openai.ts
git commit -m "feat(router): implement OpenAI protocol client with streaming support"
```

---

### Task 7：Anthropic 协议客户端

**文件：**
- 创建：`src/router/llm/anthropic.ts`

- [ ] **Step 1：实现 Anthropic 客户端**

```typescript
// src/router/llm/anthropic.ts
// Anthropic 协议 LLM 客户端
// 使用 @anthropic-ai/sdk
// 注意：Anthropic API 的 system prompt 不在 messages 数组中，
//       而是作为独立的 system 参数传递

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { BaseLLMClient } from './base.js';
import type {
  LLMClientConfig,
  LLMRequestOptions,
  LLMResponse,
  LLMMessage,
  StreamEvent,
  ToolCallInfo,
} from '../types.js';
import { LLMError } from '../types.js';
import { normalizeUsage } from '../../utils/token-counter.js';
import { logger } from '../../utils/logger.js';

export class AnthropicClient extends BaseLLMClient {
  private client: Anthropic;

  constructor(config: LLMClientConfig) {
    super({ ...config, protocol: 'anthropic' });

    this.client = new Anthropic({
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      maxRetries: 0,
    });
  }

  /** 执行非流式请求 */
  protected async doChat(options: LLMRequestOptions): Promise<LLMResponse> {
    const { systemPrompt, messages } = this.splitSystemPrompt(options.messages);
    const anthropicMessages = this.convertMessages(messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096, // Anthropic 必须指定 max_tokens
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
      stop_sequences: options.stop,
    });

    // 解析响应内容
    let content = '';
    const toolCalls: ToolCallInfo[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.mapStopReason(response.stop_reason),
      usage: normalizeUsage({
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      }),
      modelId: response.model,
    };
  }

  /** 执行流式请求 */
  protected async *doChatStream(
    options: LLMRequestOptions,
    timeout: number,
  ): AsyncGenerator<StreamEvent> {
    const { systemPrompt, messages } = this.splitSystemPrompt(options.messages);
    const anthropicMessages = this.convertMessages(messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const stream = this.client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
      stop_sequences: options.stop,
    });

    // 追踪工具调用（累积参数，与 OpenAI 行为一致）
    const toolCallBuffers: Map<string, { id: string; name: string; arguments: string }> = new Map();
    // 追踪分散的 usage（input_tokens 在 message_start，output_tokens 在 message_delta）
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            toolCallBuffers.set(block.id, {
              id: block.id,
              name: block.name,
              arguments: '',
            });
            yield {
              type: 'tool_call_start',
              data: JSON.stringify({ id: block.id, name: block.name }),
            };
          }
          break;
        }

        case 'content_block_delta': {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield {
              type: 'text_delta',
              data: delta.text,
            };
          } else if (delta.type === 'input_json_delta') {
            // 累积工具调用参数
            const partialJson = delta.partial_json;
            // 找到当前正在填充的 tool call buffer（最后一个）
            for (const [, buffer] of toolCallBuffers) {
              if (buffer.arguments !== undefined && !buffer.arguments.includes(partialJson)) {
                // 简单策略：累积到最后一个未完成的 buffer
              }
            }
            // 更可靠：取最后一个添加到 buffer 的
            const lastBuffer = Array.from(toolCallBuffers.values()).pop();
            if (lastBuffer) {
              lastBuffer.arguments += partialJson;
            }
            yield {
              type: 'tool_call_delta',
              data: partialJson,
            };
          }
          break;
        }

        case 'content_block_stop': {
          // 检查是否有工具调用块结束（通过检查最后一个 buffer 是否有数据）
          // 注意：content_block_stop 没有直接告诉我们是哪种 block，
          // 但我们可以通过 index 追踪——这里简化处理，在 message_stop 统一发送 tool_call_end
          break;
        }

        case 'message_start': {
          // 消息开始，包含 input token 用量
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens;
          }
          break;
        }

        case 'message_delta': {
          // 消息级别的增量，包含 output token 用量
          if (event.usage) {
            outputTokens = event.usage.output_tokens;
          }
          break;
        }

        case 'message_stop': {
          // 发送所有工具调用结束事件（此时参数已完整累积）
          for (const [, buffer] of toolCallBuffers) {
            yield {
              type: 'tool_call_end',
              data: JSON.stringify({
                id: buffer.id,
                name: buffer.name,
                arguments: buffer.arguments,
              }),
            };
          }

          // 合并 input + output tokens 为一条 usage 事件
          if (inputTokens > 0 || outputTokens > 0) {
            yield {
              type: 'usage',
              data: '',
              usage: {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
              },
            };
          }

          yield { type: 'done', data: '' };
          break;
        }
      }
    }
  }

  // ===== 内部转换方法 =====

  /**
   * 从消息列表中分离 system prompt
   * Anthropic 要求 system 独立于 messages 之外
   */
  private splitSystemPrompt(messages: LLMMessage[]): {
    systemPrompt: string;
    messages: LLMMessage[];
  } {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');
    return { systemPrompt, messages: nonSystemMessages };
  }

  /** 将通用 LLMMessage 转换为 Anthropic SDK 的 MessageParam */
  private convertMessages(messages: LLMMessage[]): MessageParam[] {
    // Anthropic 只支持 user 和 assistant 角色
    // tool 角色的消息要转换成 user 角色 + tool_result content block
    const result: MessageParam[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case 'user':
          result.push({ role: 'user', content: msg.content });
          break;

        case 'assistant': {
          // 如果 assistant 消息附带工具调用
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const content: Anthropic.ContentBlock[] = [];
            if (msg.content) {
              content.push({ type: 'text', text: msg.content });
            }
            for (const tc of msg.toolCalls) {
              content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: JSON.parse(tc.arguments || '{}'),
              });
            }
            result.push({ role: 'assistant', content });
          } else {
            result.push({ role: 'assistant', content: msg.content });
          }
          break;
        }

        case 'tool': {
          // tool 结果在 Anthropic 中是 user 角色的 tool_result content block
          result.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? '',
              content: msg.content,
            }],
          });
          break;
        }
      }
    }

    return result;
  }

  /** 将通用工具定义转换为 Anthropic SDK 的 Tool */
  private convertTools(tools: LLMRequestOptions['tools']): Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Tool['input_schema'],
    }));
  }

  /** 映射 stop_reason */
  private mapStopReason(
    reason: string | null,
  ): 'stop' | 'tool_calls' | 'length' | 'error' {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'tool_use': return 'tool_calls';
      case 'max_tokens': return 'length';
      default: return 'stop';
    }
  }
}
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL

- [ ] **Step 3：提交**

```powershell
git add src/router/llm/anthropic.ts
git commit -m "feat(router): implement Anthropic protocol client with streaming support"
```

---

### Task 8：LLM 客户端工厂 + 统一管理

**文件：**
- 创建：`src/router/llm/index.ts`

- [ ] **Step 1：创建客户端工厂**

```typescript
// src/router/llm/index.ts
// LLM 客户端工厂和统一管理
// 根据协议类型创建对应的客户端实例

import type { LLMClient, LLMClientConfig, Protocol } from '../types.js';
import { OpenAIClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { logger } from '../../utils/logger.js';

// 导出所有类型和类，方便外部引用
export { BaseLLMClient } from './base.js';
export { OpenAIClient } from './openai.js';
export { AnthropicClient } from './anthropic.js';

/**
 * 根据协议创建 LLM 客户端
 */
export function createLLMClient(config: LLMClientConfig): LLMClient {
  switch (config.protocol) {
    case 'openai':
      logger.debug('Creating OpenAI client', { baseUrl: config.baseUrl });
      return new OpenAIClient(config);

    case 'anthropic':
      logger.debug('Creating Anthropic client', { baseUrl: config.baseUrl });
      return new AnthropicClient(config);

    default:
      throw new Error(`Unsupported protocol: ${config.protocol}`);
  }
}

/**
 * LLM 客户端管理器
 * 管理多个客户端实例（每个 Provider 一个）
 */
export class LLMClientManager {
  private clients = new Map<string, LLMClient>();

  /** 注册一个客户端 */
  register(providerId: string, client: LLMClient): void {
    this.clients.set(providerId, client);
    logger.debug('LLM client registered', { providerId, protocol: client.protocol });
  }

  /** 获取客户端 */
  get(providerId: string): LLMClient | undefined {
    return this.clients.get(providerId);
  }

  /** 获取所有已注册的客户端 */
  listAll(): Map<string, LLMClient> {
    return new Map(this.clients);
  }

  /** 检查指定客户端是否就绪 */
  isReady(providerId: string): boolean {
    const client = this.clients.get(providerId);
    return client?.isReady() ?? false;
  }

  /** 移除客户端 */
  remove(providerId: string): void {
    this.clients.delete(providerId);
  }

  /** 初始化所有 Provider 的客户端 */
  initializeFromConfig(providers: Array<{
    id: string;
    protocol: Protocol;
    baseUrl: string;
    apiKey: string;
  }>): void {
    for (const provider of providers) {
      const client = createLLMClient({
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      });
      this.register(provider.id, client);
    }
    logger.info(`Initialized ${providers.length} LLM client(s)`);
  }
}
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

- [ ] **Step 3：提交**

```powershell
git add src/router/llm/index.ts
git commit -m "feat(router): add LLM client factory and manager"
```

---

### Task 9：LLM 客户端单元测试

**文件：**
- 创建：`tests/router/llm.test.ts`

由于 LLM 客户端依赖外部 API，测试策略是：
1. 测试客户端创建和配置验证
2. 测试消息格式转换（mock SDK）
3. 测试错误标准化
4. **不测试实际 API 调用**（那是集成测试，本 Phase 不做）

- [ ] **Step 1：编写测试**

```typescript
// tests/router/llm.test.ts
import { describe, it, expect } from 'vitest';
import { createLLMClient, LLMClientManager } from '../../src/router/llm/index.js';
import { LLMError } from '../../src/router/types.js';

describe('LLM Client Factory', () => {
  it('should create OpenAI client', () => {
    const client = createLLMClient({
      protocol: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    expect(client.protocol).toBe('openai');
    expect(client.isReady()).toBe(true);
  });

  it('should create Anthropic client', () => {
    const client = createLLMClient({
      protocol: 'anthropic',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    expect(client.protocol).toBe('anthropic');
    expect(client.isReady()).toBe(true);
  });

  it('should throw on unsupported protocol', () => {
    expect(() => createLLMClient({
      protocol: 'unknown' as 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    })).toThrow('Unsupported protocol');
  });

  it('should report not ready when no API key', () => {
    const client = createLLMClient({
      protocol: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: '',
    });
    expect(client.isReady()).toBe(false);
  });
});

describe('LLMClientManager', () => {
  it('should register and retrieve clients', () => {
    const manager = new LLMClientManager();
    const client = createLLMClient({
      protocol: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    manager.register('test-provider', client);
    expect(manager.get('test-provider')).toBe(client);
    expect(manager.isReady('test-provider')).toBe(true);
  });

  it('should return undefined for unknown provider', () => {
    const manager = new LLMClientManager();
    expect(manager.get('nonexistent')).toBeUndefined();
    expect(manager.isReady('nonexistent')).toBe(false);
  });

  it('should initialize from config', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'p1', protocol: 'openai', baseUrl: 'https://api1.test.com/v1', apiKey: 'key1' },
      { id: 'p2', protocol: 'anthropic', baseUrl: 'https://api2.test.com/v1', apiKey: 'key2' },
    ]);
    expect(manager.get('p1')?.protocol).toBe('openai');
    expect(manager.get('p2')?.protocol).toBe('anthropic');
  });

  it('should remove clients', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'p1', protocol: 'openai', baseUrl: 'https://api1.test.com/v1', apiKey: 'key1' },
    ]);
    manager.remove('p1');
    expect(manager.get('p1')).toBeUndefined();
  });
});

describe('LLMError', () => {
  it('should identify rate limit errors', () => {
    const err = new LLMError('Rate limited', 429, 'test-model');
    expect(err.isRateLimited).toBe(true);
    expect(err.isAuthError).toBe(false);
  });

  it('should identify auth errors', () => {
    const err = new LLMError('Unauthorized', 401, 'test-model');
    expect(err.isAuthError).toBe(true);
    expect(err.isRateLimited).toBe(false);
  });

  it('should identify timeout errors', () => {
    const err = new LLMError('LLM request timeout after 30000ms', undefined, 'test-model');
    expect(err.isTimeout).toBe(true);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('Network error');
    const err = new LLMError('Failed', 500, 'test-model', cause);
    expect(err.cause).toBe(cause);
  });
});
```

- [ ] **Step 2：运行全部测试**

```powershell
pnpm test
```

预期：Phase 1 的 6 个 + token-counter 的 7 个 + LLM 的 9 个 = 共 22 个测试全部通过

- [ ] **Step 3：提交**

```powershell
git add tests/router/llm.test.ts
git commit -m "test(router): add unit tests for LLM client factory, manager, and error handling"
```

---

### Task 10：更新 CLI 入口集成

**文件：**
- 修改：`src/index.ts`

将 LLM 客户端管理器集成到 CLI 入口，验证配置加载 → 客户端初始化的完整链路。

- [ ] **Step 1：更新入口**

```typescript
// src/index.ts
#!/usr/bin/env node

import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { LLMClientManager } from './router/llm/index.js';

const VERSION = '0.2.0';

async function main(): Promise<void> {
  console.log(`RouteDev v${VERSION}`);
  console.log('---');

  try {
    // 加载配置
    const config = loadConfig();

    console.log(`Language:   ${config.general.language}`);
    console.log(`Theme:      ${config.general.theme}`);
    console.log(`Providers:  ${config.providers.length} configured`);
    console.log(`Router:     ${config.router.rules.length} rules, preference=${config.router.userPreference}`);
    console.log(`Security:   directoryBoundary=${config.security.directoryBoundary}`);
    console.log(`Autonomy:   default=${config.autonomy.defaultMode}`);
    console.log('---');

    // 初始化 LLM 客户端
    const clientManager = new LLMClientManager();
    clientManager.initializeFromConfig(
      config.providers.map((p) => ({
        id: p.id,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
      })),
    );

    // 显示客户端状态
    for (const [providerId, client] of clientManager.listAll()) {
      const status = client.isReady() ? 'ready' : 'not ready';
      console.log(`  LLM [${client.protocol}] ${providerId}: ${status}`);
    }

    console.log('---');
    console.log('Configuration loaded successfully.');
    console.log('(Router coming in Phase 3, CLI interface in Phase 4)');

    logger.info('RouteDev started', {
      version: VERSION,
      providers: config.providers.length,
      routerRules: config.router.rules.length,
      llmClients: clientManager.listAll().size,
    });
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      logger.error('Startup failed', { error: err.message, stack: err.stack });
    }
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2：构建并运行验证**

```powershell
pnpm build
pnpm start
```

预期输出（无 providers 配置时）：
```
RouteDev v0.2.0
---
Language:   zh-CN
Theme:      dark
Providers:  0 configured
Router:     4 rules, preference=balanced
Security:   directoryBoundary=true
Autonomy:   default=semi
---
---
Configuration loaded successfully.
(Router coming in Phase 3, CLI interface in Phase 4)
```

- [ ] **Step 3：提交**

```powershell
git add src/index.ts
git commit -m "feat(cli): integrate LLM client manager into entry point"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 20 个用例）
4. `src/router/types.ts` 包含 Router 层全部类型 + LLM 客户端抽象接口
5. `src/agent/types.ts` 包含 Agent 层全部类型（Phase 5 可用）
6. `src/tools/types.ts` 包含 Tool 层全部类型（Phase 6 可用）
7. OpenAI 客户端支持非流式和流式两种模式
8. Anthropic 客户端支持非流式和流式两种模式，正确处理 system prompt 分离
9. LLMClientManager 能根据配置初始化多个客户端
10. 所有代码无 `any` 类型（SDK 类型约束的除外）
11. `pnpm start` 显示客户端初始化状态

## 注意事项

- **OpenAI SDK endpoint**：openai SDK 的 `baseURL` 不要包含 `/chat/completions`，SDK 会自动拼接。这是最常见的 bug
- **Anthropic system prompt**：Anthropic 的 system prompt 不在 messages 中，要单独传 `system` 参数。`splitSystemPrompt` 方法处理这个差异
- **Anthropic max_tokens**：Anthropic API 强制要求 `max_tokens` 参数，不设会报错。默认 4096
- **流式 usage**：OpenAI 需要 `stream_options: { include_usage: true }` 才能在流中获取 usage；Anthropic 的 usage 分散在 `message_start`（input_tokens）和 `message_delta`（output_tokens）两个事件中
- **工具调用流式**：OpenAI 的工具调用参数是分块到达的（tool_call_delta），需要累积；Anthropic 类似但事件结构不同
- **类型文件的前向兼容**：agent/types.ts 和 tools/types.ts 中的类型在后续 Phase 实现时可能需要微调。如果发现接口不满足实现需求，用 CONCERN 上报而不是自行修改
- **Phase 1 踩坑清单**：
  - pnpm 11 的 `allowBuilds` 已配置在 `pnpm-workspace.yaml`
  - tsconfig 已有 `ignoreDeprecations: "6.0"` 和 `types: ["node"]`
  - Zod 4 的 `z.preprocess` 模式已适配

---

*Phase 2 | 蓝图 V1.0 | 预估新增文件：~9 个 | 预估修改文件：~1 个（index.ts）*
