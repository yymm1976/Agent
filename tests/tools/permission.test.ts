// tests/tools/permission.test.ts
// PermissionChecker 单元测试

import { describe, it, expect } from 'vitest';
import { PermissionChecker } from '../../src/tools/permission.js';

describe('PermissionChecker', () => {
  it('should return auto for unknown tools', () => {
    const checker = new PermissionChecker();
    expect(checker.checkPermission('unknown', {})).toBe('auto');
  });

  it('should return auto for file_read', () => {
    const checker = new PermissionChecker();
    checker.addRule({ toolPattern: 'file_*', level: 'auto' });
    expect(checker.checkPermission('file_read', {})).toBe('auto');
  });

  it('should return deny for blacklisted tools', () => {
    const checker = new PermissionChecker();
    checker.addRule({ toolPattern: 'dangerous_*', level: 'deny' });
    expect(checker.checkPermission('dangerous_tool', {})).toBe('deny');
  });

  it('should auto-approve confirm in MVP mode', () => {
    const checker = new PermissionChecker(true);
    checker.addRule({ toolPattern: 'shell_exec', level: 'confirm' });
    expect(checker.checkPermission('shell_exec', {})).toBe('auto');
  });

  it('should return confirm when autoApproveConfirm is false', () => {
    const checker = new PermissionChecker(false);
    checker.addRule({ toolPattern: 'shell_exec', level: 'confirm' });
    expect(checker.checkPermission('shell_exec', {})).toBe('confirm');
  });

  it('should remove rules', () => {
    const checker = new PermissionChecker();
    checker.addRule({ toolPattern: 'shell_exec', level: 'deny' });
    checker.removeRule('shell_exec');
    expect(checker.checkPermission('shell_exec', {})).toBe('auto');
  });

  it('should support glob patterns', () => {
    const checker = new PermissionChecker();
    checker.addRule({ toolPattern: 'file_*', level: 'auto' });
    expect(checker.checkPermission('file_write', {})).toBe('auto');
    expect(checker.checkPermission('file_search', {})).toBe('auto');
  });
});
