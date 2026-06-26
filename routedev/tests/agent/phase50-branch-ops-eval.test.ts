// tests/agent/phase50-branch-ops-eval.test.ts
// Phase 50 Task 4：branch-operations.ts 去重评估测试
//
// 评估结论（文档记录）：
//   BranchOperations 与 BranchManager 功能非完全重叠，保留 branch-operations.ts
//
// 功能对比矩阵：
//   | 功能              | BranchManager | BranchOperations | 结论    |
//   |-------------------|---------------|------------------|---------|
//   | fork（创建分支）  | ✅ fork()     | ❌（私有 forkAt） | 重叠    |
//   | append（追加消息）| ✅ append()   | ❌（私有 appendAt）| 重叠    |
//   | editByHistoryIndex| ✅            | ❌               | 重叠    |
//   | delete            | ❌            | ✅ deleteByHistoryIndex | 独特 |
//   | insert            | ❌            | ✅ insertByHistoryIndex | 独特 |
//   | batch edit        | ❌            | ✅ editRange            | 独特 |
//   | undo/redo         | ❌            | ✅ undo()/redo()        | 独特 |
//   | serializeStacks   | ❌            | ✅                      | 独特 |
//   | squash            | ❌            | ❌                      | 都没有 |
//
// 决策：保留 branch-operations.ts，通过 BranchManager.createOperations() 接入

import { describe, it, expect } from 'vitest';
import { BranchManager } from '../../src/agent/branch.js';
import { BranchOperations } from '../../src/agent/branch-operations.js';
import type { LLMMessage } from '../../src/router/types.js';

// ============================================================
// 辅助函数
// ============================================================

/** 创建含 3 条消息的 BranchManager */
function createInitializedManager(): BranchManager {
  const manager = new BranchManager();
  const history: LLMMessage[] = [
    { role: 'user', content: '第一条消息' },
    { role: 'assistant', content: '第二条消息' },
    { role: 'user', content: '第三条消息' },
  ];
  manager.initFromHistory(history);
  return manager;
}

// ============================================================
// 测试
// ============================================================

describe('Phase 50 Task 4：branch-operations 去重评估', () => {
  describe('评估结论：BranchManager 覆盖了重叠功能', () => {
    it('BranchManager 覆盖了 fork/append/edit（与 BranchOperations 重叠的功能）', () => {
      const manager = createInitializedManager();

      // 验证 BranchManager 有 fork（重叠功能）
      expect(typeof manager.fork).toBe('function');

      // 验证 BranchManager 有 append（重叠功能）
      expect(typeof manager.append).toBe('function');

      // 验证 BranchManager 有 editByHistoryIndex（重叠功能）
      expect(typeof manager.editByHistoryIndex).toBe('function');

      // 验证 BranchManager 没有 delete（BranchOperations 独特功能）
      expect((manager as unknown as { deleteByHistoryIndex?: unknown }).deleteByHistoryIndex).toBeUndefined();

      // 验证 BranchManager 没有 undo/redo（BranchOperations 独特功能）
      expect((manager as unknown as { undo?: unknown }).undo).toBeUndefined();
      expect((manager as unknown as { redo?: unknown }).redo).toBeUndefined();

      // 验证 fork 功能正常工作
      const forkId = manager.fork(null, { role: 'user', content: '分叉消息' });
      expect(forkId).toBeTruthy();
      expect(typeof forkId).toBe('string');
    });

    it('BranchOperations 提供独特功能（delete/insert/undo/redo），BranchManager 没有', () => {
      const manager = createInitializedManager();

      // 验证 BranchOperations 有独特功能
      expect(typeof BranchOperations.prototype.deleteByHistoryIndex).toBe('function');
      expect(typeof BranchOperations.prototype.insertByHistoryIndex).toBe('function');
      expect(typeof BranchOperations.prototype.editRange).toBe('function');
      expect(typeof BranchOperations.prototype.undo).toBe('function');
      expect(typeof BranchOperations.prototype.redo).toBe('function');

      // 验证 BranchManager 类没有这些方法
      expect((BranchManager.prototype as unknown as { deleteByHistoryIndex?: unknown }).deleteByHistoryIndex).toBeUndefined();
      expect((BranchManager.prototype as unknown as { insertByHistoryIndex?: unknown }).insertByHistoryIndex).toBeUndefined();
      expect((BranchManager.prototype as unknown as { undo?: unknown }).undo).toBeUndefined();
      expect((BranchManager.prototype as unknown as { redo?: unknown }).redo).toBeUndefined();
    });
  });

  describe('接入点工作：BranchManager.createOperations() 返回可用实例', () => {
    it('createOperations() 返回 BranchOperations 实例，delete + undo 正常工作', () => {
      const manager = createInitializedManager();
      const ops = manager.createOperations();

      // 验证返回的是 BranchOperations 实例
      expect(ops).toBeInstanceOf(BranchOperations);

      // 验证初始状态：undo/redo 栈为空
      expect(ops.canUndo()).toBe(false);
      expect(ops.canRedo()).toBe(false);

      // 执行 delete 操作（BranchOperations 独特功能）
      const deleteResult = ops.deleteByHistoryIndex(1);
      expect(deleteResult.success).toBe(true);

      // delete 后 undo 栈应有 1 条记录
      expect(ops.canUndo()).toBe(true);
      expect(ops.getUndoStack().length).toBe(1);

      // undo 恢复
      const undoResult = ops.undo();
      expect(undoResult.success).toBe(true);
      expect(ops.canUndo()).toBe(false);
      expect(ops.canRedo()).toBe(true);

      // redo 重做
      const redoResult = ops.redo();
      expect(redoResult.success).toBe(true);
      expect(ops.canRedo()).toBe(false);
    });

    it('branch-operations.ts 文件存在且未被删除（评估决策：保留）', () => {
      // 验证 BranchOperations 可正常导入（文件存在）
      expect(BranchOperations).toBeDefined();
      expect(typeof BranchOperations).toBe('function');

      // 验证 BranchManager.createOperations 接入点存在
      const manager = new BranchManager();
      expect(typeof manager.createOperations).toBe('function');
    });
  });
});
