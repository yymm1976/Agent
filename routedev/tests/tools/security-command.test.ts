// tests/tools/security-command.test.ts
// Phase 29 Task 6：SecurityChecker.checkCommand 改造后的测试
// 覆盖：白名单首 token、黑名单首 token、危险模式标记

import { describe, it, expect, beforeEach } from 'vitest';
import { SecurityChecker } from '../../src/tools/security.js';
import type { SecurityConfig } from '../../src/config/schema.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

function createChecker(overrides: Partial<SecurityConfig> = {}): SecurityChecker {
  const config: SecurityConfig = {
    sensitiveFiles: ['.env', '*.key'],
    sensitiveFilePolicy: 'deny',
    commandBlacklist: ['rm', 'dd'],
    commandWhitelist: [],
    networkConfirm: true,
    ...overrides,
  };
  return new SecurityChecker('/tmp/test', config);
}

const mockContext: ToolExecutionContext = {
  workingDirectory: '/tmp/test',
  allowedDirectories: ['/tmp/test'],
  environment: {},
  timeoutMs: 30000,
};

describe('SecurityChecker.checkCommand（Phase 29 Task 3 改造）', () => {
  describe('黑名单首 token 匹配', () => {
    it('应阻止黑名单中的 rm 命令', () => {
      const checker = createChecker();
      const result = checker.checkCommand('rm -rf /tmp', mockContext);
      expect(result.allowed).toBe(false);
    });

    it('应阻止黑名单中的 dd 命令', () => {
      const checker = createChecker();
      const result = checker.checkCommand('dd if=/dev/zero', mockContext);
      expect(result.allowed).toBe(false);
    });

    it('不应误拦 python program.py（子串含 rm 但首 token 是 python）', () => {
      const checker = createChecker();
      const result = checker.checkCommand('python program.py', mockContext);
      expect(result.allowed).toBe(true);
    });

    it('不应误拦 normalize 命令（子串含 rm 但首 token 是 normalize）', () => {
      const checker = createChecker();
      const result = checker.checkCommand('normalize data.txt', mockContext);
      expect(result.allowed).toBe(true);
    });
  });

  describe('白名单首 token 匹配', () => {
    it('白名单非空时，仅允许白名单内的命令', () => {
      const checker = createChecker({
        commandWhitelist: ['git', 'ls'],
        commandBlacklist: [],
      });
      expect(checker.checkCommand('git status', mockContext).allowed).toBe(true);
      expect(checker.checkCommand('ls -la', mockContext).allowed).toBe(true);
      expect(checker.checkCommand('rm file', mockContext).allowed).toBe(false);
    });
  });

  describe('危险模式标记', () => {
    it('含管道的命令应标记为需确认', () => {
      const checker = createChecker({ commandWhitelist: [] });
      const result = checker.checkCommand('ls | grep test', mockContext);
      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('含命令替换的命令应标记为需确认', () => {
      const checker = createChecker({ commandWhitelist: [] });
      const result = checker.checkCommand('echo $(whoami)', mockContext);
      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('普通命令不需要确认', () => {
      const checker = createChecker({ commandWhitelist: [], commandBlacklist: [] });
      const result = checker.checkCommand('ls -la', mockContext);
      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });
  });
});
