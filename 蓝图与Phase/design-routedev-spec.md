# RouteDev 技术规格 - 核心模块接口与数据结构

> 日期：2026-06-16 | 状态：草案 | 配套文档：design-routedev.md

## 1. Router 层接口

### 1.1 核心类型

```typescript
// 场景等级
type ScenarioTier = 'simple' | 'medium' | 'complex' | 'reasoning';

// 模型配置
interface ModelConfig {
  id: string;                    // 模型唯一标识，如 "deepseek-v4-flash"
  name: string;                  // 显示名称，如 "DeepSeek V4 Flash"
  provider: string;              // 提供商 ID，如 "opencode-go"
  tier: ScenarioTier;            // 默认归属等级
  contextWindow: number;         // 上下文窗口大小（token 数）
  capabilities: ModelCapability[]; // 能力标签
  latencyMs: number;             // 平均延迟（毫秒）
  available: boolean;            // 当前是否可用
  fallbackModelId?: string;      // 同 tier 备选模型
}

type ModelCapability = 'reasoning' | 'code' | 'multimodal' | 'fast' | 'cheap';

// 提供商配置
interface ProviderConfig {
  id: string;                    // 提供商唯一标识
  name: string;                  // 显示名称
  protocol: 'openai' | 'anthropic'; // API 协议
  baseUrl: string;               // API 基础 URL
  apiKey: string;                // API Key（加密存储）
  models: ModelConfig[];         // 该提供商下的模型列表
}

// 路由规则
interface RouterRule {
  tier: ScenarioTier;
  modelId: string;               // 默认模型
  fallbackModelId?: string;      // 降级模型
  maxTokensPerRequest?: number;  // 单次请求 token 上限
}

// Token 预算配置
interface TokenBudget {
  mode: 'track_only' | 'enforce';  // 仅统计 / 强制限制
  dailyLimit?: number;              // 日 token 上限
  perRequestLimit?: number;         // 单次请求上限
  degradationThreshold?: number;    // 触发降级的阈值（日消耗百分比）
}
```

### 1.2 ScenarioClassifier 接口

```typescript
interface ScenarioClassifier {
  /**
   * 分析用户输入，判断场景等级
   * 实现方式：用最便宜的模型做分类（few-shot prompt）
   * 输入：用户消息 + 当前对话上下文
   * 输出：场景等级 + 置信度
   */
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

interface ClassifyInput {
  userMessage: string;
  conversationContext: ConversationMessage[]; // 最近 N 条消息
  projectContext?: ProjectContext;            // 项目上下文摘要
}

interface ClassifyResult {
  tier: ScenarioTier;
  confidence: number;           // 0-1，低于阈值时回退到 medium
  reasoning: string;            // 分类理由（调试用）
  suggestedModelId?: string;    // 用户手动覆盖时的建议
}
```

### 1.3 ModelRouter 接口

```typescript
interface ModelRouter {
  /**
   * 根据场景等级 + 配置，选择具体模型
   * 考虑因素：tier → 默认模型 → 可用性 → 预算 → 降级
   */
  selectModel(tier: ScenarioTier, options?: RouteOptions): RouteDecision;

  /**
   * 手动覆盖路由选择
   */
  override(modelId: string): RouteDecision;

  /**
   * 获取当前路由状态
   */
  getStatus(): RouterStatus;
}

interface RouteOptions {
  forceModelId?: string;        // 用户手动指定模型
  maxTokens?: number;           // 本次请求 token 预算
  excludeModels?: string[];     // 排除的模型（如已失败的）
}

interface RouteDecision {
  modelId: string;              // 选中的模型
  tier: ScenarioTier;           // 场景等级
  isOverride: boolean;          // 是否为手动覆盖
  isDegraded: boolean;          // 是否已降级
  originalModelId?: string;     // 降级前的原始模型
  reason: string;               // 路由决策理由（可观测性）
}

interface RouterStatus {
  currentModel: string;
  currentTier: ScenarioTier;
  isDegraded: boolean;
  todayTokensUsed: number;
  todayTokensLimit?: number;
  recentDecisions: RouteDecision[]; // 最近 N 次路由决策
}
```

### 1.4 TokenTracker 接口

