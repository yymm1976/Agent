// tests/runtime/automation-scheduler.test.ts
// Phase 97 Part F：自动化调度器——cron 匹配 / 版本迁移 / 白名单 / 运行历史

import { describe, it, expect, vi } from 'vitest';
import {
  AutomationScheduler,
  cronMatches,
  migrateAutomationTasks,
  isAllowedByAllowlist,
} from '../../src/runtime/automation-scheduler.js';
import {
  buildSuggestion,
  SuggestionApprovalQueue,
  EVALUATION_INTERVAL,
  MIN_FAILURES_FOR_SUGGESTION,
} from '../../src/runtime/automation-evolution.js';

describe('cronMatches（标准 5 段 cron 匹配）', () => {
  const date = new Date(2026, 7, 1, 9, 30); // 2026-08-01 09:30，周六

  it('* * * * * 每分钟都匹配', () => {
    expect(cronMatches('* * * * *', date)).toBe(true);
  });

  it('分/时精确匹配', () => {
    expect(cronMatches('30 9 * * *', date)).toBe(true);
    expect(cronMatches('0 9 * * *', date)).toBe(false);
  });

  it('逗号列表与步进', () => {
    expect(cronMatches('0,30 9 * * *', date)).toBe(true);
    expect(cronMatches('*/15 9 * * *', date)).toBe(true);
    expect(cronMatches('*/20 9 * * *', date)).toBe(false); // 30 % 20 = 10
  });

  it('非法 cron（段数不对）返回 false', () => {
    expect(cronMatches('0 9 * *', date)).toBe(false);
  });
});

describe('migrateAutomationTasks（配置版本迁移）', () => {
  it('v1 旧配置补全新字段默认值', () => {
    const migrated = migrateAutomationTasks([
      { id: 't1', name: '晨报', cron: '0 9 * * *', prompt: '生成日报' },
    ]);
    expect(migrated.length).toBe(1);
    expect(migrated[0]!.version).toBe(1);
    expect(migrated[0]!.allowlist).toEqual([]);
    expect(migrated[0]!.permissionMode).toBe('manual');
  });

  it('非法条目被过滤，非法 cron 回退默认', () => {
    const migrated = migrateAutomationTasks([
      { id: 't2', name: '坏 cron', cron: 'bad', prompt: 'x' },
      'not-object',
      null,
    ]);
    expect(migrated.length).toBe(1);
    expect(migrated[0]!.cron).toBe('0 9 * * *');
  });

  it('磁盘高版本不被覆盖（保留原 allowlist）', () => {
    const migrated = migrateAutomationTasks([
      { id: 't3', name: 'v2', cron: '0 8 * * 1-5', prompt: 'x', version: 2, allowlist: ['read:src/'], permissionMode: 'auto' },
    ]);
    expect(migrated[0]!.version).toBe(2);
    expect(migrated[0]!.allowlist).toEqual(['read:src/']);
    expect(migrated[0]!.permissionMode).toBe('auto');
  });
});

describe('isAllowedByAllowlist（权限白名单）', () => {
  it('空白名单 = 无预授权', () => {
    expect(isAllowedByAllowlist([], 'read:src/a.ts')).toBe(false);
  });
  it('精确匹配与前缀匹配', () => {
    expect(isAllowedByAllowlist(['read:src/'], 'read:src/a.ts')).toBe(true);
    expect(isAllowedByAllowlist(['read:src/'], 'read:lib/b.ts')).toBe(false);
    expect(isAllowedByAllowlist(['tool:file_read'], 'tool:file_read')).toBe(true);
  });
  it('删除/发布类操作不在白名单时拒绝', () => {
    expect(isAllowedByAllowlist(['read:src/'], 'run:git-push')).toBe(false);
  });
});

