// src/tools/security.ts
// 安全检查器：验证工具操作是否安全
// Phase 7：完整实现文件路径、命令黑名单、网络域名检查

import path from 'node:path';
import type { ISecurityChecker, SecurityCheckResult, ToolExecutionContext } from './types.js';
import type { SecurityConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export class SecurityChecker implements ISecurityChecker {
  private allowedDirs: string[];
  private sensitiveFiles: string[];
  private sensitiveFilePolicy: 'readonly' | 'deny';
  private commandBlacklist: string[];
  private commandWhitelist: string[];
  private networkConfirm: boolean;

  constructor(
    workingDirectory: string,
    securityConfig: SecurityConfig,
  ) {
    this.allowedDirs = [path.resolve(workingDirectory)];
    this.sensitiveFiles = securityConfig.sensitiveFiles;
    this.sensitiveFilePolicy = securityConfig.sensitiveFilePolicy;
    this.commandBlacklist = securityConfig.commandBlacklist.map(c => c.toLowerCase());
    this.commandWhitelist = securityConfig.commandWhitelist.map(c => c.toLowerCase());
    this.networkConfirm = securityConfig.networkConfirm;

    logger.debug('SecurityChecker initialized', {
      allowedDirs: this.allowedDirs,
      sensitiveFiles: this.sensitiveFiles,
      commandBlacklist: this.commandBlacklist,
      networkConfirm: this.networkConfirm,
    });
  }

  checkFilePath(filePath: string, _context: ToolExecutionContext): SecurityCheckResult {
    const resolved = path.resolve(filePath);

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
      return {
        allowed: false,
        reason: `文件 "${fileName}" 是敏感文件，只允许读取`,
        requiresConfirmation: false,
      };
    }

    return { allowed: true, requiresConfirmation: false };
  }

  checkCommand(command: string, _context: ToolExecutionContext): SecurityCheckResult {
    const normalized = command.toLowerCase().trim();

    // 白名单优先
    if (this.commandWhitelist.length > 0) {
      const allowed = this.commandWhitelist.some(allowed => normalized.includes(allowed));
      if (!allowed) {
        return {
          allowed: false,
          reason: `命令 "${command}" 不在白名单中`,
          requiresConfirmation: false,
        };
      }
      return { allowed: true, requiresConfirmation: false };
    }

    // 黑名单检查
    const blocked = this.commandBlacklist.some(black => normalized.includes(black));
    if (blocked) {
      return {
        allowed: false,
        reason: `命令 "${command}" 在黑名单中`,
        requiresConfirmation: false,
      };
    }

    return { allowed: true, requiresConfirmation: false };
  }

  checkNetworkRequest(url: string): SecurityCheckResult {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // 基础危险协议检查
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          allowed: false,
          reason: `不支持的协议: ${parsed.protocol}`,
          requiresConfirmation: false,
        };
      }

      // 本地地址保护
      const localPatterns = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
      if (localPatterns.some(p => hostname === p || hostname.endsWith(`.${p}`))) {
        return {
          allowed: false,
          reason: `禁止访问本地地址: ${hostname}`,
          requiresConfirmation: false,
        };
      }

      if (this.networkConfirm) {
        return {
          allowed: true,
          requiresConfirmation: true,
          reason: `网络请求需要确认: ${hostname}`,
        };
      }

      return { allowed: true, requiresConfirmation: false };
    } catch {
      return {
        allowed: false,
        reason: `无效的 URL: ${url}`,
        requiresConfirmation: false,
      };
    }
  }

  addAllowedDir(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    if (!this.allowedDirs.includes(resolved)) {
      this.allowedDirs.push(resolved);
      logger.debug('Added allowed directory', { dir: resolved });
    }
  }
}
