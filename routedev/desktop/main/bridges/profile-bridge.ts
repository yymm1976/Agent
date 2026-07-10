// desktop/main/bridges/profile-bridge.ts
// Profile 领域 delegate：负责 AgentProfile 的 CRUD 操作
// G-022a：从 engine-bridge.ts 拆分。原 RouteDevEngine 的 listProfiles/getProfile/
// saveProfile/deleteProfile/duplicateProfile 及私有辅助方法委托至此。
// 内部使用 AgentProfileManager（在 RouteDevEngine.initialize() 中创建并挂载到 ctx.profileManager）。

import type { AgentProfile } from '../../../src/agents/profiles/types.js';
import type {
  AgentProfileInfo,
  AgentProfileDetail,
  ProfileSavePayload,
  ProfileOpResult,
} from '../../shared/ipc-types.js';
import type { EngineContext } from './engine-context.js';

/**
 * Profile 领域桥接器
 *
 * 提供 AgentProfile 的列表/详情/保存/删除/复制操作。
 * ProfileManager 实例由 RouteDevEngine 在 initialize() 中创建并挂载到 ctx.profileManager，
 * 此 bridge 通过 ctx 引用访问，fail-open：未初始化时返回空数组/null/失败结果。
 */
export class ProfileBridge {
  constructor(private ctx: EngineContext) {}

  /** AgentProfile -> AgentProfileInfo（剥离 systemPrompt，列表传输用） */
  private toProfileInfo(profile: AgentProfile): AgentProfileInfo {
    // 显式列出字段，避免 systemPrompt 进入选型后造成 IPC 大对象传输
    return {
      id: profile.id,
      name: profile.name,
      type: 'agent-profile',
      version: profile.version,
      role: profile.role,
      modelId: profile.modelId,
      description: profile.description,
      allowedTools: profile.allowedTools,
      forbiddenTools: profile.forbiddenTools,
      canChallenge: profile.canChallenge,
      challengeSeverity: profile.challengeSeverity,
      outputFormat: profile.outputFormat,
      boundSkills: profile.boundSkills,
      maxTokens: profile.maxTokens,
      maxSteps: profile.maxSteps,
      isBuiltin: profile.isBuiltin,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  /** AgentProfile -> AgentProfileDetail（含完整字段） */
  private toProfileDetail(profile: AgentProfile): AgentProfileDetail {
    // TD-01：AgentProfileRole/AgentProfileOutputFormat 已统一为 AgentRole/AgentOutputFormat 别名，
    // 不再需要显式断言（IPC 侧与 src 侧类型同源）
    return {
      ...profile,
    };
  }

  /** ProfileSavePayload -> AgentProfile（IPC 字段透传，类型已与 src 一致） */
  private fromSavePayload(payload: ProfileSavePayload): AgentProfile {
    return { ...payload };
  }

  /** 列出所有 Profile（不含 systemPrompt） */
  async listProfiles(): Promise<AgentProfileInfo[]> {
    if (!this.ctx.profileManager) return [];
    try {
      const profiles = await this.ctx.profileManager.listProfiles();
      return profiles.map((p) => this.toProfileInfo(p));
    } catch (err) {
      console.error('[Engine] listProfiles failed:', err);
      return [];
    }
  }

  /** 获取指定 Profile 详情（含 systemPrompt） */
  async getProfile(id: string): Promise<AgentProfileDetail | null> {
    if (!this.ctx.profileManager) return null;
    try {
      const profile = await this.ctx.profileManager.getProfile(id);
      return profile ? this.toProfileDetail(profile) : null;
    } catch (err) {
      console.error('[Engine] getProfile failed:', err);
      return null;
    }
  }

  /** 保存 Profile（新增/更新） */
  async saveProfile(payload: ProfileSavePayload): Promise<ProfileOpResult> {
    if (!this.ctx.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      const profile = this.fromSavePayload(payload);
      await this.ctx.profileManager.saveProfile(profile);
      return { success: true, id: profile.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 删除 Profile（内置 Profile 不可删除，manager 会抛错） */
  async deleteProfile(id: string): Promise<ProfileOpResult> {
    if (!this.ctx.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      await this.ctx.profileManager.deleteProfile(id);
      return { success: true, id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 复制 Profile 为自定义副本（需传入新名称） */
  async duplicateProfile(id: string, newName: string): Promise<ProfileOpResult> {
    if (!this.ctx.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      const copy = await this.ctx.profileManager.duplicateProfile(id, newName);
      return { success: true, id: copy.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
