// desktop/main/ipc-guard.ts
// TD-08：IPC 参数校验工具，统一校验模式
//
// 设计目标：为所有 ipcMain.handle / ipcMain.on 的 handler 提供统一的参数校验入口，
// 替代各 handler 内散落的 typeof / length 检查，降低校验逻辑不一致导致的安全风险。
//
// 用法示例：
//   const validate = ipcGuard.object<{ text: string }>({
//     text: ipcGuard.string(10000),
//   });
//   try {
//     const payload = validate(rawPayload);
//   } catch (err) {
//     return { success: false, error: err instanceof Error ? err.message : '无效的参数' };
//   }
//
// 注意：object 校验器采用 passthrough 策略——保留原对象中未在校验 shape 中声明的字段，
// 仅对声明字段做类型/长度校验。这样既保证关键字段被校验，又避免对复杂配置对象
// （如 AppConfig）需要枚举全部字段的负担。消费方应只读取已校验字段以避免读到未校验数据。

import type { IpcMainInvokeEvent } from 'electron';

/** 单字段校验器：接收 unknown，返回校验后的值（类型由实现决定），校验失败抛 Error */
export type FieldValidator<T> = (value: unknown) => T;

export const ipcGuard = {
  /**
   * 字符串校验器工厂
   * @param maxLen 最大允许长度（字符数）
   * @returns 校验器：非字符串抛错；超长抛错；否则原样返回
   */
  string(maxLen: number): FieldValidator<string> {
    return (value: unknown): string => {
      if (typeof value !== 'string') throw new Error('参数必须是字符串');
      if (value.length > maxLen) throw new Error(`字符串长度不能超过 ${maxLen}`);
      return value;
    };
  },

  /**
   * 对象校验器工厂（passthrough 策略 + partial shape）
   * @param shape 各字段的校验器映射；仅对声明字段做校验，未声明字段原样保留
   * @returns 校验器：非对象/null 抛错；逐字段调用 shape 中的校验器；返回包含所有原字段的对象
   *
   * passthrough 说明：result 先展开原对象所有字段，再用校验器结果覆盖已校验字段。
   * 这样 config:save / profile:save 等接收复杂配置的 handler 无需枚举全部字段，
   * 只需校验关键标识字段（id/name/role 等），其余字段（systemPrompt 等）原样透传。
   *
   * partial 说明：shape 类型为 Partial，允许只传入部分字段的校验器。
   * 这对于字段众多的复杂类型（如 ProfileSavePayload 有 18+ 字段）是必要的，
   * 调用方只需校验安全关键字段，其余字段由 passthrough 保留。
   */
  object<T extends object>(
    shape: Partial<{ [K in keyof T]: FieldValidator<T[K]> }>,
  ): FieldValidator<T> {
    return (value: unknown): T => {
      if (typeof value !== 'object' || value === null) throw new Error('参数必须是对象');
      const source = value as Record<string, unknown>;
      // passthrough：先复制原对象所有字段
      const result: Record<string, unknown> = { ...source };
      // 再用校验器结果覆盖已校验字段（校验失败时抛错，整个 object 校验失败）
      const validators = shape as Record<string, FieldValidator<unknown> | undefined>;
      for (const key in validators) {
        if (Object.prototype.hasOwnProperty.call(validators, key)) {
          const validator = validators[key];
          if (validator) {
            result[key] = validator(source[key]);
          }
        }
      }
      return result as T;
    };
  },

  /**
   * 可选值校验器工厂
   * @param validator 内层校验器
   * @returns 校验器：undefined/null 返回 undefined；否则调用内层校验器
   */
  optional<T>(validator: FieldValidator<T>): FieldValidator<T | undefined> {
    return (value: unknown): T | undefined => {
      if (value === undefined || value === null) return undefined;
      return validator(value);
    };
  },
};

/**
 * 创建带参数校验的 IPC handler（Phase 79 Task 7）
 *
 * 统一各 handler 的参数校验逻辑，替代散落在各 ipcMain.handle 中的 typeof / length 检查。
 * 校验函数返回 null 表示通过，返回字符串表示错误消息（此时 handler 不执行，直接抛错）。
 *
 * 与权限层兼容：权限校验应在 handler 内部或其包装层执行，确保在参数校验之后运行。
 * 即 createValidatedHandler 是外层（参数校验），权限校验是内层，二者解耦。
 *
 * @param channel IPC 通道名（仅用于错误信息定位，不绑定具体通道）
 * @param validator 参数校验函数（返回 null 表示通过，返回字符串表示错误消息）
 * @param handler 实际处理函数（校验通过后调用，可通过 ...rest 接收 event 等额外参数）
 * @returns 可直接传给 ipcMain.handle 的包装函数
 */
export function createValidatedHandler<TArgs, TResult>(
  channel: string,
  validator: (args: unknown) => string | null,
  handler: (args: TArgs, ...rest: unknown[]) => Promise<TResult>,
): (event: IpcMainInvokeEvent, args: unknown) => Promise<TResult> {
  return async (event, args) => {
    // 参数校验：返回错误消息时直接抛错，handler 不执行
    const validationError = validator(args);
    if (validationError !== null) {
      // 错误信息包含通道名和校验失败原因，便于定位
      throw new Error(`[IPC ${channel}] 参数校验失败: ${validationError}`);
    }
    // 校验通过后调用 handler（权限校验由 handler 内部负责，在参数校验之后执行）
    return handler(args as TArgs, event);
  };
}
