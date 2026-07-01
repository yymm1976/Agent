// src/tools/builtin/config-guard.ts
// Phase 53 Task 7：配置保护守卫
//
// 设计哲学："反写死"——核心配置（安全开关、黑名单、治理引擎）不允许被静默弱化
// 本模块作为文件修改前的拦截层，基于确定性正则识别"安全弱化"模式
//
// 设计要点：
//   1. 不引入 yaml / js-yaml 等运行时依赖，仅用正则匹配 key: value
//   2. 默认内置 6 条受保护 pattern，用户 pattern 追加（不替换）
//   3. 9 条弱化检测规则，区分 deny（阻断）与 warn（提示）
//   4. "升级为更严格"被允许（如 sandbox 降级→严格 才告警，反向放行）
//   5. 无 config 开关也能独立运行：所有阈值与 pattern 通过 constructor opts 注入

/**
 * 守卫决策结果
 */
export interface GuardDecision {
  /** 是否允许通过（false 表示拦截） */
  allowed: boolean;
  /** 决策原因（人类可读） */
  reason?: string;
  /** 严重级别：info / warn / deny */
  severity: 'info' | 'warn' | 'deny';
  /** 触发的规则 id（如 'security.enabled.off'） */
  ruleId?: string;
}

/**
 * 默认受保护文件 pattern（构造时内置）
 *
 * 注意：以 RegExp 字符串形式定义，构造时统一编译为 RegExp（i 标志）
 */
const DEFAULT_PROTECTED_PATTERNS: string[] = [
  '/\\.routedev\\.yaml$/i',
  '/config\\.yaml$/i',
  '/\\.routedev\\/policies\\.yaml$/i',
  '/\\.routedev\\/hooks\\.yaml$/i',
  '/\\.routedev\\/permissions\\.json$/i',
  '/\\.routedev\\/skill-baseline\\.json$/i',
];

/**
 * 将形如 "/pattern/flags" 的字符串解析为 RegExp
 * 不支持的格式（如缺少前后斜杠）按字面字符串构造（包含则匹配）
 */
