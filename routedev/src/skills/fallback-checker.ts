// src/skills/fallback-checker.ts
// Skill 兜底确认检查器（Phase 49 Task 3.3）
//
// 知识库原文：
//   "AI 在 Skill 执行失败时会自己'兜底'——这是最大风险。
//    兜底方案必须显式确认。
//    Skill 中的每个 fallback 都要有'询问用户'步骤。"
//
// 检查规则（蓝图 3.3 节）：
//   1. Skill body 中包含兜底声明（如"如果做不到""如果失败"）时，
//      必须配对出现确认指令（如"停止并询问""请用户确认"）
//   2. Skill body 中不应出现危险的自动降级表述
//      （如"自动降级""默默回退""直接跳过""忽略错误继续"）
//   3. 无兜底声明时视为通过（Skill 无需为不存在的兜底补充确认）

import type { ParsedSkill } from './skill-md-parser.js';

/** 兜底确认检查结果 */
export interface FallbackCheckResult {
  /** 是否通过（无 issues 即通过） */
  passed: boolean;
  /** 问题列表（空数组表示通过） */
  issues: string[];
}

/**
 * 兜底声明关键词正则
 *
 * 匹配 Skill body 中声明的兜底场景，如：
 *   - 中文：如果做不到 / 如果失败 / 如果无法 / 出错时 / 异常时
 *   - 英文：if.fail / fallback
 */
const FALLBACK_KEYWORDS = /如果做不到|如果失败|如果无法|if\.fail|fallback|出错时|异常时/i;

/**
 * 兜底确认关键词正则（必须与兜底声明配对出现）
 *
 * 匹配 Skill body 中的显式确认指令，如：
 *   - 中文：停止并询问 / 不要降级 / 请用户确认
 *   - 英文：ask.user / abort.and.ask
 */
const CONFIRM_KEYWORDS = /停止并询问|不要降级|ask\.user|请用户确认|abort\.and\.ask/i;

/**
 * 危险降级关键词正则（不应出现在 Skill body 中）
 *
 * 匹配 Skill body 中的危险自动降级表述，如：
 *   - 自动降级 / 默默回退 / 直接跳过 / 忽略错误继续
 */
const DANGEROUS_FALLBACK = /自动降级|默默回退|直接跳过|忽略错误继续/i;

/**
 * Skill 兜底确认检查器
 *
 * 检查 Skill body 中的兜底声明是否有配对的确认指令，
 * 以及是否包含危险的自动降级表述。
 */
export class FallbackChecker {
  /**
   * 检查 Skill 的兜底确认完整性
   *
   * @param skill 已解析的 Skill
   * @returns 检查结果（passed=true 表示通过）
   */
  static check(skill: ParsedSkill): FallbackCheckResult {
    const content = skill.content;
    const issues: string[] = [];

    // 规则 1：有兜底声明但缺确认指令 → 报告 issue
    const hasFallback = FALLBACK_KEYWORDS.test(content);
    if (hasFallback) {
      const hasConfirm = CONFIRM_KEYWORDS.test(content);
      if (!hasConfirm) {
        issues.push('Skill 包含兜底声明但缺少"询问用户"或"停止"的确认指令');
      }
    }

    // 规则 2：有危险降级表述 → 报告 issue
    const hasDangerous = DANGEROUS_FALLBACK.test(content);
    if (hasDangerous) {
      issues.push(
        'Skill 包含危险的自动降级表述（如"自动降级""默默回退"），应改为询问用户',
      );
    }

    return { passed: issues.length === 0, issues };
  }
}
