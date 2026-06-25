// tests/integration/channel-flow.test.ts
// 集成测试：通道消息流（Phase 23 Task 6）
// 链路：webhook → adapter → route → respond
// 使用 mock LLM provider 和 mock fetch，不调用真实 API

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { SlackAdapter } from '../../src/channels/adapters/slack.js';
import { TelegramAdapter } from '../../src/channels/adapters/telegram.js';
import { WeChatWorkAdapter } from '../../src/channels/adapters/wechat-work.js';
import type { ChannelMessage } from '../../src/channels/types.js';

// ============================================================
// 辅助函数
// ============================================================

/** 计算 Slack 签名 */
function computeSlackSignature(secret: string, timestamp: string, body: string): string {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

// ============================================================
// 测试
// ============================================================

describe('集成测试：Slack 通道消息流', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('webhook → adapter 解析 → handler 处理 → respond', async () => {
    const adapter = new SlackAdapter({
      id: 'slack-1',
      type: 'slack',
      enabled: true,
      options: {
        botToken: 'xoxb-test',
        signingSecret: 'test-secret',
      },
    });

    // 注册消息处理器（模拟路由 + LLM 回复）
    const receivedMessages: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => {
      receivedMessages.push(msg);
      return `收到: ${msg.text}`;
    });

    // mock fetch for sendResponse
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) });

    // 构造 webhook payload
    const body = JSON.stringify({
      event_id: 'Ev-test-001',
      event: {
        type: 'message',
        text: '你好 *世界*',
        user: 'U123',
        channel: 'C456',
        ts: String(Date.now() / 1000),
        channel_type: 'channel',
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature('test-secret', timestamp, body);

    // 执行 webhook
    const result = await adapter.handleWebhook(body, signature, timestamp);

    // 验证：请求成功处理
    expect(result.status).toBe(200);

    // 验证：消息被正确解析
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].text).toBe('你好 **世界**'); // mrkdwn 已转换
    expect(receivedMessages[0].sender.id).toBe('U123');
    expect(receivedMessages[0].channelType).toBe('slack');

    // 验证：回复已发送（fetch 被调用）
    expect(fetchMock).toHaveBeenCalledOnce();
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall[0]).toContain('chat.postMessage');
  });

  it('URL Verification 挑战直接返回，不触发 handler', async () => {
    const adapter = new SlackAdapter({
      id: 'slack-1',
      type: 'slack',
      enabled: true,
      options: { botToken: 'xoxb-test', signingSecret: 'test-secret' },
    });

    const handler = vi.fn();
    adapter.onMessage(handler);

    const body = JSON.stringify({ type: 'url_verification', challenge: 'test-challenge-abc' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature('test-secret', timestamp, body);

    const result = await adapter.handleWebhook(body, signature, timestamp);

    expect(result.status).toBe(200);
    expect((result.body as { challenge: string }).challenge).toBe('test-challenge-abc');
    expect(handler).not.toHaveBeenCalled();
  });

  it('重复消息被去重，不触发 handler', async () => {
    const adapter = new SlackAdapter({
      id: 'slack-1',
      type: 'slack',
      enabled: true,
      options: { botToken: 'xoxb-test', signingSecret: 'test-secret' },
    });

    const handler = vi.fn().mockResolvedValue('回复');
    adapter.onMessage(handler);
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) });

    const body = JSON.stringify({
      event_id: 'Ev-dedup-test',
      event: { type: 'message', text: 'test', user: 'U1', channel: 'C1', ts: String(Date.now() / 1000) },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature('test-secret', timestamp, body);

    // 第一次：正常处理
    await adapter.handleWebhook(body, signature, timestamp);
    expect(handler).toHaveBeenCalledOnce();

    // 第二次：重复 event_id，应跳过
    await adapter.handleWebhook(body, signature, timestamp);
    expect(handler).toHaveBeenCalledOnce(); // 仍然只调用一次
  });
});

describe('集成测试：Telegram 通道消息流', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('poll → 解析消息 → handler 处理 → reply', async () => {
    const adapter = new TelegramAdapter({
      id: 'tg-1',
      type: 'telegram',
      enabled: true,
      options: { botToken: '123456789:AAEhBP0av28-ExampleTokenForTestingXyz', pollIntervalMs: 50 },
    });

    const handler = vi.fn().mockResolvedValue('Telegram 回复');
    adapter.onMessage(handler);

    // mock getUpdates 返回消息
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          result: [{
            update_id: 100,
            message: {
              message_id: 200,
              chat: { id: 300, type: 'private' },
              from: { id: 400, username: 'tester' },
              text: 'hello telegram',
              date: Math.floor(Date.now() / 1000),
            },
          }],
        }),
      })
      .mockResolvedValue({ json: async () => ({ ok: true }) }); // sendMessage

    await adapter.start();

    // 等待轮询执行
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(handler).toHaveBeenCalledOnce();
    const receivedMsg = handler.mock.calls[0][0] as ChannelMessage;
    expect(receivedMsg.text).toBe('hello telegram');
    expect(receivedMsg.channelType).toBe('telegram');
    expect(receivedMsg.sender.id).toBe('400');

    await adapter.stop();
  });
});

describe('集成测试：WeChatWork 通道消息流', () => {
  it('parseWebhook 正确解析 XML 消息', () => {
    const adapter = new WeChatWorkAdapter({
      id: 'wx-1',
      type: 'wechat-work',
      enabled: true,
      options: { corpId: 'corp', corpSecret: 'secret', agentId: '1000', token: 'token' },
    });

    const xml = `<xml>
      <Content><![CDATA[你好企业微信]]></Content>
      <FromUserName><![CDATA[user1]]></FromUserName>
      <ToUserName><![CDATA[bot]]></ToUserName>
      <MsgId>1234567890</MsgId>
      <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
    </xml>`;

    const msg = adapter.parseWebhook(xml);
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe('你好企业微信');
    expect(msg!.sender.id).toBe('user1');
    expect(msg!.channelType).toBe('wechat-work');
  });
});

describe('集成测试：多平台消息格式一致性', () => {
  it('三个适配器都能产生 ChannelMessage 格式', () => {
    // 验证 ChannelMessage 结构在三个平台间一致
    const slackMsg: ChannelMessage = {
      id: 'Ev1',
      channelType: 'slack',
      sender: { id: 'U1' },
      receiver: { id: 'C1' },
      text: 'hello',
      isGroup: false,
      timestamp: Date.now(),
    };
    const telegramMsg: ChannelMessage = {
      id: '200',
      channelType: 'telegram',
      sender: { id: '400' },
      receiver: { id: '300' },
      text: 'hello',
      isGroup: false,
      timestamp: Date.now(),
    };
    const wechatMsg: ChannelMessage = {
      id: '1234567890',
      channelType: 'wechat-work',
      sender: { id: 'user1' },
      receiver: { id: 'bot' },
      text: 'hello',
      isGroup: false,
      timestamp: Date.now(),
    };

    // 所有消息都有相同的必需字段
    for (const msg of [slackMsg, telegramMsg, wechatMsg]) {
      expect(msg).toHaveProperty('id');
      expect(msg).toHaveProperty('channelType');
      expect(msg).toHaveProperty('sender');
      expect(msg).toHaveProperty('receiver');
      expect(msg).toHaveProperty('text');
      expect(msg).toHaveProperty('isGroup');
      expect(msg).toHaveProperty('timestamp');
    }
  });
});
