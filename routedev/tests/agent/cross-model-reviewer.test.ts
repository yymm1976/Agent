// tests/agent/cross-model-reviewer.test.ts
// Phase 49 Task 2.6：CrossModelReviewer 跨模型审查器测试
//
// 覆盖：
//   - selectReviewerModel 选择与内循环不同的模型
//   - 陷阱 #142：只有一个模型时回退到同模型
//   - review 审查流程（mock LLM 返回）
//   - 解析 critical / warning / info 分级问题
//   - JSON 解析失败时返回保守的"通过"结果
//   - LLM 调用失败时回退（陷阱 #142）

import { describe, it, expect, vi } from 'vitest';
import { CrossModelReviewer } from '../../src/agent/cross-model-reviewer.js';
import type { ILLMClient, LLMResponse } from '../../src/router/types.js';

function makeMockLLMClient(response: Partial<LLMResponse> = {}, shouldThrow = false): ILLMClient {
  const fullResponse: LLMResponse = {
    content: '',
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    finishReason: 'stop',
    model: 'reviewer-model',
    ...response,
  };
  return {
    protocol: 'anthropic' as any,
    providerId: 'test',
    complete: vi.fn(shouldThrow
      ? async () => { throw new Error('LLM 调用失败'); }
      : async () => fullResponse,
    ),
    stream: vi.fn(async function* () {}),
    isReady: vi.fn(() => true),
  };
}

