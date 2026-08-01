// tests/desktop/agent-status-service.test.ts
// Phase 97 Part H：常驻 Agent Island 状态聚合服务
// 覆盖：upsert/mark 系列、中断队列聚合、子会话聚合、持久化/恢复、fail-open

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentStatusService,
  defaultAgentStatusPath,
  type AgentStatusInterruptionSource,
  type AgentStatusSubagentSource,
} from '../../desktop/main/agent-status-service.js';

/** 构造测试用子会话数据源 */
function makeSubagentSource(records: Array<{ childSessionId: string; status: string; description: string; createdAt: number }>): AgentStatusSubagentSource {
  return { list: () => records };
}

/** 构造测试用中断数据源 */
function makeInterruptionSource(records: Array<{ sessionId: string; status: string }>): AgentStatusInterruptionSource {
  return { list: () => records };
}

describe('AgentStatusService 更新 API', () => {
  it('markRunning 创建 running 记录', () => {
    const svc = new AgentStatusService();
    svc.markRunning('s1', '测试任务');
    const snapshot = svc.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({ sessionId: 's1', status: 'running', title: '测试任务' });
  });

  it('markCompleted 覆盖状态', () => {
    const svc = new AgentStatusService();
    svc.markRunning('s1');
    svc.markCompleted('s1');
    expect(svc.getSnapshot().sessions[0].status).toBe('completed');
  });

  it('markError 记录错误信息', () => {
    const svc = new AgentStatusService();
    svc.markError('s1', 'LLM 调用失败');
    const record = svc.getSnapshot().sessions[0];
    expect(record.status).toBe('error');
    expect(record.error).toBe('LLM 调用失败');
  });

  it('markInterruption 设置 waiting_interruption 与计数', () => {
    const svc = new AgentStatusService();
    svc.markRunning('s1');
    svc.markInterruption('s1', 2);
    const record = svc.getSnapshot().sessions[0];
    expect(record.status).toBe('waiting_interruption');
    expect(record.interruptionCount).toBe(2);
  });

  it('markInterruption(0) 恢复原状态', () => {
    const svc = new AgentStatusService();
    svc.markRunning('s1');
    svc.markInterruption('s1', 1);
    svc.markInterruption('s1', 0);
    expect(svc.getSnapshot().sessions[0].status).toBe('running');
  });

  it('remove 删除记录', () => {
    const svc = new AgentStatusService();
    svc.markRunning('s1');
    svc.remove('s1');
    expect(svc.getSnapshot().sessions).toEqual([]);
  });
});

describe('AgentStatusService 数据源聚合', () => {
  it('中断队列 pending 覆盖为 waiting_interruption', () => {
    const svc = new AgentStatusService({
      interruption: makeInterruptionSource([
        { sessionId: 's1', status: 'pending' },
        { sessionId: 's1', status: 'pending' },
        { sessionId: 's2', status: 'resolved' }, // 非 pending 忽略
      ]),
    });
    svc.markRunning('s1');
    const record = svc.getSnapshot().sessions.find((r) => r.sessionId === 's1')!;
    expect(record.status).toBe('waiting_interruption');
    expect(record.interruptionCount).toBe(2);
  });

  it('running 子会话补充为独立记录', () => {
    const svc = new AgentStatusService({
      subagent: makeSubagentSource([
        { childSessionId: 'sub-1', status: 'running', description: '调研 Proma', createdAt: 100 },
        { childSessionId: 'sub-2', status: 'completed', description: '已结束', createdAt: 200 },
      ]),
    });
    const sessions = svc.getSnapshot().sessions;
    expect(sessions).toHaveLength(1); // 只有 running 子会话
    expect(sessions[0]).toMatchObject({ sessionId: 'sub-1', status: 'running', title: '调研 Proma' });
  });

  it('快照按 startedAt 降序排序', () => {
    const svc = new AgentStatusService();
    svc.upsert('old', { startedAt: 100 });
    svc.upsert('new', { startedAt: 200 });
    const sessions = svc.getSnapshot().sessions;
    expect(sessions[0].sessionId).toBe('new');
    expect(sessions[1].sessionId).toBe('old');
  });

  it('数据源抛错时 fail-open 返回内存记录', () => {
    const svc = new AgentStatusService({
      interruption: { list: () => { throw new Error('boom'); } },
    });
    svc.markRunning('s1');
    expect(svc.getSnapshot().sessions[0].status).toBe('running');
  });
});

describe('AgentStatusService 持久化', () => {
  it('persist 后 restore 重建终态记录（running 除外）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'));
    const persistPath = path.join(dir, 'agent-status.json');
    try {
      const svc = new AgentStatusService(undefined, { persistPath });
      svc.markRunning('s1', '运行中');
      svc.markCompleted('s2', '已完成');
      svc.markError('s3', '出错', '失败任务');
      svc.persist();

      // 新实例从快照恢复
      const restored = new AgentStatusService(undefined, { persistPath });
      const snapshot = restored.restore();
      const ids = snapshot.sessions.map((r) => r.sessionId);
      expect(ids).toContain('s2');
      expect(ids).toContain('s3');
      expect(ids).not.toContain('s1'); // running 不恢复
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在时 restore 返回空快照', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'));
    try {
      const svc = new AgentStatusService(undefined, { persistPath: path.join(dir, 'nope.json') });
      expect(svc.restore().sessions).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏文件 restore fail-open 返回空快照', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'));
    const persistPath = path.join(dir, 'agent-status.json');
    try {
      fs.writeFileSync(persistPath, '{ not json', 'utf-8');
      const svc = new AgentStatusService(undefined, { persistPath });
      expect(svc.restore().sessions).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultAgentStatusPath', () => {
  it('构造 <cwd>/.routedev/agent-status.json', () => {
    expect(defaultAgentStatusPath('/tmp/proj')).toBe(path.join('/tmp/proj', '.routedev', 'agent-status.json'));
  });
});
