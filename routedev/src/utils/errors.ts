// src/utils/errors.ts
// Phase 26 Task 7：自定义错误类体系
// Phase 51 Task 9：双受众错误模型（借鉴 Flue 的 message + details + dev 三层结构）
//
// 设计原则：
//   1. 所有 RouteDev 错误继承 RouteDevError，携带 code 字段
//   2. 每个错误类携带领域特定信息（toolName/rule/field 等）
//   3. 优先用 instanceof 分类错误类型
//   4. 双受众分层：message（一句话）/ details（caller-safe 详述）/ dev（开发者向）
//      - details 严禁泄露命名空间/文件系统路径/框架内部/源码级修复指令
//      - dev 才放丰富修复指引、路径、堆栈等内部细节
//   5. 向后兼容：旧式 `new XxxError(message, code)` 调用不受影响

/**
 * RouteDev 错误基类
 * 所有自定义错误继承此类，携带稳定的 code 字段用于程序化处理
 *
 * 双受众字段语义：
 *   - message：一句话，用户可见，不含内部细节
 *   - details：较长说明，用户可见，caller-safe（不含路径/内部符号）
 *   - dev：开发者向，仅开发模式渲染（含修复指引、源码位置）
 */
export class RouteDevError extends Error {
  /** 错误代码（稳定标识，不随消息变化） */
  readonly code: string;
  /** 用户可见的额外细节（caller-safe，不含路径/内部符号） */
  readonly details?: string;
  /** 开发者向信息（仅开发模式渲染，可含路径/堆栈/修复指引） */
  readonly dev?: string;

  constructor(
    message: string,
    code: string,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = code;
    this.details = options?.details;
    this.dev = options?.dev;
    // 维持正确的原型链（ES5 target 兼容）
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** 用户友好消息（message + details，不含 dev） */
  toUserMessage(): string {
    return this.details ? `${this.message}\n\n${this.details}` : this.message;
  }

  /** 开发者消息（含 dev 信息） */
  toDevMessage(): string {
    const parts = [this.toUserMessage()];
    if (this.dev) {
      parts.push(`\n[Dev] ${this.dev}`);
    }
    return parts.join('');
  }
}

/**
 * 工具执行错误
 * 携带工具名和原始错误信息
 */
export class ToolExecutionError extends RouteDevError {
  readonly toolName: string;

  constructor(
    toolName: string,
    message: string,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(`工具 ${toolName} 执行失败: ${message}`, 'TOOL_EXECUTION_ERROR', options);
    this.toolName = toolName;
  }
}

/**
 * 权限拒绝错误
 * 携带命中的权限规则 ID
 */
export class PermissionDeniedError extends RouteDevError {
  readonly rule: string;

  constructor(
    rule: string,
    message: string,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(`权限拒绝 [${rule}]: ${message}`, 'PERMISSION_DENIED', options);
    this.rule = rule;
  }
}

/**
 * 配置验证错误
 * 携带出错的配置字段路径
 */
export class ConfigValidationError extends RouteDevError {
  readonly field: string;

  constructor(
    field: string,
    message: string,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(`配置验证失败 [${field}]: ${message}`, 'CONFIG_VALIDATION_ERROR', options);
    this.field = field;
  }
}

/**
 * 安全违规错误
 * 用于路径遍历、命令注入、敏感文件访问等安全检查失败场景
 */
export class SecurityViolationError extends RouteDevError {
  constructor(
    message: string,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(`安全违规: ${message}`, 'SECURITY_VIOLATION', options);
  }
}

/**
 * LLM 调用错误（已存在，此处重新导出以集中管理）
 * 保留原 LLMError 的兼容性
 *
 * 注意：router/llm 层使用的是 src/router/types.ts 中独立的 LLMError 类
 * （构造器签名 message/statusCode/model/cause，承载 type 推断等领域逻辑）；
 * 本类是 RouteDevError 体系内的 LLM 错误，用于统一的错误显示与分类。
 * 两者通过 instanceof 各自区分，互不冲突。
 */
export class LLMError extends RouteDevError {
  readonly provider?: string;
  readonly statusCode?: number;

  constructor(
    message: string,
    provider?: string,
    statusCode?: number,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(message, 'LLM_ERROR', options);
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

/**
 * 类型守卫：判断错误是否为 RouteDevError 体系
 */
export function isRouteDevError(err: unknown): err is RouteDevError {
  return err instanceof RouteDevError;
}

// ============================================================
// 双受众错误格式化工具函数（Phase 51 Task 9）
// ============================================================

/**
 * 将任意错误格式化为用户可见消息
 * - RouteDevError：调用 toUserMessage()（message + details，不含 dev）
 * - 普通 Error：返回 message
 * - 其他：String(err)
 *
 * 安全保证：永远不会返回 dev 字段内容，可在 UI 直接渲染
 */
export function formatErrorForUser(err: unknown): string {
  if (err instanceof RouteDevError) {
    return err.toUserMessage();
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * 将任意错误格式化为开发者可见消息
 * - RouteDevError：调用 toDevMessage()（含 dev 信息）
 * - 普通 Error：message + 堆栈（若有）
 * - 其他：String(err)
 *
 * 注意：返回内容可能包含路径、堆栈等内部细节，仅在开发模式渲染
 */
export function formatErrorForDev(err: unknown): string {
  if (err instanceof RouteDevError) {
    return err.toDevMessage();
  }
  if (err instanceof Error) {
    return err.stack ? `${err.message}\n${err.stack}` : err.message;
  }
  return String(err);
}
