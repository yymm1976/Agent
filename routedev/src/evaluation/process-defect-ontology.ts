// src/evaluation/process-defect-ontology.ts
// Phase 52 Task 2：过程级缺陷评估——缺陷本体与校准风险评分卡
//
// 知识库来源：ProcBench (arXiv 2605.20251, 阿里高德) 过程级缺陷评估框架。
// 核心思想：
//   1. 把执行失败组织成可复用的缺陷本体（ontology）
//   2. 把异构日志标准化为统一轨迹表示
//   3. 报告校准的风险评分卡（CalibratedScorecard）而非仅最终结果
//
// 与 Phase 49 的 ScoreCard（仅 token/耗时/工具调用数）相比：
//   - 提供结构化的 10 类缺陷分类
//   - 校准的风险评分（考虑频率和影响）
//   - 控制保持度（执行过程中保持预期控制流的比例）
//   - 过程质量分级（A/B/C/D/F）
//
// 所有函数为纯函数，无副作用。

// ============================================================
// 类型定义
// ============================================================

/**
 * 过程级缺陷分类（来自 ProcBench 论文的缺陷本体，共 10 类）
 */
export type DefectCategory =
  | 'tool_misuse'           // 工具误用（参数错误/选错工具）
  | 'context_loss'          // 上下文丢失（忘记前序信息）
  | 'step_skip'             // 步骤跳过（跳过必要步骤）
  | 'infinite_loop'         // 死循环
  | 'premature_termination' // 过早终止（声称完成但未完成）
  | 'scope_creep'           // 范围蔓延（做了不该做的）
  | 'recovery_failure'      // 恢复失败（出错后未能恢复）
  | 'hallucination'         // 幻觉（虚构工具结果/文件内容）
  | 'permission_violation'  // 权限违反
  | 'resource_exhaustion';  // 资源耗尽（token/时间超限）

/** 单条过程缺陷 */
export interface ProcessDefect {
  category: DefectCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 校准后的风险分（0-1，考虑频率和影响） */
  calibratedRisk: number;
  stepIndex: number;
  description: string;
  /** 日志片段证据 */
  evidence: string;
  /** 是否成功恢复 */
  recoveredFrom?: boolean;
}

/** 校准评分卡 */
export interface CalibratedScorecard {
  /** 过程缺陷列表 */
  defects: ProcessDefect[];
  /** 校准后的综合风险分（0-1） */
  overallRisk: number;
  /** 控制保持度（执行过程中保持预期控制流的比例，0-1） */
  controlPreservation: number;
  /** 最终结果 pass/fail */
  outcomePassed: boolean;
  /** 过程质量分级（A/B/C/D/F） */
  processGrade: 'A' | 'B' | 'C' | 'D' | 'F';
}

/** 缺陷检测配置 */
export interface DefectDetectionConfig {
  /** 灵敏度：low 只检测明确缺陷 / medium 默认 / high 检测更多潜在缺陷 */
  sensitivity: 'low' | 'medium' | 'high';
  /** 控制保持度阈值（低于此值标记为过程异常） */
  controlPreservationThreshold: number;
}

// ============================================================
// 缺陷描述模板
// ============================================================

/** 缺陷描述模板（用于在评分卡中输出可读说明） */
export const DEFECT_DESCRIPTIONS: Record<DefectCategory, string> = {
  tool_misuse: '工具误用：参数错误、选错工具或工具调用方式不当',
  context_loss: '上下文丢失：未引用或忽略了前序步骤的关键信息',
  step_skip: '步骤跳过：跳过了任务必需的步骤',
  infinite_loop: '死循环：重复执行相同的调用且无进展',
  premature_termination: '过早终止：声称完成但实际任务未完成',
  scope_creep: '范围蔓延：执行了与任务无关的额外操作',
  recovery_failure: '恢复失败：出错后未能恢复到正常控制流',
  hallucination: '幻觉：虚构了不存在的工具结果、文件或资源',
  permission_violation: '权限违反：执行了未授权的操作',
  resource_exhaustion: '资源耗尽：token、时间或内存超限',
};

// ============================================================
// 关键词匹配表（按缺陷类别）
// ============================================================

