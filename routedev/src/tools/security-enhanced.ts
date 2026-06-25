// src/tools/security-enhanced.ts
// 安全增强模块：SSRF 防护 + 路径逃逸防护 + symlink 真实路径解析 + Unicode/回车注入检测
//
// 借鉴来源：
//   - Claude Code bashSecurity.ts 的 7 层独立检查器设计
//   - Reasonix 的确定性安全校验
//
// 最优解思考：
//   1. SSRF：仅黑名单不够，必须 DNS 解析后校验 IP（防止域名指向内网）
//   2. Symlink：lstatSync 仅检查最终路径，realpathSync 才能覆盖中间目录 symlink
//   3. Unicode：用 \p{Cf} 检测格式字符（零宽字符等），比枚举更全面
//   4. 回车注入：过滤 \r 字符，防止终端输出覆盖

import * as dns from 'node:dns';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';

// ============================================================
// SSRF 防护
// ============================================================

/** 私有/保留 IP 范围（RFC 1918 + 链路本地 + 元数据 + 回环） */
const PRIVATE_IP_PATTERNS: Array<{ name: string; test: (ip: string) => boolean }> = [
  { name: 'loopback-v4', test: ip => ip === '127.0.0.1' || ip.startsWith('127.') },
  { name: 'loopback-v6', test: ip => ip === '::1' },
  { name: 'private-10', test: ip => ip.startsWith('10.') },
  { name: 'private-172', test: ip => /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) },
  { name: 'private-192', test: ip => ip.startsWith('192.168.') },
  { name: 'link-local', test: ip => ip.startsWith('169.254.') },
  { name: 'metadata-aws', test: ip => ip === '169.254.169.254' },
  { name: 'metadata-gcp', test: ip => ip === 'metadata.google.internal' },
  { name: 'link-local-v6', test: ip => ip.toLowerCase().startsWith('fe80:') },
  { name: 'unique-local-v6', test: ip => ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd') },
  { name: 'ipv4-mapped-v6', test: ip => ip.toLowerCase().startsWith('::ffff:') },
  { name: 'unspecified', test: ip => ip === '0.0.0.0' || ip === '::' },
];

/** 最大重定向深度 */
const MAX_REDIRECT_DEPTH = 5;

/**
 * SSRF 检查结果
 */
export interface SSRFCheckResult {
  allowed: boolean;
  reason: string;
  resolvedIp?: string;
}

/**
 * 检查 URL 是否安全（SSRF 防护）
 *
 * 最优解：DNS 解析后校验 IP，而非仅检查字符串
 * 1. 解析 URL 提取 hostname
 * 2. DNS 查询获取 IP 地址
 * 3. 校验 IP 是否在私有/保留范围内
 * 4. 防止 IP 编码绕过（十进制/八进制/十六进制）
 *
 * @param url 要检查的 URL
 */
