// src/agent/requirement-change.ts
// 需求变更检测 + 影响分析
// 配合 BranchManager.editByHistoryIndex 使用：当用户编辑历史消息时，
// 检测是否构成"需求变更"，并分析对当前 GoalPlan / FivePartGoalSpec 的影响。

export interface RequirementChange {
  type: 'edit' | 'insert' | 'delete';
  targetNodeId: string;
  before: string;
  after: string;
  impactedBranches: string[];
  timestamp: number;
}

export interface ChangeImpactResult {
  needsReplan: boolean;
  reason: string;
  affectedSteps: string[]; // 受影响的 GoalStep id 列表
  severity: 'minor' | 'moderate' | 'major';
}

// 功能词：表示新增功能（→ major）
const FEATURE_WORDS = ['支持', '增加', '新增', '实现', '添加', '加入', '扩展'];

// 范围词：表示范围调整（→ moderate）
const SCOPE_WORDS = ['不要', '取消', '移除', '去掉', '删除', '去除', '排除'];

/**
 * 检测是否是需求变更（只有 role==='user' 的消息变更才算）
 */
export function isRequirementChange(
  oldMessage: { role: string; content: string },
  newMessage: { role: string; content: string },
): boolean {
  // 只有 user 角色的消息变更才算
  if (oldMessage.role !== 'user' || newMessage.role !== 'user') {
    return false;
  }
  // 内容不同才算变更
  return oldMessage.content !== newMessage.content;
}

/**
 * 生成需求变更 diff（简单的行级 diff，基于 LCS）
 */
export function generateRequirementDiff(before: string, after: string): {
  added: string[];
  removed: string[];
  unchanged: string[];
} {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const m = beforeLines.length;
  const n = afterLines.length;
  // LCS 动态规划表
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯找出 added/removed/unchanged
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      unchanged.unshift(beforeLines[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      removed.unshift(beforeLines[i - 1]);
      i--;
    } else {
      added.unshift(afterLines[j - 1]);
      j--;
    }
  }
  while (i > 0) {
    removed.unshift(beforeLines[i - 1]);
    i--;
  }
  while (j > 0) {
    added.unshift(afterLines[j - 1]);
    j--;
  }

  return { added, removed, unchanged };
}

/**
 * 提取文本的字符 bigram（2-gram）集合
 * 中文没有词边界，用 bigram 重叠度衡量相关性
 */
function extractBigrams(text: string): Set<string> {
  // 去除空白
  const cleaned = text.replace(/\s+/g, '');
  const bigrams = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    const bg = cleaned.slice(i, i + 2);
    // 过滤掉不含中文/字母/数字的 bigram（纯标点）
    if (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(bg)) {
      bigrams.add(bg);
    }
  }
  return bigrams;
}

/**
 * 判断两段文本是否有 bigram 重叠（用于中文相关性判断）
 */
function hasBigramOverlap(textA: string, textB: string): boolean {
  const bigramsA = extractBigrams(textA);
  const bigramsB = extractBigrams(textB);
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) {
      return true;
    }
  }
  return false;
}

/**
 * 分析需求变更对 GoalPlan 的影响
 *
 * 判断规则：
 *   1. 提取变更前后的关键词差异
 *   2. 变更包含新功能词（"支持"/"增加"/"新增"/"实现"）→ major，needsReplan=true
 *   3. 变更包含范围词（"不要"/"取消"/"移除"/"去掉"）→ moderate，needsReplan=true
 *   4. 变更只是措辞调整 → minor，needsReplan=false
 *   5. 如果有 currentSpec，检查 doneWhen 是否受影响
 *   6. 如果有 currentGoalPlan，检查 steps 描述是否与变更相关
 */
export function analyzeChangeImpact(
  change: RequirementChange,
  currentGoalPlan?: {
    description: string;
    steps: Array<{ id: number; description: string; status: string }>;
  },
  currentSpec?: {
    goal: string;
    scope: string;
    constraints: string[];
    doneWhen: string[];
    stopIf: string[];
  },
): ChangeImpactResult {
  const diff = generateRequirementDiff(change.before, change.after);
  const addedText = diff.added.join(' ');
  const removedText = diff.removed.join(' ');
  const changeText = `${addedText} ${removedText}`;

  let severity: 'minor' | 'moderate' | 'major' = 'minor';
  let needsReplan = false;
  let reason = '';

  // 规则 2：包含新功能词（after 有但 before 没有）→ major
  const hasFeatureWord = FEATURE_WORDS.some(
    (w) => change.after.includes(w) && !change.before.includes(w),
  );
  if (hasFeatureWord) {
    severity = 'major';
    needsReplan = true;
    reason = '变更包含新功能需求，需要重新规划';
  }

  // 规则 3：包含范围词 → moderate
  if (!needsReplan) {
    const hasScopeWord = SCOPE_WORDS.some((w) => changeText.includes(w));
    if (hasScopeWord) {
      severity = 'moderate';
      needsReplan = true;
      reason = '变更涉及范围调整，需要重新规划';
    }
  }

  // 规则 4：措辞调整 → minor
  if (!needsReplan) {
    severity = 'minor';
    needsReplan = false;
    reason = '变更仅为措辞调整，无需重新规划';
  }

  // 规则 5：检查 doneWhen 是否受影响
  if (currentSpec && currentSpec.doneWhen && currentSpec.doneWhen.length > 0) {
    if (affectsDoneCriteria(change, currentSpec.doneWhen)) {
      // 完成标准受影响时，至少升级到 moderate
      if (severity === 'minor') {
        severity = 'moderate';
        needsReplan = true;
        reason = '变更影响完成标准，需要重新规划';
      }
    }
  }

  // 规则 6：检查 steps 描述是否与变更相关
  const affectedSteps: string[] = [];
  if (currentGoalPlan && currentGoalPlan.steps && currentGoalPlan.steps.length > 0) {
    for (const step of currentGoalPlan.steps) {
      if (hasBigramOverlap(changeText, step.description)) {
        affectedSteps.push(String(step.id));
      }
    }
  }

  return {
    needsReplan,
    reason,
    affectedSteps,
    severity,
  };
}

/**
 * 判断变更是否影响完成标准
 */
export function affectsDoneCriteria(change: RequirementChange, doneWhen: string[]): boolean {
  const diff = generateRequirementDiff(change.before, change.after);
  const changeText = `${diff.added.join(' ')} ${diff.removed.join(' ')}`;

  for (const criteria of doneWhen) {
    if (hasBigramOverlap(changeText, criteria)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断变更是否影响范围
 */
export function affectsScope(change: RequirementChange, scope: string): boolean {
  const diff = generateRequirementDiff(change.before, change.after);
  const changeText = `${diff.added.join(' ')} ${diff.removed.join(' ')}`;

  // 范围词直接判定
  const hasScopeWord = SCOPE_WORDS.some((w) => changeText.includes(w));
  if (hasScopeWord) {
    return true;
  }

  // bigram 重叠判定
  return hasBigramOverlap(changeText, scope);
}

/**
 * 格式化变更摘要（用于 UI 展示）
 */
export function formatChangeSummary(change: RequirementChange): string {
  const typeLabel: Record<RequirementChange['type'], string> = {
    edit: '编辑',
    insert: '插入',
    delete: '删除',
  };

  const diff = generateRequirementDiff(change.before, change.after);
  const summary = change.after.slice(0, 50);
  const ellipsis = change.after.length > 50 ? '...' : '';

  return `[${typeLabel[change.type]}] ${summary}${ellipsis}（+${diff.added.length}/-${diff.removed.length}）`;
}
