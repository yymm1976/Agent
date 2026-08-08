// src/router/llm/k2-transport.ts
// Closure-2：K2 post-finish 吞错范围收紧——只有 transport termination
// （ECONNRESET/EPIPE/socket/iterator transport）才降级为 usageIncomplete；
// 内部程序异常（TypeError、数据转换 invariant 错误等）不得伪装成语义完成。

const TRANSPORT_PATTERNS = [
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'socket hang up',
  'socket closed',
  'socket disconnected',
  'read ECONN',
  'write EPIPE',
  'stream error',
  'network error',
  'connection reset',
  'terminated',
];

/**
 * 是否为 transport termination（K2 可降级为语义完成的错误类别）。
 * 用户取消由调用方 signal 检查单独处理（不在此列）。
 */
export function isTransportTermination(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // SDK/底层 AbortError（内部超时 abort）属 transport 层
  if (err.name === 'AbortError') return true;
  const msg = err.message;
  return TRANSPORT_PATTERNS.some((p) => msg.includes(p));
}
