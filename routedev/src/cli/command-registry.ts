// src/cli/command-registry.ts
// 命令注册表：解耦命令解析与 App.tsx
// 蓝图 17.2：把分散的 case '/' 分支收敛为可扩展的注册表
//
// P0-6 改造（2026-07-05）：新增懒加载支持（借鉴 Claude Code stub + load() 模式）
//   - registerLazy(metadata, loader) 仅注册元数据，handler 在首次调用时按需 import
//   - 适用于带 React 组件或重服务的命令，减少启动时全量加载开销
//   - 旧 register() 保留兼容，已注册的 eager 命令不受影响

import type { ServiceContext } from './service-context.js';
import { logger } from '../utils/logger.js';

export type CommandHandlerResult =
  | { type: 'handled'; messages?: string[] }
  | { type: 'passthrough'; input: string };

export interface CommandDefinition {
  /** 命令名（如 /memory） */
  name: string;
  /** 别名 */
  aliases?: string[];
  /** 简短说明 */
  description: string;
  /** 用法示例 */
  usage?: string;
  /** 处理器 */
  handler: (args: string, ctx: ServiceContext) => Promise<CommandHandlerResult>;
}

/**
 * P0-6：命令元数据 stub（不含 handler）
 *
 * 借鉴 Claude Code `src/commands/clear/index.ts`：
 *   - index.ts 仅 14 行元数据 + `load: () => import('./clear.js')`
 *   - commands.ts 顶部 import ~100 个 stub 几乎零成本
 *   - 首次调用时才触发 impl 模块加载
 *
 * RouteDev 适配：
 *   - 旧 eager 模式继续用 `register(def: CommandDefinition)`
 *   - 新 lazy 模式用 `registerLazy(stub, loader)`
 *   - 带重依赖（React 组件 / 子 Agent 编排 / 数据库连接）的命令优先迁移
 */
export interface CommandStub {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  /** 首次调用时触发，返回完整 CommandDefinition（含 handler） */
  load: () => Promise<CommandDefinition>;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private aliasMap = new Map<string, string>();
  /** P0-6：懒加载 stub 表，key=command name */
  private lazyStubs = new Map<string, CommandStub>();
  /** P0-6：已加载的 handler 缓存，避免重复 import */
  private loadedHandlers = new Map<string, CommandDefinition['handler']>();

  register(def: CommandDefinition): void {
    this.commands.set(def.name, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.aliasMap.set(alias, def.name);
      }
    }
  }

  /**
   * P0-6：注册懒加载命令（仅元数据，handler 延迟到首次调用时加载）
   *
   * @param stub 命令元数据 + load 函数
   *
   * 行为：
   *   - 立即注册 name / aliases / description / usage 到 listCommands() 和 has()
   *   - handler 在首次 execute() 时通过 stub.load() 异步加载并缓存
   *   - 加载失败时返回 type:'handled' 错误消息，不抛异常（fail-soft）
   *
   * @example
   * registry.registerLazy({
   *   name: 'deep-review',
   *   description: '并行多 reviewer 对抗性审查',
   *   load: async () => (await import('./commands/deep-review.js')).deepReviewCommand,
   * });
   */
  registerLazy(stub: CommandStub): void {
    this.lazyStubs.set(stub.name, stub);
    if (stub.aliases) {
      for (const alias of stub.aliases) {
        this.aliasMap.set(alias, stub.name);
      }
    }
  }

  /** 解析输入，返回匹配的命令 stub 或完整定义 */
  parse(input: string): { command: CommandDefinition; args: string } | null {
    if (!input.startsWith('/')) return null;

    const trimmed = input.slice(1).trim();
    const spaceIndex = trimmed.search(/\s/);
    const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

    const canonicalName = this.aliasMap.get(commandName) ?? commandName;

    // 优先匹配 eager 命令
    const eager = this.commands.get(canonicalName);
    if (eager) return { command: eager, args };

    // 其次匹配 lazy stub（返回元数据壳，handler 在 execute 时按需加载）
    const stub = this.lazyStubs.get(canonicalName);
    if (stub) {
      const shell: CommandDefinition = {
        name: stub.name,
        aliases: stub.aliases,
        description: stub.description,
        usage: stub.usage,
        handler: async (a, ctx) => this.invokeLazy(canonicalName, a, ctx),
      };
      return { command: shell, args };
    }
    return null;
  }

  /** P0-6：懒加载命令首次调用的实际执行器 */
  private async invokeLazy(
    name: string,
    args: string,
    ctx: ServiceContext,
  ): Promise<CommandHandlerResult> {
    // 命中缓存：handler 已加载过
    const cached = this.loadedHandlers.get(name);
    if (cached) return cached(args, ctx);

    const stub = this.lazyStubs.get(name);
    if (!stub) return { type: 'passthrough', input: `/${name} ${args}`.trim() };

    try {
      const full = await stub.load();
      // 缓存 handler 供后续调用
      this.loadedHandlers.set(name, full.handler);
      // 同时注册到 eager 表，后续 parse 走快速路径
      this.commands.set(name, full);
      return full.handler(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Lazy command load failed: /${name}`, { error: msg });
      return {
        type: 'handled',
        messages: [`/${name} 加载失败: ${msg}`],
      };
    }
  }

  /** 执行命令 */
  async execute(input: string, ctx: ServiceContext): Promise<CommandHandlerResult> {
    const parsed = this.parse(input);
    if (!parsed) return { type: 'passthrough', input };
    return parsed.command.handler(parsed.args, ctx);
  }

  /** 列出所有命令（用于 /help），合并 eager + lazy stub */
  listCommands(): CommandDefinition[] {
    const eagerList = Array.from(this.commands.values());
    const lazyList: CommandDefinition[] = Array.from(this.lazyStubs.values()).map(stub => ({
      name: stub.name,
      aliases: stub.aliases,
      description: stub.description,
      usage: stub.usage,
      handler: async () => ({ type: 'handled' as const }), // listCommands 不应触发加载
    }));
    return [...eagerList, ...lazyList].sort((a, b) => a.name.localeCompare(b.name));
  }

  has(commandName: string): boolean {
    const canonicalName = this.aliasMap.get(commandName) ?? commandName;
    return this.commands.has(canonicalName) || this.lazyStubs.has(canonicalName);
  }
}

// I6 修复：createCommandRegistry() 工厂函数已移除（0 调用者，App.tsx 直接 new CommandRegistry()）