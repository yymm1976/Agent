// src/plugins/pack-discovery.ts
// 用户自建 Pack 发现器（Phase 82 Task 4）
// 扫描项目级 / 全局 / 内置三处 Pack 目录，按优先级合并去重
// 核心原则：fail-open——任何 Pack 加载失败不阻断其他 Pack 发现
//
// 优先级（从高到低）：
//   1. 项目级 `<cwd>/.routedev/packs/*/`
//   2. 全局 `~/.routedev/packs/*/`
//   3. 内置 Pack（从 `./packs/index.js` 动态导入）
// 同名 Pack（按 id 去重）：项目级覆盖全局，全局覆盖内置

import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../utils/logger.js';
import type { CapabilityPack } from './capability-pack.js';

// ============================================================
// 类型定义
// ============================================================

/** Pack 来源：项目级 > 全局 > 内置 */
export type PackSource = 'project' | 'global' | 'builtin';

/** 发现到的 Pack（含来源与路径） */
export interface DiscoveredPack {
  /** Pack 实例 */
  pack: CapabilityPack;
  /** 来源：项目级 / 全局 / 内置 */
  source: PackSource;
  /** Pack 目录绝对路径（builtin 为虚拟标记） */
  path: string;
}

/** pack.json 元数据格式 */
interface PackManifest {
  id: string;
  layer: string;
  description: string;
  costHint: string;
}

// ============================================================
// PackDiscovery
// ============================================================

/**
 * Pack 发现器
 *
 * 扫描路径（优先级从高到低）：
 *   1. 项目级 <cwd>/.routedev/packs/<name>/
 *   2. 全局 ~/.routedev/packs/<name>/
 *   3. 内置 Pack（从 ./packs/index.js 动态导入）
 *
 * 同名 Pack（按 id 去重）：项目级覆盖全局，全局覆盖内置
 * 任何 Pack 加载失败 → fail-open + log warn，不阻断其他 Pack 发现
 */
export class PackDiscovery {
  /**
   * @param cwd 当前工作目录（用于扫描项目级 .routedev/packs/）
   * @param homedir 用户主目录（用于扫描全局 ~/.routedev/packs/）
   */
  constructor(
    private readonly cwd: string,
    private readonly homedir: string,
  ) {}

  /**
   * 扫描所有 Pack 目录，返回发现到的 Pack 列表
   * 按 id 去重：项目级 > 全局 > 内置
   */
  async discover(): Promise<DiscoveredPack[]> {
    // 用 Map 按 pack.id 去重，先写入者胜（按优先级顺序写入）
    const byId = new Map<string, DiscoveredPack>();

    // 1. 项目级 Pack（最高优先级）
    const projectPacks = await this.discoverFromFilesystem(this.cwd, 'project');
    for (const dp of projectPacks) {
      byId.set(dp.pack.id, dp);
    }

    // 2. 全局 Pack（项目级未覆盖时生效）
    const globalPacks = await this.discoverFromFilesystem(this.homedir, 'global');
    for (const dp of globalPacks) {
      if (!byId.has(dp.pack.id)) {
        byId.set(dp.pack.id, dp);
      }
    }

    // 3. 内置 Pack（最低优先级）
    const builtinPacks = await this.discoverBuiltin();
    for (const dp of builtinPacks) {
      if (!byId.has(dp.pack.id)) {
        byId.set(dp.pack.id, dp);
      }
    }

    return Array.from(byId.values());
  }