function parsePattern(input: string): RegExp {
  const match = /^\/(.+)\/([a-z]*)$/i.exec(input);
  if (match) {
    const [, body, flags] = match;
    return new RegExp(body, flags);
  }
  // 退化：按字面字符串包含匹配（i 标志）
  return new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * 配置保护守卫
 *
 * 检查文件修改是否会"弱化"已存在的安全/治理配置
 * 默认受保护文件覆盖 .routedev.yaml / config.yaml / .routedev/policies.yaml 等关键配置
 */
export class ConfigGuard {
  /** 受保护文件 pattern（已编译） */
  private readonly protectedPatterns: RegExp[];
  /** 用户自定义 pattern 原始字符串（保留用于诊断） */
  private readonly userProtectedPatterns: string[];
  /** 是否对首次 warn 进行宽限处理 */
  private readonly warnOnFirst: boolean;
  /** 标记：首次 warn 是否已触发 */
  private firstTriggered: boolean = false;

  constructor(opts?: {
    /** 用户自定义 pattern（追加到默认之后，不替换） */
    protectedPatterns?: string[];
    /** 首次 warn 是否降级为 info（默认 false） */
    warnOnFirst?: boolean;
  }) {
    // 编译默认 pattern
    this.protectedPatterns = DEFAULT_PROTECTED_PATTERNS.map(parsePattern);
    // 追加用户 pattern
    this.userProtectedPatterns = opts?.protectedPatterns ?? [];
    for (const p of this.userProtectedPatterns) {
      this.protectedPatterns.push(parsePattern(p));
    }
    this.warnOnFirst = opts?.warnOnFirst ?? false;
  }

  /**
   * 检查文件修改是否被允许
   *
   * 算法流程：
   *   1. 文件路径不匹配任何 protectedPatterns → 直接放行（allowed=true, severity=info）
   *   2. 匹配到受保护文件后，按 9 条规则做 diff 分析
   *   3. oldContent 未提供时，仅检查 newContent 是否包含"危险值"
   *
   * @param filePath 文件路径
   * @param newContent 新内容
   * @param oldContent 旧内容（可选）
   */
  checkModification(
    filePath: string,
    newContent: string,
    oldContent?: string,
  ): GuardDecision {
    // 1) 文件路径不匹配任何受保护 pattern → 放行
    const isProtected = this.protectedPatterns.some((re) => re.test(filePath));
    if (!isProtected) {
      return {
        allowed: true,
        severity: 'info',
        reason: '文件不在受保护配置列表中',
      };
    }

    // 2) 按 9 条规则做弱化检测
    const decision = this.detectWeakening(filePath, newContent, oldContent);

    // 3) warnOnFirst 宽限处理：仅对 warn 级别生效
    if (
      this.warnOnFirst &&
      !this.firstTriggered &&
      decision.severity === 'warn'
    ) {
      this.firstTriggered = true;
      return {
        ...decision,
        severity: 'info',
        reason: `[首次宽限] ${decision.reason ?? ''}`.trim(),
      };
    }

    // 标记首次 warn 已触发（即使 warnOnFirst=false，也记录状态用于诊断）
    if (decision.severity === 'warn') {
      this.firstTriggered = true;
    }

    return decision;
  }

  /**
   * 弱化检测主算法
   *
   * 9 条规则的统一返回约定：
   *   - 命中 deny 规则 → 立即返回（deny 优先级最高）
   *   - 命中 warn 规则 → 累积，但 deny 优先
   *   - 未命中任何规则 → allowed=true
   */
  private detectWeakening(
    filePath: string,
    newContent: string,
    oldContent?: string,
  ): GuardDecision {
    // 提取字段值（key → value 字符串）
    const newFields = extractFieldValues(newContent);
    const oldFields = oldContent ? extractFieldValues(oldContent) : new Map<string, string>();

    // ============================================================
    // 规则 1：security.enabled: true → false → deny
    // ============================================================
    {
      const ruleId = 'security.enabled.off';
      const oldVal = oldFields.get('security.enabled');
      const newVal = newFields.get('security.enabled');
      if (isBoolTrue(oldVal) && isBoolFalse(newVal)) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.enabled 从 true 改为 false（弱化安全开关）`,
        };
      }
      // oldContent 未提供时，仅检查 newContent 是否包含危险值
      if (!oldContent && isBoolFalse(newVal)) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.enabled = false（疑似弱化安全开关）`,
        };
      }
    }

    // ============================================================
    // 规则 2：security.commandBlacklist 数组减少 → deny
    // 数组形式支持：多行（- xxx）/ inline（[a, b]）/ 单一标量
    // ============================================================
    {
      const ruleId = 'security.commandBlacklist.shrunk';
      const oldCount = oldContent
        ? countArrayInContent(oldContent, 'security.commandBlacklist')
        : 0;
      const newCount = countArrayInContent(newContent, 'security.commandBlacklist');
      if (oldContent && newCount < oldCount) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.commandBlacklist 条目数从 ${oldCount} 减少到 ${newCount}（弱化命令黑名单）`,
        };
      }
    }

    // ============================================================
    // 规则 3：security.toolBlacklist 数组减少 → deny
    // ============================================================
    {
      const ruleId = 'security.toolBlacklist.shrunk';
      const oldCount = oldContent
        ? countArrayInContent(oldContent, 'security.toolBlacklist')
        : 0;
      const newCount = countArrayInContent(newContent, 'security.toolBlacklist');
      if (oldContent && newCount < oldCount) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.toolBlacklist 条目数从 ${oldCount} 减少到 ${newCount}（弱化工具黑名单）`,
        };
      }
    }

    // ============================================================
    // 规则 4：security.sandbox 从 'workspace-write'/'full-access' 改为 'read-only' → warn
    // 注意：升级为更严格（如 workspace-write → full-access 反方向不算弱化）才警告
    // 实际语义：read-only 是最严格，full-access 是最宽松
    //   - 升级（更宽松）：full-access ← workspace-write ← read-only → 警告
    // 任务描述："从 'workspace-write'/'full-access' 改为 'read-only' → warn" 看似矛盾
    // 但任务说明明确：降级（变严格）才警告。这里按任务原文执行：
    //   "从 workspace-write/full-access 改为 read-only → warn"
    // ============================================================
    {
      const ruleId = 'security.sandbox.downgrade';
      const oldVal = oldFields.get('security.sandbox');
      const newVal = newFields.get('security.sandbox');
      if (
        oldContent &&
        isSandboxLoose(oldVal) &&
        isSandboxStrict(newVal)
      ) {
        return {
          allowed: true,
          severity: 'warn',
          ruleId,
          reason: `检测到 security.sandbox 从 '${oldVal}' 改为 '${newVal}'（沙箱策略变更）`,
        };
      }
    }

    // ============================================================
    // 规则 5：security.strictBashMode: true → false → deny
    // ============================================================
    {
      const ruleId = 'security.strictBashMode.off';
      const oldVal = oldFields.get('security.strictBashMode');
      const newVal = newFields.get('security.strictBashMode');
      if (isBoolTrue(oldVal) && isBoolFalse(newVal)) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.strictBashMode 从 true 改为 false（关闭严格 Bash 模式）`,
        };
      }
      if (!oldContent && isBoolFalse(newVal)) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.strictBashMode = false（疑似关闭严格 Bash 模式）`,
        };
      }
    }

    // ============================================================
    // 规则 6：security.ssrfProtection: true → false → deny
    // ============================================================
    {
      const ruleId = 'security.ssrfProtection.off';
      const oldVal = oldFields.get('security.ssrfProtection');
      const newVal = newFields.get('security.ssrfProtection');
      if (isBoolTrue(oldVal) && isBoolFalse(newVal)) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.ssrfProtection 从 true 改为 false（关闭 SSRF 保护）`,
        };
      }
      if (!oldContent && isBoolFalse(newVal)) {
        return {
          allowed: false,
          severity: 'deny',
          ruleId,
          reason: `检测到 security.ssrfProtection = false（疑似关闭 SSRF 保护）`,
        };
      }
    }

    // ============================================================
    // 规则 7：policyEngine.enabled: true → false → warn（弱化治理）
    // ============================================================
    {
      const ruleId = 'policyEngine.enabled.off';
      const oldVal = oldFields.get('policyEngine.enabled');
      const newVal = newFields.get('policyEngine.enabled');
      if (isBoolTrue(oldVal) && isBoolFalse(newVal)) {
        return {
          allowed: true,
          severity: 'warn',
          ruleId,
          reason: `检测到 policyEngine.enabled 从 true 改为 false（弱化治理引擎）`,
        };
      }
    }

    // ============================================================
    // 规则 8：auditChain.enabled: true → false → warn
    // ============================================================
    {
      const ruleId = 'auditChain.enabled.off';
      const oldVal = oldFields.get('auditChain.enabled');
      const newVal = newFields.get('auditChain.enabled');
      if (isBoolTrue(oldVal) && isBoolFalse(newVal)) {
        return {
          allowed: true,
          severity: 'warn',
          ruleId,
          reason: `检测到 auditChain.enabled 从 true 改为 false（关闭审计链）`,
        };
      }
    }

    // ============================================================
    // 规则 9：非 protectedPatterns 匹配的文件 → allowed=true（已在入口处理）
    // 这里所有规则均未命中 → 放行
    // ============================================================
    void filePath;
    return {
      allowed: true,
      severity: 'info',
      reason: '配置变更未触发任何弱化规则',
    };
  }
}

// ============================================================
// 内部工具函数：YAML/JSON 字段提取与比较
// ============================================================

/**
 * 从 YAML / JSON 文本中提取 "namespace.key: value" 形式的字段值
 *
 * 兼容两种格式：
 *   - YAML 嵌套：`security:\n  enabled: true` → security.enabled = true
 *   - JSON 顶层：`"security.enabled": true` 或 `"security": { "enabled": true }`（部分）
 *
 * 实现策略（确定性正则，不引入 yaml 库）：
 *   1. 维护命名空间栈：遇到 `xxx:` 行后跟缩进的子键 → 拼接为 xxx.yyy
 *   2. 跳过注释（# 开头）和空行
 *   3. 数组项不视为字段，单独由 countArrayEntries 处理
 *
 * @returns Map<fieldKey, rawValueString>，rawValueString 已 trim 并去引号
 */
function extractFieldValues(content: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!content) return result;

  // 处理 JSON 顶层 dot-path 形式：`"security.enabled": true`
  // 仅作快速通路，主要逻辑走 YAML 解析
  const jsonQuickPath = /["']([a-zA-Z_][\w.]*)["']\s*:\s*["']?([\w-]+)["']?/g;
  let m: RegExpExecArray | null;
  while ((m = jsonQuickPath.exec(content)) !== null) {
    const [, key, val] = m;
    if (!result.has(key)) {
      result.set(key, val);
    }
  }

  // YAML 嵌套解析：基于缩进维护命名空间栈
  const lines = content.split(/\r?\n/);
  // 栈元素：{ indent, key }
  const stack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of lines) {
    // 跳过空行和注释
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }
    // 跳过数组项（- 开头），由 countArrayEntries 单独处理
    if (trimmed.startsWith('-')) {
      continue;
    }

    // 计算行首缩进（空格数；tab 按 4 处理）
    const indentMatch = /^([\t ]*)/.exec(rawLine);
    const indentRaw = indentMatch ? indentMatch[1] : '';
    const indent = indentRaw.replace(/\t/g, '    ').length;

    // 弹出栈中 indent >= 当前的项
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    // 匹配 "key: value" 或 "key:" （value 可空，子项跟在后面）
    const kvMatch = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!kvMatch) continue;
    const [, key, rawVal] = kvMatch;
    const val = rawVal.trim().replace(/^["']|["']$/g, '');

    // 拼接命名空间
    const fullKey =
      stack.length > 0
        ? `${stack[stack.length - 1].key}.${key}`
        : key;

    if (val !== '') {
      // 仅记录第一次出现，避免被覆盖
      if (!result.has(fullKey)) {
        result.set(fullKey, val);
      }
    }

    // 该 key 可能是 namespace，压栈等待子项
    if (val === '') {
      stack.push({ indent, key: fullKey });
    }
  }

  return result;
}

/**
 * 从原始 content 中统计指定数组字段的条目数
 *
 * 支持三种形式：
 *   1) 多行 YAML：
 *        security:
 *          commandBlacklist:
 *            - rm
 *            - curl
 *   2) inline YAML / JSON：
 *        commandBlacklist: [rm, curl]
 *        "commandBlacklist": ["rm", "curl"]
 *   3) 单一标量：commandBlacklist: rm
 *
 * 算法：
 *   - 用正则定位到 `${lastSegment}:` 所在行的缩进与位置
 *   - 若该行值非空（inline 或标量）→ 走 inline 解析
 *   - 若该行值为空 → 收集后续缩进更深的连续 `- xxx` 行
 *
 * @param content 原始 YAML / JSON 文本
 * @param fieldKey 完整字段路径（如 'security.commandBlacklist'）
 */
function countArrayInContent(content: string, fieldKey: string): number {
  if (!content) return 0;
  const segments = fieldKey.split('.');
  const lastKey = segments[segments.length - 1];

  // 1) inline 形式：匹配 "lastKey: [...]" 或 "lastKey": [...]
  //    多行形式也先尝试匹配 inline，命中即返回
  // 使用动态构造的正则：lastKey 后跟冒号 + 任意空白 + [
  const inlineRegex = new RegExp(
    `^\\s*["']?${escapeRegex(lastKey)}["']?\\s*:\\s*\\[(.*)\\]\\s*,?\\s*$`,
  );
  const lines = content.split(/\r?\n/);

  // 先扫一遍查找 inline 数组与多行数组的起始位置
  let arrayStartLineIdx = -1;
  let arrayStartIndent = -1;
  let inlineValue: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // inline 数组：`key: [a, b]`
    const inlineMatch = inlineRegex.exec(line);
    if (inlineMatch) {
      // 校验该 key 是否在正确的命名空间路径下
      if (isInNamespace(lines, i, segments)) {
        inlineValue = inlineMatch[1];
        break;
      }
    }
    // 多行数组起始：`key:` 或 `key:` 行后跟缩进
    // 用更宽松的匹配：^\s*key:\s*$
    const startRegex = new RegExp(
      `^([\\t ]*)["']?${escapeRegex(lastKey)}["']?\\s*:\\s*$`,
    );
    const startMatch = startRegex.exec(line);
    if (startMatch && isInNamespace(lines, i, segments)) {
      arrayStartLineIdx = i;
      arrayStartIndent = startMatch[1].replace(/\t/g, '    ').length;
      break;
    }
  }

  // inline 数组解析
  if (inlineValue !== null) {
    const items = inlineValue
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
    return items.length;
  }

  // 多行数组计数：从 arrayStartLineIdx + 1 开始，收集所有缩进 > arrayStartIndent 的 `- xxx` 行
  if (arrayStartLineIdx >= 0) {
    let count = 0;
    for (let i = arrayStartLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      // 空行跳过
      if (line.trim() === '') continue;
      const indentMatch = /^([\t ]*)/.exec(line);
      const indent = indentMatch
        ? indentMatch[1].replace(/\t/g, '    ').length
        : 0;
      // 缩进回到与起始行相同或更浅 → 数组结束
      if (indent <= arrayStartIndent) break;
      // 仅统计 `- xxx` 形式的行
      if (/^\s*-\s+/.test(line)) {
        count++;
      }
    }
    return count;
  }

  // 未找到数组字段 → 0
  return 0;
}

