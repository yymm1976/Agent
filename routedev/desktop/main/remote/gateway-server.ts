import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { z, type ZodType } from 'zod';
import {
  REMOTE_DEVICE_SCOPES,
  REMOTE_EVENT_TYPES,
  REMOTE_PROTOCOL_VERSION,
  type RemoteApiResponse,
  type RemoteCapabilities,
  type RemoteDeviceScope,
  type RemoteError,
  type RemotePairRequest,
} from '../../shared/remote-protocol.js';
import {
  RemoteApprovalResolveRequestSchema,
  RemoteCreateSessionRequestSchema,
  RemotePairRequestSchema,
  RemoteSendMessageRequestSchema,
  RemoteStopTaskRequestSchema,
} from '../../shared/remote-schemas.js';
import type { RemoteDeviceStore } from './device-store.js';
import type { RemotePairingService } from './pairing-service.js';
import type { RouteDevRemoteService } from './remote-service.js';
import {
  RemoteServiceError,
  type RemotePrincipal,
} from './remote-types.js';
import { JournalCursorExpiredError } from './session-event-journal.js';
import { RemoteRouter, type RemoteRouteContext } from './router.js';
import { SseSession } from './sse-session.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 10
    || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 169 && second === 254);
}

export interface RemoteGatewayOptions {
  host?: string;
  allowLan?: boolean;
  port?: number;
  desktopName: string;
  gatewayVersion: string;
  service: RouteDevRemoteService;
  devices: RemoteDeviceStore;
  pairing: RemotePairingService;
  maxBodyBytes?: number;
  heartbeatMs?: number;
  maxSseQueueBytes?: number;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string): boolean {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}

function isRemoteServiceError(error: unknown): error is RemoteServiceError {
  return error instanceof RemoteServiceError;
}

