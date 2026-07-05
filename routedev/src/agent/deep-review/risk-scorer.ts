// src/agent/deep-review/risk-scorer.ts
// Phase 72：风险评分器——根据 diff 与变更文件列表计算 0-100 的风险评分
//
// 评分维度（纯函数，无副作用）：
//   1. 变更行数：每 50 行 +5 分，上限 30
//   2. 文件数：每文件 +3 分，上限 20
//   3. 关键路径文件：security/、config/、auth/、permission/、crypto/ 路径文件每出现 +8 分，上限 30
//   4. 删除行数占比：>30% 删除 +10 分
//   5. 新增文件：每个 +2 分，上限 20
//
// 总分 clamp 到 [0, 100]。

/** 关键路径关键词列表（命中即视为高风险文件） */
const CRITICAL_PATH_KEYWORDS = ['security/', 'config/', 'auth/', 'permission/', 'crypto/'];

/** 计算单个文件是否为关键路径文件 */
function isCriticalPath(filePath: string): boolean {
  // 路径归一化：统一用 / 比较，避免 Windows 反斜杠漏判
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return CRITICAL_PATH_KEYWORDS.some(kw => normalized.includes(kw));
}

/**
 * 从 diff 文本中统计新增行数与删除行数
 * - 以 "+" 开头但非 "+++" 的行计为新增
 * - 以 "-" 开头但非 "---" 的行计为删除
 */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/**
 * 从 diff 文本中识别"新增文件"的数量
 * 新增文件的标志：diff 头中包含 "new file mode"
 */
function countNewFiles(diff: string): number {
  const matches = diff.match(/^new file mode \d+$/gm);
  return matches ? matches.length : 0;
}

/**
 * 计算风险评分（0-100）
 *
 * @param diff 当前 git diff 文本
 * @param changedFiles 变更文件路径列表
 * @returns 0-100 之间的整数风险评分
 */
export function scoreRisk(diff: string, changedFiles: string[]): number {
  // 空变更直接返回 0
  if (!diff && changedFiles.length === 0) return 0;

  let score = 0;

  // 1. 变更行数维度：每 50 行 +5 分，上限 30
  const { added, removed } = countDiffLines(diff);
  const totalChangedLines = added + removed;
  score += Math.min(30, Math.floor(totalChangedLines / 50) * 5);

  // 2. 文件数维度：每文件 +3 分，上限 20
  score += Math.min(20, changedFiles.length * 3);

  // 3. 关键路径文件维度：每个 +8 分，上限 30
  let criticalCount = 0;
  for (const f of changedFiles) {
    if (isCriticalPath(f)) criticalCount++;
  }
  score += Math.min(30, criticalCount * 8);

  // 4. 删除行数占比维度：删除占比 >30% 时 +10 分
  //    避免除零：当 totalChangedLines=0 时比例按 0 处理
  const removeRatio = totalChangedLines > 0 ? removed / totalChangedLines : 0;
  if (removeRatio > 0.3) score += 10;

  // 5. 新增文件维度：每个 +2 分，上限 20
  const newFileCount = countNewFiles(diff);
  score += Math.min(20, newFileCount * 2);

  // 总分 clamp 到 [0, 100]
  return Math.max(0, Math.min(100, score));
}