```typescript
interface TokenTracker {
  /**
   * 记录一次 token 消耗
   */
  record(usage: TokenUsage): void;

  /**
   * 获取当前消耗统计
   */
  getStats(): TokenStats;

  /**
   * 检查是否需要降级
   */
  shouldDegrade(): boolean;

  /**
   * 重置日统计（每日 0 点自动调用）
   */
  resetDaily(): void;
}

interface TokenUsage {
  modelId: string;
  agentId: string;               // 哪个 Agent 消耗的
  stepId: string;                // 哪个步骤
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
}

interface TokenStats {
  today: {
    total: number;
    byModel: Record<string, number>;   // 按模型
    byAgent: Record<string, number>;   // 按 Agent
    byStep: Record<string, number>;    // 按步骤类型
    byGoal: Record<string, number>;    // 按 /goal 任务
  };
  currentSession: {
    total: number;
    byModel: Record<string, number>;
  };
  history: DailyTokenSummary[];       // 历史每日摘要
}

interface DailyTokenSummary {
  date: string;                  // YYYY-MM-DD
  total: number;
  byModel: Record<string, number>;
  goalCount: number;             // 完成的 /goal 数
}
```

## 2. Agent 层接口

### 2.1 核心类型

```typescript
// Agent 身份
type AgentRole = 'orchestrator' | 'coder' | 'searcher' | 'tester' | 'reviewer';

// Agent 状态
type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting_approval' | 'error' | 'done';

// 自主度模式
type AutonomyMode = 'auto' | 'semi' | 'manual';

// 工作模式（参考 MiMo Code）
type WorkMode = 'build' | 'plan' | 'compose';

// 步骤状态
type StepStatus = 'pending' | 'running' | 'paused' | 'done' | 'error' | 'skipped';

// 文件操作类型
type FileOpType = 'read' | 'write' | 'delete' | 'execute';
```

### 2.2 OrchestratorAgent 接口

```typescript
interface OrchestratorAgent {
  /**
   * 处理 /goal 命令：分析目标，动态分解为子任务
   * 返回步骤列表供用户编辑/确认
   */
  decomposeGoal(goal: string, context: ProjectContext): Promise<StepPlan>;

  /**
   * 执行步骤计划：调度 Worker，处理冲突
   */
  executePlan(plan: StepPlan, mode: AutonomyMode): Promise<ExecutionResult>;

  /**
   * 检测 Worker 间的文件访问冲突
   * 返回冲突组：同组 Worker 需排队执行
   */
  detectConflicts(steps: StepPlan): ConflictGroup[];

  /**
   * 汇总 Worker 结果
   */
  aggregateResults(workerResults: WorkerResult[]): AggregatedResult;

  /**
   * 判断是否需要启用多 Agent
   * 三个条件：角色清晰分离 + 任务可拆 + 专长差异大
   */
  shouldUseMultiAgent(goal: string): boolean;
}

// 步骤计划
interface StepPlan {
  id: string;                      // 计划唯一 ID
  goal: string;                    // 原始目标
  steps: PlanStep[];               // 步骤列表（可编辑）
  conflictGroups: ConflictGroup[]; // 冲突组
  estimatedTiers: ScenarioTier[];  // 预估各步骤的 tier
  useMultiAgent: boolean;          // 是否启用多 Agent
}

interface PlanStep {
  id: string;
  description: string;             // 步骤描述
  agentRole: AgentRole;            // 推荐的 Agent 角色
  tier: ScenarioTier;              // 预估 tier
  fileAccess: FileAccess[];        // 预计访问的文件
  dependencies: string[];          // 依赖的步骤 ID
  status: StepStatus;
  result?: StepResult;
}

interface FileAccess {
  path: string;                    // 文件路径（相对项目根目录）
  opType: FileOpType;              // 操作类型
}

// 冲突组
interface ConflictGroup {
  conflictingStepIds: string[];    // 冲突的步骤 ID
  conflictFiles: string[];         // 冲突的文件路径
  resolution: 'parallel' | 'sequential'; // 执行策略
}

// 执行结果
interface ExecutionResult {
  planId: string;
  status: 'success' | 'partial' | 'failed';
  completedSteps: number;
  totalSteps: number;
  results: StepResult[];
  totalTokensUsed: number;
  duration: number;                // 毫秒
  checkpoints: Checkpoint[];       // 执行过程中的检查点
}

interface StepResult {
  stepId: string;
  status: StepStatus;
  output: string;                  // 步骤输出摘要
  filesModified: string[];         // 修改的文件列表
  linesAdded: number;
  linesDeleted: number;
  tokensUsed: number;
  duration: number;
  error?: StepError;
}

interface StepError {
  type: 'model_error' | 'tool_error' | 'conflict' | 'timeout' | 'approval_rejected';
  message: string;
  suggestion: string;              // 建议的处理方式
  recoverable: boolean;
}

interface AggregatedResult {
  summary: string;                 // 整体结果摘要
  filesModified: string[];
  totalLinesAdded: number;
  totalLinesDeleted: number;
  testResults?: TestResult;        // 测试结果（如有）
  qualityScore?: number;           // 质量评分（Evaluator-Optimizer 模式）
}

// Goal 验证器（参考 MiMo Code）
interface GoalVerifier {
  /**
   * 审查任务是否真正完成
   * 独立模型调用，不参与实际工作，避免认知偏差
   */
  verify(executionResult: ExecutionResult, condition: string): Promise<VerificationResult>;

  /**
   * 生成完成条件建议
   */
  suggestCondition(goal: string): Promise<string>;
}

interface VerificationResult {
  passed: boolean;                 // 是否通过验证
  confidence: number;              // 置信度 0-1
  reasoning: string;               // 验证理由
  missingItems: string[];          // 未满足的条件项
  suggestions: string[];           // 改进建议
}
```