/**
 * 每个缺陷类别的关键词表（全部小写，匹配时统一转小写）
 * - primary   核心关键词（所有灵敏度都检测）
 * - secondary 辅助关键词（仅 sensitivity=medium/high 时检测）
 * - potential 潜在关键词（仅 sensitivity=high 时检测）
 */
const DEFECT_KEYWORDS: Record<
  DefectCategory,
  { primary: string[]; secondary: string[]; potential: string[] }
> = {
  tool_misuse: {
    primary: ['wrong parameter', 'invalid argument', 'tool not found'],
    secondary: ['invalid parameter', 'no such tool', 'unknown tool'],
    potential: ['bad argument', 'argument error', 'tool error'],
  },
  context_loss: {
    primary: ['forgotten', 'not mentioned', 'ignored previous'],
    secondary: ['lost context', 'did not remember', 'previous step ignored'],
    potential: ['context dropped', 'missing reference'],
  },
  step_skip: {
    primary: ['skipped', 'missing step'],
    secondary: ['step missing', 'not executed'],
    potential: ['omitted', 'jumped over'],
  },
  infinite_loop: {
    primary: ['repeated', 'loop', 'same call'],
    secondary: ['infinite loop', 'cycling', 'stuck'],
    potential: ['duplicate call', 'retried multiple'],
  },
  premature_termination: {
    primary: ['incomplete', 'not finished', 'claimed done'],
    secondary: ['finished early', 'terminated early', 'task incomplete'],
    potential: ['stopped prematurely', 'ended too soon'],
  },
  scope_creep: {
    primary: ['unrelated', 'out of scope', 'extra'],
    secondary: ['beyond scope', 'not required', 'unnecessary'],
    potential: ['extra work', 'additional task'],
  },
  recovery_failure: {
    primary: ['failed to recover', 'still failing'],
    secondary: ['recovery failed', 'could not recover'],
    potential: ['still broken', 'not fixed after retry'],
  },
  hallucination: {
    primary: ['not exist', 'fabricated', 'invented'],
    secondary: ['does not exist', 'no such file', 'made up'],
    potential: ['false result', 'imagined'],
  },
  permission_violation: {
    primary: ['permission denied', 'unauthorized'],
    secondary: ['forbidden', 'access denied', 'not allowed'],
    potential: ['no access', 'denied'],
  },
  resource_exhaustion: {
    primary: ['token limit', 'timeout', 'out of memory'],
    secondary: ['rate limit', 'quota exceeded', 'context length exceeded'],
    potential: ['too long', 'capacity reached'],
  },
};

/**
 * 各缺陷类别的默认 severity
 * 严重类（影响执行正确性/安全性）默认 high，权限违反默认 critical
 */
const DEFAULT_SEVERITY: Record<
  DefectCategory,
  'low' | 'medium' | 'high' | 'critical'
> = {
  tool_misuse: 'medium',
  context_loss: 'medium',
  step_skip: 'high',
  infinite_loop: 'high',
  premature_termination: 'high',
  scope_creep: 'low',
  recovery_failure: 'high',
  hallucination: 'high',
  permission_violation: 'critical',
  resource_exhaustion: 'high',
};

/** severity 权重（用于校准风险分：critical=1.0, high=0.7, medium=0.4, low=0.2） */
const SEVERITY_WEIGHT: Record<'low' | 'medium' | 'high' | 'critical', number> = {
  low: 0.2,
  medium: 0.4,
  high: 0.7,
  critical: 1.0,
};

/** 缺陷类别固定顺序（用于遍历检测时保持稳定结果） */
const DEFECT_CATEGORY_ORDER: DefectCategory[] = [
  'tool_misuse',
  'context_loss',
  'step_skip',
  'infinite_loop',
  'premature_termination',
  'scope_creep',
  'recovery_failure',
  'hallucination',
  'permission_violation',
  'resource_exhaustion',
];

// ============================================================
// 核心函数
// ============================================================

/**
 * 缺陷分类器
 *
 * 根据日志条目的 error/output 关键词匹配缺陷类型。
 * 灵敏度影响检测范围：
 *   - low    仅匹配 primary 关键词，且仅查 error 字段（最严格）
 *   - medium 匹配 primary + secondary 关键词，查 error 或 output（默认）
 *   - high   匹配 primary + secondary + potential 关键词（最宽松）
 *
 * 单条日志只会匹配第一个命中的类别（按 DEFECT_CATEGORY_ORDER 顺序），
 * 避免一条日志被多次分类。
 *
 * @param logEntry 单条执行日志
 * @param config   检测配置
 * @returns 缺陷对象（calibratedRisk 暂为 0，由后续 calibrateRisk 填充）；未匹配返回 null
 */
