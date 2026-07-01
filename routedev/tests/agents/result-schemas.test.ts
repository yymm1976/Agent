// tests/agents/result-schemas.test.ts
// Phase 51 Task 10：子 Agent 结构化返回 schema 单元测试
//
// 覆盖关键能力：
//   1. validateSubAgentResult 对 researcher/executor/reviewer 返回值校验
//   2. 缺失必填字段时返回错误列表
//   3. unknown role 兜底到 CustomResultSchema
//   4. formatResultForParent 按角色格式化文本
//
// 全部为纯函数测试，不依赖 LLM 或文件系统。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateSubAgentResult,
  formatResultForParent,
  ResearcherResultSchema,
  ExecutorResultSchema,
  ReviewerResultSchema,
  CustomResultSchema,
  RESULT_SCHEMAS,
} from '../../src/agents/result-schemas.js';

describe('Phase 51 Task 10: result-schemas 单元测试', () => {
  beforeEach(() => {
    // 纯函数无外部状态
  });

  // ============================================================
  // 1. validateSubAgentResult 校验路径
  // ============================================================

  it('1.1 validateSubAgentResult: researcher 完整返回值校验通过', () => {
    const result = {
      summary: '调研了 React Query 的使用方式',
      findings: [
        {
          topic: 'React Query',
          detail: '用于服务端状态管理',
          evidence: [{ file: 'src/a.ts', line: 10, excerpt: 'useQuery(...)' }],
          confidence: 'high',
        },
      ],
      recommendations: ['引入 React Query', '替换现有 fetch'],
      gaps: ['未确认 React Query 与 SWR 的差异'],
    };
    const parsed = validateSubAgentResult(result, ResearcherResultSchema);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.summary).toBe('调研了 React Query 的使用方式');
  });

  it('1.2 validateSubAgentResult: executor 缺必填 summary 时失败', () => {
    const result = {
      // summary 缺失
      changes: [{ file: 'a.ts', changeType: 'modify', description: '改了', linesAffected: 5 }],
      testsRun: [{ name: 'test1', passed: true }],
      concerns: [],
      completed: true,
    };
    const parsed = validateSubAgentResult(result, ExecutorResultSchema);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // errors 中应包含 summary 相关的错误
      const summaryErr = parsed.errors.find((e) => e.includes('summary'));
      expect(summaryErr).toBeDefined();
    }
  });

  it('1.3 validateSubAgentResult: executor completed=false 但缺 completed 字段时失败', () => {
    // completed 是必填，缺失应失败
    const result = {
      summary: '执行总结',
      // completed 缺失
    };
    const parsed = validateSubAgentResult(result, ExecutorResultSchema);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.errors.some((e) => e.includes('completed'))).toBe(true);
    }
  });

  it('1.4 validateSubAgentResult: executor 仅 summary + completed 即可通过（其他字段有默认值）', () => {
    const result = {
      summary: '执行总结',
      completed: true,
    };
    const parsed = validateSubAgentResult(result, ExecutorResultSchema);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as any;
      // 默认值兜底
      expect(data.changes).toEqual([]);
      expect(data.testsRun).toEqual([]);
      expect(data.concerns).toEqual([]);
    }
  });

  it('1.5 validateSubAgentResult: unknown role 兜底到 CustomResultSchema', () => {
    // CustomResultSchema 仅要求 summary + completed
    const result = { summary: '自定义', completed: false };
    const parsed = validateSubAgentResult(result, RESULT_SCHEMAS.custom);
    expect(parsed.success).toBe(true);
  });

  it('1.6 RESULT_SCHEMAS: 包含四种角色映射', () => {
    expect(Object.keys(RESULT_SCHEMAS).sort()).toEqual(['custom', 'executor', 'researcher', 'reviewer']);
    expect(RESULT_SCHEMAS.researcher).toBe(ResearcherResultSchema);
    expect(RESULT_SCHEMAS.executor).toBe(ExecutorResultSchema);
    expect(RESULT_SCHEMAS.reviewer).toBe(ReviewerResultSchema);
    expect(RESULT_SCHEMAS.custom).toBe(CustomResultSchema);
  });

  // ============================================================
  // 2. formatResultForParent 格式化输出
  // ============================================================

  it('2.1 formatResultForParent: researcher 结果格式化为包含"调研总结"的文本', () => {
    const text = formatResultForParent(
      {
        summary: '关于 React Query 的调研',
        findings: [],
        recommendations: [],
        gaps: [],
      },
      'researcher',
    );
    expect(text).toContain('调研总结');
    expect(text).toContain('关于 React Query 的调研');
  });

  it('2.2 formatResultForParent: executor 结果格式化为包含"执行总结"的文本', () => {
    const text = formatResultForParent(
      {
        summary: '完成了登录页',
        changes: [{ file: 'src/login.tsx', changeType: 'create' as const, description: '新建登录组件', linesAffected: 100 }],
        testsRun: [{ name: 'login.test.ts', passed: true }],
        concerns: ['尚未处理 SSO'],
        completed: true,
      },
      'executor',
    );
    expect(text).toContain('执行总结');
    expect(text).toContain('完成了登录页');
    expect(text).toContain('src/login.tsx');
    expect(text).toContain('login.test.ts');
    expect(text).toContain('已完成');
  });

  it('2.3 formatResultForParent: reviewer 结果格式化包含"审查总结"与"总体判定"', () => {
    const text = formatResultForParent(
      {
        summary: '存在两个风险',
        risks: [
          {
            description: '密码明文存储',
            failureScenario: '数据库被攻破后密码泄露',
            violatedInvariant: '密码必须加密存储',
            evidence: [{ file: 'src/auth.ts', line: 42 }],
            severity: 'blocking' as const,
            suggestedFix: '使用 bcrypt 加密',
          },
        ],
        overallVerdict: 'fail' as const,
      },
      'reviewer',
    );
    expect(text).toContain('审查总结');
    expect(text).toContain('总体判定');
    expect(text).toContain('fail');
    expect(text).toContain('blocking');
  });

  it('2.4 formatResultForParent: unknown role 兜底到 CustomResultSchema 格式化', () => {
    const text = formatResultForParent(
      { summary: '自定义结果', completed: true },
      'unknown-role',
    );
    expect(text).toContain('自定义结果');
    expect(text).toContain('已完成');
  });

  it('2.5 formatResultForParent: 校验失败时返回错误信息文本', () => {
    const text = formatResultForParent(
      { /* 缺 summary + completed */ },
      'executor',
    );
    expect(text).toContain('子 Agent 返回值校验失败');
  });
});
