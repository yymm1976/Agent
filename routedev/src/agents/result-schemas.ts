// src/agents/result-schemas.ts
// Phase 51 Task 10：子 Agent 结构化返回 schema
//
// 借鉴 Flue 的 result schema + finish/give_up 协议：
//   - 每种角色（researcher / executor / reviewer）有专属的返回 schema
//   - 父 Agent 通过 validateSubAgentResult 程序化校验子 Agent 返回值
//   - formatResultForParent 将结构化结果格式化为父 Agent 可读的文本
//
// 设计要点：
//   1. 用 Zod schema 定义，必填字段（如 summary）显式声明，可选/集合字段用 .default() 兜底
//   2. 空对象 {} 仅因 summary 缺失而失败，其余集合字段缺失时自动取默认空数组
//   3. validateSubAgentResult 用 safeParse，返回 success/failure 联合类型（不抛异常）
//   4. formatResultForParent 按 role 选择对应 schema，校验通过后格式化为文本

import { z } from 'zod';
import type { AgentRole } from './profiles/types.js';

// ============================================================
// Researcher 结果 schema
// ============================================================

/**
 * Researcher（调研者）结构化返回
 * 用于调研类子 Agent 向父 Agent 汇报调研结论
 */
export const ResearcherResultSchema = z.object({
  /** 调研总结 */
  summary: z.string().describe('调研总结'),
  /** 发现的关键信息 */
  findings: z
    .array(
      z.object({
        topic: z.string(),
        detail: z.string(),
        evidence: z
          .array(
            z.object({
              file: z.string().optional(),
              line: z.number().optional(),
              excerpt: z.string().optional(),
            }),
          )
          .default([]),
        confidence: z.enum(['high', 'medium', 'low']).default('medium'),
      }),
    )
    .default([]),
  /** 建议的下一步 */
  recommendations: z.array(z.string()).default([]),
  /** 未能调研清楚的部分 */
  gaps: z.array(z.string()).default([]).describe('未能调研清楚的部分'),
});
export type ResearcherResult = z.infer<typeof ResearcherResultSchema>;

// ============================================================
// Executor 结果 schema
// ============================================================

/**
 * Executor（执行者）结构化返回
 * 用于执行类子 Agent 汇报代码变更、测试结果与遗留关切
 */
export const ExecutorResultSchema = z.object({
  /** 执行总结 */
  summary: z.string(),
  /** 变更的文件列表 */
  changes: z
    .array(
      z.object({
        file: z.string(),
        changeType: z.enum(['create', 'modify', 'delete']),
        description: z.string(),
        linesAffected: z.number().optional(),
      }),
    )
    .default([]),
  /** 已运行的测试 */
  testsRun: z
    .array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        output: z.string().optional(),
      }),
    )
    .default([]),
  /** 执行者提出的 CONCERN */
  concerns: z.array(z.string()).default([]).describe('执行者提出的 CONCERN'),
  /** 是否完成（false 表示 give_up 或未完成） */
  completed: z.boolean(),
});
export type ExecutorResult = z.infer<typeof ExecutorResultSchema>;

// ============================================================
// Reviewer 结果 schema
// ============================================================

/**
 * Reviewer（审查者）结构化返回
 * 复用 StructuredReviewFeedback 风格，每条风险携带三条证据协议字段
 */
export const ReviewerResultSchema = z.object({
  /** 审查总结 */
  summary: z.string(),
  /** 发现的风险 */
  risks: z
    .array(
      z.object({
        description: z.string(),
        failureScenario: z.string(),
        violatedInvariant: z.string(),
        evidence: z
          .array(
            z.object({
              file: z.string(),
              line: z.number(),
              excerpt: z.string().optional(),
            }),
          )
          .default([]),
        severity: z.enum(['blocking', 'warning', 'info']),
        suggestedFix: z.string().optional(),
      }),
    )
    .default([]),
  /** 总体判定 */
  overallVerdict: z.enum(['pass', 'conditional', 'fail']),
});
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;

// ============================================================
// Custom 结果 schema（兜底）
// ============================================================

/**
 * Custom（自定义角色）结构化返回
 * 仅要求 summary + completed，其余由具体角色约定
 */
export const CustomResultSchema = z.object({
  summary: z.string(),
  completed: z.boolean(),
});
export type CustomResult = z.infer<typeof CustomResultSchema>;

// ============================================================
// 角色 → schema 映射
// ============================================================

/**
 * 角色 → 结果 schema 映射
 * 父 Agent 派发任务时按 role 取对应 schema 校验返回值
 */
export const RESULT_SCHEMAS: Record<AgentRole, z.ZodType> = {
  researcher: ResearcherResultSchema,
  executor: ExecutorResultSchema,
  reviewer: ReviewerResultSchema,
  custom: CustomResultSchema,
};

// ============================================================
// 校验函数
// ============================================================

/**
 * 校验子 Agent 返回值是否符合指定 schema
 *
 * 使用 safeParse，校验失败时不抛异常，返回结构化的错误信息数组。
 *
 * @param result 子 Agent 的返回值（通常是 LLM 解析出的 JSON 对象）
 * @param schema 对应角色的 Zod schema
 * @returns 成功返回 { success: true, data }，失败返回 { success: false, errors }
 */
