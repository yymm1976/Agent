// tests/agents/delegation-ceiling.test.ts
// Phase 97 Part E：权限天花板——执行期强制校验 + 批量等待完成语义

import { describe, it, expect, vi } from 'vitest';
import { DelegationEnforcer } from '../../src/agents/delegation-enforcer.js';
import type { DelegationContract } from '../../src/agents/delegation-contract.js';
import {
  inferPermissionCeiling,
  evaluateBatchCompletion,
  wrapSpawnAgentWithDelegation,
} from '../../src/tools/builtin/spawn-agent-delegation.js';

function buildContract(ceiling: 'read_only' | 'sandboxed_write' | 'full'): DelegationContract {
  return {
    taskId: 'task-1',
    parentAgentId: 'parent',
    childAgentId: 'child',
    profileId: 'profile-coder',
    grant: {
      readFiles: ['src/'],
      writeFiles: ['src/out.ts'],
      allowedTools: ['file_read', 'file_write', 'file_edit', 'shell_exec', 'git_op'],
      maxTokens: 10000,
      maxSteps: 20,
      canChallenge: true,
      permissionCeiling: ceiling,
    },
    obligation: {
      mustFollowDesign: true,
      mustReportProgress: true,
      mustNotAlterGoal: true,
      challengeChannel: 'parent_only',
    },
    deliverable: {
      format: 'text',
      successCriteria: ['完成'],
      failureCriteria: ['错误'],
    },
  };
}

describe('delegation permissionCeiling（权限天花板）', () => {
  it('read_only 拒绝写操作', () => {
    const enforcer = new DelegationEnforcer(buildContract('read_only'));
    expect(enforcer.beforeToolCall('file_read', { path: 'src/a.ts' }).allowed).toBe(true);
    const write = enforcer.beforeToolCall('file_write', { path: 'src/out.ts', content: 'x' });
    expect(write.allowed).toBe(false);
    expect(write.reason).toContain('read_only');
  });

  it('sandboxed_write 允许写文件但拒绝系统级执行', () => {
    const enforcer = new DelegationEnforcer(buildContract('sandboxed_write'));
    expect(enforcer.beforeToolCall('file_edit', { path: 'src/out.ts' }).allowed).toBe(true);
    const shell = enforcer.beforeToolCall('shell_exec', { command: 'npm test' });
    expect(shell.allowed).toBe(false);
    expect(shell.reason).toContain('sandboxed_write');
    expect(enforcer.beforeToolCall('git_op', {}).allowed).toBe(false);
  });

  it('full 不拦截写与执行', () => {
    const enforcer = new DelegationEnforcer(buildContract('full'));
    expect(enforcer.beforeToolCall('file_write', { path: 'src/out.ts' }).allowed).toBe(true);
    expect(enforcer.beforeToolCall('shell_exec', { command: 'ls' }).allowed).toBe(true);
  });

  it('read_only 仍遵守 writeFiles 白名单以外的拦截（原有规则保留）', () => {
    const enforcer = new DelegationEnforcer(buildContract('read_only'));
    // writeFiles 存在但不允许写操作（天花板优先拦截）
    expect(enforcer.beforeToolCall('file_write', { path: 'src/out.ts' }).allowed).toBe(false);
  });
});

describe('inferPermissionCeiling（子 Agent 类型 → 天花板推断）', () => {
  it('researcher/reviewer/review-plan 为 read_only', () => {
    expect(inferPermissionCeiling('researcher')).toBe('read_only');
    expect(inferPermissionCeiling('reviewer')).toBe('read_only');
    expect(inferPermissionCeiling('review-plan')).toBe('read_only');
  });
  it('coder 为 sandboxed_write', () => {
    expect(inferPermissionCeiling('coder')).toBe('sandboxed_write');
  });
  it('general/planner/advisor 为 full', () => {
    expect(inferPermissionCeiling('general')).toBe('full');
    expect(inferPermissionCeiling('planner')).toBe('full');
    expect(inferPermissionCeiling('advisor')).toBe('full');
  });
});

describe('evaluateBatchCompletion（批量等待完成语义）', () => {
  const results = [
    { success: true, result: 'a' },
    { success: true, result: 'b' },
    { success: false, result: '', error: 'x' },
  ];

  it('all：全部成功才算整体成功', () => {
    expect(evaluateBatchCompletion(results, 'all')).toEqual({ ok: false, succeeded: 2, failed: 1 });
    expect(evaluateBatchCompletion([results[0]!], 'all')).toEqual({ ok: true, succeeded: 1, failed: 0 });
  });

  it('anyOf：至少一个成功即通过', () => {
    expect(evaluateBatchCompletion(results, 'anyOf')).toEqual({ ok: true, succeeded: 2, failed: 1 });
    expect(evaluateBatchCompletion([results[2]!], 'anyOf')).toEqual({ ok: false, succeeded: 0, failed: 1 });
  });

  it('minSucceed：成功数达到 minCount 才通过', () => {
    expect(evaluateBatchCompletion(results, 'minSucceed', 2)).toEqual({ ok: true, succeeded: 2, failed: 1 });
    expect(evaluateBatchCompletion(results, 'minSucceed', 3)).toEqual({ ok: false, succeeded: 2, failed: 1 });
  });

  it('minCount 缺省时按 1 处理', () => {
    expect(evaluateBatchCompletion(results, 'minSucceed')).toEqual({ ok: true, succeeded: 2, failed: 1 });
  });
});

describe('wrapSpawnAgentWithDelegation 接线（evaluateBatchCompletion 生产消费）', () => {
  it('completionMode 指定时按批量语义评估本次 spawn，结果原样返回', async () => {
    const inner = vi.fn().mockResolvedValue({ success: true, result: 'done' });
    const wrapped = wrapSpawnAgentWithDelegation(inner, {});
    const result = await wrapped(
      { description: 't', prompt: 'p', completionMode: 'all' },
      {},
    );
    expect(result).toEqual({ success: true, result: 'done' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('completionMode=anyOf 且 spawn 失败时结果仍原样返回（判定不吞失败）', async () => {
    const inner = vi.fn().mockResolvedValue({ success: false, result: '', error: 'boom' });
    const wrapped = wrapSpawnAgentWithDelegation(inner, {});
    const result = await wrapped(
      { description: 't', prompt: 'p', completionMode: 'anyOf' },
      {},
    );
    expect(result).toEqual({ success: false, result: '', error: 'boom' });
  });

  it('completionMode 未指定时不进入批量判定分支（passthrough）', async () => {
    const inner = vi.fn().mockResolvedValue({ success: true, result: 'ok' });
    const wrapped = wrapSpawnAgentWithDelegation(inner, {});
    const result = await wrapped({ description: 't', prompt: 'p' }, {});
    expect(result).toEqual({ success: true, result: 'ok' });
  });
});
