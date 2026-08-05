// tests/tools/git-ops.test.ts
// B-03：git_op 读/写操作边界测试
import { describe, expect, it } from 'vitest';
import { isGitWriteOperation, GIT_READ_OPERATIONS, GIT_WRITE_OPERATIONS } from '../../src/tools/git-ops.js';
import { GitOpTool } from '../../src/tools/builtin/git-op.js';

describe('B-03 git 读/写操作边界', () => {
  it('读操作不判定为写', () => {
    for (const op of ['status', 'log', 'diff', 'blame', 'show']) {
      expect(isGitWriteOperation(op), op).toBe(false);
    }
  });

  it('写操作判定为写（计划点名的 commit/push/pull/prune）', () => {
    for (const op of ['add', 'commit', 'push', 'pull', 'prune', 'merge', 'rebase', 'reset', 'checkout']) {
      expect(isGitWriteOperation(op), op).toBe(true);
    }
  });

  it('未知/缺失操作保守按写处理（fail-closed）', () => {
    expect(isGitWriteOperation('unknown-op')).toBe(true);
    expect(isGitWriteOperation(undefined)).toBe(true);
    expect(isGitWriteOperation('')).toBe(true);
  });

  it('git_op 工具 schema 的 enum 只暴露 execute 支持的 9 个操作（审查修复）', () => {
    const schema = new GitOpTool().definition.parameters as { properties: { operation: { enum?: string[] } } };
    const enumOps = schema.properties.operation.enum ?? [];
    expect(enumOps).toEqual(['status', 'log', 'diff', 'add', 'commit', 'push', 'pull', 'blame', 'prune']);
    // 权限集合（git-ops.ts）可比可执行集合更宽（未列操作 fail-closed 按写处理）
    expect(GIT_READ_OPERATIONS.has('show')).toBe(true); // 权限判定用，execute 不支持
  });

  it('git_op 只读操作与写操作集合互斥', () => {
    for (const op of GIT_READ_OPERATIONS) {
      expect(GIT_WRITE_OPERATIONS.has(op)).toBe(false);
    }
  });
});
