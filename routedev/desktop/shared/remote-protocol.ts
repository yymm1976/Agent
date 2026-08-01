// RouteDev Remote v1 协议类型。
// 本文件只包含可序列化类型与稳定常量，不依赖 Electron、Node HTTP 或业务实现。

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_DEFAULT_PORT = 43117 as const;

export const REMOTE_API_ROUTES = {
  health: { method: 'GET', path: '/v1/health' },
  capabilities: { method: 'GET', path: '/v1/capabilities' },
  pair: { method: 'POST', path: '/v1/pair' },
  devices: { method: 'GET', path: '/v1/devices' },
  revokeDevice: { method: 'DELETE', path: '/v1/devices/{deviceId}' },
  sessions: { method: 'GET', path: '/v1/sessions' },
  createSession: { method: 'POST', path: '/v1/sessions' },
  session: { method: 'GET', path: '/v1/sessions/{sessionId}' },
  timeline: { method: 'GET', path: '/v1/sessions/{sessionId}/timeline' },
  sendMessage: { method: 'POST', path: '/v1/sessions/{sessionId}/messages' },
  stopTask: { method: 'POST', path: '/v1/sessions/{sessionId}/stop' },
  resolveApproval: { method: 'POST', path: '/v1/approvals/{approvalId}/resolve' },
  skills: { method: 'GET', path: '/v1/skills' },
  mcpServers: { method: 'GET', path: '/v1/mcp/servers' },
  tools: { method: 'GET', path: '/v1/tools' },
  events: { method: 'GET', path: '/v1/events' },
} as const;

export const REMOTE_ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_REVOKED',
  'PAIRING_EXPIRED',
  'PAIRING_INVALID',
  'SCOPE_DENIED',
  'SESSION_NOT_FOUND',
  'SESSION_BUSY',
  'SKILL_NOT_AVAILABLE',
  'MCP_NOT_AVAILABLE',
  'TOOL_NOT_ALLOWED',
  'APPROVAL_EXPIRED',
  'CONFLICT',
  'RATE_LIMITED',
  'ENGINE_UNAVAILABLE',
  'PROTOCOL_MISMATCH',
] as const;

export type RemoteErrorCode = typeof REMOTE_ERROR_CODES[number];

export const REMOTE_DEVICE_SCOPES = [
  'sessions:read',
  'messages:send',
  'tasks:stop',
  'approvals:resolve',
  'skills:select',
  'mcp:select',
  'autonomy:change',
] as const;

export type RemoteDeviceScope = typeof REMOTE_DEVICE_SCOPES[number];

export const REMOTE_EVENT_TYPES = [
  'session.created',
  'session.updated',
  'turn.started',
  'assistant.text.delta',
  'assistant.reasoning.delta',
  'assistant.progress',
  'tool.started',
  'tool.output.delta',
  'tool.completed',
  'tool.failed',
  'todo.replaced',
  'todo.updated',
  'approval.required',
  'approval.resolved',
  'turn.completed',
  'turn.failed',
  'task.completed',
  'task.failed',
  'connection.notice',
] as const;

