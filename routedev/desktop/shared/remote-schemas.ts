// RouteDev Remote v1 运行时校验器。
// 所有对象允许未知字段，确保新增字段不会破坏旧客户端；必填字段和枚举保持严格。

import { z } from 'zod';
import {
  REMOTE_DEVICE_SCOPES,
  REMOTE_ERROR_CODES,
  REMOTE_EVENT_TYPES,
  REMOTE_PROTOCOL_VERSION,
} from './remote-protocol.js';

const identifierSchema = z.string().trim().min(1).max(256);
const timestampSchema = z.string().min(1).refine(
  (value) => Number.isFinite(Date.parse(value)),
  'timestamp must be ISO-8601 compatible',
);
const sequenceSchema = z.number().int().positive();
const recordSchema = z.record(z.string(), z.unknown());

export const RemoteErrorCodeSchema = z.enum(REMOTE_ERROR_CODES);
export const RemoteDeviceScopeSchema = z.enum(REMOTE_DEVICE_SCOPES);
export const RemoteEventTypeSchema = z.enum(REMOTE_EVENT_TYPES);
export const RemoteAutonomyModeSchema = z.enum(['auto', 'semi', 'manual']);
export const RemoteSessionStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
]);

export const RemoteErrorSchema = z.object({
  code: RemoteErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: recordSchema.optional(),
}).passthrough();

export function createRemoteApiResponseSchema<T extends z.ZodTypeAny>(payloadSchema: T) {
  return z.object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    requestId: identifierSchema,
    timestamp: timestampSchema,
    sessionId: identifierSchema.nullable(),
    turnId: identifierSchema.nullable(),
    ok: z.boolean(),
    payload: payloadSchema.nullable(),
    error: RemoteErrorSchema.nullable(),
  }).passthrough().superRefine((value, ctx) => {
    if (value.ok && value.error !== null) {
      ctx.addIssue({ code: 'custom', message: 'successful response cannot contain error' });
    }
    if (!value.ok && value.error === null) {
      ctx.addIssue({ code: 'custom', message: 'failed response must contain error' });
    }
  });
}

export const RemoteHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  desktopName: z.string().min(1),
  gatewayVersion: z.string().min(1),
  engineAvailable: z.boolean(),
}).passthrough();

export const RemoteCapabilitiesSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  eventTypes: z.array(RemoteEventTypeSchema),
  deviceScopes: z.array(RemoteDeviceScopeSchema),
  supportsImages: z.boolean(),
  maxImageCount: z.number().int().nonnegative(),
  maxImageBytes: z.number().int().nonnegative(),
}).passthrough();

export const RemotePairRequestSchema = z.object({
  pairingId: identifierSchema,
  secret: z.string().min(22).max(512),
  deviceId: identifierSchema,
  deviceName: z.string().trim().min(1).max(120),
  requestedScopes: z.array(RemoteDeviceScopeSchema),
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
}).passthrough();

export const RemotePairResponseSchema = z.object({
  deviceId: identifierSchema,
  deviceToken: z.string().min(32),
  grantedScopes: z.array(RemoteDeviceScopeSchema),
  desktopName: z.string().min(1),
  baseUrl: z.string().url(),
}).passthrough();

export const RemoteDeviceSchema = z.object({
  deviceId: identifierSchema,
  deviceName: z.string().min(1),
  scopes: z.array(RemoteDeviceScopeSchema),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
}).passthrough();

export const RemoteSessionSummarySchema = z.object({
  sessionId: identifierSchema,
  title: z.string(),
  status: RemoteSessionStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  activeTurnId: identifierSchema.nullable(),
  lastSequence: z.number().int().nonnegative(),
}).passthrough();

export const RemoteSessionDetailSchema = RemoteSessionSummarySchema.extend({
  projectId: identifierSchema.nullable(),
  projectName: z.string().nullable(),
  latestResult: z.string().nullable(),
  ownerDeviceId: identifierSchema.optional(),
  acl: z.array(z.object({
    deviceId: identifierSchema,
    access: z.enum(['reader', 'operator']),
    grantedAt: timestampSchema,
  }).passthrough()).optional(),
}).passthrough();

