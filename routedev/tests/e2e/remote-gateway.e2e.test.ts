import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../desktop/shared/config-types.js';
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteApiResponse,
  type RemotePairResponse,
  type RemoteTool,
} from '../../desktop/shared/remote-protocol.js';
import {
  EngineEventHub,
  RemoteDeviceStore,
  RemoteGatewayServer,
  RemotePairingService,
  RouteDevRemoteService,
  type RemoteEngine,
  type RemoteTurnContextInput,
} from '../../desktop/main/remote/index.js';

class GatewayFakeEngine implements RemoteEngine {
  readonly hub = new EngineEventHub({
    createEventId: (_sessionId, sequence) => `event-${sequence}`,
  });
  ready = true;
  sendCalls: Array<{ text: string; context?: RemoteTurnContextInput }> = [];

  isReady(): boolean { return this.ready; }
  getProjectInfo() { return { id: 'project-1', name: 'RouteDev', cwd: 'C:\\RouteDev' }; }
  getConfig(): AppConfig {
    return { mcp: { servers: [] } } as unknown as AppConfig;
  }
  getEventHub(): EngineEventHub { return this.hub; }
  async sendChat(text: string, context?: RemoteTurnContextInput): Promise<void> {
    this.sendCalls.push({ text, context });
  }
  stopGeneration(): void {}
  resolveToolConfirm(): void {}
  listSkills() { return []; }
  getMCPStatus() { return { connected: false, servers: [] }; }
  listRemoteTools(): RemoteTool[] {
    return [{
      name: 'file_read',
      description: 'read',
      source: 'builtin',
      mcpServerId: null,
      allowed: true,
    }];
  }
}

interface GatewayFixture {
  baseUrl: string;
  gateway: RemoteGatewayServer;
  service: RouteDevRemoteService;
  devices: RemoteDeviceStore;
  pairing: RemotePairingService;
  engine: GatewayFakeEngine;
  directory: string;
}

const fixtures: GatewayFixture[] = [];

async function createGateway(): Promise<GatewayFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'routedev-gateway-test-'));
  const devices = new RemoteDeviceStore(path.join(directory, 'devices.json'));
  await devices.initialize();
  const engine = new GatewayFakeEngine();
  const service = new RouteDevRemoteService(engine);
  const pairing = new RemotePairingService(devices, async (_request, proposed) => proposed);
  const gateway = new RemoteGatewayServer({
    host: '127.0.0.1',
    port: 0,
    desktopName: 'Test Desktop',
    gatewayVersion: 'test',
    service,
    devices,
    pairing,
    heartbeatMs: 50,
  });
  const address = await gateway.start();
  const fixture = {
    baseUrl: `http://${address.host}:${address.port}`,
    gateway,
    service,
    devices,
    pairing,
    engine,
    directory,
  };
  fixtures.push(fixture);
  return fixture;
}

async function pair(fixture: GatewayFixture): Promise<string> {
  const offer = fixture.pairing.createOffer(fixture.baseUrl, 'Test Desktop');
  const response = await fetch(`${fixture.baseUrl}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairingId: offer.pairingId,
      secret: offer.secret,
      deviceId: 'android-device-1',
      deviceName: 'Pixel',
      requestedScopes: [
        'sessions:read',
        'messages:send',
        'tasks:stop',
        'skills:select',
        'mcp:select',
      ],
      protocolVersion: REMOTE_PROTOCOL_VERSION,
    }),
  });
  const envelope = await response.json() as RemoteApiResponse<RemotePairResponse>;
  expect(response.status).toBe(201);
  expect(envelope.ok).toBe(true);
  return envelope.payload!.deviceToken;
}

async function createRemoteSession(
  fixture: GatewayFixture,
  token: string,
): Promise<string> {
  const response = await fetch(`${fixture.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ clientSessionId: crypto.randomUUID() }),
  });
  const envelope = await response.json() as RemoteApiResponse<{
    session: { sessionId: string };
  }>;
  expect(response.status).toBe(201);
  return envelope.payload!.session.sessionId;
}

