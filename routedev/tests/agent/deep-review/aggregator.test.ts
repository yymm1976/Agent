// tests/agent/deep-review/aggregator.test.ts
// Phase 72：聚合器测试——解析、去重、仲裁、汇总

import { describe, it, expect } from 'vitest';
import {
  parseIssuesFromReport,
  dedupeIssues,
  arbitrate,
  aggregate,
} from '../../../src/agent/deep-review/aggregator.js';
import type {
  ReviewerReport,
  ReviewIssue,
  DeepReviewConfig,
} from '../../../src/agent/deep-review/types.js';
import type { ReviewFocus } from '../../../src/cli/commands/review.js';

/** 构造一份 ReviewerReport */
function makeReport(overrides: Partial<ReviewerReport> = {}): ReviewerReport {
  return {
    focus: 'correctness' as ReviewFocus,
    success: true,
    output: '',
    issueCounts: { critical: 0, major: 0, minor: 0, total: 0 },
    durationMs: 100,
    ...overrides,
  };
}

/** 构造一份默认 DeepReviewConfig */
function makeConfig(overrides: Partial<DeepReviewConfig> = {}): DeepReviewConfig {
  return {
    enabled: true,
    focuses: ['correctness', 'security', 'performance', 'style'],
    parallel: 2,
    arbitration: 'critical-veto',
    aggregateMode: 'concat',
    crossModel: false,
    riskThreshold: 40,
    reviewModel: 'auto',
    reviewStrictness: 'medium',
    ...overrides,
  };
}

/** 一段示例 reviewer 输出（含 3 个问题） */
const SAMPLE_OUTPUT = `### Critical（必须修复）
- [src/auth.ts:42] 密码明文存储 → 使用 bcrypt 哈希

### Major（建议修复）
- [src/auth.ts:58] 缺少输入校验 → 添加长度与字符校验

### Minor（可选修复）
- [src/utils.ts:10] 命名不规范 → 改为 camelCase

### 总结
问题总数：3 个（critical: 1, major: 1, minor: 1）`;