export const RemoteCreateSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  projectId: identifierSchema.optional(),
  clientSessionId: identifierSchema,
}).passthrough();

export const RemoteCreateSessionResponseSchema = z.object({
  session: RemoteSessionDetailSchema,
  clientSessionId: identifierSchema,
}).passthrough();

export const RemoteImageInputSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataBase64: z.string().min(1),
  filename: z.string().max(255).optional(),
}).passthrough();

export const RemoteSendMessageRequestSchema = z.object({
  text: z.string().max(200_000),
  images: z.array(RemoteImageInputSchema).max(8).optional(),
  skillIds: z.array(identifierSchema).max(64).optional(),
  mcpServerIds: z.array(identifierSchema).max(64).optional(),
  allowedToolNames: z.array(identifierSchema).max(256).optional(),
  autonomyMode: RemoteAutonomyModeSchema.optional(),
  clientMessageId: identifierSchema,
}).passthrough().refine(
  (value) => value.text.trim().length > 0 || (value.images?.length ?? 0) > 0,
  'message requires text or image',
);

export const RemoteSendMessageResponseSchema = z.object({
  sessionId: identifierSchema,
  turnId: identifierSchema,
  clientMessageId: identifierSchema,
  acceptedAt: timestampSchema,
  duplicate: z.boolean(),
}).passthrough();

export const RemoteStopTaskRequestSchema = z.object({
  turnId: identifierSchema.optional(),
  reason: z.string().max(500).optional(),
}).passthrough();

export const RemoteApprovalResolveRequestSchema = z.object({
  approved: z.boolean(),
  payload: z.unknown().optional(),
}).passthrough();

export const RemoteSkillSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
  description: z.string(),
  source: z.string().min(1),
  enabled: z.boolean(),
}).passthrough();

export const RemoteMcpServerSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
  connected: z.boolean(),
  toolCount: z.number().int().nonnegative(),
}).passthrough();

export const RemoteToolSchema = z.object({
  name: identifierSchema,
  description: z.string(),
  source: z.enum(['builtin', 'mcp']),
  mcpServerId: identifierSchema.nullable(),
  allowed: z.boolean(),
}).passthrough();

export const RemoteTodoItemSchema = z.object({
  id: identifierSchema,
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['low', 'medium', 'high']).optional(),
}).passthrough();

export const RemoteApprovalSchema = z.object({
  approvalId: identifierSchema,
  toolName: identifierSchema,
  summary: z.string(),
  expiresAt: timestampSchema,
  canResolveRemotely: z.boolean(),
}).passthrough();

const eventEnvelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) => z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  eventId: identifierSchema,
  timestamp: timestampSchema,
  sessionId: identifierSchema,
  turnId: identifierSchema.nullable(),
  sequence: sequenceSchema,
  type: z.literal(type),
  payload,
}).passthrough();