export function validateSubAgentResult(
  result: unknown,
  schema: z.ZodType,
): { success: true; data: unknown } | { success: false; errors: string[] } {
  const parsed = schema.safeParse(result);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return {
    success: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    }),
  };
}

// ============================================================
// 格式化函数
// ============================================================

/**
 * 根据 role 取对应 schema（非法 role 兜底到 custom）
 */
function schemaForRole(role: string): z.ZodType {
  if (role in RESULT_SCHEMAS) {
    return RESULT_SCHEMAS[role as AgentRole];
  }
  return RESULT_SCHEMAS.custom;
}

/**
 * 将 Researcher 结构化结果格式化为父 Agent 可读文本
 */
function formatResearcher(data: ResearcherResult): string {
  const lines: string[] = [`【调研总结】\n${data.summary}`];
  if (data.findings.length > 0) {
    lines.push('【关键发现】');
    data.findings.forEach((f, i) => {
      lines.push(`${i + 1}. [${f.confidence}] ${f.topic}：${f.detail}`);
      f.evidence.forEach((e) => {
        const loc = e.file ?? '(无文件)';
        const line = e.line !== undefined ? `:${e.line}` : '';
        const excerpt = e.excerpt ? ` ${e.excerpt}` : '';
        lines.push(`   - ${loc}${line}${excerpt}`);
      });
    });
  }
  if (data.recommendations.length > 0) {
    lines.push('【建议下一步】');
    data.recommendations.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  if (data.gaps.length > 0) {
    lines.push('【未决事项】');
    data.gaps.forEach((g, i) => lines.push(`${i + 1}. ${g}`));
  }
  return lines.join('\n');
}

/**
 * 将 Executor 结构化结果格式化为父 Agent 可读文本
 */
function formatExecutor(data: ExecutorResult): string {
  const lines: string[] = [`【执行总结】\n${data.summary}`];
  if (data.changes.length > 0) {
    lines.push('【文件变更】');
    data.changes.forEach((c, i) => {
      const la = c.linesAffected !== undefined ? ` (+${c.linesAffected}行)` : '';
      lines.push(`${i + 1}. [${c.changeType}] ${c.file}${la}：${c.description}`);
    });
  }
  if (data.testsRun.length > 0) {
    lines.push('【测试结果】');
    data.testsRun.forEach((t, i) => {
      const flag = t.passed ? 'PASS' : 'FAIL';
      lines.push(`${i + 1}. [${flag}] ${t.name}`);
    });
  }
  if (data.concerns.length > 0) {
    lines.push('【CONCERN】');
    data.concerns.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  }
  lines.push(`【完成状态】${data.completed ? '已完成' : '未完成'}`);
  return lines.join('\n');
}

/**
 * 将 Reviewer 结构化结果格式化为父 Agent 可读文本
 */
function formatReviewer(data: ReviewerResult): string {
  const lines: string[] = [`【审查总结】\n${data.summary}`];
  if (data.risks.length > 0) {
    lines.push('【风险清单】');
    data.risks.forEach((r, i) => {
      lines.push(
        `${i + 1}. [${r.severity}] ${r.description}`,
      );
      lines.push(`   失败场景：${r.failureScenario}`);
      lines.push(`   违反不变式：${r.violatedInvariant}`);
      r.evidence.forEach((e) => {
        const excerpt = e.excerpt ? ` ${e.excerpt}` : '';
        lines.push(`   证据：${e.file}:${e.line}${excerpt}`);
      });
      if (r.suggestedFix) {
        lines.push(`   建议修复：${r.suggestedFix}`);
      }
    });
  }
  lines.push(`【总体判定】${data.overallVerdict}`);
  return lines.join('\n');
}

/**
 * 将 Custom 结构化结果格式化为父 Agent 可读文本
 */
function formatCustom(data: CustomResult): string {
  return `【总结】\n${data.summary}\n【完成状态】${data.completed ? '已完成' : '未完成'}`;
}

/**
 * 提取最终答案文本（从结构化结果）
 *
 * 流程：
 *   1. 按 role 选择对应 schema
 *   2. 用 validateSubAgentResult 校验
 *   3. 校验失败：返回校验错误信息（供父 Agent 决策是否重试）
 *   4. 校验成功：按 role 格式化为可读文本
 *
 * @param result 子 Agent 的返回值
 * @param role 子 Agent 角色（researcher / executor / reviewer / custom）
 * @returns 父 Agent 可读的文本
 */
export function formatResultForParent(result: unknown, role: string): string {
  const schema = schemaForRole(role);
  const parsed = validateSubAgentResult(result, schema);
  if (!parsed.success) {
    return `[子 Agent 返回值校验失败]\n${parsed.errors.join('\n')}`;
  }
  const data = parsed.data;
  switch (role) {
    case 'researcher':
      return formatResearcher(data as ResearcherResult);
    case 'executor':
      return formatExecutor(data as ExecutorResult);
    case 'reviewer':
      return formatReviewer(data as ReviewerResult);
    default:
      return formatCustom(data as CustomResult);
  }
}
