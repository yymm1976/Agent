// src/hooks/market-manager.ts
// Hook 市场管理
//
// 与 SkillMarketManager 类似，但管理 Hook 包（JSON 格式）
//
// 目录结构：
//   ${rootDir}/.routedev/market-draft/hooks/<name>/hook.json    草稿
//   ${rootDir}/.routedev/market/hooks/<name>/<version>/hook.json 已发布版本
//   ${rootDir}/.routedev/market/hooks/<name>/metadata.json     市场元数据
//   ${rootDir}/.routedev/hooks/<name>/hook.json                已安装

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export type HookMarketItemStatus = 'draft' | 'published' | 'deprecated';

export interface HookMarketItem {
  name: string;
  version: string;
  type: 'hook';
  status: HookMarketItemStatus;
  draftPath: string;
  publishedPath: string;
  publishedAt?: number;
  changelog: string[];
  metadata?: {
    name: string;
    description: string;
    version: string;
    author: string;
    tags: string[];
  };
}

/** Hook 包 JSON 结构 */
export interface HookPackage {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tags?: string[];
  config: Record<string, unknown>;
}

interface HookMarketMetadataFile {
  name: string;
  type: 'hook';
  status: HookMarketItemStatus;
  currentVersion?: string;
  publishedAt?: number;
  changelog: string[];
  versions: string[];
}

// ============================================================
// HookMarketManager
// ============================================================

export class HookMarketManager {
  private marketDir: string;
  private draftDir: string;
  private installDir: string;

  constructor(rootDir: string) {
    this.marketDir = path.join(rootDir, '.routedev', 'market', 'hooks');
    this.draftDir = path.join(rootDir, '.routedev', 'market-draft', 'hooks');
    this.installDir = path.join(rootDir, '.routedev', 'hooks');
  }

