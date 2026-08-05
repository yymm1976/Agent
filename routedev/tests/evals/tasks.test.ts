// tests/evals/tasks.test.ts
// B-00：任务定义与聚合的单元测试
// 重点：验证 fixture 在修复前确实处于失败态（红态），防止"测了个寂寞"。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_TASKS, type EvalTask } from './tasks.js';
import { aggregateResults, summaryToMarkdown, type EvalEntry } from './summarize.js';
import { copyDirSync } from './fs-utils.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function materialize(task: EvalTask): string {
  const ws = mkdtempSync(join(tmpdir(), 'routedev-eval-test-'));
  copyDirSync(join(FIXTURES, task.fixtureDir), ws);
  return ws;
}

describe('B-00 任务定义', () => {
  it('恰好 12 个任务且 id 唯一', () => {
    expect(EVAL_TASKS).toHaveLength(12);
    const ids = EVAL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(12);
  });

  it('任务字段完整：category/prompt/fixtureDir/taskShape 合法', () => {
    const categories = EVAL_TASKS.map((t) => t.category);
    expect(categories).toEqual(expect.arrayContaining([
      'readonly-locate', 'fix-single', 'fix-multi', 'test-debug', 'permission-deny', 'subagent-explore',
    ]));
    const counts = (c: string) => categories.filter((x) => x === c).length;
    expect(counts('readonly-locate')).toBe(2);
    expect(counts('fix-single')).toBe(4);
    expect(counts('fix-multi')).toBe(2);
    expect(counts('test-debug')).toBe(2);
    expect(counts('permission-deny')).toBe(1);
    expect(counts('subagent-explore')).toBe(1);
    for (const t of EVAL_TASKS) {
      expect(t.prompt.length).toBeGreaterThan(10);
      expect(existsSync(join(FIXTURES, t.fixtureDir))).toBe(true);
      expect(['single-step', 'multi-step-impl', 'investigation', 'qa']).toContain(t.taskShape);
    }
  });

  it('8 个修复/诊断任务在修复前必须处于失败态（红态 fixture）', async () => {
    const fixers = EVAL_TASKS.filter((t) => t.category === 'fix-single' || t.category === 'fix-multi' || t.category === 'test-debug');
    expect(fixers).toHaveLength(8);
    for (const task of fixers) {
      const ws = materialize(task);
      try {
        const result = await task.checkWorkspace(ws);
        expect(result.passed, `${task.id} 修复前应失败，实际通过: ${result.detail}`).toBe(false);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
  });

  it('权限拒绝任务：文件存在性校验在文件存在时为通过', async () => {
    const task = EVAL_TASKS.find((t) => t.id === 'permission-deny-1')!;
    const ws = materialize(task);
    try {
      const result = await task.checkWorkspace(ws);
      expect(result.passed).toBe(true);
      expect(task.denyTool?.tool).toBe('shell_exec');
      expect(task.denyTool!.match({ command: 'rm -rf notes' })).toBe(true);
      expect(task.denyTool!.match({ command: 'ls -la' })).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('子代理任务要求 spawn_agent 工具调用', () => {
    const task = EVAL_TASKS.find((t) => t.id === 'subagent-explore-1')!;
    expect(task.requiresToolCall).toBe('spawn_agent');
    expect(task.answerKeywordsAll).toEqual(['toTitleCase', 'today']);
  });
});

describe('B-00 聚合', () => {
  function entry(overrides: Partial<EvalEntry>): EvalEntry {
    return {
      taskId: 'x', name: 'x', category: 'fix-single', completed: true, passed: true,
      toolCalls: 4, invalidToolCalls: 1, turns: 3, inputTokens: 1000, outputTokens: 200,
      totalTokens: 1200, toolSchemaTokens: 800, toolCount: 20, durationMs: 5000,
      ...overrides,
    };
  }

  it('空列表返回全零', () => {
    const s = aggregateResults([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.avgToolCalls).toBe(0);
  });

  it('通过率/平均/无效率按完成条目计算', () => {
    const entries = [
      entry({ taskId: 'a', passed: true, toolCalls: 4, invalidToolCalls: 1, turns: 3, inputTokens: 1000, toolSchemaTokens: 800 }),
      entry({ taskId: 'b', passed: false, toolCalls: 8, invalidToolCalls: 2, turns: 6, inputTokens: 3000, toolSchemaTokens: 1200, failStage: 'checkWorkspace' }),
      entry({ taskId: 'c', completed: false, error: 'env-blocked: DEEPSEEK_API_KEY 未配置' }),
    ];
    const s = aggregateResults(entries);
    expect(s.total).toBe(3);
    expect(s.completed).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.passRate).toBe(0.5);
    expect(s.avgToolCalls).toBe(6);
    expect(s.avgInvalidToolCalls).toBe(1.5);
    expect(s.invalidRate).toBe(0.3); // (1+2)/(4+8)=0.25，round1 半入到 0.3（Math.round(2.5)=3）
    expect(s.avgInputTokens).toBe(2000);
    expect(s.avgToolSchemaTokens).toBe(1000);
    expect(s.blocked).toEqual([{ taskId: 'c', reason: 'env-blocked: DEEPSEEK_API_KEY 未配置' }]);
    expect(s.byCategory['fix-single']).toEqual({ total: 3, completed: 2, passed: 1, passRate: 0.5 });
  });

  it('summaryToMarkdown 输出包含关键指标', () => {
    const md = summaryToMarkdown(aggregateResults([entry({})]));
    expect(md).toContain('完成率');
    expect(md).toContain('平均工具调用');
    expect(md).toContain('工具 schema token');
  });
});

describe('B-02B 提示变体与 A/B 对比', () => {
  it('compact 变体可渲染且字符数比主模板低至少 15%（代理指标）', async () => {
    const { PromptTemplateManager, promptStats } = await import('../../src/prompts/manager.js');
    const manager = new PromptTemplateManager();
    const context = {
      language: '中文',
      autonomyMode: 'auto',
      availableTools: '- 文件读写：file_read, file_write\n- 命令执行：shell_exec',
      projectRules: '规则',
      projectMemory: '记忆',
      cwd: '/tmp/x',
      taskShape: 'multi-step-impl',
      userProfile: '',
    };
    const full = await manager.render('main.system', context);
    const compact = await manager.render('main.system.compact', context);
    expect(compact.length).toBeGreaterThan(300);
    const ratio = compact.length / full.length;
    expect(ratio).toBeLessThan(0.85);
    expect(compact).toContain('你是 RouteDev');
    expect(compact).toContain('<verification>');
    expect(compact).toContain('<modification_protection>');
    const stats = promptStats(compact);
    expect(stats.tokens).toBeGreaterThan(0);
  });

  it('compareSummaries：完成率下降时给出撤回提示', async () => {
    const { compareSummaries } = await import('./summarize.js');
    const { aggregateResults } = await import('./summarize.js');
    const base = (pass: boolean): EvalEntry[] => [
      { taskId: 'a', name: 'a', category: 'fix-single', completed: true, passed: pass,
        toolCalls: 2, invalidToolCalls: 0, turns: 2, inputTokens: 1000, outputTokens: 100,
        totalTokens: 1100, toolSchemaTokens: 500, toolCount: 10, durationMs: 1000 },
      { taskId: 'b', name: 'b', category: 'fix-single', completed: true, passed: true,
        toolCalls: 2, invalidToolCalls: 0, turns: 2, inputTokens: 1000, outputTokens: 100,
        totalTokens: 1100, toolSchemaTokens: 500, toolCount: 10, durationMs: 1000 },
    ];
    const baseline = aggregateResults(base(true));
    const degraded = aggregateResults(base(false)); // 完成率 1.0 → 0.5
    const lines = compareSummaries(baseline, degraded);
    expect(lines.some((l) => l.includes('完成率下降'))).toBe(true);
    expect(lines.some((l) => l.includes('撤回'))).toBe(true);
  });

  it('compareSummaries：token 下降达标时无退化提示', async () => {
    const { compareSummaries, aggregateResults } = await import('./summarize.js');
    const mk = (inputTokens: number): EvalEntry[] => [
      { taskId: 'a', name: 'a', category: 'fix-single', completed: true, passed: true,
        toolCalls: 2, invalidToolCalls: 0, turns: 2, inputTokens, outputTokens: 100,
        totalTokens: inputTokens + 100, toolSchemaTokens: 500, toolCount: 10, durationMs: 1000 },
    ];
    const lines = compareSummaries(aggregateResults(mk(2000)), aggregateResults(mk(1400))); // -30%
    expect(lines.some((l) => l.includes('完成率下降'))).toBe(false);
    expect(lines.some((l) => l.includes('token 下降达标'))).toBe(true);
  });

  it('compareSummaries：环境阻塞时不可比', async () => {
    const { compareSummaries, aggregateResults } = await import('./summarize.js');
    const blocked = aggregateResults([]);
    const lines = compareSummaries(blocked, blocked);
    expect(lines.some((l) => l.includes('不可比'))).toBe(true);
  });
});
