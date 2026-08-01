import { randomUUID } from 'node:crypto';
import {
  REMOTE_PROTOCOL_VERSION,
  type AnyRemoteEvent,
  type RemoteEventEnvelope,
  type RemoteEventPayloadMap,
  type RemoteEventType,
  type RemoteTimelineResponse,
} from '../../shared/remote-protocol.js';

export interface SessionEventJournalOptions {
  maxEventsPerSession?: number;
  maxSessions?: number;
  now?: () => Date;
  createEventId?: (sessionId: string, sequence: number) => string;
}

export interface JournalReadOptions {
  afterEventId?: string;
  afterSequence?: number;
  limit?: number;
}

interface SessionJournal {
  nextSequence: number;
  events: AnyRemoteEvent[];
  eventSequences: Map<string, number>;
}

export class JournalCursorExpiredError extends Error {
  readonly code = 'JOURNAL_CURSOR_EXPIRED';

  constructor(
    readonly sessionId: string,
    readonly eventId: string,
    readonly earliestSequence: number,
  ) {
    super(`Event cursor ${eventId} is no longer retained for session ${sessionId}`);
    this.name = 'JournalCursorExpiredError';
  }
}

/**
 * Bounded in-memory event journal.
 *
 * sequence is allocated once at append time and remains the only ordering key.
 * Old entries may be evicted, but sequence numbers are never reused.
 */
export class SessionEventJournal {
  private readonly maxEventsPerSession: number;
  private readonly maxSessions: number;
  private readonly now: () => Date;
  private readonly createEventId: (sessionId: string, sequence: number) => string;
  private readonly sessions = new Map<string, SessionJournal>();

  constructor(options: SessionEventJournalOptions = {}) {
    this.maxEventsPerSession = Math.max(1, options.maxEventsPerSession ?? 2_000);
    this.maxSessions = Math.max(1, options.maxSessions ?? 64);
    this.now = options.now ?? (() => new Date());
    this.createEventId = options.createEventId
      ?? ((sessionId, sequence) => `${sessionId}:${sequence}:${randomUUID()}`);
  }

  append<TType extends RemoteEventType>(
    sessionId: string,
    turnId: string | null,
    type: TType,
    payload: RemoteEventPayloadMap[TType],
  ): RemoteEventEnvelope<TType, RemoteEventPayloadMap[TType]> {
    const journal = this.getOrCreate(sessionId);
    const sequence = journal.nextSequence++;
    const event: RemoteEventEnvelope<TType, RemoteEventPayloadMap[TType]> = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      eventId: this.createEventId(sessionId, sequence),
      timestamp: this.now().toISOString(),
      sessionId,
      turnId,
      sequence,
      type,
      payload,
    };

    journal.events.push(event as AnyRemoteEvent);
    journal.eventSequences.set(event.eventId, sequence);
    while (journal.events.length > this.maxEventsPerSession) {
      const removed = journal.events.shift();
      if (removed) journal.eventSequences.delete(removed.eventId);
    }
    return event;
  }

  read(sessionId: string, options: JournalReadOptions = {}): RemoteTimelineResponse {
    const journal = this.sessions.get(sessionId);
    if (!journal) return { events: [], nextSequence: 1 };

    let afterSequence = options.afterSequence ?? 0;
    if (options.afterEventId) {
      const cursorSequence = journal.eventSequences.get(options.afterEventId);
      if (cursorSequence === undefined) {
        const earliestSequence = journal.events[0]?.sequence ?? journal.nextSequence;
        throw new JournalCursorExpiredError(sessionId, options.afterEventId, earliestSequence);
      }
      afterSequence = Math.max(afterSequence, cursorSequence);
    }

    const limit = Math.max(1, options.limit ?? this.maxEventsPerSession);
    const events = journal.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit);
    const nextSequence = events.at(-1)?.sequence
      ? events.at(-1)!.sequence + 1
      : Math.max(afterSequence + 1, journal.events[0]?.sequence ?? journal.nextSequence);
    return { events, nextSequence };
  }

  getLastSequence(sessionId: string): number {
    return (this.sessions.get(sessionId)?.nextSequence ?? 1) - 1;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  private getOrCreate(sessionId: string): SessionJournal {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Refresh insertion order so the least recently appended session is evicted first.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }

    while (this.sessions.size >= this.maxSessions) {
      const oldestSessionId = this.sessions.keys().next().value as string | undefined;
      if (!oldestSessionId) break;
      this.sessions.delete(oldestSessionId);
    }
    const created: SessionJournal = {
      nextSequence: 1,
      events: [],
      eventSequences: new Map(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }
}
