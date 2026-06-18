// src/channels/adapters/telegram.ts
// Telegram Bot Adapter（长轮询模式）

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelResponse,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelType,
} from '../types.js';
import { logger } from '../../utils/logger.js';

export interface TelegramConfig extends ChannelConfig {
  type: 'telegram';
  options: {
    botToken?: string;
    /** 轮询间隔毫秒（默认 1000） */
    pollIntervalMs?: string;
    /** 仅响应该列表中的用户 ID（可选，逗号分隔） */
    allowedUserIds?: string;
  };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'telegram';
  readonly config: TelegramConfig;
  private messageHandler: ChannelMessageHandler | null = null;
  private messagesProcessed = 0;
  private lastMessageAt: number | undefined;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private offset = 0;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.options.botToken) {
      logger.warn('TelegramAdapter: missing botToken');
      return;
    }
    this.running = true;
    const interval = parseInt(this.config.options.pollIntervalMs ?? '1000', 10);
    this.pollTimer = setInterval(() => this.poll(), interval);
    logger.info('TelegramAdapter started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('TelegramAdapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  async sendResponse(targetId: string, text: string, _isGroup: boolean): Promise<ChannelResponse> {
    const token = this.config.options.botToken;
    if (!token) {
      return { text: '', success: false, error: 'missing botToken' };
    }

    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: targetId, text: this.truncate(text) }),
      });
      const data = (await response.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        return { text, success: false, error: data.description ?? 'send failed' };
      }
      return { text, success: true };
    } catch (error) {
      return { text, success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  getStatus(): ChannelStatus {
    return {
      type: this.type,
      running: this.isRunning(),
      messagesProcessed: this.messagesProcessed,
      lastMessageAt: this.lastMessageAt,
    };
  }

  private async poll(): Promise<void> {
    const token = this.config.options.botToken;
    if (!token || !this.messageHandler) return;

    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${this.offset}&limit=10`;
      const response = await fetch(url);
      const data = (await response.json()) as {
        ok: boolean;
        result?: Array<{
          update_id: number;
          message?: {
            message_id: number;
            chat: { id: number; type: string };
            from?: { id: number; username?: string };
            text?: string;
            date: number;
          };
        }>;
      };

      if (!data.ok || !data.result) return;

      const allowed = this.parseAllowedUserIds();

      for (const update of data.result) {
        this.offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const userId = String(msg.from?.id ?? '');
        if (allowed.length > 0 && !allowed.includes(userId)) {
          logger.info('TelegramAdapter: ignored message from unauthorized user', { userId });
          continue;
        }

        const channelMessage: ChannelMessage = {
          id: String(msg.message_id),
          channelType: 'telegram',
          sender: {
            id: userId,
            name: msg.from?.username,
          },
          receiver: { id: String(msg.chat.id) },
          text: msg.text,
          isGroup: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
          timestamp: msg.date * 1000,
        };

        this.messagesProcessed++;
        this.lastMessageAt = Date.now();
        try {
          const reply = await this.messageHandler(channelMessage);
          await this.sendResponse(String(msg.chat.id), reply, channelMessage.isGroup);
        } catch (error) {
          logger.error('TelegramAdapter: handle message failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn('TelegramAdapter: poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private parseAllowedUserIds(): string[] {
    const raw = this.config.options.allowedUserIds;
    return raw ? raw.split(',').map(s => s.trim()) : [];
  }

  private truncate(text: string, maxLength = 4000): string {
    return text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text;
  }
}
