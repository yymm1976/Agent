// tests/memory/context-manager.test.ts
// ContextManager 单元测试

import { describe, it, expect, vi } from 'vitest';
import { ContextManager } from '../../src/agent/memory/context-manager.js';
import { CheckpointWriter } from '../../src/agent/memory/checkpoint-writer.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, LLMMessage } from '../../src/router/types.js';
import type { CheckpointData, CheckpointWriterOutput, CheckpointWriterInput } from '../../src/agent/memory/types.js';
import type { CheckpointLevel } from '../../src/agent/memory/types.js';

function createMockWriter(response: CheckpointData = {
  currentIntent: 'mock',
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
}): { writer: CheckpointWriter; client: ILLMClient } {
  const client: ILLMClient = {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => {
      return {
        content: JSON.stringify(response),
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }),
    stream: vi.fn(async function* () { /* not used */ }),
  };
  const writer = new CheckpointWriter(client, 'mock', 500, '/nonexistent.md');
  return { writer, client };
}

function createManager(writer: CheckpointWriter, opts: { enabled?: boolean; window?: number; threshold?: number; keep?: number } = {}) {
  return new ContextManager(
    {
      contextWindow: opts.window ?? 1000,
      compressionThreshold: opts.threshold ?? 0.8,
      keepRecentMessages: opts.keep ?? 2,
      checkpointEnabled: opts.enabled ?? true,
      // 单元测试使用低注入阈值，避免 PPR 分数在小图上达不到生产默认 0.7
      memory: { inference: true, autoLearn: true, injectThreshold: 0 },
    },
    writer,
  );
}

const sampleMessages: LLMMessage[] = Array.from({ length: 10 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `Message ${i} referencing foo.ts and bar.ts`,
}));

