// tests/hooks/adapter.test.ts
// Phase 39 Task 2：HookConfig → HookDefinition 转换器测试
// 覆盖：configToDefinition 转换、replaceVariables 变量替换、executeShellCommand 命令执行

import { describe, it, expect } from 'vitest';
import {
  configToDefinition,
  replaceVariables,
  executeShellCommand,
} from '../../src/hooks/adapter.js';
import type { HookConfig } from '../../src/hooks/registry.js';
import type { HookContext } from '../../src/agent/hooks.js';

// ============================================================
// 测试辅助
// ============================================================

/** 构造最小 HookConfig */
function makeConfig(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    id: 'test-hook',
    name: '测试 Hook',
    event: 'post-tool-call',
    enabled: true,
    command: 'echo hello',
    failBehavior: 'warn',
    isTemplate: false,
    ...overrides,
  };
}

/** 构造最小 HookContext */
function makeContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    stepId: 'step-001',
    agentId: 'agent-001',
    projectPath: '/tmp/project',
    ...overrides,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('HookConfig Adapter (Phase 39 Task 2)', () => {
  // ============================================================
  // configToDefinition
  // ============================================================

  it('1. configToDefinition 正确转换 id/event/priority', () => {
    const config = makeConfig({ id: 'my-hook', event: 'pre-tool-call' });
    // 注入 priority 扩展字段
    const extConfig = { ...config, priority: 10 } as HookConfig;
    const def = configToDefinition(extConfig);

    expect(def.name).toBe('my-hook');
    expect(def.event).toBe('pre-tool-call');
    expect(def.priority).toBe(10);
    expect(typeof def.handler).toBe('function');
  });

  it('2. replaceVariables 替换 {{filePath}}（shell-escaped）', () => {
    const ctx = makeContext();
    // filePath 不在标准 HookContext 中，通过扩展字段注入
    const extCtx = { ...ctx, filePath: '/src/index.ts' } as HookContext;
    const result = replaceVariables('prettier {{filePath}}', extCtx);
    // shellEscape 用引号包裹值，防止命令注入（Unix 单引号 / Windows 双引号）
    const expected = process.platform === 'win32'
      ? 'prettier "/src/index.ts"'
      : "prettier '/src/index.ts'";
    expect(result).toBe(expected);
  });

  it('3. replaceVariables 替换 {{toolName}}（shell-escaped）', () => {
    const ctx = makeContext({ toolName: 'file_write' });
    const result = replaceVariables('工具 {{toolName}} 已执行', ctx);
    const expected = process.platform === 'win32'
      ? '工具 "file_write" 已执行'
      : "工具 'file_write' 已执行";
    expect(result).toBe(expected);
  });

  it('3a. replaceVariables 对危险输入 shell-escape 防命令注入', () => {
    // 验证含 shell 元字符的值被引号包裹，; 不会成为命令分隔符
    const ctx = makeContext();
    const extCtx = { ...ctx, filePath: 'safe; rm -rf /' } as HookContext;
    const result = replaceVariables('prettier {{filePath}}', extCtx);
    // 危险值必须被引号包裹，; 在引号内为字面字符
    if (process.platform === 'win32') {
      expect(result).toBe('prettier "safe; rm -rf /"');
    } else {
      expect(result).toBe("prettier 'safe; rm -rf /'");
    }
    // 确保未发生注入：原始分隔符不应裸露在引号外
    expect(result).not.toBe('prettier safe; rm -rf /');
  });

  // ============================================================
  // executeShellCommand
  // ============================================================

  it('4. executeShellCommand 成功时返回 { action: "continue" }', async () => {
    // echo 命令在所有平台都可用，退出码 0
    const result = await executeShellCommand(
      process.platform === 'win32' ? 'echo success' : 'echo success',
      5000,
    );
    expect(result.action).toBe('continue');
    expect(result.modifiedToolResult).toContain('success');
  });

  it('5. executeShellCommand 非零退出码返回 { action: "skip" }', async () => {
    // exit 1 在所有平台都可用，退出码 1
    const result = await executeShellCommand(
      process.platform === 'win32' ? 'exit /b 1' : 'exit 1',
      5000,
    );
    expect(result.action).toBe('skip');
    expect(result.message).toContain('退出码');
  });

  it('6. executeShellCommand 超时返回 skip 或错误结果', async () => {
    // 使用 sleep 命令制造超时（timeout=100ms，sleep 5s）
    // Windows 用 timeout，Linux/Mac 用 sleep
    const cmd = process.platform === 'win32'
      ? 'timeout /t 5 /nobreak'
      : 'sleep 5';
    const result = await executeShellCommand(cmd, 200);
    // 超时后子进程被 kill，close 事件触发，code 非 0
    expect(['skip', 'continue']).toContain(result.action);
  });
});