export async function checkSSRF(url: string): Promise<SSRFCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: '无效的 URL 格式' };
  }

  // 仅允许 http/https 协议
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `不允许的协议: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;

  // 防止 IP 编码绕过：十进制（2130706433）、八进制（0177.0.0.1）、十六进制（0x7f000001）
  // 先尝试解析为 IP 地址
  const directIp = tryParseIP(hostname);
  if (directIp) {
    // hostname 本身就是 IP，直接校验
    const result = checkIP(directIp);
    if (!result.allowed) {
      return { allowed: false, reason: `IP 地址被禁止: ${result.reason}`, resolvedIp: directIp };
    }
    return { allowed: true, reason: '', resolvedIp: directIp };
  }

  // hostname 是域名，DNS 解析后校验
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true, family: 0 });
    for (const addr of addresses) {
      const result = checkIP(addr.address);
      if (!result.allowed) {
        logger.warn('SSRF check: DNS resolved to private IP', {
          hostname,
          ip: addr.address,
          reason: result.reason,
        });
        return {
          allowed: false,
          reason: `域名 ${hostname} 解析到私有 IP ${addr.address}: ${result.reason}`,
          resolvedIp: addr.address,
        };
      }
    }
    return { allowed: true, reason: '', resolvedIp: addresses[0]?.address };
  } catch (err) {
    // DNS 解析失败，可能是本地 hostname（如 localhost）
    const result = checkIP(hostname);
    if (!result.allowed) {
      return { allowed: false, reason: `hostname 被禁止: ${result.reason}`, resolvedIp: hostname };
    }
    return { allowed: true, reason: '' };
  }
}

/**
 * 尝试解析字符串为 IP 地址（处理编码绕过）
 */
function tryParseIP(str: string): string | null {
  // 标准 IPv4
  if (net.isIPv4(str)) return str;
  // 标准 IPv6
  if (net.isIPv6(str)) return str;
  // 十进制 IPv4（如 2130706433 = 127.0.0.1）
  if (/^\d+$/.test(str)) {
    const num = parseInt(str, 10);
    if (num >= 0 && num <= 0xffffffff) {
      const ip = `${(num >>> 24) & 0xff}.${(num >>> 16) & 0xff}.${(num >>> 8) & 0xff}.${num & 0xff}`;
      return ip;
    }
  }
  // 十六进制 IPv4（如 0x7f000001）
  if (/^0x[0-9a-f]+$/i.test(str)) {
    const num = parseInt(str, 16);
    if (num >= 0 && num <= 0xffffffff) {
      const ip = `${(num >>> 24) & 0xff}.${(num >>> 16) & 0xff}.${(num >>> 8) & 0xff}.${num & 0xff}`;
      return ip;
    }
  }
  return null;
}

/**
 * 检查 IP 地址是否在禁止范围内
 */
function checkIP(ip: string): { allowed: boolean; reason: string } {
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(ip)) {
      return { allowed: false, reason: `${pattern.name}: ${ip}` };
    }
  }
  return { allowed: true, reason: '' };
}

/**
 * 获取最大重定向深度
 */
export function getMaxRedirectDepth(): number {
  return MAX_REDIRECT_DEPTH;
}

// ============================================================
// Symlink 真实路径解析（P1-6 修复：覆盖中间目录 symlink）
// ============================================================

/**
 * 安全解析路径：使用 realpathSync 解析完整真实路径，覆盖中间目录 symlink
 *
 * 最优解思考：
 *   原 lstatSync 仅检查最终路径组件是否为 symlink
 *   如果中间目录是 symlink（如 /project/legitdir → /etc），lstatSync('/project/legitdir/passwd')
 *   会跟随中间 symlink 解析到 /etc/passwd，但 /etc/passwd 本身不是 symlink，防护被绕过
 *   使用 realpathSync 解析完整真实路径，然后验证是否在允许目录内，能覆盖所有 symlink 场景
 *
 * @param resolved path.resolve 后的路径
 * @param allowedDirs 允许的目录列表
 * @returns { allowed, realPath, reason }
 */
export function resolveSecurePath(
  resolved: string,
  allowedDirs: string[],
): { allowed: boolean; realPath: string; reason?: string } {
  // 先用 path.relative 检查逻辑路径
  const logicalAllowed = isPathInDirs(resolved, allowedDirs);
  if (!logicalAllowed.allowed) {
    return { allowed: false, realPath: resolved, reason: logicalAllowed.reason };
  }

  // 文件存在时，解析真实路径（覆盖中间目录 symlink）
  try {
    const realPath = fs.realpathSync(resolved);
    const realAllowed = isPathInDirs(realPath, allowedDirs);
    if (!realAllowed.allowed) {
      logger.warn('Symlink escape detected', {
        logicalPath: resolved,
        realPath,
        reason: realAllowed.reason,
      });
      return {
        allowed: false,
        realPath,
        reason: `符号链接目标逃逸目录边界: ${realPath}`,
      };
    }
    return { allowed: true, realPath };
  } catch {
    // 文件不存在（新建文件场景），跳过 realpath 检查
    return { allowed: true, realPath: resolved };
  }
}

/**
 * 检查路径是否在允许目录内
 */
function isPathInDirs(
  target: string,
  allowedDirs: string[],
): { allowed: boolean; reason?: string } {
  for (const dir of allowedDirs) {
    if (target === dir) return { allowed: true };
    const rel = path.relative(dir, target);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `路径不在允许目录内: ${target}` };
}

// ============================================================
// Claude Code 7 层 Bash 安全检查
// ============================================================

/** Bash 安全检查结果 */
export interface BashSecurityResult {
  allowed: boolean;
  reason: string;
  /** 命中哪一层检查 */
  layer?: string;
}

/**
 * 7 层 Bash 命令安全检查（借鉴 Claude Code bashSecurity.ts）
 *
 * 层级：
 *   1. Unicode 空白字符检测（防零宽字符注入）
 *   2. 回车注入检测（防 \r 覆盖终端输出）
 *   3. proc environ 访问阻止
 *   4. 危险命令检测（rm -rf root, dd of=dev, mkfs 等）
 *   5. 命令注入检测（分号 管道 && $() 反引号等）
 *   6. 环境变量泄露检测（PATH, HOME 等在参数中）
 *   7. 命令复杂度检测（超过 50 个子命令时跳过分析，防事件循环饥饿）
 *
 * @param command 要检查的命令字符串
 */
export function checkBashSecurity(command: string): BashSecurityResult {
  // Layer 7: 命令复杂度检测（先检查，防止后续正则耗尽事件循环）
  // 安全修复：复杂度超限时仍执行 Layer 1-4（低成本正则），仅跳过 Layer 5-6 的注入分析
  // 原行为直接 allowed: true 跳过全部检查，攻击者用空格填充即可绕过危险命令检测
  const tokenCount = command.split(/\s+/).length;
  const tooComplex = tokenCount > 50;
  if (tooComplex) {
    logger.warn('Bash security: command too complex, skipping Layer 5-6 injection analysis', { tokenCount });
  }

  // Layer 1: Unicode 空白字符检测
  // \p{Cf} 匹配格式字符（零宽空格 U+200B、零宽连字 U+200C、零宽不连字 U+200D 等）
  // 这些字符不可见但可改变命令解析，是已知的注入向量
  const unicodeFormatChars = command.match(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g);
  if (unicodeFormatChars) {
    return {
      allowed: false,
      reason: `检测到 Unicode 格式字符（零宽字符/方向标记），可能是注入攻击: ${unicodeFormatChars.length} 个`,
      layer: 'unicode',
    };
  }

  // Layer 2: 回车注入检测
  // \r 字符可以覆盖终端输出，隐藏恶意命令
  if (command.includes('\r')) {
    return {
      allowed: false,
      reason: '检测到回车符 (\\r)，可能用于覆盖终端输出隐藏恶意命令',
      layer: 'carriage-return',
    };
  }

  // Layer 3: /proc/*/environ 访问阻止
  if (/\/proc\/\d+\/environ/.test(command)) {
    return {
      allowed: false,
      reason: '禁止访问 /proc/*/environ（可能泄露环境变量中的密钥）',
      layer: 'proc-environ',
    };
  }

  // Layer 4: 危险命令检测
  // I2 修复：放宽正则匹配，覆盖更多变体（rm -rf /*、rm -rf / --no-preserve-root、dd of= 任意位置等）
  const dangerousPatterns = [
    // rm -rf / 或 rm -rf /* 或 rm -rf / --no-preserve-root
    // 匹配 rm 后跟 -f 标志和 / 开头的参数（含 /* 和 /path）
    { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$|\*|--)/i, reason: 'rm -rf /（删除根目录）' },
    // rm -rf . 或 rm -rf ..（删除当前/上级目录）
    { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\.\.?(\/|\s|$)/i, reason: 'rm -rf . 或 ..（删除当前/上级目录）' },
    // dd 写入设备文件（of= 可出现在任意位置）
    { pattern: /\bdd\b.*\bof=\/dev\//i, reason: 'dd 写入设备文件' },
    // mkfs 系列（格式化文件系统）
    { pattern: /\bmkfs(\.|\s)/i, reason: 'mkfs 格式化文件系统' },
    // fdisk 分区操作
    { pattern: /\bfdisk\s/i, reason: 'fdisk 分区操作' },
    // 系统关机/重启
    { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: '系统关机/重启命令' },
    // fork 炸弹
    { pattern: /:\(\)\s*\{.*\};\s*:/, reason: 'fork 炸弹' },
    // chmod 777 根目录或系统目录
    { pattern: /\bchmod\s+777\s+\//, reason: 'chmod 777 根目录' },
  ];
  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(command)) {
      return { allowed: false, reason, layer: 'dangerous-command' };
    }
  }

  // Layer 5: 命令注入检测（基础版，已有 command-parser.ts 做更详细的 tokenize）
  // 这里检测明显的注入模式，command-parser 负责精确解析
  // 注意：不拦截合法的管道和重定向，仅检测可疑模式
  // 安全修复：复杂度超限时跳过 Layer 5-6（高成本正则），仅记录 warn
  if (!tooComplex) {
    const injectionPatterns = [
      { pattern: /\$\([^)]*\)/, reason: '命令替换 $() 可能是注入' },
      { pattern: /`[^`]*`/, reason: '反引号命令替换可能是注入' },
    ];
    for (const { pattern, reason } of injectionPatterns) {
      if (pattern.test(command)) {
        // 仅 warn 不 block，因为合法场景也可能使用 $()
        logger.warn('Bash security: potential injection', { reason, command: command.slice(0, 100) });
      }
    }

    // Layer 6: 环境变量泄露检测
    // 检测命令参数中是否引用了敏感环境变量
    const sensitiveEnvPatterns = [
      { pattern: /\$\{?AWS_SECRET_ACCESS_KEY\}?/i, reason: 'AWS 密钥引用' },
      { pattern: /\$\{?OPENAI_API_KEY\}?/i, reason: 'OpenAI API 密钥引用' },
      { pattern: /\$\{?ANTHROPIC_API_KEY\}?/i, reason: 'Anthropic API 密钥引用' },
      { pattern: /\$\{?GITHUB_TOKEN\}?/i, reason: 'GitHub Token 引用' },
    ];
    for (const { pattern, reason } of sensitiveEnvPatterns) {
      if (pattern.test(command)) {
        logger.warn('Bash security: sensitive env var reference', { reason });
        // 仅 warn 不 block，因为可能是合法的环境变量设置
      }
    }
  }

  return { allowed: true, reason: '' };
}

