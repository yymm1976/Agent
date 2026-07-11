// tests/agent/permission-middleware.test.ts
// TD-04：PermissionMiddleware 集成测试
// 验证 PermissionEngine 通过 PermissionMiddleware 接入 Agent Loop onActing 后的端到端行为
//
// 测试矩阵：
//   1. sandbox=read-only 时 file_write 被拒（permissionDenied 被设置）
//   2. sandbox=read-only 时 shell_exec 被拒
//   3. deny 规则（rm -rf /）被拒
//   4. auto 模式下 file_read 放行（无 permissionDenied / requiresConfirmation）
//   5. confirm 规则（shell_exec）→ requiresConfirmation=true
//   6. PermissionEngine 异常时 fail-closed 拒绝
//   7. TrustGradient requiresConfirmation=true 时强制 confirm（TD-06）

import { describe, it, expect, vi } from 'vitest';
import { AgentMiddlewarePipeline, type MiddlewareContext } from '../../src/agent/middleware.js';
import { PermissionMiddleware } from '../../src/agent/middleware/permission-middleware.js';
import {
  PermissionEngine,
  createDefaultEngine,
} from '../../src/tools/permission-engine.js';

/** 构造一个 onActing 中间件上下文 */
function makeOnActingCtx(
  toolName: string,
  toolArgs: Record<string, unknown> = {},
  autonomyMode: 'manual' | 'semi' | 'auto' = 'semi',
): MiddlewareContext {
  return {
    phase: 'onActing',
    toolName,
    toolArgs,
    metadata: { autonomyMode },
  };
}

/** 注册 PermissionMiddleware 到 pipeline 并执行一次 onActing */
async function runPermissionMiddleware(
  engine: PermissionEngine,
  toolName: string,
  args: Record<string, unknown>,
  mode: 'manual' | 'semi' | 'auto' = 'semi',
): Promise<MiddlewareContext> {
  const pipeline = new AgentMiddlewarePipeline();
  const mw = new PermissionMiddleware(engine, mode);
  pipeline.register('onActing', mw.getHandler());
  const ctx = makeOnActingCtx(toolName, args, mode);
  await pipeline.execute('onActing', ctx);
  return ctx;
}

