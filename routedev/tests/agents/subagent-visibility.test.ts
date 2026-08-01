// tests/agents/subagent-visibility.test.ts
// Phase 97 Part E：子会话可见性——登记/查询/停止 + SpawnResult 携带 childSessionId

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubagentRegistry } from '../../src/agents/subagent-registry.js';

describe('subagent-registry（子会话可见性）', () => {
  let registry: SubagentRegistry;

  beforeEach(() => {
    registry = new SubagentRegistry();
  });

  it('register 返回 AbortController 并可查询记录', () => {
    const controller = registry.register({
      childSessionId: 'sub-1',
      parentSessionId: 'parent-a',
      description: '研究 X 库',
      subagentType: 'researcher',
      status: 'running',
    });
    expect(controller.signal.aborted).toBe(false);

    const rec = registry.get('sub-1');
    expect(rec).toBeDefined();
    expect(rec?.status).toBe('running');
    expect(rec?.parentSessionId).toBe('parent-a');
  });

  it('update 更新状态并写入完成时间', () => {
    registry.register({
      childSessionId: 'sub-2',
      description: '写测试',
      subagentType: 'coder',
      status: 'running',
    });
    registry.update('sub-2', {
      status: 'completed',
      result: '完成',
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    });

    const rec = registry.get('sub-2');
    expect(rec?.status).toBe('completed');
    expect(rec?.result).toBe('完成');
    expect(rec?.completedAt).toBeDefined();
    expect(rec?.tokenUsage?.outputTokens).toBe(5);
  });

  it('list 支持按父会话过滤并按创建时间倒序', () => {
    registry.register({ childSessionId: 'a', parentSessionId: 'p1', description: '1', subagentType: 'general', status: 'running', createdAt: 100 });
    registry.register({ childSessionId: 'b', parentSessionId: 'p1', description: '2', subagentType: 'general', status: 'running', createdAt: 200 });
    registry.register({ childSessionId: 'c', parentSessionId: 'p2', description: '3', subagentType: 'general', status: 'running', createdAt: 150 });

    const all = registry.list();
    expect(all.map((r) => r.childSessionId)).toEqual(['b', 'c', 'a']);

    const p1 = registry.list('p1');
    expect(p1.map((r) => r.childSessionId)).toEqual(['b', 'a']);
  });

  it('stop 中止运行中的子会话并标记 aborted', () => {
    registry.register({ childSessionId: 'sub-3', description: '运行中', subagentType: 'reviewer', status: 'running' });
    const ok = registry.stop('sub-3');
    expect(ok).toBe(true);
    const rec = registry.get('sub-3');
    expect(rec?.status).toBe('aborted');
    expect(rec?.completedAt).toBeDefined();
    // 已停止的会话再次 stop 返回 false
    expect(registry.stop('sub-3')).toBe(false);
  });

  it('未登记或已完成的会话 stop 返回 false', () => {
    expect(registry.stop('not-exist')).toBe(false);
    registry.register({ childSessionId: 'done', description: '已完成', subagentType: 'general', status: 'running' });
    registry.update('done', { status: 'completed' });
    expect(registry.stop('done')).toBe(false);
  });

  it('register 允许注入 createdAt（会话恢复重建场景）', () => {
    registry.register({
      childSessionId: 'sub-4',
      description: '恢复的会话',
      subagentType: 'planner',
      status: 'completed',
      result: '历史结果',
      createdAt: 12345,
      completedAt: 12346,
    });
    const rec = registry.get('sub-4');
    expect(rec?.createdAt).toBe(12345);
    expect(rec?.completedAt).toBe(12346);
    // 恢复历史会话仍可查询子任务结果
    expect(rec?.result).toBe('历史结果');
  });
});
