// tests/channels/server.test.ts
// WebhookServer 单元测试

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebhookServer } from '../../src/channels/server.js';
import type { ChannelAdapter, ChannelMessage, ChannelStatus, ChannelType, ChannelMessageHandler } from '../../src/channels/types.js';
import http from 'node:http';

function makeMockAdapter(type: ChannelType = 'wechat-work', handlerResponse: string = 'reply'): ChannelAdapter {
  const adapter: Partial<ChannelAdapter> & {
    messageHandler?: ChannelMessageHandler;
    parseWebhook?: (body: string) => ChannelMessage | null;
    verifySignature?: (body: string, sig: string, ts: string) => boolean;
  } = {
    type,
    config: { id: 'test', type, enabled: true, options: {} },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isRunning: () => true,
    onMessage: (h: ChannelMessageHandler) => { adapter.messageHandler = h; },
    sendResponse: vi.fn(async () => ({ text: handlerResponse, success: true })),
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

async function request(server: WebhookServer, port: number, path: string, body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path,
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'text/xml' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// I3 修复：带 Bearer Token 认证的请求辅助函数
async function requestWithAuth(server: WebhookServer, port: number, path: string, body: string, token: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'Authorization': `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('WebhookServer', () => {
  let server: WebhookServer;
  let port: number;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should start and stop', async () => {
    server = new WebhookServer({ port: 0 });
    // port 0 means OS-assigned, but server.listen() needs real port
    // Let's use a real port
    server = new WebhookServer({ port: 19900 });
    await server.start();
    await server.stop();
    expect(server).toBeDefined();
  });

  it('should respond to GET /status with no adapters', async () => {
    server = new WebhookServer({ port: 19901 });
    await server.start();
    const res = await request(server, 19901, '/status');
    expect(res.status).toBe(200);
    // I4 修复：/status 现在只返回最小健康状态
    expect(res.data).toContain('"ok":true');
  });

  it('should return 404 for unknown webhook path', async () => {
    // I3 修复：需配置 authToken，否则未认证请求返回 401 而非 404
    server = new WebhookServer({ port: 19902, authToken: 'test-token' });
    await server.start();
    const res = await requestWithAuth(server, 19902, '/unknown', '<xml></xml>', 'test-token');
    expect(res.status).toBe(404);
  });

  it('should return 404 for unknown channel type', async () => {
    const adapter = makeMockAdapter('wechat-work');
    // I3 修复：测试需配置 authToken 才能通过认证
    server = new WebhookServer({ port: 19903, authToken: 'test-token' });
    server.registerAdapter(adapter);
    await server.start();
    const res = await requestWithAuth(server, 19903, '/webhook/unknown-channel', '<xml></xml>', 'test-token');
    expect(res.status).toBe(404);
  });

  it('should route wechat-work webhook to adapter handler', async () => {
    const adapter = makeMockAdapter('wechat-work', 'hello reply');
    server = new WebhookServer({ port: 19904, authToken: 'test-token' });
    server.registerAdapter(adapter);
    await server.start();

    const xmlBody = `<xml>
<ToUserName><![CDATA[bot]]></ToUserName>
<FromUserName><![CDATA[user1]]></FromUserName>
<CreateTime>1700000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[hello]]></Content>
<MsgId>123456</MsgId>
</xml>`;

    const res = await requestWithAuth(server, 19904, '/webhook/wechat-work', xmlBody, 'test-token');
    expect(res.status).toBe(200);
  });

  it('should return minimal status in /status', async () => {
    const adapter = makeMockAdapter('wechat-work');
    server = new WebhookServer({ port: 19905 });
    server.registerAdapter(adapter);
    await server.start();

    const res = await request(server, 19905, '/status');
    expect(res.status).toBe(200);
    // I4 修复：/status 不再泄露适配器列表
    expect(res.data).toContain('"ok":true');
    expect(res.data).not.toContain('wechat-work');
  });

  it('should track running adapters count', async () => {
    const adapter = makeMockAdapter();
    server = new WebhookServer({ port: 19906 });
    server.registerAdapter(adapter);
    await server.start();

    const running = server.getRunningAdapters();
    expect(running.length).toBe(1);
    expect(running[0].type).toBe('wechat-work');
  });
});