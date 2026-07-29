// src/tools/types.ts
// Tool 层核心类型定义（Phase 6 可用）
// 包含：工具接口、工具注册、工具执行结果、权限模型
//
// P0-1/P0-2/P0-3 改造（2026-07-05）：
//   - 新增 buildTool 工厂 + ToolDef 配置对象类型（借鉴 Claude Code）
//   - 新增 ValidationResult 辨识联合（带 errorCode 与 behavior）
//   - 新增 ITool.backfillObservableInput 可选方法（防 hook 绕过）
//   - 旧 ITool 类继承模式保留兼容，新工具优先用 buildTool

// ============================================================
// 工具接口
// ============================================================

/** 工具参数 JSON Schema */
interface ToolParameterSchema {
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
  /**
   * Phase 73 Part B：工具执行模式
   *   - 'sequential'：串行执行（有状态竞争的工具，如 ask_user/file_edit/shell_exec）
   *   - 'parallel'：并行执行（默认，无状态竞争的只读工具）
   *
   * ReActAgentLoop 在并行分支前会扫描 batch 中所有工具的 executionMode，
   * 若任一为 'sequential'，则整个 batch 回退为串行执行，避免状态竞争。
   */
  executionMode?: 'sequential' | 'parallel';
  /**
   * Phase 96 P1-6：是否启用 Structured Outputs / Constrained Sampling
   *
   * 设为 true 时，OpenAI 客户端会透传 strict=true 给 API，模型输出严格遵循
   * parameters 定义的 JSON Schema（不支持的字段会被拒绝）。
   * Anthropic/Gemini 协议无 strict 字段，此字段被忽略（input_schema 本身即约束）。
   *
   * 缺省为 undefined，由 client 默认行为决定。
   * 注意：OpenAI strict=true 要求 parameters 必须是完整的 JSON Schema（含 type/properties），
   * 且不支持 additionalProperties、$ref、union type 等高级特性。
   */
  strict?: boolean;
}

/**
 * P0-2：辨识联合验证结果（借鉴 Claude Code）
 *
 * - `result: true` 表示通过，无附加字段
 * - `result: false` 表示失败，必带 message + errorCode，可选 behavior
 * - errorCode 用于错误归因与自动修复路由（如 "ERR_NOT_READ" → 自动 Read 再 Edit）
 * - behavior='ask' 让 harness 决定弹窗确认还是直接拒绝
 *
 * 数字 errorCode 建议约定：
 *   1 = 参数缺失 / 类型错误
 *   2 = 参数值非法（如路径不存在）
 *   3 = 权限拒绝
 *   4 = 路径越界
 *   5 = 命令危险
 *   6 = 文件未读取（stale-check 失败）
 *   7 = 内容冲突
 */
export type ValidationResult =
  | { result: true }
  | {
      result: false;
      /** 人类可读错误描述 */
      message: string;
      /** 数字错误码，用于归因与自动修复路由 */
      errorCode: number;
      /** 'ask' = 允许 harness 弹窗确认后重试；不填 = 直接拒绝 */
      behavior?: 'ask';
    };

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
  /** 当前自主度；auto 仅跳过可确认项，绝不绕过安全硬拒绝。 */
  autonomyMode?: 'auto' | 'semi' | 'manual';
  /**
   * 可选：用户确认回调
   * 当安全检查返回 requiresConfirmation=true 时，executor 会调用此回调请求用户确认
   * 返回 true 表示用户同意执行，false 表示拒绝
   * 未提供时：requiresConfirmation=true 的工具会被拒绝执行（安全默认）
   */
  requestConfirmation?: (reason: string) => Promise<boolean>;
  /**
   * Phase 96 P1-1：可选的 AbortSignal，传递给工具以支持中途取消
   *
   * shell_exec 等长任务工具应监听 signal.aborted 并终止子进程；
   * 其他工具可忽略此字段（短任务无需取消支持）
   */
  signal?: AbortSignal;
  /**
   * Phase 96 P1-1：可选的增量输出回调
   *
   * shell_exec 等长任务工具在收到 stdout/stderr 增量时调用此回调，
   * 把中间状态推送给上层（loop → IPC → 渲染层），让用户和 LLM 看到执行进度
   *
   * 注意：回调应做节流处理（如 100ms），避免高频 stdout 触发过多事件
   */
  onUpdate?: (chunk: string) => void;
}

// ============================================================
// Phase 72 Task C1：工具返回 status 三态化
// ============================================================

/**
 * 工具执行状态三态：
 *   - success：完全成功
 *   - partial：部分成功（如搜索无匹配、批量操作部分失败）
 *   - error：失败
 *
 * 设计动机：原 ToolResult.success 为 boolean，无法区分"完全失败"与"语义上可接受的空结果"。
 * 三态化让上游（Agent 决策、评估器、UI）能基于更精细的状态做路由。
 */
