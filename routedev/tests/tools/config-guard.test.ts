// tests/tools/config-guard.test.ts
// Phase 53 Task 7：ConfigGuard 单元测试

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigGuard } from '../../src/tools/builtin/config-guard.js';

describe('ConfigGuard', () => {
  let guard: ConfigGuard;

  beforeEach(() => {
    guard = new ConfigGuard();
  });

  // ============================================================
  // 规则 1：弱化 security.enabled → deny
  // ============================================================
  describe('规则 1：security.enabled 弱化', () => {
    it('security.enabled: true → false 应被 deny', () => {
      const oldContent = [
        'security:',
        '  enabled: true',
        '  sandbox: workspace-write',
      ].join('\n');
      const newContent = [
        'security:',
        '  enabled: false',
        '  sandbox: workspace-write',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.severity).toBe('deny');
      expect(decision.ruleId).toBe('security.enabled.off');
    });

    it('security.enabled: false → true（加强）应放行', () => {
      const oldContent = [
        'security:',
        '  enabled: false',
      ].join('\n');
      const newContent = [
        'security:',
        '  enabled: true',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(true);
    });

    it('未提供 oldContent 时检测到 enabled: false 应 deny', () => {
      const newContent = [
        'security:',
        '  enabled: false',
      ].join('\n');

      const decision = guard.checkModification('.routedev.yaml', newContent);

      expect(decision.allowed).toBe(false);
      expect(decision.severity).toBe('deny');
      expect(decision.ruleId).toBe('security.enabled.off');
    });
  });

  // ============================================================
  // 规则 2/3：弱化 blacklist → deny
  // ============================================================
  describe('规则 2/3：blacklist 弱化', () => {
    it('security.commandBlacklist 多行条目减少应被 deny', () => {
      const oldContent = [
        'security:',
        '  commandBlacklist:',
        '    - rm',
        '    - curl',
        '    - wget',
      ].join('\n');
      const newContent = [
        'security:',
        '  commandBlacklist:',
        '    - rm',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.severity).toBe('deny');
      expect(decision.ruleId).toBe('security.commandBlacklist.shrunk');
    });

    it('security.toolBlacklist inline 数组减少应被 deny', () => {
      const oldContent = [
        'security:',
        '  toolBlacklist: [shell_exec, web_fetch, file_write]',
      ].join('\n');
      const newContent = [
        'security:',
        '  toolBlacklist: [shell_exec]',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.severity).toBe('deny');
      expect(decision.ruleId).toBe('security.toolBlacklist.shrunk');
    });

    it('blacklist 增加（加强）应放行', () => {
      const oldContent = [
        'security:',
        '  commandBlacklist:',
        '    - rm',
      ].join('\n');
      const newContent = [
        'security:',
        '  commandBlacklist:',
        '    - rm',
        '    - curl',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(true);
    });
  });

  // ============================================================
  // 规则 9：非受保护文件不拦截
  // ============================================================
  describe('非受保护文件', () => {
    it('普通 .ts 文件修改不拦截', () => {
      const decision = guard.checkModification(
        'src/utils/logger.ts',
        'export const foo = 1;',
        'export const foo = 0;',
      );

      expect(decision.allowed).toBe(true);
      expect(decision.severity).toBe('info');
    });

    it('README.md 修改不拦截', () => {
      const decision = guard.checkModification(
        'README.md',
        '# new content',
        '# old content',
      );

      expect(decision.allowed).toBe(true);
    });

    it('非 .routedev/policies.yaml 路径不拦截', () => {
      const decision = guard.checkModification(
        'docs/policies.md',
        'whatever',
      );
      expect(decision.allowed).toBe(true);
    });
  });

  // ============================================================
  // warnOnFirst 行为
  // ============================================================
  describe('warnOnFirst', () => {
    it('warnOnFirst=true 时首次 warn 降级为 info', () => {
      const g = new ConfigGuard({ warnOnFirst: true });
      const oldContent = [
        'security:',
        '  sandbox: workspace-write',
      ].join('\n');
      const newContent = [
        'security:',
        '  sandbox: read-only',
      ].join('\n');

      const decision = g.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      // sandbox 从 workspace-write 改为 read-only → warn，但首次宽限为 info
      expect(decision.severity).toBe('info');
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('security.sandbox.downgrade');
      expect(decision.reason).toContain('首次宽限');
    });

    it('warnOnFirst=true 时第二次 warn 正常返回 warn', () => {
      const g = new ConfigGuard({ warnOnFirst: true });
      const old1 = [
        'security:',
        '  sandbox: workspace-write',
      ].join('\n');
      // 第一次（不同文件路径但同 sandbox 变更，仍触发 warn）
      // 为简化场景：用 policyEngine.enabled 触发 warn，便于连续两次构造
      const oldContent = [
        'policyEngine:',
        '  enabled: true',
      ].join('\n');
      const newContent = [
        'policyEngine:',
        '  enabled: false',
      ].join('\n');

      // 第一次：触发 warn，被宽限为 info
      const first = g.checkModification('.routedev.yaml', newContent, oldContent);
      expect(first.severity).toBe('info');

      // 第二次：使用 sandbox 规则触发新的 warn
      // 由于 firstTriggered 已为 true，不再宽限
      const oldContent2 = [
        'security:',
        '  sandbox: workspace-write',
      ].join('\n');
      const newContent2 = [
        'security:',
        '  sandbox: read-only',
      ].join('\n');
      const second = g.checkModification('.routedev.yaml', newContent2, oldContent2);
      expect(second.severity).toBe('warn');
      expect(second.allowed).toBe(true);

      void old1; // 占位避免未使用警告
    });

    it('warnOnFirst=false（默认）时 warn 直接返回 warn', () => {
      const g = new ConfigGuard(); // 默认 warnOnFirst=false
      const oldContent = [
        'policyEngine:',
        '  enabled: true',
      ].join('\n');
      const newContent = [
        'policyEngine:',
        '  enabled: false',
      ].join('\n');

      const decision = g.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.severity).toBe('warn');
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('policyEngine.enabled.off');
    });
  });

  // ============================================================
  // 其他规则覆盖
  // ============================================================
  describe('其他规则', () => {
    it('security.strictBashMode: true → false 应 deny', () => {
      const oldContent = [
        'security:',
        '  strictBashMode: true',
      ].join('\n');
      const newContent = [
        'security:',
        '  strictBashMode: false',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.severity).toBe('deny');
      expect(decision.ruleId).toBe('security.strictBashMode.off');
    });

    it('security.ssrfProtection: true → false 应 deny', () => {
      const oldContent = [
        'security:',
        '  ssrfProtection: true',
      ].join('\n');
      const newContent = [
        'security:',
        '  ssrfProtection: false',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.severity).toBe('deny');
      expect(decision.ruleId).toBe('security.ssrfProtection.off');
    });

    it('auditChain.enabled: true → false 应 warn', () => {
      const oldContent = [
        'auditChain:',
        '  enabled: true',
      ].join('\n');
      const newContent = [
        'auditChain:',
        '  enabled: false',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      expect(decision.severity).toBe('warn');
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('auditChain.enabled.off');
    });

    it('config.yaml 也受保护', () => {
      const oldContent = [
        'security:',
        '  enabled: true',
      ].join('\n');
      const newContent = [
        'security:',
        '  enabled: false',
      ].join('\n');

      const decision = guard.checkModification(
        'config.yaml',
        newContent,
        oldContent,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.severity).toBe('deny');
    });

    it('用户自定义 pattern 追加后受保护', () => {
      const g = new ConfigGuard({
        protectedPatterns: ['/\\.env$/i'],
      });
      const decision = g.checkModification('.env', 'whatever');
      // .env 不在默认规则中，但匹配用户 pattern，进入规则检测流程
      // 内容无任何弱化字段 → 放行（但 allowed=true 是因为没命中规则）
      expect(decision.allowed).toBe(true);
    });

    it('sandbox 从 read-only 改为 workspace-write（反向）不触发 warn', () => {
      const oldContent = [
        'security:',
        '  sandbox: read-only',
      ].join('\n');
      const newContent = [
        'security:',
        '  sandbox: workspace-write',
      ].join('\n');

      const decision = guard.checkModification(
        '.routedev.yaml',
        newContent,
        oldContent,
      );

      // 反方向（变宽松）不触发 warn
      expect(decision.severity).not.toBe('warn');
      expect(decision.allowed).toBe(true);
    });
  });
});
