// src/utils/logger.ts
// Winston 日志模块
// 行为：
//   - 错误日志写入 %APPDATA%/RouteDev/logs/error.log（5MB 滚动，保留 3 个）
//   - 全量日志写入 %APPDATA%/RouteDev/logs/combined.log（10MB 滚动，保留 5 个）
//   - 开发模式（NODE_ENV !== 'production'）额外输出到控制台
// 日志级别通过环境变量 ROUTEDEV_LOG_LEVEL 调整（默认 info）

import { createLogger, format, transports } from 'winston';
import { getAppDataDir, ensureDir } from './paths.js';
import { join } from 'path';

const LOG_DIR = join(getAppDataDir(), 'logs');
ensureDir(LOG_DIR);

export const logger = createLogger({
  level: process.env.ROUTEDEV_LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json(),
  ),
  defaultMeta: { service: 'routedev' },
  transports: [
    // 文件日志：只记录 error 级别（独立文件，方便排错）
    new transports.File({
      filename: join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
    }),
    // 文件日志：全量级别
    new transports.File({
      filename: join(LOG_DIR, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
  ],
});

// 开发模式下也输出到控制台（带颜色）
if (process.env.NODE_ENV !== 'production') {
  logger.add(
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
