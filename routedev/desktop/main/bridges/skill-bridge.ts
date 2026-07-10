// desktop/main/bridges/skill-bridge.ts
// Skill 领域 delegate：负责 Skill 列表/预览/启停/创建/删除/安装/重载/路由
// 原 RouteDevEngine.listSkills / previewSkill / toggleSkill / createSkill / deleteSkill /
// installSkill / reloadSkills / routeSkills 及私有 createSecurityGateFromConfig /
// createIntegrityManifestFromConfig 委托至此。

import path from 'node:path';
import type { SkillInstallPayload } from '../../shared/ipc-types.js';
import { SkillMarketManager } from '../../../src/skills/market-manager.js';
// Phase 53 Task 6：安装前安全门控（仅类型，运行时按需动态 import）
import type { SkillSecurityGate } from '../../../src/skills/security-gate.js';
import type { EngineContext, SkillInfo, SkillPreview } from './engine-context.js';

/**
 * Skill 领域桥接器
 *
 * 通过 ctx.deps.skillsRouter / ctx.deps.filesystemDiscovery 管理 Skill 注册与文件系统操作。
 * installSkill 复用 SkillMarketManager（与 app-init.ts 一致的安全门控 + 完整性校验配置守护）。
 */
export class SkillBridge {
  constructor(private ctx: EngineContext) {}

  /** 列出所有 Skill（含启用/禁用状态，不含 content） */
  listSkills(): SkillInfo[] {
    if (!this.ctx.deps) return [];
    return this.ctx.deps.skillsRouter.listStatuses().map((s) => ({
      name: s.name,
      description: s.description,
      routingKeywords: s.routingKeywords,
      enabled: s.enabled,
      sourcePath: s.sourcePath,
    }));
  }

  /** 预览指定 Skill（含完整 content） */
  previewSkill(name: string): SkillPreview | null {
    if (!this.ctx.deps) return null;
    const status = this.ctx.deps.skillsRouter.listStatuses().find((s) => s.name === name);
    if (!status) return null;
    return {
      name: status.name,
      description: status.description,
      routingKeywords: status.routingKeywords,
      enabled: status.enabled,
      sourcePath: status.sourcePath,
      content: status.content,
    };
  }

  /** 启用/禁用 Skill */
  toggleSkill(name: string, enabled: boolean): boolean {
    if (!this.ctx.deps) return false;
    return this.ctx.deps.skillsRouter.setEnabled(name, enabled);
  }

