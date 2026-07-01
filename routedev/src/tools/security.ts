// src/tools/security.ts
// 安全检查器：验证工具操作是否安全
// Phase 7：完整实现文件路径、命令黑名单、网络域名检查
// Phase 29 Task 3：命令检查从子串匹配升级为 tokenize 解析（修复 S2/S3）
// P1-8：增加 symlink 防护，防止通过符号链接逃逸目录边界
// 安全增强：集成 security-enhanced.ts（realpathSync + 7层Bash安全 + SSRF防护）

import path from 'node:path';
import type { ISecurityChecker, SecurityCheckResult, ToolExecutionContext } from './types.js';
import type { SecurityConfig, PermissionProfile } from '../config/schema.js';
import { parseCommand } from './command-parser.js';
import { logger } from '../utils/logger.js';
import { resolveSecurePath, checkBashSecurity, checkSSRF } from './security-enhanced.js';

// ============================================================
// glob 匹配工具（轻量实现，不引入 minimatch 依赖）
// 支持：* 单层通配、** 跨层通配、? 单字符、字面量
// ============================================================

/**
 * 将 glob 模式转换为正则表达式
 * 支持 *（单层）、**（跨层）、?（单字符）
 *
 * @param pattern glob 模式（如跨层匹配 .env 文件等）
 * @returns RegExp
 */
function globToRegExp(pattern: string): RegExp {
  // 转义正则特殊字符（除 * 和 ? 外）
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      // ** 跨目录通配（匹配任意层级，包括路径分隔符）
      if (pattern[i + 1] === '*') {
        regex += '.*';
        i += 2;
        // 跳过紧跟的路径分隔符（**/ 中的 /）
        if (pattern[i] === '/' || pattern[i] === '\\') {
          i++;
        }
      } else {
        // * 单层通配（不匹配路径分隔符）
        regex += '[^/\\\\]*';
        i++;
      }
    } else if (ch === '?') {
      regex += '[^/\\\\]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp('^' + regex + '$', 'i');
}

/**
 * 检查文件路径是否匹配 glob 模式
 * 同时支持正斜杠和反斜杠路径分隔符（跨平台）
 *
 * @param filePath 文件路径
 * @param pattern glob 模式
 * @returns 是否匹配
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  // 统一路径分隔符为正斜杠，便于匹配
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  try {
    const regex = globToRegExp(normalizedPattern);
    return regex.test(normalizedPath);
  } catch {
    // 正则编译失败时降级为简单后缀匹配
    if (pattern.startsWith('*.')) {
      return filePath.endsWith(pattern.slice(1));
    }
    return filePath === pattern;
  }
}

/**
 * 检查域名是否匹配通配符模式
 * 支持 *.github.com 这类前缀通配
 *
 * @param hostname 待检查的域名
 * @param pattern 域名通配符模式
 * @returns 是否匹配
 */
export function matchDomain(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    // *.github.com 匹配 api.github.com、github.com（前缀通配）
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return h === p;
}

export class SecurityChecker implements ISecurityChecker {
  private allowedDirs: string[];
  private sensitiveFiles: string[];
  private sensitiveFilePolicy: 'readonly' | 'deny';
  private commandBlacklist: string[];
  private commandWhitelist: string[];
  private networkConfirm: boolean;
  /** 权限规则（Permission Profile） */
  private permissionProfile: PermissionProfile;
  /** 保留原始安全配置引用，用于读取 ssrfProtection/strictBashMode/httpsOnly/rateLimitMaxSize */
  private securityConfig: SecurityConfig;
  /** I5：速率限制 Map（LRU 策略，上限由 rateLimitMaxSize 控制） */
  private rateLimitMap = new Map<string, { count: number; windowStart: number }>();
  /** 速率限制窗口大小（毫秒） */
  private static readonly RATE_LIMIT_WINDOW_MS = 60_000;
  /** 速率限制窗口内最大请求数 */
  private static readonly RATE_LIMIT_MAX_REQUESTS = 100;

