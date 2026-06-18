// src/channels/types.ts
// 渠道集成层类型定义

export type ChannelType = 'wechat-work' | 'telegram' | 'slack' | 'discord';

export interface ChannelMessage {
  /** 消息 ID（渠道侧） */
  id: string;
  /** 渠道类型 */
  channelType: ChannelType;
  /** 发送者 */
  sender: ChannelSender;
  /** 接收者（Bot 自身） */
  receiver: ChannelReceiver;
  /** 消息文本 */
  text: string;
  /** 是否群消息 */
  isGroup: boolean;
  /** 时间戳 */
  timestamp: number;
  /** 附件 */
  attachments?: ChannelAttachment[];
}

export interface ChannelSender {
  /** 用户 ID（渠道侧） */
  id: string;
  /** 显示名 */
  name?: string;
}

export interface ChannelReceiver {
  /** 频道/会话 ID */
  id: string;
  /** 显示名 */
  name?: string;
}

export interface ChannelAttachment {
  type: 'image' | 'file' | 'voice';
  url?: string;
  localPath?: string;
  mediaType?: string;
  data?: string;
}

export interface ChannelResponse {
  text: string;
  success: boolean;
  error?: string;
}

export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly config: ChannelConfig;

  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  onMessage(handler: ChannelMessageHandler): void;
  sendResponse(targetId: string, text: string, isGroup: boolean): Promise<ChannelResponse>;

  getStatus(): ChannelStatus;
}

/** 渠道处理器（由 MessageRouter 提供） */
export type ChannelMessageHandler = (message: ChannelMessage) => Promise<string>;

/** 渠道状态 */
export interface ChannelStatus {
  type: ChannelType;
  running: boolean;
  messagesProcessed: number;
  lastMessageAt?: number;
  error?: string;
}

/** 渠道配置（运行时） */
export interface ChannelConfig {
  /** 渠道 ID */
  id: string;
  /** 渠道类型 */
  type: ChannelType;
  /** 是否启用 */
  enabled: boolean;
  /** 渠道特定配置（access_token, corpid 等） */
  options: Record<string, string>;
}