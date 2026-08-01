import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../desktop/shared/config-types.js';
import type {
  RemoteDeviceScope,
  RemoteTool,
} from '../../desktop/shared/remote-protocol.js';
import {
  EngineEventHub,
  RemoteServiceError,
  RouteDevRemoteService,
  type RemoteEngine,
  type RemotePrincipal,
  type RemoteTurnContextInput,
} from '../../desktop/main/remote/index.js';

function principal(scopes: RemoteDeviceScope[]): RemotePrincipal {
  return { deviceId: 'device-1', scopes: new Set(scopes) };
}

class FakeRemoteEngine implements RemoteEngine {
  readonly hub = new EngineEventHub({
    createEventId: (_sessionId, sequence) => `event-${sequence}`,
  });
  readonly sendCalls: Array<{ text: string; context?: RemoteTurnContextInput }> = [];
  readonly stopped: Array<string | undefined> = [];
  readonly approvals: Array<{ id: string; approved: boolean; origin?: string }> = [];
  ready = true;
  skills = [
    { name: 'enabled-skill', description: 'enabled', enabled: true, sourcePath: 'skill://enabled' },
    { name: 'disabled-skill', description: 'disabled', enabled: false, sourcePath: 'skill://disabled' },
  ];
  tools: RemoteTool[] = [
    { name: 'file_read', description: 'read', source: 'builtin', mcpServerId: null, allowed: true },
    { name: 'mcp__connected__search', description: 'search', source: 'mcp', mcpServerId: 'connected', allowed: true },
    { name: 'mcp__offline__query', description: 'query', source: 'mcp', mcpServerId: 'offline', allowed: true },
  ];

  isReady(): boolean { return this.ready; }
  getProjectInfo() { return { id: 'project-1', name: 'RouteDev', cwd: 'C:\\RouteDev' }; }
  getConfig(): AppConfig {
    return {
      mcp: {
        servers: [
          { id: 'connected', name: 'Connected', enabled: true, config: {} },
          { id: 'offline', name: 'Offline', enabled: true, config: {} },
        ],
      },
    } as unknown as AppConfig;
  }
  getEventHub(): EngineEventHub { return this.hub; }
  async sendChat(text: string, context?: RemoteTurnContextInput): Promise<void> {
    this.sendCalls.push({ text, context });
  }
  stopGeneration(requestId?: string): void { this.stopped.push(requestId); }
  resolveToolConfirm(id: string, approved: boolean, _payload?: unknown, origin?: 'desktop' | 'android'): void {
    this.approvals.push({ id, approved, origin });
  }
  listSkills() { return this.skills; }
  getMCPStatus() {
    return {
      connected: true,
      servers: [
        { id: 'connected', connected: true },
        { id: 'offline', connected: false },
      ],
    };
  }
  listRemoteTools(): RemoteTool[] { return this.tools; }
}

const fullPrincipal = principal([
  'sessions:read',
  'messages:send',
  'tasks:stop',
  'approvals:resolve',
  'skills:select',
  'mcp:select',
  'autonomy:change',
]);

function createSession(service: RouteDevRemoteService): string {
  return service.createSession(fullPrincipal, {
    clientSessionId: 'client-session-1',
  }).session.sessionId;
}

