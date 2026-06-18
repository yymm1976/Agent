# RouteDev 技术规格 - Tool 层 / Harness 层 / UI 层

> 日期：2026-06-16 | 状态：草案 | 配套文档：design-routedev.md, design-routedev-spec.md

## 1. Tool 层接口

### 1.1 核心类型

```typescript
// 工具来源
type ToolSource = 'builtin' | 'mcp' | 'plugin';

// 工具权限级别
type ToolPermission = 'auto' | 'confirm' | 'deny';

// 工具执行状态
type ToolExecStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'timeout';

// 工具调用结果
interface ToolResult {
  toolName: string;
  status: ToolExecStatus;
  output: string;
  error?: string;
  duration: number;               // 毫秒
  tokensUsed?: number;            // 如果工具内部调用了模型
  artifacts?: ToolArtifact[];     // 产出物（文件、截图等）
}

interface ToolArtifact {
  type: 'file_created' | 'file_modified' | 'file_deleted' | 'image' | 'url';
  path?: string;
  url?: string;
  description: string;
}
```

### 1.2 工具注册表

```typescript
interface ToolRegistry {
  /**
   * 注册一个工具
   */
  register(tool: ToolDefinition): void;

  /**
   * 注销一个工具
   */
  unregister(toolId: string): void;

  /**
   * 获取所有可用工具
   */
  listTools(): ToolDefinition[];

  /**
   * 按来源筛选工具
   */
  getBySource(source: ToolSource): ToolDefinition[];

  /**
   * 按权限级别筛选工具
   */
  getByPermission(permission: ToolPermission): ToolDefinition[];

  /**
   * 获取工具定义（供模型 function calling 使用）
   */
  getFunctionSchemas(): FunctionSchema[];
}

interface ToolDefinition {
  id: string;                     // 唯一标识，如 "builtin.file_read"
  name: string;                   // 显示名称
  description: string;            // 工具描述（给模型看的）
  source: ToolSource;
  permission: ToolPermission;     // auto=自动执行, confirm=需确认, deny=禁止
  parameters: ToolParameter[];    // 参数定义
  handler: ToolHandler;           // 执行函数
}

interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
  enum?: string[];                // 可选值列表
  default?: unknown;
}

// 工具执行函数
type ToolHandler = (params: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;

interface ToolExecutionContext {
  projectId: string;
  projectPath: string;
  agentId: string;
  stepId: string;
  autonomyMode: AutonomyMode;
  securityPolicy: SecurityPolicy; // 当前安全策略
  timeout: number;                // 超时时间（毫秒）
}

// 模型 function calling 的 schema
interface FunctionSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema 格式
}
```

### 1.3 工具执行器

```typescript
interface ToolExecutor {
  /**
   * 执行工具调用
   * 权限检查 → 安全策略 → 执行 → 记录 Trace
   */
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;

  /**
   * 批量执行（并行，自动处理依赖）
   */
  executeBatch(calls: ToolCall[], context: ToolExecutionContext): Promise<ToolResult[]>;

  /**
   * 取消执行
   */
  cancel(callId: string): void;
}

interface ToolCall {
  id: string;
  toolId: string;
  parameters: Record<string, unknown>;
  requestedAt: number;
}

// 工具执行流程
// 1. 权限检查：permission=deny → 拒绝；confirm → 弹确认框
// 2. 安全策略检查：目录边界、命令黑名单、敏感文件保护
// 3. 执行工具 handler
// 4. 记录 Trace（输入/输出/耗时/token）
// 5. 返回结果
```

### 1.4 内置工具定义