export type ToolStatus = 'success' | 'partial' | 'error';

/**
 * 结构化错误码（限定枚举，便于归因与自动修复路由）
 *   - NOT_FOUND：资源未找到（文件/搜索匹配/工具目标）
 *   - CONFLICT：并发冲突（文件被外部修改、乐观锁失败）
 *   - PERMISSION_DENIED：权限拒绝
 *   - TIMEOUT：超时
 *   - UNKNOWN：未归类错误
 */
export type ToolErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'UNKNOWN';

/**
 * 结构化工具结果（三态化封装）
 *
 * 作为 ToolResult.structured 字段使用，不替代原有 string output：
 *   - success 路径：{ status: 'success', data?: ... }
 *   - partial 路径（如搜索无匹配）：{ status: 'partial', error: { code: 'NOT_FOUND', ... } }
 *   - error 路径：{ status: 'error', error: { code: 'CONFLICT', ... } }
 */
export interface StructuredToolResult {
  status: ToolStatus;
  data?: unknown;
  error?: { code: ToolErrorCode; message: string };
  /**
   * Phase 96 P2-10：执行结果中携带的图片内容（base64 编码）
   * 仅 file_read 等图片读取工具会填充此字段，loop 收到后会注入为 ContentPart.image
   */
  images?: Array<{ mediaType: string; data: string }>;
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
  /**
   * Phase 96 P2-10：图片内容（用于多模态 LLM 输入）
   *
   * file_read 读取图片文件时填充此字段，上游 LLM 客户端会将其转换为
   * ContentPart.image 注入到消息中。output 字段仍保留简短描述（如"[图片: foo.png 800x600]"）。
   * 非图片文件不填充此字段。
   */
  images?: Array<{ mediaType: string; data: string }>;
  /**
   * Phase 72 Task C1：结构化三态结果（可选增强字段）
   *
   * - 不替代 success / output / error 字段，保持现有 string 返回兼容性
   * - 工具可在特定错误分支（如 CONFLICT / NOT_FOUND）填充此字段，
   *   上游若关心三态可读取 structured.status，不关心则继续用 success boolean
   */
  structured?: StructuredToolResult;
}

/** 工具执行的结构化响应（工具永远不 throw，失败通过 isError 标记） */
export interface ToolResponse {
  /** 响应文本（成功时的结果 / 失败时的错误描述） */
  content: string;
  /** 是否为错误 */
  isError: boolean;
  /** 可选的结构化数据（供后续工具链使用） */
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

  /**
   * P0-3：可观测输入回填（借鉴 Claude FileEditTool.backfillObservableInput）
   *
   * 在权限校验和 hook 匹配**之前**调用，把 args 中的相对路径、~、符号链接
   * 展开为绝对路径并规范化。返回更新后的 args（可原样返回 args 表示无需修改）。
   *
   * 默认实现：返回原 args（不影响现有工具）。
   * 路径类工具应覆盖此方法，确保 ConfigGuard / CommandSandbox / hook 白名单
   * 始终基于绝对路径匹配，杜绝通过 `~/foo` / `./foo` / `..` 等绕过白名单。
   */
  backfillObservableInput?(args: Record<string, unknown>, context: ToolExecutionContext): Record<string, unknown>;
}

// ============================================================
// P0-1：buildTool 工厂 + ToolDef 配置对象（借鉴 Claude Code）
// ============================================================

/**
 * ToolDef：buildTool 输入的配置对象形状。
 *
 * 与 ITool 的差异：
 *   - `execute` / `validateArgs` 作为字段而非方法，便于闭包捕获
 *   - `backfillObservableInput` 可选
 *   - `definition` 字段拆平为顶层 name/description/parameters/requiresApproval/category
 *     减少嵌套层级，配置对象更扁平可读
 */
export interface ToolDef {
  /** 工具名（唯一标识，LLM 通过此名调用） */
  name: string;
  /** 工具描述（注入 system prompt，决定 LLM 何时选用此工具） */
  description: string;
  /** 参数 JSON Schema */
  parameters: ToolParameterSchema;
  /** 是否需要用户确认 */
  requiresApproval: boolean;
  /** 工具分类 */
  category: ToolDefinition['category'];
  /** Phase 73 Part B：工具执行模式（未设置时默认 'parallel'） */
  executionMode?: ToolDefinition['executionMode'];
  /** 参数校验：返回辨识联合，相比 { valid; errors } 支持 errorCode 与 behavior */
  validate?: (args: Record<string, unknown>) => ValidationResult;
  /** 兼容旧签名：返回 { valid; errors }。与 validate 二选一，validate 优先 */
  validateArgs?: (args: Record<string, unknown>) => { valid: boolean; errors: string[] };
  /** 执行工具，返回结构化结果 */
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
  /** 可选：路径回填，防 hook 绕过 */
  backfillObservableInput?: (args: Record<string, unknown>, context: ToolExecutionContext) => Record<string, unknown>;
}

