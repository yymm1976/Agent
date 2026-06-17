// src/tools/security.ts
// 安全检查器：验证工具操作是否安全
// Phase 6：实现文件路径检查（目录边界 + 敏感文件）
// Phase 7：添加命令检查和网络请求检查

import path from 'node:path';
import type { ISecurityChecker, SecurityCheckResult, ToolExecutionContext } from './types.js';
import type { SecurityConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export class SecurityChecker implements ISecurityChecker {
  private allowedDirs: string[];
  private sensitiveFiles: string[];
  private sensitiveFilePolicy: 'readonly' | 'deny';

  constructor(
    workingDirectory: string,
    securityConfig: SecurityConfig,
  ) {
    this.allowedDirs = [path.resolve(workingDirectory)];
    this.sensitiveFiles = securityConfig.sensitiveFiles;
    this.sensitiveFilePolicy = securityConfig.sensitiveFilePolicy;

    logger.debug('SecurityChecker initialized', {
      allowedDirs: this.allowedDirs,
      sensitiveFiles: this.sensitiveFiles,
      policy: this.sensitiveFilePolicy,
    });
  }

  /** 检查文件路径是否在允许范围内 */
  checkFilePath(filePath: string, _context: ToolExecutionContext): SecurityCheckResult {
    const resolved = path.resolve(filePath);

    // 检查是否在允许的目录内
    const inAllowedDir = this.allowedDirs.some(dir =>
      resolved.startsWith(dir + path.sep) || resolved === dir,
    );

    if (!inAllowedDir) {
      return {
        allowed: false,
        reason: `路径 "${filePath}" 不在项目目录范围内`,
        requiresConfirmation: false,
      };
    }

    // 检查是否为敏感文件
    const fileName = path.basename(resolved);
    const isSensitive = this.sensitiveFiles.some(pattern => {
      if (pattern.startsWith('*.')) {
        return fileName.endsWith(pattern.slice(1));
      }
      return fileName === pattern || resolved.endsWith(pattern);
    });

    if (isSensitive) {
      if (this.sensitiveFilePolicy === 'deny') {
        return {
          allowed: false,
          reason: `文件 "${fileName}" 是敏感文件，禁止访问`,
          requiresConfirmation: false,
        };
      }
      // readonly 策略：读取允许，写入拒绝
      if (this.isWriteOperation(resolved)) {
        return {
          allowed: false,
          reason: `文件 "${fileName}" 是敏感文件，只允许读取`,
          requiresConfirmation: false,
        };
      }
    }

    return { allowed: true, requiresConfirmation: false };
  }

  /** 检查 Shell 命令（Phase 7 实现） */
  checkCommand(command: string, _context: ToolExecutionContext): SecurityCheckResult {
    // Phase 6 暂不检查命令，Phase 7 添加命令黑名单
    return { allowed: true, requiresConfirmation: false };
  }

  /** 检查网络请求（Phase 7 实现） */
  checkNetworkRequest(url: string): SecurityCheckResult {
    // Phase 6 暂不检查网络请求，Phase 7 添加域名白/黑名单
    return { allowed: true, requiresConfirmation: false };
  }

  /** 添加允许目录 */
  addAllowedDir(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    if (!this.allowedDirs.includes(resolved)) {
      this.allowedDirs.push(resolved);
      logger.debug('Added allowed directory', { dir: resolved });
    }
  }

  /** 判断是否为写操作（通过文件名判断不可行，Phase 7 在调用处传 operation） */
  private isWriteOperation(filePath: string): boolean {
    // 简单启发式：敏感文件默认禁止写入
    return true;
  }
}
