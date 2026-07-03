// src/agent/multi/cli-adapter.ts
// Phase 69 Task 5: CLI 代理适配器

import { logger } from '../../utils/logger.js';

export interface CLIAdapterConfig {
  command: string;
  defaultArgs: string[];
  spawnTimeoutMs: number;
}

export const DEFAULT_CLAUDE_CODE_CONFIG: CLIAdapterConfig = {
  command: 'claude',
  defaultArgs: [],
  spawnTimeoutMs: 30000,
};

export interface CLISession {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  active: boolean;
  createdAt: number;
}

export interface CLIAdapter {
  name: string;
  spawn(task: string, cwd: string): Promise<CLISession>;
  kill(session: CLISession): void;
}

export class ClaudeCodeAdapter implements CLIAdapter {
  name = 'claude-code';

  constructor(private config: CLIAdapterConfig) {}

  async spawn(task: string, cwd: string): Promise<CLISession> {
    const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = [...this.config.defaultArgs, task];

    logger.info('ClaudeCodeAdapter: session started', { id, command: this.config.command });

    return {
      id,
      command: this.config.command,
      args,
      cwd,
      active: true,
      createdAt: Date.now(),
    };
  }

  kill(session: CLISession): void {
    session.active = false;
    logger.info('ClaudeCodeAdapter: session killed', { id: session.id });
  }
}

export class CLIAdapterRegistry {
  private adapters = new Map<string, CLIAdapter>();

  register(adapter: CLIAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): CLIAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): CLIAdapter[] {
    return [...this.adapters.values()];
  }
}
