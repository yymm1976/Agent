import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_API_ROUTES,
  REMOTE_ERROR_CODES,
  REMOTE_EVENT_TYPES,
  validateRemoteEventSequence,
  type RemoteEventEnvelope,
} from '../../desktop/shared/remote-protocol.js';
import {
  RemoteEventEnvelopeSchema,
  RemoteRestSchemaMap,
  type RemoteRestSchemaName,
} from '../../desktop/shared/remote-schemas.js';

interface RestFixture {
  name: string;
  schema: RemoteRestSchemaName;
  value: unknown;
}

interface InvalidFixture {
  name: string;
  schema: RemoteRestSchemaName | 'event';
  value: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../../../routedev-android/protocol/fixtures');

async function loadFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8')) as T;
}

describe('RouteDev Remote v1 protocol contract', () => {
  it('declares every required REST route exactly once', () => {
    expect(Object.values(REMOTE_API_ROUTES)).toEqual([
      { method: 'GET', path: '/v1/health' },
      { method: 'GET', path: '/v1/capabilities' },
      { method: 'POST', path: '/v1/pair' },
      { method: 'GET', path: '/v1/devices' },
      { method: 'DELETE', path: '/v1/devices/{deviceId}' },
      { method: 'GET', path: '/v1/sessions' },
      { method: 'POST', path: '/v1/sessions' },
      { method: 'GET', path: '/v1/sessions/{sessionId}' },
      { method: 'GET', path: '/v1/sessions/{sessionId}/timeline' },
      { method: 'POST', path: '/v1/sessions/{sessionId}/messages' },
      { method: 'POST', path: '/v1/sessions/{sessionId}/stop' },
      { method: 'POST', path: '/v1/approvals/{approvalId}/resolve' },
      { method: 'GET', path: '/v1/skills' },
      { method: 'GET', path: '/v1/mcp/servers' },
      { method: 'GET', path: '/v1/tools' },
      { method: 'GET', path: '/v1/events' },
    ]);
  });

  it('accepts all REST success fixtures and preserves unknown fields', async () => {
    const fixtures = await loadFixture<RestFixture[]>('rest-success.json');
    for (const fixture of fixtures) {
      const result = RemoteRestSchemaMap[fixture.schema].safeParse(fixture.value);
      expect(result.success, fixture.name).toBe(true);
    }

    const pair = fixtures.find((fixture) => fixture.schema === 'pairRequest');
    const parsed = RemoteRestSchemaMap.pairRequest.parse(pair?.value);
    expect(parsed.futureField).toBe('ignored');
  });

  it('accepts every event type and fixes strict sequence order', async () => {
    const values = await loadFixture<unknown[]>('event-success.json');
    const events = values.map((value) => RemoteEventEnvelopeSchema.parse(value));
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(REMOTE_EVENT_TYPES));
    expect(validateRemoteEventSequence(events)).toEqual([]);
    expect(events[0]?.futureEnvelopeField).toBe('ignored');

    const orderedTypes = events.map((event) => event.type);
    expect(orderedTypes.slice(3, 9)).toEqual([
      'assistant.reasoning.delta',
      'assistant.progress',
      'tool.started',
      'tool.output.delta',
      'tool.completed',
      'assistant.reasoning.delta',
    ]);
  });

  it('rejects missing required fields, protocol mismatches and unknown enums', async () => {
    const fixtures = await loadFixture<InvalidFixture[]>('invalid-fixtures.json');
    for (const fixture of fixtures) {
      const schema = fixture.schema === 'event'
        ? RemoteEventEnvelopeSchema
        : RemoteRestSchemaMap[fixture.schema];
      expect(schema.safeParse(fixture.value).success, fixture.name).toBe(false);
    }
  });

  it('exposes stable machine-readable error codes', () => {
    expect(new Set(REMOTE_ERROR_CODES).size).toBe(REMOTE_ERROR_CODES.length);
    expect(REMOTE_ERROR_CODES).toContain('AUTH_REVOKED');
    expect(REMOTE_ERROR_CODES).toContain('PROTOCOL_MISMATCH');
    expect(REMOTE_ERROR_CODES).not.toContain('UNKNOWN');
  });

  it('rejects duplicate, reversed and cross-session sequence streams', () => {
    const base: RemoteEventEnvelope = {
      protocolVersion: 1,
      eventId: 'event-1',
      timestamp: '2026-07-30T08:00:00.000Z',
      sessionId: 'session-1',
      turnId: null,
      sequence: 2,
      type: 'connection.notice',
      payload: { level: 'info', message: 'connected', code: null },
    };
    const errors = validateRemoteEventSequence([
      base,
      { ...base, eventId: 'event-1', sequence: 1, sessionId: 'session-2' },
    ]);
    expect(errors).toEqual(expect.arrayContaining([
      'duplicate eventId: event-1',
      'mixed sessionId: session-2',
      'sequence must increase: 2 -> 1',
    ]));
  });
});
