// tests/cli/command-registry.test.ts

import { describe, it, expect, vi } from 'vitest';
import {
  CommandRegistry,
  createCommandRegistry,
} from '../../src/cli/command-registry.js';
import { clearCommand } from '../../src/cli/commands/clear.js';
import { helpCommand } from '../../src/cli/commands/help.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { promptCommand } from '../../src/cli/commands/prompt.js';
import type { ServiceContext } from '../../src/cli/service-context.js';

function buildMockCtx(partial: Partial<ServiceContext> = {}): ServiceContext {
  return {
    config: { router: { budget: { mode: 'track_only', dailyLimit: 500000 } } } as any,
    clientManager: {
      getReadyClients: vi.fn().mockReturnValue([]),
      listAll: vi.fn().mockReturnValue(new Map()),
    } as any,
    tracker: { getStats: vi.fn().mockReturnValue({ total: { totalTokens: 42 } }) } as any,
    prompts: {
      listBuiltinTemplates: vi.fn().mockReturnValue([
        { id: 'main.system', name: '主系统提示', description: '', variables: [] },
      ]),
      getTemplate: vi.fn().mockResolvedValue({ id: 'main.system', content: 'hi', variables: [] }),
      render: vi.fn().mockResolvedValue('rendered'),
    } as any,
    audit: { log: vi.fn() } as any,
    contextManager: { getCheckpoint: vi.fn().mockReturnValue(null) } as any,
    checkpointManager: { count: 0, isEnabled: false } as any,
    branchManager: { listBranches: vi.fn().mockReturnValue([]), getActiveBranchId: vi.fn().mockReturnValue(null) } as any,
    mcpManager: { connectedCount: 0, totalToolCount: 0 } as any,
    commandBridge: {
      getState: vi.fn().mockReturnValue({
        currentModel: 'test-model',
        currentTier: 'simple',
        isDegraded: false,
        autonomyMode: 'auto',
        conversationHistoryLength: 0,
        mcpConnectedCount: 0,
        mcpTotalToolCount: 0,
      }),
    } as any,
    ...partial,
  } as ServiceContext;
}

describe('CommandRegistry', () => {
  it('registers and parses commands', () => {
    const registry = createCommandRegistry();
    registry.register(clearCommand);
    const parsed = registry.parse('/clear');
    expect(parsed).not.toBeNull();
    expect(parsed?.command.name).toBe('clear');
    expect(parsed?.args).toBe('');
  });

  it('supports aliases', () => {
    const registry = createCommandRegistry();
    registry.register(helpCommand);
    const parsed = registry.parse('/?');
    expect(parsed?.command.name).toBe('help');
  });

  it('returns null for non-command input', () => {
    const registry = createCommandRegistry();
    expect(registry.parse('hello')).toBeNull();
  });

  it('returns passthrough for unknown command', async () => {
    const registry = createCommandRegistry();
    const result = await registry.execute('/unknown', buildMockCtx());
    expect(result.type).toBe('passthrough');
  });

  it('executes clear command', async () => {
    const registry = createCommandRegistry();
    registry.register(clearCommand);
    const result = await registry.execute('/clear', buildMockCtx());
    expect(result.type).toBe('handled');
  });

  it('executes status command', async () => {
    const registry = createCommandRegistry();
    registry.register(statusCommand);
    const result = await registry.execute('/status', buildMockCtx());
    expect(result.type).toBe('handled');
  });

  it('prompt command lists templates', async () => {
    const registry = createCommandRegistry();
    registry.register(promptCommand);
    const result = await registry.execute('/prompt list', buildMockCtx());
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('main.system');
  });
});
