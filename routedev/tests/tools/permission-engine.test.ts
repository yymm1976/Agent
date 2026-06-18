// tests/tools/permission-engine.test.ts
// PermissionEngine 单元测试（Phase 21 Task 1）
// 验证三层权限引擎：deny > confirm > auto

import { describe, it, expect } from 'vitest';
import {
  PermissionEngine,
  DEFAULT_DENY_RULES,
  DEFAULT_CONFIRM_RULES,
  DEFAULT_AUTO_RULES,
  createDefaultEngine,
  type PermissionRule,
} from '../../src/tools/permission-engine.js';

describe('PermissionEngine', () => {
  describe('默认规则集', () => {
    it('deny 规则在 auto 模式下不可绕过', () => {
      // 关键测试：autonomy=auto 也不能绕过 deny
      const engine = createDefaultEngine();
      const result = engine.check(
        'shell_exec',
        { command: 'rm -rf /' },
        'auto', // 即使是 auto 模式
      );
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-rm-rf-root');
    });

    it('deny 系统目录写入不可绕过', () => {
      const engine = createDefaultEngine();
      const result = engine.check(
        'file_write',
        { path: '/etc/passwd', content: 'malicious' },
        'auto',
      );
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-system-dirs');
    });

    it('file_read 自动放行（auto 规则）', () => {
      const engine = createDefaultEngine();
      const result = engine.check('file_read', { path: '/tmp/test.txt' }, 'manual');
      expect(result.decision).toBe('auto');
      expect(result.matchedRuleId).toBe('auto-file-read');
    });

    it('glob 自动放行（auto 规则）', () => {
      const engine = createDefaultEngine();
      const result = engine.check('glob', { pattern: '*.ts' }, 'manual');
      expect(result.decision).toBe('auto');
      expect(result.matchedRuleId).toBe('auto-glob');
    });

    it('shell_exec 触发 confirm（非危险命令）', () => {
      const engine = createDefaultEngine();
      // 普通的 shell 命令（非 rm -rf /）应触发 confirm 而非 deny
      const result = engine.check(
        'shell_exec',
        { command: 'ls -la' },
        'semi',
      );
      expect(result.decision).toBe('confirm');
      expect(result.matchedRuleId).toBe('confirm-shell-exec');
    });
  });

  describe('autonomy mode fallback', () => {
    it('无匹配规则时 manual 模式 → confirm', () => {
      const engine = new PermissionEngine(); // 无规则
      const result = engine.check('unknown_tool', {}, 'manual');
      expect(result.decision).toBe('confirm');
      expect(result.matchedRuleId).toBeUndefined();
    });

    it('无匹配规则时 auto 模式 → auto', () => {
      const engine = new PermissionEngine();
      const result = engine.check('unknown_tool', {}, 'auto');
      expect(result.decision).toBe('auto');
    });

    it('无匹配规则时 semi 模式 → confirm', () => {
      const engine = new PermissionEngine();
      const result = engine.check('unknown_tool', {}, 'semi');
      expect(result.decision).toBe('confirm');
    });
  });

  describe('通配符匹配', () => {
    it('file_* 通配符正确匹配 file_write/file_read 等', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        {
          id: 'auto-file-wildcard',
          layer: 'auto',
          toolPattern: 'file_*',
          description: '所有 file_ 工具自动放行',
        },
      ]);
      expect(engine.check('file_write', {}, 'manual').decision).toBe('auto');
      expect(engine.check('file_read', {}, 'manual').decision).toBe('auto');
      expect(engine.check('file_search', {}, 'manual').decision).toBe('auto');
    });

    it('* 通配符匹配所有工具', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        {
          id: 'confirm-all',
          layer: 'confirm',
          toolPattern: '*',
          description: '所有工具都需确认',
        },
      ]);
      expect(engine.check('anything', {}, 'auto').decision).toBe('confirm');
      expect(engine.check('shell_exec', {}, 'auto').decision).toBe('confirm');
    });

    it('通配符不匹配非前缀工具', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        {
          id: 'auto-file-wildcard',
          layer: 'auto',
          toolPattern: 'file_*',
          description: 'file_ 工具自动放行',
        },
      ]);
      // shell_exec 不匹配 file_*，且无其他规则 → fallback
      expect(engine.check('shell_exec', {}, 'manual').decision).toBe('confirm');
    });
  });

  describe('argsPredicate 参数谓词', () => {
    it('同工具不同参数命中不同层级', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        {
          id: 'deny-dangerous-rm',
          layer: 'deny',
          toolPattern: 'shell_exec',
          argsPredicate: a => String(a.command ?? '').includes('rm -rf /'),
          description: '禁止 rm -rf /',
        },
        {
          id: 'confirm-shell',
          layer: 'confirm',
          toolPattern: 'shell_exec',
          description: 'Shell 需确认',
        },
      ]);

      // 危险命令 → deny
      expect(
        engine.check('shell_exec', { command: 'rm -rf /' }, 'auto').decision,
      ).toBe('deny');
      // 普通命令 → confirm
      expect(
        engine.check('shell_exec', { command: 'ls' }, 'auto').decision,
      ).toBe('confirm');
    });

    it('argsPredicate 返回 false 时不命中该规则', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        {
          id: 'deny-specific-path',
          layer: 'deny',
          toolPattern: 'file_write',
          argsPredicate: a => String(a.path ?? '').startsWith('/etc/'),
          description: '禁止写 /etc/',
        },
      ]);
      // /tmp/ 路径不命中 deny → fallback
      expect(
        engine.check('file_write', { path: '/tmp/test.txt' }, 'auto').decision,
      ).toBe('auto');
      // /etc/ 路径命中 deny
      expect(
        engine.check('file_write', { path: '/etc/passwd' }, 'auto').decision,
      ).toBe('deny');
    });
  });

  describe('规则优先级', () => {
    it('deny + auto 同时命中 → deny 胜出', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        {
          id: 'auto-shell',
          layer: 'auto',
          toolPattern: 'shell_exec',
          description: 'Shell 自动放行',
        },
        {
          id: 'deny-shell-rmrf',
          layer: 'deny',
          toolPattern: 'shell_exec',
          argsPredicate: a => String(a.command ?? '').includes('rm -rf'),
          description: '禁止 rm -rf',
        },
      ]);
      const result = engine.check(
        'shell_exec',
        { command: 'rm -rf /' },
        'auto',
      );
      expect(result.decision).toBe('deny');
      expect(result.matchedRuleId).toBe('deny-shell-rmrf');
    });

    it('confirm + auto 同时命中 → confirm 胜出', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        {
          id: 'auto-shell',
          layer: 'auto',
          toolPattern: 'shell_exec',
          description: 'Shell 自动放行',
        },
        {
          id: 'confirm-shell',
          layer: 'confirm',
          toolPattern: 'shell_exec',
          description: 'Shell 需确认',
        },
      ]);
      const result = engine.check('shell_exec', {}, 'semi');
      expect(result.decision).toBe('confirm');
    });
  });

  describe('默认规则集导出', () => {
    it('DEFAULT_DENY_RULES 包含 rm -rf / 和系统目录', () => {
      expect(DEFAULT_DENY_RULES.length).toBeGreaterThanOrEqual(2);
      const ids = DEFAULT_DENY_RULES.map(r => r.id);
      expect(ids).toContain('deny-rm-rf-root');
      expect(ids).toContain('deny-system-dirs');
      // 所有 deny 规则的 layer 必须是 deny
      expect(DEFAULT_DENY_RULES.every(r => r.layer === 'deny')).toBe(true);
    });

    it('DEFAULT_CONFIRM_RULES 包含 shell_exec / git_op / web_search', () => {
      // Phase 0c 修复：合并了原 PermissionChecker 的规则
      expect(DEFAULT_CONFIRM_RULES.length).toBeGreaterThanOrEqual(3);
      const patterns = DEFAULT_CONFIRM_RULES.map(r => r.toolPattern);
      expect(patterns).toContain('shell_exec');
      expect(patterns).toContain('git_op');
      expect(patterns).toContain('web_search');
    });

    it('DEFAULT_AUTO_RULES 包含 file_read / file_* / glob / code_search', () => {
      // Phase 0c 修复：合并了原 PermissionChecker 的规则
      const patterns = DEFAULT_AUTO_RULES.map(r => r.toolPattern);
      expect(patterns).toContain('file_read');
      expect(patterns).toContain('file_*');
      expect(patterns).toContain('glob');
      expect(patterns).toContain('code_search');
    });
  });

  describe('loadRules / addRule / getRules', () => {
    it('loadRules 替换现有规则', () => {
      const engine = new PermissionEngine();
      engine.loadRules([
        { id: 'r1', layer: 'auto', toolPattern: 'a', description: 'r1' },
      ]);
      expect(engine.getRules().length).toBe(1);
      engine.loadRules([
        { id: 'r2', layer: 'deny', toolPattern: 'b', description: 'r2' },
        { id: 'r3', layer: 'confirm', toolPattern: 'c', description: 'r3' },
      ]);
      expect(engine.getRules().length).toBe(2);
      expect(engine.getRules().map(r => r.id)).toEqual(['r2', 'r3']);
    });

    it('addRule 追加规则', () => {
      const engine = new PermissionEngine();
      engine.addRule({ id: 'r1', layer: 'auto', toolPattern: 'a', description: 'r1' });
      engine.addRule({ id: 'r2', layer: 'deny', toolPattern: 'b', description: 'r2' });
      expect(engine.getRules().length).toBe(2);
    });

    it('getRules 返回副本（修改不影响内部状态）', () => {
      const engine = new PermissionEngine();
      engine.addRule({ id: 'r1', layer: 'auto', toolPattern: 'a', description: 'r1' });
      const rules = engine.getRules();
      rules.push({ id: 'injected', layer: 'deny', toolPattern: '*', description: 'x' });
      expect(engine.getRules().length).toBe(1);
    });
  });

  // ============================================================
  // Phase 0c Task 1：权限统一回归测试
  // 验证原 PermissionChecker 的规则在 PermissionEngine 中生效
  // ============================================================
  describe('Phase 0c: 原 PermissionChecker 规则迁移回归', () => {
    it('file_write 命中 file_* auto 规则 → auto', () => {
      // 原 App.tsx: permissionChecker.addRule({ toolPattern: 'file_*', level: 'auto' })
      const engine = createDefaultEngine();
      const result = engine.check('file_write', { path: '/tmp/test.txt' }, 'manual');
      expect(result.decision).toBe('auto');
    });

    it('file_search 命中 file_* auto 规则 → auto', () => {
      const engine = createDefaultEngine();
      const result = engine.check('file_search', { pattern: '*.ts' }, 'manual');
      expect(result.decision).toBe('auto');
    });

    it('code_search 命中 auto 规则 → auto', () => {
      // 原 App.tsx: permissionChecker.addRule({ toolPattern: 'code_search', level: 'auto' })
      const engine = createDefaultEngine();
      const result = engine.check('code_search', { pattern: 'foo' }, 'manual');
      expect(result.decision).toBe('auto');
    });

    it('shell_exec 命中 confirm 规则 → semi 模式下 confirm', () => {
      // 原 App.tsx: permissionChecker.addRule({ toolPattern: 'shell_exec', level: 'confirm' })
      const engine = createDefaultEngine();
      const result = engine.check('shell_exec', { command: 'ls' }, 'semi');
      expect(result.decision).toBe('confirm');
    });

    it('git_op 命中 confirm 规则 → semi 模式下 confirm', () => {
      // 原 App.tsx: permissionChecker.addRule({ toolPattern: 'git_op', level: 'confirm' })
      const engine = createDefaultEngine();
      const result = engine.check('git_op', { operation: 'status' }, 'semi');
      expect(result.decision).toBe('confirm');
    });

    it('web_search 命中 confirm 规则 → semi 模式下 confirm', () => {
      // 原 App.tsx: permissionChecker.addRule({ toolPattern: 'web_search', level: 'confirm' })
      const engine = createDefaultEngine();
      const result = engine.check('web_search', { query: 'test' }, 'semi');
      expect(result.decision).toBe('confirm');
    });

    it('auto 模式下 confirm 规则仍返回 confirm（PermissionEngine 不自动放行 confirm）', () => {
      // 关键差异：原 PermissionChecker 在 auto 模式下会把 confirm 降级为 auto
      // PermissionEngine 严格遵守三层：confirm 就是 confirm，需用户确认
      // 这是设计选择——更安全的权限模型
      const engine = createDefaultEngine();
      const result = engine.check('shell_exec', { command: 'ls' }, 'auto');
      expect(result.decision).toBe('confirm');
    });
  });
});