/**
 * buildTool：把 ToolDef 配置对象包装为 ITool 实例。
 *
 * - 旧类继承模式（class XxxTool implements ITool）继续兼容
 * - 新工具优先用 buildTool，配置对象更扁平、可组合、易序列化
 * - validate 与 validateArgs 二选一：若提供 validate（辨识联合），自动适配为
 *   ITool.validateArgs 的 { valid; errors } 形状以保持向后兼容
 *
 * @example
 * export const fooTool = buildTool({
 *   name: 'foo',
 *   description: '做 foo',
 *   parameters: { type: 'object', properties: {}, required: [] },
 *   requiresApproval: false,
 *   category: 'system',
 *   validate(args) {
 *     return args.x ? { result: true } : { result: false, message: '缺 x', errorCode: 1 };
 *   },
 *   async execute(args, ctx) {
 *     return { success: true, output: 'ok', durationMs: 0 };
 *   },
 * });
 */
export function buildTool(def: ToolDef): ITool {
  return {
    definition: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresApproval: def.requiresApproval,
      category: def.category,
      ...(def.executionMode ? { executionMode: def.executionMode } : {}),
    },
    execute: def.execute,
    validateArgs: adaptValidate(def),
    ...(def.backfillObservableInput ? { backfillObservableInput: def.backfillObservableInput } : {}),
  };
}

/**
 * 把 ToolDef.validate（辨识联合）适配为 ITool.validateArgs（{ valid; errors }）。
 * - 未提供 validate 但提供 validateArgs：直接复用
 * - 都未提供：返回永真校验
 * - 同时提供：validate 优先，validateArgs 被忽略并 logger.warn（在 buildTool 调用方责任）
 */
function adaptValidate(def: ToolDef): ITool['validateArgs'] {
  if (def.validate) {
    return (args) => {
      const r = def.validate!(args);
      if (r.result) return { valid: true, errors: [] };
      return { valid: false, errors: [r.message] };
    };
  }
  if (def.validateArgs) return def.validateArgs;
  return () => ({ valid: true, errors: [] });
}

// ============================================================
// 工具注册表
// ============================================================

/** 工具注册表接口 */
export interface IToolRegistry {
  /**
   * 注册工具
   * M1 修复：支持 forceOverwrite 参数控制重复注册行为
   * @param tool 要注册的工具
   * @param forceOverwrite 是否强制覆盖（默认 true；设为 false 时重复注册抛异常）
   */
  register(tool: ITool, forceOverwrite?: boolean): void;

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

// Phase 0c 修复：权限模型已迁移到 src/tools/permission-engine.ts
// 原 IPermissionChecker / PermissionRule / PermissionLevel 已删除
// PermissionEngine 通过 AgentMiddlewarePipeline.onActing 中间件统一拦截
// 详见 src/tools/permission-engine.ts

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
  /** 检查文件路径是否安全
   * @param filePath 文件路径
   * @param context 工具执行上下文
   * @param isWrite 是否为写入操作（影响 Permission Profile 的 read/write 规则判定，默认 false）
   */
  checkFilePath(filePath: string, context: ToolExecutionContext, isWrite?: boolean): SecurityCheckResult;

  /** 检查命令是否安全 */
  checkCommand(command: string, context: ToolExecutionContext): SecurityCheckResult;

  /** 检查网络请求是否安全（C1/C2 修复：async 以支持 DNS 解析防 SSRF） */
  checkNetworkRequest(url: string): Promise<SecurityCheckResult>;
}

// ============================================================
// 工具执行器
// ============================================================

/** 工具执行器接口（负责调度工具执行 + 安全检查） */
export interface IToolExecutor {
  /** 执行工具（带完整检查） */
  execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;

  /** 设置安全检查器 */
  setSecurityChecker(checker: ISecurityChecker): void;
}

// ============================================================
// 内置工具类型（Phase 6 实现）
// ============================================================

/** 文件操作工具参数 */
interface FileToolArgs {
  path: string;
  content?: string;
  encoding?: 'utf-8' | 'base64';
}

/** Shell 执行工具参数 */
interface ShellToolArgs {
  command: string;
  workingDirectory?: string;
  timeoutMs?: number;
}

/** Git 操作工具参数 */
interface GitToolArgs {
  operation: 'status' | 'add' | 'commit' | 'push' | 'pull' | 'diff' | 'log';
  args?: string[];
}

/** 网页抓取工具参数 */
interface WebFetchToolArgs {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/** 代码搜索工具参数 */
interface CodeSearchToolArgs {
  pattern: string;
  path?: string;
  filePattern?: string;
  maxResults?: number;
}
