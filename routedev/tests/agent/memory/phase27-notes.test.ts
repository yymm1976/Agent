// tests/agent/memory/phase27-notes.test.ts
// Phase-27 Task 9 测试：notes.md 模块
// 验证 NotesManager、NotesTool、CheckpointWriter 集成

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NotesManager } from '../../../src/agent/memory/notes.js';
import { NotesTool } from '../../../src/tools/builtin/notes-tool.js';
import { CheckpointWriter } from '../../../src/agent/memory/checkpoint-writer.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, LLMMessage } from '../../../src/router/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'routedev-notes-test-'));
});

afterEach(async () => {
  await fsPromises.rm(tempDir, { recursive: true, force: true });
});

// ============================================================
// NotesManager 单元测试
// ============================================================
describe('Phase-27 Task 9: NotesManager', () => {
  describe('append / readAll / clear / size', () => {
    it('append 追加内容到 notes.md', async () => {
      const manager = new NotesManager(tempDir);
      await manager.append('第一条笔记');
      await manager.append('第二条笔记');

      const content = await manager.readAll();
      expect(content).toContain('第一条笔记');
      expect(content).toContain('第二条笔记');
    });

    it('readAll 文件不存在时返回空字符串', async () => {
      const manager = new NotesManager(tempDir);
      const content = await manager.readAll();
      expect(content).toBe('');
    });

    it('clear 清空 notes.md', async () => {
      const manager = new NotesManager(tempDir);
      await manager.append('一些内容');
      expect(await manager.size()).toBeGreaterThan(0);

      await manager.clear();
      expect(await manager.readAll()).toBe('');
      expect(await manager.size()).toBe(0);
    });

    it('size 返回文件字节数', async () => {
      const manager = new NotesManager(tempDir);
      await manager.append('hello');
      const size = await manager.size();
      // 'hello\n' = 6 字节
      expect(size).toBe(6);
    });

    it('size 文件不存在时返回 0', async () => {
      const manager = new NotesManager(tempDir);
      const size = await manager.size();
      expect(size).toBe(0);
    });

    it('getPath 返回 notes.md 路径', () => {
      const manager = new NotesManager(tempDir);
      const notesPath = manager.getPath();
      expect(notesPath).toBe(path.join(tempDir, 'notes.md'));
    });

    it('append 自动创建不存在的目录', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'session');
      const manager = new NotesManager(nestedDir);
      await manager.append('内容');
      expect(await manager.readAll()).toContain('内容');
    });
  });
});

