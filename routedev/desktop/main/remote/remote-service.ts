import { randomUUID } from 'node:crypto';
import {
  REMOTE_DEVICE_SCOPES,
  type AnyRemoteEvent,
  type RemoteCreateSessionRequest,
  type RemoteCreateSessionResponse,
  type RemoteDeviceScope,
  type RemoteMcpServer,
  type RemoteSendMessageRequest,
  type RemoteSendMessageResponse,
  type RemoteSessionDetail,
  type RemoteSessionAccess,
  type RemoteSessionAclEntry,
  type RemoteSessionSummary,
  type RemoteSkill,
  type RemoteStopTaskRequest,
  type RemoteTimelineResponse,
  type RemoteTool,
} from '../../shared/remote-protocol.js';
import type {
  RemoteEngine,
  RemotePrincipal,
  RemoteSessionRecord,
} from './remote-types.js';
import { RemoteServiceError } from './remote-types.js';
import type { EngineEventListener } from './engine-event-hub.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_COUNT = 8;

type RequiredSessionAccess = 'reader' | 'operator';

function accessRank(access: RequiredSessionAccess | 'owner'): number {
  return access === 'owner' ? 2 : access === 'operator' ? 1 : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toSummary(session: RemoteSessionDetail): RemoteSessionSummary {
  return {
    sessionId: session.sessionId,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    activeTurnId: session.activeTurnId,
    lastSequence: session.lastSequence,
  };
}

function requireScope(
  principal: RemotePrincipal,
  scope: RemoteDeviceScope,
): void {
  if (!principal.scopes.has(scope)) {
    throw new RemoteServiceError(
      'SCOPE_DENIED',
      `设备没有所需权限：${scope}`,
      403,
    );
  }
}

/**
 * Application service shared by the loopback gateway and future renderer IPC.
 * It owns remote session/idempotency semantics; actual Agent execution remains
 * exclusively in RouteDevEngine.
 */
export class RouteDevRemoteService {
  private readonly sessions = new Map<string, RemoteSessionRecord>();
  private readonly clientSessions = new Map<string, string>();
  private readonly acceptedMessages = new Map<string, RemoteSendMessageResponse>();
  private readonly approvals = new Map<string, { sessionId: string; turnId: string | null }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly engine: RemoteEngine) {
    this.unsubscribe = engine.getEventHub().subscribe((event) => {
      this.applyEngineEvent(event);
    });
  }

  close(): void {
    this.unsubscribe();
  }

  getSupportedScopes(): RemoteDeviceScope[] {
    return [...REMOTE_DEVICE_SCOPES];
  }

  isEngineAvailable(): boolean {
    return this.engine.isReady();
  }

  subscribeEvents(
    principal: RemotePrincipal,
    sessionId: string,
    listener: EngineEventListener,
  ): () => void {
    requireScope(principal, 'sessions:read');
    this.requireSessionAccess(principal, sessionId, 'reader');
    return this.engine.getEventHub().subscribe(listener, { sessionId });
  }

  private auditRemoteAction(
    principal: RemotePrincipal,
    action: string,
    context: { sessionId?: string; turnId?: string; details?: Record<string, unknown> } = {},
    result: 'success' | 'failure' | 'denied' = 'success',
  ): void {
    this.engine.auditRemoteAction?.(action, {
      deviceId: principal.deviceId,
      scopes: [...principal.scopes],
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...context.details,
    }, result);
  }

  listSessions(principal: RemotePrincipal): RemoteSessionSummary[] {
    requireScope(principal, 'sessions:read');
    return [...this.sessions.values()]
      .filter((session) => this.sessionAccess(principal, session) !== null)
      .map((session) => toSummary(this.refreshSequence(session)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createSession(
    principal: RemotePrincipal,
    request: RemoteCreateSessionRequest,
  ): RemoteCreateSessionResponse {
    requireScope(principal, 'messages:send');
    const clientSessionKey = this.clientSessionKey(principal, request.clientSessionId);
    const existingId = this.clientSessions.get(clientSessionKey);
    if (existingId) {
      this.requireSessionAccess(principal, existingId, 'operator');
      return {
        session: this.getSessionInternal(existingId),
        clientSessionId: request.clientSessionId,
      };
    }

    const project = this.engine.getProjectInfo();
    const timestamp = nowIso();
    const session: RemoteSessionRecord = {
      sessionId: randomUUID(),
      clientSessionId: request.clientSessionId,
      ownerDeviceId: principal.deviceId,
      acl: [],
      title: request.title?.trim() || '新对话',
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      activeTurnId: null,
      lastSequence: 0,
      projectId: request.projectId ?? project.id,
      projectName: project.name,
      latestResult: null,
    };
    this.sessions.set(session.sessionId, session);
    this.clientSessions.set(clientSessionKey, session.sessionId);
    this.engine.getEventHub().publish(
      session.sessionId,
      null,
      'session.created',
      { session: toSummary(this.refreshSequence(session)) },
    );
    this.auditRemoteAction(principal, 'session_create', { sessionId: session.sessionId });
    return { session: this.getSessionInternal(session.sessionId), clientSessionId: request.clientSessionId };
  }

  getSession(principal: RemotePrincipal, sessionId: string): RemoteSessionDetail {
    requireScope(principal, 'sessions:read');
    this.requireSessionAccess(principal, sessionId, 'reader');
    return this.getSessionInternal(sessionId);
  }

  getTimeline(
    principal: RemotePrincipal,
    sessionId: string,
    afterSequence?: number,
  ): RemoteTimelineResponse {
    requireScope(principal, 'sessions:read');
    this.requireSessionAccess(principal, sessionId, 'reader');
    return this.engine.getEventHub().journal.read(sessionId, { afterSequence });
  }

  getTimelineAfterEventId(
    principal: RemotePrincipal,
    sessionId: string,
    afterEventId: string,
  ): RemoteTimelineResponse {
    requireScope(principal, 'sessions:read');
    this.requireSessionAccess(principal, sessionId, 'reader');
    return this.engine.getEventHub().journal.read(sessionId, { afterEventId });
  }

  sendMessage(
    principal: RemotePrincipal,
    sessionId: string,
    request: RemoteSendMessageRequest,
  ): RemoteSendMessageResponse {
    requireScope(principal, 'messages:send');
    this.requireSessionAccess(principal, sessionId, 'operator');
    const session = this.getMutableSession(sessionId);
    const idempotencyKey = `${principal.deviceId}:${sessionId}:${request.clientMessageId}`;
    const duplicate = this.acceptedMessages.get(idempotencyKey);
    if (duplicate) return { ...duplicate, duplicate: true };
    if (session.status === 'queued' || session.status === 'running' || session.status === 'waiting_approval') {
      throw new RemoteServiceError('SESSION_BUSY', '该对话仍有任务在运行', 409, true);
    }
    if (!this.engine.isReady()) {
      throw new RemoteServiceError('ENGINE_UNAVAILABLE', '桌面引擎尚未就绪', 503, true);
    }

    this.validateImages(request);
    const skillIds = this.resolveSkills(principal, request.skillIds);
    const mcpServerIds = this.resolveMcpServers(principal, request.mcpServerIds);
    const allowedToolNames = this.resolveTools(request.allowedToolNames, mcpServerIds);
    if (request.autonomyMode !== undefined) {
      requireScope(principal, 'autonomy:change');
      if (!this.engine.getConfig().remote.allowAutonomyChange) {
        throw new RemoteServiceError('SCOPE_DENIED', '远程 autonomy 切换未由桌面端启用', 403);
      }
    }

    const turnId = randomUUID();
    const acceptedAt = nowIso();
    const response: RemoteSendMessageResponse = {
      sessionId,
      turnId,
      clientMessageId: request.clientMessageId,
      acceptedAt,
      duplicate: false,
    };
    this.acceptedMessages.set(idempotencyKey, response);
    session.status = 'queued';
    session.activeTurnId = turnId;
    session.updatedAt = acceptedAt;

    this.engine.getEventHub().publish(sessionId, turnId, 'turn.queued', {
      clientMessageId: request.clientMessageId,
      position: 0,
    });
    this.auditRemoteAction(principal, 'message_send', {
      sessionId,
      turnId,
      details: { autonomyMode: request.autonomyMode ?? null },
    });
    if (session.title === '新对话') {
      session.title = request.text.trim().slice(0, 80) || '图片任务';
    }

    void this.engine.sendChat(request.text, {
      sessionId,
      turnId,
      clientMessageId: request.clientMessageId,
      skillIds,
      mcpServerIds,
      allowedToolNames,
      autonomyMode: request.autonomyMode,
      images: request.images,
      deviceId: principal.deviceId,
      triggerSource: 'remote',
    }).catch((error) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.activeTurnId !== turnId) return;
      this.engine.getEventHub().publish(sessionId, turnId, 'turn.failed', {
        error: {
          code: 'ENGINE_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      });
    });
    return response;
  }

  stopTask(
    principal: RemotePrincipal,
    sessionId: string,
    request: RemoteStopTaskRequest,
  ): void {
    requireScope(principal, 'tasks:stop');
    this.requireSessionAccess(principal, sessionId, 'operator');
    const session = this.getMutableSession(sessionId);
    const turnId = request.turnId ?? session.activeTurnId;
    if (!turnId || session.activeTurnId !== turnId) {
      throw new RemoteServiceError('CONFLICT', '没有可停止的当前任务', 409);
    }
    this.engine.stopGeneration(turnId);
    this.auditRemoteAction(principal, 'task_stop', { sessionId, turnId });
  }

  resolveApproval(
    principal: RemotePrincipal,
    approvalId: string,
    approved: boolean,
    payload?: unknown,
  ): void {
    requireScope(principal, 'approvals:resolve');
    if (!this.engine.getConfig().remote.allowRemoteApprovals) {
      throw new RemoteServiceError('SCOPE_DENIED', '远程审批未由桌面端启用', 403);
    }
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new RemoteServiceError('APPROVAL_EXPIRED', '审批不存在或已失效', 409);
    }
    this.requireSessionAccess(principal, approval.sessionId, 'operator');
    if (approval.turnId) {
      const session = this.getMutableSession(approval.sessionId);
      if (session.activeTurnId !== approval.turnId) {
        throw new RemoteServiceError('APPROVAL_EXPIRED', '审批不属于当前执行轮次', 409);
      }
    }
    this.engine.resolveToolConfirm(approvalId, approved, payload, 'android');
    this.auditRemoteAction(principal, 'approval_resolve', {
      sessionId: approval.sessionId,
      ...(approval.turnId ? { turnId: approval.turnId } : {}),
      details: { approvalId, approved },
    });
  }

  listSkills(principal: RemotePrincipal): RemoteSkill[] {
    requireScope(principal, 'sessions:read');
    return this.engine.listSkills().map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      source: skill.sourcePath,
      enabled: skill.enabled,
    }));
  }

  listMcpServers(principal: RemotePrincipal): RemoteMcpServer[] {
    requireScope(principal, 'sessions:read');
    return this.getMcpServers();
  }

  private getMcpServers(): RemoteMcpServer[] {
    const status = new Map(
      this.engine.getMCPStatus().servers.map((server) => [server.id, server.connected]),
    );
    const toolCounts = new Map<string, number>();
    for (const tool of this.engine.listRemoteTools()) {
      if (tool.mcpServerId) {
        toolCounts.set(tool.mcpServerId, (toolCounts.get(tool.mcpServerId) ?? 0) + 1);
      }
    }
    return this.engine.getConfig().mcp.servers
      .filter((server) => server.enabled)
      .map((server) => ({
        id: server.id,
        name: server.name,
        connected: status.get(server.id) ?? false,
        toolCount: toolCounts.get(server.id) ?? 0,
      }));
  }

  listTools(principal: RemotePrincipal): RemoteTool[] {
    requireScope(principal, 'sessions:read');
    const connectedServers = new Set(
      this.listMcpServers(principal)
        .filter((server) => server.connected)
        .map((server) => server.id),
    );
    return this.engine.listRemoteTools().map((tool) => ({
      ...tool,
      allowed: tool.source === 'builtin'
        ? tool.allowed
        : tool.allowed && !!tool.mcpServerId && connectedServers.has(tool.mcpServerId),
    }));
  }

  private getMutableSession(sessionId: string): RemoteSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RemoteServiceError('SESSION_NOT_FOUND', '未找到该对话', 404);
    }
    return session;
  }

  private clientSessionKey(principal: RemotePrincipal, clientSessionId: string): string {
    return `${principal.deviceId}:${clientSessionId}`;
  }

  private sessionAccess(
    principal: RemotePrincipal,
    session: RemoteSessionRecord,
  ): 'owner' | RemoteSessionAccess | null {
    if (session.ownerDeviceId === principal.deviceId) return 'owner';
    return session.acl.find((entry) => entry.deviceId === principal.deviceId)?.access ?? null;
  }

  private requireSessionAccess(
    principal: RemotePrincipal,
    sessionId: string,
    required: RequiredSessionAccess,
  ): RemoteSessionRecord {
    const session = this.getMutableSession(sessionId);
    const actual = this.sessionAccess(principal, session);
    if (actual === null || accessRank(actual) < accessRank(required)) {
      throw new RemoteServiceError('SESSION_ACCESS_DENIED', '设备未获准访问该会话', 403);
    }
    return session;
  }

  /** Desktop-only control surface for explicitly granting a session to a paired device. */
  grantSessionAccess(
    sessionId: string,
    deviceId: string,
    access: RemoteSessionAccess,
  ): RemoteSessionDetail {
    const session = this.getMutableSession(sessionId);
    const entry: RemoteSessionAclEntry = { deviceId, access, grantedAt: nowIso() };
    session.acl = [...session.acl.filter((item) => item.deviceId !== deviceId), entry];
    session.updatedAt = entry.grantedAt;
    this.publishSessionUpdated(session);
    this.engine.auditRemoteAction?.('session_acl_grant', { sessionId, deviceId, access });
    return this.getSessionInternal(sessionId);
  }

  /** Desktop-only control surface for revoking a per-session grant. */
  revokeSessionAccess(sessionId: string, deviceId: string): RemoteSessionDetail {
    const session = this.getMutableSession(sessionId);
    session.acl = session.acl.filter((item) => item.deviceId !== deviceId);
    session.updatedAt = nowIso();
    this.publishSessionUpdated(session);
    this.engine.auditRemoteAction?.('session_acl_revoke', { sessionId, deviceId });
    return this.getSessionInternal(sessionId);
  }

  /** Remove all per-session grants when a paired device is revoked. */
  revokeDeviceAccess(deviceId: string): void {
    for (const session of this.sessions.values()) {
      const nextAcl = session.acl.filter((entry) => entry.deviceId !== deviceId);
      if (nextAcl.length === session.acl.length) continue;
      session.acl = nextAcl;
      session.updatedAt = nowIso();
      this.publishSessionUpdated(session);
      this.engine.auditRemoteAction?.('device_acl_revoke', {
        sessionId: session.sessionId,
        deviceId,
      });
    }
  }

  private getSessionInternal(sessionId: string): RemoteSessionDetail {
    const session = this.refreshSequence(this.getMutableSession(sessionId));
    return {
      sessionId: session.sessionId,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      activeTurnId: session.activeTurnId,
      lastSequence: session.lastSequence,
      projectId: session.projectId,
      projectName: session.projectName,
      latestResult: session.latestResult,
      ownerDeviceId: session.ownerDeviceId,
      acl: session.acl.map((entry) => ({ ...entry })),
    };
  }

  private refreshSequence(session: RemoteSessionRecord): RemoteSessionRecord {
    session.lastSequence = this.engine.getEventHub().journal.getLastSequence(session.sessionId);
    return session;
  }

  private resolveSkills(
    principal: RemotePrincipal,
    requested: string[] | undefined,
  ): string[] | undefined {
    if (requested === undefined) return undefined;
    requireScope(principal, 'skills:select');
    const enabled = new Set(
      this.engine.listSkills().filter((skill) => skill.enabled).map((skill) => skill.name),
    );
    for (const skillId of requested) {
      if (!enabled.has(skillId)) {
        throw new RemoteServiceError(
          'SKILL_NOT_AVAILABLE',
          `Skill 不可用：${skillId}`,
          422,
        );
      }
    }
    return [...new Set(requested)];
  }

  private resolveMcpServers(
    principal: RemotePrincipal,
    requested: string[] | undefined,
  ): string[] | undefined {
    if (requested === undefined) return undefined;
    requireScope(principal, 'mcp:select');
    const connected = new Set(
      this.getMcpServers()
        .filter((server) => server.connected)
        .map((server) => server.id),
    );
    for (const serverId of requested) {
      if (!connected.has(serverId)) {
        throw new RemoteServiceError(
          'MCP_NOT_AVAILABLE',
          `MCP Server 不可用：${serverId}`,
          422,
        );
      }
    }
    return [...new Set(requested)];
  }

  private resolveTools(
    requested: string[] | undefined,
    requestedMcpServers: string[] | undefined,
  ): string[] {
    const installed = this.engine.listRemoteTools().filter((tool) => tool.allowed);
    const installedByName = new Map(installed.map((tool) => [tool.name, tool]));
    if (requested) {
      for (const toolName of requested) {
        if (!installedByName.has(toolName)) {
          throw new RemoteServiceError(
            'TOOL_NOT_ALLOWED',
            `工具不可用：${toolName}`,
            422,
          );
        }
      }
    }
    const requestedNames = requested ? new Set(requested) : null;
    const mcpScope = requestedMcpServers ? new Set(requestedMcpServers) : null;
    return installed
      .filter((tool) => !requestedNames || requestedNames.has(tool.name))
      .filter((tool) =>
        tool.source === 'builtin'
        || !mcpScope
        || (!!tool.mcpServerId && mcpScope.has(tool.mcpServerId)),
      )
      .map((tool) => tool.name);
  }

  private validateImages(request: RemoteSendMessageRequest): void {
    const images = request.images ?? [];
    if (images.length > MAX_IMAGE_COUNT) {
      throw new RemoteServiceError('CONFLICT', '图片数量超过限制', 413);
    }
    for (const image of images) {
      const estimatedBytes = Math.floor(image.dataBase64.length * 0.75);
      if (estimatedBytes > MAX_IMAGE_BYTES) {
        throw new RemoteServiceError('CONFLICT', '单张图片超过 5 MB', 413);
      }
    }
  }

  private applyEngineEvent(event: AnyRemoteEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    session.lastSequence = event.sequence;
    session.updatedAt = event.timestamp;

    switch (event.type) {
      case 'assistant.text.delta':
        session.latestResult = `${session.latestResult ?? ''}${event.payload.text}`;
        break;
      case 'turn.started':
        session.status = 'running';
        break;
      case 'turn.queued':
        session.status = 'queued';
        break;
      case 'approval.required':
        session.status = 'waiting_approval';
        this.approvals.set(event.payload.approval.approvalId, {
          sessionId: session.sessionId,
          turnId: event.turnId,
        });
        break;
      case 'approval.resolved':
        this.approvals.delete(event.payload.approvalId);
        if (session.activeTurnId) session.status = 'running';
        break;
      case 'turn.completed':
        session.status = 'completed';
        session.activeTurnId = null;
        this.publishSessionUpdated(session);
        this.engine.getEventHub().publish(
          session.sessionId,
          event.turnId,
          'task.completed',
          { summary: session.latestResult ?? '' },
        );
        break;
      case 'turn.failed':
        session.status = 'failed';
        session.activeTurnId = null;
        this.publishSessionUpdated(session);
        this.engine.getEventHub().publish(
          session.sessionId,
          event.turnId,
          'task.failed',
          { error: event.payload.error },
        );
        break;
      default:
        break;
    }
  }

  private publishSessionUpdated(session: RemoteSessionRecord): void {
    this.engine.getEventHub().publish(
      session.sessionId,
      null,
      'session.updated',
      { session: toSummary(this.refreshSequence(session)) },
    );
  }
}