export type RemoteEventType = typeof REMOTE_EVENT_TYPES[number];
export type RemoteAutonomyMode = 'auto' | 'semi' | 'manual';
export type RemoteSessionStatus = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed';
export type RemoteTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface RemoteError {
  code: RemoteErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface RemoteApiResponse<T> {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  requestId: string;
  timestamp: string;
  sessionId: string | null;
  turnId: string | null;
  ok: boolean;
  payload: T | null;
  error: RemoteError | null;
}

export interface RemoteEventEnvelope<TType extends RemoteEventType = RemoteEventType, TPayload = unknown> {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  eventId: string;
  timestamp: string;
  sessionId: string;
  turnId: string | null;
  sequence: number;
  type: TType;
  payload: TPayload;
}

export interface RemoteHealth {
  status: 'ok' | 'degraded';
  desktopName: string;
  gatewayVersion: string;
  engineAvailable: boolean;
}

export interface RemoteCapabilities {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  eventTypes: RemoteEventType[];
  deviceScopes: RemoteDeviceScope[];
  supportsImages: boolean;
  maxImageCount: number;
  maxImageBytes: number;
}

export interface RemotePairRequest {
  pairingId: string;
  secret: string;
  deviceId: string;
  deviceName: string;
  requestedScopes: RemoteDeviceScope[];
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
}

export interface RemotePairResponse {
  deviceId: string;
  deviceToken: string;
  grantedScopes: RemoteDeviceScope[];
  desktopName: string;
  baseUrl: string;
}

export interface RemoteDevice {
  deviceId: string;
  deviceName: string;
  scopes: RemoteDeviceScope[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface RemoteSessionSummary {
  sessionId: string;
  title: string;
  status: RemoteSessionStatus;
  createdAt: string;
  updatedAt: string;
  activeTurnId: string | null;
  lastSequence: number;
}

export interface RemoteSessionDetail extends RemoteSessionSummary {
  projectId: string | null;
  projectName: string | null;
  latestResult: string | null;
}

export interface RemoteCreateSessionRequest {
  title?: string;
  projectId?: string;
  clientSessionId: string;
}

export interface RemoteCreateSessionResponse {
  session: RemoteSessionDetail;
  clientSessionId: string;
}

export interface RemoteImageInput {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;
  filename?: string;
}

export interface RemoteSendMessageRequest {
  text: string;
  images?: RemoteImageInput[];
  skillIds?: string[];
  mcpServerIds?: string[];
  allowedToolNames?: string[];
  autonomyMode?: RemoteAutonomyMode;
  clientMessageId: string;
}

export interface RemoteSendMessageResponse {
  sessionId: string;
  turnId: string;
  clientMessageId: string;
  acceptedAt: string;
  duplicate: boolean;
}

export interface RemoteStopTaskRequest {
  turnId?: string;
  reason?: string;
}

export interface RemoteApprovalResolveRequest {
  approved: boolean;
  payload?: unknown;
}

export interface RemoteSkill {
  id: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
}

export interface RemoteMcpServer {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
}

export interface RemoteTool {
  name: string;
  description: string;
  source: 'builtin' | 'mcp';
  mcpServerId: string | null;
  allowed: boolean;
}

export interface RemoteTodoItem {
  id: string;
  content: string;
  status: RemoteTodoStatus;
  priority?: 'low' | 'medium' | 'high';
}

export interface RemoteApproval {
  approvalId: string;
  toolName: string;
  summary: string;
  expiresAt: string;
  canResolveRemotely: boolean;
}

export interface RemoteEventPayloadMap {
  'session.created': { session: RemoteSessionSummary };
  'session.updated': { session: RemoteSessionSummary };
  'turn.started': { clientMessageId: string; userText: string };
  'assistant.text.delta': { text: string };
  'assistant.reasoning.delta': { text: string; visibility: 'provider_returned' };
  'assistant.progress': { text: string; source: 'model' | 'engine' };
  'tool.started': { toolCallId: string; toolName: string; argsSummary: string | null };
  'tool.output.delta': { toolCallId: string; delta: string };
  'tool.completed': { toolCallId: string; outputSummary: string | null };
  'tool.failed': { toolCallId: string; error: RemoteError };
  'todo.replaced': { items: RemoteTodoItem[] };
  'todo.updated': { item: RemoteTodoItem };
  'approval.required': { approval: RemoteApproval };
  'approval.resolved': { approvalId: string; approved: boolean; resolvedBy: 'desktop' | 'android' };
  'turn.completed': { finishReason: string; completionStatus: string | null };
  'turn.failed': { error: RemoteError };
  'task.completed': { summary: string };
  'task.failed': { error: RemoteError };
  'connection.notice': { level: 'info' | 'warning' | 'error'; message: string; code: string | null };
}

export type AnyRemoteEvent = {
  [K in RemoteEventType]: RemoteEventEnvelope<K, RemoteEventPayloadMap[K]>;
}[RemoteEventType];

export interface RemoteTimelineResponse {
  events: AnyRemoteEvent[];
  nextSequence: number;
}

/**
 * 校验已经反序列化的事件是否能组成严格有序、无重复的单会话时间线。
 * 网络层和本地数据库都使用相同语义：sequence 是唯一排序依据。
 */
export function validateRemoteEventSequence(events: readonly RemoteEventEnvelope[]): string[] {
  const errors: string[] = [];
  const eventIds = new Set<string>();
  let previousSequence = 0;
  let sessionId: string | null = null;

  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      errors.push(`duplicate eventId: ${event.eventId}`);
    }
    eventIds.add(event.eventId);

    if (sessionId === null) sessionId = event.sessionId;
    if (event.sessionId !== sessionId) {
      errors.push(`mixed sessionId: ${event.sessionId}`);
    }
    if (event.sequence <= previousSequence) {
      errors.push(`sequence must increase: ${previousSequence} -> ${event.sequence}`);
    }
    previousSequence = event.sequence;
  }
  return errors;
}
