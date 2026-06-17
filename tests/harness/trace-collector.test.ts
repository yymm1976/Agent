// tests/harness/trace-collector.test.ts
// TraceCollector 单元测试

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import type { ReActEvent, TokenUsageInfo } from '../../src/agent/loop-config.js';
import type { RoutingResult } from '../../src/router/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TraceCollector', () => {
  describe('startSession', () => {
    it('should return 8-character session ID', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const id = tc.startSession('hello');
      expect(id).toHaveLength(8);
    });

    it('should store user input', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const id = tc.startSession('what is the meaning of life?');
      expect(tc.getSessionId()).toBe(id);
    });

    it('should truncate long user input', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const longInput = 'x'.repeat(500);
      tc.startSession(longInput);
      // session will be persisted on endSession
    });
  });

  describe('recordEvent', () => {
    it('should create react_iteration span for thinking event', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      const event: ReActEvent = { type: 'thinking', message: 'Let me think...' };
      tc.recordEvent(event);
      const spans = tc.getSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].type).toBe('react_iteration');
    });

    it('should create tool_call span for tool_call_start', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      tc.recordEvent({
        type: 'tool_call_start',
        toolName: 'file_read',
        toolCallId: 'call-1',
      });
      const spans = tc.getSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].type).toBe('tool_call');
    });

    it('should complete tool_call span on tool_call_result', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      tc.recordEvent({ type: 'tool_call_start', toolName: 'file_read', toolCallId: 'c1' });
      tc.recordEvent({ type: 'tool_call_result', toolName: 'file_read', toolCallId: 'c1', result: 'ok', isError: false });
      const spans = tc.getSpans();
      expect(spans[0].status).toBe('completed');
    });

    it('should fail span on error event', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      tc.recordEvent({ type: 'thinking', message: 'hmm' });
      tc.recordEvent({ type: 'error', error: 'something failed' });
      const spans = tc.getSpans();
      expect(spans[0].status).toBe('error');
    });

    it('should record usage from done event', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      const usage: TokenUsageInfo = { inputTokens: 100, outputTokens: 50 };
      tc.recordEvent({ type: 'done', content: 'result', usage });
      await tc.endSession();
      const sessions = await tc.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].totalUsage?.inputTokens).toBe(100);
    });
  });

  describe('recordToolCall / recordToolResult', () => {
    it('should create span with approval flag', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      const span = tc.recordToolCall('shell_exec', { command: 'ls' }, 'c1', true);
      expect(span).not.toBeNull();
      expect(span!.type).toBe('tool_call');
    });

    it('should mark tool result as completed', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      tc.recordToolCall('shell_exec', { command: 'ls' }, 'c1', false);
      tc.recordToolResult('shell_exec', 'c1', 'file.txt', false);
      const spans = tc.getSpans();
      expect(spans[0].status).toBe('completed');
    });
  });

  describe('recordLLMCall', () => {
    it('should create and complete llm_call span', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      tc.recordLLMCall('gpt-4', { inputTokens: 10, outputTokens: 20 }, 100, 0);
      const spans = tc.getSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].type).toBe('llm_call');
      expect(spans[0].status).toBe('completed');
    });
  });

  describe('recordWorkerTask', () => {
    it('should create worker_task span with role', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      const spanId = tc.recordWorkerTask('coder', 'implement auth', 1);
      expect(spanId).toBeGreaterThan(0);
      const spans = tc.getSpans();
      expect(spans[0].type).toBe('worker_task');
      expect(spans[0].workerRole).toBe('coder');
    });

    it('should complete worker task', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      const spanId = tc.recordWorkerTask('coder', 'do', 1);
      tc.completeWorkerTask(spanId, true, 'done', ['auth.ts']);
      const spans = tc.getSpans();
      expect(spans[0].status).toBe('completed');
      expect((spans[0].payload as any).modifiedFiles).toContain('auth.ts');
    });
  });

  describe('endSession + persistence', () => {
    it('should write session.json and spans.json', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test query');
      tc.recordEvent({ type: 'thinking', message: 'thinking...' });
      await tc.endSession();

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = path.join(tempDir, today);
      const files = await fs.readdir(dayDir);
      const sessionFiles = files.filter(f => f.endsWith('.session.json'));
      const spansFiles = files.filter(f => f.endsWith('.spans.json'));
      expect(sessionFiles.length).toBeGreaterThan(0);
      expect(spansFiles.length).toBeGreaterThan(0);
    });
  });

  describe('listSessions', () => {
    it('should list persisted sessions', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test');
      await tc.endSession();
      const sessions = await tc.listSessions();
      expect(sessions.length).toBe(1);
    });

    it('should return empty when no sessions', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const sessions = await tc.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('maxSpansPerSession limit', () => {
    it('should drop oldest spans when limit exceeded', () => {
      const tc = new TraceCollector({ storageDir: tempDir, maxSpansPerSession: 3 });
      tc.startSession('test');
      for (let i = 0; i < 5; i++) {
        tc.recordEvent({ type: 'thinking', message: `thought ${i}` });
      }
      const spans = tc.getSpans();
      expect(spans.length).toBe(3);
    });
  });

  describe('disabled mode', () => {
    it('should not create any spans when disabled', () => {
      const tc = new TraceCollector({ storageDir: tempDir, enabled: false });
      tc.startSession('test');
      tc.recordEvent({ type: 'thinking', message: 'hmm' });
      expect(tc.getSpans().length).toBe(0);
    });

    it('should return -1 from recordWorkerTask when disabled', () => {
      const tc = new TraceCollector({ storageDir: tempDir, enabled: false });
      tc.startSession('test');
      expect(tc.recordWorkerTask('coder', 'x', 1)).toBe(-1);
    });
  });

  describe('route decision', () => {
    it('should capture routing decision at startSession', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const route: RoutingResult = {
        model: { id: 'gpt-4', tier: 'complex' } as any,
        providerId: 'openai',
        fallbackUsed: false,
        originalTier: 'complex',
        degraded: false,
      };
      tc.startSession('test', route);
      await tc.endSession();
      const sessions = await tc.listSessions();
      expect(sessions[0].routeDecision?.modelId).toBe('gpt-4');
      expect(sessions[0].routeDecision?.tier).toBe('complex');
    });
  });

  describe('readSessionRecords', () => {
    it('should return records for a given session', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const id = tc.startSession('test');
      tc.recordEvent({ type: 'thinking', message: 'thinking...' });
      await tc.endSession();
      const records = await tc.readSessionRecords(id);
      expect(records.length).toBeGreaterThan(0);
    });

    it('should return empty for unknown session', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const records = await tc.readSessionRecords('nonexistent');
      expect(records).toEqual([]);
    });
  });
});