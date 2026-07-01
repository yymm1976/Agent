// src/tools/mcp/security-scanner.ts
// MCP 工具安全扫描器（Phase 53 Task 5）
//
// 实现 4 类威胁检测（全部确定性正则/距离算法，无 LLM）：
//   1. 工具投毒（poisoning）：描述中包含注入指令（<system>、ignore previous 等）
//   2. 名称仿冒（impersonation）：与已知工具名 Levenshtein 距离 ≤ 2
//   3. 隐藏指令（hidden_instruction）：零宽 Unicode 字符
//   4. 地毯式替换（carpet_bombing）：描述 >500 字符 + 2+ 注入模式匹配
//
// 设计原则：
//   - 无 config 开关也能独立运行（config 守护在 app-init.ts）
//   - 所有配置通过 constructor opts 注入，不 import 共享配置
//   - 不引入外部依赖（Levenshtein 自实现）

// ============================================================
// 类型定义
// ============================================================

/** MCP 安全威胁类型 */
export type McpThreatType =
  | 'poisoning'
  | 'impersonation'
  | 'hidden_instruction'
  | 'carpet_bombing';

/** 严重度等级（升序：low < medium < high < critical） */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** 安全扫描发现 */
export interface McpSecurityFinding {
  /** 工具名（来自 McpToolDefinition.name） */
  toolName: string;
  /** 威胁类型 */
  threatType: McpThreatType;
  /** 严重度 */
  severity: Severity;
  /** 威胁描述（中文） */
  description: string;
  /** 证据片段（匹配到的字符串或上下文） */
  evidence: string;
}

/** 待扫描的 MCP 工具定义 */
export interface McpToolDefinition {
  /** 工具名 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 输入 schema（可选） */
  inputSchema?: Record<string, unknown>;
}

/** 扫描器构造配置 */
export interface McpSecurityScannerOptions {
  /** 已知合法工具名列表（用于仿冒检测） */
  knownToolNames?: string[];
  /** 阻断阈值：severity >= 此值时阻断注册（默认 'high'） */
  blockThreshold?: Severity;
}

// ============================================================
// 默认配置
// ============================================================

/**
 * 默认注入指令模式（大小写不敏感）
 *
 * 这些模式表示工具描述中不应出现的指令性语言，
 * 用于检测 prompt injection 攻击。
 */
const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /<system>/i,
  /ignore previous/i,
  /ignore all/i,
  /disregard/i,
  /you are now/i,
  /new instructions/i,
];

/**
 * 默认隐藏 Unicode 字符范围
 *
 * 零宽字符可用于在视觉上隐藏恶意指令。
 */
const DEFAULT_HIDDEN_UNICODE_RANGES: RegExp[] = [
  /[\u200B-\u200D]/, // 零宽空格、零宽连字符、零宽非连字符
  /[\uFEFF]/,        // BOM / 零宽不换行空格
  /[\u2060-\u2069]/, // 词连接符、不可见操作符等
];

/** 默认阻断阈值 */
const DEFAULT_BLOCK_THRESHOLD: Severity = 'high';

/** 地毯式替换检测的描述长度阈值 */
const CARPET_BOMBING_DESC_LENGTH = 500;

/** 地毯式替换检测的注入模式匹配数阈值 */
const CARPET_BOMBING_MATCH_THRESHOLD = 2;

/** 名称仿冒的 Levenshtein 距离阈值 */
const IMPERSONATION_DISTANCE = 2;

/** 各严重度的数值（用于比较） */
const SEVERITY_ORDER: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

// ============================================================
// 辅助函数
// ============================================================

/**
 * 计算两个字符串的 Levenshtein 距离（编辑距离）
 *
 * 自实现，不引入外部依赖。使用经典 DP 算法，
 * 空间复杂度 O(m*n)，时间复杂度 O(m*n)。
 *
 * @param a 字符串 a
 * @param b 字符串 b
 * @returns 编辑距离（插入/删除/替换各计 1 次操作）
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // dp[i][j] = a 的前 i 字符 → b 的前 j 字符 的最小编辑距离
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,        // 删除
        dp[i][j - 1] + 1,        // 插入
        dp[i - 1][j - 1] + cost, // 替换
      );
    }
  }
  return dp[m][n];
}

/**
 * 提取匹配周围的上下文（用于 evidence 字段）
 *
 * @param text 原始文本
 * @param matchStart 匹配起始位置
 * @param matchEnd 匹配结束位置
 * @param contextRadius 上下文半径（前后各取的字符数）
 * @returns 包含上下文的证据片段
 */