describe('AutomationScheduler（调度执行与历史）', () => {
  it('tick 触发匹配任务并记录历史；同分钟不重复', async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const scheduler = new AutomationScheduler(
      [{ id: 'a', name: 'A', cron: '* * * * *', permissionMode: 'semi', allowlist: [], prompt: 'p', version: 1 }],
    );
    scheduler.setExecutor(executor);
    const now = new Date(2026, 7, 1, 9, 30);
    await scheduler.tick(now);
    await scheduler.tick(now); // 同分钟第二次应跳过
    expect(executor).toHaveBeenCalledTimes(1);

    const history = scheduler.getHistory('a');
    expect(history.length).toBe(1);
    expect(history[0]!.ok).toBe(true);
    scheduler.stop();
  });

  it('不匹配的任务不执行', async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const scheduler = new AutomationScheduler(
      [{ id: 'b', name: 'B', cron: '0 0 * * *', permissionMode: 'semi', allowlist: [], prompt: 'p', version: 1 }],
    );
    scheduler.setExecutor(executor);
    await scheduler.tick(new Date(2026, 7, 1, 9, 30));
    expect(executor).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('执行失败记录历史且不抛出', async () => {
    const executor = vi.fn(async () => ({ ok: false, error: '模型不可用' }));
    const scheduler = new AutomationScheduler(
      [{ id: 'c', name: 'C', cron: '* * * * *', permissionMode: 'semi', allowlist: [], prompt: 'p', version: 1 }],
    );
    scheduler.setExecutor(executor);
    await scheduler.tick(new Date(2026, 7, 1, 9, 30));
    const history = scheduler.getHistory('c');
    expect(history[0]!.ok).toBe(false);
    expect(history[0]!.error).toBe('模型不可用');
    scheduler.stop();
  });

  it('无 executor 时 start 不启动 timer', () => {
    const scheduler = new AutomationScheduler([]);
    scheduler.start(); // 不应抛错
    scheduler.stop();
  });
});

describe('buildSuggestion + SuggestionApprovalQueue（自我迭代建议）', () => {
  const baseHistory = (taskId: string, okList: boolean[]): Parameters<typeof buildSuggestion>[1] =>
    okList.map((ok, i) => ({
      taskId,
      ok,
      error: ok ? undefined : `失败原因 ${i}`,
      durationMs: 100,
      timestamp: Date.now() + i,
    }));

  it('失败不足阈值时返回 null', () => {
    const history = baseHistory('t', [true, true, true, true, false]);
    expect(buildSuggestion('t', history, '原 prompt')).toBeNull();
  });

  it('连续失败达到阈值时生成修订建议', () => {
    const history = baseHistory('t', [false, false, false, false, false]);
    const suggestion = buildSuggestion('t', history, '原 prompt');
    expect(suggestion).not.toBeNull();
    expect(suggestion!.failurePatterns.length).toBeGreaterThan(0);
    expect(suggestion!.suggestedPrompt).toContain('修订指引');
    expect(suggestion!.suggestedPrompt).toContain('原 prompt');
  });

  it('建议经审批后才生效（默认 pending，不自动应用）', () => {
    const queue = new SuggestionApprovalQueue();
    queue.submit({ taskId: 't', failurePatterns: ['x'], suggestedPrompt: 'new', createdAt: Date.now() });
    expect(queue.isApproved('t')).toBe(false);
    const approved = queue.approve('t');
    expect(approved).not.toBeNull();
    expect(queue.isApproved('t')).toBe(true);
    expect(queue.listPending().length).toBe(0);
  });

  it('拒绝建议后不再出现在待审批列表', () => {
    const queue = new SuggestionApprovalQueue();
    queue.submit({ taskId: 't', failurePatterns: ['x'], suggestedPrompt: 'new', createdAt: Date.now() });
    expect(queue.reject('t')).toBe(true);
    expect(queue.listPending().length).toBe(0);
    expect(queue.approve('t')).toBeNull();
  });

  it('导出阈值常量供配置引用（防魔法数）', () => {
    expect(EVALUATION_INTERVAL).toBe(5);
    expect(MIN_FAILURES_FOR_SUGGESTION).toBe(3);
  });
});

