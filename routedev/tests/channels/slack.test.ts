// tests/channels/slack.test.ts
// SlackAdapter 测试（Phase 23 Task 2）
// 验证签名验证、消息去重、格式转换、URL Verification 挑战

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { SlackAdapter } from '../../src/channels/adapters/slack.js';
import type { SlackAdapterConfig } from '../../src/channels/adapters/slack.js';

/** 构造测试配置 */
function makeConfig(overrides: Partial<SlackAdapterConfig['options']> = {}): SlackAdapterConfig {
  return {
    id: 'slack-1',
    type: 'slack',
    enabled: true,
    options: {
      botToken: 'xoxb-test-token',
      signingSecret: 'test-signing-secret',
      ...overrides,
    },
  };
}

/** 计算 Slack 签名 */
function computeSignature(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
}

describe('SlackAdapter', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ===== 基础生命周期 =====

  it('无 botToken 时不启动', async () => {
    const adapter = new SlackAdapter(makeConfig({ botToken: undefined }));
    await adapter.start();
    expect(adapter.isRunning()).toBe(false);
  });

  it('有 botToken 时正常启动', async () => {
    const adapter = new SlackAdapter(makeConfig());
    await adapter.start();
    expect(adapter.isRunning()).toBe(true);
    await adapter.stop();
    expect(adapter.isRunning()).toBe(false);
  });

  // ===== 签名验证 =====

  describe('verifySignature', () => {
    it('正确签名通过验证', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = '{"type":"event_callback"}';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = computeSignature('test-signing-secret', timestamp, body);
      expect(adapter.verifySignature(body, signature, timestamp)).toBe(true);
    });

    it('错误签名拒绝', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = '{"type":"event_callback"}';
      const timestamp = String(Math.floor(Date.now() / 1000));
      expect(adapter.verifySignature(body, 'v0=invalid', timestamp)).toBe(false);
    });

    it('超过 5 分钟的请求拒绝（防重放）', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = '{"type":"event_callback"}';
      // 6 分钟前
      const timestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
      const signature = computeSignature('test-signing-secret', timestamp, body);
      expect(adapter.verifySignature(body, signature, timestamp)).toBe(false);
    });

    it('未配置 signingSecret 时跳过验证（开发模式）', () => {
      const adapter = new SlackAdapter(makeConfig({ signingSecret: undefined }));
      expect(adapter.verifySignature('body', 'v0=anything', '123')).toBe(true);
    });

    it('无效时间戳拒绝', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.verifySignature('body', 'v0=x', 'not-a-number')).toBe(false);
    });
  });

  // ===== URL Verification =====

  describe('handleUrlVerification', () => {
    it('正确处理 challenge 请求', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = JSON.stringify({
        type: 'url_verification',
        challenge: 'test-challenge-123',
      });
      const result = adapter.handleUrlVerification(body);
      expect(result).toEqual({ challenge: 'test-challenge-123' });
    });

    it('非挑战请求返回 null', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = JSON.stringify({ type: 'event_callback', event: {} });
      const result = adapter.handleUrlVerification(body);
      expect(result).toBeNull();
    });

    it('无效 JSON 返回 null', () => {
      const adapter = new SlackAdapter(makeConfig());
      const result = adapter.handleUrlVerification('not json');
      expect(result).toBeNull();
    });
  });

  // ===== 消息去重 =====

  describe('isDuplicate', () => {
    it('首次 event_id 返回 false', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.isDuplicate('Ev001')).toBe(false);
    });

    it('重复 event_id 返回 true', () => {
      const adapter = new SlackAdapter(makeConfig());
      adapter.isDuplicate('Ev001');
      expect(adapter.isDuplicate('Ev001')).toBe(true);
    });

    it('不同 event_id 各自首次返回 false', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.isDuplicate('Ev001')).toBe(false);
      expect(adapter.isDuplicate('Ev002')).toBe(false);
    });
  });

  // ===== 消息格式转换 =====

  describe('formatInbound', () => {
    it('转换 <!here> 为 @here', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('Hello <!here> everyone')).toBe('Hello @here everyone');
    });

    it('转换 <!channel> 为 @channel', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('Attention <!channel>')).toBe('Attention @channel');
    });

    it('转换 <@U123> 为 @U123', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('Hi <@U123>')).toBe('Hi @U123');
    });

    it('转换 *bold* 为 **bold**', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('This is *important*')).toBe('This is **important**');
    });

    it('转换 ~strike~ 为 ~~strike~~', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('This is ~removed~')).toBe('This is ~~removed~~');
    });

    it('转换 <#C123|general> 为 #general', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('See <#C123|general>')).toBe('See #general');
    });

    it('转换链接格式 <url|text> 为 text', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('Visit <https://example.com|here>')).toBe('Visit here');
    });

    it('转换纯链接 <url> 为 url', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.formatInbound('Visit <https://example.com>')).toBe('Visit https://example.com');
    });

    it('组合转换', () => {
      const adapter = new SlackAdapter(makeConfig());
      const input = '<@U123> *bold* ~strike~ <!here>';
      const result = adapter.formatInbound(input);
      expect(result).toBe('@U123 **bold** ~~strike~~ @here');
    });
  });

  describe('formatOutbound', () => {
    it('纯文本生成 section block', () => {
      const adapter = new SlackAdapter(makeConfig());
      const result = adapter.formatOutbound('Hello world') as { blocks: Array<{ type: string; text: { type: string; text: string } }> };
      expect(result.blocks).toBeDefined();
      expect(result.blocks[0].type).toBe('section');
      expect(result.blocks[0].text.type).toBe('mrkdwn');
      expect(result.blocks[0].text.text).toBe('Hello world');
    });

    it('代码块生成独立 section block', () => {
      const adapter = new SlackAdapter(makeConfig());
      const result = adapter.formatOutbound('Before\n```\ncode here\n```\nAfter') as { blocks: Array<{ type: string; text: { type: string; text: string } }> };
      expect(result.blocks).toBeDefined();
      expect(result.blocks.length).toBeGreaterThanOrEqual(2);
      // 代码块应包含 ``` 包裹
      const codeBlock = result.blocks.find(b => b.text.text.includes('code here'));
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.text.text).toContain('```');
    });

    it('空文本回退为纯文本字段', () => {
      const adapter = new SlackAdapter(makeConfig());
      const result = adapter.formatOutbound('   ') as { text: string };
      expect(result.text).toBeDefined();
    });
  });

  // ===== Webhook 解析 =====

  describe('parseWebhook', () => {
    it('正确解析 message 事件', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = JSON.stringify({
        event_id: 'Ev99999',
        event: {
          type: 'message',
          text: 'Hello *world*',
          user: 'U123',
          channel: 'C456',
          ts: '1700000000.000200',
          channel_type: 'channel',
        },
      });
      const msg = adapter.parseWebhook(body);
      expect(msg).not.toBeNull();
      expect(msg!.id).toBe('Ev99999');
      expect(msg!.channelType).toBe('slack');
      expect(msg!.sender.id).toBe('U123');
      expect(msg!.receiver.id).toBe('C456');
      expect(msg!.text).toBe('Hello **world**');
      expect(msg!.isGroup).toBe(true);
    });

    it('非 message 事件返回 null', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = JSON.stringify({
        event_id: 'Ev1',
        event: { type: 'reaction_added' },
      });
      expect(adapter.parseWebhook(body)).toBeNull();
    });

    it('重复 event_id 返回 null（去重）', () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = JSON.stringify({
        event_id: 'Ev001',
        event: { type: 'message', text: 'hi', user: 'U1', channel: 'C1', ts: '1700000000.000100' },
      });
      const first = adapter.parseWebhook(body);
      expect(first).not.toBeNull();
      // 第二次解析同一 event_id
      const second = adapter.parseWebhook(body);
      expect(second).toBeNull();
    });

    it('无效 JSON 返回 null', () => {
      const adapter = new SlackAdapter(makeConfig());
      expect(adapter.parseWebhook('not json')).toBeNull();
    });
  });

  // ===== handleWebhook 集成 =====

  describe('handleWebhook', () => {
    it('签名无效返回 401', async () => {
      const adapter = new SlackAdapter(makeConfig());
      const result = await adapter.handleWebhook('body', 'v0=invalid', String(Math.floor(Date.now() / 1000)));
      expect(result.status).toBe(401);
    });

    it('URL Verification 返回 challenge', async () => {
      const adapter = new SlackAdapter(makeConfig());
      const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = computeSignature('test-signing-secret', timestamp, body);
      const result = await adapter.handleWebhook(body, signature, timestamp);
      expect(result.status).toBe(200);
      expect((result.body as { challenge: string }).challenge).toBe('abc123');
    });

    it('有效消息触发 handler 并回复', async () => {
      const adapter = new SlackAdapter(makeConfig());
      const handler = vi.fn().mockResolvedValue('reply text');
      adapter.onMessage(handler);

      fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) });

      const body = JSON.stringify({
        event_id: 'Ev100',
        event: { type: 'message', text: 'hello', user: 'U1', channel: 'C1', ts: '1700000000.000100' },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = computeSignature('test-signing-secret', timestamp, body);

      const result = await adapter.handleWebhook(body, signature, timestamp);
      expect(result.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  // ===== sendResponse =====

  describe('sendResponse', () => {
    it('无 botToken 返回错误', async () => {
      const adapter = new SlackAdapter(makeConfig({ botToken: undefined }));
      const result = await adapter.sendResponse('C1', 'hello', false);
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing botToken');
    });

    it('API 返回 ok=true 时成功', async () => {
      const adapter = new SlackAdapter(makeConfig());
      fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) });
      const result = await adapter.sendResponse('C1', 'hello', false);
      expect(result.success).toBe(true);
    });

    it('API 返回 ok=false 时失败', async () => {
      const adapter = new SlackAdapter(makeConfig());
      fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'rate_limited' }) });
      const result = await adapter.sendResponse('C1', 'hello', false);
      expect(result.success).toBe(false);
      expect(result.error).toBe('rate_limited');
    });
  });

  // ===== getStatus =====

  it('getStatus 返回正确状态', async () => {
    const adapter = new SlackAdapter(makeConfig());
    await adapter.start();
    const status = adapter.getStatus();
    expect(status.type).toBe('slack');
    expect(status.running).toBe(true);
    expect(status.messagesProcessed).toBe(0);
  });
});