  /**
   * 从文件系统扫描 Pack 目录
   * 约定：`<base>/.routedev/packs/<name>/` 含 `pack.json` + `index.ts`
   *
   * @param base 基准目录（cwd 或 homedir）
   * @param source 来源标记（project / global）
   */
  private async discoverFromFilesystem(
    base: string,
    source: 'project' | 'global',
  ): Promise<DiscoveredPack[]> {
    const packsDir = path.join(base, '.routedev', 'packs');
    const results: DiscoveredPack[] = [];

    // 读取 packs 目录条目
    let entries: string[];
    try {
      entries = await fs.readdir(packsDir);
    } catch (e) {
      // 目录不存在（ENOENT）是正常情况，静默跳过；其他错误记 warn
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.warn('[pack-discovery] 读取 packs 目录失败', {
          dir: packsDir,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return results;
    }

    for (const entry of entries) {
      const packDir = path.join(packsDir, entry);

      // 跳过非目录条目
      try {
        const stat = await fs.stat(packDir);
        if (!stat.isDirectory()) continue;
      } catch (e) {
        // stat 失败（权限/ENOENT），跳过该条目
        logger.debug('[pack-discovery] stat 失败，跳过条目', {
          packDir,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      // 尝试加载该 Pack（失败 fail-open，返回 null）
      const discovered = await this.tryLoadPack(packDir, source);
      if (discovered) results.push(discovered);
    }

    return results;
  }

  /**
   * 尝试加载单个 Pack 目录
   * 读取 pack.json + 动态 import index.ts
   * 任何步骤失败 → fail-open（log warn，返回 null）
   */
  private async tryLoadPack(
    packDir: string,
    source: 'project' | 'global',
  ): Promise<DiscoveredPack | null> {
    // 1. 读取 pack.json 元数据
    let manifest: PackManifest;
    try {
      const raw = await fs.readFile(path.join(packDir, 'pack.json'), 'utf-8');
      manifest = JSON.parse(raw) as PackManifest;
    } catch (e) {
      // pack.json 读取或 JSON 解析失败 → fail-open
      logger.warn('[pack-discovery] pack.json 读取/解析失败，跳过', {
        packDir,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }

    // 2. 基础字段校验：必需字段不可缺
    const missing: string[] = [];
    if (!manifest.id) missing.push('id');
    if (!manifest.layer) missing.push('layer');
    if (!manifest.description) missing.push('description');
    if (!manifest.costHint) missing.push('costHint');
    if (missing.length > 0) {
      logger.warn('[pack-discovery] pack.json 缺少必需字段，跳过', { packDir, missing });
      return null;
    }

    // 3. 动态 import 入口文件（优先 index.ts，回退 index.js）
    let pack: CapabilityPack;
    try {
      const entryPath = await this.resolveEntry(packDir);
      if (!entryPath) {
        logger.warn('[pack-discovery] 未找到 Pack 入口文件（index.ts/index.js），跳过', {
          packDir,
          id: manifest.id,
        });
        return null;
      }
      // 用 pathToFileURL 转换为 file:// URL（Windows 路径兼容）
      const fileUrl = pathToFileURL(entryPath).href;
      const mod = await import(fileUrl);
      // 默认导出为 CapabilityPack，兼容命名导出 pack
      const exported = mod.default ?? mod.pack;
      if (!exported) {
        logger.warn('[pack-discovery] Pack 入口未导出 default 或 pack，跳过', {
          packDir,
          id: manifest.id,
        });
        return null;
      }
      pack = exported as CapabilityPack;
    } catch (e) {
      // fail-open：单个 Pack 动态 import 失败不阻断其他
      logger.warn('[pack-discovery] Pack 动态 import 失败，跳过', {
        packDir,
        id: manifest.id,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }

    // 4. 一致性校验：pack.id 必须与 pack.json 声明的 id 一致
    if (pack.id !== manifest.id) {
      logger.warn('[pack-discovery] Pack id 与 pack.json 不一致，跳过', {
        packDir,
        manifestId: manifest.id,
        packId: pack.id,
      });
      return null;
    }

    return { pack, source, path: packDir };
  }

  /**
   * 解析 Pack 入口文件路径
   * 优先 index.ts，回退 index.js
   * 都不存在返回 null
   */
  private async resolveEntry(packDir: string): Promise<string | null> {
    const tsEntry = path.join(packDir, 'index.ts');
    const jsEntry = path.join(packDir, 'index.js');
    // 同步 existsSync 避免 await 竞态；入口文件存在性检查无性能瓶颈
    if (fsSync.existsSync(tsEntry)) return tsEntry;
    if (fsSync.existsSync(jsEntry)) return jsEntry;
    return null;
  }

  /**
   * 加载内置 Pack
   * 从 `./packs/index.js` 动态导入
   * 导出形状：`{ builtinPacks: CapabilityPack[] }` 或 default 数组
   * 加载失败 → fail-open（log warn，返回空数组）
   */
  private async discoverBuiltin(): Promise<DiscoveredPack[]> {
    try {
      // 动态 import 避免内置 Pack 模块不存在时阻断整个发现器加载
      const mod = await import('./packs/index.js');
      // 内置 Pack 模块导出 OFFICIAL_PACKS 数组
      const packs: unknown = mod.OFFICIAL_PACKS ?? [];
      if (!Array.isArray(packs)) {
        logger.warn('[pack-discovery] 内置 Pack 模块未导出数组', { type: typeof packs });
        return [];
      }
      return (packs as CapabilityPack[]).map((p) => ({
        pack: p,
        source: 'builtin' as const,
        path: '<builtin>',
      }));
    } catch (e) {
      // 内置 Pack 模块加载失败 → fail-open（可能模块尚未实现）
      logger.warn('[pack-discovery] 内置 Pack 加载失败', {
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }
}