### 2.3 WorkerAgent 接口

```typescript
interface WorkerAgent {
  readonly id: string;
  readonly role: AgentRole;
  readonly status: AgentStatus;

  /**
   * 执行单个步骤
   * 自主度控制：auto=直接执行，semi=危险操作暂停，manual=每步暂停
   */
  executeStep(step: PlanStep, mode: AutonomyMode): Promise<StepResult>;

  /**
   * 暂停执行（等待用户确认）
   */
  pause(): void;

  /**
   * 恢复执行（用户确认后）
   */
  resume(approval: ApprovalDecision): void;

  /**
   * 获取 Worker 的私有笔记
   */
  getPrivateNotes(): WorkerNotes;

  /**
   * 获取 Worker 的执行 Trace
   */
  getTrace(): AgentTrace;
}

type ApprovalDecision = 'approve' | 'reject' | 'modify';

// Worker 私有笔记
interface WorkerNotes {
  workerId: string;
  sessionId: string;
  entries: NoteEntry[];
}

interface NoteEntry {
  timestamp: number;
  stepId: string;
  type: 'observation' | 'decision' | 'intermediate_result' | 'error_detail';
  content: string;
  metadata?: Record<string, unknown>;
}

// Agent 执行 Trace
interface AgentTrace {
  agentId: string;
  steps: TraceStep[];
}

interface TraceStep {
  timestamp: number;
  type: 'model_call' | 'tool_call' | 'decision' | 'state_change';
  input: string;
  output: string;
  duration: number;
  tokensUsed?: TokenUsage;
  modelId?: string;
  toolName?: string;
}
```

### 2.4 DurableExecutor 接口

```typescript
interface DurableExecutor {
  /**
   * 启动持久化执行
   * 每完成一步自动保存状态
   */
  start(plan: StepPlan): Promise<ExecutionResult>;

  /**
   * 从上次成功的步骤恢复
   */
  resumeFrom(planId: string): Promise<ExecutionResult>;

  /**
   * 获取执行状态快照
   */
  getSnapshot(planId: string): ExecutionSnapshot;

  /**
   * 列出所有可恢复的执行
   */
  listRecoverable(): ExecutionSnapshot[];
}

interface ExecutionSnapshot {
  planId: string;
  goal: string;
  startedAt: number;
  lastStepCompleted: number;       // 最后完成的步骤索引
  totalSteps: number;
  status: 'running' | 'paused' | 'failed' | 'completed';
  completedResults: StepResult[];
  nextStep: PlanStep | null;
  createdAt: number;
}
```

### 2.5 通信协议

Orchestrator 与 Worker 之间的通信采用消息传递：

```typescript
// Agent 间消息
interface AgentMessage {
  id: string;
  from: string;                    // 发送方 Agent ID
  to: string;                      // 接收方 Agent ID（或 'orchestrator'）
  type: MessageType;
  payload: unknown;
  timestamp: number;
}

type MessageType =
  | 'task_assign'       // Orchestrator → Worker：分配任务
  | 'task_result'       // Worker → Orchestrator：返回结果
  | 'task_error'        // Worker → Orchestrator：报告错误
  | 'approval_request'  // Worker → Orchestrator：请求用户确认
  | 'approval_response' // Orchestrator → Worker：用户确认结果
  | 'cancel'            // Orchestrator → Worker：取消任务
  | 'status_query'      // Orchestrator → Worker：查询状态
  | 'status_response';  // Worker → Orchestrator：返回状态

// 任务分配消息
interface TaskAssignPayload {
  stepId: string;
  description: string;
  tier: ScenarioTier;
  fileAccess: FileAccess[];
  blackboardSnapshot: BlackboardSnapshot; // 公共黑板快照
  autonomyMode: AutonomyMode;
}

// 任务结果消息
interface TaskResultPayload {
  stepId: string;
  status: StepStatus;
  output: string;
  filesModified: string[];
  linesAdded: number;
  linesDeleted: number;
  tokensUsed: number;
  blackboardUpdates: BlackboardUpdate[]; // 需要更新到公共黑板的信息
}
```

