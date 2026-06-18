// tests/cli/components/ConfigReloadUI.test.ts
// ConfigReloadUI 测试（Phase 23 Task 4）
// 验证变更分类、通知合并、配置 diff

import { describe, it, expect } from 'vitest';
import {
  classifyConfigChange,
  diffConfigs,
  mergeChanges,
  generateReloadNotices,
  handleConfigReload,
} from '../../../src/cli/components/ConfigReloadUI.js';
import type { ConfigChange } from '../../../src/cli/components/ConfigReloadUI.js';

describe('ConfigReloadUI: classifyConfigChange', () => {
  it('autonomy.defaultMode 分类为热更新', () => {
    const change = classifyConfigChange('autonomy.defaultMode', 'auto');
    expect(change.hot).toBe(true);
    expect(change.message).toContain('自主模式已切换为 auto');
  });

  it('autonomy 其他字段也分类为热更新', () => {
    const change = classifyConfigChange('autonomy.autoApprovePatterns');
    expect(change.hot).toBe(true);
  });

  it('router.budget 分类为热更新', () => {
    const change = classifyConfigChange('router.budget.dailyLimit');
    expect(change.hot).toBe(true);
    expect(change.message).toContain('预算设置');
  });

  it('router.userPreference 分类为热更新', () => {
    const change = classifyConfigChange('router.userPreference');
    expect(change.hot).toBe(true);
  });

  it('general 分类为热更新', () => {
    const change = classifyConfigChange('general.language');
    expect(change.hot).toBe(true);
    expect(change.message).toContain('界面设置');
  });

  it('sounds 分类为热更新', () => {
    const change = classifyConfigChange('sounds.enabled');
    expect(change.hot).toBe(true);
  });

  it('providers 分类为冷更新', () => {
    const change = classifyConfigChange('providers');
    expect(change.hot).toBe(false);
    expect(change.message).toContain('Provider');
    expect(change.message).toContain('下次会话');
  });

  it('router.rules 分类为冷更新', () => {
    const change = classifyConfigChange('router.rules');
    expect(change.hot).toBe(false);
    expect(change.message).toContain('模型分配');
  });

  it('channels 分类为冷更新', () => {
    const change = classifyConfigChange('channels.entries');
    expect(change.hot).toBe(false);
    expect(change.message).toContain('通道');
    expect(change.message).toContain('重启');
  });

  it('security 分类为冷更新', () => {
    const change = classifyConfigChange('security.directoryBoundary');
    expect(change.hot).toBe(false);
    expect(change.message).toContain('重启');
  });

  it('mcp 分类为冷更新', () => {
    const change = classifyConfigChange('mcp.servers');
    expect(change.hot).toBe(false);
  });

  it('未知路径默认为冷更新', () => {
    const change = classifyConfigChange('unknown.field');
    expect(change.hot).toBe(false);
    expect(change.message).toContain('配置已变更');
  });
});

describe('ConfigReloadUI: diffConfigs', () => {
  it('相同配置返回空数组', () => {
    const config = { a: 1, b: 'hello' };
    expect(diffConfigs(config, config)).toEqual([]);
  });

  it('基本类型变更被检测', () => {
    const old = { a: 1 };
    const next = { a: 2 };
    expect(diffConfigs(old, next)).toEqual(['a']);
  });

  it('新增字段被检测', () => {
    const old = { a: 1 };
    const next = { a: 1, b: 2 };
    expect(diffConfigs(old, next)).toEqual(['b']);
  });

  it('删除字段被检测', () => {
    const old = { a: 1, b: 2 };
    const next = { a: 1 };
    expect(diffConfigs(old, next)).toEqual(['b']);
  });

  it('嵌套对象变更被检测（递归）', () => {
    const old = { router: { budget: { dailyLimit: 500000 } } };
    const next = { router: { budget: { dailyLimit: 1000000 } } };
    expect(diffConfigs(old, next)).toEqual(['router.budget.dailyLimit']);
  });

  it('数组变更被检测（不递归）', () => {
    const old = { providers: [{ id: 'openai' }] };
    const next = { providers: [{ id: 'openai' }, { id: 'deepseek' }] };
    expect(diffConfigs(old, next)).toEqual(['providers']);
  });

  it('多层嵌套变更被检测', () => {
    const old = { a: { b: { c: { d: 1 } } } };
    const next = { a: { b: { c: { d: 2 } } } };
    expect(diffConfigs(old, next)).toEqual(['a.b.c.d']);
  });
});