/**
 * 校验数组 key 是否在正确的命名空间路径下
 *
 * 例如 segments = ['security', 'commandBlacklist']
 *   - 当 lastKey 行的缩进 > 父 namespace 行的缩进 → 在 namespace 下
 *   - 若父 namespace 不存在（顶层 key），仅校验 lastKey 是顶层
 *
 * 简化策略：从当前行向上回溯，依次找到所有父 key 的最近出现位置
 * 不要求严格父子关系，仅要求父 key 在当前行之前出现过且缩进 < 当前行
 */
function isInNamespace(
  lines: string[],
  currentIdx: number,
  segments: string[],
): boolean {
  // segments 长度为 1 时，顶层 key，无需校验父命名空间
  if (segments.length <= 1) return true;

  const currentLine = lines[currentIdx];
  const curIndentMatch = /^([\t ]*)/.exec(currentLine);
  const currentIndent = curIndentMatch
    ? curIndentMatch[1].replace(/\t/g, '    ').length
    : 0;

  // 从 segments 中去掉最后一个（已确认是 lastKey），逐个向上找父 namespace
  const parents = segments.slice(0, -1);
  let searchIdx = currentIdx - 1;
  // 倒序遍历 parents：最内层父优先
  for (let p = parents.length - 1; p >= 0; p--) {
    const parentKey = parents[p];
    const parentRegex = new RegExp(
      `^([\\t ]*)["']?${escapeRegex(parentKey)}["']?\\s*:\\s*$`,
    );
    let found = false;
    while (searchIdx >= 0) {
      const line = lines[searchIdx];
      const m = parentRegex.exec(line);
      if (m) {
        const parentIndent = m[1].replace(/\t/g, '    ').length;
        // 父 namespace 缩进必须严格小于当前 key 的缩进
        if (parentIndent < currentIndent) {
          found = true;
          searchIdx = searchIdx - 1;
          break;
        }
      }
      searchIdx--;
    }
    if (!found) return false;
  }
  return true;
}

/** 转义正则元字符，用于把字面 key 安全嵌入正则 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断字符串值是否为 YAML/JSON 布尔 true
 * 兼容：true / True / TRUE
 */
function isBoolTrue(val: string | undefined): boolean {
  if (val === undefined) return false;
  return /^(true|True|TRUE)$/i.test(val);
}

/**
 * 判断字符串值是否为 YAML/JSON 布尔 false
 * 兼容：false / False / FALSE
 */
function isBoolFalse(val: string | undefined): boolean {
  if (val === undefined) return false;
  return /^(false|False|FALSE)$/i.test(val);
}

/**
 * 沙箱宽松值：workspace-write 或 full-access
 */
function isSandboxLoose(val: string | undefined): boolean {
  if (val === undefined) return false;
  return val === 'workspace-write' || val === 'full-access';
}

/**
 * 沙箱严格值：read-only
 */
function isSandboxStrict(val: string | undefined): boolean {
  return val === 'read-only';
}
