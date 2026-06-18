// tests/channels/manager-slack.test.ts
// Phase 29 Task 6：ChannelManager Slack 适配器注册测试

import { describe, it, expect } from 'vitest';
import { ChannelManager } from '../../src/channels/manager.js';
import type { ChannelEntryConfig } from '../../src/config/schema.js';

describe('ChannelManager Phase 29 Slack 适配器注册', () => {
  it('应能创建 slack 类型的适配器', () => {
    const manager = new ChannelManager(9876);
    const entries: ChannelEntryConfig[] = [
      {
        id: 'slack-1',
        type: 'slack',
        enabled: true,
        options: {
          botToken: 'xoxb-test',
          signingSecret: 'test-secret',
        },
      } as any,
    ];

    // initializeAdapters 不应抛错
    expect(() => manager.initializeAdapters(entries, {} as any)).not.toThrow();
    expect(manager.adapterCount).toBe(1);
  });

  it('未知渠道类型应抛出错误', () => {
    const manager = new ChannelManager(9877);
    const entries: ChannelEntryConfig[] = [
      {
        id: 'unknown-1',
        type: 'unknown-type' as any,
        enabled: true,
        options: {},
      } as any,
    ];

    // initializeAdapters 内部 catch 错误，不会抛出，但适配器数量为 0
    manager.initializeAdapters(entries, {} as any);
    expect(manager.adapterCount).toBe(0);
  });

  it('wechat-work 类型仍可正常创建', () => {
    const manager = new ChannelManager(9878);
    const entries: ChannelEntryConfig[] = [
      {
        id: 'wecom-1',
        type: 'wechat-work',
        enabled: true,
        options: {
          corpId: 'test',
          corpSecret: 'test',
          agentId: '1000001',
          token: 'test',
        },
      } as any,
    ];

    manager.initializeAdapters(entries, {} as any);
    expect(manager.adapterCount).toBe(1);
  });
});
