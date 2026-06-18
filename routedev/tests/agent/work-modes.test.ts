// tests/agent/work-modes.test.ts
// WorkModeController 单元测试（Phase 20 Task 1）

import { describe, it, expect } from 'vitest';
import { WorkModeController, GuardedToolExecutorAdapter } from '../../src/agent/work-modes.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';

describe('WorkModeController', () => {
  it('Build 模式允许 file_write', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('build');
    const result = ctrl.checkOperation('file_write', { path: '/tmp/x', content: 'hi' });
    expect(result.allowed).toBe(true);
  });

  it('Plan 模式拦截 file_write，reason 含 "Plan mode"', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    const result = ctrl.checkOperation('file_write', { path: '/tmp/x', content: 'hi' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Plan mode');
  });

  it('Plan 模式允许 file_read', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    const result = ctrl.checkOperation('file_read', { path: '/tmp/x' });
    expect(result.allowed).toBe(true);
  });

  it('Plan 模式拦截 shell_exec 写入命令（rm -rf）', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    const result = ctrl.checkOperation('shell_exec', { command: 'rm -rf /tmp' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Plan mode');
  });

  it('Plan 模式允许 shell_exec 只读命令（ls -la）', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    const result = ctrl.checkOperation('shell_exec', { command: 'ls -la' });
    expect(result.allowed).toBe(true);
  });

  it('Compose 模式允许所有操作', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('compose');
    expect(ctrl.checkOperation('file_write', {}).allowed).toBe(true);
    expect(ctrl.checkOperation('file_edit', {}).allowed).toBe(true);
    expect(ctrl.checkOperation('shell_exec', { command: 'rm -rf /' }).allowed).toBe(true);
    expect(ctrl.checkOperation('git_op', { operation: 'push' }).allowed).toBe(true);
    expect(ctrl.checkOperation('mcp_tool', {}).allowed).toBe(true);
  });

  it('模式切换后立即生效', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('build');
    expect(ctrl.checkOperation('file_write', {}).allowed).toBe(true);

    ctrl.setMode('plan');
    expect(ctrl.checkOperation('file_write', {}).allowed).toBe(false);

    ctrl.setMode('compose');
    expect(ctrl.checkOperation('file_write', {}).allowed).toBe(true);
  });

  it('Plan 模式拦截 git_op 写操作（push）', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    expect(ctrl.checkOperation('git_op', { operation: 'push' }).allowed).toBe(false);
    expect(ctrl.checkOperation('git_op', { operation: 'commit' }).allowed).toBe(false);
  });

  it('Plan 模式允许 git_op 读操作（log/status/diff）', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    expect(ctrl.checkOperation('git_op', { operation: 'log' }).allowed).toBe(true);
    expect(ctrl.checkOperation('git_op', { operation: 'status' }).allowed).toBe(true);
    expect(ctrl.checkOperation('git_op', { operation: 'diff' }).allowed).toBe(true);
  });

  it('Plan 模式拦截 mcp_ 工具', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    expect(ctrl.checkOperation('mcp_filesystem', {}).allowed).toBe(false);
  });

  it('Compose 模式管线阶段推进', () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('compose');
    expect(ctrl.getComposePhase()).toBe('requirements');
    ctrl.advanceComposePhase();
    expect(ctrl.getComposePhase()).toBe('coding');
    ctrl.advanceComposePhase();
    expect(ctrl.getComposePhase()).toBe('testing');
    ctrl.advanceComposePhase();
    expect(ctrl.getComposePhase()).toBe('review');
    // 最后一阶段，再推进不变
    ctrl.advanceComposePhase();
    expect(ctrl.getComposePhase()).toBe('review');
  });

  it('非 Compose 模式时 getComposePhase 返回 null', () => {
    const ctrl = new WorkModeController();
    expect(ctrl.getComposePhase()).toBeNull();
    ctrl.setMode('plan');
    expect(ctrl.getComposePhase()).toBeNull();
  });
});

describe('GuardedToolExecutorAdapter', () => {
  it('Plan 模式拦截写入工具调用', async () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('plan');
    const mockInner: ToolExecutorAdapter = {
      getToolDefinitions: () => [],
      hasTool: () => true,
      executeTool: async () => 'should not reach here',
    };
    const guarded = new GuardedToolExecutorAdapter(mockInner, ctrl);
    const result = await guarded.executeTool('file_write', 'call-1', { path: '/x' });
    expect(result).toContain('拦截');
  });

  it('Build 模式放行并委托给内部适配器', async () => {
    const ctrl = new WorkModeController();
    ctrl.setMode('build');
    const mockInner: ToolExecutorAdapter = {
      getToolDefinitions: () => [],
      hasTool: () => true,
      executeTool: async () => 'ok',
    };
    const guarded = new GuardedToolExecutorAdapter(mockInner, ctrl);
    const result = await guarded.executeTool('file_write', 'call-1', { path: '/x' });
    expect(result).toBe('ok');
  });
});
