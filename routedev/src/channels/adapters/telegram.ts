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
    pollIntervalMs?: number;
    /** 仅响应该列表中的用户 ID（可选，逗号分隔） */
    allowedUserIds?: string;
  };
}

// S10：Telegram botToken 格式校验（数字:字母数字_-= 组合，长度 ≥ 35）
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
// Telegram API 合法 hostname
const TELEGRAM_API_HOST = 'api.telegram.org';

/** S10：校验 botToken 格式并构造安全的 API URL */
function buildTelegramApiUrl(token: string, endpoint: string, query?: string): string {
  if (!BOT_TOKEN_PATTERN.test(token)) {
    throw new Error(`Invalid botToken format: expected "<numeric>:<alphanumeric>" (≥35 chars), got length=${token.length}`);
  }
  const url = new URL(`https://${TELEGRAM_API_HOST}/bot${token}/${endpoint}`);
  if (query) url.search = query;
  // 防止 token 中嵌入路径穿越或主机重定向
  if (url.hostname !== TELEGRAM_API_HOST) {
    throw new Error(`Invalid Telegram API hostname: ${url.hostname}`);
  }
  return url.toString();
}

/**
 * 带超时的 fetch 封装：使用 AbortController 在指定毫秒后中止请求
 * 防止网络挂起导致长轮询堆积或进程无法退出
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  /** 轮询间隔毫秒，start() 时初始化 */
  private pollIntervalMs = 1000;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.options.botToken) {
      logger.warn('TelegramAdapter: missing botToken');
      return;
    }
    // S10：校验 botToken 格式
    try {
      buildTelegramApiUrl(this.config.options.botToken, 'getMe');
    } catch (err) {
      logger.error('TelegramAdapter: invalid botToken, refusing to start', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // 安全修复：生产环境强制要求配置 allowedUserIds，防止 bot 公网暴露后任意人可调用
    // 原行为 allowedUserIds 可选，未配置时任何 Telegram 用户都可触发 Agent 执行 shell 命令
    if (process.env.NODE_ENV === 'production') {
      const allowed = this.parseAllowedUserIds();
      if (allowed.length === 0) {
        logger.error('TelegramAdapter: 生产环境未配置 allowedUserIds，拒绝启动（防止未授权访问）。请在配置中设置 allowedUserIds 或切换到开发模式。');
        return;
      }
    } else {
      const allowed = this.parseAllowedUserIds();
      if (allowed.length === 0) {
        logger.warn('TelegramAdapter: 开发模式未配置 allowedUserIds，任何用户可访问（仅开发环境允许）');
      }
    }
    this.running = true;
    // B7：pollIntervalMs 已改为 number 类型，直接使用
    const interval = this.config.options.pollIntervalMs ?? 1000;
    this.pollIntervalMs = Number.isFinite(interval) && interval > 0 ? interval : 1000;
    if (!Number.isFinite(interval) || interval <= 0) {
      logger.warn('TelegramAdapter: invalid pollIntervalMs, fallback to 1000', { value: this.config.options.pollIntervalMs });
    }
    // 改用递归 setTimeout：确保上一次 poll() 完成后才调度下一次，避免长轮询堆积
    this.schedulePoll();
    logger.info('TelegramAdapter started');
  }

  /**
   * 递归调度下一次轮询：在上一次 poll() 完成后才设置下一个 setTimeout
   * 避免 setInterval 在 poll 耗时较长时导致多个 poll 重叠执行
   */
  private schedulePoll(): void {
    this.pollTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.poll();
      } finally {
        // 仅在仍在运行时调度下一次，stop() 后不再调度
        if (this.running) this.schedulePoll();
      }
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
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
      // S10：使用统一 URL 构造器，校验 token 格式与 hostname
      const url = buildTelegramApiUrl(token, 'sendMessage');
      const response = await fetchWithTimeout(url, {
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
      // S10：使用统一 URL 构造器
      const url = buildTelegramApiUrl(token, 'getUpdates', `offset=${this.offset}&limit=10`);
      const response = await fetchWithTimeout(url);
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