  constructor(
    workingDirectory: string,
    securityConfig: SecurityConfig,
    permissionProfile?: PermissionProfile,
  ) {
    this.allowedDirs = [path.resolve(workingDirectory)];
    this.sensitiveFiles = securityConfig.sensitiveFiles;
    this.sensitiveFilePolicy = securityConfig.sensitiveFilePolicy;
    this.commandBlacklist = securityConfig.commandBlacklist.map(c => c.toLowerCase());
    this.commandWhitelist = securityConfig.commandWhitelist.map(c => c.toLowerCase());
    this.networkConfirm = securityConfig.networkConfirm;
    this.securityConfig = securityConfig;
    // 默认权限规则：空 Profile（不限制）
    this.permissionProfile = permissionProfile ?? {
      name: 'default',
      filesystem: [],
      network: { allow: [], deny: [] },
    };

    logger.debug('SecurityChecker initialized', {
      allowedDirs: this.allowedDirs,
      sensitiveFiles: this.sensitiveFiles,
      commandBlacklist: this.commandBlacklist,
      networkConfirm: this.networkConfirm,
      permissionProfileName: this.permissionProfile.name,
      filesystemRules: this.permissionProfile.filesystem.length,
    });
  }

  /**
   * 设置权限规则（运行时切换 Profile 时使用）
   */
  setPermissionProfile(profile: PermissionProfile): void {
    this.permissionProfile = profile;
    logger.debug('PermissionProfile updated', {
      name: profile.name,
      filesystemRules: profile.filesystem.length,
    });
  }

  /**
   * 检查文件路径是否被权限规则允许
   * 按规则顺序匹配，命中第一条即生效；未命中则返回 allowed
   *
   * @param filePath 文件路径（绝对路径或相对工作目录的路径）
   * @param isWrite 是否为写入操作（影响 read/write 规则判定）
   * @returns 安全检查结果
   */
  checkPermissionProfile(filePath: string, isWrite: boolean): SecurityCheckResult {
    for (const rule of this.permissionProfile.filesystem) {
      if (matchGlob(filePath, rule.pattern)) {
        switch (rule.access) {
          case 'deny':
            return {
              allowed: false,
              reason: `权限规则禁止访问该文件（pattern: ${rule.pattern}）`,
              requiresConfirmation: false,
            };
          case 'read':
            // 只读规则：写入操作被拒绝，读取允许但需确认
            if (isWrite) {
              return {
                allowed: false,
                reason: `权限规则将该文件设为只读，禁止写入（pattern: ${rule.pattern}）`,
                requiresConfirmation: false,
              };
            }
            return {
              allowed: true,
              reason: `权限规则将该文件设为只读（pattern: ${rule.pattern}）`,
              requiresConfirmation: true,
            };
          case 'write':
            // 可读写规则：直接放行
            return { allowed: true, requiresConfirmation: false };
        }
      }
    }
    // 未命中任何规则：默认允许
    return { allowed: true, requiresConfirmation: false };
  }

