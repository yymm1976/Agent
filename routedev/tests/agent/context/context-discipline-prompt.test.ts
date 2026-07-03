import { describe, it, expect } from 'vitest';
import { buildContextDisciplinePrompt } from '../../../src/agent/context/context-discipline-prompt.js';

describe('buildContextDisciplinePrompt', () => {
  it('默认调用返回非空字符串', () => {
    const result = buildContextDisciplinePrompt();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('包含 plan 工具引导', () => {
    const result = buildContextDisciplinePrompt();
    expect(result).toContain('plan_get');
    expect(result).toContain('plan_set');
  });

  it('包含 vfs 工具引导', () => {
    const result = buildContextDisciplinePrompt();
    expect(result).toContain('vfs_write');
    expect(result).toContain('vfs_read');
  });

  it('包含 @-mention 引导', () => {
    const result = buildContextDisciplinePrompt();
    expect(result).toContain('@路径');
  });

  it('包含 offload 引导', () => {
    const result = buildContextDisciplinePrompt();
    expect(result).toContain('file_read');
    expect(result).toContain('offload');
  });

  it('options.includeVFS=false 时跳过 VFS 部分', () => {
    const result = buildContextDisciplinePrompt({ includeVFS: false });
    expect(result).not.toContain('vfs_write');
    expect(result).not.toContain('vfs_read');
    // 其余部分仍应存在
    expect(result).toContain('plan_get');
  });

  it('总长度不超过 300 字', () => {
    const result = buildContextDisciplinePrompt();
    expect(result.length).toBeLessThanOrEqual(300);
  });

  it('所有子段都禁用时返回空字符串', () => {
    const result = buildContextDisciplinePrompt({
      includePlan: false,
      includeVFS: false,
      includeMention: false,
      includeOffload: false,
      includeNoRepeat: false,
    });
    expect(result).toBe('');
  });

  it('禁用 plan 段后不再出现 plan_get / plan_set', () => {
    const result = buildContextDisciplinePrompt({ includePlan: false });
    expect(result).not.toContain('plan_get');
    expect(result).not.toContain('plan_set');
  });
});