  /** 创建新 Skill（写入 .routedev/skills/<name>/SKILL.md） */
  async createSkill(
    name: string,
    description: string,
    keywords: string[],
    content: string,
  ): Promise<{ success: boolean; error?: string; path?: string }> {
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };
    try {
      const skillPath = await this.ctx.deps.filesystemDiscovery.createSkill(name, description, keywords, content);
      // 重新发现并注册
      const skills = await this.ctx.deps.filesystemDiscovery.discoverSkills();
      this.ctx.deps.skillsRouter.unregister(name);
      const newSkill = skills.find((s) => s.name === name);
      if (newSkill) {
        this.ctx.deps.skillsRouter.register(newSkill);
      }
      return { success: true, path: skillPath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 从市场安装 Skill
   * 1. 调用 SkillMarketManager.install 把 market/<name>/<version>/SKILL.md 拷贝到 .routedev/skills/<name>/SKILL.md
   * 2. 通过 filesystemDiscovery 重新发现并注册到 skillsRouter
   * 失败时返回 { success: false, error }
   */
  async installSkill(payload: SkillInstallPayload): Promise<{ success: boolean; error?: string; path?: string }> {
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };
    try {
      // Phase 53 Task 6：安装前注入安全门控（未启用时 undefined，SkillMarketManager fail-open 跳过）
      const securityGate = await this.createSecurityGateFromConfig();
      // Phase 71 Task 2：注入完整性校验清单（未启用时 undefined，SkillMarketManager fail-open 跳过）
      const integrityManifest = await this.createIntegrityManifestFromConfig() as
        import('../../../src/security/integrity-manifest.js').IntegrityManifest | undefined;
      const marketManager = new SkillMarketManager(
        this.ctx.options.cwd,
        securityGate,
        integrityManifest,
      );
      await marketManager.install(payload.name, payload.version);

      // Phase 71 Task 2：安装后校验完整性（record 已在 install 内完成，此处做一次 verify 确认）
      if (integrityManifest) {
        try {
          await marketManager.verifyInstalled(payload.name);
        } catch {
          // verify 失败已在 marketManager 内部 logger.warn，此处不阻断流程（integrityStrict=false 时）
        }
      }

      // 重新发现并注册（与 createSkill 后处理一致，避免重启引擎才生效）
      const skills = await this.ctx.deps.filesystemDiscovery.discoverSkills();
      this.ctx.deps.skillsRouter.unregister(payload.name);
      const newSkill = skills.find((s) => s.name === payload.name);
      if (newSkill) {
        this.ctx.deps.skillsRouter.register(newSkill);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Phase 53 Task 6：根据配置创建技能安全门控
   *
   * - config.phase53Integration.skillSecurityGate.enabled=true → 创建门控实例
   * - 未启用或模块不可用 → 返回 undefined（SkillMarketManager fail-open 跳过 scan）
   *
   * 与 app-init.ts 保持一致的 config 守护与动态 import 模式，避免未启用时加载模块。
   */
  private async createSecurityGateFromConfig(): Promise<SkillSecurityGate | undefined> {
    const cfg = this.ctx.config.phase53Integration?.skillSecurityGate;
    if (!cfg?.enabled) return undefined;
    try {
      const mod = await import('../../../src/skills/security-gate.js');
      return new mod.SkillSecurityGate({ autoInstallThreshold: cfg.autoInstallThreshold });
    } catch (err) {
      // fail-open：模块不可用时不阻塞安装
      console.warn('SkillSecurityGate module not available, install will skip scan', err);
      return undefined;
    }
  }

  /**
   * Phase 71 Task 2：根据配置创建 IntegrityManifest
   *
   * - config.security.integrityCheck=true → 创建 manifest 实例，用于 skill 安装/加载时校验 SHA-256
   * - 未启用或模块不可用 → 返回 undefined（SkillMarketManager fail-open 跳过校验）
   *
   * 与 app-init.ts 保持一致的 config 守护与动态 import 模式。
   */
  private async createIntegrityManifestFromConfig(): Promise<import('../../../src/security/integrity-manifest.js').IntegrityManifest | undefined> {
    const cfg = this.ctx.config.security;
    if (!cfg?.integrityCheck) return undefined;
    try {
      const mod = await import('../../../src/security/integrity-manifest.js');
      const manifestPath = cfg.integrityManifestPath
        ? path.resolve(this.ctx.options.cwd, cfg.integrityManifestPath)
        : path.join(this.ctx.options.cwd, '.routedev', 'integrity-manifest.json');
      const manifest = new mod.IntegrityManifest(manifestPath);
      await manifest.load();
      return manifest;
    } catch (err) {
      // fail-open：模块不可用时不阻塞安装
      console.warn('IntegrityManifest module not available, install will skip checksum', err);
      return undefined;
    }
  }

  /** 删除 Skill */
  async deleteSkill(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };
    try {
      const ok = await this.ctx.deps.filesystemDiscovery.deleteSkill(name);
      if (ok) {
        this.ctx.deps.skillsRouter.unregister(name);
        return { success: true };
      }
      return { success: false, error: '删除失败' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 重新发现 Skill（从文件系统重新加载） */
  async reloadSkills(): Promise<{ count: number }> {
    if (!this.ctx.deps) return { count: 0 };
    const skills = await this.ctx.deps.filesystemDiscovery.discoverSkills();
    // 清除旧注册（保留启用/禁用状态，因为 SkillsRouter 持久化了 disabledSkills）
    const oldNames = this.ctx.deps.skillsRouter.list().map((s) => s.name);
    for (const name of oldNames) {
      this.ctx.deps.skillsRouter.unregister(name);
    }
    for (const skill of skills) {
      this.ctx.deps.skillsRouter.register(skill);
    }
    return { count: skills.length };
  }

  /** 根据任务描述测试 Skill 路由匹配 */
  routeSkills(taskDescription: string): SkillInfo[] {
    if (!this.ctx.deps) return [];
    return this.ctx.deps.skillsRouter.route(taskDescription, 5).map((s) => ({
      name: s.name,
      description: s.description,
      routingKeywords: s.routingKeywords,
      enabled: true,
      sourcePath: s.sourcePath,
    }));
  }
}
