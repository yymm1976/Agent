// tests/memory/checkpoint-writer.test.ts
// CheckpointWriter 单元测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CheckpointWriter } from '../../src/agent/memory/checkpoint-writer.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, LLMMessage } from '../../src/router/types.js';
import type { CheckpointData, CheckpointLevel } from '../../src/agent/memory/types.js';

function createMockClient(response: string): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => {
      return {
        content: response,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }),
    stream: vi.fn(async function* () { /* not used */ }),
  };
}

const minimalCheckpoint: CheckpointData = {
  currentIntent: '完成测试',
  nextAction: '编写测试',
  workingConstraints: ['不允许 break 现有测试'],
  taskTree: { description: '完成测试', status: 'in_progress', children: [] },
  currentWorkingFiles: ['foo.ts'],
  involvedFiles: ['foo.ts', 'bar.ts'],
  crossTaskDiscoveries: ['foo 和 bar 共享类型'],
  errorsAndFixes: [{ error: 'TS 错误', fix: '修复 import', resolved: true }],
  runtimeState: { node: 'v20' },
  designDecisions: [{ decision: '使用 vitest', reason: '速度快' }],
  miscNotes: ['需要 mock'],
};

const sampleMessages: LLMMessage[] = [
  { role: 'user', content: '我要写测试' },
  { role: 'assistant', content: '好的，我先看代码' },
];

describe('CheckpointWriter', () => {
  let tempNotesPath: string;

  beforeEach(() => {
    tempNotesPath = path.join(os.tmpdir(), `routedev-notes-${Date.now()}-${Math.random()}.md`);
    // 确保文件不存在
    try { fs.unlinkSync(tempNotesPath); } catch { /* noop */ }
  });

  it('should parse initial checkpoint from JSON response', async () => {
    const response = JSON.stringify(minimalCheckpoint);
    const client = createMockClient(response);
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(output).not.toBeNull();
    expect(output!.checkpoint.currentIntent).toBe('完成测试');
    expect(output!.checkpoint.workingConstraints).toContain('不允许 break 现有测试');
  });

  it('should parse JSON wrapped in markdown code block', async () => {
    const response = '```json\n' + JSON.stringify(minimalCheckpoint) + '\n```';
    const client = createMockClient(response);
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(output).not.toBeNull();
    expect(output!.checkpoint.currentIntent).toBe('完成测试');
  });

  it('should return null on invalid JSON', async () => {
    const client = createMockClient('not valid json at all');
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(output).toBeNull();
  });

  it('should fill missing fields with defaults', async () => {
    const response = JSON.stringify({ currentIntent: 'minimal' });
    const client = createMockClient(response);
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(output).not.toBeNull();
    expect(output!.checkpoint.currentIntent).toBe('minimal');
    expect(output!.checkpoint.workingConstraints).toEqual([]);
    expect(output!.checkpoint.involvedFiles).toEqual([]);
  });

  it('should merge incremental with previous', async () => {
    const response = JSON.stringify({
      currentIntent: '新意图',
      involvedFiles: ['new.ts'],
      errorsAndFixes: [{ error: '新错误', fix: '新修复', resolved: false }],
    });
    const client = createMockClient(response);
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const output = await writer.write({
      level: 'incremental',
      recentMessages: sampleMessages,
      previousCheckpoint: minimalCheckpoint,
      notes: '',
      usagePercent: 0.45,
    });

    expect(output).not.toBeNull();
    // 合并：involvedFiles 应包含新的和旧的
    expect(output!.checkpoint.involvedFiles).toContain('new.ts');
    expect(output!.checkpoint.involvedFiles).toContain('foo.ts');
    expect(output!.checkpoint.involvedFiles).toContain('bar.ts');
    // errorsAndFixes 应追加
    expect(output!.checkpoint.errorsAndFixes.length).toBe(2);
  });

  it('should clear notes.md after writing', async () => {
    fs.writeFileSync(tempNotesPath, 'some notes content', 'utf-8');
    const response = JSON.stringify(minimalCheckpoint);
    const client = createMockClient(response);
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: 'some notes content',
      usagePercent: 0.2,
    });

    expect(output).not.toBeNull();
    expect(fs.readFileSync(tempNotesPath, 'utf-8')).toBe('');
  });

  it('should not clear notes.md when notes is empty', async () => {
    fs.writeFileSync(tempNotesPath, '保留的笔记', 'utf-8');
    const response = JSON.stringify(minimalCheckpoint);
    const client = createMockClient(response);
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(fs.readFileSync(tempNotesPath, 'utf-8')).toBe('保留的笔记');
  });

  it('should readNotes() return empty when file not exists', async () => {
    const client = createMockClient('{}');
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);
    const notes = await writer.readNotes();
    expect(notes).toBe('');
  });

  it('should readNotes() return file content', async () => {
    fs.writeFileSync(tempNotesPath, '笔记内容', 'utf-8');
    const client = createMockClient('{}');
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);
    const notes = await writer.readNotes();
    expect(notes).toBe('笔记内容');
  });

  it('should appendNote() append content', async () => {
    const client = createMockClient('{}');
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);
    await writer.appendNote('第一条');
    await writer.appendNote('第二条');
    const notes = await writer.readNotes();
    expect(notes).toContain('第一条');
    expect(notes).toContain('第二条');
  });

  it('should return null on LLM error', async () => {
    const client: ILLMClient = {
      isReady: () => true,
      complete: vi.fn(async () => { throw new Error('LLM down'); }),
      stream: vi.fn(async function* () { /* not used */ }),
    };
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(output).toBeNull();
  });

  it('should use different system prompts for different levels', async () => {
    const response = JSON.stringify(minimalCheckpoint);
    const client = createMockClient(response);
    const writer = new CheckpointWriter(client, 'mock-model', 500, tempNotesPath);

    const levels: CheckpointLevel[] = ['initial', 'incremental', 'compress'];
    for (const level of levels) {
      await writer.write({
        level,
        recentMessages: sampleMessages,
        previousCheckpoint: null,
        notes: '',
        usagePercent: 0.2,
      });
    }

    const calls = (client.complete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(3);
    const prompts = calls.map(c => (c[0] as LLMRequestOptions).systemPrompt ?? '');
    expect(prompts[0]).toContain('首次 checkpoint');
    expect(prompts[1]).toContain('增量 checkpoint');
    expect(prompts[2]).toContain('晚期 checkpoint');
  });
});
