// src/retry-helper.ts
// 重试辅助：fn 最多尝试 attempts 次，全部失败抛最后一次错误
export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  // BUG: 循环边界多一次（i <= attempts）——attempts=3 时实际尝试 4 次，
  // 与"最多尝试 attempts 次"的精确语义不符（常规路径测试看不出，边界测试才暴露）。
  let lastError: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
