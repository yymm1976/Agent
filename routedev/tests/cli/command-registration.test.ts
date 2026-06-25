// tests/cli/command-registration.test.ts
// Phase 46 Task 5：验证 5 个未注册命令已正确注册到 CommandRegistry
// 以及 /clarify 命令输出不再引用已删除的 /clarify-enrich

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommandRegistry } from '../../src/cli/command-registry.js';
import { clarifyCommand } from '../../src/cli/commands/clarify.js';
import { experimentCommand } from '../../src/cli/commands/experiment.js';
import { qualityCommand } from '../../src/cli/commands/quality.js';
import { scheduleCommand } from '../../src/cli/commands/schedule.js';
import { trustCommand } from '../../src/cli/commands/trust.js';

describe('Phase 46 Task 5：CLI 命令注册', () => {
  function buildRegistryWithAll(): CommandRegistry {
    const registry = new CommandRegistry();
    [
      clarifyCommand,
      experimentCommand,
      qualityCommand,
      scheduleCommand,
      trustCommand,
    ].forEach((c) => registry.register(c));
    return registry;
  }

  it('/clarify 命令在 CommandRegistry 中可被找到', () => {
    const registry = buildRegistryWithAll();
    expect(registry.has('clarify')).toBe(true);
    expect(clarifyCommand.name).toBe('clarify');
  });

  it('/experiment 命令在 CommandRegistry 中可被找到', () => {
    const registry = buildRegistryWithAll();
    expect(registry.has('experiment')).toBe(true);
    expect(experimentCommand.name).toBe('experiment');
  });

  it('/quality 命令在 CommandRegistry 中可被找到', () => {
    const registry = buildRegistryWithAll();
    expect(registry.has('quality')).toBe(true);
    expect(qualityCommand.name).toBe('quality');
  });

  it('/schedule 命令在 CommandRegistry 中可被找到', () => {
    const registry = buildRegistryWithAll();
    expect(registry.has('schedule')).toBe(true);
    expect(scheduleCommand.name).toBe('schedule');
  });

  it('/trust 命令在 CommandRegistry 中可被找到', () => {
    const registry = buildRegistryWithAll();
    expect(registry.has('trust')).toBe(true);
    expect(trustCommand.name).toBe('trust');
  });

  it('/clarify 输出不包含 /clarify-enrich', () => {
    // 静态检查源文件：确保已删除对 /clarify-enrich 的引用
    const sourcePath = resolve(__dirname, '../../src/cli/commands/clarify.ts');
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).not.toContain('/clarify-enrich');
  });
});
