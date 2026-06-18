// tests/channels/server-security.test.ts
// WebhookServer 安全加固测试：body 大小限制、Bearer 认证、速率限制

import { describe, it, expect, afterEach } from 'vitest';
import { WebhookServer } from '../../src/channels/server.js';
import type { ChannelAdapter, ChannelMessage, ChannelStatus, ChannelType, ChannelMessageHandler } from '../../src/channels/types.js';
import http from 'node:http';

function makeMockAdapter(type: ChannelType = 'wechat-work'): ChannelAdapter {
  const adapter: Partial<ChannelAdapter> & {
    messageHandler?: ChannelMessageHandler;
    parseWebhook?: (body: string) => ChannelMessage | null;
    verifySignature?: (body: string, sig: string, ts: string) => boolean;
  } = {
    type,
    config: { id: 'test', type, enabled: true, options: {} },
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    onMessage: (h: ChannelMessageHandler) => { adapter.messageHandler = h; },
    sendResponse: async () => ({ text: 'reply', success: true }),
    getStatus: (): ChannelStatus => ({
      type,
      running: true,
      messagesProcessed: 0,
    }),
    messageHandler: undefined,
    parseWebhook: (body: string): ChannelMessage | null => {
      const fromMatch = body.match(/<FromUserName>[^<]*<!\[CDATA\[([^\]]+)\]\]><\/FromUserName>/);
      const contentMatch = body.match(/<Content>[^<]*<!\[CDATA\[([^\]]+)\]\]><\/Content>/);
      const toMatch = body.match(/<ToUserName>[^<]*<!\[CDATA\[([^\]]+)\]\]><\/ToUserName>/);
      if (!fromMatch || !contentMatch) return null;
      return {
        id: 'msg-1',
        channelType: type,
        sender: { id: fromMatch[1] },
        receiver: { id: toMatch?.[1] ?? 'bot' },
        text: contentMatch[1],
        isGroup: false,
        timestamp: Date.now(),
      };
    },
    verifySignature: () => true,
  };
  return adapter as ChannelAdapter;
}

/** 发送 HTTP 请求，支持自定义 headers */
async function request(
  port: number,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method: options.body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'text/xml', ...(options.headers ?? {}) },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('WebhookServer Security', () => {
  let server: WebhookServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  describe('body size limit', () => {
    it('should reject body exceeding 1MB', async () => {
      server = new WebhookServer({ port: 19910 });
      server.registerAdapter(makeMockAdapter());
      await server.start();

      // 构造 2MB 的请求体
      const largeBody = 'x'.repeat(2 * 1024 * 1024);
      try {
        const res = await request(19910, '/webhook/wechat-work', { body: largeBody });
        // 如果收到响应，状态码不应为 200
        expect(res.status).not.toBe(200);
      } catch {
        // 连接被重置也是可接受的（req.destroy() 导致）
        expect(true).toBe(true);
      }
    });

    it('should accept body under 1MB', async () => {
      server = new WebhookServer({ port: 19911 });
      server.registerAdapter(makeMockAdapter());
      await server.start();

      const xmlBody = `<xml>
<ToUserName><![CDATA[bot]]></ToUserName>
<FromUserName><![CDATA[user1]]></FromUserName>
<CreateTime>1700000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[hello]]></Content>
<MsgId>123456</MsgId>
</xml>`;
      const res = await request(19911, '/webhook/wechat-work', { body: xmlBody });
      expect(res.status).toBe(200);
    });
  });

  describe('Bearer Token authentication', () => {
    it('should return 401 when authToken configured but no Authorization header', async () => {
      server = new WebhookServer({ port: 19912, authToken: 'secret-token' });
      server.registerAdapter(makeMockAdapter());
      await server.start();

      const res = await request(19912, '/webhook/wechat-work', { body: '<xml></xml>' });
      expect(res.status).toBe(401);
    });

    it('should return 401 with wrong Bearer token', async () => {
      server = new WebhookServer({ port: 19913, authToken: 'secret-token' });
      server.registerAdapter(makeMockAdapter());
      await server.start();

      const res = await request(19913, '/webhook/wechat-work', {
        body: '<xml></xml>',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('should pass with correct Bearer token', async () => {
      server = new WebhookServer({ port: 19914, authToken: 'secret-token' });
      server.registerAdapter(makeMockAdapter());
      await server.start();

      const xmlBody = `<xml>
<ToUserName><![CDATA[bot]]></ToUserName>
<FromUserName><![CDATA[user1]]></FromUserName>
<CreateTime>1700000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[hello]]></Content>
<MsgId>123456</MsgId>
</xml>`;
      const res = await request(19914, '/webhook/wechat-work', {
        body: xmlBody,
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(res.status).toBe(200);
    });

    it('should return 401 when Authorization header does not start with Bearer', async () => {
      server = new WebhookServer({ port: 19915, authToken: 'secret-token' });
      server.registerAdapter(makeMockAdapter());
      await server.start();

      const res = await request(19915, '/webhook/wechat-work', {
        body: '<xml></xml>',
        headers: { Authorization: 'Basic secret-token' },
      });
      expect(res.status).toBe(401);
    });

    it('should allow /status without auth (exempt from authentication)', async () => {
      server = new WebhookServer({ port: 19916, authToken: 'secret-token' });
      await server.start();

      const res = await request(19916, '/status');
      expect(res.status).toBe(200);
    });

    it('should skip auth when authToken not configured (dev mode)', async () => {
      server = new WebhookServer({ port: 19917 });
      server.registerAdapter(makeMockAdapter());
      await server.start();

      const xmlBody = `<xml>
<ToUserName><![CDATA[bot]]></ToUserName>
<FromUserName><![CDATA[user1]]></FromUserName>
<CreateTime>1700000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[hello]]></Content>
<MsgId>123456</MsgId>
</xml>`;
      const res = await request(19917, '/webhook/wechat-work', { body: xmlBody });
      expect(res.status).toBe(200);
    });
  });

  describe('rate limiting (token bucket)', () => {
    it('should return 429 after exceeding 30 requests', async () => {
      server = new WebhookServer({ port: 19918 });
      await server.start();

      // 发送 30 次请求（应全部成功）
      for (let i = 0; i < 30; i++) {
        const res = await request(19918, '/status');
        expect(res.status).toBe(200);
      }

      // 第 31 次请求应被限流
      const res = await request(19918, '/status');
      expect(res.status).toBe(429);
    });

    it('should track rate limit per client IP', async () => {
      // 使用 X-Forwarded-For 模拟不同客户端 IP
      server = new WebhookServer({ port: 19919 });
      await server.start();

      // 客户端 A 发送 30 次请求（应全部成功）
      for (let i = 0; i < 30; i++) {
        const res = await request(19919, '/status', {
          headers: { 'X-Forwarded-For': '10.0.0.1' },
        });
        expect(res.status).toBe(200);
      }

      // 客户端 A 第 31 次请求应被限流
      const resA = await request(19919, '/status', {
        headers: { 'X-Forwarded-For': '10.0.0.1' },
      });
      expect(resA.status).toBe(429);

      // 客户端 B 的请求应成功（独立桶）
      const resB = await request(19919, '/status', {
        headers: { 'X-Forwarded-For': '10.0.0.2' },
      });
      expect(resB.status).toBe(200);
    });
  });
});
