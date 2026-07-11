// src/plugins/capability-pack.ts
// Phase 82 Task 1：能力包（Capability Pack）运行时接口
//
// 设计参考：Pi Extensions 风格的 Pack 接口
//   - Pack 是比 Plugin 更重的能力单元：一个 Pack 可注册多个工具/命令/事件钩子
//   - Pack 分两层：extended（高级区）/ standard（扩展区）
//   - Pack 默认不启用（defaultEnabled 始终 false），需 config.packs.<id>.enabled 显式开启
//   - Pack 加载失败不阻断 Core 主流程（fail-open）
//
// 本文件提供：
//   1. Pack 核心接口定义（CapabilityPack / PackContext / PackLayer）
//   2. CommandRegistry——轻量 slash 命令注册表
//   3. PackEventBus——轻量事件总线（tool_call / message / turn_start 等事件）
//
// 具体的 Pack 实现（multi-agent / browser-web / code-map 等）由 Task 2/3 负责。

import type { ToolRegistry } from '../tools/registry.js';
import type { AppConfig } from '../config/schema.js';
import type { UsageCounter } from '../observability/usage-counter.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** Pack 层级：extended = 高级区（默认关，修 bug 不扩功能）/ standard = 扩展区（默认关，冷处理仅修崩溃） */
export type PackLayer = 'extended' | 'standard';

/** 日志类型：复用全局 Winston logger 实例类型 */
export type Logger = typeof logger;

/** slash 命令处理器：接收原始参数字符串，返回文本结果 */
export type CommandHandler = (args: string) => Promise<string> | string;

/** Pack 事件类型枚举（可扩展） */
export type PackEventType =
  | 'tool_call'       // 工具调用前后
  | 'message'         // 消息收发
  | 'turn_start'      // 轮次开始
  | 'turn_end'        // 轮次结束
  | 'pack_load'       // Pack 加载
  | 'pack_unload';    // Pack 卸载

/** 事件处理器：接收事件负载（任意结构），无返回值 */
export type PackEventHandler = (payload: unknown) => void;

// ============================================================
// Pack 核心接口
// ============================================================

/**
 * 能力包接口（Pi Extensions 风格）
 *
 * 一个 Pack 是一个自包含的能力单元：
 *   - register(ctx)：在 ctx.tools / ctx.commands / ctx.events 上注册自己的资源
 *   - unregister(ctx)：逆操作，清理已注册的资源
 *   - defaultEnabled 始终 false——用户必须在 config.packs.<id>.enabled 中显式开启
 */
export interface CapabilityPack {
  /** Pack 唯一标识（如 'pack.multi-agent'） */
  id: string;
  /** 对应 config.packs 的 key（如 'multiAgent'），用于读取启用状态 */
  configKey: string;
  /** 层级：extended | standard */
  layer: PackLayer;
  /** 用户可见描述（展示在设置页"能力分层"tab） */
  description: string;
  /** 启用后的 token/性能成本提示（如 '+2 tools, ~500 tokens/system prompt'） */
  costHint: string;
  /** 始终 false——Pack 默认不启用，需配置显式开启 */
  defaultEnabled: false;
  /** 注册 Pack 资源到上下文（工具/命令/事件钩子） */
  register(ctx: PackContext): Promise<void> | void;
  /** 可选：卸载 Pack 时清理资源（注销工具/命令/事件） */
  unregister?(ctx: PackContext): Promise<void> | void;
}

/**
 * Pack 上下文（Pi Extensions 风格）
 *
 * Pack 通过此上下文访问宿主能力：
 *   - tools：注册/注销工具
 *   - commands：注册/注销 slash 命令
 *   - events：订阅事件钩子
 *   - config：只读配置（AppConfig）
 *   - logger：宿主日志
 *   - usage：使用计数器（记录 Pack 内部事件）
 */
export interface PackContext {
  /** 工具注册表 */
  tools: ToolRegistry;
  /** 命令注册表 */
  commands: CommandRegistry;
  /** 事件总线 */
  events: PackEventBus;
  /** 全局配置 */
  config: AppConfig;
  /** 宿主日志 */
  logger: Logger;
  /** 使用计数器 */
  usage: UsageCounter;
}

// ============================================================
// CommandRegistry——轻量 slash 命令注册表
// ============================================================

/**
 * slash 命令注册表
 *
 * 职责：register / unregister / execute / list
 * 不做权限校验（由调用方在上层处理），不解析参数语法（由调用方拆分）
 */
export class CommandRegistry {
  /** 命令名 → 处理器 */
  private readonly commands = new Map<string, CommandHandler>();

  /** 注册命令（重复注册抛异常，防止意外覆盖） */
  register(name: string, handler: CommandHandler): void {
    if (this.commands.has(name)) {
      throw new Error(`Command "${name}" already registered`);
    }
    this.commands.set(name, handler);
  }

  /** 注销命令 */
  unregister(name: string): void {
    this.commands.delete(name);
  }

  /** 执行命令：未注册时抛异常 */
  async execute(name: string, args: string): Promise<string> {
    const handler = this.commands.get(name);
    if (!handler) {
      throw new Error(`Command "${name}" not found`);
    }
    return handler(args);
  }

  /** 列出所有已注册的命令名 */
  list(): string[] {
    return Array.from(this.commands.keys());
  }

  /** 检查命令是否已注册 */
  has(name: string): boolean {
    return this.commands.has(name);
  }
}

// ============================================================
// PackEventBus——轻量事件总线
// ============================================================

/**
 * Pack 事件总线
 *
 * 职责：on / off / emit
 * 支持事件：tool_call / message / turn_start / turn_end / pack_load / pack_unload
 * 事件处理器异常不阻断 emit（fail-open，仅记录日志）
 */
export class PackEventBus {
  /** 事件名 → 处理器列表 */
  private readonly handlers = new Map<PackEventType, Set<PackEventHandler>>();

  /** 订阅事件 */
  on(event: PackEventType, handler: PackEventHandler): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  /** 取消订阅（需传入同一个处理器引用） */
  off(event: PackEventType, handler: PackEventHandler): void {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      // 清理空集合，避免内存泄漏
      if (set.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  /** 触发事件：逐个调用处理器，单个异常不阻断其他 */
  emit(event: PackEventType, payload: unknown): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        // fail-open：单个处理器异常不阻断其他处理器
        logger.debug('[PackEventBus] 事件处理器异常，fail-open 跳过', {
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** 获取指定事件的订阅者数量（供测试和状态查询用） */
  listenerCount(event: PackEventType): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
