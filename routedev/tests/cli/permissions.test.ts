// tests/cli/permissions.test.ts
// /permissions 命令测试（Phase 24 Task 5）

import { describe, it, expect } from 'vitest';
import {
  renderPermissionsOutput,
  permissionsCommand,
} from '../../src/cli/commands/permissions.js';
import { createDefaultEngine } from '../../src/tools/permission-engine.js';

describe('/permissions 命令 (Phase 24 Task 5)', () => {
  describe('renderPermissionsOutput', () => {
    it('使用默认引擎渲染完整规则集', () => {
      const engine = createDefaultEngine();
      const output = renderPermissionsOutput(engine, 'semi');

      // 应包含三层标题
      expect(output.some(l => l.includes('DENY 规则'))).toBe(true);
      expect(output.some(l => l.includes('CONFIRM 规则'))).toBe(true);
      expect(output.some(l => l.includes('AUTO 规则'))).toBe(true);

      // 应包含分隔线
      expect(output.some(l => l.includes('─'))).toBe(true);

      // 应包含自主度模式
      expect(output.some(l => l.includes('当前自主模式: semi'))).toBe(true);
    });

    it('不传引擎时使用默认规则集', () => {
      const output = renderPermissionsOutput(undefined, 'auto');

      // 应包含默认 deny 规则
      expect(output.some(l => l.includes('deny-rm-rf-root'))).toBe(true);
      expect(output.some(l => l.includes('deny-system-dirs'))).toBe(true);

      // 应包含默认 confirm 规则
      expect(output.some(l => l.includes('confirm-shell-exec'))).toBe(true);
      expect(output.some(l => l.includes('confirm-git-op'))).toBe(true);

      // 应包含默认 auto 规则
      expect(output.some(l => l.includes('auto-file-read'))).toBe(true);
      expect(output.some(l => l.includes('auto-code-search'))).toBe(true);
    });

    it('每层规则数量正确', () => {
      const engine = createDefaultEngine();
      const output = renderPermissionsOutput(engine);

      // DENY 层应显示 4 条（Phase 29 新增 deny-find-delete 和 deny-dd-device）
      const denyLine = output.find(l => l.includes('DENY 规则'));
      expect(denyLine).toBeDefined();
      expect(denyLine).toContain('共 4 条');

      // CONFIRM 层应显示 3 条
      const confirmLine = output.find(l => l.includes('CONFIRM 规则'));
      expect(confirmLine).toBeDefined();
      expect(confirmLine).toContain('共 3 条');

      // AUTO 层应显示 4 条
      const autoLine = output.find(l => l.includes('AUTO 规则'));
      expect(autoLine).toBeDefined();
      expect(autoLine).toContain('共 4 条');
    });

    it('不传自主度模式时不显示模式行', () => {
      const output = renderPermissionsOutput(undefined);
      expect(output.some(l => l.includes('当前自主模式'))).toBe(false);
    });

    it('规则 ID 和描述都显示', () => {
      const output = renderPermissionsOutput(undefined);
      // 检查 deny 规则的描述
      expect(output.some(l => l.includes('禁止: rm -rf /'))).toBe(true);
      // 检查 confirm 规则的描述
      expect(output.some(l => l.includes('Shell 命令执行需要确认'))).toBe(true);
      // 检查 auto 规则的描述
      expect(output.some(l => l.includes('文件读取安全，自动放行'))).toBe(true);
    });
  });

  describe('permissionsCommand 定义', () => {
    it('命令名和别名正确', () => {
      expect(permissionsCommand.name).toBe('permissions');
      expect(permissionsCommand.aliases).toContain('perms');
    });

    it('命令有描述和用法', () => {
      expect(permissionsCommand.description).toBeTruthy();
      expect(permissionsCommand.usage).toBe('/permissions');
    });

    it('handler 返回 handled 类型', async () => {
      // 模拟 ServiceContext
      const mockCtx = {
        commandBridge: {
          getState: () => ({ autonomyMode: 'semi' }),
        },
      } as any;

      const result = await permissionsCommand.handler('', mockCtx);
      expect(result.type).toBe('handled');
      if (result.type === 'handled') {
        expect(result.messages).toBeDefined();
        expect(result.messages!.length).toBeGreaterThan(0);
      }
    });
  });
});
