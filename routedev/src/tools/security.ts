// src/tools/security.ts
// 安全检查器：验证工具操作是否安全
// Phase 7：完整实现文件路径、命令黑名单、网络域名检查
// Phase 29 Task 3：命令检查从子串匹配升级为 tokenize 解析（修复 S2/S3）

import path from 'node:path';
import type { ISecurityChecker, SecurityCheckResult, ToolExecutionContext } from './types.js';
import type { SecurityConfig } from '../config/schema.js';
import { parseCommand } from './command-parser.js';
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

    // 使用 path.relative 替代 startsWith，防止前缀匹配绕过
    // 例如 allowedDir=/project，/project-secret/file 不应通过
    const inAllowedDir = this.allowedDirs.some(dir => {
      if (resolved === dir) return true;
      const rel = path.relative(dir, resolved);
      // 相对路径不以 .. 开头且不是绝对路径，说明 resolved 在 dir 内
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });

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
    // Phase 29 Task 3：使用 tokenize 解析替代子串匹配（修复 S2/S3）
    // 子串匹配的问题：includes('rm') 会误拦 "python program.py"（含 "rm"），
    // 同时无法拦截 "rm" 在引号内或大写变体
    const parsed = parseCommand(command);
    const commandName = parsed.command.toLowerCase();

    // 白名单检查：匹配命令名（首 token），不再子串匹配
    if (this.commandWhitelist.length > 0) {
      const allowed = this.commandWhitelist.some(wl => commandName === wl);
      if (!allowed) {
        return {
          allowed: false,
          reason: `命令 "${parsed.command}" 不在白名单中`,
          requiresConfirmation: false,
        };
      }
    }

    // 黑名单检查：支持单 token（如 "rm"）和多 token（如 "rm -rf"）条目
    // 单 token：匹配命令名（首 token）
    // 多 token：匹配命令名 + 条目 args 是命令 args 的前缀
    const blocked = this.commandBlacklist.some(bl => {
      const blParsed = parseCommand(bl);
      // 命令名不匹配，直接跳过
      if (commandName !== blParsed.command.toLowerCase()) return false;
      // 单 token 条目（仅命令名），匹配
      if (blParsed.args.length === 0) return true;
      // 多 token 条目：检查条目 args 是命令 args 的前缀
      if (blParsed.args.length > parsed.args.length) return false;
      return blParsed.args.every((arg, i) => parsed.args[i] === arg);
    });
    if (blocked) {
      return {
        allowed: false,
        reason: `命令 "${parsed.command}" 在黑名单中`,
        requiresConfirmation: false,
      };
    }

    // 危险模式标记（不阻断，但标记为需确认）
    // 管道和命令替换可能绕过白名单/黑名单检查
    if (parsed.hasSubstitution || parsed.hasPipe) {
      return {
        allowed: true,
        requiresConfirmation: true,
        reason: '命令含管道或命令替换，需确认',
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
