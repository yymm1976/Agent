// tests/channels/telegram.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../../src/channels/adapters/telegram.js';

describe('TelegramAdapter', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not run without botToken', async () => {
    const adapter = new TelegramAdapter({
      id: 'tg1',
      type: 'telegram',
      enabled: true,
      options: {},
    });
    await adapter.start();
    expect(adapter.isRunning()).toBe(false);
  });

  it('runs with botToken', async () => {
    const adapter = new TelegramAdapter({
      id: 'tg1',
      type: 'telegram',
      enabled: true,
      options: { botToken: 'token' },
    });
    await adapter.start();
    expect(adapter.isRunning()).toBe(true);
    await adapter.stop();
    expect(adapter.isRunning()).toBe(false);
  });

  it('receives message and replies', async () => {
    const adapter = new TelegramAdapter({
      id: 'tg1',
      type: 'telegram',
      enabled: true,
      options: { botToken: 'token' },
    });

    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          result: [{
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: 100, type: 'private' },
              from: { id: 200, username: 'tester' },
              text: 'hello',
              date: 1700000000,
            },
          }],
        }),
      } as any)
      .mockResolvedValueOnce({
        json: async () => ({ ok: true }),
      } as any);

    const handler = vi.fn().mockResolvedValue('hi back');
    adapter.onMessage(handler);

    // @ts-ignore 访问私有方法测试
    await adapter.poll();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.telegram.org/bottoken/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('hi back'),
      }),
    );
  });

  it('filters unauthorized users', async () => {
    const adapter = new TelegramAdapter({
      id: 'tg1',
      type: 'telegram',
      enabled: true,
      options: { botToken: 'token', allowedUserIds: '200' },
    });

    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        ok: true,
        result: [{
          update_id: 1,
          message: {
            message_id: 10,
            chat: { id: 100, type: 'private' },
            from: { id: 999, username: 'stranger' },
            text: 'hello',
            date: 1700000000,
          },
        }],
      }),
    } as any);

    const handler = vi.fn();
    adapter.onMessage(handler);

    // @ts-ignore
    await adapter.poll();
    expect(handler).not.toHaveBeenCalled();
  });
});
