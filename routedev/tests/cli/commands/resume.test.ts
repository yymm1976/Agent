// tests/cli/commands/resume.test.ts
// /resume 命令测试（Phase 27 Task 6）
// 测试 resumeCommand 的列表、恢复、错误处理逻辑

import { describe, it, expect, vi } from 'vitest';
import { resumeCommand } from '../../../src/cli/commands/resume.js';
import {
  formatSnapshotLine,
  formatSnapshotTime,
  renderSnapshotListText,
} from '../../../src/cli/components/ResumePicker.js';
import type { ExecutionSnapshot } from '../../../src/agent/durable-executor.js';
import type { ServiceContext } from '../../../src/cli/service-context.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建测试用快照 */
function makeSnapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    planId: 'plan-test-001',
    goal: '实现用户登录功能',
    startedAt: Date.now() - 60000,
    lastStepCompleted: 2,
    totalSteps: 5,
    status: 'paused',
    completedResults: [],
    nextStep: null,
    updatedAt: Date.now() - 30000,
    ...overrides,
  };
}

/** 创建 mock ServiceContext（仅包含 resume 命令所需字段） */
function makeMockCtx(snapshots: ExecutionSnapshot[], resumeResult?: { success: boolean; error?: string }): Partial<ServiceContext> {
  const systemMessages: string[] = [];
  return {
    durableExecutor: {
      listRecoverableAsync: vi.fn(async () => snapshots),
      resumeFrom: vi.fn(async (_planId: string) => ({
        success: resumeResult?.success ?? true,
        snapshot: snapshots[0] ?? makeSnapshot(),
        error: resumeResult?.error,
      })),
    } as never,
    commandBridge: {
      addSystemMessage: vi.fn((content: string) => { systemMessages.push(content); }),
    } as never,
  } as Partial<ServiceContext>;
}

// ============================================================
// 测试用例
// ============================================================

describe('resumeCommand: 基本属性', () => {
  it('命令名为 resume', () => {
    expect(resumeCommand.name).toBe('resume');
  });

  it('有描述和用法', () => {
    expect(resumeCommand.description).toBeTruthy();
    expect(resumeCommand.usage).toContain('resume');
  });
});

describe('resumeCommand: 无可恢复执行', () => {
  it('空列表返回友好提示', async () => {
    const ctx = makeMockCtx([]);
    const result = await resumeCommand.handler('', ctx as ServiceContext);
    expect(result.type).toBe('handled');
    if (result.type === 'handled' && result.messages) {
      expect(result.messages[0]).toContain('无可恢复');
    }
  });
});

describe('resumeCommand: 列表模式', () => {
  it('显示可恢复列表', async () => {
    const snapshots = [
      makeSnapshot({ planId: 'plan-001', goal: '任务A' }),
      makeSnapshot({ planId: 'plan-002', goal: '任务B', status: 'failed' }),
    ];
    const ctx = makeMockCtx(snapshots);
    const result = await resumeCommand.handler('', ctx as ServiceContext);
    expect(result.type).toBe('handled');
    if (result.type === 'handled' && result.messages) {
      const text = result.messages[0];
      expect(text).toContain('plan-001');
      expect(text).toContain('plan-002');
      expect(text).toContain('可恢复的执行 (2)');
    }
  });
});

describe('resumeCommand: 指定 planId 恢复', () => {
  it('恢复成功返回成功消息', async () => {
    const snapshots = [makeSnapshot({ planId: 'plan-001' })];
    const ctx = makeMockCtx(snapshots, { success: true });
    const result = await resumeCommand.handler('plan-001', ctx as ServiceContext);
    expect(result.type).toBe('handled');
    if (result.type === 'handled' && result.messages) {
      expect(result.messages[0]).toContain('恢复成功');
    }
  });

  it('未找到 planId 返回错误', async () => {
    const snapshots = [makeSnapshot({ planId: 'plan-001' })];
    const ctx = makeMockCtx(snapshots);
    const result = await resumeCommand.handler('plan-not-exist', ctx as ServiceContext);
    expect(result.type).toBe('handled');
    if (result.type === 'handled' && result.messages) {
      expect(result.messages[0]).toContain('未找到');
    }
  });

  it('恢复失败返回错误消息', async () => {
    const snapshots = [makeSnapshot({ planId: 'plan-001' })];
    const ctx = makeMockCtx(snapshots, { success: false, error: '快照损坏' });
    const result = await resumeCommand.handler('plan-001', ctx as ServiceContext);
    expect(result.type).toBe('handled');
    if (result.type === 'handled' && result.messages) {
      expect(result.messages[0]).toContain('恢复失败');
      expect(result.messages[0]).toContain('快照损坏');
    }
  });
});

describe('resumeCommand: DurableExecutor 不可用', () => {
  it('无 durableExecutor 时返回错误', async () => {
    const ctx = { commandBridge: { addSystemMessage: vi.fn() } } as unknown as ServiceContext;
    const result = await resumeCommand.handler('', ctx);
    expect(result.type).toBe('handled');
    if (result.type === 'handled' && result.messages) {
      expect(result.messages[0]).toContain('不可用');
    }
  });
});

// ============================================================
// ResumePicker 辅助函数测试
// ============================================================

describe('ResumePicker: formatSnapshotTime', () => {
  it('格式化时间戳为本地时间字符串', () => {
    const ts = new Date('2025-01-15T10:30:00Z').getTime();
    const result = formatSnapshotTime(ts);
    expect(result).toMatch(/2025/);
  });
});

describe('ResumePicker: formatSnapshotLine', () => {
  it('格式化暂停状态的快照', () => {
    const snapshot = makeSnapshot({ status: 'paused', planId: 'plan-001', goal: '测试目标' });
    const line = formatSnapshotLine(snapshot, 0);
    expect(line).toContain('plan-001');
    expect(line).toContain('暂停');
    expect(line).toContain('2/5');
    expect(line).toContain('测试目标');
  });

  it('格式化失败状态的快照', () => {
    const snapshot = makeSnapshot({ status: 'failed', planId: 'plan-002', goal: '失败任务' });
    const line = formatSnapshotLine(snapshot, 1);
    expect(line).toContain('plan-002');
    expect(line).toContain('失败');
    expect(line).toContain('2. ');
  });
});

describe('ResumePicker: renderSnapshotListText', () => {
  it('空列表返回友好提示', () => {
    const text = renderSnapshotListText([]);
    expect(text).toContain('无可恢复');
  });

  it('非空列表包含头部、快照行和提示', () => {
    const snapshots = [
      makeSnapshot({ planId: 'plan-001' }),
      makeSnapshot({ planId: 'plan-002', status: 'failed' }),
    ];
    const text = renderSnapshotListText(snapshots);
    expect(text).toContain('可恢复的执行 (2)');
    expect(text).toContain('plan-001');
    expect(text).toContain('plan-002');
    expect(text).toContain('/resume <planId>');
  });
});
