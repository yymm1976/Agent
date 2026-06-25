// tests/channels/wechat-work-phase29.test.ts
// Phase 29 Task 6：WeChatWorkAdapter Phase 29 安全加固测试
// 覆盖：生产模式签名拒绝、PKCS#7 padding 严格验证、parseInt NaN 防护

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatWorkAdapter } from '../../src/channels/adapters/wechat-work.js';
import { logger } from '../../src/utils/logger.js';

function makeConfig(token?: string): any {
  return {
    id: 'wecom-1',
    type: 'wechat-work',
    enabled: true,
    options: {
      corpId: 'test-corp',
      corpSecret: 'test-secret',
      agentId: '1000001',
      token,
      encodingAESKey: 'A'.repeat(43),
    },
  };
}

describe('WeChatWorkAdapter Phase 29 安全加固', () => {
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
    it('生产模式下 token 未配置应拒绝请求', () => {
      process.env.NODE_ENV = 'production';
      const adapter = new WeChatWorkAdapter(makeConfig(undefined));
      const result = adapter.verifySignature('body', 'signature', 'timestamp');
      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('开发模式下 token 未配置应放行但记录警告', () => {
      process.env.NODE_ENV = 'development';
      const adapter = new WeChatWorkAdapter(makeConfig(undefined));
      const result = adapter.verifySignature('body', 'signature', 'timestamp');
      expect(result).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('token 已配置时正常验证（不受 NODE_ENV 影响）', () => {
      process.env.NODE_ENV = 'production';
      const adapter = new WeChatWorkAdapter(makeConfig('test-token'));
      // 签名不匹配应返回 false
      const result = adapter.verifySignature('body', 'invalid-signature', 'timestamp');
      expect(result).toBe(false);
    });
  });

  describe('Task 1.4：PKCS#7 padding 严格验证', () => {
    it('未配置 AES key 时直接返回原文', () => {
      const adapter = new WeChatWorkAdapter({
        ...makeConfig('token'),
        options: { ...makeConfig('token').options, encodingAESKey: undefined },
      });
      const result = adapter.decryptMessage('encrypted-text');
      expect(result).toBe('encrypted-text');
    });

    it('解密失败时返回空字符串并记录警告（Minor 修复：避免后续 XML 解析异常）', () => {
      const adapter = new WeChatWorkAdapter(makeConfig('token'));
      // 提供无效的 base64 数据，解密会失败
      const result = adapter.decryptMessage('!!!invalid-base64!!!');
      // Minor 修复：解密失败返回空字符串而非密文，避免后续 XML 解析异常
      expect(result).toBe('');
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('Task 1.5：parseInt NaN 防护', () => {
    // 辅助函数：创建不配置 AES key 的 adapter，使 decryptMessage 直接返回原文（XML 字符串）
    function makeNoAesKeyConfig(token?: string): any {
      return { ...makeConfig(token), options: { ...makeConfig(token).options, encodingAESKey: undefined } };
    }

    it('CreateTime 缺失时使用当前时间戳', () => {
      const adapter = new WeChatWorkAdapter(makeNoAesKeyConfig('token'));
      // XML 中无 CreateTime 字段
      const xml = '<xml><Content>hello</Content><FromUserName>user1</FromUserName></xml>';
      const message = adapter.parseWebhook(xml);
      expect(message).not.toBeNull();
      expect(message!.timestamp).toBeGreaterThan(0);
    });

    it('CreateTime 为非数字时使用当前时间戳', () => {
      const adapter = new WeChatWorkAdapter(makeNoAesKeyConfig('token'));
      const xml = '<xml><Content>hello</Content><FromUserName>user1</FromUserName><CreateTime>abc</CreateTime></xml>';
      const message = adapter.parseWebhook(xml);
      expect(message).not.toBeNull();
      // 应该是当前时间（秒级），不是 NaN
      expect(message!.timestamp).toBeGreaterThan(0);
      expect(Number.isNaN(message!.timestamp)).toBe(false);
    });
  });
});
