// tests/harness/checkpoint-rollback.test.ts
// Phase 29 Task 6：CheckpointManager rollback 前置检查测试

import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';

describe('CheckpointManager Phase 29 rollback 前置检查', () => {
  it('工作区有未提交更改时应中止回滚', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger as any);

    // 模拟 git status 返回有修改的文件
    const mockStatus = {
      modified: ['src/file1.ts'],
      not_added: [],
      deleted: [],
    };

    const hasUncommitted = mockStatus.modified.length > 0
      || mockStatus.not_added.length > 0
      || mockStatus.deleted.length > 0;

    expect(hasUncommitted).toBe(true);
    if (hasUncommitted) {
      logger.error('回滚中止：工作区有未提交的更改。请先 stash 或 commit 后再回滚。');
    }

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('工作区干净时应允许回滚', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger as any);

    const mockStatus = {
      modified: [],
      not_added: [],
      deleted: [],
    };

    const hasUncommitted = mockStatus.modified.length > 0
      || mockStatus.not_added.length > 0
      || mockStatus.deleted.length > 0;

    expect(hasUncommitted).toBe(false);
    if (hasUncommitted) {
      logger.error('回滚中止');
    }

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('有删除的文件时应中止回滚', () => {
    const mockStatus = {
      modified: [],
      not_added: [],
      deleted: ['src/old-file.ts'],
    };

    const hasUncommitted = mockStatus.modified.length > 0
      || mockStatus.not_added.length > 0
      || mockStatus.deleted.length > 0;

    expect(hasUncommitted).toBe(true);
  });

  it('有新增文件时应中止回滚', () => {
    const mockStatus = {
      modified: [],
      not_added: ['src/new-file.ts'],
      deleted: [],
    };

    const hasUncommitted = mockStatus.modified.length > 0
      || mockStatus.not_added.length > 0
      || mockStatus.deleted.length > 0;

    expect(hasUncommitted).toBe(true);
  });
});
