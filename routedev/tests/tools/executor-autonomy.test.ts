import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../src/tools/executor.js';
import type { ISecurityChecker, ITool, IToolRegistry, ToolExecutionContext } from '../../src/tools/types.js';

function createContext(autonomyMode: ToolExecutionContext['autonomyMode']): ToolExecutionContext {
  return {
    workingDirectory: '/tmp/project',
    allowedDirectories: ['/tmp/project'],
    environment: {},
    timeoutMs: 30000,
    autonomyMode,
    requestConfirmation: vi.fn().mockResolvedValue(false),
  };
}

function createExecutor(securityResult: { allowed: boolean; requiresConfirmation?: boolean; reason?: string }) {
  const execute = vi.fn().mockResolvedValue({ success: true, output: 'ok', durationMs: 0 });
  const tool = {
    definition: {
      name: 'shell_exec',
      description: 'test shell',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      category: 'shell',
    },
    validateArgs: () => ({ valid: true, errors: [] }),
    execute,
  } as unknown as ITool;
  const registry = { get: vi.fn().mockReturnValue(tool) } as unknown as IToolRegistry;
  const executor = new ToolExecutor(registry);
  executor.setSecurityChecker({ checkCommand: vi.fn().mockReturnValue(securityResult) } as unknown as ISecurityChecker);
  return { executor, execute };
}

describe('ToolExecutor autonomy confirmation', () => {
  it('runs an allowed piped command in auto mode without a second confirmation', async () => {
    const { executor, execute } = createExecutor({
      allowed: true,
      requiresConfirmation: true,
      reason: '命令含管道或命令替换，需确认',
    });
    const context = createContext('auto');

    const result = await executor.execute('shell_exec', { command: 'git status | Select-Object -First 5' }, context);

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(context.requestConfirmation).not.toHaveBeenCalled();
  });

  it('still rejects a command that the security checker hard-denies', async () => {
    const { executor, execute } = createExecutor({ allowed: false, reason: '危险命令' });
    const context = createContext('auto');

    const result = await executor.execute('shell_exec', { command: 'rm -rf /' }, context);

    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(context.requestConfirmation).not.toHaveBeenCalled();
  });

  it('keeps confirmation in semi mode', async () => {
    const { executor, execute } = createExecutor({ allowed: true, requiresConfirmation: true, reason: '需确认' });
    const context = createContext('semi');

    const result = await executor.execute('shell_exec', { command: 'git status | Select-Object -First 5' }, context);

    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(context.requestConfirmation).toHaveBeenCalledOnce();
  });
});
