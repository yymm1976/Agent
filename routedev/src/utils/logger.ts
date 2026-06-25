// src/utils/logger.ts
// Winston 日志模块
// 行为：
//   - 错误日志写入 %APPDATA%/RouteDev/logs/error.log（5MB 滚动，保留 3 个）
//   - 全量日志写入 %APPDATA%/RouteDev/logs/combined.log（10MB 滚动，保留 5 个）
//   - 开发模式（NODE_ENV !== 'production'）额外输出到控制台
// 日志级别通过环境变量 ROUTEDEV_LOG_LEVEL 调整（默认 info）
//
// M4 修复：延迟初始化日志目录，避免 import 时的副作用
// 原实现在模块加载时调用 ensureDir(LOG_DIR)，会在测试或意外导入时创建目录
// 修复：使用 Proxy 懒加载模式，首次调用日志方法时才创建目录和文件 transport

import { createLogger, format, transports } from 'winston';
import type * as winston from 'winston';
import { getAppDataDir, ensureDir } from './paths.js';
import { join } from 'path';

// 原始 logger 实例（不直接导出，仅内部使用）
const _logger = createLogger({
  level: process.env.ROUTEDEV_LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json(),
  ),
  defaultMeta: { service: 'routedev' },
  // M4 修复：创建时不带文件 transport，由 Proxy 懒加载
  transports: [],
});

// 开发模式下也输出到控制台（带颜色）
if (process.env.NODE_ENV !== 'production') {
  _logger.add(
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          // 排除 service 默认 meta（避免噪声）
          const { service: _service, ...rest } = meta;
          const metaStr = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        }),
      ),
    })
  );
}

/**
 * M4 修复：懒初始化文件 transport
 * 首次调用日志方法时才创建日志目录和文件 transport
 */
let fileTransportsAdded = false;
function ensureFileTransports(): void {
  if (fileTransportsAdded) return;
  const logDir = join(getAppDataDir(), 'logs');
  ensureDir(logDir);
  _logger.add(
    // 文件日志：只记录 error 级别（独立文件，方便排错）
    new transports.File({
      filename: join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
    }),
  );
  _logger.add(
    // 文件日志：全量级别
    new transports.File({
      filename: join(logDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
  );
  fileTransportsAdded = true;
}

/**
 * M4 修复：用 Proxy 包装 logger，首次调用日志方法时触发文件 transport 懒加载
 * 这样模块导入不会产生副作用（不创建目录），只有真正写日志时才初始化
 */
const LOG_METHODS = new Set([
  'error', 'warn', 'info', 'verbose', 'debug', 'silly', 'log',
  'emerg', 'alert', 'crit', 'notice',
]);
export const logger = new Proxy(_logger, {
  get(target, prop: string | symbol, receiver: unknown) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof prop === 'string' && LOG_METHODS.has(prop) && typeof value === 'function') {
      // 首次调用日志方法时确保文件 transport 已初始化
      ensureFileTransports();
      return value.bind(target);
    }
    return value;
  },
});

export type { winston };
