// tests/channels/wechat-work.test.ts
// WeChatWorkAdapter 单元测试

import { describe, it, expect, vi } from 'vitest';
import { WeChatWorkAdapter } from '../../src/channels/adapters/wechat-work.js';
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

describe('WeChatWorkAdapter', () => {
  describe('constructor', () => {
    it('should initialize with config', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      expect(adapter.type).toBe('wechat-work');
      expect(adapter.config.id).toBe('wecom-1');
    });

    it('should decode encodingAESKey', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      expect(adapter['aesKey']).not.toBeNull();
      expect(adapter['aesKey']!.length).toBe(32);
    });
  });

  describe('isRunning', () => {
    it('should return true when credentials present', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      expect(adapter.isRunning()).toBe(true);
    });

    it('should return false when missing corpSecret', () => {
      const config = makeConfig();
      delete config.options.corpSecret;
      const adapter = new WeChatWorkAdapter(config);
      expect(adapter.isRunning()).toBe(false);
    });
  });

  describe('onMessage', () => {
    it('should register handler', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const handler = vi.fn(async () => 'reply');
      adapter.onMessage(handler);
      expect(adapter['messageHandler']).toBe(handler);
    });
  });

  describe('sendResponse', () => {
    it('should return success', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      adapter.onMessage(async () => 'reply');
      const result = await adapter.sendResponse('user-1', 'reply text', false);
      expect(result.success).toBe(true);
    });

    it('should return failure when no handler', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const result = await adapter.sendResponse('user-1', 'reply', false);
      expect(result.success).toBe(false);
      expect(result.error).toBe('no handler');
    });
  });

  describe('getStatus', () => {
    it('should return status', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      adapter.onMessage(async () => 'r');
      await adapter.sendResponse('u1', 'r', false);
      const status = adapter.getStatus();
      expect(status.type).toBe('wechat-work');
      expect(status.running).toBe(true);
      expect(status.messagesProcessed).toBe(1);
    });
  });

  describe('verifySignature', () => {
    it('should verify valid signature', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const token = 'test-token';
      const timestamp = '1234567890';
      const body = '<xml>...</xml>';
      const expected = crypto.createHash('sha1').update(token).update(timestamp).update(body).digest('hex');
      expect(adapter.verifySignature(body, expected, timestamp)).toBe(true);
    });

    it('should reject invalid signature', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      expect(adapter.verifySignature('body', 'invalidsig', '1234567890')).toBe(false);
    });

    it('should skip verification when no token configured', () => {
      const config = makeConfig();
      delete config.options.token;
      const adapter = new WeChatWorkAdapter(config);
      expect(adapter.verifySignature('body', 'anything', '123')).toBe(true);
    });
  });

  describe('parseWebhook', () => {
    it('should parse valid XML message', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const xml = `<xml>
<ToUserName><![CDATA[bot]]></ToUserName>
<FromUserName><![CDATA[user1]]></FromUserName>
<CreateTime>1700000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[hello]]></Content>
<MsgId>123456</MsgId>
</xml>`;
      const msg = adapter.parseWebhook(xml);
      expect(msg).not.toBeNull();
      expect(msg!.sender.id).toBe('user1');
      expect(msg!.text).toBe('hello');
      expect(msg!.channelType).toBe('wechat-work');
    });

    it('should return null for invalid XML', () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const xml = '<xml><FromUserName>user</FromUserName></xml>';
      expect(adapter.parseWebhook(xml)).toBeNull();
    });
  });

  describe('start/stop', () => {
    it('should start and stop', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      await adapter.start();
      await adapter.stop();
      expect(adapter['accessToken']).toBeNull();
    });
  });

  describe('triggerMessage', () => {
    it('should call handler', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      const handler = vi.fn(async () => 'response');
      adapter.onMessage(handler);
      const result = await adapter.triggerMessage({
        id: '1',
        channelType: 'wechat-work',
        sender: { id: 'u1' },
        receiver: { id: 'b1' },
        text: 'hello',
        isGroup: false,
        timestamp: Date.now(),
      });
      expect(result).toBe('response');
      expect(handler).toHaveBeenCalled();
    });

    it('should throw without handler', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      await expect(adapter.triggerMessage({
        id: '1',
        channelType: 'wechat-work',
        sender: { id: 'u1' },
        receiver: { id: 'b1' },
        text: 'hello',
        isGroup: false,
        timestamp: Date.now(),
      })).rejects.toThrow('no handler');
    });
  });

  describe('access token cache', () => {
    it('should cache access token', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      adapter['accessToken'] = 'cached';
      adapter['accessTokenExpiresAt'] = Date.now() + 10 * 60 * 1000;
      const token = await adapter.getAccessToken();
      expect(token).toBe('cached');
    });

    it('should return null when expired and not refreshing', async () => {
      const adapter = new WeChatWorkAdapter(makeConfig());
      adapter['accessToken'] = 'expired';
      adapter['accessTokenExpiresAt'] = Date.now() - 1000;
      const token = await adapter.getAccessToken();
      expect(token).toBeNull();
    });
  });
});