```typescript
// 文件读取
const FILE_READ: ToolDefinition = {
  id: 'builtin.file_read',
  name: '读取文件',
  description: '读取指定文件的内容',
  source: 'builtin',
  permission: 'auto',
  parameters: [
    { name: 'path', type: 'string', required: true, description: '文件路径（相对项目根目录）' },
    { name: 'startLine', type: 'number', required: false, description: '起始行号' },
    { name: 'endLine', type: 'number', required: false, description: '结束行号' },
    { name: 'encoding', type: 'string', required: false, description: '编码', default: 'utf-8' },
  ],
  handler: fileReadHandler,
};

// 文件写入
const FILE_WRITE: ToolDefinition = {
  id: 'builtin.file_write',
  name: '写入文件',
  description: '创建或修改文件内容',
  source: 'builtin',
  permission: 'confirm',          // 写文件需确认
  parameters: [
    { name: 'path', type: 'string', required: true, description: '文件路径' },
    { name: 'content', type: 'string', required: true, description: '文件内容' },
    { name: 'createIfNotExists', type: 'boolean', required: false, description: '不存在时创建', default: true },
  ],
  handler: fileWriteHandler,
};

// 文件搜索
const FILE_SEARCH: ToolDefinition = {
  id: 'builtin.file_search',
  name: '搜索文件',
  description: '按内容或文件名搜索文件',
  source: 'builtin',
  permission: 'auto',
  parameters: [
    { name: 'query', type: 'string', required: true, description: '搜索关键词或正则' },
    { name: 'type', type: 'string', required: false, description: '搜索类型', enum: ['content', 'filename', 'glob'] },
    { name: 'filePattern', type: 'string', required: false, description: '文件名模式，如 *.java' },
    { name: 'maxResults', type: 'number', required: false, description: '最大结果数', default: 50 },
  ],
  handler: fileSearchHandler,
};

// Shell 执行
const SHELL_EXEC: ToolDefinition = {
  id: 'builtin.shell_exec',
  name: '执行命令',
  description: '在项目目录下执行 Shell 命令',
  source: 'builtin',
  permission: 'confirm',          // Shell 命令需确认
  parameters: [
    { name: 'command', type: 'string', required: true, description: '要执行的命令' },
    { name: 'timeout', type: 'number', required: false, description: '超时（秒）', default: 60 },
    { name: 'cwd', type: 'string', required: false, description: '工作目录' },
  ],
  handler: shellExecHandler,
};

// Git 操作
const GIT_OP: ToolDefinition = {
  id: 'builtin.git_op',
  name: 'Git 操作',
  description: '执行 Git 操作（diff, log, status, add, commit, push, branch）',
  source: 'builtin',
  permission: 'auto',             // 读取操作自动执行
  parameters: [
    { name: 'operation', type: 'string', required: true, description: 'Git 操作', enum: ['diff', 'log', 'status', 'add', 'commit', 'push', 'branch', 'checkout', 'stash'] },
    { name: 'args', type: 'array', required: false, description: '操作参数' },
  ],
  handler: gitOpHandler,
  // 注意：写操作（commit, push）在 handler 内部根据 operation 动态调整 permission
};

// 网络搜索
const WEB_SEARCH: ToolDefinition = {
  id: 'builtin.web_search',
  name: '网络搜索',
  description: '搜索互联网获取信息',
  source: 'builtin',
  permission: 'auto',
  parameters: [
    { name: 'query', type: 'string', required: true, description: '搜索关键词' },
    { name: 'maxResults', type: 'number', required: false, description: '最大结果数', default: 10 },
  ],
  handler: webSearchHandler,
};

// 代码搜索（基础 + 可选 CodeGraph 增强）
const CODE_SEARCH: ToolDefinition = {
  id: 'builtin.code_search',
  name: '代码搜索',
  description: '语义代码搜索，可接入 CodeGraph 增强搜索能力',
  source: 'builtin',
  permission: 'auto',
  parameters: [
    { name: 'query', type: 'string', required: true, description: '搜索意图描述' },
    { name: 'searchType', type: 'string', required: false, description: '搜索类型', enum: ['semantic', 'text', 'symbol'], default: 'semantic' },
    { name: 'targetDirs', type: 'array', required: false, description: '搜索范围目录' },
    { name: 'maxResults', type: 'number', required: false, description: '最大结果数', default: 20 },
  ],
  handler: codeSearchHandler,
  // handler 内部检测 CodeGraph MCP 是否可用，可用则增强搜索
};
```

### 1.5 MCP 客户端

