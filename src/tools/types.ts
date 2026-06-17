// src/tools/types.ts
// Tool 层核心类型定义（Phase 6 可用）
// 包含：工具接口、工具注册、工具执行结果、权限模型

// ============================================================
// 工具接口
// ============================================================

/** 工具参数 JSON Schema */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  /** 工具是否需要用户确认（写操作通常需要） */
  requiresApproval: boolean;
  /** 工具分类 */
  category: 'file' | 'shell' | 'git' | 'web' | 'search' | 'code' | 'system' | 'mcp';
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  /** 工作目录 */
  workingDirectory: string;
  /** 允许访问的目录边界 */
  allowedDirectories: string[];
  /** 环境变量 */
  environment: Record<string, string>;
  /** 超时时间（毫秒） */
  timeoutMs: number;
}

/** 工具执行结果 */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 额外元数据（如文件变更列表） */
  metadata?: Record<string, unknown>;
}

/** 工具接口（所有内置/自定义工具必须实现） */
export interface ITool {
  readonly definition: ToolDefinition;

  /** 执行工具 */
  execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;

  /** 检查参数是否有效 */
  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] };
}

// ============================================================
// 工具注册表
// ============================================================

/** 工具注册表接口 */
export interface IToolRegistry {
  /** 注册工具 */
  register(tool: ITool): void;

  /** 注销工具 */
  unregister(name: string): void;

  /** 获取工具 */
  get(name: string): ITool | undefined;

  /** 列出所有工具 */
  list(): ITool[];

  /** 检查工具是否存在 */
  has(name: string): boolean;
}

// ============================================================
// 权限模型
// ============================================================

/** 权限级别（deny > confirm > auto，最严格规则永远胜出） */
export type PermissionLevel = 'auto' | 'confirm' | 'deny';

/** 权限规则 */
export interface PermissionRule {
  /** 工具名称（支持 glob 模式，如 "file_*"） */
  toolPattern: string;
  /** 权限级别 */
  level: PermissionLevel;
  /** 规则描述 */
  description?: string;
}

/** 权限检查器接口 */
export interface IPermissionChecker {
  /** 检查工具执行权限 */
  checkPermission(toolName: string, args: Record<string, unknown>): PermissionLevel;

  /** 添加权限规则 */
  addRule(rule: PermissionRule): void;

  /** 移除权限规则 */
  removeRule(toolPattern: string): void;
}

// ============================================================
// 安全检查
// ============================================================

/** 安全检查结果 */
export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  /** 是否需要用户确认 */
  requiresConfirmation: boolean;
}

/** 安全检查器接口 */
export interface ISecurityChecker {
  /** 检查文件路径是否安全 */
  checkFilePath(filePath: string, context: ToolExecutionContext): SecurityCheckResult;

  /** 检查命令是否安全 */
  checkCommand(command: string, context: ToolExecutionContext): SecurityCheckResult;

  /** 检查网络请求是否安全 */
  checkNetworkRequest(url: string): SecurityCheckResult;
}

// ============================================================
// 工具执行器
// ============================================================

/** 工具执行器接口（负责调度工具执行 + 权限检查 + 安全检查） */
export interface IToolExecutor {
  /** 执行工具（带完整检查） */
  execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;

  /** 设置权限检查器 */
  setPermissionChecker(checker: IPermissionChecker): void;

  /** 设置安全检查器 */
  setSecurityChecker(checker: ISecurityChecker): void;
}

// ============================================================
// 内置工具类型（Phase 6 实现）
// ============================================================

/** 文件操作工具参数 */
export interface FileToolArgs {
  path: string;
  content?: string;
  encoding?: 'utf-8' | 'base64';
}

/** Shell 执行工具参数 */
export interface ShellToolArgs {
  command: string;
  workingDirectory?: string;
  timeoutMs?: number;
}

/** Git 操作工具参数 */
export interface GitToolArgs {
  operation: 'status' | 'add' | 'commit' | 'push' | 'pull' | 'diff' | 'log';
  args?: string[];
}

/** 网页抓取工具参数 */
export interface WebFetchToolArgs {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/** 代码搜索工具参数 */
export interface CodeSearchToolArgs {
  pattern: string;
  path?: string;
  filePattern?: string;
  maxResults?: number;
}
