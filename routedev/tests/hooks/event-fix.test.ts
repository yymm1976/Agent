// tests/hooks/event-fix.test.ts
// 事件类型修复测试
// 覆盖：on-model-call 合法性、isValidConfig 事件白名单
//
// E11 清理：移除 token-alert.json 测试块（E8 改为 TS 模板注册后该 JSON 文件已不存在）
//         —— 保留 on-model-call 合法性测试（仍在 HookEvent 白名单内）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHookRunner, type HookEvent } from '../../src/agent/hooks.js';
import { HookConfigRegistry } from '../../src/hooks/registry.js';

// ============================================================
// 工具函数
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-event-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// 测试
// ============================================================

describe('事件类型修复：on-model-call', () => {
  // 6. on-model-call 是合法的 HookEvent
  describe('on-model-call 是合法的 HookEvent', () => {
    it('编译期：on-model-call 可赋值给 HookEvent 类型', () => {
 {
        // 若 'on-model-call' 不是合法 HookEvent，tsc 会报错
        const event: HookEvent = 'on-model-call';
        expect(event).toBe('on-model-call');
      }
    });

    it('运行期：HookRunner 可注册 on-model-call 钩子', () => {
      const runner = createHookRunner();
      runner.register({
        event: 'on-model-call',
        handler: async () => ({ action: 'continue' }),
        name: 'token-alert-hook',
      });
      expect(runner.count('on-model-call')).toBe(1);
    });
  });

  // 7. 非法事件名在 isValidConfig 中被拒绝
  describe('isValidConfig 拒绝非法事件名', () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(async () => {
      tmpDir = await makeTempDir();
      configPath = path.join(tmpDir, 'hooks.json');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('非法事件名被拒绝，不加载该配置', async () => {
      const invalidConfig = {
        configs: [
          {
            id: 'bad-event',
            name: '非法事件测试',
            event: 'on-invalid-event',
            enabled: true,
            command: 'echo bad',
            failBehavior: 'warn',
            isTemplate: false,
          },
        ],
      };
      await fs.writeFile(configPath, JSON.stringify(invalidConfig), 'utf-8');

      const registry = new HookConfigRegistry(configPath);
      await registry.load();

      // 非法事件应被过滤掉
      expect(registry.list()).toHaveLength(0);
    });

    it('合法事件名 on-model-call 被接受', async () => {
      const validConfig = {
        configs: [
          {
            id: 'token-alert',
            name: 'Token 警告',
            event: 'on-model-call',
            enabled: true,
            command: 'echo token',
            failBehavior: 'warn',
            isTemplate: true,
          },
        ],
      };
      await fs.writeFile(configPath, JSON.stringify(validConfig), 'utf-8');

      const registry = new HookConfigRegistry(configPath);
      await registry.load();

      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].event).toBe('on-model-call');
    });

    it('其他合法事件名（pre-step 等）被接受', async () => {
      const validConfig = {
        configs: [
          {
            id: 'pre-step-hook',
            name: '步骤前钩子',
            event: 'pre-step',
            enabled: true,
            command: 'echo pre',
            failBehavior: 'warn',
            isTemplate: false,
          },
        ],
      };
      await fs.writeFile(configPath, JSON.stringify(validConfig), 'utf-8');

      const registry = new HookConfigRegistry(configPath);
      await registry.load();

      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].event).toBe('pre-step');
    });
  });

  // E11 清理：原 token-alert.json 事件类型测试块已移除
  // 原因：E8 已将 hook 模板从 JSON 文件迁移到 TS 模板注册（src/hooks/templates.ts）
  //       token-alert.json 文件已不存在；on-model-call 事件合法性已由上述测试覆盖
});