describe('ContextManager', () => {
  describe('shouldTriggerCheckpoint', () => {
    it('should return null when below all thresholds', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer);
      const triggers = [{ level: 20, action: 'initial' as CheckpointLevel }, { level: 45, action: 'incremental' as CheckpointLevel }];
      expect(mgr.shouldTriggerCheckpoint(0.1, triggers)).toBeNull();
      expect(mgr.shouldTriggerCheckpoint(0.19, triggers)).toBeNull();
    });

    it('should return "initial" when usage reaches 20%', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer);
      const triggers = [{ level: 20, action: 'initial' as CheckpointLevel }];
      expect(mgr.shouldTriggerCheckpoint(0.2, triggers)).toBe('initial');
      expect(mgr.shouldTriggerCheckpoint(0.3, triggers)).toBe('initial');
    });

    it('should not re-trigger same level', async () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer);
      const triggers = [{ level: 20, action: 'initial' as CheckpointLevel }];

      // 第一次触发
      expect(mgr.shouldTriggerCheckpoint(0.25, triggers)).toBe('initial');
      // 标记为已触发
      mgr['triggeredLevels'].add('initial');
      // 第二次返回 null
      expect(mgr.shouldTriggerCheckpoint(0.3, triggers)).toBeNull();
    });

    it('should return "incremental" after initial triggered', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer);
      mgr['triggeredLevels'].add('initial');
      const triggers = [
        { level: 20, action: 'initial' as CheckpointLevel },
        { level: 45, action: 'incremental' as CheckpointLevel },
      ];
      expect(mgr.shouldTriggerCheckpoint(0.5, triggers)).toBe('incremental');
    });

    it('should return null when checkpointEnabled=false', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer, { enabled: false });
      const triggers = [{ level: 20, action: 'initial' as CheckpointLevel }];
      expect(mgr.shouldTriggerCheckpoint(0.5, triggers)).toBeNull();
    });
  });

  describe('shouldCompress', () => {
    it('should return false when below threshold', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer, { window: 1000, threshold: 0.8 });
      expect(mgr.shouldCompress(10, 700)).toBe(false);
    });

    it('should return true when above threshold', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer, { window: 1000, threshold: 0.8 });
      expect(mgr.shouldCompress(10, 800)).toBe(true);
      expect(mgr.shouldCompress(10, 900)).toBe(true);
    });

    it('should return false when checkpointEnabled=false', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer, { enabled: false, window: 100, threshold: 0.8 });
      expect(mgr.shouldCompress(10, 1000)).toBe(false);
    });
  });

  describe('compress', () => {
    it('should not compress when message count is small', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer, { keep: 5 });
      const messages: LLMMessage[] = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ];
      const { compressed, result } = mgr.compress(messages);
      expect(compressed.length).toBe(2);
      expect(result.summary).toBe('消息数不足，跳过压缩');
    });

    it('should compress old messages to summary', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer, { keep: 2 });
      const messages: LLMMessage[] = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Msg ${i} mentioning config.ts`,
      }));
      const { compressed, result } = mgr.compress(messages);
      expect(result.originalCount).toBe(8);
      // 1 系统摘要 + 2 保留
      expect(compressed.length).toBe(3);
      expect(compressed[0].role).toBe('system');
      expect(result.checkpointSnapshot).toBeNull(); // 没有 checkpoint
    });

    it('should include checkpoint info in summary when available', async () => {
      const cp: CheckpointData = {
        currentIntent: '完成 Phase 11',
        nextAction: '写测试',
        workingConstraints: [],
        taskTree: { description: '', status: 'pending', children: [] },
        currentWorkingFiles: ['App.tsx'],
        involvedFiles: ['App.tsx', 'prompts.ts'],
        crossTaskDiscoveries: ['共享类型定义'],
        errorsAndFixes: [],
        runtimeState: {},
        designDecisions: [],
        miscNotes: [],
      };
      const { writer } = createMockWriter(cp);
      const mgr = createManager(writer, { keep: 2 });
      mgr.setCheckpoint(cp);

      const messages: LLMMessage[] = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Msg ${i}`,
      }));

      const { compressed } = mgr.compress(messages);
      const systemMsg = compressed[0];
      const content = typeof systemMsg.content === 'string' ? systemMsg.content : '';
      expect(content).toContain('完成 Phase 11');
      expect(content).toContain('写测试');
      expect(content).toContain('App.tsx');
    });

    it('should extract file references from old messages when no checkpoint', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer, { keep: 2 });
      const messages: LLMMessage[] = [
        { role: 'user', content: 'look at auth.ts and login.ts' },
        { role: 'assistant', content: 'also check db.ts' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'msg 4' },
        { role: 'user', content: 'msg 5' },
        { role: 'assistant', content: 'msg 6 (recent)' },
      ];
      const { compressed } = mgr.compress(messages);
      const systemMsg = compressed[0];
      const content = typeof systemMsg.content === 'string' ? systemMsg.content : '';
      expect(content).toContain('auth.ts');
      expect(content).toContain('login.ts');
    });
  });

  describe('triggerCheckpoint', () => {
    it('should call writer.write and update state', async () => {
      const { writer, client } = createMockWriter({
        currentIntent: '测试 checkpoint',
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
      });
      const mgr = createManager(writer);
      const messages: LLMMessage[] = [{ role: 'user', content: 'test' }];

      const result = await mgr.triggerCheckpoint('initial', messages, 0.2);
      expect(result).not.toBeNull();
      expect(result!.currentIntent).toBe('测试 checkpoint');
      expect(mgr.getCheckpoint()).not.toBeNull();
      expect(mgr['triggeredLevels'].has('initial')).toBe(true);
      expect((client.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    it('should return null when writer fails', async () => {
      const client: ILLMClient = {
        isReady: () => true,
        complete: vi.fn(async () => {
          return { content: 'invalid', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        }),
        stream: vi.fn(async function* () { /* */ }),
      };
      const writer = new CheckpointWriter(client, 'mock', 500, '/nonexistent.md');
      const mgr = createManager(writer);

      const result = await mgr.triggerCheckpoint('initial', [], 0.2);
      expect(result).toBeNull();
    });
  });

  describe('resetTriggers', () => {
    it('should clear triggered levels and current checkpoint', async () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer);
      await mgr.triggerCheckpoint('initial', [], 0.2);
      expect(mgr.getCheckpoint()).not.toBeNull();

      mgr.resetTriggers();
      expect(mgr.getCheckpoint()).toBeNull();
      expect(mgr['triggeredLevels'].size).toBe(0);
    });
  });

  describe('saveCheckpoint / loadCheckpoint', () => {
    it('should roundtrip checkpoint data', async () => {
      const { writer } = createMockWriter({
        currentIntent: '持久化测试',
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
      });
      const mgr1 = createManager(writer);
      await mgr1.triggerCheckpoint('initial', [], 0.2);
      await mgr1.saveCheckpoint();

      const mgr2 = createManager(writer);
      await mgr2.loadCheckpoint();
      expect(mgr2.getCheckpoint()?.currentIntent).toBe('持久化测试');
    });
  });

  describe('recallMemories（知识图谱集成）', () => {
    it('recallMemories 在 checkpoint 后能返回相关记忆', async () => {
      // 准备一个含丰富信息的 checkpoint 响应
      const cp: CheckpointData = {
        currentIntent: '完成 TypeScript 编译器配置',
        nextAction: '调整 tsconfig.json',
        workingConstraints: ['不能引入新依赖'],
        taskTree: { description: '', status: 'pending', children: [] },
        currentWorkingFiles: ['tsconfig.json'],
        involvedFiles: ['tsconfig.json', 'src/index.ts'],
        crossTaskDiscoveries: ['TypeScript 严格模式有用'],
        errorsAndFixes: [
          { error: '类型推断失败', fix: '显式标注类型', resolved: true },
        ],
        runtimeState: {},
        designDecisions: [
          { decision: '使用 strict 模式', reason: '提高类型安全' },
        ],
        miscNotes: ['注意 tsconfig 路径'],
      };
      const { writer } = createMockWriter(cp);
      const mgr = createManager(writer);

      // 触发 checkpoint，将事实写入图谱
      await mgr.triggerCheckpoint('initial', [], 0.2);

      // 召回相关记忆
      const results = mgr.recallMemories('TypeScript');
      expect(results.length).toBeGreaterThan(0);
      // 至少有一个结果包含 TypeScript
      const contents = results.map(r => r.node.content);
      expect(contents.some(c => c.includes('TypeScript'))).toBe(true);
    });

    it('recallMemories 空 query 返回空数组', async () => {
      const { writer } = createMockWriter({
        currentIntent: '测试',
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
      });
      const mgr = createManager(writer);
      await mgr.triggerCheckpoint('initial', [], 0.2);
      expect(mgr.recallMemories('')).toEqual([]);
    });

    it('recallMemories 在无 checkpoint 时返回空数组', () => {
      const { writer } = createMockWriter();
      const mgr = createManager(writer);
      expect(mgr.recallMemories('anything')).toEqual([]);
    });

    it('getKnowledgeGraph 返回内部图谱实例', async () => {
      const { writer } = createMockWriter({
        currentIntent: '图谱测试',
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
      });
      const mgr = createManager(writer);
      await mgr.triggerCheckpoint('initial', [], 0.2);
      const graph = mgr.getKnowledgeGraph();
      expect(graph).toBeTruthy();
      expect(graph.listNodes().length).toBeGreaterThan(0);
    });

    it('多次 checkpoint 同内容应累加 validatedCount', async () => {
      const cp: CheckpointData = {
        currentIntent: '重复意图',
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
      const { writer } = createMockWriter(cp);
      const mgr = createManager(writer);

      await mgr.triggerCheckpoint('initial', [], 0.2);
      // 重置触发级别以允许再次触发
      mgr['triggeredLevels'].clear();
      await mgr.triggerCheckpoint('incremental', [], 0.5);

      const graph = mgr.getKnowledgeGraph();
      const intentNode = graph.listNodes().find(n => n.content.includes('重复意图'));
      expect(intentNode).toBeTruthy();
      expect(intentNode!.validatedCount).toBeGreaterThanOrEqual(2);
    });
  });
});