export const RemoteEventEnvelopeSchema = z.discriminatedUnion('type', [
  eventEnvelope('session.created', z.object({ session: RemoteSessionSummarySchema }).passthrough()),
  eventEnvelope('session.updated', z.object({ session: RemoteSessionSummarySchema }).passthrough()),
  eventEnvelope('turn.queued', z.object({
    clientMessageId: identifierSchema,
    position: z.number().int().nonnegative(),
  }).passthrough()),
  eventEnvelope('turn.started', z.object({
    clientMessageId: identifierSchema,
    userText: z.string(),
  }).passthrough()),
  eventEnvelope('assistant.text.delta', z.object({ text: z.string() }).passthrough()),
  eventEnvelope('assistant.reasoning.delta', z.object({
    text: z.string(),
    visibility: z.literal('provider_returned'),
  }).passthrough()),
  eventEnvelope('assistant.progress', z.object({
    text: z.string().min(1),
    source: z.enum(['model', 'engine']),
  }).passthrough()),
  eventEnvelope('tool.started', z.object({
    toolCallId: identifierSchema,
    toolName: identifierSchema,
    argsSummary: z.string().nullable(),
  }).passthrough()),
  eventEnvelope('tool.output.delta', z.object({
    toolCallId: identifierSchema,
    delta: z.string(),
  }).passthrough()),
  eventEnvelope('tool.completed', z.object({
    toolCallId: identifierSchema,
    outputSummary: z.string().nullable(),
  }).passthrough()),
  eventEnvelope('tool.failed', z.object({
    toolCallId: identifierSchema,
    error: RemoteErrorSchema,
  }).passthrough()),
  eventEnvelope('todo.replaced', z.object({
    items: z.array(RemoteTodoItemSchema),
  }).passthrough()),
  eventEnvelope('todo.updated', z.object({
    item: RemoteTodoItemSchema,
  }).passthrough()),
  eventEnvelope('approval.required', z.object({
    approval: RemoteApprovalSchema,
  }).passthrough()),
  eventEnvelope('approval.resolved', z.object({
    approvalId: identifierSchema,
    approved: z.boolean(),
    resolvedBy: z.enum(['desktop', 'android']),
  }).passthrough()),
  eventEnvelope('turn.completed', z.object({
    finishReason: z.string(),
    completionStatus: z.string().nullable(),
  }).passthrough()),
  eventEnvelope('turn.failed', z.object({ error: RemoteErrorSchema }).passthrough()),
  eventEnvelope('task.completed', z.object({ summary: z.string() }).passthrough()),
  eventEnvelope('task.failed', z.object({ error: RemoteErrorSchema }).passthrough()),
  eventEnvelope('connection.notice', z.object({
    level: z.enum(['info', 'warning', 'error']),
    message: z.string(),
    code: z.string().nullable(),
  }).passthrough()),
]);

export const RemoteTimelineResponseSchema = z.object({
  events: z.array(RemoteEventEnvelopeSchema),
  nextSequence: z.number().int().positive(),
}).passthrough();

export const RemoteRestSchemaMap = {
  pairRequest: RemotePairRequestSchema,
  createSessionRequest: RemoteCreateSessionRequestSchema,
  sendMessageRequest: RemoteSendMessageRequestSchema,
  stopTaskRequest: RemoteStopTaskRequestSchema,
  approvalResolveRequest: RemoteApprovalResolveRequestSchema,
  healthResponse: createRemoteApiResponseSchema(RemoteHealthSchema),
  capabilitiesResponse: createRemoteApiResponseSchema(RemoteCapabilitiesSchema),
  pairResponse: createRemoteApiResponseSchema(RemotePairResponseSchema),
  devicesResponse: createRemoteApiResponseSchema(z.array(RemoteDeviceSchema)),
  sessionsResponse: createRemoteApiResponseSchema(z.array(RemoteSessionSummarySchema)),
  createSessionResponse: createRemoteApiResponseSchema(RemoteCreateSessionResponseSchema),
  sessionResponse: createRemoteApiResponseSchema(RemoteSessionDetailSchema),
  timelineResponse: createRemoteApiResponseSchema(RemoteTimelineResponseSchema),
  sendMessageResponse: createRemoteApiResponseSchema(RemoteSendMessageResponseSchema),
  emptyResponse: createRemoteApiResponseSchema(z.object({}).passthrough()),
  skillsResponse: createRemoteApiResponseSchema(z.array(RemoteSkillSchema)),
  mcpServersResponse: createRemoteApiResponseSchema(z.array(RemoteMcpServerSchema)),
  toolsResponse: createRemoteApiResponseSchema(z.array(RemoteToolSchema)),
  errorResponse: createRemoteApiResponseSchema(z.unknown()),
} as const;

export type RemoteRestSchemaName = keyof typeof RemoteRestSchemaMap;
