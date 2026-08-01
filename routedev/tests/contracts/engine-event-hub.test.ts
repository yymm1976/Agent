import { describe, expect, it, vi } from 'vitest';
import {
  ChatStreamEventPublisher,
  EngineEventHub,
  JournalCursorExpiredError,
  SessionEventJournal,
} from '../../desktop/main/remote/index.js';
import { validateRemoteEventSequence } from '../../desktop/shared/remote-protocol.js';

describe('SessionEventJournal', () => {
  it('allocates a strict sequence and preserves real reasoning/tool ordering', () => {
    const journal = new SessionEventJournal({
      now: () => new Date('2026-07-30T08:00:00.000Z'),
      createEventId: (_sessionId, sequence) => `event-${sequence}`,
    });

    journal.append('session-1', 'turn-1', 'assistant.reasoning.delta', {
      text: '先检查文件',
      visibility: 'provider_returned',
    });
    journal.append('session-1', 'turn-1', 'tool.started', {
      toolCallId: 'tool-1',
      toolName: 'file_read',
      argsSummary: 'README.md',
    });
    journal.append('session-1', 'turn-1', 'tool.completed', {
      toolCallId: 'tool-1',
      outputSummary: '读取完成',
    });
    journal.append('session-1', 'turn-1', 'assistant.reasoning.delta', {
      text: '继续分析结果',
      visibility: 'provider_returned',
    });

    const timeline = journal.read('session-1');
    expect(timeline.events.map((event) => event.type)).toEqual([
      'assistant.reasoning.delta',
      'tool.started',
      'tool.completed',
      'assistant.reasoning.delta',
    ]);
    expect(timeline.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(validateRemoteEventSequence(timeline.events)).toEqual([]);
  });

  it('replays after Last-Event-ID and rejects an evicted cursor', () => {
    const journal = new SessionEventJournal({
      maxEventsPerSession: 2,
      createEventId: (_sessionId, sequence) => `event-${sequence}`,
    });
    journal.append('session-1', null, 'connection.notice', {
      level: 'info',
      message: 'one',
      code: null,
    });
    journal.append('session-1', null, 'connection.notice', {
      level: 'info',
      message: 'two',
      code: null,
    });
    journal.append('session-1', null, 'connection.notice', {
      level: 'info',
      message: 'three',
      code: null,
    });

    expect(journal.read('session-1', { afterEventId: 'event-2' }).events)
      .toHaveLength(1);
    expect(() => journal.read('session-1', { afterEventId: 'event-1' }))
      .toThrow(JournalCursorExpiredError);
  });

  it('bounds the number of retained sessions without reusing sequences', () => {
    const journal = new SessionEventJournal({ maxSessions: 1 });
    journal.append('session-1', null, 'connection.notice', {
      level: 'info',
      message: 'first',
      code: null,
    });
    journal.append('session-2', null, 'connection.notice', {
      level: 'info',
      message: 'second',
      code: null,
    });

    expect(journal.hasSession('session-1')).toBe(false);
    expect(journal.getLastSequence('session-2')).toBe(1);
  });
});

describe('EngineEventHub', () => {
  it('journals before fan-out and isolates failing or slow subscribers', async () => {
    const hub = new EngineEventHub({
      createEventId: (_sessionId, sequence) => `event-${sequence}`,
    });
    const observedSequences: number[] = [];
    const slow = vi.fn(async () => new Promise<void>(() => undefined));

    hub.subscribe((event) => {
      observedSequences.push(
        hub.journal.read(event.sessionId).events.at(-1)?.sequence ?? 0,
      );
      throw new Error('observer failed');
    });
    hub.subscribe(slow);
    hub.subscribe(() => {
      observedSequences.push(99);
    }, { sessionId: 'another-session' });

    const event = hub.publish('session-1', 'turn-1', 'assistant.text.delta', {
      text: 'hello',
    });

    expect(event.sequence).toBe(1);
    expect(observedSequences).toEqual([1]);
    expect(slow).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes only that listener', () => {
    const hub = new EngineEventHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);
    unsubscribe();

    hub.publish('session-1', null, 'connection.notice', {
      level: 'info',
      message: 'connected',
      code: null,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(hub.journal.getLastSequence('session-1')).toBe(1);
  });
});

describe('ChatStreamEventPublisher', () => {
  it('keeps renderer events and remote events in one real-time order', () => {
    const hub = new EngineEventHub({
      createEventId: (_sessionId, sequence) => `event-${sequence}`,
    });
    const rendererTypes: string[] = [];
    const publisher = new ChatStreamEventPublisher(
      hub,
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        clientMessageId: 'message-1',
      },
      (payload) => rendererTypes.push(payload.type),
    );

    publisher.start('检查项目');
    publisher.emit({ type: 'reasoning_delta', reasoning: '先读文档' });
    publisher.emit({
      type: 'tool_start',
      toolName: 'file_read',
      toolCallId: 'tool-1',
      toolArgs: { path: 'README.md' },
    });
    publisher.emit({
      type: 'tool_done',
      toolName: 'file_read',
      toolCallId: 'tool-1',
      toolResult: 'done',
    });
    publisher.emit({ type: 'reasoning_delta', reasoning: '继续分析' });
    publisher.emit({
      type: 'done',
      completionStatus: 'completed_unverified',
    });

    expect(rendererTypes).toEqual([
      'reasoning_delta',
      'tool_start',
      'tool_done',
      'reasoning_delta',
      'done',
    ]);
    expect(hub.journal.read('session-1').events.map((event) => event.type))
      .toEqual([
        'turn.started',
        'assistant.reasoning.delta',
        'tool.started',
        'tool.completed',
        'assistant.reasoning.delta',
        'turn.completed',
      ]);
  });

  it('does not turn synthetic thinking copy into model progress', () => {
    const hub = new EngineEventHub();
    const renderer = vi.fn();
    const publisher = new ChatStreamEventPublisher(
      hub,
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        clientMessageId: 'message-1',
      },
      renderer,
    );
    publisher.start('hello');
    publisher.emit({ type: 'thinking', message: '模型思考中...' });

    expect(renderer).toHaveBeenCalledOnce();
    expect(hub.journal.read('session-1').events.map((event) => event.type))
      .toEqual(['turn.started']);
  });

  it('emits only one terminal event after failure and done', () => {
    const hub = new EngineEventHub();
    const publisher = new ChatStreamEventPublisher(
      hub,
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        clientMessageId: 'message-1',
      },
      () => undefined,
    );
    publisher.start('hello');
    publisher.emit({ type: 'error', error: 'provider failed' });
    publisher.emit({ type: 'done' });

    expect(hub.journal.read('session-1').events.map((event) => event.type))
      .toEqual(['turn.started', 'turn.failed']);
  });
});