function extractContext(
  text: string,
  matchStart: number,
  matchEnd: number,
  contextRadius = 20,
): string {
  const start = Math.max(0, matchStart - contextRadius);
  const end = Math.min(text.length, matchEnd + contextRadius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return prefix + text.slice(start, end) + suffix;
}

// ============================================================
// McpSecurityScanner 主类
// ============================================================

/**
 * MCP 工具安全扫描器
 *
 * 用法：
 *   const scanner = new McpSecurityScanner({
 *     knownToolNames: ['file_read', 'file_write'],
 *     blockThreshold: 'high',
 *   });
 *
 *   const findings = scanner.scan({
 *     name: 'file_read',
 *     description: 'Read a file from disk',
 *   });
 *
 *   if (scanner.shouldBlock(findings)) {
 *     // 阻断该工具注册
 *   }
 */
export class McpSecurityScanner {
  /** 注入指令模式列表 */
  private readonly injectionPatterns: RegExp[];
  /** 隐藏 Unicode 字符范围列表 */
  private readonly hiddenUnicodeRanges: RegExp[];
  /** 已知合法工具名集合 */
  private readonly knownToolNames: Set<string>;
  /** 阻断阈值 */
  private readonly blockThreshold: Severity;

  constructor(opts?: McpSecurityScannerOptions) {
    this.injectionPatterns = [...DEFAULT_INJECTION_PATTERNS];
    this.hiddenUnicodeRanges = [...DEFAULT_HIDDEN_UNICODE_RANGES];
    this.knownToolNames = new Set(opts?.knownToolNames ?? []);
    this.blockThreshold = opts?.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD;
  }

  /**
   * 扫描工具定义，返回所有发现
   *
   * 检测顺序（不影响结果，仅影响 findings 数组顺序）：
   *   1. 工具投毒（poisoning）
   *   2. 名称仿冒（impersonation）
   *   3. 隐藏指令（hidden_instruction）
   *   4. 地毯式替换（carpet_bombing）
   *
   * @param toolDef 待扫描的工具定义
   * @returns 发现列表（可能为空）
   */
  scan(toolDef: McpToolDefinition): McpSecurityFinding[] {
    const findings: McpSecurityFinding[] = [];
    const description = toolDef.description ?? '';
    const name = toolDef.name ?? '';

    // 1. 工具投毒检测：扫描描述中的注入模式
    const poisoningMatches = this.findInjectionMatches(description);
    for (const match of poisoningMatches) {
      findings.push({
        toolName: name,
        threatType: 'poisoning',
        severity: 'high',
        description: `工具描述中包含可疑注入指令：${match.pattern}`,
        evidence: extractContext(description, match.start, match.end),
      });
    }

    // 2. 名称仿冒检测：与已知工具名的 Levenshtein 距离 ≤ 2
    for (const knownName of this.knownToolNames) {
      if (name === knownName) {
        // 完全同名不算仿冒（属于命名冲突，由其他逻辑处理）
        continue;
      }
      const distance = levenshtein(name, knownName);
      if (distance > 0 && distance <= IMPERSONATION_DISTANCE) {
        findings.push({
          toolName: name,
          threatType: 'impersonation',
          severity: 'high',
          description: `工具名 "${name}" 与已知工具 "${knownName}" 相似（Levenshtein 距离=${distance}）`,
          evidence: `${name} ≈ ${knownName} (distance=${distance})`,
        });
        break; // 一个仿冒匹配即可，不重复
      }
    }

    // 3. 隐藏指令检测：扫描描述中的零宽 Unicode 字符
    for (const range of this.hiddenUnicodeRanges) {
      const match = range.exec(description);
      if (match) {
        // 计算零宽字符的码点用于 evidence
        const codePoint = description.codePointAt(match.index) ?? 0;
        const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
        findings.push({
          toolName: name,
          threatType: 'hidden_instruction',
          severity: 'medium',
          description: `工具描述中包含隐藏 Unicode 字符（U+${hex}）`,
          evidence: extractContext(description, match.index, match.index + 1),
        });
        break; // 一个隐藏字符即可标记，不重复
      }
    }

    // 4. 地毯式替换检测：描述 >500 字符 + 2+ 注入模式匹配
    if (
      description.length > CARPET_BOMBING_DESC_LENGTH &&
      poisoningMatches.length >= CARPET_BOMBING_MATCH_THRESHOLD
    ) {
      findings.push({
        toolName: name,
        threatType: 'carpet_bombing',
        severity: 'critical',
        description: `工具描述长度 ${description.length} 超过 ${CARPET_BOMBING_DESC_LENGTH}，且包含 ${poisoningMatches.length} 个注入模式匹配（阈值 ${CARPET_BOMBING_MATCH_THRESHOLD}）`,
        evidence: `length=${description.length}, matches=${poisoningMatches.length}`,
      });
    }

    return findings;
  }

  /**
   * 是否阻断注册
   *
   * 当任一发现的 severity >= blockThreshold 时返回 true。
   *
   * @param findings scan() 返回的发现列表
   * @returns 是否阻断
   */
  shouldBlock(findings: McpSecurityFinding[]): boolean {
    const thresholdValue = SEVERITY_ORDER[this.blockThreshold];
    return findings.some((f) => SEVERITY_ORDER[f.severity] >= thresholdValue);
  }

  /**
   * 在文本中查找所有注入模式匹配
   *
   * @param text 待扫描文本
   * @returns 匹配列表（包含模式、位置）
   */
  private findInjectionMatches(
    text: string,
  ): Array<{ pattern: string; start: number; end: number }> {
    const matches: Array<{ pattern: string; start: number; end: number }> = [];
    for (const re of this.injectionPatterns) {
      // 复制 pattern 并强制加 global flag，便于 exec 迭代所有匹配
      const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
      const reGlobal = new RegExp(re.source, flags);
      let m: RegExpExecArray | null;
      while ((m = reGlobal.exec(text)) !== null) {
        matches.push({
          pattern: re.source,
          start: m.index,
          end: m.index + m[0].length,
        });
        // 防止零宽匹配死循环
        if (m[0].length === 0) {
          reGlobal.lastIndex++;
        }
      }
    }
    return matches;
  }
}