describe('AutomationScheduler × automation-evolution（反馈闭环与建议审批）', () => {
  const makeTask = (id: string, prompt = '原 prompt') => ({
    id,
    name: id.toUpperCase(),
    cron: '* * * * *',
    permissionMode: 'semi' as const,
    allowlist: [] as string[],
    prompt,
    version: 1,
  });

  /** 同一小时内的 5 个不同分钟 tick（避开同分钟去重） */
  const runTicks = async (scheduler: AutomationScheduler, hour: number) => {
    for (let i = 0; i < 5; i++) {
      await scheduler.tick(new Date(2026, 7, 1, hour, i));
    }
  };

  it('5 次失败 → 1 条待审批建议，任务 prompt 不被自动修改', async () => {
    const executor = vi.fn(async () => ({ ok: false, error: '模型不可用' }));
    const scheduler = new AutomationScheduler([makeTask('ev1')]);
    scheduler.setExecutor(executor);
    await runTicks(scheduler, 9);
    expect(executor).toHaveBeenCalledTimes(5);

    const pending = scheduler.listPendingSuggestions();
    expect(pending.length).toBe(1);
    expect(pending[0]!.taskId).toBe('ev1');
    expect(pending[0]!.failurePatterns).toEqual(['模型不可用']);
    expect(pending[0]!.suggestedPrompt).toContain('原 prompt');
    // 建议不自动应用：任务 prompt 保持原样
    expect(scheduler.listTasks()[0]!.prompt).toBe('原 prompt');
    scheduler.stop();
  });

  it('5 次成功 → 无待审批建议', async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const scheduler = new AutomationScheduler([makeTask('ev2')]);
    scheduler.setExecutor(executor);
    await runTicks(scheduler, 9);
    expect(scheduler.listPendingSuggestions().length).toBe(0);
    scheduler.stop();
  });

  it('approveSuggestion 返回被批准的建议并清空待审批', async () => {
    const executor = vi.fn(async () => ({ ok: false, error: 'x' }));
    const scheduler = new AutomationScheduler([makeTask('ev3')]);
    scheduler.setExecutor(executor);
    await runTicks(scheduler, 9);
    expect(scheduler.listPendingSuggestions().length).toBe(1);

    const approved = scheduler.approveSuggestion('ev3');
    expect(approved).not.toBeNull();
    expect(approved!.taskId).toBe('ev3');
    expect(scheduler.listPendingSuggestions().length).toBe(0);
    scheduler.stop();
  });

  it('rejectSuggestion 清空待审批，已拒绝的建议不可再批准', async () => {
    const executor = vi.fn(async () => ({ ok: false, error: 'x' }));
    const scheduler = new AutomationScheduler([makeTask('ev4')]);
    scheduler.setExecutor(executor);
    await runTicks(scheduler, 9);
    expect(scheduler.listPendingSuggestions().length).toBe(1);

    expect(scheduler.rejectSuggestion('ev4')).toBe(true);
    expect(scheduler.listPendingSuggestions().length).toBe(0);
    expect(scheduler.approveSuggestion('ev4')).toBeNull();
    scheduler.stop();
  });

  it('executor 抛异常计入失败反馈，5 次后生成建议且不抛出', async () => {
    const executor = vi.fn(async () => {
      throw new Error('执行器崩溃');
    });
    const scheduler = new AutomationScheduler([makeTask('ev5')]);
    scheduler.setExecutor(executor);
    await runTicks(scheduler, 9);

    const history = scheduler.getHistory('ev5');
    expect(history.length).toBe(5);
    expect(history.every((h) => !h.ok)).toBe(true);
    const pending = scheduler.listPendingSuggestions();
    expect(pending.length).toBe(1);
    expect(pending[0]!.failurePatterns).toEqual(['执行器崩溃']);
    scheduler.stop();
  });

  it('approve 后反馈重置，新一轮失败可重新入队建议', async () => {
    const executor = vi.fn(async () => ({ ok: false, error: '原因A' }));
    const scheduler = new AutomationScheduler([makeTask('ev6')]);
    scheduler.setExecutor(executor);
    await runTicks(scheduler, 9);
    expect(scheduler.listPendingSuggestions().length).toBe(1);

    expect(scheduler.approveSuggestion('ev6')).not.toBeNull();
    expect(scheduler.listPendingSuggestions().length).toBe(0);

    // 第二轮 5 次失败（不同小时/分钟，避开同分钟去重）→ 重新入队
    await runTicks(scheduler, 10);
    const pending = scheduler.listPendingSuggestions();
    expect(pending.length).toBe(1);
    expect(pending[0]!.taskId).toBe('ev6');
    expect(pending[0]!.failurePatterns).toEqual(['原因A']);
    scheduler.stop();
  });
});
