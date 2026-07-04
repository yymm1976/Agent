// tests/cli/commands/mode-manager.test.ts
// ModeManager 单元测试：
//   - 默认模式为 code
//   - setMode 切换模式并记录 previousMode
//   - restoreMode 从 ask 恢复到 previousMode
//   - getToolFilter 各模式的工具过滤正确
//   - getSystemPromptAddendum 各模式的指令正确
//   - isAskMode / isArchitectMode 状态查询

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModeManager,
  modeManager,
  ARCHITECT_SYSTEM_PROMPT_ADDENDUM,
  ASK_SYSTEM_PROMPT_ADDENDUM,
  READONLY_TOOLS,
  WRITE_TOOLS,
} from '../../../src/cli/commands/mode-manager.js';

describe('ModeManager', () => {
  let mgr: ModeManager;

  beforeEach(() => {
    mgr = new ModeManager();
  });

  it('默认模式为 code', () => {
    expect(mgr.getMode()).toBe('code');
    expect(mgr.isAskMode()).toBe(false);
    expect(mgr.isArchitectMode()).toBe(false);
  });

  it('setMode 切换模式并记录 previousMode', () => {
    mgr.setMode('architect');
    expect(mgr.getMode()).toBe('architect');
    expect(mgr.getPreviousMode()).toBe('code');
    expect(mgr.isArchitectMode()).toBe(true);

    mgr.setMode('ask');
    expect(mgr.getMode()).toBe('ask');
    expect(mgr.getPreviousMode()).toBe('architect');
    expect(mgr.isAskMode()).toBe(true);
  });

  it('setMode 重复设置同模式不记录', () => {
    mgr.setMode('architect');
    mgr.setMode('architect'); // 重复
    expect(mgr.getMode()).toBe('architect');
    expect(mgr.getPreviousMode()).toBe('code'); // 仍是 code，未被覆盖
  });

  it('restoreMode 从 ask 恢复到 previousMode', () => {
    mgr.setMode('architect');
    mgr.setMode('ask');
    expect(mgr.getMode()).toBe('ask');
    const restored = mgr.restoreMode();
    expect(restored).toBe(true);
    expect(mgr.getMode()).toBe('architect');
  });

  it('restoreMode 在非 ask 模式返回 false', () => {
    mgr.setMode('architect');
    const restored = mgr.restoreMode();
    expect(restored).toBe(false);
    expect(mgr.getMode()).toBe('architect');
  });

  it('code 模式工具过滤为空（全部允许）', () => {
    const filter = mgr.getToolFilter('code');
    expect(filter.allowed).toEqual([]);
    expect(filter.blocked).toEqual([]);
  });

  it('architect 模式工具过滤为空（全部允许）', () => {
    const filter = mgr.getToolFilter('architect');
    expect(filter.allowed).toEqual([]);
    expect(filter.blocked).toEqual([]);
  });

  it('ask 模式只允许只读工具，禁用写工具', () => {
    const filter = mgr.getToolFilter('ask');
    expect(filter.allowed).toEqual([...READONLY_TOOLS]);
    expect(filter.blocked).toEqual([...WRITE_TOOLS]);
    // 关键只读工具在白名单
    expect(filter.allowed).toContain('file_read');
    expect(filter.allowed).toContain('code_search');
    expect(filter.allowed).toContain('repo_map');
    // 关键写工具在黑名单
    expect(filter.blocked).toContain('file_edit');
    expect(filter.blocked).toContain('file_write');
    expect(filter.blocked).toContain('shell_exec');
  });

  it('getSystemPromptAddendum 各模式返回正确', () => {
    expect(mgr.getSystemPromptAddendum('code')).toBe('');
    expect(mgr.getSystemPromptAddendum('architect')).toBe(ARCHITECT_SYSTEM_PROMPT_ADDENDUM);
    expect(mgr.getSystemPromptAddendum('ask')).toBe(ASK_SYSTEM_PROMPT_ADDENDUM);
  });

  it('getToolFilter 默认使用当前模式', () => {
    mgr.setMode('ask');
    const filter = mgr.getToolFilter();
    expect(filter.allowed).toContain('file_read');
    expect(filter.blocked).toContain('file_edit');
  });

  it('reset 恢复到默认 code 模式', () => {
    mgr.setMode('architect');
    mgr.setMode('ask');
    mgr.reset();
    expect(mgr.getMode()).toBe('code');
    expect(mgr.getPreviousMode()).toBe('code');
  });

  it('单例 modeManager 可正常使用', () => {
    const original = modeManager.getMode();
    modeManager.setMode('ask');
    expect(modeManager.getMode()).toBe('ask');
    modeManager.restoreMode();
    expect(modeManager.getMode()).toBe(original);
    modeManager.reset();
    expect(modeManager.getMode()).toBe('code');
  });
});
