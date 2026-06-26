// tests/skills/skill-flow-checkpoint-store.test.ts
// SkillFlow 任务中断恢复单元测试（Phase 49 Task 1.8）
//
// 测试策略：
//   - 使用 os.tmpdir() 创建临时项目根目录
//   - 构造 FlowExecutionContext 并 save/load 验证往返一致性
//   - 验证 detectInterrupted 检测未完成的 flow
//   - 验证 validateCheckpoint 检测 stale 节点

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillFlowCheckpointStore } from '../../src/skills/skill-flow-checkpoint-store.js';
import type { FlowExecutionContext } from '../../src/skills/skill-flow-types.js';

describe('SkillFlowCheckpointStore（Phase 49 Task 1.8）', () => {
  let tmpDir: string;
  let store: SkillFlowCheckpointStore;

  beforeEach(async () => {
    // 每个测试用独立临时目录
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillflow-test-'));
    store = new SkillFlowCheckpointStore(tmpDir);
  });

  afterEach(async () => {
    // 清理临时目录
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** 构造测试用 FlowExecutionContext */
  function makeCtx(overrides: Partial<FlowExecutionContext> = {}): FlowExecutionContext {
    return {
      currentNodeId: 'step2',
      nodeStates: new Map([
        ['step1', 'passed'],
        ['step2', 'running'],
      ]),
      nodeOutputs: new Map([
        ['step1', '步骤1的输出内容'],
      ]),
      totalIterations: 1,
      loopCounters: new Map(),
      handoffArtifacts: new Map(),
      ...overrides,
    };
  }

  describe('save / load', () => {
    it('save 后 load 应返回等价的 ctx（往返一致）', async () => {
      const ctx = makeCtx();
      const flowId = 'deploy-20260625-001';

      await store.save(flowId, ctx, 'exit');
      const loaded = await store.load(flowId);

      expect(loaded).not.toBeNull();
      expect(loaded!.currentNodeId).toBe('step2');
      expect(loaded!.totalIterations).toBe(1);
      expect(loaded!.nodeStates.get('step1')).toBe('passed');
      expect(loaded!.nodeStates.get('step2')).toBe('running');
      expect(loaded!.nodeOutputs.get('step1')).toBe('步骤1的输出内容');
    });

    it('load 不存在的 flow 返回 null', async () => {
      const loaded = await store.load('nonexistent-flow');

      expect(loaded).toBeNull();
    });

    it('save 后文件应位于 .routedev/skill-flow/<flow-id>.json', async () => {
      const ctx = makeCtx();
      const flowId = 'test-flow';

      await store.save(flowId, ctx, 'exit');

      const expectedPath = path.join(tmpDir, '.routedev', 'skill-flow', 'test-flow.json');
      const stat = await fs.stat(expectedPath);
      expect(stat.isFile()).toBe(true);
    });

    it('completed=true 时保存标记为已完成', async () => {
      const ctx = makeCtx({ currentNodeId: 'exit' });
      const flowId = 'completed-flow';

      await store.save(flowId, ctx, 'exit', true);

      const interrupted = await store.detectInterrupted();
      expect(interrupted).not.toContain(flowId);
    });
  });

  describe('detectInterrupted', () => {
    it('检测未完成的 flow', async () => {
      const ctx1 = makeCtx();
      await store.save('flow-1', ctx1, 'exit', false);
      await store.save('flow-2', ctx1, 'exit', false);

      const interrupted = await store.detectInterrupted();

      expect(interrupted).toContain('flow-1');
      expect(interrupted).toContain('flow-2');
      expect(interrupted).toHaveLength(2);
    });

    it('不返回已完成的 flow', async () => {
      const ctx = makeCtx();
      await store.save('completed-flow', ctx, 'exit', true);
      await store.save('pending-flow', ctx, 'exit', false);

      const interrupted = await store.detectInterrupted();

      expect(interrupted).toContain('pending-flow');
      expect(interrupted).not.toContain('completed-flow');
    });

    it('存储目录不存在时返回空数组', async () => {
      // tmpDir 下没有 .routedev/skill-flow 目录
      const interrupted = await store.detectInterrupted();

      expect(interrupted).toEqual([]);
    });
  });

  describe('validateCheckpoint', () => {
    it('ctx 未被篡改时返回空 stale 集合', async () => {
      const ctx = makeCtx();
      const flowId = 'valid-flow';

      await store.save(flowId, ctx, 'exit');
      const loaded = await store.load(flowId);
      expect(loaded).not.toBeNull();

      const stale = await store.validateCheckpoint(flowId, loaded!);

      expect(stale.size).toBe(0);
    });

    it('ctx.nodeOutputs 被篡改后该节点标记为 stale', async () => {
      const ctx = makeCtx();
      const flowId = 'tampered-flow';

      await store.save(flowId, ctx, 'exit');

      // 加载后篡改 step1 的输出
      const loaded = await store.load(flowId);
      expect(loaded).not.toBeNull();
      loaded!.nodeOutputs.set('step1', '被外部篡改的内容');

      const stale = await store.validateCheckpoint(flowId, loaded!);

      expect(stale.has('step1')).toBe(true);
    });

    it('passed 节点缺少 output 时标记为 stale', async () => {
      const ctx = makeCtx();
      const flowId = 'incomplete-flow';

      await store.save(flowId, ctx, 'exit');

      // 加载后删除 step1 的 output
      const loaded = await store.load(flowId);
      expect(loaded).not.toBeNull();
      loaded!.nodeOutputs.delete('step1');

      const stale = await store.validateCheckpoint(flowId, loaded!);

      expect(stale.has('step1')).toBe(true);
    });

    it('checkpoint 文件不存在时所有 passed 节点标记为 stale', async () => {
      const ctx = makeCtx();

      // 不调用 save，直接 validate
      const stale = await store.validateCheckpoint('nonexistent', ctx);

      // step1 是 passed 状态 → 应被标记为 stale
      expect(stale.has('step1')).toBe(true);
    });
  });

  describe('delete', () => {
    it('删除已保存的 checkpoint 文件', async () => {
      const ctx = makeCtx();
      const flowId = 'to-delete';

      await store.save(flowId, ctx, 'exit');
      await store.delete(flowId);

      const loaded = await store.load(flowId);
      expect(loaded).toBeNull();
    });

    it('删除不存在的文件不报错', async () => {
      // 不应抛异常
      await store.delete('nonexistent');
    });
  });

  describe('路径安全', () => {
    it('flowId 含路径分隔符时只保留文件名部分（防路径遍历）', async () => {
      const ctx = makeCtx();
      // 尝试路径遍历
      const maliciousFlowId = '../../../etc/passwd';

      await store.save(maliciousFlowId, ctx, 'exit');

      // 文件应位于 storeDir 下，basename 为 'passwd'
      const expectedPath = path.join(tmpDir, '.routedev', 'skill-flow', 'passwd.json');
      const stat = await fs.stat(expectedPath);
      expect(stat.isFile()).toBe(true);
    });
  });
});
