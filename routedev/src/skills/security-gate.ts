// src/skills/security-gate.ts
// 技能安全扫描门控（Phase 53 Task 6）
//
// 17 类漏洞规则正则扫描 + 风险评分 + 自动安装门禁
//
// 设计原则：
//   - 诚实记账：scanMode 永远为 'static-only'（无 LLM），llm* 字段永远为 false
//   - 无 config 开关也能独立运行（config 守护在 app-init.ts）
//   - 基线抑制：与基线完全匹配的发现 severity 降一级
//   - 风险评分递减：同规则多次匹配按 0.5x → 0.25x → 0.1x 衰减

// ============================================================
// 类型定义
// ============================================================

/** 严重度等级 */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** 安全扫描发现 */
export interface SkillSecurityFinding {
  /** 规则名（如 'command_injection'） */
  rule: string;
  /** 严重度 */
  severity: Severity;
  /** 证据片段 */
  evidence: string;
  /** 行号（可选，1-based） */
  line?: number;
}

/** 扫描结果 */
export interface SkillScanResult {
  /** 技能 ID */
  skillId: string;
  /** 风险评分（0-100，越低越安全） */
  score: number;
  /** 发现列表 */
  findings: SkillSecurityFinding[];
  /** 扫描模式：永远为 'static-only'（诚实记账） */
  scanMode: 'static-only' | 'static+llm';
  /** 是否请求了 LLM 扫描：永远为 false */
  llmRequested: boolean;
  /** LLM 是否可用：永远为 false */
  llmAvailable: boolean;
  /** 是否使用了 LLM：永远为 false */
  llmUsed: boolean;
}

/** 漏洞规则定义 */
export interface VulnerabilityRule {
  /** 规则名（如 'command_injection'） */
  name: string;
  /** 正则模式 */
  pattern: RegExp;
  /** 严重度 */
  severity: Severity;
}

/** 门控构造配置 */
export interface SkillSecurityGateOptions {
  /** 自动安装阈值：score <= 此值才允许自动安装（默认 30） */
  autoInstallThreshold?: number;
  /** 基线发现列表（用于基线抑制） */
  baselineFindings?: SkillSecurityFinding[];
}

// ============================================================
// 默认配置
// ============================================================

/** 默认自动安装阈值 */
const DEFAULT_AUTO_INSTALL_THRESHOLD = 30;

/** 严重度 → 基础分映射 */
const SEVERITY_BASE_SCORE: Record<Severity, number> = {
  critical: 50,
  high: 25,
  medium: 10,
  low: 5,
};

/** 同规则递减乘数（index 0 = 第 1 次匹配，1 = 第 2 次，...） */
const DECAY_MULTIPLIERS = [1.0, 0.5, 0.25, 0.1];

/** 可执行文件扩展名（触发 1.3x 乘数） */
const EXECUTABLE_EXTENSIONS = ['.exe', '.sh', '.bat'];

/** 可执行文件乘数 */
const EXECUTABLE_MULTIPLIER = 1.3;

/** 严重度降级顺序：critical → high → medium → low → 跳过 */
const SEVERITY_DOWNGRADE: Record<Severity, Severity | null> = {
  critical: 'high',
  high: 'medium',
  medium: 'low',
  low: null,
};

// ============================================================
// 默认 17 类漏洞规则
// ============================================================

/**
 * 默认漏洞规则（17 类）
 *
 * 严重度按蓝图分配：
 *   critical: 命令注入、SQL 注入、不安全反序列化、命令拼接
 *   high:     路径穿越、XSS、硬编码密钥、文件包含、eval 类
 *   medium:   SSRF、弱加密、不安全随机、危险 API
 *   low:      SSRF URL、调试代码、网络外发、模板注入
 */
