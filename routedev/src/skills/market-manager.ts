// src/skills/market-manager.ts
// Skill 市场管理
//
// 设计目标：
//   1. 维护 Skill 草稿目录与已发布市场目录
//   2. 支持发布、安装、卸载、导出、导入、回滚
//   3. 版本化管理（每个版本一个子目录）
//   4. 与 SkillMdParser 协作解析 SKILL.md
//
// 目录结构：
//   ${rootDir}/.routedev/market-draft/skills/<name>/SKILL.md       草稿
//   ${rootDir}/.routedev/market/skills/<name>/<version>/SKILL.md   已发布版本
//   ${rootDir}/.routedev/market/skills/<name>/metadata.json        市场元数据
//   ${rootDir}/.routedev/skills/<name>/SKILL.md                    已安装

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { SkillMdParser, type SkillMetadata, type ParsedSkill } from './skill-md-parser.js';

// ============================================================
// 类型定义
// ============================================================

export type MarketItemStatus = 'draft' | 'published' | 'deprecated';

export interface MarketItem {
  name: string;
  version: string;
  type: 'skill' | 'hook';
  status: MarketItemStatus;
  draftPath: string;
  publishedPath: string;
  publishedAt?: number;
  changelog: string[];
  metadata?: SkillMetadata;
}

/** 市场元数据持久化结构（每个 name 一份 metadata.json） */
interface MarketMetadataFile {
  name: string;
  type: 'skill';
  status: MarketItemStatus;
  currentVersion?: string;
  publishedAt?: number;
  changelog: string[];
  versions: string[];
}

// ============================================================
// SkillMarketManager
// ============================================================

export class SkillMarketManager {
  private marketDir: string;
  private draftDir: string;
  private installDir: string;

  constructor(rootDir: string) {
    this.marketDir = path.join(rootDir, '.routedev', 'market', 'skills');
    this.draftDir = path.join(rootDir, '.routedev', 'market-draft', 'skills');
    this.installDir = path.join(rootDir, '.routedev', 'skills');
  }

  /**
   * 发布草稿到市场
   *
   * 流程：
   *   1. 解析传入 content，提取 metadata
   *   2. 写入草稿目录
   *   3. 复制到 market/<name>/<version>/SKILL.md
   *   4. 更新 metadata.json
   */
  async publish(name: string, content: string): Promise<MarketItem> {
    if (!name || !/^[a-zA-Z0-9-_]+$/.test(name)) {
      throw new Error(`Invalid skill name: ${name}`);
    }
    if (!content || content.trim().length === 0) {
      throw new Error('Skill content cannot be empty');
    }

    const parsed = SkillMdParser.parse(content);
    const version = parsed.metadata.version || '0.0.1';

    // 1. 写入草稿
    const draftPath = path.join(this.draftDir, name, 'SKILL.md');
    await fs.mkdir(path.dirname(draftPath), { recursive: true });
    await fs.writeFile(draftPath, content, 'utf-8');

    // 2. 复制到市场版本目录
    const versionDir = path.join(this.marketDir, name, version);
    const publishedPath = path.join(versionDir, 'SKILL.md');
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(publishedPath, content, 'utf-8');

    // 3. 更新 metadata.json
    const metaPath = path.join(this.marketDir, name, 'metadata.json');
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

    logger.info('SkillMarketManager: published', { name, version });

    return {
      name,
      version,
      type: 'skill',
      status: 'published',
      draftPath,
      publishedPath,
      publishedAt: now,
      changelog: meta.changelog,
      metadata: parsed.metadata,
    };
  }