## 3. Memory 层数据结构

### 3.1 公共黑板（Blackboard）

所有 Agent 共享的共识信息，由 Orchestrator 管理。

```typescript
interface Blackboard {
  projectId: string;
  sessionId: string;
  updatedAt: number;

  // 当前任务信息
  currentGoal?: GoalInfo;

  // 已完成的步骤摘要（只存结论，不存推理过程）
  completedSteps: StepSummary[];

  // 项目共识信息
  projectFacts: ProjectFact[];

  // 版本号（乐观锁，防止并发冲突）
  version: number;
}

interface GoalInfo {
  goalId: string;
  description: string;
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: number;
  useMultiAgent: boolean;
}

interface StepSummary {
  stepId: string;
  description: string;
  conclusion: string;             // 结论（不含推理过程）
  filesModified: string[];
  completedAt: number;
  workerId: string;
}

interface ProjectFact {
  key: string;                    // 如 "language", "framework", "testRunner"
  value: string;
  source: 'user' | 'inferred';   // 用户指定 / Agent 推断
  confidence: number;
  updatedAt: number;
}

// 公共黑板更新（Worker → Orchestrator）
interface BlackboardUpdate {
  type: 'add_step_summary' | 'add_project_fact' | 'update_goal_status';
  payload: StepSummary | ProjectFact | Partial<GoalInfo>;
}

// 公共黑板快照（Orchestrator → Worker，任务分配时附带）
interface BlackboardSnapshot {
  goalInfo: GoalInfo;
  relevantSteps: StepSummary[];   // 只传与当前任务相关的步骤
  relevantFacts: ProjectFact[];   // 只传与当前任务相关的事实
}
```

### 3.2 私有笔记（Worker Notes）

每个 Worker 的工作细节，仅自己可见。

```typescript
interface WorkerNotes {
  workerId: string;
  sessionId: string;
  entries: NoteEntry[];
}

interface NoteEntry {
  id: string;
  timestamp: number;
  stepId: string;
  type: NoteType;
  content: string;
  metadata?: Record<string, unknown>;
}

type NoteType =
  | 'observation'          // 观察到的事实
  | 'decision'             // 做出的决策及理由
  | 'intermediate_result'  // 中间计算/推理结果
  | 'error_detail'         // 错误详情
  | 'tool_output'          // 工具调用输出
  | 'model_response';      // 模型原始响应摘要

// 私有笔记裁剪规则
interface NotePruningRule {
  maxEntries: number;             // 最大条目数
  maxAgeMs: number;               // 最大保留时间
  keepTypes: NoteType[];          // 保留的类型
  summarizeThreshold: number;     // 超过此数量时自动摘要
}

// 临时记事本（MiMo Code 风格，主 Agent 唯一写入通道）
interface ScratchPad {
  sessionId: string;
  entries: ScratchEntry[];
}

interface ScratchEntry {
  id: string;
  timestamp: number;
  content: string;                // 自由格式文本
  tags: string[];                 // 可选标签，便于 Writer 归类
}
```

### 3.3 增量 Checkpoint（参考 MiMo Code）

