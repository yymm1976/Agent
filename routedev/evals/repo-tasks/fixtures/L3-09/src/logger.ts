// src/logger.ts
// 日志输出
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string): string {
  return `[${level}] ${message}`;
}
