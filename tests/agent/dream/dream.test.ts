// tests/agent/dream/dream.test.ts
// DreamConsolidator 单元测试

import { describe, it, expect, vi } from 'vitest';
import { DreamConsolidator } from '../../../src/agent/dream-consolidator.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse } from '../../../src/router/types.js';
import type { CheckpointData } from '../../../src/agent/memory/types.js';

function makeMockClient(response: string | null = null): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => {
      if (response === null) {
        return { content: 'invalid', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      }
      return { content: response, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }),
    stream: vi.fn(async function* () { /* */ }),
  };
}

function makeLargeCheckpoint(): CheckpointData {
  return {
    currentIntent: '完成功能',
    nextAction: '测试',
    workingConstraints: ['约束1', '约束2', '约束3', '约束4', '约束5', '约束6'],
    taskTree: { description: 'main', status: 'in_progress', children: [] },
    currentWorkingFiles: ['a.ts', 'b.ts', 'c.ts'],
    involvedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    crossTaskDiscoveries: ['发现1', '发现2', '发现3', '发现4', '发现5', '发现6', '发现7'],
    errorsAndFixes: [
      { error: 'err1', fix: 'fix1', resolved: true },
      { error: 'err2', fix: 'fix2', resolved: false },
    ],
    runtimeState: { key1: 'v1', key2: 'v2' },
    designDecisions: [{ decision: 'd1', reason: 'r1' }, { decision: 'd2', reason: 'r2' }],
    miscNotes: ['note1', 'note2', 'note3'],
  };
}

describe('DreamConsolidator', () => {
  it('should return early when no checkpoint', async () => {
    const consolidator = new DreamConsolidator({
      llmClient: makeMockClient(),
      modelId: 'test',
    });
    const result = await consolidator.consolidate(null as any);
    expect(result.summary).toContain('没有记忆');
    expect(result.beforeSize).toBe(0);
  });

  it('should skip LLM when below threshold', async () => {
    const client = makeMockClient('{"currentIntent":"merged"}');
    const consolidator = new DreamConsolidator({
      llmClient: client,
      modelId: 'test',
      threshold: 100,
    });
    const small: CheckpointData = {
      currentIntent: 'small',
      nextAction: '',
      workingConstraints: [],
      taskTree: { description: '', status: 'pending', children: [] },
      currentWorkingFiles: [],
      involvedFiles: [],
      crossTaskDiscoveries: [],
      errorsAndFixes: [],
      runtimeState: {},
      designDecisions: [],
      miscNotes: [],
    };
    const result = await consolidator.consolidate(small);
    expect(result.summary).toContain('低于阈值');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('should call LLM and merge when above threshold', async () => {
    const merged: CheckpointData = {
      currentIntent: '合并后的意图',
      nextAction: '下一步',
      workingConstraints: ['核心约束'],
      taskTree: { description: 'task', status: 'in_progress', children: [] },
      currentWorkingFiles: ['x.ts'],
      involvedFiles: ['x.ts', 'y.ts'],
      crossTaskDiscoveries: ['重要发现'],
      errorsAndFixes: [{ error: 'e', fix: 'f', resolved: true }],
      runtimeState: { k: 'v' },
      designDecisions: [{ decision: 'd', reason: 'r' }],
      miscNotes: [],
    };
    const client = makeMockClient(JSON.stringify(merged));
    const consolidator = new DreamConsolidator({
      llmClient: client,
      modelId: 'test',
      threshold: 5,
    });

    const result = await consolidator.consolidate(makeLargeCheckpoint());
    expect(client.complete).toHaveBeenCalled();
    expect(result.consolidated.currentIntent).toBe('合并后的意图');
    expect(result.summary).toContain('整理完成');
  });

  it('should fallback to original on parse error', async () => {
    const client = makeMockClient(null);
    const consolidator = new DreamConsolidator({
      llmClient: client,
      modelId: 'test',
      threshold: 5,
    });
    const result = await consolidator.consolidate(makeLargeCheckpoint());
    expect(result.summary).toContain('解析失败');
    expect(result.consolidated).toBeTruthy();
  });

  it('should fallback to original on LLM error', async () => {
    const client: ILLMClient = {
      isReady: () => true,
      complete: vi.fn(async () => { throw new Error('LLM down'); }),
      stream: vi.fn(async function* () { /* */ }),
    };
    const consolidator = new DreamConsolidator({
      llmClient: client,
      modelId: 'test',
      threshold: 5,
    });
    const result = await consolidator.consolidate(makeLargeCheckpoint());
    expect(result.summary).toContain('整理失败');
  });
});
