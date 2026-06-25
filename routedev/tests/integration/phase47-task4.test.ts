// tests/integration/phase47-task4.test.ts
// Phase 47 Task 4 集成测试：沙箱级与审批级分离的权限模型
//
// 测试策略：
//   1. read-only 沙箱下 file_write 被 deny，file_read 被 auto
//   2. workspace-write 沙箱下 web_fetch 被 deny（不在允许列表）
//   3. full-access 沙箱下所有类别可用
//   4. 审批覆盖：write: never-ask 后 file_write 不再询问
//   5. headless 模式下 always-ask 工具自动 deny（陷阱 #135）
//   6. 向后兼容：不配置 sandbox 时默认 workspace-write
//   7. 原有 deny 规则仍生效（commandBlacklist / sensitiveFiles）
//   8. 沙箱级判断在审批级之前（陷阱 #136）
//   9. categorize() 方法正确分类工具

import { describe, it, expect } from 'vitest';
import {
  PermissionEngine,
  createDefaultEngine,
  type SandboxLevel,
  type ApprovalLevel,
  type ToolCategory,
} from '../../src/tools/permission-engine.js';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// ============================================================
// 1. read-only 沙箱下 file_write 被 deny，file_read 被 auto
// ============================================================
describe('Phase 47 Task 4 - read-only 沙箱限制', () => {
  it('read-only 沙箱下 file_write 被 deny（write 类别不在允许列表）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('read-only');

    const result = engine.check('file_write', { path: '/tmp/test.txt', content: 'x' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('沙箱级拒绝');
  });

  it('read-only 沙箱下 file_read 被 auto（read 类别在允许列表）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('read-only');

    const result = engine.check('file_read', { path: '/tmp/test.txt' }, 'manual');
    expect(result.decision).toBe('auto');
    expect(result.matchedRuleId).toBe('auto-file-read');
  });
});

// ============================================================
// 2. workspace-write 沙箱下 web_fetch 被 deny
// ============================================================
describe('Phase 47 Task 4 - workspace-write 沙箱限制', () => {
  it('workspace-write 沙箱下 web_fetch 被 deny（network 类别不在允许列表）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('workspace-write');

    const result = engine.check('web_fetch', { url: 'https://example.com' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('沙箱级拒绝');
    expect(result.reason).toContain('network');
  });

  it('workspace-write 沙箱下 file_write 通过沙箱（write 类别在允许列表）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('workspace-write');

    // file_write 无 auto 规则，fallback 到 confirm（semi 模式）
    const result = engine.check('file_write', { path: '/tmp/test.txt', content: 'x' }, 'semi');
    expect(result.decision).not.toBe('deny');
    // write 类别默认审批 on-request，不改变 confirm
    expect(result.decision).toBe('confirm');
  });
});

// ============================================================
// 3. full-access 沙箱下所有类别可用
// ============================================================
describe('Phase 47 Task 4 - full-access 沙箱放行所有类别', () => {
  it('full-access 沙箱下 network 类别工具通过沙箱', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');

    // web_search 有 confirm 规则，但不应被沙箱 deny
    const result = engine.check('web_search', { query: 'test' }, 'semi');
    expect(result.decision).not.toBe('deny');
    // network 默认审批 always-ask，非 headless 下 confirm
    expect(result.decision).toBe('confirm');
  });

  it('full-access 沙箱下 git-write 类别工具通过沙箱', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');

    // git_op 有 confirm 规则，但不应被沙箱 deny
    const result = engine.check('git_op', { operation: 'commit' }, 'semi');
    expect(result.decision).not.toBe('deny');
    // git-write 默认审批 always-ask，非 headless 下 confirm
    expect(result.decision).toBe('confirm');
  });

  it('full-access 沙箱下 shell 类别工具通过沙箱', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');

    const result = engine.check('shell_exec', { command: 'ls -la' }, 'semi');
    expect(result.decision).not.toBe('deny');
    expect(result.decision).toBe('confirm');
  });
});

// ============================================================
// 4. 审批覆盖：write: never-ask 后 file_write 不再询问
// ============================================================
describe('Phase 47 Task 4 - 审批级覆盖', () => {
  it('write: never-ask 后 file_write 从 confirm 升级为 auto', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('workspace-write');
    engine.setApproval('write', 'never-ask');

    // file_write 无规则命中 → fallback confirm（semi 模式）
    // 审批级 never-ask 将 confirm 升级为 auto
    const result = engine.check('file_write', { path: '/tmp/test.txt', content: 'x' }, 'semi');
    expect(result.decision).toBe('auto');
    expect(result.reason).toContain('never-ask');
  });

  it('read: never-ask（默认）下 file_read 保持 auto', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('workspace-write');

    // read 类别默认审批 never-ask，file_read 命中 auto 规则
    const result = engine.check('file_read', { path: '/tmp/test.txt' }, 'manual');
    expect(result.decision).toBe('auto');
  });

  it('shell: never-ask 覆盖后 shell_exec 从 confirm 升级为 auto', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('workspace-write');
    engine.setApproval('shell', 'never-ask');

    // shell_exec 命中 confirm 规则，审批级 never-ask 升级为 auto
    const result = engine.check('shell_exec', { command: 'ls' }, 'semi');
    expect(result.decision).toBe('auto');
  });
});