```typescript
interface CheckpointWriter {
  /**
   * 触发 checkpoint
   * 在 token 消耗达到 20%/45%/70% 时自动调用
   */
  checkpoint(sessionId: string, triggerLevel: CheckpointTriggerLevel): Promise<Checkpoint>;

  /**
   * 从 checkpoint 重建上下文
   */
  restore(sessionId: string, checkpointId?: string): Promise<RestoredContext>;

  /**
   * 整理记忆（/dream 命令触发）
   * 合并去重、压缩、清理过期条目
   */
  dream(projectId: string): Promise<DreamResult>;
}

type CheckpointTriggerLevel = 20 | 45 | 70;

interface Checkpoint {
  id: string;
  sessionId: string;
  triggerLevel: CheckpointTriggerLevel;
  timestamp: number;
  isIncremental: boolean;         // 是否为增量更新
  previousCheckpointId?: string;  // 上一个 checkpoint ID

  // 11 个结构化字段
  currentIntent: string;
  nextAction: string;
  workingConstraints: string[];
  taskTree: TaskTreeNode[];
  currentWorkingFiles: string[];
  involvedFiles: string[];
  crossTaskDiscoveries: string[];
  errorsAndFixes: ErrorFixRecord[];
  runtimeState: Record<string, unknown>;
  designDecisions: DesignDecision[];
  miscNotes: string;
}

interface TaskTreeNode {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  children: TaskTreeNode[];
}

interface ErrorFixRecord {
  error: string;
  fix: string;
  timestamp: number;
}

interface DesignDecision {
  decision: string;
  reasoning: string;
  timestamp: number;
}

interface RestoredContext {
  checkpoint: Checkpoint;
  recentMessages: ConversationMessage[]; // 最近 N 条消息
  blackboard: Blackboard;
}

interface DreamResult {
  mergedEntries: number;
  removedEntries: number;
  newInsights: string[];
  updatedRules: ProjectRule[];
}
```

### 3.4 项目记忆（Project Memory）

跨会话持久的项目级信息。

```typescript
interface ProjectMemory {
  projectId: string;              // 项目唯一 ID（路径哈希）
  projectPath: string;            // 项目根目录绝对路径

  // 项目规则（类似 AGENTS.md）
  rules: ProjectRule[];

  // 项目上下文
  context: ProjectContext;

  // 历史决策
  decisions: DecisionRecord[];

  // 元信息
  createdAt: number;
  updatedAt: number;
  lastSessionId: string;
}

interface ProjectRule {
  id: string;
  category: 'coding_style' | 'architecture' | 'testing' | 'deployment' | 'custom';
  title: string;
  content: string;
  source: 'user' | 'inferred';
  priority: 'critical' | 'important' | 'suggestion';
}

interface ProjectContext {
  language: string;
  framework?: string;
  buildTool?: string;
  testFramework?: string;
  packageManager?: string;
  directoryStructure: DirectoryInfo;
  keyFiles: string[];             // 关键文件路径
  conventions: string[];          // 代码约定摘要
}

interface DirectoryInfo {
  srcDirs: string[];
  testDirs: string[];
  configFiles: string[];
  entryPoints: string[];
}

interface DecisionRecord {
  id: string;
  timestamp: number;
  sessionId: string;
  goal: string;
  decision: string;
  reasoning: string;
  outcome: 'success' | 'partial' | 'failed';
}
```

### 3.4 会话记忆（Session Memory）

单次会话内的上下文和进度。

```typescript
interface SessionMemory {
  sessionId: string;
  projectId: string;
  startedAt: number;

  // 对话消息
  messages: ConversationMessage[];

  // 分支信息
  branches: ConversationBranch[];

  // 当前 /goal 进度
  currentGoal?: GoalProgress;

  // 会话摘要（长对话自动压缩后）
  summary?: SessionSummary;

  // Token 统计
  tokenStats: SessionTokenStats;
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  modelId?: string;
  tier?: ScenarioTier;
  tokensUsed?: number;
  branchId: string;               // 所属分支
  parentId?: string;              // 父消息 ID（用于分支）
  metadata?: Record<string, unknown>;
}

// 对话分支（ChatGPT 式）
interface ConversationBranch {
  id: string;
  parentMessageId?: string;       // 从哪条消息分叉
  forkReason: 'user_edit' | 'user_delete' | 'retry';
  createdAt: number;
  isActive: boolean;              // 当前活跃分支
}

interface GoalProgress {
  goalId: string;
  planId: string;
  description: string;
  totalSteps: number;
  completedSteps: number;
  currentStepId?: string;
  status: 'planning' | 'executing' | 'paused' | 'completed' | 'failed';
  startedAt: number;
  checkpoints: Checkpoint[];
}

interface Checkpoint {
  id: string;
  stepId: string;
  gitCommitHash: string;
  timestamp: number;
  description: string;
  filesSnapshot: string[];        // 当时涉及的文件列表
}

// 会话摘要（自动压缩生成）
interface SessionSummary {
  generatedAt: number;
  originalMessageCount: number;
  keyTopics: string[];
  decisions: string[];
  codeChanges: string[];
  unresolvedIssues: string[];
  nextSteps: string[];
}

interface SessionTokenStats {
  totalInput: number;
  totalOutput: number;
  byModel: Record<string, { input: number; output: number }>;
  byAgent: Record<string, { input: number; output: number }>;
}
```

