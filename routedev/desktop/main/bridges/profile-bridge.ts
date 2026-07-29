// desktop/main/bridges/profile-bridge.ts
// Agent Profile 领域 delegate：负责 Profile CRUD 与版本管理（list/diff/rollback）
// G-022a：从 engine-bridge.ts 拆分。原 RouteDevEngine 的 listProfiles/getProfile/saveProfile/
// deleteProfile/duplicateProfile/importProfile 及版本相关方法委托至此。
//
// 设计要点：
//   1. 委托给 ctx.profileManager（AgentProfileManager 实例，懒加载于 EngineContext.initialize）
//   2. 版本相关方法委托给 ctx.profileManager.getVersionManager()
//   3. fail-open：profileManager 未就绪或底层异常时返回空数组/null/失败结果，不抛出
//   4. listProfiles 把 AgentProfile 映射为 AgentProfileSummary（剥离 systemPrompt）

import { logger } from '../../../src/utils/logger.js';
import type {
  AgentProfileDetail,
  AgentProfileSummary,
  ProfileOpResult,
  ProfileSavePayload,
  VersionMeta,
  VersionRecord,
  FieldDiff,
} from '../../shared/ipc-types.js';
import type { AgentProfile } from '../../../src/agents/profiles/types.js';
import type { AgentProfileManager } from '../../../src/agents/profiles/manager.js';
import type { EngineContext } from './engine-context.js';

/**
 * Agent Profile 领域桥接器
 *
 * 通过 ctx.profileManager 完成实际 CRUD，所有方法 fail-open：
 * profileManager 未初始化或异常时返回安全默认值，不向 IPC 调用方抛错。
 */
export class ProfileBridge {
  constructor(private ctx: EngineContext) {}

  /** 获取 profileManager（未初始化时返回 null） */
  private manager(): AgentProfileManager | null {
    return this.ctx.profileManager;
  }

