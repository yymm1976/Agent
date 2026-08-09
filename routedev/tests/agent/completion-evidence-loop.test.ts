import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import { RunEventLog } from '../../src/harness/run-event-log.js';
import type { ILLMClient, LLMRequestOptions, LLMStreamEvent, RoutingResult } from '../../src/router/types.js';

function route(): RoutingResult {
  return {
    model: {
      id: 'mock-model', name: 'mock', provider: 'mock', tier: 'simple', contextWindow: 32_000,
      capabilities: ['tool_use'], latencyMs: 0, available: true,
    },
    providerId: 'mock', fallbackUsed: false, originalTier: 'simple', degraded: false,
  };
}

function toolEvents(id: string, name: string, args: Record<string, unknown>): LLMStreamEvent[] {
  return [
    { type: 'tool_call_start', toolCall: { id, name } },
    { type: 'tool_call_delta', toolCallId: id, argumentsDelta: JSON.stringify(args) },
    { type: 'tool_call_end', toolCallId: id },
    { type: 'done', finishReason: 'tool_use' },
  ];
}

function executor(): ToolExecutorAdapter {
  return {
    getToolDefinitions: () => [
      { name: 'file_edit', description: 'edit', parameters: { type: 'object', properties: {} } },
      { name: 'shell_exec', description: 'shell', parameters: { type: 'object', properties: {} } },
    ],
    hasTool: () => true,
    getToolExecutionMode: (name) => name === 'file_edit' || name === 'shell_exec' ? 'sequential' : 'parallel',
    executeTool: async (name) => name === 'shell_exec' ? 'tests passed' : 'file edited',
  };
}

describe('completion evidence production loop wiring', () => {
  it('recovers stale verification and emits run_completed only after latest epoch is verified', async () => {
    let round = 0;
    const requests: string[] = [];
    const client: ILLMClient = {
      protocol: 'openai', providerId: 'mock', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
      stream: async function* (options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
        round++;
        requests.push(JSON.stringify(options.messages));
        if (round === 1) {
          yield* toolEvents('edit-1', 'file_edit', { path: 'src/a.ts', oldString: 'a', newString: 'b' });
        } else if (round === 2) {
          yield { type: 'text_delta', text: 'done too early' };
          yield { type: 'done', finishReason: 'stop' };
        } else if (round === 3) {
          yield* toolEvents('test-1', 'shell_exec', { command: 'pnpm test' });
        } else {
          yield { type: 'text_delta', text: 'verified completion' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const loop = new ReActAgentLoop(executor());
    const log = new RunEventLog('completion-recovery', mkdtempSync(join(tmpdir(), 'routedev-completion-log-')));
    loop.setRunEventLog(log);
    for await (const _event of loop.run({
      requestId: 'completion-recovery',
      userMessage: 'Fix src/a.ts and keep all tests green.',
      llmClient: client,
      routeDecision: route(),
      conversationHistory: [],
      autonomyMode: 'auto',
      workspace: { workingDirectory: process.cwd(), allowedDirectories: [process.cwd()] },
    })) { /* consume */ }

    expect(round).toBe(4);
    expect(requests[2]).toContain('完成证据门');
    expect(log.getEvents().filter((event) => event.type === 'run_completed')).toHaveLength(1);
    expect(log.getEvents().filter((event) => event.type === 'run_interrupted')).toHaveLength(0);
  });

  it('records completion_evidence_missing instead of false success after two recoveries', async () => {
    let rounds = 0;
    const client: ILLMClient = {
      protocol: 'openai', providerId: 'mock', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        rounds++;
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const loop = new ReActAgentLoop(executor());
    const log = new RunEventLog('completion-interrupt', mkdtempSync(join(tmpdir(), 'routedev-completion-log-')));
    loop.setRunEventLog(log);
    for await (const _event of loop.run({
      requestId: 'completion-interrupt',
      userMessage: 'Implement src/a.ts and run the tests.',
      llmClient: client,
      routeDecision: route(),
      conversationHistory: [],
      autonomyMode: 'auto',
    })) { /* consume */ }

    expect(rounds).toBe(3);
    expect(log.getEvents().some((event) => event.type === 'run_completed')).toBe(false);
    const interrupted = log.getEvents().find((event) => event.type === 'run_interrupted');
    expect(interrupted?.type === 'run_interrupted' ? interrupted.payload.reason : '').toBe('completion_evidence_missing');
  });

  it('allows a conformance harness to explicitly disable completion evidence without changing the default', async () => {
    let rounds = 0;
    const client: ILLMClient = {
      protocol: 'openai', providerId: 'mock', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        rounds++;
        yield { type: 'text_delta', text: 'conformance complete' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const loop = new ReActAgentLoop(executor());
    const log = new RunEventLog('completion-disabled', mkdtempSync(join(tmpdir(), 'routedev-completion-log-')));
    loop.setRunEventLog(log);
    for await (const _event of loop.run({
      requestId: 'completion-disabled',
      userMessage: 'Implement src/a.ts and run the tests.',
      llmClient: client,
      routeDecision: route(),
      conversationHistory: [],
      autonomyMode: 'auto',
      completionEvidenceEnabled: false,
    })) { /* consume */ }

    expect(rounds).toBe(1);
    expect(log.getEvents().filter((event) => event.type === 'run_completed')).toHaveLength(1);
    expect(log.getEvents().filter((event) => event.type === 'run_interrupted')).toHaveLength(0);
  });

  it('gives cancellation priority while a completion recovery is in flight', async () => {
    const controller = new AbortController();
    let rounds = 0;
    const client: ILLMClient = {
      protocol: 'openai', providerId: 'mock', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        rounds++;
        if (rounds === 2) controller.abort();
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const loop = new ReActAgentLoop(executor());
    const log = new RunEventLog('completion-cancel', mkdtempSync(join(tmpdir(), 'routedev-completion-log-')));
    loop.setRunEventLog(log);
    for await (const _event of loop.run({
      requestId: 'completion-cancel',
      userMessage: 'Implement src/a.ts and run the tests.',
      llmClient: client,
      routeDecision: route(),
      conversationHistory: [],
      autonomyMode: 'auto',
      signal: controller.signal,
    })) { /* consume */ }

    expect(rounds).toBe(2);
    expect(log.getEvents().some((event) => event.type === 'run_completed')).toBe(false);
    const interrupted = log.getEvents().find((event) => event.type === 'run_interrupted');
    expect(interrupted?.type === 'run_interrupted' ? interrupted.payload.reason : '').toContain('用户取消');
  });
});
