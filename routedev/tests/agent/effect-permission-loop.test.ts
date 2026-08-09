import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import { AgentMiddlewarePipeline } from '../../src/agent/middleware.js';
import { PermissionMiddleware } from '../../src/agent/middleware/permission-middleware.js';
import { PermissionEngine, type PermissionRule } from '../../src/tools/permission-engine.js';
import { RunEventLog } from '../../src/harness/run-event-log.js';
import type { ILLMClient, LLMStreamEvent, RoutingResult } from '../../src/router/types.js';

const protectTests: PermissionRule = {
  id: 'protect-tests-effects',
  layer: 'deny',
  toolPattern: 'file_*',
  effectKinds: ['fs.write', 'fs.create', 'fs.delete', 'fs.move'],
  resourcePatterns: ['tests/**'],
  argsPredicate: (args) => String(args.path ?? '').replace(/\\/g, '/').startsWith('tests/'),
  description: 'tests are protected',
};

function route(): RoutingResult {
  return {
    model: {
      id: 'mock-model', name: 'mock', provider: 'mock', tier: 'simple',
      contextWindow: 32_000, capabilities: ['tool_use'], latencyMs: 0, available: true,
    },
    providerId: 'mock', fallbackUsed: false, originalTier: 'simple', degraded: false,
  };
}

function repairedCallClient(): ILLMClient {
  let round = 0;
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      round++;
      if (round === 1) {
        yield { type: 'reasoning_delta', text: '{"name":"file_write","arguments":{"path":"tests/scavenged.ts","content":"x"}}' };
        yield { type: 'tool_call_start', toolCall: { id: 'read-1', name: 'file_read' } };
        yield { type: 'tool_call_delta', toolCallId: 'read-1', argumentsDelta: '{"path":"src/a.ts"}' };
        yield { type: 'tool_call_end', toolCallId: 'read-1' };
        yield { type: 'done', finishReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  };
}

describe('effect permission production loop wiring', () => {
  it('authorizes repaired final calls and emits structured rejection evidence', async () => {
    const executed: string[] = [];
    const executor: ToolExecutorAdapter = {
      getToolDefinitions: () => [
        { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} } },
        { name: 'file_write', description: 'write', parameters: { type: 'object', properties: {} } },
      ],
      hasTool: () => true,
      executeTool: async (name) => {
        executed.push(name);
        return name === 'file_read' ? 'ok' : 'unexpected';
      },
    };
    const engine = new PermissionEngine();
    engine.loadRules([protectTests]);
    const pipeline = new AgentMiddlewarePipeline();
    pipeline.register('onActing', new PermissionMiddleware(engine, 'auto').getHandler());
    const loop = new ReActAgentLoop(executor, { parallelToolExecution: true });
    loop.setMiddlewarePipeline(pipeline);
    const log = new RunEventLog('repair-final-auth', mkdtempSync(join(tmpdir(), 'routedev-run-log-')));
    loop.setRunEventLog(log);

    for await (const _event of loop.run({
      requestId: 'repair-final-auth',
      userMessage: 'inspect source',
      llmClient: repairedCallClient(),
      routeDecision: route(),
      conversationHistory: [],
      autonomyMode: 'auto',
      workspace: { workingDirectory: process.cwd(), allowedDirectories: [process.cwd()] },
    })) { /* consume */ }

    expect(executed).toEqual(['file_read']);
    const rejected = log.getEvents().find((event) => event.type === 'tool_rejected');
    expect(rejected?.type).toBe('tool_rejected');
    if (rejected?.type === 'tool_rejected') {
      expect(rejected.payload.policyRuleId).toBe('protect-tests-effects');
      expect(rejected.payload.effectKind).toBe('fs.write');
      expect(rejected.payload.resource).toBe('tests/scavenged.ts');
      expect(JSON.stringify(rejected.payload)).not.toContain('"content":"x"');
    }
  });
});
