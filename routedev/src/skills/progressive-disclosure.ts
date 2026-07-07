// src/skills/progressive-disclosure.ts
// Phase 71 Task D6：兑现 docs/CONTEXT_USAGE.md 承诺，实装渐进式披露
// 根据上下文占用率、用户经验、任务复杂度动态调整输出详细度
export type DisclosureLevel = 'summary' | 'key-details' | 'full';

export interface DisclosureContext {
  /** 0-1，当前上下文占用率（已用 token / 上下文窗口） */
  tokenUsageRatio: number;
  /** 用户经验等级 */
  expertiseLevel: 'beginner' | 'intermediate' | 'expert';
  /** 任务复杂度 */
  taskComplexity: 'low' | 'medium' | 'high';
}

/**
 * 根据上下文计算披露级别
 *
 * 决策逻辑：
 * - 上下文占用 >80% → summary（强制压缩，避免溢出）
 * - 专家用户 + 低复杂度 → summary（专家不需要详细解释）
 * - 初学者 → full（详细解释，帮助理解）
 * - 其他 → key-details（默认，保留关键细节）
 */
export function computeDisclosureLevel(ctx: DisclosureContext): DisclosureLevel {
  // 上下文占用 >80% → summary（强制压缩）
  if (ctx.tokenUsageRatio > 0.8) return 'summary';
  // 专家用户 + 低复杂度 → summary
  if (ctx.expertiseLevel === 'expert' && ctx.taskComplexity === 'low') return 'summary';
  // 初学者 → full（详细解释）
  if (ctx.expertiseLevel === 'beginner') return 'full';
  // 默认 → key-details
  return 'key-details';
}

/**
 * 根据披露级别调整内容
 *
 * - summary：取首 5 行 + [已压缩...] 标记
 * - key-details：保留原内容（删除冗余空行）
 * - full：保留原内容
 */
export function applyDisclosure(content: string, level: DisclosureLevel): string {
  if (!content) return content;
  switch (level) {
    case 'summary': {
      // 取首 5 行 + 压缩标记
      const lines = content.split('\n');
      if (lines.length <= 5) return content;
      return lines.slice(0, 5).join('\n') + '\n[已压缩...]';
    }
    case 'key-details': {
      // 保留关键细节，删除连续空行（合并为单个空行）
      return content.replace(/\n{3,}/g, '\n\n');
    }
    case 'full':
      return content;
  }
}