function errorFrom(error: unknown): { status: number; error: RemoteError } {
  if (isRemoteServiceError(error)) {
    return {
      status: error.httpStatus,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    };
  }
  if (error instanceof JournalCursorExpiredError) {
    return {
      status: 409,
      error: {
        code: 'CONFLICT',
        message: '断线时间过长，请重新同步该对话时间线',
        retryable: true,
        details: { earliestSequence: error.earliestSequence },
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      error: {
        code: 'CONFLICT',
        message: '请求格式不正确',
        retryable: false,
        details: { fields: error.issues.map((issue) => issue.path.join('.')) },
      },
    };
  }
  return {
    status: 500,
    error: {
      code: 'ENGINE_UNAVAILABLE',
      message: '桌面服务处理请求失败',
      retryable: true,
    },
  };
}

export class RemoteGatewayServer {
  private readonly host: string;
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private readonly heartbeatMs: number;
  private readonly maxSseQueueBytes: number;
  private readonly router = new RemoteRouter();
  private readonly rateLimiter = new FixedWindowRateLimiter(120, 60_000);
  private readonly pairingRateLimiter = new FixedWindowRateLimiter(10, 60_000);
  private readonly sseByDevice = new Map<string, Set<SseSession>>();
  private server: Server | null = null;
  private removeRevocationListener: (() => void) | null = null;

  constructor(private readonly options: RemoteGatewayOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 43117;
    this.maxBodyBytes = options.maxBodyBytes ?? 48 * 1024 * 1024;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.maxSseQueueBytes = options.maxSseQueueBytes ?? 1024 * 1024;
    if (!LOOPBACK_HOSTS.has(this.host) && !(options.allowLan && (this.host === '0.0.0.0' || isPrivateIpv4(this.host)))) {
      throw new Error('Remote Gateway 只能绑定 loopback 或受控局域网地址');
    }
    this.configureRoutes();
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('Remote Gateway 已启动');
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.removeRevocationListener = this.options.devices.onRevoked((deviceId) => {
      const sessions = this.sseByDevice.get(deviceId);
      if (!sessions) return;
      for (const session of sessions) session.close();
      this.sseByDevice.delete(deviceId);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    return {
      host: this.host,
      port: typeof address === 'object' && address ? address.port : this.port,
    };
  }

  async close(): Promise<void> {
    this.removeRevocationListener?.();
    this.removeRevocationListener = null;
    for (const sessions of this.sseByDevice.values()) {
      for (const session of sessions) session.close();
    }
    this.sseByDevice.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private configureRoutes(): void {
    this.router
      .add('GET', '/v1/health', (context) => this.handleHealth(context))
      .add('GET', '/v1/capabilities', (context) => this.handleCapabilities(context))
      .add('POST', '/v1/pair', (context) => this.handlePair(context))
      .add('GET', '/v1/devices', (context) => this.handleDevices(context))
      .add('DELETE', '/v1/devices/:deviceId', (context) => this.handleRevoke(context))
      .add('GET', '/v1/sessions', (context) => this.handleSessions(context))
      .add('POST', '/v1/sessions', (context) => this.handleCreateSession(context))
      .add('GET', '/v1/sessions/:sessionId', (context) => this.handleSession(context))
      .add('GET', '/v1/sessions/:sessionId/timeline', (context) => this.handleTimeline(context))
      .add('POST', '/v1/sessions/:sessionId/messages', (context) => this.handleSendMessage(context))
      .add('POST', '/v1/sessions/:sessionId/stop', (context) => this.handleStop(context))
      .add('POST', '/v1/approvals/:approvalId/resolve', (context) => this.handleApproval(context))
      .add('GET', '/v1/skills', (context) => this.handleSkills(context))
      .add('GET', '/v1/mcp/servers', (context) => this.handleMcpServers(context))
      .add('GET', '/v1/tools', (context) => this.handleTools(context))
      .add('GET', '/v1/events', (context) => this.handleEvents(context));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = this.requestId(request);
    try {
      const url = new URL(request.url ?? '/', `http://${this.host}`);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      const handled = await this.router.dispatch(request, response, url);
      if (!handled && !response.writableEnded) {
        this.sendError(response, requestId, {
          status: 404,
          error: {
            code: 'CONFLICT',
            message: '接口不存在',
            retryable: false,
          },
        });
      }
    } catch (error) {
      if (!response.headersSent && !response.writableEnded) {
        this.sendError(response, requestId, errorFrom(error));
      } else if (!response.writableEnded) {
        response.destroy();
      }
    }
  }

  private handleHealth({ request, response }: RemoteRouteContext): void {
    this.enforceRate(request, false);
    this.sendOk(response, this.requestId(request), null, null, {
      status: this.options.service.isEngineAvailable() ? 'ok' : 'degraded',
      desktopName: this.options.desktopName,
      gatewayVersion: this.options.gatewayVersion,
      engineAvailable: this.options.service.isEngineAvailable(),
    });
  }

  private handleCapabilities({ request, response }: RemoteRouteContext): void {
    this.enforceRate(request, false);
    const payload: RemoteCapabilities = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      eventTypes: [...REMOTE_EVENT_TYPES],
      deviceScopes: [...REMOTE_DEVICE_SCOPES],
      supportsImages: true,
      maxImageCount: 8,
      maxImageBytes: 5 * 1024 * 1024,
    };
    this.sendOk(response, this.requestId(request), null, null, payload);
  }

  private async handlePair({ request, response }: RemoteRouteContext): Promise<void> {
    this.enforceRate(request, true);
    const body = await this.readBody(request, RemotePairRequestSchema);
    const payload = await this.options.pairing.pair(body as RemotePairRequest);
    this.sendOk(response, this.requestId(request), null, null, payload, 201);
  }

  private async handleDevices(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const current = this.options.devices.get(principal.deviceId);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      null,
      null,
      current ? [current] : [],
    );
  }

  private async handleRevoke(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    if (context.params.deviceId !== principal.deviceId) {
      throw new RemoteServiceError('SCOPE_DENIED', '设备只能撤销自身配对', 403);
    }
    await this.options.devices.revoke(principal.deviceId);
    this.sendOk(context.response, this.requestId(context.request), null, null, {});
  }

  private async handleSessions(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      null,
      null,
      this.options.service.listSessions(principal),
    );
  }

  private async handleCreateSession(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const body = await this.readBody(context.request, RemoteCreateSessionRequestSchema);
    const payload = this.options.service.createSession(principal, body);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      payload.session.sessionId,
      null,
      payload,
      201,
    );
  }

  private async handleSession(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const payload = this.options.service.getSession(principal, context.params.sessionId);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      context.params.sessionId,
      payload.activeTurnId,
      payload,
    );
  }

  private async handleTimeline(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const rawAfter = context.url.searchParams.get('afterSequence');
    const afterSequence = rawAfter === null ? undefined : Number(rawAfter);
    if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
      throw new RemoteServiceError('CONFLICT', 'afterSequence 必须是非负整数', 400);
    }
    const payload = this.options.service.getTimeline(
      principal,
      context.params.sessionId,
      afterSequence,
    );
    this.sendOk(
      context.response,
      this.requestId(context.request),
      context.params.sessionId,
      null,
      payload,
    );
  }

  private async handleSendMessage(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const body = await this.readBody(context.request, RemoteSendMessageRequestSchema);
    const payload = this.options.service.sendMessage(
      principal,
      context.params.sessionId,
      body,
    );
    this.sendOk(
      context.response,
      this.requestId(context.request),
      context.params.sessionId,
      payload.turnId,
      payload,
      202,
    );
  }

  private async handleStop(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const body = await this.readBody(context.request, RemoteStopTaskRequestSchema);
    this.options.service.stopTask(principal, context.params.sessionId, body);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      context.params.sessionId,
      body.turnId ?? null,
      {},
    );
  }

  private async handleApproval(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const body = await this.readBody(context.request, RemoteApprovalResolveRequestSchema);
    this.options.service.resolveApproval(
      principal,
      context.params.approvalId,
      body.approved,
      body.payload,
    );
    this.sendOk(context.response, this.requestId(context.request), null, null, {});
  }

  private async handleSkills(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      null,
      null,
      this.options.service.listSkills(principal),
    );
  }

  private async handleMcpServers(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      null,
      null,
      this.options.service.listMcpServers(principal),
    );
  }

  private async handleTools(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    this.sendOk(
      context.response,
      this.requestId(context.request),
      null,
      null,
      this.options.service.listTools(principal),
    );
  }

  private async handleEvents(context: RemoteRouteContext): Promise<void> {
    const principal = await this.authenticate(context.request);
    const sessionId = context.url.searchParams.get('sessionId');
    if (!sessionId) {
      throw new RemoteServiceError('CONFLICT', 'SSE 连接需要 sessionId', 400);
    }
    this.options.service.getSession(principal, sessionId);
    const lastEventId = context.request.headers['last-event-id'];
    const cursor = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    // Validate the cursor before headers are committed. We read again after
    // subscribing so events arriving in the small setup window cannot be lost.
    const initialReplay = cursor
      ? this.options.service.getTimelineAfterEventId(principal, sessionId, cursor).events
      : this.options.service.getTimeline(principal, sessionId).events;

    context.response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    context.response.flushHeaders();

    let removeListener: () => void = () => {};
    let session!: SseSession;
    const removeFromDevice = () => {
      removeListener();
      const set = this.sseByDevice.get(principal.deviceId);
      set?.delete(session);
      if (set?.size === 0) this.sseByDevice.delete(principal.deviceId);
    };
    session = new SseSession(context.response, {
      heartbeatMs: this.heartbeatMs,
      maxQueuedBytes: this.maxSseQueueBytes,
      onClose: removeFromDevice,
    });
    const deviceSessions = this.sseByDevice.get(principal.deviceId) ?? new Set<SseSession>();
    deviceSessions.add(session);
    this.sseByDevice.set(principal.deviceId, deviceSessions);
    removeListener = this.options.service.subscribeEvents(
      principal,
      sessionId,
      (event) => session.send(event),
    );
    const replayEvents = cursor
      ? this.options.service.getTimelineAfterEventId(principal, sessionId, cursor).events
      : this.options.service.getTimeline(principal, sessionId).events;
    session.finishReplay(replayEvents.length >= initialReplay.length ? replayEvents : initialReplay);
  }

  private async authenticate(request: IncomingMessage): Promise<RemotePrincipal> {
    this.enforceRate(request, false);
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new RemoteServiceError('AUTH_REQUIRED', '需要设备令牌', 401);
    }
    const token = authorization.slice('Bearer '.length).trim();
    const authenticated = await this.options.devices.authenticate(token);
    if (!authenticated) {
      throw new RemoteServiceError('AUTH_REVOKED', '设备令牌无效或已撤销', 401);
    }
    return {
      deviceId: authenticated.device.deviceId,
      scopes: authenticated.scopes,
    };
  }

  private enforceRate(request: IncomingMessage, pairing: boolean): void {
    const key = request.socket.remoteAddress ?? 'unknown';
    const limiter = pairing ? this.pairingRateLimiter : this.rateLimiter;
    if (!limiter.consume(key)) {
      throw new RemoteServiceError('RATE_LIMITED', '请求过于频繁，请稍后再试', 429, true);
    }
  }

  private async readBody<T>(
    request: IncomingMessage,
    schema: ZodType<T>,
  ): Promise<T> {
    const contentType = request.headers['content-type'] ?? '';
    if (!String(contentType).toLowerCase().startsWith('application/json')) {
      throw new RemoteServiceError('CONFLICT', '请求必须使用 JSON', 415);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > this.maxBodyBytes) {
        throw new RemoteServiceError('CONFLICT', '请求内容超过大小限制', 413);
      }
      chunks.push(buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new RemoteServiceError('CONFLICT', 'JSON 格式不正确', 400);
    }
    return schema.parse(parsed);
  }

  private requestId(request: IncomingMessage): string {
    const provided = request.headers['x-request-id'];
    const value = Array.isArray(provided) ? provided[0] : provided;
    return value && value.length <= 256 ? value : randomUUID();
  }

  private sendOk<T>(
    response: ServerResponse,
    requestId: string,
    sessionId: string | null,
    turnId: string | null,
    payload: T,
    status = 200,
  ): void {
    const envelope: RemoteApiResponse<T> = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId,
      timestamp: new Date().toISOString(),
      sessionId,
      turnId,
      ok: true,
      payload,
      error: null,
    };
    this.sendJson(response, status, envelope);
  }

  private sendError(
    response: ServerResponse,
    requestId: string,
    mapped: { status: number; error: RemoteError },
  ): void {
    const envelope: RemoteApiResponse<null> = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId,
      timestamp: new Date().toISOString(),
      sessionId: null,
      turnId: null,
      ok: false,
      payload: null,
      error: mapped.error,
    };
    this.sendJson(response, mapped.status, envelope);
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }
}
