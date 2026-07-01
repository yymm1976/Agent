// src/tools/registry.ts
// 工具注册表：管理所有已注册的工具
// 实现 IToolRegistry 接口

import type { ITool, IToolRegistry } from './types.js';
import type { LLMToolDefinition } from '../router/types.js';
import { logger } from '../utils/logger.js';

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ITool>();

  /**
   * 注册工具
   * 默认拒绝重复注册，调用方必须显式传入 forceOverwrite=true 才能覆盖
   * @param tool 要注册的工具
   * @param forceOverwrite 是否强制覆盖（默认 false，避免插件或重复初始化静默覆盖工具）
   */
  register(tool: ITool, forceOverwrite = false): void {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      if (!forceOverwrite) {
        // M1 修复：forceOverwrite=false 时抛异常，防止意外覆盖
        throw new Error(`Tool "${name}" already registered (forceOverwrite=false)`);
      }
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

  /**
   * 创建注册表的浅拷贝（工具对象共享引用，但 Map 独立）
   * Phase 38 Task 2：用于子 Agent 工具集隔离
   *   - 父 Agent registry 不受子 Agent 工具增删影响
   *   - 子 Agent 在 clone 上 unregister('spawn_agent') 阻断递归
   *   - 工具对象本身共享引用（避免重复实例化开销）
   */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      copy.tools.set(name, tool);
    }
    return copy;
  }
}