describe('PermissionMiddleware 集成测试', () => {
  describe('沙箱级（read-only）拦截', () => {
    it('sandbox=read-only 时 file_write 被拒', async () => {
      const engine = createDefaultEngine();
      engine.setSandboxLevel('read-only');

      const ctx = await runPermissionMiddleware(
        engine,
        'file_write',
        { path: '/tmp/foo.txt', content: 'x' },
        'semi',
      );

      expect(ctx.metadata.permissionDenied).toBeTruthy();
      expect(typeof ctx.metadata.permissionDenied).toBe('string');
      expect(ctx.metadata.permissionDecision).toBe('deny');
      // 沙箱级拒绝原因应包含工具名和沙箱级
      expect(ctx.metadata.permissionDenied as string).toContain('file_write');
      expect(ctx.metadata.permissionDenied as string).toContain('read-only');
    });

    it('sandbox=read-only 时 shell_exec 被拒', async () => {
      const engine = createDefaultEngine();
      engine.setSandboxLevel('read-only');

      const ctx = await runPermissionMiddleware(
        engine,
        'shell_exec',
        { command: 'ls -la' },
        'semi',
      );

      expect(ctx.metadata.permissionDenied).toBeTruthy();
      expect(ctx.metadata.permissionDecision).toBe('deny');
      expect(ctx.metadata.permissionDenied as string).toContain('shell_exec');
    });

    it('sandbox=read-only 时 file_read 放行（read 类别在允许列表中）', async () => {
      const engine = createDefaultEngine();
      engine.setSandboxLevel('read-only');

      const ctx = await runPermissionMiddleware(
        engine,
        'file_read',
        { path: '/tmp/foo.txt' },
        'semi',
      );

      // file_read 命中 auto-file-read 规则，read 类别在 read-only 允许列表中 → auto 放行
      expect(ctx.metadata.permissionDenied).toBeFalsy();
      expect(ctx.metadata.permissionDecision).toBe('auto');
    });
  });

  describe('deny 规则拦截', () => {
    it('rm -rf / 被 deny 规则拦截', async () => {
      const engine = createDefaultEngine();
      // 不配置沙箱（向后兼容模式），让规则检查主导决策
      // createDefaultEngine 默认设置 full-access，不激活沙箱限制

      const ctx = await runPermissionMiddleware(
        engine,
        'shell_exec',
        { command: 'rm -rf /' },
        'auto', // 即使 auto 模式也必须被 deny
      );

      expect(ctx.metadata.permissionDenied).toBeTruthy();
      expect(ctx.metadata.permissionDecision).toBe('deny');
      expect(ctx.metadata.permissionMatchedRule).toBe('deny-rm-rf-root');
    });

    it('find -delete 被 deny 规则拦截', async () => {
      const engine = createDefaultEngine();

      const ctx = await runPermissionMiddleware(
        engine,
        'shell_exec',
        { command: 'find . -delete' },
        'auto',
      );

      expect(ctx.metadata.permissionDenied).toBeTruthy();
      expect(ctx.metadata.permissionDecision).toBe('deny');
      expect(ctx.metadata.permissionMatchedRule).toBe('deny-find-delete');
    });

    it('写入 /etc/passwd 被 deny 规则拦截', async () => {
      const engine = createDefaultEngine();

      const ctx = await runPermissionMiddleware(
        engine,
        'file_write',
        { path: '/etc/passwd', content: 'malicious' },
        'auto',
      );

      expect(ctx.metadata.permissionDenied).toBeTruthy();
      expect(ctx.metadata.permissionDecision).toBe('deny');
      expect(ctx.metadata.permissionMatchedRule).toBe('deny-system-dirs');
    });
  });

  describe('confirm 规则与 auto 模式放行', () => {
    it('shell_exec 普通命令触发 confirm（requiresConfirmation=true）', async () => {
      const engine = createDefaultEngine();

      const ctx = await runPermissionMiddleware(
        engine,
        'shell_exec',
        { command: 'ls -la' },
        'semi',
      );

      expect(ctx.metadata.permissionDenied).toBeFalsy();
      expect(ctx.metadata.permissionDecision).toBe('confirm');
      expect(ctx.metadata.requiresConfirmation).toBe(true);
      expect(ctx.metadata.permissionMatchedRule).toBe('confirm-shell-exec');
    });

    it('file_read 在 auto 模式下放行（无任何拦截标记）', async () => {
      const engine = createDefaultEngine();

      const ctx = await runPermissionMiddleware(
        engine,
        'file_read',
        { path: '/tmp/foo.txt' },
        'auto',
      );

      expect(ctx.metadata.permissionDenied).toBeFalsy();
      expect(ctx.metadata.requiresConfirmation).toBeFalsy();
      expect(ctx.metadata.permissionDecision).toBe('auto');
      expect(ctx.metadata.permissionMatchedRule).toBe('auto-file-read');
    });

    it('未知工具在 auto 模式下放行（fallback）', async () => {
      const engine = createDefaultEngine();

      const ctx = await runPermissionMiddleware(
        engine,
        'unknown_tool',
        {},
        'auto',
      );

      expect(ctx.metadata.permissionDenied).toBeFalsy();
      expect(ctx.metadata.requiresConfirmation).toBeFalsy();
      expect(ctx.metadata.permissionDecision).toBe('auto');
    });

    it('未知工具在 semi 模式下触发 confirm（fallback）', async () => {
      const engine = createDefaultEngine();

      const ctx = await runPermissionMiddleware(
        engine,
        'unknown_tool',
        {},
        'semi',
      );

      expect(ctx.metadata.permissionDenied).toBeFalsy();
      expect(ctx.metadata.permissionDecision).toBe('confirm');
      expect(ctx.metadata.requiresConfirmation).toBe(true);
    });
  });

  describe('fail-closed 异常处理', () => {
    it('PermissionEngine.check 异常时 fail-closed 拒绝', async () => {
      // 构造一个会抛异常的 PermissionEngine
      const engine = createDefaultEngine();
      // 模拟 check 方法抛异常
      vi.spyOn(engine, 'check').mockImplementation(() => {
        throw new Error('mock check failure');
      });

      const ctx = await runPermissionMiddleware(
        engine,
        'file_read',
        { path: '/tmp/foo.txt' },
        'semi',
      );

      // fail-closed：异常时设置 permissionDenied
      expect(ctx.metadata.permissionDenied).toBeTruthy();
      expect(ctx.metadata.permissionDenied as string).toContain('fail-closed');
      expect(ctx.metadata.permissionDenied as string).toContain('mock check failure');

      vi.restoreAllMocks();
    });
  });

  describe('TrustGradient 接线（Phase 79 Freeze）', () => {
    // Phase 79: TrustGradient Freeze — 旁路 level-based 动态决策，仅保留用户显式临时授权
    //   - checkOperation 的 requiresConfirmation 不再强制升级为 confirm
    //   - checkOperation 的 plan 拦截不再返回 deny
    //   - checkOperation 的 level-based auto 放行不再生效
    //   - 仅 hasTemporaryGrant（用户显式授权）能让操作 auto 放行

    it('Phase 79: TrustGradient requiresConfirmation=true 不再强制 confirm（走规则决策）', async () => {
      // 构造一个 file_read 命中 auto 规则但 trust 要求确认的场景
      const engine = createDefaultEngine();

      // 注入一个 mock TrustGradientManager，checkOperation 要求确认（模拟 level=default）
      const mockTrustManager = {
        checkOperation: () => ({
          allowed: true,
          requiresConfirmation: true,
          reason: 'trust level default requires confirmation',
        }),
        // hasTemporaryGrant 返回 false：无用户显式授权
        hasTemporaryGrant: () => false,
        getLevel: () => 'default',
        setLevel: () => {},
        clearSessionGrants: () => {},
        grantTemporary: () => {},
        classifyRisk: () => 'read',
        cleanupExpiredGrants: () => {},
        getTemporaryGrantsCount: () => 0,
        getPreferences: () => [],
        savePreferences: () => {},
        loadPreferences: () => 0,
        toAutonomyMode: () => 'manual' as const,
      };
      engine.setTrustGradientManager(mockTrustManager as never);

      // file_read 在默认规则集中命中 auto-file-read
      // Phase 79 Freeze：trust requiresConfirmation 被旁路，应走 auto 规则放行（不再强制 confirm）
      const ctx = await runPermissionMiddleware(
        engine,
        'file_read',
        { path: '/tmp/foo.txt' },
        'auto',
      );

      expect(ctx.metadata.permissionDenied).toBeFalsy();
      // Phase 79: 不再被 trust 强制升级为 confirm，走 auto 规则
      expect(ctx.metadata.permissionDecision).toBe('auto');
      expect(ctx.metadata.requiresConfirmation).toBeFalsy();
      expect(ctx.metadata.permissionMatchedRule).toBe('auto-file-read');
    });

    it('Phase 79: 用户显式临时授权（hasTemporaryGrant=true）时放行', async () => {
      const engine = createDefaultEngine();

      // 注入一个 mock TrustGradientManager
      // - checkOperation 要求确认（模拟 level=default，模拟"连续成功不自动提权"）
      // - hasTemporaryGrant 返回 true（模拟用户显式授权）
      const mockTrustManager = {
        checkOperation: () => ({
          allowed: true,
          requiresConfirmation: true,
          reason: 'default 模式需要确认',
        }),
        hasTemporaryGrant: () => true,
        getLevel: () => 'default',
        setLevel: () => {},
        clearSessionGrants: () => {},
        grantTemporary: () => {},
        classifyRisk: () => 'write',
        cleanupExpiredGrants: () => {},
        getTemporaryGrantsCount: () => 1,
        getPreferences: () => [],
        savePreferences: () => {},
        loadPreferences: () => 0,
        toAutonomyMode: () => 'manual' as const,
      };
      engine.setTrustGradientManager(mockTrustManager as never);

      // file_write 无 confirm/auto 规则命中 → fallback
      // Phase 79: hasTemporaryGrant=true → trustAutoAllowed → auto（用户显式授权放行）
      const ctx = await runPermissionMiddleware(
        engine,
        'file_write',
        { path: '/tmp/foo.txt', content: 'x' },
        'semi',
      );

      expect(ctx.metadata.permissionDenied).toBeFalsy();
      expect(ctx.metadata.requiresConfirmation).toBeFalsy();
      expect(ctx.metadata.permissionDecision).toBe('auto');
      expect(ctx.metadata.permissionReason as string).toContain('临时授权');
    });

    it('Phase 79: plan 模式拦截不再 deny（走规则决策）', async () => {
      const engine = createDefaultEngine();

      // 注入一个 mock TrustGradientManager，checkOperation 返回拦截（模拟 plan 模式）
      const mockTrustManager = {
        checkOperation: () => ({
          allowed: false,
          requiresConfirmation: false,
          reason: 'Plan 模式拦截写操作',
        }),
        hasTemporaryGrant: () => false,
        getLevel: () => 'plan',
        setLevel: () => {},
        clearSessionGrants: () => {},
        grantTemporary: () => {},
        classifyRisk: () => 'write',
        cleanupExpiredGrants: () => {},
        getTemporaryGrantsCount: () => 0,
        getPreferences: () => [],
        savePreferences: () => {},
        loadPreferences: () => 0,
        toAutonomyMode: () => 'manual' as const,
      };
      engine.setTrustGradientManager(mockTrustManager as never);

      // file_write 无 deny 规则命中（非系统目录），无 confirm/auto 规则命中 → fallback
      // Phase 79 Freeze：plan 模式的 deny 被旁路，走 semi 模式 fallback → confirm（不再 deny）
      const ctx = await runPermissionMiddleware(
        engine,
        'file_write',
        { path: '/tmp/foo.txt', content: 'x' },
        'semi',
      );

      // Phase 79: 不再被 plan 模式 deny
      expect(ctx.metadata.permissionDenied).toBeFalsy();
      expect(ctx.metadata.permissionDecision).toBe('confirm');
      expect(ctx.metadata.requiresConfirmation).toBe(true);
    });

    it('Phase 79: 连续成功执行不得改变权限决策（无自动提权）', async () => {
      // 验证核心约束：即使模拟"连续成功执行"，trust 的 level-based 决策不影响 check() 结果
      // 场景：file_write 在 default 模式下，模拟多次成功后 level 仍为 default，决策不变
      const engine = createDefaultEngine();

      // 第一次：default 模式，无临时授权
      const mockTrustManager = {
        checkOperation: () => ({
          allowed: true,
          requiresConfirmation: true,
          reason: 'default 模式需要确认',
        }),
        hasTemporaryGrant: () => false,
        getLevel: () => 'default',
        setLevel: () => {},
        clearSessionGrants: () => {},
        grantTemporary: () => {},
        classifyRisk: () => 'write',
        cleanupExpiredGrants: () => {},
        getTemporaryGrantsCount: () => 0,
        getPreferences: () => [],
        savePreferences: () => {},
        loadPreferences: () => 0,
        toAutonomyMode: () => 'manual' as const,
      };
      engine.setTrustGradientManager(mockTrustManager as never);

      const ctx1 = await runPermissionMiddleware(
        engine,
        'file_write',
        { path: '/tmp/foo.txt', content: 'x' },
        'semi',
      );

      // Phase 79: checkOperation requiresConfirmation 被旁路，走 semi fallback → confirm
      expect(ctx1.metadata.permissionDecision).toBe('confirm');
      expect(ctx1.metadata.requiresConfirmation).toBe(true);

      // 模拟"连续成功执行后"：level 仍为 default（无自动提权），决策应不变
      // mockTrustManager.getLevel() 仍返回 'default'，checkOperation 仍返回 requiresConfirmation=true
      const ctx2 = await runPermissionMiddleware(
        engine,
        'file_write',
        { path: '/tmp/foo.txt', content: 'y' },
        'semi',
      );

      // 决策与第一次完全一致——连续成功执行不改变权限决策
      expect(ctx2.metadata.permissionDecision).toBe(ctx1.metadata.permissionDecision);
      expect(ctx2.metadata.requiresConfirmation).toBe(ctx1.metadata.requiresConfirmation);
    });
  });

  describe('与 Loop onActing 流程的兼容性', () => {
    it('非 onActing 阶段调用时透传（不检查权限）', async () => {
      const engine = createDefaultEngine();
      const pipeline = new AgentMiddlewarePipeline();
      const mw = new PermissionMiddleware(engine, 'semi');
      pipeline.register('onReasoning', mw.getHandler());

      const ctx: MiddlewareContext = {
        phase: 'onReasoning',
        metadata: {},
      };
      await pipeline.execute('onReasoning', ctx);

      // 非 onActing 阶段不应设置任何权限标记
      expect(ctx.metadata.permissionDenied).toBeUndefined();
      expect(ctx.metadata.permissionDecision).toBeUndefined();
    });

    it('无 toolName 时透传', async () => {
      const engine = createDefaultEngine();
      const pipeline = new AgentMiddlewarePipeline();
      const mw = new PermissionMiddleware(engine, 'semi');
      pipeline.register('onActing', mw.getHandler());

      // onActing 但无 toolName
      const ctx: MiddlewareContext = {
        phase: 'onActing',
        metadata: {},
      };
      await pipeline.execute('onActing', ctx);

      expect(ctx.metadata.permissionDenied).toBeUndefined();
      expect(ctx.metadata.permissionDecision).toBeUndefined();
    });

    it('注册到 pipeline 后 next() 能继续执行后续中间件', async () => {
      const engine = createDefaultEngine();
      const pipeline = new AgentMiddlewarePipeline();
      const mw = new PermissionMiddleware(engine, 'semi');
      pipeline.register('onActing', mw.getHandler());

      // 注册第二个中间件验证 next() 被调用
      let nextMiddlewareCalled = false;
      pipeline.register('onActing', async (_ctx, next) => {
        nextMiddlewareCalled = true;
        await next();
      });

      const ctx = makeOnActingCtx('file_read', { path: '/tmp/foo.txt' });
      await pipeline.execute('onActing', ctx);

      expect(nextMiddlewareCalled).toBe(true);
      // file_read 应放行
      expect(ctx.metadata.permissionDenied).toBeFalsy();
    });
  });
});