export function classifyDefect(
  logEntry: { tool?: string; error?: string; output?: string; stepIndex: number },
  config: DefectDetectionConfig,
): ProcessDefect | null {
  const errorText = (logEntry.error ?? '').toLowerCase();
  const outputText = (logEntry.output ?? '').toLowerCase();

  // low 灵敏度仅查 error 字段；medium/high 同时查 error 和 output
  const haystacks: string[] =
    config.sensitivity === 'low' ? [errorText] : [errorText, outputText];

  for (const category of DEFECT_CATEGORY_ORDER) {
    const keywords = collectKeywords(category, config.sensitivity);

    for (const text of haystacks) {
      for (const k of keywords) {
        if (text.includes(k)) {
          return {
            category,
            severity: DEFAULT_SEVERITY[category],
            calibratedRisk: 0, // 由 calibrateRisk 后续填充
            stepIndex: logEntry.stepIndex,
            description: DEFECT_DESCRIPTIONS[category],
            evidence: extractEvidence(text, k),
          };
        }
      }
    }
  }

  return null;
}

/**
 * 校准风险分（考虑频率和影响）
 *
 * 算法：
 *   1. 取出所有同类缺陷
 *   2. 频率系数 frequencyFactor = 1 - e^(-count/3)（出现越多越接近 1，3 次约 63%）
 *   3. 影响权重取同类缺陷中最高 severity 的权重
 *   4. calibratedRisk = impactWeight * (0.6 + 0.4 * frequencyFactor)
 *      —— 影响为主（60%），频率为辅（40%）
 *
 * @param defects  当前已检测到的所有缺陷
 * @param category 待校准的缺陷类别
 * @returns 校准后的风险分（0-1）
 */
export function calibrateRisk(
  defects: ProcessDefect[],
  category: DefectCategory,
): number {
  const sameCategory = defects.filter(d => d.category === category);
  if (sameCategory.length === 0) return 0;

  // 频率系数：出现次数越多越接近 1（指数衰减，3 次达到约 63%）
  const frequencyFactor = 1 - Math.exp(-sameCategory.length / 3);

  // 影响权重：取同类缺陷中最高 severity
  const maxSeverityWeight = sameCategory.reduce(
    (max, d) => Math.max(max, SEVERITY_WEIGHT[d.severity]),
    0,
  );

  // 综合风险分：影响为主（60%），频率为辅（40%）
  const risk = maxSeverityWeight * (0.6 + 0.4 * frequencyFactor);
  return clamp01(round4(risk));
}

/**
 * 计算控制保持度
 *
 * 定义：执行过程中保持预期控制流的步骤比例
 *   controlPreservation = 1 - (unrecoveredSteps / totalSteps)
 *
 * 其中 unrecoveredSteps 为出现缺陷且未恢复（recoveredFrom !== true）的不同 stepIndex 数。
 *
 * @param totalSteps 总步骤数
 * @param defects    检测到的缺陷列表
 * @returns 控制保持度（0-1）；totalSteps <= 0 时返回 1.0
 */
export function computeControlPreservation(
  totalSteps: number,
  defects: ProcessDefect[],
): number {
  if (totalSteps <= 0) return 1.0;

  // 未恢复的不同步骤数（按 stepIndex 去重）
  const unrecoveredSteps = new Set<number>();
  for (const d of defects) {
    if (!d.recoveredFrom) {
      unrecoveredSteps.add(d.stepIndex);
    }
  }

  const ratio = unrecoveredSteps.size / totalSteps;
  return clamp01(round4(1 - ratio));
}

/**
 * 过程质量分级
 *
 * 分级规则（按优先级从高到低判断）：
 *   - A：通过 且 overallRisk < 0.1
 *   - B：通过 且 overallRisk < 0.3
 *   - C：未通过但 controlPreservation > 0.7；或 overallRisk < 0.5
 *   - D：overallRisk < 0.7
 *   - F：其他（高风险或失败且控制保持差）
 *
 * @param outcomePassed       最终结果是否通过
 * @param overallRisk         综合风险分（0-1）
 * @param controlPreservation 控制保持度（0-1）
 * @returns 过程质量分级 A/B/C/D/F
 */