// ============================================================
// NotesTool 单元测试
// ============================================================
describe('Phase-27 Task 9: NotesTool', () => {
  function makeContext() {
    return {
      workingDirectory: tempDir,
      allowedDirectories: [tempDir],
      environment: {},
      timeoutMs: 5000,
    };
  }

  it('execute 追加笔记并返回成功', async () => {
    const manager = new NotesManager(tempDir);
    const tool = new NotesTool(manager);

    const result = await tool.execute(
      { content: '发现一个 bug', category: 'discovery' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('笔记已追加');
    expect(result.output).toContain('discovery');

    const content = await manager.readAll();
    expect(content).toContain('发现一个 bug');
    expect(content).toContain('[discovery]');
  });

  it('execute 不指定 category 时默认 misc', async () => {
    const manager = new NotesManager(tempDir);
    const tool = new NotesTool(manager);

    const result = await tool.execute({ content: '普通笔记' }, makeContext());

    expect(result.success).toBe(true);
    const content = await manager.readAll();
    expect(content).toContain('[misc]');
    expect(content).toContain('普通笔记');
  });

  it('validateArgs 检测缺失的 content 参数', () => {
    const manager = new NotesManager(tempDir);
    const tool = new NotesTool(manager);

    const validation = tool.validateArgs({});
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('缺少必需参数: content');
  });

  it('validateArgs 检测非字符串 content', () => {
    const manager = new NotesManager(tempDir);
    const tool = new NotesTool(manager);

    const validation = tool.validateArgs({ content: 123 });
    expect(validation.valid).toBe(false);
  });

  it('validateArgs 合法参数返回 valid', () => {
    const manager = new NotesManager(tempDir);
    const tool = new NotesTool(manager);

    const validation = tool.validateArgs({ content: '合法内容', category: 'todo' });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('definition 包含正确的工具名和分类', () => {
    const manager = new NotesManager(tempDir);
    const tool = new NotesTool(manager);

    expect(tool.definition.name).toBe('notes');
    expect(tool.definition.category).toBe('system');
    expect(tool.definition.requiresApproval).toBe(false);
  });
});

// ============================================================
// CheckpointWriter + NotesManager 集成测试
// ============================================================
describe('Phase-27 Task 9: CheckpointWriter + NotesManager 集成', () => {
  function createMockClient(response: string): ILLMClient {
    return {
      isReady: () => true,
      complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => ({
        content: response,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      })),
      stream: vi.fn(async function* () { /* not used */ }),
    };
  }

  const sampleMessages: LLMMessage[] = [
    { role: 'user', content: '我要写测试' },
  ];

  const minimalCheckpointJson = JSON.stringify({
    currentIntent: '完成测试',
    nextAction: '编写测试',
    workingConstraints: [],
    taskTree: { description: '完成测试', status: 'in_progress', children: [] },
    currentWorkingFiles: [],
    involvedFiles: [],
    crossTaskDiscoveries: [],
    errorsAndFixes: [],
    runtimeState: {},
    designDecisions: [],
    miscNotes: [],
  });

  it('设置 NotesManager 后 write 从 NotesManager 读取 notes', async () => {
    const notesManager = new NotesManager(tempDir);
    await notesManager.append('[discovery] 发现 foo.ts 有 bug');

    const client = createMockClient(minimalCheckpointJson);
    const writer = new CheckpointWriter(client, 'mock-model', 500);
    writer.setNotesManager(notesManager);

    // input.notes 为空，应从 NotesManager 读取
    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(output).not.toBeNull();
    // notes 应被清空
    expect(await notesManager.readAll()).toBe('');
  });

  it('checkpoint() 方法与 write() 等价', async () => {
    const notesManager = new NotesManager(tempDir);
    await notesManager.append('一些笔记');

    const client = createMockClient(minimalCheckpointJson);
    const writer = new CheckpointWriter(client, 'mock-model', 500);
    writer.setNotesManager(notesManager);

    const output = await writer.checkpoint({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '',
      usagePercent: 0.2,
    });

    expect(output).not.toBeNull();
    expect(await notesManager.readAll()).toBe('');
  });

  it('未设置 NotesManager 时保持原有行为', async () => {
    const notesPath = path.join(tempDir, 'legacy-notes.md');
    fs.writeFileSync(notesPath, '旧笔记', 'utf-8');

    const client = createMockClient(minimalCheckpointJson);
    const writer = new CheckpointWriter(client, 'mock-model', 500, notesPath);

    const output = await writer.write({
      level: 'initial',
      recentMessages: sampleMessages,
      previousCheckpoint: null,
      notes: '旧笔记',
      usagePercent: 0.2,
    });

    expect(output).not.toBeNull();
    // 旧文件应被清空
    expect(fs.readFileSync(notesPath, 'utf-8')).toBe('');
  });

  it('readNotes 通过 NotesManager 读取', async () => {
    const notesManager = new NotesManager(tempDir);
    await notesManager.append('通过 NotesManager 写入');

    const client = createMockClient('{}');
    const writer = new CheckpointWriter(client, 'mock-model', 500);
    writer.setNotesManager(notesManager);

    const notes = await writer.readNotes();
    expect(notes).toContain('通过 NotesManager 写入');
  });

  it('appendNote 通过 NotesManager 追加', async () => {
    const notesManager = new NotesManager(tempDir);
    const client = createMockClient('{}');
    const writer = new CheckpointWriter(client, 'mock-model', 500);
    writer.setNotesManager(notesManager);

    await writer.appendNote('通过 writer 追加');
    const content = await notesManager.readAll();
    expect(content).toContain('通过 writer 追加');
  });
});
