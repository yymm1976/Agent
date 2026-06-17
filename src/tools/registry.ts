// src/tools/registry.ts
// 工具注册表：管理所有已注册的工具
// 实现 IToolRegistry 接口

import type { ITool, IToolRegistry } from './types.js';
import type { LLMToolDefinition } from '../router/types.js';
import { logger } from '../utils/logger.js';

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ITool>();

  register(tool: ITool): void {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      logger.warn(`Tool "${name}" already registered, overwriting`, {
        category: tool.definition.category,
        requiresApproval: tool.definition.requiresApproval,
      });
    }
    this.tools.set(name, tool);
    logger.debug(`Tool registered: ${name}`, {
      category: tool.definition.category,
      requiresApproval: tool.definition.requiresApproval,
    });
  }

  unregister(name: string): void {
    const existed = this.tools.delete(name);
    if (existed) {
      logger.debug(`Tool unregistered: ${name}`);
    }
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ITool[] {
    return Array.from(this.tools.values());
  }

  /** 生成给 LLM function calling 用的 schema 列表 */
  getFunctionSchemas(): LLMToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.definition.name,
      description: tool.definition.description,
      parameters: tool.definition.parameters as unknown as Record<string, unknown>,
    }));
  }

  /** 获取工具总数 */
  get size(): number {
    return this.tools.size;
  }
}