  /** AgentProfile → AgentProfileSummary（剥离 systemPrompt） */
  private toSummary(profile: AgentProfile): AgentProfileSummary {
    return {
      id: profile.id,
      name: profile.name,
      type: profile.type,
      version: profile.version,
      role: profile.role,
      modelId: profile.modelId,
      description: profile.description,
      allowedTools: profile.allowedTools,
      forbiddenTools: profile.forbiddenTools,
      boundSkills: profile.boundSkills,
      canChallenge: profile.canChallenge,
      challengeSeverity: profile.challengeSeverity,
      outputFormat: profile.outputFormat,
      maxTokens: profile.maxTokens,
      maxSteps: profile.maxSteps,
      isBuiltin: profile.isBuiltin,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  /** 列出所有 Profile（不含 systemPrompt） */
  async listProfiles(): Promise<AgentProfileSummary[]> {
    const manager = this.manager();
    if (!manager) {
      logger.warn('[ProfileBridge] listProfiles: profileManager 未初始化');
      return [];
    }
    try {
      const profiles = await manager.listProfiles();
      return profiles.map((p) => this.toSummary(p));
    } catch (err) {
      logger.warn('[ProfileBridge] listProfiles failed', { err });
      return [];
    }
  }

  /** 获取指定 Profile 详情（含 systemPrompt） */
  async getProfile(id: string): Promise<AgentProfileDetail | null> {
    if (!id) return null;
    const manager = this.manager();
    if (!manager) {
      logger.warn('[ProfileBridge] getProfile: profileManager 未初始化');
      return null;
    }
    try {
      return await manager.getProfile(id);
    } catch (err) {
      logger.warn('[ProfileBridge] getProfile failed', { id, err });
      return null;
    }
  }

  /** 保存 Profile（新增/更新）—— 来自 UI 的保存记为 user_edit */
  async saveProfile(payload: ProfileSavePayload): Promise<ProfileOpResult> {
    const manager = this.manager();
    if (!manager) {
      return { success: false, error: 'profileManager 未初始化' };
    }
    try {
      // ProfileSavePayload === AgentProfileDetail === AgentProfile（type alias）
      // UI 保存走 user_edit，程序写入请直接调用 manager.saveProfile(..., source)
      await manager.saveProfile(payload, 'user_edit');
      return { success: true, id: payload.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, id: payload?.id, error };
    }
  }

  /** 删除 Profile（内置 Profile 不可删除，manager 会抛错） */
  async deleteProfile(id: string): Promise<ProfileOpResult> {
    const manager = this.manager();
    if (!manager) {
      return { success: false, error: 'profileManager 未初始化' };
    }
    try {
      await manager.deleteProfile(id);
      return { success: true, id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, id, error };
    }
  }

  /** 复制 Profile 为自定义副本（需传入新名称） */
  async duplicateProfile(sourceId: string, newName: string): Promise<ProfileOpResult> {
    const manager = this.manager();
    if (!manager) {
      return { success: false, error: 'profileManager 未初始化' };
    }
    try {
      const copy = await manager.duplicateProfile(sourceId, newName);
      return { success: true, id: copy.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }

  /** 从 SKILL.md 文件导入 Profile（自动分配新 id 避免冲突） */
  async importProfile(inputPath: string): Promise<ProfileOpResult> {
    const manager = this.manager();
    if (!manager) {
      return { success: false, error: 'profileManager 未初始化' };
    }
    try {
      const imported = await manager.importProfile(inputPath);
      return { success: true, id: imported.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }

  // ============================================================
  // 版本管理委托（VersionManager）
  // ============================================================

  /** 列出指定 Profile 的所有版本元数据（按时间倒序） */
  async listVersions(profileId: string): Promise<VersionMeta[]> {
    if (!profileId) return [];
    const manager = this.manager();
    if (!manager) {
      logger.warn('[ProfileBridge] listVersions: profileManager 未初始化');
      return [];
    }
    try {
      return await manager.getVersionManager().listVersions(profileId);
    } catch (err) {
      logger.warn('[ProfileBridge] listVersions failed', { profileId, err });
      return [];
    }
  }

  /** 获取指定版本完整记录（含 snapshot） */
  async getVersion(profileId: string, versionId: string): Promise<VersionRecord | null> {
    if (!profileId || !versionId) return null;
    const manager = this.manager();
    if (!manager) {
      logger.warn('[ProfileBridge] getVersion: profileManager 未初始化');
      return null;
    }
    try {
      // loadVersion 在版本不存在时抛错，这里转换为 null（fail-open）
      return await manager.getVersionManager().loadVersion(profileId, versionId);
    } catch (err) {
      logger.warn('[ProfileBridge] getVersion failed', { profileId, versionId, err });
      return null;
    }
  }

  /** 回滚到指定版本 */
  async rollbackProfile(profileId: string, versionId: string): Promise<ProfileOpResult> {
    const manager = this.manager();
    if (!manager) {
      return { success: false, error: 'profileManager 未初始化' };
    }
    try {
      // manager.rollback 内部会调用 saveProfile(source='rollback')，自动写新版本快照
      await manager.rollback(profileId, versionId);
      return { success: true, id: profileId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, id: profileId, error };
    }
  }

  /** 比较两个版本的字段差异 */
  async diffVersions(
    profileId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<FieldDiff[]> {
    if (!profileId || !fromVersionId || !toVersionId) return [];
    const manager = this.manager();
    if (!manager) {
      logger.warn('[ProfileBridge] diffVersions: profileManager 未初始化');
      return [];
    }
    try {
      return await manager.getVersionManager().diffVersions(profileId, fromVersionId, toVersionId);
    } catch (err) {
      logger.warn('[ProfileBridge] diffVersions failed', { profileId, fromVersionId, toVersionId, err });
      return [];
    }
  }

  /** 比较当前 Profile 与指定历史版本的字段差异 */
  async diffCurrentWith(profileId: string, targetVersionId: string): Promise<FieldDiff[]> {
    if (!profileId || !targetVersionId) return [];
    const manager = this.manager();
    if (!manager) {
      logger.warn('[ProfileBridge] diffCurrentWith: profileManager 未初始化');
      return [];
    }
    try {
      const current = await manager.getProfile(profileId);
      if (!current) {
        logger.warn('[ProfileBridge] diffCurrentWith: profile 不存在', { profileId });
        return [];
      }
      return await manager
        .getVersionManager()
        .diffCurrentWith(profileId, current, targetVersionId);
    } catch (err) {
      logger.warn('[ProfileBridge] diffCurrentWith failed', { profileId, targetVersionId, err });
      return [];
    }
  }
}