const DEFAULT_VULNERABILITY_RULES: VulnerabilityRule[] = [
  // 1. 命令注入 critical
  { name: 'command_injection', pattern: /eval\(|exec\(|system\(/, severity: 'critical' },
  // 2. 路径穿越 high
  { name: 'path_traversal', pattern: /\.\.[\\\/]/, severity: 'high' },
  // 3. SSRF medium
  { name: 'ssrf', pattern: /fetch\(|axios\(|http\.get\(/, severity: 'medium' },
  // 4. SQL 注入 critical
  { name: 'sql_injection', pattern: /';.*--|OR.*1=1/, severity: 'critical' },
  // 5. XSS high
  { name: 'xss', pattern: /<script>/, severity: 'high' },
  // 6. 硬编码密钥 high
  { name: 'hardcoded_secret', pattern: /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9]{16,}/, severity: 'high' },
  // 7. 不安全反序列化 critical
  { name: 'unsafe_deserialization', pattern: /unserialize\(|pickle\.loads\(/, severity: 'critical' },
  // 8. 弱加密 medium
  { name: 'weak_crypto', pattern: /md5\(|sha1\(/, severity: 'medium' },
  // 9. SSRF URL low
  { name: 'ssrf_url', pattern: /http:\/\/localhost|http:\/\/127\.0\.0\.1/, severity: 'low' },
  // 10. 调试代码 low
  { name: 'debug_code', pattern: /console\.log|debugger|print\(/, severity: 'low' },
  // 11. 文件包含 high
  { name: 'file_inclusion', pattern: /include\(|require\(.+\$_(GET|POST)/, severity: 'high' },
  // 12. 命令拼接 critical
  { name: 'command_concat', pattern: /shell_exec\(|passthru\(/, severity: 'critical' },
  // 13. 不安全随机 medium
  { name: 'insecure_random', pattern: /Math\.random\(\)/, severity: 'medium' },
  // 14. eval 类 high
  { name: 'eval_class', pattern: /new Function\(/, severity: 'high' },
  // 15. 危险 API medium
  { name: 'dangerous_api', pattern: /process\.exit\(|window\.location/, severity: 'medium' },
  // 16. 网络外发 low
  { name: 'network_egress', pattern: /XMLHttpRequest|WebSocket/, severity: 'low' },
  // 17. 模板注入 low
  { name: 'template_injection', pattern: /\{\{.*\}\}/, severity: 'low' },
];

// ============================================================
// SkillSecurityGate 主类
// ============================================================

/**
 * 技能安全扫描门控
 *
 * 用法：
 *   const gate = new SkillSecurityGate({
 *     autoInstallThreshold: 30,
 *     baselineFindings: [...],
 *   });
 *
 *   const result = gate.scan('my-skill', skillContent);
 *
 *   if (!gate.canAutoInstall(result)) {
 *     // 阻断自动安装，提示用户审查
 *   }
 */
export class SkillSecurityGate {
  /** 漏洞规则列表 */
  private readonly vulnerabilityRules: VulnerabilityRule[];
  /** 自动安装阈值 */
  private readonly autoInstallThreshold: number;
  /** 基线发现（用于基线抑制） */
  private readonly baselineFindings: SkillSecurityFinding[];

  constructor(opts?: SkillSecurityGateOptions) {
    this.vulnerabilityRules = [...DEFAULT_VULNERABILITY_RULES];
    this.autoInstallThreshold = opts?.autoInstallThreshold ?? DEFAULT_AUTO_INSTALL_THRESHOLD;
    this.baselineFindings = opts?.baselineFindings ?? [];
  }

  /**
   * 扫描技能内容
   *
   * @param skillId 技能 ID（用于可执行文件乘数判断）
   * @param content 技能内容字符串
   * @returns 扫描结果（含 score、findings、诚实记账字段）
   */
  scan(skillId: string, content: string): SkillScanResult {
    // 收集所有发现（按规则顺序）
    const rawFindings: SkillSecurityFinding[] = [];

    const lines = content.split('\n');

    for (const rule of this.vulnerabilityRules) {
      // 复制 pattern 并强制加 global flag，便于 exec 迭代所有匹配
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
      const globalRe = new RegExp(rule.pattern.source, flags);
      let m: RegExpExecArray | null;
      while ((m = globalRe.exec(content)) !== null) {
        // 计算行号（1-based）
        const line = this.lineOfOffset(lines, m.index);
        // 提取证据片段
        const evidence = this.extractEvidence(content, m.index, m.index + m[0].length);
        rawFindings.push({
          rule: rule.name,
          severity: rule.severity,
          evidence,
          line,
        });
        // 防止零宽匹配死循环
        if (m[0].length === 0) {
          globalRe.lastIndex++;
        }
      }
    }

    // 基线抑制：与基线 (rule, evidence) 完全匹配的发现 severity 降一级
    const findings = this.applyBaselineSuppression(rawFindings);

    // 风险评分
    const score = this.computeScore(skillId, findings);

    return {
      skillId,
      score,
      findings,
      // 诚实记账：本模块无 LLM 集成，所有 LLM 相关字段永远为 false
      scanMode: 'static-only',
      llmRequested: false,
      llmAvailable: false,
      llmUsed: false,
    };
  }

  /**
   * 是否允许自动安装
   *
   * @param result 扫描结果
   * @returns score <= autoInstallThreshold 时返回 true
   */
  canAutoInstall(result: SkillScanResult): boolean {
    return result.score <= this.autoInstallThreshold;
  }

  // ----------------------------------------------------------
  // 内部辅助方法
  // ----------------------------------------------------------

  /**
   * 计算风险评分
   *
   * 算法：
   *   1. 按规则分组，第 N 次匹配乘以 DECAY_MULTIPLIERS[N-1]
   *      （第 1 次 1.0x，第 2 次 0.5x，第 3 次 0.25x，第 4 次及之后 0.1x）
   *   2. 求和
   *   3. 可执行文件（skillId 含 .exe/.sh/.bat）乘以 1.3x
   *   4. 封顶 0-100
   */
  private computeScore(skillId: string, findings: SkillSecurityFinding[]): number {
    // 按规则分组，记录每个规则已匹配的次数
    const perRuleCount = new Map<string, number>();
    let total = 0;
    for (const f of findings) {
      const count = perRuleCount.get(f.rule) ?? 0;
      // 第 N 次匹配的乘数（N 从 1 开始）
      const multiplier = DECAY_MULTIPLIERS[Math.min(count, DECAY_MULTIPLIERS.length - 1)];
      const base = SEVERITY_BASE_SCORE[f.severity];
      total += base * multiplier;
      perRuleCount.set(f.rule, count + 1);
    }

    // 可执行文件乘数
    const isExecutable = EXECUTABLE_EXTENSIONS.some((ext) =>
      skillId.toLowerCase().endsWith(ext),
    );
    if (isExecutable) {
      total *= EXECUTABLE_MULTIPLIER;
    }

    // 封顶 0-100
    return Math.max(0, Math.min(100, Math.round(total)));
  }

  /**
   * 应用基线抑制
   *
   * 如果当前发现的 (rule, evidence) 与基线完全匹配，
   * 则该发现 severity 降一级（critical → high → medium → low → 跳过）。
   */
  private applyBaselineSuppression(
    findings: SkillSecurityFinding[],
  ): SkillSecurityFinding[] {
    if (this.baselineFindings.length === 0) {
      return findings;
    }
    // 构建基线索引：rule::evidence → 是否存在
    const baselineIndex = new Set<string>();
    for (const b of this.baselineFindings) {
      baselineIndex.add(`${b.rule}::${b.evidence}`);
    }

    const result: SkillSecurityFinding[] = [];
    for (const f of findings) {
      const key = `${f.rule}::${f.evidence}`;
      if (baselineIndex.has(key)) {
        // 命中基线 → severity 降一级
        const downgraded = SEVERITY_DOWNGRADE[f.severity];
        if (downgraded === null) {
          // 已是最低 → 跳过
          continue;
        }
        result.push({ ...f, severity: downgraded });
      } else {
        result.push(f);
      }
    }
    return result;
  }

  /**
   * 根据字符 offset 计算行号（1-based）
   *
   * @param lines content.split('\n') 的结果
   * @param offset 字符偏移量
   * @returns 行号（1-based）
   */
  private lineOfOffset(lines: string[], offset: number): number {
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      // +1 为换行符占用的 1 个字符
      const lineEnd = pos + lines[i].length + 1;
      if (offset < lineEnd) {
        return i + 1;
      }
      pos = lineEnd;
    }
    return lines.length;
  }

  /**
   * 提取证据片段（带上下文）
   *
   * @param content 原始内容
   * @param start 匹配起始位置
   * @param end 匹配结束位置
   * @param radius 上下文半径（前后各取的字符数）
   * @returns 证据片段（可能带 ... 前缀/后缀）
   */
  private extractEvidence(
    content: string,
    start: number,
    end: number,
    radius = 20,
  ): string {
    const s = Math.max(0, start - radius);
    const e = Math.min(content.length, end + radius);
    const prefix = s > 0 ? '...' : '';
    const suffix = e < content.length ? '...' : '';
    return prefix + content.slice(s, e) + suffix;
  }
}