async function readSseEvents(
  response: Response,
  count: number,
): Promise<Array<{ id: string; type: string; data: unknown }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<{ id: string; type: string; data: unknown }> = [];
  while (events.length < count) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!block.startsWith(':')) {
        const fields = Object.fromEntries(block.split('\n').map((line) => {
          const split = line.indexOf(':');
          return [line.slice(0, split), line.slice(split + 1).trim()];
        }));
        events.push({
          id: fields.id,
          type: fields.event,
          data: JSON.parse(fields.data),
        });
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel();
  return events;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    fixture.service.close();
    await fixture.gateway.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }));
});

describe('RemoteGatewayServer', () => {
  it('refuses non-loopback binding', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'routedev-gateway-loopback-'));
    const devices = new RemoteDeviceStore(path.join(directory, 'devices.json'));
    const engine = new GatewayFakeEngine();
    const service = new RouteDevRemoteService(engine);
    const pairing = new RemotePairingService(devices, async (_request, proposed) => proposed);

    expect(() => new RemoteGatewayServer({
      host: '0.0.0.0',
      desktopName: 'Unsafe',
      gatewayVersion: 'test',
      service,
      devices,
      pairing,
    })).toThrow(/loopback/);
    expect(() => new RemoteGatewayServer({
      host: '192.168.1.20',
      allowLan: true,
      desktopName: 'LAN',
      gatewayVersion: 'test',
      service,
      devices,
      pairing,
    })).not.toThrow();
    expect(() => new RemoteGatewayServer({
      host: '8.8.8.8',
      allowLan: true,
      desktopName: 'Public',
      gatewayVersion: 'test',
      service,
      devices,
      pairing,
    })).toThrow(/loopback/);
    service.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('pairs, authenticates and creates an idempotent remote turn', async () => {
    const fixture = await createGateway();
    const health = await fetch(`${fixture.baseUrl}/v1/health`);
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
    expect((await health.json() as { ok: boolean }).ok).toBe(true);

    const unauthorized = await fetch(`${fixture.baseUrl}/v1/sessions`);
    expect(unauthorized.status).toBe(401);

    const token = await pair(fixture);
    const sessionId = await createRemoteSession(fixture, token);
    const body = { text: 'hello', clientMessageId: 'message-1' };
    const send = () => fetch(`${fixture.baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await second.json() as { payload: { duplicate: boolean } }).payload.duplicate)
      .toBe(true);
    expect(fixture.engine.sendCalls).toHaveLength(1);
  });

  it('resumes SSE after Last-Event-ID without duplicates or gaps', async () => {
    const fixture = await createGateway();
    const token = await pair(fixture);
    const sessionId = await createRemoteSession(fixture, token);
    fixture.engine.hub.publish(sessionId, null, 'connection.notice', {
      level: 'info',
      message: 'before disconnect',
      code: null,
    });

    const firstController = new AbortController();
    const firstResponse = await fetch(
      `${fixture.baseUrl}/v1/events?sessionId=${sessionId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: firstController.signal,
      },
    );
    const firstEvents = await readSseEvents(firstResponse, 2);
    firstController.abort();
    expect(firstEvents.map((event) => event.type)).toEqual([
      'session.created',
      'connection.notice',
    ]);

    fixture.engine.hub.publish(sessionId, 'turn-1', 'assistant.reasoning.delta', {
      text: 'reasoning',
      visibility: 'provider_returned',
    });
    fixture.engine.hub.publish(sessionId, 'turn-1', 'tool.started', {
      toolCallId: 'tool-1',
      toolName: 'file_read',
      argsSummary: null,
    });

    const secondResponse = await fetch(
      `${fixture.baseUrl}/v1/events?sessionId=${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Last-Event-ID': firstEvents.at(-1)!.id,
        },
      },
    );
    const resumed = await readSseEvents(secondResponse, 2);
    expect(resumed.map((event) => event.type)).toEqual([
      'assistant.reasoning.delta',
      'tool.started',
    ]);
    expect(new Set(resumed.map((event) => event.id)).size).toBe(2);
  });

  it('closes an active SSE stream when the device token is revoked', async () => {
    const fixture = await createGateway();
    const token = await pair(fixture);
    const sessionId = await createRemoteSession(fixture, token);
    const response = await fetch(`${fixture.baseUrl}/v1/events?sessionId=${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reader = response.body!.getReader();
    await fixture.devices.revoke('android-device-1');

    const closed = await Promise.race([
      (async () => {
        while (true) {
          const result = await reader.read();
          if (result.done) return true;
        }
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(closed).toBe(true);
  });
});