describe('CrossModelReviewer (Phase 49 Task 2.3)', () => {
  // ============================================================
  // selectReviewerModel
  // ============================================================
  describe('selectReviewerModel', () => {
    it('有多个候选时选择与内循环不同的模型', () => {
      const reviewer = new CrossModelReviewer({} as any, 'deepseek-chat', [
        'deepseek-chat',
        'claude-opus',
        'gpt-4',
      ]);
      const selected = reviewer.selectReviewerModel('deepseek-chat', [
        'deepseek-chat',
        'claude-opus',
        'gpt-4',
      ]);
      expect(selected).not.toBe('deepseek-chat');
    });

    it('候选中优先选择 claude（更强模型）', () => {
      const reviewer = new CrossModelReviewer({} as any, 'deepseek-chat', [
        'gpt-4',
        'claude-opus',
      ]);
      const selected = reviewer.selectReviewerModel('deepseek-chat', [
        'gpt-4',
        'claude-opus',
      ]);
      expect(selected).toBe('claude-opus');
    });

    it('陷阱 #142：只有一个模型时回退到同模型', () => {
      const reviewer = new CrossModelReviewer({} as any, 'deepseek-chat', ['deepseek-chat']);
      const selected = reviewer.selectReviewerModel('deepseek-chat', ['deepseek-chat']);
      expect(selected).toBe('deepseek-chat');
    });

    it('空模型列表时回退到内循环模型', () => {
      const reviewer = new CrossModelReviewer({} as any, 'deepseek-chat', []);
      const selected = reviewer.selectReviewerModel('deepseek-chat', []);
      expect(selected).toBe('deepseek-chat');
    });
  });

  // ============================================================
  // review 基本流程
  // ============================================================
  describe('review 基本流程', () => {
    it('返回 CodeReviewResult 结构', async () => {
      const llm = makeMockLLMClient({
        content: JSON.stringify({
          passed: true,
          issues: [],
          summary: '审查通过',
        }),
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成了功能 A',
        goalDescription: '实现功能 A',
      });

      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('tokenUsage');
    });

    it('LLM 被调用一次', async () => {
      const llm = makeMockLLMClient({
        content: '{"passed":true,"issues":[],"summary":"通过"}',
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it('传入正确的 systemPrompt（包含审查维度）', async () => {
      const llm = makeMockLLMClient({
        content: '{"passed":true,"issues":[],"summary":"通过"}',
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      const callArgs = (llm.complete as any).mock.calls[0][0];
      expect(callArgs.systemPrompt).toContain('安全性');
      expect(callArgs.systemPrompt).toContain('性能');
      expect(callArgs.systemPrompt).toContain('可读性');
      expect(callArgs.systemPrompt).toContain('边界条件');
      expect(callArgs.systemPrompt).toContain('错误处理');
    });

    it('传入修改的文件列表和目标描述', async () => {
      const llm = makeMockLLMClient({
        content: '{"passed":true,"issues":[],"summary":"通过"}',
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      await reviewer.review({
        modifiedFiles: ['src/a.ts', 'src/b.ts'],
        executionSummary: '执行摘要 XYZ',
        goalDescription: '目标描述 ABC',
      });
      const callArgs = (llm.complete as any).mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('src/a.ts');
      expect(callArgs.messages[0].content).toContain('src/b.ts');
      expect(callArgs.messages[0].content).toContain('执行摘要 XYZ');
      expect(callArgs.messages[0].content).toContain('目标描述 ABC');
    });
  });

  // ============================================================
  // 解析分级问题
  // ============================================================
  describe('解析分级问题', () => {
    it('正确解析 critical / warning / info 三种严重度', async () => {
      const llm = makeMockLLMClient({
        content: JSON.stringify({
          passed: false,
          issues: [
            { severity: 'critical', file: 'src/a.ts', line: 10, description: '严重' },
            { severity: 'warning', file: 'src/b.ts', line: 20, description: '警告' },
            { severity: 'info', file: 'src/c.ts', description: '建议' },
          ],
          summary: '发现 3 个问题',
        }),
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.issues).toHaveLength(3);
      expect(result.issues[0].severity).toBe('critical');
      expect(result.issues[0].file).toBe('src/a.ts');
      expect(result.issues[0].line).toBe(10);
      expect(result.issues[1].severity).toBe('warning');
      expect(result.issues[2].severity).toBe('info');
      expect(result.issues[2].line).toBeUndefined();
    });

    it('解析 markdown 代码块中的 JSON', async () => {
      const llm = makeMockLLMClient({
        content: '```json\n{"passed":true,"issues":[],"summary":"通过"}\n```',
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.passed).toBe(true);
      expect(result.summary).toBe('通过');
    });

    it('JSON 解析失败时返回保守的"通过"结果', async () => {
      const llm = makeMockLLMClient({
        content: '这不是 JSON 格式的响应',
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.passed).toBe(true); // 不阻断主流程
      expect(result.issues).toEqual([]);
      expect(result.summary).toContain('解析失败');
    });

    it('JSON 解析异常（语法错误）时返回保守的"通过"结果', async () => {
      const llm = makeMockLLMClient({
        content: '{ passed: true, issues: [', // 不完整的 JSON
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.passed).toBe(true);
      expect(result.summary).toContain('解析失败');
    });

    it('缺失 severity 字段时回退到 info', async () => {
      const llm = makeMockLLMClient({
        content: JSON.stringify({
          passed: true,
          issues: [{ file: 'src/a.ts', description: '无 severity' }],
          summary: '通过',
        }),
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.issues[0].severity).toBe('info');
    });

    it('缺失 line 字段时为 undefined', async () => {
      const llm = makeMockLLMClient({
        content: JSON.stringify({
          passed: true,
          issues: [{ severity: 'warning', file: 'src/a.ts', description: '无 line' }],
          summary: '通过',
        }),
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.issues[0].line).toBeUndefined();
    });

    it('缺失 issues 字段时返回空数组', async () => {
      const llm = makeMockLLMClient({
        content: JSON.stringify({ passed: true, summary: '通过' }),
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.issues).toEqual([]);
    });
  });

  // ============================================================
  // 陷阱 #142：LLM 调用失败时回退
  // ============================================================
  describe('陷阱 #142：LLM 调用失败回退', () => {
    it('LLM 抛错时返回保守的"通过"结果，不抛出', async () => {
      const llm = makeMockLLMClient({}, true); // shouldThrow = true
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);

      // 不应抛错
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });

      expect(result.passed).toBe(true); // 不阻断主流程
      expect(result.issues).toEqual([]);
      expect(result.summary).toContain('审查失败');
      expect(result.tokenUsage.totalTokens).toBe(0);
    });

    it('同模型审查时 summary 标注"未跨模型"', async () => {
      // 只有一个可用模型（同模型回退）
      const llm = makeMockLLMClient({
        content: JSON.stringify({ passed: true, issues: [], summary: '通过' }),
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['deepseek-chat']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.summary).toContain('未跨模型');
    });

    it('真正跨模型时 summary 不标注"未跨模型"', async () => {
      const llm = makeMockLLMClient({
        content: JSON.stringify({ passed: true, issues: [], summary: '通过' }),
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.summary).not.toContain('未跨模型');
    });
  });

  // ============================================================
  // token 用量记录
  // ============================================================
  describe('token 用量', () => {
    it('返回的 tokenUsage 来自 LLM 响应', async () => {
      const llm = makeMockLLMClient({
        content: '{"passed":true,"issues":[],"summary":"通过"}',
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      });
      const reviewer = new CrossModelReviewer(llm, 'deepseek-chat', ['claude-opus']);
      const result = await reviewer.review({
        modifiedFiles: ['src/a.ts'],
        executionSummary: '完成',
        goalDescription: '目标',
      });
      expect(result.tokenUsage.inputTokens).toBe(200);
      expect(result.tokenUsage.outputTokens).toBe(100);
      expect(result.tokenUsage.totalTokens).toBe(300);
    });
  });
});
