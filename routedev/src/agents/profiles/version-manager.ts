/**
 * AgentProfile 版本管理器
 * 负责版本快照的保存、列表、加载、diff、回滚与保留策略
 *
 * 存储路径：
 *   ${rootDir}/.routedev/skills/agents/<profileId>/versions/<versionId>.json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentProfile } from './types.js';
import type { VersionMeta, VersionRecord, VersionSource, FieldChange, FieldDiff } from './version-types.js';

/** 每个 Profile 最多保留版本数 */
const MAX_VERSIONS_PER_PROFILE = 20;

/** 参与 diff / fieldChanges 的字段 */
const DIFF_FIELDS: (keyof AgentProfile)[] = [
  'name',
  'description',
  'systemPrompt',
  'modelId',
  'version',
  'role',
  'allowedTools',
  'forbiddenTools',
  'boundSkills',
  'maxTokens',
  'maxSteps',
  'canChallenge',
  'challengeSeverity',
  'outputFormat',
];

/** 磁盘上的持久化格式（与 VersionRecord 同构，便于兼容） */
interface PersistedVersion {
  meta: VersionMeta;
  snapshot: AgentProfile;
}

export class VersionManager {
  constructor(private rootDir: string) {}

  /** 获取某 Profile 的 versions 目录 */
  private versionsDir(profileId: string): string {
    return join(this.rootDir, '.routedev', 'skills', 'agents', profileId, 'versions');
  }

  private versionPath(profileId: string, versionId: string): string {
    return join(this.versionsDir(profileId), `${versionId}.json`);
  }

  private ensureDir(profileId: string): void {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private generateVersionId(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = randomBytes(4).toString('hex');
    return `${ts}-${rand}`;
  }

  /**
   * 计算相对前一快照的字段变更
   */
  private computeFieldChanges(
    previous: AgentProfile | undefined,
    current: AgentProfile,
  ): FieldChange[] {
    if (!previous) return [];
    const changes: FieldChange[] = [];
    for (const field of DIFF_FIELDS) {
      const before = previous[field];
      const after = current[field];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ field, before, after });
      }
    }
    return changes;
  }

  /**
   * 生成人类可读变更摘要
   */
  private buildChangeSummary(fieldChanges: FieldChange[]): string {
    if (fieldChanges.length === 0) return '';
    return fieldChanges
      .map((c) => {
        if (typeof c.before === 'string' || typeof c.after === 'string' || typeof c.before === 'number' || typeof c.after === 'number') {
          return `${c.field}: ${String(c.before)} → ${String(c.after)}`;
        }
        return `${c.field} changed`;
      })
      .join('; ');
  }

  /**
   * 保存当前 profile 为新版本快照
   * @returns versionId
   */
  async saveVersion(
    profile: AgentProfile,
    source: VersionSource,
    previousSnapshot?: AgentProfile,
  ): Promise<string> {
    this.ensureDir(profile.id);
    const versionId = this.generateVersionId();
    const timestamp = Date.now();
    const fieldChanges = this.computeFieldChanges(previousSnapshot, profile);
    const changeSummary = this.buildChangeSummary(fieldChanges);

    const meta: VersionMeta = {
      versionId,
      profileId: profile.id,
      timestamp,
      source,
      fieldChanges,
      changeSummary,
    };

    const record: PersistedVersion = {
      meta,
      snapshot: structuredClone(profile),
    };

    writeFileSync(
      this.versionPath(profile.id, versionId),
      JSON.stringify(record, null, 2),
      'utf-8',
    );

    this.enforceRetention(profile.id);
    return versionId;
  }

  /**
   * 列出某 Profile 的所有版本元数据（按时间倒序，最新在前）
   */
  async listVersions(profileId: string): Promise<VersionMeta[]> {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const metas: VersionMeta[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const record = JSON.parse(raw) as PersistedVersion;
        if (record?.meta) {
          metas.push(record.meta);
        }
      } catch {
        // skip corrupt files
      }
    }

    return metas.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 加载指定版本的完整记录（含 snapshot）
   * @throws 版本不存在时抛错
   */
  async loadVersion(profileId: string, versionId: string): Promise<VersionRecord> {
    const path = this.versionPath(profileId, versionId);
    if (!existsSync(path)) {
      throw new Error(`Version not found: ${profileId}/${versionId}`);
    }
    try {
      const raw = readFileSync(path, 'utf-8');
      const record = JSON.parse(raw) as PersistedVersion;
      if (!record?.meta || !record?.snapshot) {
        throw new Error(`Corrupt version record: ${profileId}/${versionId}`);
      }
      return { meta: record.meta, snapshot: record.snapshot };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Version not found')) throw err;
      if (err instanceof Error && err.message.startsWith('Corrupt')) throw err;
      throw new Error(`Failed to load version ${profileId}/${versionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 比较两个版本的字段差异
   */
  async diffVersions(
    profileId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<FieldDiff[]> {
    const from = await this.loadVersion(profileId, fromVersionId);
    const to = await this.loadVersion(profileId, toVersionId);
    return this.diffProfiles(from.snapshot, to.snapshot);
  }

  /**
   * 比较当前 Profile 与指定历史版本的字段差异
   * @param currentProfile 当前内存中的 Profile
   * @param targetVersionId 目标历史版本 ID
   */
  async diffCurrentWith(
    profileId: string,
    currentProfile: AgentProfile,
    targetVersionId: string,
  ): Promise<FieldDiff[]> {
    const target = await this.loadVersion(profileId, targetVersionId);
    return this.diffProfiles(target.snapshot, currentProfile);
  }

  /**
   * 字段级 diff
   */
  diffProfiles(before: AgentProfile, after: AgentProfile): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    for (const field of DIFF_FIELDS) {
      const b = before[field];
      const a = after[field];
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        diffs.push({ field, before: b, after: a });
      }
    }
    return diffs;
  }

  /**
   * 回滚到指定版本，返回该版本的 profile 快照
   * @throws 版本不存在时抛错
   */
  async rollbackTo(profileId: string, versionId: string): Promise<AgentProfile> {
    const record = await this.loadVersion(profileId, versionId);
    return structuredClone(record.snapshot);
  }

  /**
   * 删除某 Profile 的全部版本目录
   */
  async deleteAllVersions(profileId: string): Promise<void> {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  /**
   * 保留策略：超过 MAX_VERSIONS_PER_PROFILE 时删除最旧的
   */
  enforceRetention(profileId: string): void {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return;

    // 同步列出（enforce 常在 save 后调用）
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const metas: VersionMeta[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const record = JSON.parse(raw) as PersistedVersion;
        if (record?.meta) metas.push(record.meta);
      } catch {
        // skip
      }
    }
    metas.sort((a, b) => b.timestamp - a.timestamp);

    if (metas.length <= MAX_VERSIONS_PER_PROFILE) return;

    const toDelete = metas.slice(MAX_VERSIONS_PER_PROFILE);
    for (const v of toDelete) {
      try {
        const p = this.versionPath(profileId, v.versionId);
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }

  /** 获取最大保留数（供测试） */
  static get maxVersionsPerProfile(): number {
    return MAX_VERSIONS_PER_PROFILE;
  }
}
