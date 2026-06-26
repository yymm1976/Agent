// src/utils/errors.ts
// Phase 26 Task 7：自定义错误类体系
// 替代字符串模式匹配错误分类，提供结构化的错误类型层次
//
// 设计原则：
//   1. 所有 RouteDev 错误继承 RouteDevError，携带 code 字段
//   2. 每个错误类携带领域特定信息（toolName/rule/field 等）
//   3. 优先用 instanceof 分类错误类型

/**
 * RouteDev 错误基类
 * 所有自定义错误继承此类，携带稳定的 code 字段用于程序化处理
 */
export class RouteDevError extends Error {
  /** 错误代码（稳定标识，不随消息变化） */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    // 维持正确的原型链（ES5 target 兼容）
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 工具执行错误
 * 携带工具名和原始错误信息
 */
export class ToolExecutionError extends RouteDevError {
  readonly toolName: string;

  constructor(toolName: string, message: string, public readonly cause?: unknown) {
    super(`工具 ${toolName} 执行失败: ${message}`, 'TOOL_EXECUTION_ERROR');
    this.toolName = toolName;
  }
}

/**
 * 权限拒绝错误
 * 携带命中的权限规则 ID
 */
export class PermissionDeniedError extends RouteDevError {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(`权限拒绝 [${rule}]: ${message}`, 'PERMISSION_DENIED');
    this.rule = rule;
  }
}

/**
 * 配置验证错误
 * 携带出错的配置字段路径
 */
export class ConfigValidationError extends RouteDevError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`配置验证失败 [${field}]: ${message}`, 'CONFIG_VALIDATION_ERROR');
    this.field = field;
  }
}

/**
 * 安全违规错误
 * 用于路径遍历、命令注入、敏感文件访问等安全检查失败场景
 */
export class SecurityViolationError extends RouteDevError {
  constructor(message: string) {
    super(`安全违规: ${message}`, 'SECURITY_VIOLATION');
  }
}

/**
 * LLM 调用错误（已存在，此处重新导出以集中管理）
 * 保留原 LLMError 的兼容性
 */
export class LLMError extends RouteDevError {
  readonly provider?: string;
  readonly statusCode?: number;

  constructor(message: string, provider?: string, statusCode?: number) {
    super(message, 'LLM_ERROR');
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
