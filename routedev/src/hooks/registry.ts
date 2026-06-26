// src/hooks/registry.ts
// Phase 39 Task 2：Hook 配置注册表
//
// 设计目标：
//   1. 持久化用户启用的 Hook 配置到 .routedev/hooks.json
//   2. 区分模板 Hook（isTemplate=true）和自定义 Hook（isTemplate=false）
//   3. 支持启用/禁用、增删、按事件过滤
//   4. 与 HookGenerator 解耦：Generator 负责"生成"，Registry 负责"存储"
//
// 文件格式（.routedev/hooks.json）：
//   {
//     "configs": [
//       {
//         "id": "auto-format",
//         "name": "自动格式化",
//         "event": "post-tool-call",
//         "enabled": true,
//         "condition": { "toolName": "file_write" },
//         "command": "npx prettier --write {{filePath}}",
//         "failBehavior": "warn",
//         "isTemplate": true
//       }
//     ]
//   }

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { HookEvent } from '../agent/hooks.js';

// ============================================================
// 类型定义
// ============================================================

/** Hook 配置（持久化结构） */
export interface HookConfig {
  /** 配置 ID（唯一标识） */
  id: string;
  /** 配置名称（展示用） */
  name: string;
  /** 触发事件 */
  event: HookEvent;
  /** 是否启用 */
  enabled: boolean;
  /** 触发条件 */
  condition?: { toolName?: string; filePattern?: string };
  /** 执行命令 */
  command: string;
  /** 失败行为 */
  failBehavior: 'warn' | 'block' | 'silent';
  /** 是否来自模板 */
  isTemplate: boolean;
}

/** 持久化文件结构 */
interface HookConfigFile {
  /** 配置列表 */
  configs: HookConfig[];
}

// ============================================================
// HookConfigRegistry
// ============================================================

/**
 * Hook 配置注册表
 *
 * 职责：
 *   - load()：从 .routedev/hooks.json 加载
 *   - save()：保存到 .routedev/hooks.json
 *   - add/remove/toggle：CRUD 操作
 *   - list/listByEvent/listTemplates/listCustom：查询
 *
 * 注意：
 *   - 所有 CRUD 操作只修改内存，需显式调用 save() 持久化
 *   - 文件不存在时 load() 静默返回空列表
 *   - 文件格式错误时 load() 记录警告并返回空列表
 */
export class HookConfigRegistry {
  /** 配置存储（按 id 索引） */
  private configs: Map<string, HookConfig> = new Map();
  /** 配置文件路径 */
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  /**
   * 从 .routedev/hooks.json 加载
   *
   * 文件不存在时静默返回，格式错误时记录警告并返回空列表
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      const data = JSON.parse(raw) as HookConfigFile;

      if (!data.configs || !Array.isArray(data.configs)) {
        logger.warn('HookConfigRegistry: invalid config file, missing configs array', {
          path: this.configPath,
        });
        return;
      }

      this.configs.clear();
      for (const config of data.configs) {
        if (this.isValidConfig(config)) {
          this.configs.set(config.id, config);
        }
      }

      logger.info('HookConfigRegistry: loaded', {
        path: this.configPath,
        count: this.configs.size,
      });
    } catch (err) {
      // 文件不存在是正常情况，不记录警告
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        logger.debug('HookConfigRegistry: config file not found, starting empty', {
          path: this.configPath,
        });
        return;
      }
      logger.warn('HookConfigRegistry: failed to load config', {
        path: this.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 保存到 .routedev/hooks.json
   *
   * 自动创建父目录
   */
  async save(): Promise<void> {
    const dir = path.dirname(this.configPath);
    // 确保目录存在
    await fs.mkdir(dir, { recursive: true });

    const data: HookConfigFile = {
      configs: Array.from(this.configs.values()),
    };

    await fs.writeFile(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
    logger.info('HookConfigRegistry: saved', {
      path: this.configPath,
      count: this.configs.size,
    });
  }

  /**
   * 添加 Hook 配置
   *
   * 如果 id 已存在，覆盖旧配置
   */
  add(config: HookConfig): void {
    this.configs.set(config.id, config);
    logger.debug('HookConfigRegistry: config added', { id: config.id });
  }

  /**
   * 移除 Hook 配置
   *
   * @returns 是否移除成功（id 不存在时返回 false）
   */
  remove(id: string): boolean {
    const removed = this.configs.delete(id);
    if (removed) {
      logger.debug('HookConfigRegistry: config removed', { id });
    }
    return removed;
  }

  /**
   * 启用/禁用 Hook 配置
   *
   * @returns 是否操作成功（id 不存在时返回 false）
   */
  toggle(id: string, enabled: boolean): boolean {
    const config = this.configs.get(id);
    if (!config) return false;
    config.enabled = enabled;
    logger.debug('HookConfigRegistry: config toggled', { id, enabled });
    return true;
  }

  /**
   * 列出所有配置
   */
  list(): HookConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * 按事件过滤
   */
  listByEvent(event: HookEvent): HookConfig[] {
    return Array.from(this.configs.values()).filter((c) => c.event === event);
  }

  /**
   * 只列模板配置
   */
  listTemplates(): HookConfig[] {
    return Array.from(this.configs.values()).filter((c) => c.isTemplate);
  }

  /**
   * 只列自定义配置
   */
  listCustom(): HookConfig[] {
    return Array.from(this.configs.values()).filter((c) => !c.isTemplate);
  }

  /**
   * 获取指定 ID 的配置
   */
  get(id: string): HookConfig | undefined {
    return this.configs.get(id);
  }

  /**
   * 清空所有配置
   */
  clear(): void {
    this.configs.clear();
  }

  /**
   * 配置数量
   */
  size(): number {
    return this.configs.size;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 合法的事件白名单 */
  private static readonly VALID_EVENTS: string[] = [
    'pre-step',
    'post-step',
    'on-error',
    'on-complete',
    'pre-tool-call',
    'post-tool-call',
    'on-session-start',
    'on-session-end',
    'on-model-call',
  ];

  /** 校验配置对象是否合法 */
  private isValidConfig(config: unknown): config is HookConfig {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as Record<string, unknown>;
    return (
      typeof c.id === 'string' &&
      typeof c.name === 'string' &&
      typeof c.event === 'string' &&
      typeof c.enabled === 'boolean' &&
      typeof c.command === 'string' &&
      typeof c.failBehavior === 'string' &&
      typeof c.isTemplate === 'boolean' &&
      HookConfigRegistry.VALID_EVENTS.includes(c.event)
    );
  }
}
