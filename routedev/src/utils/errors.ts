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
 * 统一错误消息提取（TD-22）
 *
 * 替代散布全库的 `error instanceof Error ? error.message : String(error)` 模式。
 * 安全处理任意 thrown 值（Error 对象 / 字符串 / 普通对象 / null / undefined）。
 *
 * @param error 任意 thrown 值
 * @returns 字符串形式的错误消息
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error === null || error === undefined) {
    return String(error);
  }
  // 普通对象：尝试 message 属性，否则 JSON 序列化
  if (typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
