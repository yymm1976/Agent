import type {
  AnyRemoteEvent,
  RemoteEventEnvelope,
  RemoteEventPayloadMap,
  RemoteEventType,
} from '../../shared/remote-protocol.js';
import {
  SessionEventJournal,
  type SessionEventJournalOptions,
} from './session-event-journal.js';

export type EngineEventListener = (event: AnyRemoteEvent) => void | Promise<void>;

export interface EngineEventSubscription {
  sessionId?: string;
}

/**
 * Single ordered fan-out point for renderer adapters, SSE clients and tests.
 *
 * publish() always journals first. Listener failures are isolated and async
 * listeners are intentionally not awaited so a disconnected phone cannot stall
 * the desktop Agent loop.
 */
export class EngineEventHub {
  readonly journal: SessionEventJournal;
  private readonly listeners = new Map<EngineEventListener, EngineEventSubscription>();

  constructor(journalOptions: SessionEventJournalOptions = {}) {
    this.journal = new SessionEventJournal(journalOptions);
  }

  publish<TType extends RemoteEventType>(
    sessionId: string,
    turnId: string | null,
    type: TType,
    payload: RemoteEventPayloadMap[TType],
  ): RemoteEventEnvelope<TType, RemoteEventPayloadMap[TType]> {
    const event = this.journal.append(sessionId, turnId, type, payload);
    for (const [listener, subscription] of this.listeners) {
      if (subscription.sessionId && subscription.sessionId !== sessionId) continue;
      try {
        Promise.resolve(listener(event as AnyRemoteEvent)).catch(() => undefined);
      } catch {
        // A consumer is observational. It must never break the engine event path.
      }
    }
    return event;
  }

  subscribe(
    listener: EngineEventListener,
    subscription: EngineEventSubscription = {},
  ): () => void {
    this.listeners.set(listener, subscription);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.listeners.clear();
  }
}