  /**
   * 发布草稿到市场
   */
  async publish(name: string, content: string): Promise<HookMarketItem> {
    if (!name || !/^[a-zA-Z0-9-_]+$/.test(name)) {
      throw new Error(`Invalid hook name: ${name}`);
    }
    if (!content || content.trim().length === 0) {
      throw new Error('Hook content cannot be empty');
    }

    let pkg: HookPackage;
    try {
      pkg = JSON.parse(content) as HookPackage;
    } catch (err) {
      throw new Error(`Invalid hook JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!pkg.name || !pkg.version) {
      throw new Error('Hook package must have name and version');
    }

    const version = pkg.version;

    // 1. 写入草稿
    const draftPath = path.join(this.draftDir, name, 'hook.json');
    await fs.mkdir(path.dirname(draftPath), { recursive: true });
    await fs.writeFile(draftPath, content, 'utf-8');

    // 2. 复制到市场版本目录
    const versionDir = path.join(this.marketDir, name, version);
    const publishedPath = path.join(versionDir, 'hook.json');
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(publishedPath, content, 'utf-8');

    // 3. 更新 metadata.json
    const meta = await this.loadMetadata(name);
    const now = Date.now();
    if (!meta.versions.includes(version)) {
      meta.versions.push(version);
    }
    meta.currentVersion = version;
    meta.status = 'published';
    meta.publishedAt = now;
    meta.changelog = meta.changelog || [];
    meta.changelog.push(`v${version} published at ${new Date(now).toISOString()}`);
    await this.saveMetadata(name, meta);

    logger.info('HookMarketManager: published', { name, version });

    return {
      name,
      version,
      type: 'hook',
      status: 'published',
      draftPath,
      publishedPath,
      publishedAt: now,
      changelog: meta.changelog,
      metadata: {
        name: pkg.name,
        description: pkg.description ?? '',
        version: pkg.version,
        author: pkg.author ?? 'anonymous',
        tags: pkg.tags ?? [],
      },
    };
  }

  /**
   * 列出市场已发布项
   */
  listPublished(): HookMarketItem[] {
    const items: HookMarketItem[] = [];
    if (!fsSync.existsSync(this.marketDir)) return items;

    const entries = fsSync.readdirSync(this.marketDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.marketDir, entry.name, 'metadata.json');
      if (!fsSync.existsSync(metaPath)) continue;
      try {
        const raw = fsSync.readFileSync(metaPath, 'utf-8');
        const meta = JSON.parse(raw) as HookMarketMetadataFile;
        const version = meta.currentVersion ?? meta.versions[meta.versions.length - 1] ?? '0.0.0';
        items.push({
          name: meta.name,
          version,
          type: 'hook',
          status: meta.status,
          draftPath: path.join(this.draftDir, meta.name, 'hook.json'),
          publishedPath: path.join(this.marketDir, meta.name, version, 'hook.json'),
          publishedAt: meta.publishedAt,
          changelog: meta.changelog ?? [],
        });
      } catch (err) {
        logger.warn('HookMarketManager.listPublished: skip invalid metadata', {
          name: entry.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return items;
  }

  /**
   * 列出草稿
   */
  listDrafts(): HookMarketItem[] {
    const items: HookMarketItem[] = [];
    if (!fsSync.existsSync(this.draftDir)) return items;

    const entries = fsSync.readdirSync(this.draftDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const draftPath = path.join(this.draftDir, entry.name, 'hook.json');
      if (!fsSync.existsSync(draftPath)) continue;

      let metadata: HookMarketItem['metadata'];
      let version = '0.0.0';
      try {
        const raw = fsSync.readFileSync(draftPath, 'utf-8');
        const pkg = JSON.parse(raw) as HookPackage;
        metadata = {
          name: pkg.name,
          description: pkg.description ?? '',
          version: pkg.version,
          author: pkg.author ?? 'anonymous',
          tags: pkg.tags ?? [],
        };
        version = pkg.version || '0.0.0';
      } catch {
        // 忽略解析失败
      }

      items.push({
        name: entry.name,
        version,
        type: 'hook',
        status: 'draft',
        draftPath,
        publishedPath: '',
        changelog: [],
        metadata,
      });
    }
    return items;
  }

  /**
   * 安装市场项
   */
  async install(name: string, version?: string): Promise<void> {
    const meta = await this.loadMetadata(name);
    const targetVersion = version ?? meta.currentVersion ?? meta.versions[meta.versions.length - 1];
    if (!targetVersion) {
      throw new Error(`No available version for hook: ${name}`);
    }
    if (!meta.versions.includes(targetVersion)) {
      throw new Error(`Version ${targetVersion} not found for hook: ${name}`);
    }

    const srcPath = path.join(this.marketDir, name, targetVersion, 'hook.json');
    if (!fsSync.existsSync(srcPath)) {
      throw new Error(`Source file not found: ${srcPath}`);
    }

    const destDir = path.join(this.installDir, name);
    const destPath = path.join(destDir, 'hook.json');
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(srcPath, destPath);

    const installMetaPath = path.join(destDir, '.installed.json');
    await fs.writeFile(
      installMetaPath,
      JSON.stringify({ name, version: targetVersion, installedAt: Date.now() }, null, 2),
      'utf-8',
    );

    logger.info('HookMarketManager: installed', { name, version: targetVersion });
  }

  /**
   * 卸载
   */
  async uninstall(name: string): Promise<void> {
    const destDir = path.join(this.installDir, name);
    if (!fsSync.existsSync(destDir)) {
      logger.warn('HookMarketManager.uninstall: not installed', { name });
      return;
    }
    await fs.rm(destDir, { recursive: true, force: true });
    logger.info('HookMarketManager: uninstalled', { name });
  }

  /**
   * 导出为 zip（实际为 JSON 导出文件）
   */
  async export(name: string, outputPath: string): Promise<void> {
    const meta = await this.loadMetadata(name);
    const hookDir = path.join(this.marketDir, name);
    if (!fsSync.existsSync(hookDir)) {
      throw new Error(`Hook not found in market: ${name}`);
    }

    const versions: Record<string, string> = {};
    for (const v of meta.versions) {
      const hookFile = path.join(hookDir, v, 'hook.json');
      if (fsSync.existsSync(hookFile)) {
        versions[v] = await fs.readFile(hookFile, 'utf-8');
      }
    }

    const payload = {
      kind: 'routedev-hook-export',
      version: 1,
      name,
      metadata: meta,
      versions,
      exportedAt: Date.now(),
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf-8');

    logger.info('HookMarketManager: exported', { name, outputPath });
  }

  /**
   * 导入 zip
   */
  async import(zipPath: string): Promise<HookMarketItem> {
    if (!fsSync.existsSync(zipPath)) {
      throw new Error(`Import file not found: ${zipPath}`);
    }

    const raw = await fs.readFile(zipPath, 'utf-8');
    let payload: {
      kind: string;
      name: string;
      metadata: HookMarketMetadataFile;
      versions: Record<string, string>;
    };
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid export file: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (payload.kind !== 'routedev-hook-export') {
      throw new Error(`Not a routedev hook export file: ${payload.kind}`);
    }

    const name = payload.name;
    const versions = payload.versions || {};
    const versionEntries = Object.entries(versions);
    if (versionEntries.length === 0) {
      throw new Error(`No versions in export file: ${zipPath}`);
    }

    for (const [v, content] of versionEntries) {
      const versionDir = path.join(this.marketDir, name, v);
      await fs.mkdir(versionDir, { recursive: true });
      await fs.writeFile(path.join(versionDir, 'hook.json'), content, 'utf-8');
    }

    const meta = await this.loadMetadata(name);
    for (const v of Object.keys(versions)) {
      if (!meta.versions.includes(v)) meta.versions.push(v);
    }
    meta.currentVersion = payload.metadata.currentVersion ?? versionEntries[0][0];
    meta.status = 'published';
    meta.publishedAt = Date.now();
    meta.changelog.push(`imported at ${new Date().toISOString()}`);
    await this.saveMetadata(name, meta);

    const latestVersion = meta.currentVersion;
    let pkg: HookPackage | undefined;
    try {
      pkg = JSON.parse(versionEntries[0][1]) as HookPackage;
    } catch {
      // 忽略
    }

    logger.info('HookMarketManager: imported', { name, version: latestVersion });

    return {
      name,
      version: latestVersion,
      type: 'hook',
      status: 'published',
      draftPath: path.join(this.draftDir, name, 'hook.json'),
      publishedPath: path.join(this.marketDir, name, latestVersion, 'hook.json'),
      publishedAt: meta.publishedAt,
      changelog: meta.changelog,
      metadata: pkg
        ? {
            name: pkg.name,
            description: pkg.description ?? '',
            version: pkg.version,
            author: pkg.author ?? 'anonymous',
            tags: pkg.tags ?? [],
          }
        : undefined,
    };
  }

  /**
   * 回滚到旧版本
   */
  async rollback(name: string, targetVersion: string): Promise<void> {
    const meta = await this.loadMetadata(name);
    if (!meta.versions.includes(targetVersion)) {
      throw new Error(`Version ${targetVersion} not found for hook: ${name}`);
    }

    const srcPath = path.join(this.marketDir, name, targetVersion, 'hook.json');
    if (!fsSync.existsSync(srcPath)) {
      throw new Error(`Source file not found: ${srcPath}`);
    }

    meta.currentVersion = targetVersion;
    meta.changelog.push(`rollback to v${targetVersion} at ${new Date().toISOString()}`);
    await this.saveMetadata(name, meta);

    const installMetaPath = path.join(this.installDir, name, '.installed.json');
    if (fsSync.existsSync(installMetaPath)) {
      await this.install(name, targetVersion);
    }

    logger.info('HookMarketManager: rollback', { name, targetVersion });
  }

  /**
   * 获取版本列表
   */
  getVersions(name: string): string[] {
    const metaPath = path.join(this.marketDir, name, 'metadata.json');
    if (!fsSync.existsSync(metaPath)) return [];
    try {
      const raw = fsSync.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as HookMarketMetadataFile;
      return meta.versions || [];
    } catch {
      return [];
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private async loadMetadata(name: string): Promise<HookMarketMetadataFile> {
    const metaPath = path.join(this.marketDir, name, 'metadata.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(raw) as HookMarketMetadataFile;
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return {
          name,
          type: 'hook',
          status: 'draft',
          changelog: [],
          versions: [],
        };
      }
      logger.warn('HookMarketManager.loadMetadata: parse failed, reset', {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        name,
        type: 'hook',
        status: 'draft',
        changelog: [],
        versions: [],
      };
    }
  }

  private async saveMetadata(name: string, meta: HookMarketMetadataFile): Promise<void> {
    const metaPath = path.join(this.marketDir, name, 'metadata.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