```typescript
interface McpClient {
  /**
   * 连接 MCP Server
   */
  connect(config: McpServerConfig): Promise<void>;

  /**
   * 断开 MCP Server
   */
  disconnect(serverId: string): Promise<void>;

  /**
   * 列出已连接的 MCP Server
   */
  listServers(): McpServerStatus[];

  /**
   * 获取 MCP Server 提供的工具列表
   */
  listTools(serverId: string): Promise<ToolDefinition[]>;

  /**
   * 调用 MCP 工具
   */
  callTool(serverId: string, toolName: string, params: Record<string, unknown>): Promise<ToolResult>;

  /**
   * 导入/导出 MCP 配置
   */
  exportConfig(): McpConfigFile;
  importConfig(config: McpConfigFile): Promise<void>;
}

interface McpServerConfig {
  id: string;
  name: string;
  command: string;                // 启动命令，如 "npx"
  args: string[];                 // 启动参数
  env?: Record<string, string>;   // 环境变量
  autoStart: boolean;             // 是否自动启动
}

interface McpServerStatus {
  id: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  lastConnectedAt?: number;
  error?: string;
}

interface McpConfigFile {
  version: number;
  servers: McpServerConfig[];
}
```

### 1.6 插件系统

```typescript
interface PluginSystem {
  /**
   * 加载插件
   */
  load(pluginPath: string): Promise<Plugin>;

  /**
   * 卸载插件
   */
  unload(pluginId: string): Promise<void>;

  /**
   * 列出已加载插件
   */
  listPlugins(): Plugin[];

  /**
   * 获取插件提供的工具
   */
  getPluginTools(pluginId: string): ToolDefinition[];

  /**
   * 获取插件提供的 Hook
   */
  getPluginHooks(pluginId: string): HookDefinition[];

  /**
   * 获取插件提供的路由策略
   */
  getPluginRouter(pluginId: string): RouterPlugin | null;
}

interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  type: PluginType[];
  author: string;
  entryPoint: string;
  config?: PluginConfig;
}

type PluginType = 'theme' | 'tool' | 'hook' | 'router';

interface PluginConfig {
  schema: Record<string, unknown>;  // JSON Schema
  values: Record<string, unknown>;  // 当前配置值
}

// 路由插件接口
interface RouterPlugin {
  /**
   * 替换默认路由逻辑
   * 返回 null 表示使用默认路由
   */
  route(input: ClassifyInput, models: ModelConfig[]): RouteDecision | null;
}

// Hook 插件接口
interface HookDefinition {
  event: HookEvent;
  handler: HookHandler;
}

type HookEvent = 'pre-step' | 'post-step' | 'on-error' | 'on-complete';
type HookHandler = (context: HookContext) => Promise<HookResult>;

interface HookContext {
  stepId: string;
  agentId: string;
  stepResult?: StepResult;
  error?: StepError;
  projectPath: string;
}

interface HookResult {
  action: 'continue' | 'abort' | 'retry' | 'skip';
  message?: string;
  modifiedResult?: StepResult;
}
```

## 2. Harness 层接口

### 2.1 安全策略与审计日志

