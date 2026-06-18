// tests/channels/wechat-work-security.test.ts
// WeChatWorkAdapter 安全修复测试：timingSafeEqual、token 未配置 warn、签名长度不匹配

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WeChatWorkAdapter } from '../../src/channels/adapters/wechat-work.js';
import { logger } from '../../src/utils/logger.js';
import crypto from 'node:crypto';

function makeConfig(): any {
  return {
    id: 'wecom-1',
    type: 'wechat-work',
    enabled: true,
    options: {
      corpId: 'test-corp',
      corpSecret: 'test-secret',
      agentId: '1000001',
      token: 'test-token',
      encodingAESKey: 'A'.repeat(43),
    },
  };
}

describe('WeChatWorkAdapter Security', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // vi.spyOn 在已 spy 的方法上会返回既有 spy，需 mockClear 重置调用计数
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as any);
    warnSpy.mockClear();
  });

  describe('verifySignature with timingSafeEqual', () => {
    it('should accept correct signature', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const token = 'test-token';
      const timestamp = '1234567890';
      const body = '<xml>hello world</xml>';
      const expected = crypto
        .createHash('sha1')
        .update(token)
        .update(timestamp)
        .update(body)
        .digest('hex');

      expect(adapter.verifySignature(body, expected, timestamp)).toBe(true);
    });

    it('should reject incorrect signature', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const body = '<xml>hello</xml>';
      const timestamp = '1234567890';
      // 构造一个有效 hex 但错误的签名（40 个字符）
      const wrongSig = '0'.repeat(40);

      expect(adapter.verifySignature(body, wrongSig, timestamp)).toBe(false);
    });

    it('should reject signature with mismatched length', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const body = '<xml>hello</xml>';
      const timestamp = '1234567890';
      // 签名长度与期望（20 字节）不匹配：'ab' 解码为 1 字节
      const shortSig = 'ab';

      expect(adapter.verifySignature(body, shortSig, timestamp)).toBe(false);
    });

    it('should reject empty signature', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const body = '<xml>hello</xml>';
      const timestamp = '1234567890';

      expect(adapter.verifySignature(body, '', timestamp)).toBe(false);
    });

    it('should reject non-hex signature', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const body = '<xml>hello</xml>';
      const timestamp = '1234567890';
      // 非 hex 字符串，Buffer.from 会得到空或部分 buffer
      const nonHexSig = 'not-a-valid-hex-signature!';

      expect(adapter.verifySignature(body, nonHexSig, timestamp)).toBe(false);
    });

    it('should accept correct signature with different body content', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const token = 'test-token';
      const timestamp = '1700000000';
      const body = '<xml><Content><![CDATA[你好世界]]></Content></xml>';
      const expected = crypto
        .createHash('sha1')
        .update(token)
        .update(timestamp)
        .update(body)
        .digest('hex');

      expect(adapter.verifySignature(body, expected, timestamp)).toBe(true);
    });
  });

  describe('token not configured warning', () => {
    it('should warn and return true when token not configured (dev mode)', () => {
      const config = makeConfig();
      delete config.options.token;
      const adapter = new WeChatWorkAdapter(config);

      const result = adapter.verifySignature('body', 'anything', '123');

      // Phase 29：开发模式（NODE_ENV !== 'production'）降级放行
      expect(result).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        'WeChatWork webhook token 未配置，开发模式放行（不安全）',
      );
    });

    it('should warn each time verifySignature is called without token', () => {
      const config = makeConfig();
      delete config.options.token;
      const adapter = new WeChatWorkAdapter(config);

      adapter.verifySignature('body1', 'sig1', '123');
      adapter.verifySignature('body2', 'sig2', '456');

      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});