describe('RouteDevRemoteService', () => {
  it('executes one turn for repeated clientMessageId', () => {
    const engine = new FakeRemoteEngine();
    const service = new RouteDevRemoteService(engine);
    const sessionId = createSession(service);
    const request = { text: 'hello', clientMessageId: 'message-1' };

    const first = service.sendMessage(fullPrincipal, sessionId, request);
    const second = service.sendMessage(fullPrincipal, sessionId, request);

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ ...first, duplicate: true });
    expect(engine.sendCalls).toHaveLength(1);
  });

  it('rejects disabled skills, disconnected MCP and unknown tools', () => {
    const engine = new FakeRemoteEngine();
    const service = new RouteDevRemoteService(engine);

    const disabledSkillSession = createSession(service);
    expect(() => service.sendMessage(fullPrincipal, disabledSkillSession, {
      text: 'hello',
      clientMessageId: 'message-skill',
      skillIds: ['disabled-skill'],
    })).toThrowError(expect.objectContaining({ code: 'SKILL_NOT_AVAILABLE' }));

    const mcpSession = service.createSession(fullPrincipal, {
      clientSessionId: 'client-session-2',
    }).session.sessionId;
    expect(() => service.sendMessage(fullPrincipal, mcpSession, {
      text: 'hello',
      clientMessageId: 'message-mcp',
      mcpServerIds: ['offline'],
    })).toThrowError(expect.objectContaining({ code: 'MCP_NOT_AVAILABLE' }));

    const toolSession = service.createSession(fullPrincipal, {
      clientSessionId: 'client-session-3',
    }).session.sessionId;
    expect(() => service.sendMessage(fullPrincipal, toolSession, {
      text: 'hello',
      clientMessageId: 'message-tool',
      allowedToolNames: ['shell_that_does_not_exist'],
    })).toThrowError(expect.objectContaining({ code: 'TOOL_NOT_ALLOWED' }));
  });

  it('intersects requested MCP and tool capabilities before calling the engine', () => {
    const engine = new FakeRemoteEngine();
    const service = new RouteDevRemoteService(engine);
    const sessionId = createSession(service);
    service.sendMessage(fullPrincipal, sessionId, {
      text: 'search',
      clientMessageId: 'message-1',
      skillIds: ['enabled-skill'],
      mcpServerIds: ['connected'],
      allowedToolNames: ['file_read', 'mcp__connected__search'],
      autonomyMode: 'semi',
    });

    expect(engine.sendCalls[0]?.context).toMatchObject({
      skillIds: ['enabled-skill'],
      mcpServerIds: ['connected'],
      allowedToolNames: ['file_read', 'mcp__connected__search'],
      autonomyMode: 'semi',
    });
    expect(engine.sendCalls[0]?.context?.allowedToolNames)
      .not.toContain('mcp__offline__query');
  });

  it('requires scopes at the application-service boundary', () => {
    const engine = new FakeRemoteEngine();
    const service = new RouteDevRemoteService(engine);
    expect(() => service.createSession(principal(['sessions:read']), {
      clientSessionId: 'denied',
    })).toThrowError(expect.objectContaining({ code: 'SCOPE_DENIED' }));

    const error = (() => {
      try {
        service.listSessions(principal([]));
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(RemoteServiceError);
  });

  it('publishes task completion after the ordered turn terminal event', () => {
    const engine = new FakeRemoteEngine();
    const service = new RouteDevRemoteService(engine);
    const sessionId = createSession(service);
    const accepted = service.sendMessage(fullPrincipal, sessionId, {
      text: 'hello',
      clientMessageId: 'message-1',
    });
    engine.hub.publish(sessionId, accepted.turnId, 'assistant.text.delta', {
      text: 'finished',
    });
    engine.hub.publish(sessionId, accepted.turnId, 'turn.completed', {
      finishReason: 'stop',
      completionStatus: 'completed_verified',
    });

    const types = engine.hub.journal.read(sessionId).events.map((event) => event.type);
    expect(types.slice(-3)).toEqual([
      'turn.completed',
      'session.updated',
      'task.completed',
    ]);
    expect(service.getSession(fullPrincipal, sessionId)).toMatchObject({
      status: 'completed',
      latestResult: 'finished',
      activeTurnId: null,
    });
  });

  it('does not require autonomy scope unless a mode override is requested', () => {
    const engine = new FakeRemoteEngine();
    const service = new RouteDevRemoteService(engine);
    const limited = principal(['messages:send']);
    const session = service.createSession(limited, { clientSessionId: 'limited-1' }).session.sessionId;

    expect(() => service.sendMessage(limited, session, {
      text: 'hello',
      clientMessageId: 'message-1',
      autonomyMode: 'auto',
    })).toThrowError(expect.objectContaining({ code: 'SCOPE_DENIED' }));
  });
});