export function computeProcessGrade(
  outcomePassed: boolean,
  overallRisk: number,
  controlPreservation: number,
): 'A' | 'B' | 'C' | 'D' | 'F' {
  // A：通过且风险极低
  if (outcomePassed && overallRisk < 0.1) return 'A';
  // B：通过且风险较低
  if (outcomePassed && overallRisk < 0.3) return 'B';
  // C：未通过但控制保持良好；或风险中等
  if ((!outcomePassed && controlPreservation > 0.7) || overallRisk < 0.5) return 'C';
  // D：风险较高但未到临界
  if (overallRisk < 0.7) return 'D';
  // F：其他
  return 'F';
}

/**
 * 生成校准评分卡
 *
 * 流程：
 *   1. 遍历执行日志，对每条 logEntry 调用 classifyDefect 检测缺陷
 *   2. 对每个缺陷类别调用 calibrateRisk 计算风险分
 *   3. 把风险分回填到每条缺陷（同类别共享风险分）
 *   4. 计算 overallRisk（取所有类别中最高风险分；无缺陷为 0）
 *   5. 计算 controlPreservation
 *   6. 计算 processGrade
 *
 * @param executionLog  执行日志（按 stepIndex 顺序）
 * @param outcomePassed 最终结果是否通过
 * @param config        检测配置
 * @returns 校准评分卡
 */
export function buildCalibratedScorecard(
  executionLog: Array<{ stepIndex: number; tool?: string; error?: string; output?: string }>,
  outcomePassed: boolean,
  config: DefectDetectionConfig,
): CalibratedScorecard {
  // 1. 检测缺陷
  const rawDefects: ProcessDefect[] = [];
  for (const entry of executionLog) {
    const defect = classifyDefect(entry, config);
    if (defect) {
      rawDefects.push(defect);
    }
  }

  // 2. 按类别分组并计算每个类别的校准风险分
  const categorySet = new Set<DefectCategory>(rawDefects.map(d => d.category));
  const riskByCategory = new Map<DefectCategory, number>();
  for (const cat of categorySet) {
    riskByCategory.set(cat, calibrateRisk(rawDefects, cat));
  }

  // 3. 应用风险到每条缺陷（同类别共享风险分）
  const defects: ProcessDefect[] = rawDefects.map(d => ({
    ...d,
    calibratedRisk: riskByCategory.get(d.category) ?? 0,
  }));

  // 4. overallRisk：取所有类别中最高风险分；无缺陷为 0
  const overallRisk =
    riskByCategory.size === 0
      ? 0
      : clamp01(round4(Math.max(...Array.from(riskByCategory.values()))));

  // 5. 控制保持度
  const controlPreservation = computeControlPreservation(
    executionLog.length,
    defects,
  );

  // 6. 过程质量分级
  const processGrade = computeProcessGrade(
    outcomePassed,
    overallRisk,
    controlPreservation,
  );

  return {
    defects,
    overallRisk,
    controlPreservation,
    outcomePassed,
    processGrade,
  };
}

// ============================================================
// 私有：关键词与证据工具
// ============================================================

/** 根据灵敏度收集关键词（primary / +secondary / +potential） */
function collectKeywords(
  category: DefectCategory,
  sensitivity: 'low' | 'medium' | 'high',
): string[] {
  const kw = DEFECT_KEYWORDS[category];
  switch (sensitivity) {
    case 'low':
      return kw.primary;
    case 'medium':
      return [...kw.primary, ...kw.secondary];
    case 'high':
      return [...kw.primary, ...kw.secondary, ...kw.potential];
    default:
      return kw.primary;
  }
}

/**
 * 从文本中提取证据片段（关键词前后各保留 30 字符，超长用 ... 省略）
 */
function extractEvidence(text: string, keyword: string): string {
  const idx = text.indexOf(keyword);
  if (idx < 0) return keyword;
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + keyword.length + 30);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

// ============================================================
// 私有：数值工具
// ============================================================

/** 钳制到 [0, 1] 区间 */
function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** 四舍五入到 4 位小数（避免浮点精度问题） */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