```typescript
interface SecurityPolicy {
  // 目录边界
  directoryBoundary: {
    enabled: boolean;
    allowedPaths: string[];        // 允许操作的路径（默认只有项目目录）
    deniedPaths: string[];         // 禁止操作的路径
  };

  // 命令控制
  commandControl: {
    blacklist: string[];           // 禁止的命令模式
    whitelist: string[];           // 允许的命令模式（空=不限制）
    mode: 'blacklist' | 'whitelist' | 'both';
  };

  // 敏感文件保护
  sensitiveFiles: {
    patterns: string[];            // 文件名模式，如 ".env", "*.key"
    policy: 'readonly' | 'deny';  // 只读或禁止访问
  };

  // 网络请求
  networkConfirm: {
    enabled: boolean;
    allowedDomains: string[];      // 允许的域名（不弹确认）
    deniedDomains: string[];       // 禁止的域名
  };
}

interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
  overrideAvailable: boolean;     // 用户是否可以手动覆盖
}

// 操作审计日志（参考 ZCode）
interface AuditLogger {
  /**
   * 记录操作
   */
  log(entry: AuditEntry): void;

  /**
   * 查询审计日志
   */
  query(filter: AuditFilter): AuditEntry[];

  /**
   * 导出审计日志
   */
  export(format: 'json' | 'csv', dateRange?: DateRange): string;
}

interface AuditEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  agentId: string;
  stepId?: string;

  // 操作信息
  actionType: 'file_read' | 'file_write' | 'file_delete' | 'shell_exec' | 'git_op' | 'model_call' | 'tool_call' | 'approval';
  target: string;                 // 目标文件/命令/模型
  parameters?: Record<string, unknown>;

  // 结果
  result: 'success' | 'failure' | 'cancelled';
  error?: string;

  // 变更对比（文件操作）
  beforeHash?: string;            // 操作前文件 hash
  afterHash?: string;             // 操作后文件 hash
  diff?: string;                  // unified diff

  // 确认信息
  approvalRequired: boolean;
  approvedBy?: string;            // 用户 ID 或 'auto'
  approvedAt?: number;

  // 路由信息
  modelId?: string;
  tier?: ScenarioTier;
  tokensUsed?: number;
}

interface AuditFilter {
  sessionId?: string;
  agentId?: string;
  actionType?: AuditEntry['actionType'];
  target?: string;
  dateRange?: DateRange;
  result?: 'success' | 'failure' | 'cancelled';
}

interface DateRange {
  start: number;
  end: number;
}
```

### 2.2 容器沙箱

```typescript
interface Sandbox {
  /**
   * 创建沙箱容器
   */
  create(config: SandboxConfig): Promise<SandboxInstance>;

  /**
   * 在沙箱中执行命令
   */
  exec(instanceId: string, command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;

  /**
   * 复制文件到沙箱
   */
  copyIn(instanceId: string, srcPath: string, destPath: string): Promise<void>;

  /**
   * 从沙箱复制文件出来
   */
  copyOut(instanceId: string, srcPath: string, destPath: string): Promise<void>;

  /**
   * 销毁沙箱
   */
  destroy(instanceId: string): Promise<void>;
}

interface SandboxConfig {
  image: string;                  // Docker 镜像
  workDir: string;                // 工作目录
  mountPoints: MountPoint[];      // 挂载点
  networkMode: 'none' | 'restricted' | 'host'; // 网络模式
  memoryLimit: string;            // 内存限制，如 "512m"
  cpuLimit: number;               // CPU 限制（核心数）
  timeout: number;                // 超时（秒）
}

interface MountPoint {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}
```

### 2.3 检查点管理

```typescript
interface CheckpointManager {
  /**
   * 创建检查点（git commit）
   */
  create(stepId: string, description: string): Promise<Checkpoint>;

  /**
   * 回滚到指定检查点
   */
  rollback(checkpointId: string): Promise<RollbackResult>;

  /**
   * 列出所有检查点
   */
  list(goalId?: string): Checkpoint[];

  /**
   * 获取检查点差异
   */
  diff(checkpointId: string): Promise<CheckpointDiff>;

  /**
   * 清理旧检查点（保留最近 N 个）
   */
  prune(keepCount: number): Promise<number>;
}

interface Checkpoint {
  id: string;
  stepId: string;
  goalId: string;
  gitCommitHash: string;
  timestamp: number;
  description: string;
  filesSnapshot: string[];
  isAutoCreated: boolean;         // 自动创建 vs 手动创建
}

interface RollbackResult {
  checkpointId: string;
  filesRestored: string[];
  linesReverted: number;
  success: boolean;
  error?: string;
}

interface CheckpointDiff {
  checkpointId: string;
  previousCheckpointId?: string;
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
  patch: string;                  // unified diff 格式
}
```

### 2.4 测试运行器