// ============================================================
// 5. headless 模式下 always-ask 工具自动 deny（陷阱 #135）
// ============================================================
describe('Phase 47 Task 4 - headless 模式陷阱 #135', () => {
  it('headless 模式下 shell_exec（always-ask）自动 deny', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');
    engine.setHeadlessMode(true);

    // shell 类别默认审批 always-ask，headless 下自动 deny
    const result = engine.check('shell_exec', { command: 'ls' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('headless');
  });

  it('headless 模式下 web_search（always-ask）自动 deny', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');
    engine.setHeadlessMode(true);

    const result = engine.check('web_search', { query: 'test' }, 'auto');
    expect(result.decision).toBe('deny');
  });

  it('非 headless 模式下 always-ask 工具正常 confirm', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');
    engine.setHeadlessMode(false);

    const result = engine.check('shell_exec', { command: 'ls' }, 'auto');
    expect(result.decision).toBe('confirm');
  });

  it('headless 模式下 never-ask 工具不受影响', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');
    engine.setHeadlessMode(true);

    // read 类别默认 never-ask，headless 不影响
    const result = engine.check('file_read', { path: '/tmp/test.txt' }, 'manual');
    expect(result.decision).toBe('auto');
  });
});

// ============================================================
// 6. 向后兼容：不配置 sandbox 时默认 workspace-write
// ============================================================
describe('Phase 47 Task 4 - 向后兼容', () => {
  it('new PermissionEngine() 默认沙箱级为 workspace-write', () => {
    const engine = new PermissionEngine();
    expect(engine.getSandboxLevel()).toBe('workspace-write');
  });

  it('AppConfigSchema 默认 security.sandbox 为 workspace-write', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.security.sandbox).toBe('workspace-write');
  });

  it('DEFAULT_CONFIG.security.sandbox 为 workspace-write', () => {
    expect(DEFAULT_CONFIG.security.sandbox).toBe('workspace-write');
  });

  it('createDefaultEngine() 设置沙箱为 full-access（向后兼容）', () => {
    // createDefaultEngine 显式设置 full-access，避免现有行为变更
    const engine = createDefaultEngine();
    expect(engine.getSandboxLevel()).toBe('full-access');
  });

  it('createDefaultEngine() 下 web_search 仍为 confirm（行为不变）', () => {
    const engine = createDefaultEngine();
    const result = engine.check('web_search', { query: 'test' }, 'semi');
    expect(result.decision).toBe('confirm');
  });

  it('createDefaultEngine() 下 git_op 仍为 confirm（行为不变）', () => {
    const engine = createDefaultEngine();
    const result = engine.check('git_op', { operation: 'status' }, 'semi');
    expect(result.decision).toBe('confirm');
  });
});

// ============================================================
// 7. 原有 deny 规则仍生效（commandBlacklist / sensitiveFiles）
// ============================================================
describe('Phase 47 Task 4 - 原有 deny 规则不回归', () => {
  it('rm -rf / 仍被 deny（deny 规则优先于沙箱）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');

    const result = engine.check('shell_exec', { command: 'rm -rf /' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.matchedRuleId).toBe('deny-rm-rf-root');
  });

  it('写入系统目录 /etc 仍被 deny', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');

    const result = engine.check('file_write', { path: '/etc/passwd', content: 'x' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.matchedRuleId).toBe('deny-system-dirs');
  });

  it('find -delete 仍被 deny', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');

    const result = engine.check('shell_exec', { command: 'find . -delete' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.matchedRuleId).toBe('deny-find-delete');
  });

  it('deny 规则在 read-only 沙箱下也优先生效', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('read-only');

    // rm -rf / 既命中 deny 规则，shell 类别也不在 read-only 允许列表
    // 无论哪个先判断，结果都是 deny
    const result = engine.check('shell_exec', { command: 'rm -rf /' }, 'auto');
    expect(result.decision).toBe('deny');
  });
});

