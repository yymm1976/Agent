// src/channels/adapters/wechat-work.ts
// WeChatWorkAdapter：企业微信适配器
// 实现 ChannelAdapter 接口，验证签名、解密消息、发送回复

import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelResponse, ChannelMessageHandler, ChannelStatus, ChannelType } from '../types.js';
import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';

export interface WeChatWorkConfig extends ChannelConfig {
  type: 'wechat-work';
  options: {
    corpId?: string;
    corpSecret?: string;
    agentId?: string;
    token?: string;
    encodingAESKey?: string;
  };
}

/**
 * 带超时的 fetch 封装：使用 AbortController 在指定毫秒后中止请求
 * 防止企业微信 API 网络挂起导致调用方无限等待
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

export class WeChatWorkAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'wechat-work';
  readonly config: WeChatWorkConfig;
  private messageHandler: ChannelMessageHandler | null = null;
  private messagesProcessed = 0;
  private lastMessageAt: number | undefined;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private aesKey: Buffer | null = null;

  constructor(config: WeChatWorkConfig) {
    this.config = config;
    // C11 修复：支持从环境变量读取密钥，代码中不硬编码任何密钥
    // 配置优先，环境变量作为后备
    const aesKey = config.options.encodingAESKey ?? process.env.WECOM_ENCODING_AES_KEY;
    if (aesKey) {
      // EncodingAESKey 是 Base64 编码的 43 字符，解码后是 32 字节密钥
      this.aesKey = Buffer.from(aesKey + '=', 'base64');
    }
  }

  async start(): Promise<void> {
    logger.info('WeChatWorkAdapter started', {
      corpId: this.config.options.corpId ? '***' : '(missing)',
      agentId: this.config.options.agentId,
    });
  }

  async stop(): Promise<void> {
    this.accessToken = null;
    logger.info('WeChatWorkAdapter stopped');
  }

  isRunning(): boolean {
    // C11 修复：支持从环境变量读取 corpId/corpSecret
    return !!(this.config.options.corpId ?? process.env.WECOM_CORP_ID)
      && !!(this.config.options.corpSecret ?? process.env.WECOM_CORP_SECRET);
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  async sendResponse(targetId: string, text: string, isGroup: boolean): Promise<ChannelResponse> {
    if (!this.messageHandler) {
      return { text: '', success: false, error: 'no handler' };
    }

    // 调用企业微信 API 实际发送消息（isGroup 参数保留以匹配接口签名，企业微信当前仅支持单聊推送）
    void isGroup; // eslint-disable-line @typescript-eslint/no-unused-expressions
    const ok = await this.sendToUser(targetId, text);
    this.messagesProcessed++;
    this.lastMessageAt = Date.now();
    if (!ok) {
      return { text: '', success: false, error: '企业微信 API 发送失败' };
    }
    return { text, success: true };
  }

  getStatus(): ChannelStatus {
    return {
      type: this.type,
      running: this.isRunning(),
      messagesProcessed: this.messagesProcessed,
      lastMessageAt: this.lastMessageAt,
    };
  }

  /** 验证企业微信签名 */
  verifySignature(body: string, signature: string, timestamp: string): boolean {
    // C11 修复：Token 优先从配置读取，其次从环境变量读取，代码中不硬编码任何密钥
    const token = this.config.options.token ?? process.env.WECOM_WEBHOOK_TOKEN;
    if (!token) {
      // 生产模式：签名密钥未配置时拒绝请求，避免静默放行
      // 开发模式：降级放行（保留开发便利），但记录警告
      if (process.env.NODE_ENV === 'production') {
        logger.error('WeChatWork webhook token 未配置，生产模式拒绝处理请求');
        return false;
      }
      logger.warn('WeChatWork webhook token 未配置，开发模式放行（不安全）');
      return true;
    }

    // 企业微信签名算法：sha1(token + timestamp + body)
    const expected = crypto
      .createHash('sha1')
      .update(token)
      .update(timestamp)
      .update(body)
      .digest('hex');

    // 使用 timingSafeEqual 防止时序攻击
    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  }

  /** 解密企业微信消息（如果需要） */
  decryptMessage(encrypted: string): string {
    if (!this.aesKey) {
      return encrypted; // 未配置 AES key，直接返回原文
    }

    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.aesKey.slice(0, 16));
      let decrypted = decipher.update(encrypted, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      // 严格验证 PKCS#7 padding（防止 padding oracle 攻击）
      // AES 块大小为 16 字节，padding 长度范围为 1-16
      const padLen = decrypted.charCodeAt(decrypted.length - 1);
      if (padLen < 1 || padLen > 16) {
        throw new Error('Invalid PKCS#7 padding: out of range');
      }
      // 严格验证：最后 padLen 个字节必须全部等于 padLen
      for (let i = 0; i < padLen; i++) {
        if (decrypted.charCodeAt(decrypted.length - 1 - i) !== padLen) {
          throw new Error('Invalid PKCS#7 padding: inconsistent bytes');
        }
      }
      decrypted = decrypted.slice(0, decrypted.length - padLen);
      return decrypted;
    } catch (error) {
      logger.warn('WeChatWork: decrypt failed', { error: String(error) });
      // Minor 修复：解密失败返回空字符串而非密文，避免后续 XML 解析异常
      return '';
    }
  }

  /** 解析企业微信 XML 消息 */
  parseWebhook(body: string): ChannelMessage | null {
    const decrypted = this.decryptMessage(body);

    // 提取关键字段（XML 格式：<xml><Content>...</Content><FromUserName>...</FromUserName></xml>）
    const extract = (tag: string): string => {
      const match = decrypted.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's'));
      return match ? match[1] : '';
    };

    const content = extract('Content');
    const fromUser = extract('FromUserName');
    const toUser = extract('ToUserName');
    const msgId = extract('MsgId');
    // parseInt NaN 防护：CreateTime 缺失或非数字时使用当前时间戳
    const rawCreateTime = parseInt(extract('CreateTime'), 10);
    const createTime = isNaN(rawCreateTime) ? Math.floor(Date.now() / 1000) : rawCreateTime;

    if (!content || !fromUser) {
      return null;
    }

    return {
      id: msgId || `${fromUser}-${Date.now()}`,
      channelType: 'wechat-work',
      sender: { id: fromUser, name: fromUser },
      receiver: { id: toUser, name: toUser },
      text: content,
      isGroup: false,
      timestamp: createTime ? createTime * 1000 : Date.now(),
    };
  }

  /** 触发消息处理（由外部调用） */
  async triggerMessage(message: ChannelMessage): Promise<string> {
    if (!this.messageHandler) {
      throw new Error('no handler registered');
    }
    this.messagesProcessed++;
    this.lastMessageAt = Date.now();
    return await this.messageHandler(message);
  }

  /** 获取 access_token（带缓存） */
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 5 * 60 * 1000) {
      return this.accessToken;
    }
    return null; // 需要调用 refreshAccessToken
  }

  /** 刷新 access_token（实际调用企业微信 API） */
  async refreshAccessToken(): Promise<string | null> {
    // C11 修复：支持从环境变量读取 corpId/corpSecret，代码中不硬编码
    const corpId = this.config.options.corpId ?? process.env.WECOM_CORP_ID;
    const corpSecret = this.config.options.corpSecret ?? process.env.WECOM_CORP_SECRET;
    if (!corpId || !corpSecret) return null;

    // 脱敏日志：不记录完整 URL（含 corpSecret）
    logger.debug('Refreshing access token', { corpId: corpId ? '***' : '(missing)' });

    try {
      // 实际生产环境使用 fetch
      // 注意：企业微信 API 仅支持 GET query 传参，无法改用 POST body
      // 确保所有错误处理路径不记录完整 URL
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
      const response = await fetchWithTimeout(url);
      const data = await response.json() as { access_token?: string; expires_in?: number; errcode?: number };

      if (data.access_token && data.expires_in) {
        this.accessToken = data.access_token;
        this.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
        return this.accessToken;
      }
      // 错误日志不含 URL，仅记录 errcode
      logger.warn('WeChatWork: gettoken failed', { errcode: data.errcode });
      return null;
    } catch (error) {
      // 错误日志不含 URL 或 corpSecret，仅记录错误类型
      const errMsg = error instanceof Error ? error.message : String(error);
      const sanitized = errMsg.replace(/corpsecret=[^&]+/g, 'corpsecret=***');
      logger.error('WeChatWork: refreshAccessToken error', { error: sanitized });
      return null;
    }
  }

  /** 发送消息到企业微信（实际调用 API） */
  async sendToUser(userId: string, text: string): Promise<boolean> {
    let token = await this.getAccessToken();
    if (!token) {
      token = await this.refreshAccessToken();
      if (!token) return false;
    }

    const agentId = this.config.options.agentId;
    if (!agentId) return false;
    // parseInt NaN 防护：agentId 非数字时使用 0（企业微信会返回错误，但不会崩溃）
    const rawAgentId = parseInt(agentId, 10);
    const agentIdNum = isNaN(rawAgentId) ? 0 : rawAgentId;

    try {
      const response = await fetchWithTimeout(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: userId,
            msgtype: 'text',
            agentid: agentIdNum,
            text: { content: text },
          }),
        },
      );
      const data = await response.json() as { errcode?: number; errmsg?: string };
      return data.errcode === 0;
    } catch (error) {
      logger.error('WeChatWork: sendToUser error', { error: String(error) });
      return false;
    }
  }
}