### 3.5 上下文压缩策略

```typescript
interface CompressionStrategy {
  /**
   * 触发条件：当前消息 token 数超过模型窗口的 X%
   */
  triggerThreshold: number;       // 默认 0.8（80%）

  /**
   * 压缩方式
   */
  method: 'sliding_window' | 'summary' | 'hybrid';

  /**
   * 保留策略
   */
  retention: RetentionPolicy;
}

interface RetentionPolicy {
  // 始终保留的消息
  keepRecentCount: number;        // 保留最近 N 条完整消息
  keepSystemPrompt: boolean;      // 保留系统提示
  keepGoalContext: boolean;       // 保留当前 /goal 上下文
  keepBlackboard: boolean;        // 保留公共黑板快照

  // 压缩历史消息
  compressOlderThan: number;      // 超过 N 条的消息压缩为摘要
  keepDecisionMessages: boolean;  // 保留包含决策的消息
}
```

## 4. 配置文件结构

### 4.1 全局配置 (config.yaml)

```yaml
# RouteDev 全局配置
version: 1

# 通用设置
general:
  language: zh-CN              # 界面语言
  theme: dark                  # dark / light
  startupBehavior: restore     # restore / project_select

# 提供商配置
providers:
  - id: opencode-go
    name: OpenCode Go
    protocol: openai
    baseUrl: https://opencode.ai/zen/go/v1
    apiKey: ${OPENCODE_API_KEY}  # 环境变量引用

  - id: opencode-go-anthropic
    name: OpenCode Go (Anthropic)
    protocol: anthropic
    baseUrl: https://opencode.ai/zen/go/v1
    apiKey: ${OPENCODE_API_KEY}

# 路由配置
router:
  rules:
    - tier: simple
      modelId: deepseek-v4-flash
    - tier: medium
      modelId: minimax-m3
    - tier: complex
      modelId: qwen3.7-plus
    - tier: reasoning
      modelId: kimi-k2.7
      fallbackModelId: deepseek-v4-pro
  budget:
    mode: track_only           # track_only / enforce
    dailyLimit: 500000         # 日 token 上限
  classifierModel: deepseek-v4-flash  # 分类用的模型

# Checkpoint 配置（Phase 3）
checkpoint:
  enabled: true
  triggers:                    # 三档触发阈值（可配置）
    - level: 20                # 百分比
      action: initial          # 首次 checkpoint
    - level: 45
      action: incremental      # 增量更新
    - level: 70
      action: compress         # 准备压缩
  modelId: deepseek-v4-flash   # CheckpointWriter 使用的模型
  maxTokensPerCheckpoint: 500  # 单次 checkpoint 最大 token 数

# Goal 验证配置（Phase 4）
goalVerifier:
  enabled: true
  modelId: kimi-k2.7           # 独立验证 Agent 使用的模型
  maxTokensPerVerification: 1000  # 单次验证最大 token 数
  autoVerify: true             # 是否自动验证（/goal 完成时）

# 安全配置
security:
  directoryBoundary: true
  commandBlacklist: ["rm -rf", "format", "del /s"]
  commandWhitelist: []         # 空表示不限制白名单
  sensitiveFiles: [".env", "credentials.json", "*.key"]
  sensitiveFilePolicy: readonly  # readonly / deny
  networkConfirm: true

# 自主度默认值
autonomy:
  defaultMode: semi            # auto / semi / manual

# 提示音
sounds:
  enabled: true
  completion: default          # 内置音效名
  error: warning
  approval: notification

# 更新
updates:
  checkOnStartup: true
  autoUpdate: false
```

### 4.2 项目配置 (.routedev.yaml)

项目根目录下，覆盖全局配置：

```yaml
# 项目级 RouteDev 配置
version: 1

# 项目规则（也可写在 .routedev/rules.md）
rules:
  - "使用中文注释"
  - "NeoForge 1.21.1 适配"
  - "所有注册通过 DeferredRegister"

# 项目覆盖的路由规则
router:
  rules:
    - tier: simple
      modelId: deepseek-v4-flash
    - tier: reasoning
      modelId: deepseek-v4-pro  # Minecraft 模组用 DeepSeek Pro

# 项目特定的安全配置
security:
  sensitiveFiles: [".env", "src/main/resources/*.properties"]

# 项目特定的工具配置
tools:
  mcpServers:
    - name: codegraph
      command: npx
      args: ["-y", "@anthropic/codegraph-mcp"]
```
