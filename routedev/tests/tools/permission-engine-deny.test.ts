// tests/tools/permission-engine-deny.test.ts
// Phase 29 Task 6：PermissionEngine deny 规则测试
// 覆盖：rm -rf 变体、find -delete、dd of=/dev/

import { describe, it, expect } from 'vitest';
import { createDefaultEngine } from '../../src/tools/permission-engine.js';

describe('PermissionEngine deny 规则（Phase 29 Task 3）', () => {
  const engine = createDefaultEngine();

  describe('deny-rm-rf-root', () => {
    it('应阻止 rm -rf /', () => {
      const result = engine.check('shell_exec', { command: 'rm -rf /' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-rm-rf-root');
    });

    it('应阻止 rm -rf "/"（引号绕过）', () => {
      const result = engine.check('shell_exec', { command: 'rm -rf "/"' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-rm-rf-root');
    });

    it("应阻止 rm -rf '/'（单引号绕过）", () => {
      const result = engine.check('shell_exec', { command: "rm -rf '/'" }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-rm-rf-root');
    });

    it('应阻止 RM -rf /（大写绕过）', () => {
      const result = engine.check('shell_exec', { command: 'RM -rf /' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-rm-rf-root');
    });

    it('应阻止 rm -fr /（标志顺序变体）', () => {
      const result = engine.check('shell_exec', { command: 'rm -fr /' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-rm-rf-root');
    });

    it('不应阻止 rm -rf ./tmp（非根目录）', () => {
      const result = engine.check('shell_exec', { command: 'rm -rf ./tmp' }, 'auto');
      expect(result.decision).not.toBe('deny');
    });

    it('不应阻止 ls -la', () => {
      const result = engine.check('shell_exec', { command: 'ls -la' }, 'auto');
      expect(result.decision).not.toBe('deny');
    });
  });

  describe('deny-find-delete', () => {
    it('应阻止 find / -delete', () => {
      const result = engine.check('shell_exec', { command: 'find / -delete' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-find-delete');
    });

    it('应阻止 find . -name "*.log" -delete', () => {
      const result = engine.check('shell_exec', { command: 'find . -name "*.log" -delete' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-find-delete');
    });

    it('不应阻止 find . -name "*.ts"', () => {
      const result = engine.check('shell_exec', { command: 'find . -name "*.ts"' }, 'auto');
      expect(result.decision).not.toBe('deny');
    });
  });

  describe('deny-dd-device', () => {
    it('应阻止 dd of=/dev/sda', () => {
      const result = engine.check('shell_exec', { command: 'dd of=/dev/sda' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-dd-device');
    });

    it('应阻止 dd if=/dev/zero of=/dev/sdb', () => {
      const result = engine.check('shell_exec', { command: 'dd if=/dev/zero of=/dev/sdb' }, 'auto');
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-dd-device');
    });

    it('不应阻止 dd if=img.iso of=disk.img', () => {
      const result = engine.check('shell_exec', { command: 'dd if=img.iso of=disk.img' }, 'auto');
      expect(result.decision).not.toBe('deny');
    });
  });
});