  /**
   * 检查网络请求是否被权限规则允许
   * 黑名单优先于白名单
   *
   * @param url 待检查的 URL
   * @returns 安全检查结果
   */
  checkNetworkPermissionProfile(url: string): SecurityCheckResult {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const { allow, deny } = this.permissionProfile.network;

      // 黑名单优先：命中即拒绝
      for (const pattern of deny) {
        if (matchDomain(hostname, pattern)) {
          return {
            allowed: false,
            reason: `权限规则禁止访问域名 ${hostname}（pattern: ${pattern}）`,
            requiresConfirmation: false,
          };
        }
      }

      // 白名单非空时：必须命中白名单才允许
      if (allow.length > 0) {
        const allowed = allow.some(pattern => matchDomain(hostname, pattern));
        if (!allowed) {
          return {
            allowed: false,
            reason: `域名 ${hostname} 不在权限规则白名单中`,
            requiresConfirmation: false,
          };
        }
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

  checkFilePath(filePath: string, context: ToolExecutionContext, isWrite: boolean = false): SecurityCheckResult {
    // C2 修复：基于 context.workingDirectory 解析路径，与文件工具的解析基准保持一致
    // 原 path.resolve(filePath) 以 process.cwd() 为基准，与实际操作路径基准不一致
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(context?.workingDirectory ?? process.cwd(), filePath);

    // P1-8 + 安全增强：使用 resolveSecurePath 替代原 lstatSync
    // resolveSecurePath 使用 realpathSync 解析完整真实路径
    // 覆盖中间目录 symlink 场景（原 lstatSync 仅检查最终路径组件，可被中间 symlink 绕过）
    const secureResult = resolveSecurePath(resolved, this.allowedDirs);
    if (!secureResult.allowed) {
      return {
        allowed: false,
        reason: secureResult.reason ?? `路径 "${filePath}" 不在项目目录范围内`,
        requiresConfirmation: false,
      };
    }

    // Permission Profile 检查（glob 级权限规则，优先于 sensitiveFiles 检查）
    // 命中 deny 规则直接拒绝；命中 read 规则时写入操作被拒绝、读取需确认
    const profileResult = this.checkPermissionProfile(resolved, isWrite);
    if (!profileResult.allowed) {
      return profileResult;
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
      // I16 修复：readonly 策略应允许访问但标记需确认，而非与 deny 行为相同
      return {
        allowed: true,
        reason: `文件 "${fileName}" 是敏感文件，需确认`,
        requiresConfirmation: true,
      };
    }

    // Permission Profile 命中 read 规则但未被前面拦截时（读取场景），透传 requiresConfirmation
    if (profileResult.requiresConfirmation) {
      return profileResult;
    }

    return { allowed: true, requiresConfirmation: false };
  }

  /** 检查路径是否在允许目录内（保留公共方法供测试使用） */
  private isPathAllowed(resolved: string): boolean {
    return this.allowedDirs.some(dir => {
      if (resolved === dir) return true;
      const rel = path.relative(dir, resolved);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  checkCommand(command: string, _context: ToolExecutionContext): SecurityCheckResult {
    // 安全增强：先执行 7 层 Bash 安全检查（Unicode/回车注入/proc/危险命令等）
    const bashResult = checkBashSecurity(command);
    if (!bashResult.allowed) {
      return {
        allowed: false,
        reason: bashResult.reason,
        requiresConfirmation: false,
      };
    }

    // I2 修复：Bash 注入检测阻断
    // checkBashSecurity 的 Layer 5 仅 warn 不 block，这里根据 strictBashMode 决定是否阻断
    const strictBashMode = this.securityConfig.strictBashMode ?? false;
    if (strictBashMode) {
      const injectionDetected = this.detectBashInjection(command);
      if (injectionDetected) {
        return {
          allowed: false,
          reason: '检测到 Bash 命令注入模式（strictBashMode 已启用，已阻断）',
          requiresConfirmation: false,
        };
      }
    }

    // Phase 29 Task 3：使用 tokenize 解析替代子串匹配（修复 S2/S3）
    // 子串匹配的问题：includes('rm') 会误拦 "python program.py"（含 "rm"），
    // 同时无法拦截 "rm" 在引号内或大写变体
    const parsed = parseCommand(command);
    const commandsToCheck = parsed.subCommands && parsed.subCommands.length > 0 ? parsed.subCommands : [parsed];
    const commandName = parsed.command.toLowerCase();

    // 白名单检查：匹配命令名（首 token），不再子串匹配
    if (this.commandWhitelist.length > 0) {
      const allowed = commandsToCheck.every(cmd => this.commandWhitelist.some(wl => cmd.command.toLowerCase() === wl));
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
    const blocked = commandsToCheck.some(cmd => this.commandBlacklist.some(bl => {
      const blParsed = parseCommand(bl);
      // 命令名不匹配，直接跳过
      if (cmd.command.toLowerCase() !== blParsed.command.toLowerCase()) return false;
      // 单 token 条目（仅命令名），匹配
      if (blParsed.args.length === 0) return true;
      // 多 token 条目：检查条目 args 是命令 args 的前缀
      if (blParsed.args.length > cmd.args.length) return false;
      return blParsed.args.every((arg, i) => cmd.args[i] === arg);
    }));
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

  /**
   * I2 修复：检测 Bash 命令注入模式
   * 检测 $() 命令替换、反引号命令替换、分号链式等注入向量
   * @param command 待检查的命令
   * @returns 是否检测到注入模式
   */
  private detectBashInjection(command: string): boolean {
    // 命令替换 $()
    if (/\$\([^)]*\)/.test(command)) {
      logger.warn('Bash injection detected: command substitution $()', { command: command.slice(0, 100) });
      return true;
    }
    // 反引号命令替换
    if (/`[^`]*`/.test(command)) {
      logger.warn('Bash injection detected: backtick substitution', { command: command.slice(0, 100) });
      return true;
    }
    return false;
  }

  async checkNetworkRequest(url: string): Promise<SecurityCheckResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        allowed: false,
        reason: `无效的 URL: ${url}`,
        requiresConfirmation: false,
      };
    }

    const hostname = parsed.hostname.toLowerCase();

    // 基础危险协议检查
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        allowed: false,
        reason: `不支持的协议: ${parsed.protocol}`,
        requiresConfirmation: false,
      };
    }

    // I3 修复：强制 HTTPS，拒绝 HTTP 请求（除非是 localhost）
    const httpsOnly = this.securityConfig.httpsOnly ?? true;
    if (httpsOnly && parsed.protocol === 'http:' && !this.isLocalhostHost(hostname)) {
      return {
        allowed: false,
        reason: `仅允许 HTTPS 请求（httpsOnly 已启用）: ${url}`,
        requiresConfirmation: false,
      };
    }

    // C1 修复：SSRF 防护——DNS 解析后检查实际 IP，防止 DNS 重绑定绕过
    // 覆盖：127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
    //        169.254.0.0/16, 0.0.0.0/8, ::1, fc00::/7, fe80::/10
    const ssrfEnabled = this.securityConfig.ssrfProtection ?? true;
    if (ssrfEnabled) {
      const ssrfResult = await checkSSRF(url);
      if (!ssrfResult.allowed) {
        return {
          allowed: false,
          reason: `SSRF 防护拦截: ${ssrfResult.reason}`,
          requiresConfirmation: false,
        };
      }
    }

    // I5 修复：速率限制 Map LRU 淘汰，防止 Map 无界增长导致内存泄漏
    this.trackRateLimit(hostname);

    // Permission Profile 网络规则检查（glob 级域名白名单/黑名单）
    // 黑名单优先于白名单；白名单非空时必须命中才允许
    const profileNetResult = this.checkNetworkPermissionProfile(url);
    if (!profileNetResult.allowed) {
      return profileNetResult;
    }

    if (this.networkConfirm) {
      return {
        allowed: true,
        requiresConfirmation: true,
        reason: `网络请求需要确认: ${hostname}`,
      };
    }

    return { allowed: true, requiresConfirmation: false };
  }

  /**
   * 判断 hostname 是否为 localhost（用于 I3 HTTPS 豁免）
   */
  private isLocalhostHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
  }

  /**
   * I5 修复：跟踪网络请求速率（LRU Map）
   * Map 大小上限由 config.security.rateLimitMaxSize 控制（默认 10000）
   * 超过上限时删除最旧条目（LRU 淘汰）
   */
  private trackRateLimit(hostname: string): void {
    const maxSize = this.securityConfig.rateLimitMaxSize ?? 10000;
    const now = Date.now();
    const windowMs = SecurityChecker.RATE_LIMIT_WINDOW_MS;
    const maxRequests = SecurityChecker.RATE_LIMIT_MAX_REQUESTS;

    // LRU：先删除再重新插入，使该 key 移到 Map 末尾（最近使用）
    const existing = this.rateLimitMap.get(hostname);
    if (existing) {
      this.rateLimitMap.delete(hostname);
      // 检查窗口是否过期
      if (now - existing.windowStart > windowMs) {
        // 窗口过期，重置计数
        this.rateLimitMap.set(hostname, { count: 1, windowStart: now });
      } else {
        existing.count++;
        this.rateLimitMap.set(hostname, existing);
        if (existing.count > maxRequests) {
          logger.warn('Rate limit exceeded for hostname', { hostname, count: existing.count });
        }
      }
    } else {
      // 新条目：先检查 Map 大小，超过上限时删除最旧条目（Map 迭代顺序 = 插入顺序）
      while (this.rateLimitMap.size >= maxSize) {
        const oldestKey = this.rateLimitMap.keys().next().value;
        if (oldestKey === undefined) break;
        this.rateLimitMap.delete(oldestKey);
      }
      this.rateLimitMap.set(hostname, { count: 1, windowStart: now });
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