// ============================================================
// 8. 沙箱级判断在审批级之前（陷阱 #136）
// ============================================================
describe('Phase 47 Task 4 - 陷阱 #136：沙箱级先于审批级', () => {
  it('沙箱 deny 优先于审批 never-ask（file_write 在 read-only 下）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('read-only');
    // 设置 write 类别审批为 never-ask（如果通过沙箱，会变成 auto）
    engine.setApproval('write', 'never-ask');

    // file_write 属于 write 类别，read-only 沙箱不允许 write
    // 沙箱级应先判断 → deny，而非审批级 never-ask → auto
    const result = engine.check('file_write', { path: '/tmp/test.txt', content: 'x' }, 'semi');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('沙箱级拒绝');
    // 不应出现审批级 never-ask 的提示
    expect(result.reason).not.toContain('never-ask');
  });

  it('沙箱 deny 优先于审批 always-ask headless deny', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('read-only');
    engine.setHeadlessMode(true);

    // shell_exec 属于 shell 类别，read-only 沙箱不允许 shell
    // 即使 headless + always-ask 也会 deny，但原因应是沙箱级拒绝
    const result = engine.check('shell_exec', { command: 'ls' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('沙箱级拒绝');
  });

  it('沙箱通过后审批级才生效（workspace-write 下 file_write）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('workspace-write');
    engine.setApproval('write', 'never-ask');

    // file_write 属于 write 类别，workspace-write 允许 write
    // 通过沙箱后，审批级 never-ask 将 confirm 升级为 auto
    const result = engine.check('file_write', { path: '/tmp/test.txt', content: 'x' }, 'semi');
    expect(result.decision).toBe('auto');
    expect(result.reason).toContain('never-ask');
  });
});

// ============================================================
// 9. categorize() 方法正确分类工具
// ============================================================
describe('Phase 47 Task 4 - categorize() 工具分类', () => {
  const engine = createDefaultEngine();

  it('读取类工具分类为 read', () => {
    expect(engine.categorize('file_read')).toBe('read');
    expect(engine.categorize('file_search')).toBe('read');
    expect(engine.categorize('glob')).toBe('read');
    expect(engine.categorize('code_search')).toBe('read');
    expect(engine.categorize('list_directory')).toBe('read');
    expect(engine.categorize('repo_map')).toBe('read');
  });

  it('写入类工具分类为 write', () => {
    expect(engine.categorize('file_write')).toBe('write');
    expect(engine.categorize('file_edit')).toBe('write');
    expect(engine.categorize('todo_write')).toBe('write');
    expect(engine.categorize('notes')).toBe('write');
  });

  it('shell_exec 分类为 shell', () => {
    expect(engine.categorize('shell_exec')).toBe('shell');
  });

  it('网络工具分类为 network', () => {
    expect(engine.categorize('web_search')).toBe('network');
    expect(engine.categorize('web_fetch')).toBe('network');
  });

  it('git_op 分类为 git-write（保守策略）', () => {
    expect(engine.categorize('git_op')).toBe('git-write');
  });

  it('spawn_agent 分类为 agent', () => {
    expect(engine.categorize('spawn_agent')).toBe('agent');
  });

  it('mcp__ 前缀工具分类为 mcp', () => {
    expect(engine.categorize('mcp__codebase-memory__get_call_graph')).toBe('mcp');
    expect(engine.categorize('mcp__custom__tool')).toBe('mcp');
  });

  it('未知工具默认分类为 write（保守策略）', () => {
    expect(engine.categorize('unknown_tool')).toBe('write');
    expect(engine.categorize('custom_operation')).toBe('write');
  });
});

// ============================================================
// 10. Schema 配置验证
// ============================================================
describe('Phase 47 Task 4 - Schema 配置验证', () => {
  it('security.sandbox 接受合法值', () => {
    for (const level of ['read-only', 'workspace-write', 'full-access'] as SandboxLevel[]) {
      const config = AppConfigSchema.parse({ security: { sandbox: level } }) as AppConfig;
      expect(config.security.sandbox).toBe(level);
    }
  });

  it('security.approval 接受合法的类别-审批级映射', () => {
    const config = AppConfigSchema.parse({
      security: {
        approval: {
          'write': 'never-ask',
          'shell': 'always-ask',
          'network': 'on-request',
        },
      },
    }) as AppConfig;
    expect(config.security.approval).toBeDefined();
    expect(config.security.approval!['write']).toBe('never-ask');
    expect(config.security.approval!['shell']).toBe('always-ask');
    expect(config.security.approval!['network']).toBe('on-request');
  });

  it('security.approval 未配置时为 undefined', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.security.approval).toBeUndefined();
  });

  it('security.sandbox 拒绝非法值', () => {
    expect(() => AppConfigSchema.parse({ security: { sandbox: 'invalid' } })).toThrow();
  });
});
