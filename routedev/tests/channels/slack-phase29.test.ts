// tests/channels/slack-phase29.test.ts
// Phase 29 Task 6：SlackAdapter Phase 29 安全加固测试
// 覆盖：生产模式签名拒绝、signingSecret 缺失

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter } from '../../src/channels/adapters/slack.js';
import { logger } from '../../src/utils/logger.js';

function makeConfig(signingSecret?: string): any {
  return {
    id: 'slack-1',
    type: 'slack',
    enabled: true,
    options: {
      botToken: 'xoxb-test-token',
      signingSecret,
    },
  };
}

describe('SlackAdapter Phase 29 安全加固', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger as any);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as any);
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('Task 1.1：签名验证生产模式拒绝降级', () => {
    it('生产模式下 signingSecret 未配置应拒绝请求', () => {
      process.env.NODE_ENV = 'production';
      const adapter = new SlackAdapter(makeConfig(undefined));
      const result = adapter.verifySignature('body', 'signature', '1234567890');
      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('开发模式下 signingSecret 未配置应放行但记录警告', () => {
      process.env.NODE_ENV = 'development';
      const adapter = new SlackAdapter(makeConfig(undefined));
      const result = adapter.verifySignature('body', 'signature', '1234567890');
      expect(result).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('signingSecret 已配置时正常验证', () => {
      process.env.NODE_ENV = 'production';
      const adapter = new SlackAdapter(makeConfig('test-secret'));
      // 签名不匹配应返回 false
      const result = adapter.verifySignature('body', 'v0=invalid', '1234567890');
      expect(result).toBe(false);
    });
  });
});
