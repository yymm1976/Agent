// src/tools/registry.ts
// 工具注册表：管理所有已注册的工具
// 实现 IToolRegistry 接口

import type { ITool, IToolRegistry, ToolExposureMeta } from './types.js';
import type { LLMToolDefinition } from '../router/types.js';
import { logger } from '../utils/logger.js';

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ITool>();

  /**
   * 注册工具
   * 默认拒绝重复注册，调用方必须显式传入 forceOverwrite=true 才能覆盖
   * B-01A：meta 在注册时合并到工具定义的拷贝（Object.create 包装保留类实例方法），
   * 供类式工具附加 exposure/modes/readOnly 元数据，无需改动工具类文件。
   * @param tool 要注册的工具
   * @param forceOverwrite 是否强制覆盖（默认 false，避免插件或重复初始化静默覆盖工具）
   * @param meta 注册时附加的模型可见性元数据（可选）
   */
  register(tool: ITool, forceOverwrite = false, meta?: ToolExposureMeta): void {
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
    // 有 meta 时包装：原型继承原工具（保留 execute 等方法），仅遮蔽合并后的 definition
    const entry: ITool = meta
      ? Object.assign(Object.create(tool) as ITool, {
          definition: { ...tool.definition, ...meta },
        })
      : tool;
    this.tools.set(name, entry);
    logger.debug(`Tool registered: ${name}`, {
      category: tool.definition.category,
      requiresApproval: tool.definition.requiresApproval,
      exposure: entry.definition.exposure,
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
      // 保留双断言：ToolParameterSchema 含字面量 type:'object'，与 Record<string, unknown>
      // 不充分重叠；LLMToolDefinition 在 router/types.ts（EXCLUDED），无法改 parameters 类型
      parameters: tool.definition.parameters as unknown as Record<string, unknown>,
      // Phase 96 P1-6：透传 strict 字段（仅在工具显式声明时才赋值，避免 undefined 覆盖 client 默认）
      ...(tool.definition.strict !== undefined ? { strict: tool.definition.strict } : {}),
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