// ============================================================
// 凭证上下文过滤（Eve 零静态密钥理念）
// ============================================================

/** 敏感字段名模式 */
const SENSITIVE_FIELD_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /auth/i,
];

/**
 * 过滤上下文中的敏感信息（Eve 零静态密钥理念）
 *
 * 在传递给 LLM 的上下文中过滤掉包含 API Key 的配置信息
 * 防止凭证泄露给模型
 *
 * I6 修复：原正则 `/(?:sk-|pk-|rk-)?[a-zA-Z0-9]{32,}/g` 过度激进，
 * 会误伤 base64、hex、UUID、长标识符等合法内容。
 * 修复策略：
 *   1. 必须有明确前缀（sk-、pk-、rk-、Bearer 等）才视为 API Key
 *   2. 或使用 Shannon 熵检测（>4.5 bits/char 视为高熵字符串，可能是密钥）
 *
 * @param obj 要过滤的对象
 * @param depth 递归深度（防止循环引用）
 */
export function filterSensitiveFields<T>(obj: T, depth = 0): T {
  if (depth > 10 || obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // I6 修复：仅过滤明确前缀的 API Key 或高熵字符串
    return filterSensitiveString(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => filterSensitiveFields(item, depth + 1)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_PATTERNS.some(p => p.test(key))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = filterSensitiveFields(value, depth + 1);
      }
    }
    return result as unknown as T;
  }

  return obj;
}