describe('aggregator', () => {
  describe('parseIssuesFromReport', () => {
    it('解析 markdown 输出提取问题列表', () => {
      const report = makeReport({ output: SAMPLE_OUTPUT });
      const issues = parseIssuesFromReport(report);
      expect(issues).toHaveLength(3);
      expect(issues[0].severity).toBe('critical');
      expect(issues[0].file).toBe('src/auth.ts');
      expect(issues[0].line).toBe('42');
      expect(issues[0].description).toContain('密码明文存储');
      expect(issues[0].suggestion).toBe('使用 bcrypt 哈希');
      expect(issues[2].severity).toBe('minor');
    });

    it('空输出返回空数组', () => {
      const report = makeReport({ output: '' });
      expect(parseIssuesFromReport(report)).toHaveLength(0);
    });

    it('失败的报告返回空数组', () => {
      const report = makeReport({ success: false, output: 'some error' });
      expect(parseIssuesFromReport(report)).toHaveLength(0);
    });

    it('格式错误的行被跳过', () => {
      const output = `### Critical（必须修复）
- 这一行没有方括号格式
- [src/auth.ts:42] 正确格式的问题
随机非列表行
### Major（建议修复）
* [src/x.ts:1] 用星号开头也算

### 总结
问题总数：2 个`;
      const report = makeReport({ output });
      const issues = parseIssuesFromReport(report);
      // 应解析出 2 个：1 个 critical + 1 个 major；格式错误的行被跳过
      expect(issues).toHaveLength(2);
      expect(issues.filter(i => i.severity === 'critical')).toHaveLength(1);
      expect(issues.filter(i => i.severity === 'major')).toHaveLength(1);
    });

    it('dedupeKey 包含 file + line + description 前 80 字符', () => {
      const report = makeReport({
        output: '### Minor（可选修复）\n- [a.ts:1] 描述内容',
      });
      const issues = parseIssuesFromReport(report);
      expect(issues[0].dedupeKey).toBe('a.ts:1:描述内容');
    });
  });

  describe('dedupeIssues', () => {
    it('相同 dedupeKey 的问题去重为一个', () => {
      const issues: ReviewIssue[] = [
        { focus: 'correctness', severity: 'minor', file: 'a.ts', line: '1', description: 'desc', dedupeKey: 'a.ts:1:desc' },
        { focus: 'security', severity: 'minor', file: 'a.ts', line: '1', description: 'desc', dedupeKey: 'a.ts:1:desc' },
      ];
      expect(dedupeIssues(issues)).toHaveLength(1);
    });

    it('保留严重度最高的一项', () => {
      const issues: ReviewIssue[] = [
        { focus: 'correctness', severity: 'minor', file: 'a.ts', line: '1', description: 'desc', dedupeKey: 'a.ts:1:desc' },
        { focus: 'security', severity: 'critical', file: 'a.ts', line: '1', description: 'desc', dedupeKey: 'a.ts:1:desc' },
        { focus: 'performance', severity: 'major', file: 'a.ts', line: '1', description: 'desc', dedupeKey: 'a.ts:1:desc' },
      ];
      const deduped = dedupeIssues(issues);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].severity).toBe('critical');
    });

    it('不同 dedupeKey 的问题保留全部', () => {
      const issues: ReviewIssue[] = [
        { focus: 'correctness', severity: 'minor', file: 'a.ts', line: '1', description: 'desc1', dedupeKey: 'a.ts:1:desc1' },
        { focus: 'security', severity: 'critical', file: 'a.ts', line: '2', description: 'desc2', dedupeKey: 'a.ts:2:desc2' },
      ];
      expect(dedupeIssues(issues)).toHaveLength(2);
    });

    it('空列表返回空数组', () => {
      expect(dedupeIssues([])).toHaveLength(0);
    });
  });

  describe('arbitrate', () => {
    it('critical-veto：有 critical 问题 → reject', () => {
      const reports = [makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'critical', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'critical-veto')).toBe('reject');
    });

    it('critical-veto：无 critical 问题 → approve', () => {
      const reports = [makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'major', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'critical-veto')).toBe('approve');
    });

    it('majority-vote：>50% 成功且无 critical → approve', () => {
      const reports = [
        makeReport({ focus: 'correctness' }),
        makeReport({ focus: 'security' }),
        makeReport({ focus: 'performance', success: false }),
      ];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'major', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'majority-vote')).toBe('approve');
    });

    it('majority-vote：有 critical → request_changes', () => {
      const reports = [makeReport(), makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'critical', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'majority-vote')).toBe('request_changes');
    });

    it('highest-severity：有 critical → reject', () => {
      const reports = [makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'critical', description: 'x', dedupeKey: 'k1' },
        { focus: 'correctness', severity: 'major', description: 'y', dedupeKey: 'k2' },
      ];
      expect(arbitrate(reports, issues, 'highest-severity')).toBe('reject');
    });

    it('highest-severity：仅有 major → request_changes', () => {
      const reports = [makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'major', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'highest-severity')).toBe('request_changes');
    });

    it('highest-severity：仅 minor 或无问题 → approve', () => {
      const reports = [makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'minor', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'highest-severity')).toBe('approve');
    });

    it('all-must-pass：全部成功且无 critical/major → approve', () => {
      const reports = [makeReport(), makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'minor', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'all-must-pass')).toBe('approve');
    });

    it('all-must-pass：有 major → request_changes', () => {
      const reports = [makeReport(), makeReport()];
      const issues: ReviewIssue[] = [
        { focus: 'security', severity: 'major', description: 'x', dedupeKey: 'k1' },
      ];
      expect(arbitrate(reports, issues, 'all-must-pass')).toBe('request_changes');
    });

    it('半数以上 reviewer 失败 → inconclusive（覆盖所有策略）', () => {
      const reports = [
        makeReport({ focus: 'correctness', success: false }),
        makeReport({ focus: 'security', success: false }),
        makeReport({ focus: 'performance', success: true }),
      ];
      const issues: ReviewIssue[] = [];
      expect(arbitrate(reports, issues, 'critical-veto')).toBe('inconclusive');
      expect(arbitrate(reports, issues, 'majority-vote')).toBe('inconclusive');
      expect(arbitrate(reports, issues, 'highest-severity')).toBe('inconclusive');
      expect(arbitrate(reports, issues, 'all-must-pass')).toBe('inconclusive');
    });

    it('0 reviewer → inconclusive（Phase 72 修复 I1：避免空审查 approve 误导）', () => {
      const issues: ReviewIssue[] = [];
      expect(arbitrate([], issues, 'critical-veto')).toBe('inconclusive');
      expect(arbitrate([], issues, 'majority-vote')).toBe('inconclusive');
      expect(arbitrate([], issues, 'highest-severity')).toBe('inconclusive');
      expect(arbitrate([], issues, 'all-must-pass')).toBe('inconclusive');
    });

    it('全部成功无问题 → approve（所有策略）', () => {
      const reports = [makeReport(), makeReport()];
      const issues: ReviewIssue[] = [];
      expect(arbitrate(reports, issues, 'critical-veto')).toBe('approve');
      expect(arbitrate(reports, issues, 'majority-vote')).toBe('approve');
      expect(arbitrate(reports, issues, 'highest-severity')).toBe('approve');
      expect(arbitrate(reports, issues, 'all-must-pass')).toBe('approve');
    });
  });

  describe('aggregate', () => {
    it('完整流程：解析 → 去重 → 仲裁 → 汇总', async () => {
      const reports = [
        makeReport({
          focus: 'correctness',
          output: `### Critical（必须修复）
- [a.ts:1] 重复问题 → 修复

### 总结
correctness 总结`,
        }),
        makeReport({
          focus: 'security',
          output: `### Critical（必须修复）
- [a.ts:1] 重复问题 → 修复

### Major（建议修复）
- [b.ts:2] 安全问题 → 修复

### 总结
security 总结`,
        }),
      ];
      const config = makeConfig({ aggregateMode: 'concat' });
      const result = await aggregate(reports, config);

      // 去重后：2 个问题（1 个 critical 重复 + 1 个 major）
      expect(result.issues).toHaveLength(2);
      expect(result.issues.filter(i => i.severity === 'critical')).toHaveLength(1);
      expect(result.issues.filter(i => i.severity === 'major')).toHaveLength(1);
      // 有 critical → critical-veto → reject
      expect(result.arbitration).toBe('reject');
      // concat 模式应包含两个 reviewer 的总结
      expect(result.summary).toContain('correctness');
      expect(result.summary).toContain('security');
    });

    it('llm-summary 模式无 llmClient 时降级为 concat', async () => {
      const reports = [makeReport({ output: '### 总结\nfoo' })];
      const config = makeConfig({ aggregateMode: 'llm-summary' });
      const result = await aggregate(reports, config, undefined);
      // 无 llmClient → 降级 concat，summary 应包含原总结内容
      expect(result.summary).toContain('foo');
    });

    it('tournament 模式降级为 llm-summary（再降级为 concat）', async () => {
      const reports = [makeReport({ output: '### 总结\nbar' })];
      const config = makeConfig({ aggregateMode: 'tournament' });
      const result = await aggregate(reports, config, undefined);
      // tournament → llm-summary → 无 llmClient 时 concat
      expect(result.summary).toContain('bar');
    });
  });

  // Phase 72 修复 C3：验证 reviewStrictness 注入 prompt
  describe('buildReviewerPrompt strictness 注入（C3 回归）', () => {
    it('strictness=high 时 prompt 包含"严格"', async () => {
      const { buildReviewerPrompt } = await import('../../../src/agent/deep-review/reviewer-factory.js');
      const prompt = buildReviewerPrompt('correctness', 'diff', ['file.ts'], 'high');
      expect(prompt).toContain('严格');
      expect(prompt).toContain('宁可误报不可漏报');
    });

    it('strictness=low 时 prompt 包含"宽松"', async () => {
      const { buildReviewerPrompt } = await import('../../../src/agent/deep-review/reviewer-factory.js');
      const prompt = buildReviewerPrompt('security', 'diff', ['file.ts'], 'low');
      expect(prompt).toContain('宽松');
    });

    it('strictness=medium 时 prompt 包含"默认"', async () => {
      const { buildReviewerPrompt } = await import('../../../src/agent/deep-review/reviewer-factory.js');
      const prompt = buildReviewerPrompt('performance', 'diff', ['file.ts'], 'medium');
      expect(prompt).toContain('默认');
    });
  });
});
