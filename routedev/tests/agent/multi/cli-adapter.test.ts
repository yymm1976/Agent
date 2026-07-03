// tests/agent/multi/cli-adapter.test.ts
// Phase 69 Task 5: CLIAdapter 单元测试

import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter, CLIAdapterRegistry, DEFAULT_CLAUDE_CODE_CONFIG } from '../../../src/agent/multi/cli-adapter.js';

describe('ClaudeCodeAdapter', () => {
  describe('spawn returns CLISession', () => {
    it('should create session with correct structure', async () => {
      const adapter = new ClaudeCodeAdapter(DEFAULT_CLAUDE_CODE_CONFIG);
      const session = await adapter.spawn('implement auth module', '/project');

      expect(session.command).toBe('claude');
      expect(session.args).toContain('implement auth module');
      expect(session.cwd).toBe('/project');
      expect(session.active).toBe(true);
      expect(session.id).toMatch(/^claude-\d+-[a-z0-9]+$/);
      expect(session.createdAt).toBeGreaterThan(0);
    });

    it('should include defaultArgs in session args', async () => {
      const config = {
        command: 'claude',
        defaultArgs: ['--verbose', '--model', 'sonnet'],
        spawnTimeoutMs: 30000,
      };
      const adapter = new ClaudeCodeAdapter(config);
      const session = await adapter.spawn('test task', '/cwd');

      expect(session.args).toEqual(['--verbose', '--model', 'sonnet', 'test task']);
    });
  });

  describe('kill sets active=false', () => {
    it('should set session active to false', async () => {
      const adapter = new ClaudeCodeAdapter(DEFAULT_CLAUDE_CODE_CONFIG);
      const session = await adapter.spawn('task', '/cwd');

      expect(session.active).toBe(true);
      adapter.kill(session);
      expect(session.active).toBe(false);
    });
  });
});

describe('CLIAdapterRegistry', () => {
  describe('register + get + list', () => {
    it('should register and retrieve adapter by name', () => {
      const registry = new CLIAdapterRegistry();
      const adapter = new ClaudeCodeAdapter(DEFAULT_CLAUDE_CODE_CONFIG);

      registry.register(adapter);
      const retrieved = registry.get('claude-code');

      expect(retrieved).toBe(adapter);
      expect(retrieved?.name).toBe('claude-code');
    });

    it('should return undefined for unknown adapter', () => {
      const registry = new CLIAdapterRegistry();

      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should list all registered adapters', () => {
      const registry = new CLIAdapterRegistry();
      const adapter1 = new ClaudeCodeAdapter(DEFAULT_CLAUDE_CODE_CONFIG);
      const adapter2 = new ClaudeCodeAdapter({
        command: 'custom-cli',
        defaultArgs: [],
        spawnTimeoutMs: 60000,
      });
      adapter2.name = 'custom';

      registry.register(adapter1);
      registry.register(adapter2);

      const list = registry.list();
      expect(list.length).toBe(2);
      expect(list.map((a) => a.name)).toContain('claude-code');
      expect(list.map((a) => a.name)).toContain('custom');
    });
  });
});