```typescript
interface TestRunner {
  /**
   * 自动检测项目测试框架
   */
  detectFramework(projectPath: string): TestFramework | null;

  /**
   * 运行测试
   */
  run(config: TestRunConfig): Promise<TestResult>;

  /**
   * 运行与指定文件相关的测试
   */
  runRelated(changedFiles: string[]): Promise<TestResult>;
}

interface TestFramework {
  name: string;                   // 如 "jest", "pytest", "gradle"
  command: string;                // 运行命令
  configPath?: string;            // 配置文件路径
  testDir: string;                // 测试目录
}

interface TestRunConfig {
  framework: TestFramework;
  targetFiles?: string[];         // 指定测试文件（空=全部）
  timeout: number;
  env?: Record<string, string>;
}

interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: TestFailure[];
  coverage?: TestCoverage;
}

interface TestFailure {
  testName: string;
  file: string;
  line: number;
  error: string;
  stackTrace: string;
}

interface TestCoverage {
  lines: number;                  // 百分比
  branches: number;
  functions: number;
}
```

## 3. UI 层组件接口

### 3.1 状态管理

```typescript
// 全局应用状态
interface AppState {
  // 当前项目
  currentProject: ProjectInfo | null;

  // 当前会话
  currentSession: SessionInfo | null;

  // 路由状态
  routerStatus: RouterStatus;

  // Agent 状态
  agentStatuses: Record<string, AgentStatusInfo>;

  // Token 统计
  tokenStats: TokenStats;

  // UI 状态
  ui: UiState;
}

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
  sessionCount: number;
}

interface SessionInfo {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  messageCount: number;
  currentGoal?: GoalProgress;
}

interface AgentStatusInfo {
  agentId: string;
  role: AgentRole;
  status: AgentStatus;
  currentStep?: string;
  progress?: number;              // 0-100
}

interface UiState {
  theme: 'dark' | 'light';
  language: 'zh-CN' | 'en-US';
  sidebarCollapsed: boolean;
  activePanel: 'chat' | 'steps' | 'trace' | 'memory';
  showDiffView: boolean;          // 代码变更显示模式
  soundEnabled: boolean;
}
```

### 3.2 Chat 组件接口

```typescript
interface ChatComponent {
  // 消息列表
  messages: ChatMessage[];

  // 当前活跃分支
  activeBranchId: string;

  // 分支列表
  branches: BranchInfo[];

  // 输入状态
  inputState: ChatInputState;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  branchId: string;
  parentId?: string;

  // 执行卡片（assistant 消息特有）
  executionCard?: ExecutionCard;

  // 模型信息
  modelId?: string;
  tier?: ScenarioTier;
  tokensUsed?: number;

  // 代码变更摘要
  codeChange?: CodeChangeSummary;
}

interface ExecutionCard {
  stepId: string;
  status: StepStatus;
  title: string;
  tools: ToolCallSummary[];
  duration: number;
  expandable: boolean;
  expanded: boolean;
}

interface ToolCallSummary {
  toolName: string;
  status: ToolExecStatus;
  duration: number;
  resultPreview: string;          // 结果预览（截断）
}

interface CodeChangeSummary {
  filesModified: number;
  linesAdded: number;
  linesDeleted: number;
  showDiff: boolean;              // 是否展开 Diff
  diff?: string;                  // unified diff（按需加载）
}

interface BranchInfo {
  id: string;
  parentMessageId: string;
  label: string;                  // 分支标签，如 "编辑后", "重试"
  createdAt: number;
  messageCount: number;
  isActive: boolean;
}

interface ChatInputState {
  text: string;
  isVoiceActive: boolean;
  autonomyMode: AutonomyMode;
  currentModel: string;
  currentTier: ScenarioTier;
}
```

### 3.3 步骤编辑器组件

```typescript
interface StepEditorComponent {
  // 步骤计划
  plan: StepPlan | null;

  // 编辑状态
  editState: StepEditState;

  // 拖拽状态
  dragState: DragState | null;
}

interface StepEditState {
  isEditing: boolean;
  editingStepId: string | null;
  editMode: 'description' | 'tier' | 'agent_role' | 'file_access';
}

interface DragState {
  draggedStepId: string;
  targetIndex: number;
  isDragging: boolean;
}

// Notion 风格卡片数据
interface StepCard {
  step: PlanStep;
  isEditing: boolean;
  isDragging: boolean;
  showDetails: boolean;
  conflictInfo?: ConflictInfo;
}

interface ConflictInfo {
  hasConflict: boolean;
  conflictingWith: string[];      // 冲突的步骤 ID
  resolution: 'parallel' | 'sequential';
}
```

