// src/skills/coach.ts
// Phase 97 Part I Task I3：流程沉淀引导（Skills 化）
//
// 借鉴 Proma 的「经验固化」思想：不要求用户主动写 Skill，
// 而是基于 trace 里的 tool 调用序列自动检测「重复出现的工作流模式」，
// 生成 Skill 草案建议；建议经用户批准后才落盘（不自动写入）。
//
// 约束：
//   - 纯函数，无副作用（不读文件、不写文件）
//   - 输入为 tool 调用序列（string[]），由调用方从 trace spans 提取
//   - 只生成「建议」，落盘与审批由上层（skill-lifecycle / UI）负责

// ============================================================
// 类型定义
// ============================================================

/** Skill 草案建议（检测到重复工作流时生成） */
export interface SkillDraftSuggestion {
  /** 建议的 Skill 名称（由重复模式中的高频 tool 名推导） */
  suggestedName: string;
  /** 建议理由（人类可读） */
  reason: string;
  /** 检测到的工作流模式（连续 tool 名序列） */
  toolPattern: string[];
  /** 该模式在输入序列中的出现次数 */
  occurrences: number;
  /** 示例任务描述（最多 3 条，由调用方传入） */
  exampleTasks: string[];
}

/** 检测选项 */
export interface DetectWorkflowOptions {
  /** 最少重复次数（达到才视为「重复工作流」），默认 2 */
  minRepeat?: number;
  /** n-gram 窗口上限（连续 tool 数），默认 4 */
  maxWindow?: number;
  /** 返回建议上限，默认 3 */
  maxPatterns?: number;
}

// ============================================================
// 常量
// ============================================================

/** 默认最少重复次数 */
const DEFAULT_MIN_REPEAT = 2;
/** 默认 n-gram 窗口上限 */
const DEFAULT_MAX_WINDOW = 4;
/** 默认建议上限 */
const DEFAULT_MAX_PATTERNS = 3;

// ============================================================
// 检测逻辑
// ============================================================

/**
 * 从 tool 调用序列中检测重复工作流模式
 *
 * 算法（n-gram 频率统计，简单可靠）：
 *   1. 对序列生成 2..maxWindow 长度的连续子序列（n-gram）
 *   2. 统计每个 n-gram 的出现次数
 *   3. 出现次数 ≥ minRepeat 且「未被更长模式包含」的 n-gram 视为重复工作流
 *   4. 按 (长度, 频率) 排序，返回频率最高的若干模式
 *
 * 「未被更长模式包含」规则：若某模式是另一更高频模式的连续子序列，则忽略短的，
 * 避免同一工作流同时报出 2 步/3 步/4 步三个建议。
 *
 * @param toolSequence 一次任务执行的 tool 调用序列（按时间顺序）
 * @param options 检测选项
 * @returns Skill 草案建议列表（按优先级降序）；无重复模式时返回空数组
 */
export function detectRepeatedWorkflows(
  toolSequence: string[],
  options: DetectWorkflowOptions = {},
): SkillDraftSuggestion[] {
  const minRepeat = options.minRepeat ?? DEFAULT_MIN_REPEAT;
  const maxWindow = options.maxWindow ?? DEFAULT_MAX_WINDOW;
  const maxPatterns = options.maxPatterns ?? DEFAULT_MAX_PATTERNS;

  if (minRepeat < 2 || maxWindow < 2 || toolSequence.length < minRepeat) {
    return [];
  }

  // 1. 生成所有 n-gram 并计数（key 用 '|' 连接，避免 tool 名内嵌分隔符歧义）
  const freq = new Map<string, { count: number; pattern: string[] }>();
  for (let win = 2; win <= Math.min(maxWindow, toolSequence.length); win++) {
    for (let i = 0; i + win <= toolSequence.length; i++) {
      const pattern = toolSequence.slice(i, i + win);
      const key = pattern.join('|');
      const existing = freq.get(key);
      if (existing) {
        existing.count++;
      } else {
        freq.set(key, { count: 1, pattern });
      }
    }
  }

  // 2. 过滤达到阈值的模式，并按长度降序（先处理长模式）
  const candidates = [...freq.entries()]
    .filter(([, v]) => v.count >= minRepeat)
    .sort((a, b) => b[1].pattern.length - a[1].pattern.length);

  // 3. 去冗余：短模式若被更长模式包含则忽略
  //    （判断「包含」只看 tool 名序列，不看绝对位置）
  const kept: Array<{ key: string; count: number; pattern: string[] }> = [];
  for (const [key, v] of candidates) {
    const isSubPattern = kept.some((k) =>
      k.pattern.length > v.pattern.length && containsPattern(k.pattern, v.pattern),
    );
    if (!isSubPattern) {
      kept.push({ key, count: v.count, pattern: v.pattern });
    }
  }

  // 4. 按 (频率, 长度) 降序，取前 maxPatterns
  const top = kept
    .sort((a, b) => b.count - a.count || b.pattern.length - a.pattern.length)
    .slice(0, maxPatterns);

  return top.map((item) => {
    // Skill 名：取模式中最高频 tool 名（去重后），用 '-' 连接
    const toolNames = [...new Set(item.pattern)];
    const suggestedName = toolNames.slice(0, 3).join('-') || 'workflow-skill';
    return {
      suggestedName,
      reason: `检测到 ${item.count} 次重复的工作流：${item.pattern.join(' → ')}，建议固化为 Skill 复用`,
      toolPattern: item.pattern,
      occurrences: item.count,
      exampleTasks: [],
    };
  });
}

/**
 * 从 trace spans 提取 tool 调用序列
 *
 * 兼容两类 span：
 *   - type: 'tool_call' → 直接取 payload.toolName
 *   - type: 'react_iteration' → 取 payload.action?.toolName（有 action 时）
 *
 * @param spans trace spans（按时间顺序）
 * @returns tool 名序列（忽略非 tool 类 span）
 */
export function extractToolSequence(
  spans: Array<{
    type: string;
    payload?: {
      type?: string;
      toolName?: string;
      action?: { toolName?: string };
    };
  }>,
): string[] {
  const sequence: string[] = [];
  for (const span of spans) {
    if (span.type === 'tool_call') {
      const name = span.payload?.toolName;
      if (name) sequence.push(name);
    } else if (span.type === 'react_iteration') {
      const name = span.payload?.action?.toolName;
      if (name) sequence.push(name);
    }
  }
  return sequence;
}

// ============================================================
// 内部辅助
// ============================================================

/** 判断 longer 序列是否包含 shorter 序列（连续子序列） */
function containsPattern(longer: string[], shorter: string[]): boolean {
  if (shorter.length > longer.length) return false;
  outer: for (let i = 0; i + shorter.length <= longer.length; i++) {
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) continue outer;
    }
    return true;
  }
  return false;
}