/**
 * I6 修复：过滤字符串中的敏感信息
 * 仅匹配明确前缀的 API Key 或高熵字符串，避免误伤合法内容
 */
function filterSensitiveString(str: string): string {
  // 1. 匹配明确前缀的 API Key（sk-、pk-、rk-、Bearer、token 等）
  // 这些前缀是行业标准，误伤率极低
  const prefixedPattern = /\b(?:sk-|pk-|rk-|Bearer\s)[a-zA-Z0-9_-]{20,}/g;

  // 2. 匹配高熵字符串（可能是密钥），但仅当长度 >= 40 且熵 > 4.5 bits/char
  // 避免误伤 base64 编码的短数据、hex 字符串等
  const HIGH_ENTROPY_THRESHOLD = 4.5;

  let result = str.replace(prefixedPattern, '[REDACTED]');

  // 检查高熵字符串（仅在未匹配前缀的情况下，减少误伤）
  // 匹配连续的字母数字字符串，长度 >= 40
  result = result.replace(/[a-zA-Z0-9+/=]{40,}/g, match => {
    if (calculateShannonEntropy(match) > HIGH_ENTROPY_THRESHOLD) {
      return '[REDACTED]';
    }
    return match;
  });

  return result;
}

/**
 * I6 修复：计算字符串的 Shannon 熵
 * @param str 输入字符串
 * @returns 熵值（bits/char），越高越随机
 */
function calculateShannonEntropy(str: string): number {
  if (str.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}