### 3.4 侧边栏组件

```typescript
interface SidebarComponent {
  // 项目列表
  projects: ProjectListItem[];

  // 对话列表
  conversations: ConversationListItem[];

  // Token 统计
  tokenDisplay: TokenDisplay;

  // 模型状态
  modelDisplay: ModelDisplay;

  // 运行状态
  statusDisplay: StatusDisplay;
}

interface ProjectListItem {
  id: string;
  name: string;
  path: string;
  isActive: boolean;
  sessionCount: number;
  lastOpenedAt: number;
}

interface ConversationListItem {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  hasActiveGoal: boolean;
  goalStatus?: 'executing' | 'paused' | 'completed';
}

interface TokenDisplay {
  currentRequest: number;
  sessionTotal: number;
  todayTotal: number;
  todayLimit?: number;
  byModel: Record<string, number>;
}

interface ModelDisplay {
  currentModel: string;
  currentTier: ScenarioTier;
  isDegraded: boolean;
  modelInfo: {
    contextWindow: number;
    capabilities: ModelCapability[];
    latencyMs: number;
    available: boolean;
  };
}

interface StatusDisplay {
  agentStatus: 'idle' | 'running' | 'paused' | 'error';
  activeWorkers: number;
  currentGoal?: string;
  progress?: number;              // 0-100
}
```

### 3.5 配置向导组件

```typescript
interface SetupWizard {
  currentStep: number;            // 1-5
  steps: WizardStep[];
  config: Partial<AppConfig>;     // 累积的配置
}

interface WizardStep {
  id: string;
  title: string;
  description: string;
  component: string;              // React 组件名
  validation?: (config: Partial<AppConfig>) => ValidationResult;
}

interface AppConfig {
  provider: ProviderConfig;
  models: ModelConfig[];
  router: RouterRule[];
  budget: TokenBudget;
  projectPath: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// 向导步骤定义
const WIZARD_STEPS: WizardStep[] = [
  {
    id: 'welcome',
    title: '欢迎使用 RouteDev',
    description: '选择 API 提供商',
    component: 'ProviderSelect',
  },
  {
    id: 'apikey',
    title: '配置 API',
    description: '输入 API Key 和模型 URL',
    component: 'ApiKeyInput',
    validation: (config) => ({
      valid: !!config.provider?.apiKey,
      errors: config.provider?.apiKey ? [] : ['请输入 API Key'],
      warnings: [],
    }),
  },
  {
    id: 'models',
    title: '选择模型',
    description: '自动检测可用模型，配置路由',
    component: 'ModelConfig',
  },
  {
    id: 'budget',
    title: '设置预算',
    description: '配置 Token 预算和路由偏好',
    component: 'BudgetConfig',
  },
  {
    id: 'project',
    title: '关联项目',
    description: '选择要关联的项目目录',
    component: 'ProjectSelect',
    validation: (config) => ({
      valid: !!config.projectPath,
      errors: config.projectPath ? [] : ['请选择项目目录'],
      warnings: [],
    }),
  },
];
```

### 3.6 Trace 面板组件

```typescript
interface TracePanelComponent {
  // 当前 Trace 数据
  trace: AgentTrace | null;

  // 过滤器
  filters: TraceFilters;

  // 展开状态
  expandedSteps: Set<string>;
}

interface TraceFilters {
  agentId?: string;
  type?: TraceStep['type'];
  timeRange?: { start: number; end: number };
}

// Trace 可视化：时间线 + 调用关系图
interface TraceVisualization {
  // 时间线视图
  timeline: TraceTimelineEntry[];

  // 调用关系图
  callGraph: TraceCallNode[];
}

interface TraceTimelineEntry {
  step: TraceStep;
  depth: number;                  // 嵌套深度
  barStart: number;               // 时间线起始位置（百分比）
  barWidth: number;               // 时间线宽度（百分比）
}

interface TraceCallNode {
  agentId: string;
  stepId: string;
  children: TraceCallNode[];
  duration: number;
  tokensUsed: number;
}
```
