// src/plugins/capability-pack-registry.ts
// Phase 82 Task 1：能力包注册表
//
// 职责：
//   1. 管理 CapabilityPack 的注册/注销（register / unregister / get / listAll / listByLayer）
//   2. loadEnabled：根据 config.packs.<id>.enabled 加载已启用的 Pack
//      - 仅 enabled 时调用 pack.register(ctx)
//      - register 抛错 → fail-open + log + usage-counter 记录 pack:<id>:skip
//      - 成功注册后记录 pack:<id>:load
//      - 重复 enable 幂等（已加载的不再重复注册）
//
// 设计原则：
//   - Pack 加载失败绝不阻断 Core 主流程
//   - 与 PluginRegistry 分离：Plugin 是文件系统发现的外部模块，Pack 是内置能力单元

import type { CapabilityPack, PackContext, PackLayer } from './capability-pack.js';
import { logger } from '../utils/logger.js';

// ============================================================
// CapabilityPackRegistry
// ============================================================

/**
 * 能力包注册表
 *
 * 负责 Pack 的注册管理和按需加载。
 * 与 PluginRegistry 的区别：
 *   - PluginRegistry 从文件系统发现外部插件（routedev-plugin.json）
 *   - CapabilityPackRegistry 管理内置能力包（代码中静态 register）
 *   - Pack 的启用/禁用由 config.packs.<id>.enabled 控制
 */
export class CapabilityPackRegistry {
  /** 已注册的 Pack（id → pack 实例） */
  private readonly packs = new Map<string, CapabilityPack>();
  /** 已加载（已调用 register）的 Pack id 集合——用于幂等控制 */
  private readonly loaded = new Set<string>();

  /** 注册一个 Pack（重复 id 抛异常） */
  register(pack: CapabilityPack): void {
    if (this.packs.has(pack.id)) {
      throw new Error(`Pack "${pack.id}" already registered`);
    }
    this.packs.set(pack.id, pack);
    logger.debug('[PackRegistry] Pack 注册', { id: pack.id, layer: pack.layer });
  }

  /** 注销一个 Pack（若已加载则先 unregister） */
  unregister(packId: string): void {
    this.packs.delete(packId);
    // 清理加载标记（实际 unregister 资源由调用方通过 pack.unregister 完成）
    this.loaded.delete(packId);
  }

  /** 获取指定 Pack */
  get(packId: string): CapabilityPack | undefined {
    return this.packs.get(packId);
  }

  /** 列出所有已注册的 Pack */
  listAll(): CapabilityPack[] {
    return Array.from(this.packs.values());
  }

  /** 按层级列出 Pack */
  listByLayer(layer: PackLayer): CapabilityPack[] {
    return this.listAll().filter((p) => p.layer === layer);
  }

  /**
   * 加载所有已启用的 Pack
   *
   * 约束：
   *   - 读 config.packs.<packId>.enabled，仅 enabled 时调用 pack.register(ctx)
   *   - register 抛错 → fail-open + log + usage-counter 记录 pack:<id>:skip
   *   - 成功注册后记录 pack:<id>:load
   *   - 重复 enable 幂等（已加载的 Pack 不再重复注册）
   *
   * @param ctx Pack 上下文（包含 config / tools / commands / events / logger / usage）
   */
  async loadEnabled(ctx: PackContext): Promise<void> {
    // 将 config.packs 转为动态查找表（PacksConfig 的 key 是固定的 camelCase，需 cast 才能用 string 索引）
    const packsConfig = ctx.config.packs as Record<string, { enabled?: boolean } | undefined>;

    for (const pack of this.packs.values()) {
      // 幂等：已加载的 Pack 跳过
      if (this.loaded.has(pack.id)) {
        continue;
      }

      // 读 config.packs.<configKey>.enabled（configKey 是 camelCase，如 'browserWeb'）
      const enabled = packsConfig[pack.configKey]?.enabled === true;
      if (!enabled) {
        // 未启用的 Pack 不加载（不计数 skip——skip 仅用于 register 抛错的情况）
        continue;
      }

      try {
        await pack.register(ctx);
        // 标记为已加载
        this.loaded.add(pack.id);
        // 记录加载成功
        ctx.usage.increment({ kind: 'pack', name: pack.id, action: 'load' });
        logger.info('[PackRegistry] Pack 加载成功', { id: pack.id, layer: pack.layer });
      } catch (err) {
        // fail-open：register 抛错不阻断 Core 主流程
        // 记录 skip（表示该 Pack 被跳过）
        ctx.usage.increment({ kind: 'pack', name: pack.id, action: 'skip' });
        logger.warn('[PackRegistry] Pack 加载失败，fail-open 跳过', {
          id: pack.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** 检查指定 Pack 是否已加载（已调用 register 成功） */
  isLoaded(packId: string): boolean {
    return this.loaded.has(packId);
  }
}