describe('ConfigReloadUI: mergeChanges', () => {
  it('空数组返回空数组', () => {
    expect(mergeChanges([])).toEqual([]);
  });

  it('相同消息去重', () => {
    const changes: ConfigChange[] = [
      { path: 'autonomy.defaultMode', hot: true, message: '自主模式已切换为 auto' },
      { path: 'autonomy.autoApprovePatterns', hot: true, message: '自主模式已切换为 auto' },
    ];
    const merged = mergeChanges(changes);
    expect(merged).toHaveLength(1);
  });

  it('不同消息保留', () => {
    const changes: ConfigChange[] = [
      { path: 'autonomy.defaultMode', hot: true, message: '自主模式已切换为 auto' },
      { path: 'router.budget', hot: true, message: '预算设置已更新' },
    ];
    const merged = mergeChanges(changes);
    expect(merged).toHaveLength(2);
  });

  it('热更新和冷更新相同消息不合并', () => {
    const changes: ConfigChange[] = [
      { path: 'a', hot: true, message: '相同消息' },
      { path: 'b', hot: false, message: '相同消息' },
    ];
    const merged = mergeChanges(changes);
    expect(merged).toHaveLength(2);
  });

  it('多条相同保留第一条', () => {
    const changes: ConfigChange[] = [
      { path: 'a', hot: true, message: 'msg' },
      { path: 'b', hot: true, message: 'msg' },
      { path: 'c', hot: true, message: 'msg' },
    ];
    const merged = mergeChanges(changes);
    expect(merged).toHaveLength(1);
    expect(merged[0].path).toBe('a');
  });
});

describe('ConfigReloadUI: generateReloadNotices', () => {
  it('无变更返回空数组', () => {
    const config = { autonomy: { defaultMode: 'semi' } };
    expect(generateReloadNotices(config, config)).toEqual([]);
  });

  it('单字段变更生成单条通知', () => {
    const old = { autonomy: { defaultMode: 'semi' } };
    const next = { autonomy: { defaultMode: 'auto' } };
    const notices = generateReloadNotices(old, next);
    expect(notices).toHaveLength(1);
    expect(notices[0].hot).toBe(true);
    expect(notices[0].message).toContain('auto');
  });

  it('多字段变更生成多条通知（去重后）', () => {
    const old = {
      autonomy: { defaultMode: 'semi' },
      router: { budget: { dailyLimit: 500000 }, rules: [] },
    };
    const next = {
      autonomy: { defaultMode: 'auto' },
      router: { budget: { dailyLimit: 1000000 }, rules: [{ tier: 'simple' }] },
    };
    const notices = generateReloadNotices(old, next);
    expect(notices.length).toBeGreaterThanOrEqual(2);
    // 应包含热更新和冷更新
    expect(notices.some(n => n.hot)).toBe(true);
    expect(notices.some(n => !n.hot)).toBe(true);
  });
});

describe('ConfigReloadUI: handleConfigReload', () => {
  it('无变更返回默认消息', () => {
    const config = { autonomy: { defaultMode: 'semi' } };
    const msgs = handleConfigReload(config, config);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('[配置]');
  });

  it('有变更返回格式化消息', () => {
    const old = { autonomy: { defaultMode: 'semi' } };
    const next = { autonomy: { defaultMode: 'auto' } };
    const msgs = handleConfigReload(old, next);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('[配置]');
    expect(msgs[0]).toContain('自主模式');
    expect(msgs[0]).toContain('已立即生效');
  });

  it('冷更新消息不包含"已立即生效"', () => {
    const old = { providers: [{ id: 'openai' }] };
    const next = { providers: [{ id: 'openai' }, { id: 'deepseek' }] };
    const msgs = handleConfigReload(old, next);
    expect(msgs[0]).toContain('[配置]');
    expect(msgs[0]).not.toContain('已立即生效');
  });
});
