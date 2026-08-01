import type { ServerResponse } from 'node:http';
import type { AnyRemoteEvent } from '../../shared/remote-protocol.js';

export interface SseSessionOptions {
  heartbeatMs?: number;
  maxQueuedBytes?: number;
  onClose?: () => void;
}

function serializeEvent(event: AnyRemoteEvent): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * A bounded SSE writer. Node owns the chunk that made write() return false;
 * subsequent events are kept in our bounded queue until drain.
 */
export class SseSession {
  private readonly heartbeatMs: number;
  private readonly maxQueuedBytes: number;
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private backpressured = false;
  private closed = false;
  private replaying = true;
  private readonly replayQueue: AnyRemoteEvent[] = [];
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly response: ServerResponse,
    options: SseSessionOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024;
    response.on('drain', () => this.flush());
    response.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.heartbeat);
      options.onClose?.();
    });
    this.heartbeat = setInterval(() => {
      if (!this.backpressured) this.writeRaw(`: heartbeat ${Date.now()}\n\n`);
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  send(event: AnyRemoteEvent): void {
    if (this.closed) return;
    if (this.replaying) {
      this.replayQueue.push(event);
      return;
    }
    this.writeRaw(serializeEvent(event));
  }

  finishReplay(replayed: readonly AnyRemoteEvent[]): void {
    if (this.closed) return;
    let lastSequence = 0;
    for (const event of replayed) {
      this.writeRaw(serializeEvent(event));
      lastSequence = Math.max(lastSequence, event.sequence);
    }
    this.replaying = false;
    this.replayQueue
      .filter((event) => event.sequence > lastSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .forEach((event) => this.writeRaw(serializeEvent(event)));
    this.replayQueue.length = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.response.end();
  }

  private writeRaw(chunk: string): void {
    if (this.closed) return;
    if (this.backpressured) {
      const bytes = Buffer.byteLength(chunk);
      if (this.queuedBytes + bytes > this.maxQueuedBytes) {
        this.close();
        return;
      }
      this.queue.push(chunk);
      this.queuedBytes += bytes;
      return;
    }
    this.backpressured = !this.response.write(chunk);
  }

  private flush(): void {
    if (this.closed) return;
    this.backpressured = false;
    while (this.queue.length > 0 && !this.backpressured) {
      const chunk = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(chunk);
      this.backpressured = !this.response.write(chunk);
    }
  }
}
