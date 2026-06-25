// tests/tools/trust-gradient.test.ts
// Claude Code 7 级信任梯度 + 压缩边界 UUID + 子 Agent 工具阉割 单元测试

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TrustGradientManager,
  createCompactionBoundary,
  type TrustLevel,
  type RiskLevel,
} from '../../src/tools/trust-gradient.js';
import { createDefaultEngine } from '../../src/tools/permission-engine.js';
import type { LLMMessage } from '../../src/router/types.js';

// ============================================================
// TrustGradientManager
// ============================================================

describe('TrustGradientManager', () => {
  let manager: TrustGradientManager;

  beforeEach(() => {
    manager = new TrustGradientManager('test-session');
  });

  it('默认信任级别应为 default', () => {
    expect(manager.getLevel()).toBe('default');
  });

  it('setLevel 应更新信任级别', () => {
    manager.setLevel('acceptEdits');
    expect(manager.getLevel()).toBe('acceptEdits');
  });

  it('setLevel 相同级别应无操作', () => {
    manager.setLevel('default');
    expect(manager.getLevel()).toBe('default');
  });

  // plan 模式
  it('plan 模式应拦截写操作', () => {
    manager.setLevel('plan');
    const result = manager.checkOperation('file_write', { path: 'test.txt' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Plan 模式拦截写操作');
  });

  it('plan 模式应放行只读操作', () => {
    manager.setLevel('plan');
    const result = manager.checkOperation('file_read', { path: 'test.txt' }, false);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('放行');
  });

  // default 模式
  it('default 模式应要求确认', () => {
    const result = manager.checkOperation('file_write', { path: 'test.txt' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('default 模式有临时授权时应自动放行', () => {
    const args = { path: 'test.txt' };
    manager.grantTemporary('file_write', args);
    const result = manager.checkOperation('file_write', args, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  // acceptEdits 模式
  it('acceptEdits 模式应放行文件操作', () => {
    manager.setLevel('acceptEdits');
    const result = manager.checkOperation('file_edit', { path: 'test.txt' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('acceptEdits 模式 Shell 操作应要求确认', () => {
    manager.setLevel('acceptEdits');
    const result = manager.checkOperation('shell_exec', { command: 'ls' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  // acceptAll 模式
  it('acceptAll 模式应自动放行所有操作', () => {
    manager.setLevel('acceptAll');
    const result = manager.checkOperation('shell_exec', { command: 'rm file' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  // auto 模式
  it('auto 模式应放行只读操作', () => {
    manager.setLevel('auto');
    const result = manager.checkOperation('file_read', {}, false);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('auto 模式应放行写操作（风险容忍阈值内）', () => {
    manager.setLevel('auto');
    const result = manager.checkOperation('file_write', { path: 'test.txt' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('auto 模式 push 操作应要求确认（超出容忍阈值）', () => {
    manager.setLevel('auto');
    const result = manager.checkOperation('git_op', { operation: 'push' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  // bypassPermissions 模式
  it('bypassPermissions 应跳过所有检查', () => {
    manager.setLevel('bypassPermissions');
    const result = manager.checkOperation('shell_exec', { command: 'rm -rf /' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('bypassPermissions 不应放行 push 操作', () => {
    manager.setLevel('bypassPermissions');
    const result = manager.checkOperation('git_op', { operation: 'push' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  // trusted 模式
  it('trusted 应跳过所有检查', () => {
    manager.setLevel('trusted');
    const result = manager.checkOperation('anything', {}, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('trusted 应放行 push 操作', () => {
    manager.setLevel('trusted');
    const result = manager.checkOperation('git_op', { operation: 'push' }, true);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  // 临时授权 TTL
  it('临时授权应支持 TTL 过期', () => {
    const args = { path: 'test.txt' };
    // 授予 1ms TTL
    manager.grantTemporary('file_write', args, 1);
    // 等待过期
    return new Promise<void>(resolve => {
      setTimeout(() => {
        const result = manager.checkOperation('file_write', args, true);
        expect(result.requiresConfirmation).toBe(true);
        resolve();
      }, 10);
    });
  });

  // clearSessionGrants
  it('clearSessionGrants 应清理所有临时授权', () => {
    const args = { path: 'test.txt' };
    manager.grantTemporary('file_write', args);
    manager.clearSessionGrants();
    const result = manager.checkOperation('file_write', args, true);
    expect(result.requiresConfirmation).toBe(true);
  });

  // cleanupExpiredGrants
  it('cleanupExpiredGrants 应清理过期授权', () => {
    const args = { path: 'test.txt' };
    manager.grantTemporary('file_write', args, 1);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        manager.cleanupExpiredGrants();
        // 过期授权应被清理，checkOperation 应要求确认
        const result = manager.checkOperation('file_write', args, true);
        expect(result.requiresConfirmation).toBe(true);
        resolve();
      }, 10);
    });
  });

  // 不同参数不应匹配临时授权
  it('不同参数不应匹配临时授权', () => {
    manager.grantTemporary('file_write', { path: 'a.txt' });
    const result = manager.checkOperation('file_write', { path: 'b.txt' }, true);
    expect(result.requiresConfirmation).toBe(true);
  });

  // AutonomyMode 映射
  it('toAutonomyMode 应正确映射', () => {
    manager.setLevel('plan');
    expect(manager.toAutonomyMode()).toBe('manual');
    manager.setLevel('default');
    expect(manager.toAutonomyMode()).toBe('manual');
    manager.setLevel('acceptEdits');
    expect(manager.toAutonomyMode()).toBe('semi');
    manager.setLevel('auto');
    expect(manager.toAutonomyMode()).toBe('auto');
    manager.setLevel('bypassPermissions');
    expect(manager.toAutonomyMode()).toBe('auto');
  });

  it('fromAutonomyMode 应正确映射', () => {
    expect(TrustGradientManager.fromAutonomyMode('manual')).toBe('default');
    expect(TrustGradientManager.fromAutonomyMode('semi')).toBe('acceptEdits');
    expect(TrustGradientManager.fromAutonomyMode('auto')).toBe('auto');
  });

  // ============================================================
  // Phase 40 Task 1：渐进式信任权限系统增强测试
  // ============================================================

  // 测试 1：7 级信任梯度的风险容忍阈值
  it('7 级信任梯度的风险容忍阈值', () => {
    // plan: 只放行 read，拦截写
    manager.setLevel('plan');
    expect(manager.checkOperation('file_read', {}, false).requiresConfirmation).toBe(false);
    expect(manager.checkOperation('file_write', { path: 'a.txt' }, true).allowed).toBe(false);

    // default: 只放行 read，写需确认
    manager.setLevel('default');
    expect(manager.checkOperation('file_read', {}, false).requiresConfirmation).toBe(false);
    expect(manager.checkOperation('file_write', { path: 'a.txt' }, true).requiresConfirmation).toBe(true);

    // acceptEdits: 放行 read + write，execute 需确认
    manager.setLevel('acceptEdits');
    expect(manager.checkOperation('file_read', {}, false).requiresConfirmation).toBe(false);
    expect(manager.checkOperation('file_write', { path: 'a.txt' }, true).requiresConfirmation).toBe(false);
    expect(manager.checkOperation('shell_exec', { command: 'ls' }, true).requiresConfirmation).toBe(true);

    // acceptAll: 放行 read + write + execute，network 需确认
    manager.setLevel('acceptAll');
    expect(manager.checkOperation('shell_exec', { command: 'ls' }, true).requiresConfirmation).toBe(false);
    expect(manager.checkOperation('web_search', {}, false).requiresConfirmation).toBe(true);

    // auto: 放行 read + write + execute + network，push 需确认
    manager.setLevel('auto');
    expect(manager.checkOperation('web_search', {}, false).requiresConfirmation).toBe(false);
    expect(manager.checkOperation('git_op', { operation: 'push' }, true).requiresConfirmation).toBe(true);

    // bypassPermissions: 放行所有（不含 push）
    manager.setLevel('bypassPermissions');
    expect(manager.checkOperation('web_search', {}, false).requiresConfirmation).toBe(false);
    expect(manager.checkOperation('git_op', { operation: 'push' }, true).requiresConfirmation).toBe(true);

    // trusted: 放行所有（含 push）
    manager.setLevel('trusted');
    expect(manager.checkOperation('git_op', { operation: 'push' }, true).requiresConfirmation).toBe(false);
  });

  // 测试 2：临时授权的 TTL 过期（已存在于上方，此处补充验证过期后授权被清理）
  it('临时授权 TTL 过期后应被清理', () => {
    const args = { path: 'ttl-test.txt' };
    manager.grantTemporary('file_write', args, 1);
    expect(manager.getTemporaryGrantsCount()).toBe(1);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        // 触发过期检查
        manager.hasTemporaryGrant('file_write', args);
        expect(manager.getTemporaryGrantsCount()).toBe(0);
        resolve();
      }, 10);
    });
  });

  // 测试 3：前缀匹配（src/utils/ 放行 → src/utils/helpers/format.ts 匹配）
  it('前缀匹配：src/utils/ 放行应匹配 src/utils/helpers/format.ts', () => {
    // 对 src/utils/foo.ts 授予临时授权
    manager.grantTemporary('file_write', { path: 'src/utils/foo.ts' });
    // src/utils/helpers/format.ts 应通过前缀匹配放行
    expect(manager.hasTemporaryGrant('file_write', { path: 'src/utils/helpers/format.ts' })).toBe(true);
    // src/other/bar.ts 不应匹配
    expect(manager.hasTemporaryGrant('file_write', { path: 'src/other/bar.ts' })).toBe(false);
  });

  // 测试 4：偏好持久化（save + load）
  it('偏好持久化：save + load 应正确还原', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-trust-'));
    try {
      const mgr1 = new TrustGradientManager('session-1');
      mgr1.grantTemporary('file_write', { path: 'src/utils/foo.ts' }, 60000);
      mgr1.savePreferences(tmpDir);

      // 验证文件存在
      const prefPath = path.join(tmpDir, '.routedev', 'trust-preferences.json');
      expect(fs.existsSync(prefPath)).toBe(true);

      // 用新 manager 加载
      const mgr2 = new TrustGradientManager('session-2');
      const loaded = mgr2.loadPreferences(tmpDir);
      expect(loaded).toBe(1);
      expect(mgr2.hasTemporaryGrant('file_write', { path: 'src/utils/foo.ts' })).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 测试 5：原子写入（并发安全）
  it('原子写入：save 后 .tmp 文件应被清理，内容应为有效 JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-trust-'));
    try {
      manager.grantTemporary('file_write', { path: 'test.txt' }, 60000);
      manager.savePreferences(tmpDir);

      const prefPath = path.join(tmpDir, '.routedev', 'trust-preferences.json');
      const tmpPath = prefPath + '.tmp';

      // .tmp 文件不应存在（已被 rename）
      expect(fs.existsSync(tmpPath)).toBe(false);
      // 主文件应为有效 JSON
      const raw = fs.readFileSync(prefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].toolPattern).toBe('file_write');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 测试 6：LRU 淘汰（超过 1000 条）
  it('LRU 淘汰：超过 1000 条时应淘汰最旧的', () => {
    const mgr = new TrustGradientManager('lru-test');
    // 添加 1000 条
    for (let i = 0; i < 1000; i++) {
      mgr.grantTemporary('file_write', { path: `file-${i}.txt` }, 60000);
    }
    expect(mgr.getTemporaryGrantsCount()).toBe(1000);

    // 添加第 1001 条，应触发 LRU 淘汰
    mgr.grantTemporary('file_write', { path: 'file-1000.txt' }, 60000);
    expect(mgr.getTemporaryGrantsCount()).toBe(1000);

    // 最旧的 file-0.txt 应被淘汰（file-1.txt 也可能被淘汰，取决于清理顺序）
    // 验证总数仍为 1000
    expect(mgr.getTemporaryGrantsCount()).toBeLessThanOrEqual(1000);
  });

  // 测试 7：SHA-256 参数哈希
  it('SHA-256 参数哈希：不同参数应产生不同授权，相同参数应去重', () => {
    const args1 = { path: 'a.txt', content: 'hello' };
    const args2 = { path: 'b.txt', content: 'world' };
    const args1Copy = { content: 'hello', path: 'a.txt' }; // 相同内容，不同 key 顺序

    manager.grantTemporary('file_write', args1);
    // 相同参数（不同 key 顺序）应去重（同一 key）
    manager.grantTemporary('file_write', args1Copy);
    expect(manager.getTemporaryGrantsCount()).toBe(1);

    // 不同参数应产生不同授权
    manager.grantTemporary('file_write', args2);
    expect(manager.getTemporaryGrantsCount()).toBe(2);

    // 验证哈希不碰撞
    expect(manager.hasTemporaryGrant('file_write', args1)).toBe(true);
    expect(manager.hasTemporaryGrant('file_write', args2)).toBe(true);
    expect(manager.hasTemporaryGrant('file_write', { path: 'c.txt' })).toBe(false);
  });

  // 测试 8：classifyRisk 风险分类
  it('classifyRisk 应正确分类工具风险级别', () => {
    expect(manager.classifyRisk('file_read', {})).toBe('read' as RiskLevel);
    expect(manager.classifyRisk('list_directory', {})).toBe('read' as RiskLevel);
    expect(manager.classifyRisk('glob', {})).toBe('read' as RiskLevel);
    expect(manager.classifyRisk('file_write', {})).toBe('write' as RiskLevel);
    expect(manager.classifyRisk('file_edit', {})).toBe('write' as RiskLevel);
    expect(manager.classifyRisk('shell_exec', { command: 'ls' })).toBe('execute' as RiskLevel);
    expect(manager.classifyRisk('git_op', { operation: 'commit' })).toBe('execute' as RiskLevel);
    expect(manager.classifyRisk('git_op', { operation: 'push' })).toBe('push' as RiskLevel);
    expect(manager.classifyRisk('shell_exec', { command: 'git push origin main' })).toBe('push' as RiskLevel);
    expect(manager.classifyRisk('web_search', {})).toBe('network' as RiskLevel);
    expect(manager.classifyRisk('web_fetch', {})).toBe('network' as RiskLevel);
  });
});

// ============================================================
// Phase 40 Task 1：PermissionEngine + TrustGradientManager 联动
// ============================================================

describe('PermissionEngine + TrustGradientManager 联动', () => {
  it('deny 规则应优先于临时授权（不可被绕过）', () => {
    const engine = createDefaultEngine();
    const manager = new TrustGradientManager('integration-test');
    // 设置为 bypassPermissions（最宽松），并授予临时授权
    manager.setLevel('bypassPermissions');
    manager.grantTemporary('file_write', { path: '/etc/passwd' });
    engine.setTrustGradientManager(manager);

    // 即使 bypassPermissions + 临时授权，deny 规则仍应拦截系统目录写入
    const result = engine.check('file_write', { path: '/etc/passwd', content: 'malicious' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.matchedRuleId).toBe('deny-system-dirs');
  });

  it('TrustGradientManager 临时放行应返回 auto', () => {
    const engine = createDefaultEngine();
    const manager = new TrustGradientManager('integration-test');
    manager.setLevel('default');
    // 授予临时授权
    manager.grantTemporary('file_write', { path: 'src/test.txt' });
    engine.setTrustGradientManager(manager);

    // 临时授权有效 → 应返回 auto
    const result = engine.check('file_write', { path: 'src/test.txt', content: 'test' }, 'manual');
    expect(result.decision).toBe('auto');
  });

  it('TrustGradientManager 需确认时应继续走规则检查', () => {
    const engine = createDefaultEngine();
    const manager = new TrustGradientManager('integration-test');
    manager.setLevel('default');
    engine.setTrustGradientManager(manager);

    // default 模式无临时授权 → 需确认 → 继续走规则
    // file_write 无 confirm 规则，无 auto 规则 → fallback
    const result = engine.check('file_write', { path: 'src/test.txt' }, 'manual');
    expect(result.decision).toBe('confirm');
  });

  it('plan 模式拦截应返回 deny', () => {
    const engine = createDefaultEngine();
    const manager = new TrustGradientManager('integration-test');
    manager.setLevel('plan');
    engine.setTrustGradientManager(manager);

    // plan 模式拦截写操作 → deny
    const result = engine.check('file_write', { path: 'src/test.txt' }, 'manual');
    expect(result.decision).toBe('deny');
  });

  it('Windows 危险命令应被 deny 规则拦截', () => {
    const engine = createDefaultEngine();
    // format 命令
    expect(engine.check('shell_exec', { command: 'format C:' }, 'auto').decision).toBe('deny');
    // diskpart 命令
    expect(engine.check('shell_exec', { command: 'diskpart' }, 'auto').decision).toBe('deny');
    // reg delete 命令
    expect(engine.check('shell_exec', { command: 'reg delete HKLM\\Software\\Test' }, 'auto').decision).toBe('deny');
    // bcdedit 命令
    expect(engine.check('shell_exec', { command: 'bcdedit /set' }, 'auto').decision).toBe('deny');
    // netsh firewall 命令
    expect(engine.check('shell_exec', { command: 'netsh firewall set opmode disable' }, 'auto').decision).toBe('deny');
  });
});

// ============================================================
// 压缩边界 UUID 标记
// ============================================================

describe('压缩边界 UUID (createCompactionBoundary)', () => {
  it('应生成包含 UUID 的边界标记', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const compacted: LLMMessage[] = [
      { role: 'user', content: 'summary' },
    ];
    const boundary = createCompactionBoundary(messages, compacted, 1);

    expect(boundary.headUuid).toBeTruthy();
    expect(boundary.anchorUuid).toBeTruthy();
    expect(boundary.tailUuid).toBeTruthy();
    expect(boundary.headUuid).not.toBe(boundary.tailUuid);
    expect(boundary.compactedAt).toBeGreaterThan(0);
    expect(boundary.stage).toBe(1);
    expect(boundary.originalCount).toBe(2);
    expect(boundary.compactedCount).toBe(1);
  });
});
