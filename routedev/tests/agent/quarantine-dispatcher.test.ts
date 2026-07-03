import { describe, it, expect, vi } from 'vitest';
import { QuarantineManager, QUARANTINE_DEFAULT_DENIED_TOOLS } from '../../src/tools/quarantine-profile.js';
import { ActionAgentDispatcher } from '../../src/agent/action-agent-dispatcher.js';
import type { DispatchIntent } from '../../src/agent/action-agent-dispatcher.js';

const TRUSTED_ID = 'trusted-agent';
const UNTRUSTED_ID = 'untrusted-agent';

function makeDispatcher(
  mgr: QuarantineManager,
  executor = vi.fn().mockResolvedValue('ok'),
) {
  return new ActionAgentDispatcher(mgr, {
    trustedAgentId: TRUSTED_ID,
    untrustedAgentId: UNTRUSTED_ID,
    intentForwardingEnabled: true,
  }, executor);
}

function makeIntent(override: Partial<DispatchIntent> = {}): DispatchIntent {
  return {
    intentId: 'intent-1',
    description: 'write file',
    requiredTools: ['file_write'],
    originAgentId: UNTRUSTED_ID,
    ...override,
  };
}

describe('QuarantineManager', () => {
  it('untrusted agent 默认拒绝受限工具', () => {
    const mgr = new QuarantineManager();
    mgr.registerUntrusted(UNTRUSTED_ID);
    expect(mgr.isToolAllowed(UNTRUSTED_ID, 'file_write')).toBe(false);
    expect(mgr.isToolAllowed(UNTRUSTED_ID, 'shell_exec')).toBe(false);
    expect(mgr.isToolAllowed(UNTRUSTED_ID, 'git_op')).toBe(false);
  });

  it('trusted agent 允许所有工具', () => {
    const mgr = new QuarantineManager();
    mgr.registerTrusted(TRUSTED_ID);
    expect(mgr.isToolAllowed(TRUSTED_ID, 'file_write')).toBe(true);
    expect(mgr.isToolAllowed(TRUSTED_ID, 'shell_exec')).toBe(true);
  });

  it('未注册的 agent 默认允许（fail-open）', () => {
    const mgr = new QuarantineManager();
    expect(mgr.isToolAllowed('unknown-agent', 'file_write')).toBe(true);
  });

  it('propagateContamination: 受信任的下游被污染后变为不受信任', () => {
    const mgr = new QuarantineManager();
    mgr.registerUntrusted(UNTRUSTED_ID);
    mgr.registerTrusted(TRUSTED_ID);
    mgr.propagateContamination(UNTRUSTED_ID, TRUSTED_ID, 'cross-contamination');
    expect(mgr.get(TRUSTED_ID)?.trusted).toBe(false);
  });

  it('污染传播被记录到 contaminationLog', () => {
    const mgr = new QuarantineManager();
    mgr.registerUntrusted(UNTRUSTED_ID);
    mgr.registerTrusted('target-agent');
    mgr.propagateContamination(UNTRUSTED_ID, 'target-agent', 'reason');
    const log = mgr.getContaminationLog();
    expect(log).toHaveLength(1);
    expect(log[0].sourceAgentId).toBe(UNTRUSTED_ID);
    expect(log[0].targetAgentId).toBe('target-agent');
  });

  it('contaminationTrace 深度不超过 maxTraceDepth', () => {
    const mgr = new QuarantineManager(QUARANTINE_DEFAULT_DENIED_TOOLS, 3);
    const victim = 'victim-agent';
    mgr.registerUntrusted('src-1');
    mgr.registerUntrusted('src-2');
    mgr.registerUntrusted('src-3');
    mgr.registerUntrusted('src-4');
    mgr.registerTrusted(victim);
    mgr.propagateContamination('src-1', victim, 'r1');
    mgr.propagateContamination('src-2', victim, 'r2');
    mgr.propagateContamination('src-3', victim, 'r3');
    mgr.propagateContamination('src-4', victim, 'r4');
    const trace = mgr.get(victim)?.contaminationTrace ?? [];
    expect(trace.length).toBeLessThanOrEqual(3);
  });
});

describe('ActionAgentDispatcher', () => {
  it('untrusted agent 使用受限工具时，意图被转发给 trusted agent', async () => {
    const mgr = new QuarantineManager();
    mgr.registerUntrusted(UNTRUSTED_ID);
    mgr.registerTrusted(TRUSTED_ID);
    const executor = vi.fn().mockResolvedValue('executed by trusted');
    const dispatcher = makeDispatcher(mgr, executor);
    const result = await dispatcher.dispatch(makeIntent());
    expect(result.executedBy).toBe('forwarded');
    expect(result.success).toBe(true);
    expect(result.deniedTools).toContain('file_write');
    expect(executor).toHaveBeenCalledOnce();
  });

  it('trusted agent 直接执行，无限制', async () => {
    const mgr = new QuarantineManager();
    mgr.registerTrusted(TRUSTED_ID);
    const executor = vi.fn().mockResolvedValue('direct exec');
    const dispatcher = makeDispatcher(mgr, executor);
    const result = await dispatcher.dispatch(makeIntent({ originAgentId: TRUSTED_ID }));
    expect(result.executedBy).toBe('trusted');
    expect(result.success).toBe(true);
    expect(result.deniedTools).toHaveLength(0);
  });

  it('intentForwarding 禁用时返回失败，不执行', async () => {
    const mgr = new QuarantineManager();
    mgr.registerUntrusted(UNTRUSTED_ID);
    mgr.registerTrusted(TRUSTED_ID);
    const executor = vi.fn().mockResolvedValue('should not run');
    const dispatcher = new ActionAgentDispatcher(mgr, {
      trustedAgentId: TRUSTED_ID,
      untrustedAgentId: UNTRUSTED_ID,
      intentForwardingEnabled: false,
    }, executor);
    const result = await dispatcher.dispatch(makeIntent());
    expect(result.success).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it('trusted executor 抛出异常时，返回失败', async () => {
    const mgr = new QuarantineManager();
    mgr.registerUntrusted(UNTRUSTED_ID);
    mgr.registerTrusted(TRUSTED_ID);
    const executor = vi.fn().mockRejectedValue(new Error('exec error'));
    const dispatcher = makeDispatcher(mgr, executor);
    const result = await dispatcher.dispatch(makeIntent());
    expect(result.success).toBe(false);
    expect(result.output).toContain('exec error');
  });
});