  /**
   * 列出市场已发布项
   */
  listPublished(): MarketItem[] {
    const items: MarketItem[] = [];
    if (!fsSync.existsSync(this.marketDir)) return items;

    const entries = fsSync.readdirSync(this.marketDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.marketDir, entry.name, 'metadata.json');
      if (!fsSync.existsSync(metaPath)) continue;
      try {
        const raw = fsSync.readFileSync(metaPath, 'utf-8');
        const meta = JSON.parse(raw) as MarketMetadataFile;
        const version = meta.currentVersion ?? meta.versions[meta.versions.length - 1] ?? '0.0.0';
        items.push({
          name: meta.name,
          version,
          type: 'skill',
          status: meta.status,
          draftPath: path.join(this.draftDir, meta.name, 'SKILL.md'),
          publishedPath: path.join(this.marketDir, meta.name, version, 'SKILL.md'),
          publishedAt: meta.publishedAt,
          changelog: meta.changelog ?? [],
        });
      } catch (err) {
        logger.warn('SkillMarketManager.listPublished: skip invalid metadata', {
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
  listDrafts(): MarketItem[] {
    const items: MarketItem[] = [];
    if (!fsSync.existsSync(this.draftDir)) return items;

    const entries = fsSync.readdirSync(this.draftDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const draftPath = path.join(this.draftDir, entry.name, 'SKILL.md');
      if (!fsSync.existsSync(draftPath)) continue;

      let metadata: SkillMetadata | undefined;
      let version = '0.0.0';
      try {
        const raw = fsSync.readFileSync(draftPath, 'utf-8');
        const parsed = SkillMdParser.parse(raw);
        metadata = parsed.metadata;
        version = parsed.metadata.version || '0.0.0';
      } catch {
        // 忽略解析失败
      }

      items.push({
        name: entry.name,
        version,
        type: 'skill',
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
   * 安装市场项（复制到 .routedev/skills/）
   */
  async install(name: string, version?: string): Promise<void> {
    const meta = await this.loadMetadata(name);
    const targetVersion = version ?? meta.currentVersion ?? meta.versions[meta.versions.length - 1];
    if (!targetVersion) {
      throw new Error(`No available version for skill: ${name}`);
    }
    if (!meta.versions.includes(targetVersion)) {
      throw new Error(`Version ${targetVersion} not found for skill: ${name}`);
    }

    const srcPath = path.join(this.marketDir, name, targetVersion, 'SKILL.md');
    if (!fsSync.existsSync(srcPath)) {
      throw new Error(`Source file not found: ${srcPath}`);
    }

    const destDir = path.join(this.installDir, name);
    const destPath = path.join(destDir, 'SKILL.md');
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(srcPath, destPath);

    // 写入安装信息
    const installMetaPath = path.join(destDir, '.installed.json');
    await fs.writeFile(
      installMetaPath,
      JSON.stringify({ name, version: targetVersion, installedAt: Date.now() }, null, 2),
      'utf-8',
    );

    logger.info('SkillMarketManager: installed', { name, version: targetVersion });
  }

  /**
   * 卸载
   */
  async uninstall(name: string): Promise<void> {
    const destDir = path.join(this.installDir, name);
    if (!fsSync.existsSync(destDir)) {
      logger.warn('SkillMarketManager.uninstall: not installed', { name });
      return;
    }
    await fs.rm(destDir, { recursive: true, force: true });
    logger.info('SkillMarketManager: uninstalled', { name });
  }

  /**
   * 导出为 zip
   *
   * 简化实现：将整个市场目录打包为单个 JSON 文件（包含所有版本）
   * 文件扩展名仍为 .zip 但内容为 JSON，便于跨平台测试
   */
  async export(name: string, outputPath: string): Promise<void> {
    const meta = await this.loadMetadata(name);
    const skillDir = path.join(this.marketDir, name);
    if (!fsSync.existsSync(skillDir)) {
      throw new Error(`Skill not found in market: ${name}`);
    }

    const versions: Record<string, string> = {};
    for (const v of meta.versions) {
      const skillFile = path.join(skillDir, v, 'SKILL.md');
      if (fsSync.existsSync(skillFile)) {
        versions[v] = await fs.readFile(skillFile, 'utf-8');
      }
    }

    const payload = {
      kind: 'routedev-skill-export',
      version: 1,
      name,
      metadata: meta,
      versions,
      exportedAt: Date.now(),
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf-8');

    logger.info('SkillMarketManager: exported', { name, outputPath });
  }

  /**
   * 导入 zip（实际为 JSON 导出文件）
   */
  async import(zipPath: string): Promise<MarketItem> {
    if (!fsSync.existsSync(zipPath)) {
      throw new Error(`Import file not found: ${zipPath}`);
    }

    const raw = await fs.readFile(zipPath, 'utf-8');
    let payload: {
      kind: string;
      name: string;
      metadata: MarketMetadataFile;
      versions: Record<string, string>;
    };
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid export file: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (payload.kind !== 'routedev-skill-export') {
      throw new Error(`Not a routedev skill export file: ${payload.kind}`);
    }

    const name = payload.name;
    const versions = payload.versions || {};
    const versionEntries = Object.entries(versions);
    if (versionEntries.length === 0) {
      throw new Error(`No versions in export file: ${zipPath}`);
    }

    // 写入所有版本
    for (const [v, content] of versionEntries) {
      const versionDir = path.join(this.marketDir, name, v);
      await fs.mkdir(versionDir, { recursive: true });
      await fs.writeFile(path.join(versionDir, 'SKILL.md'), content, 'utf-8');
    }

    // 合并 metadata
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
    const parsed: ParsedSkill = SkillMdParser.parse(versionEntries[0][1]);

    logger.info('SkillMarketManager: imported', { name, version: latestVersion });

    return {
      name,
      version: latestVersion,
      type: 'skill',
      status: 'published',
      draftPath: path.join(this.draftDir, name, 'SKILL.md'),
      publishedPath: path.join(this.marketDir, name, latestVersion, 'SKILL.md'),
      publishedAt: meta.publishedAt,
      changelog: meta.changelog,
      metadata: parsed.metadata,
    };
  }

  /**
   * 回滚到旧版本
   */
  async rollback(name: string, targetVersion: string): Promise<void> {
    const meta = await this.loadMetadata(name);
    if (!meta.versions.includes(targetVersion)) {
      throw new Error(`Version ${targetVersion} not found for skill: ${name}`);
    }

    const srcPath = path.join(this.marketDir, name, targetVersion, 'SKILL.md');
    if (!fsSync.existsSync(srcPath)) {
      throw new Error(`Source file not found: ${srcPath}`);
    }

    // 更新 currentVersion
    meta.currentVersion = targetVersion;
    meta.changelog.push(`rollback to v${targetVersion} at ${new Date().toISOString()}`);
    await this.saveMetadata(name, meta);

    // 同步到安装目录（如果已安装）
    const installMetaPath = path.join(this.installDir, name, '.installed.json');
    if (fsSync.existsSync(installMetaPath)) {
      await this.install(name, targetVersion);
    }

    logger.info('SkillMarketManager: rollback', { name, targetVersion });
  }

  /**
   * 获取版本列表
   */
  getVersions(name: string): string[] {
    const metaPath = path.join(this.marketDir, name, 'metadata.json');
    if (!fsSync.existsSync(metaPath)) return [];
    try {
      const raw = fsSync.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as MarketMetadataFile;
      return meta.versions || [];
    } catch {
      return [];
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 加载市场元数据（不存在时返回空骨架） */
  private async loadMetadata(name: string): Promise<MarketMetadataFile> {
    const metaPath = path.join(this.marketDir, name, 'metadata.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(raw) as MarketMetadataFile;
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return {
          name,
          type: 'skill',
          status: 'draft',
          changelog: [],
          versions: [],
        };
      }
      logger.warn('SkillMarketManager.loadMetadata: parse failed, reset', {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        name,
        type: 'skill',
        status: 'draft',
        changelog: [],
        versions: [],
      };
    }
  }

  /** 保存市场元数据 */
  private async saveMetadata(name: string, meta: MarketMetadataFile): Promise<void> {
    const metaPath = path.join(this.marketDir, name, 'metadata.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
