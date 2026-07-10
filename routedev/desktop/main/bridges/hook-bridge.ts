// desktop/main/bridges/hook-bridge.ts
// Hook 领域 delegate：负责 Hook 配置的 CRUD 操作与安全扫描
// G-022a：从 engine-bridge.ts 拆分。原 RouteDevEngine 的 listHooks/toggleHook/
// createHook/deleteHook/listHookTemplates 及私有辅助方法 resolveHookConfigPath 委托至此。
// 安全：所有 Hook 命令经 checkBashSecurity 扫描；configPath 越界校验拒绝路径穿越。

import path from 'node:path';
import { HookConfigRegistry } from '../../../src/hooks/registry.js';
import type { HookConfig } from '../../../src/hooks/registry.js';
import { getHookTemplates, getHookTemplateById } from '../../../src/hooks/templates.js';
import type { HookTemplate } from '../../../src/hooks/templates.js';
// C3 修复：Hook 命令安全扫描
import { checkBashSecurity } from '../../../src/tools/security-enhanced.js';
import type { EngineContext } from './engine-context.js';

/**
 * Hook 领域桥接器
 *
 * 提供 Hook 配置的列表/切换/创建/删除操作，以及内置模板列表。
 * fail-open：底层模块调用失败时返回默认值，不抛异常。
 * 安全：configPath 越界校验 + 命令 bash 安全扫描。
 */
export class HookBridge {
  constructor(private ctx: EngineContext) {}

  /**
   * 统一解析 Hook 配置文件路径并执行边界校验
   * 安全：拒绝绝对路径 + resolve 后必须 startsWith cwd，防止路径穿越
   * @returns 校验通过的绝对路径；校验失败返回 null
   */
  private resolveHookConfigPath(): string | null {
    const rawConfigPath = this.ctx.config.hooks?.configPath ?? '.routedev/hooks.json';
    if (path.isAbsolute(rawConfigPath)) {
      return null;
    }
    const resolvedConfigPath = path.resolve(this.ctx.options.cwd, rawConfigPath);
    const cwdResolved = path.resolve(this.ctx.options.cwd);
    if (!resolvedConfigPath.startsWith(cwdResolved + path.sep) && resolvedConfigPath !== cwdResolved) {
      return null;
    }
    return resolvedConfigPath;
  }

  /** 列出所有 Hook 配置 */
  async listHooks(): Promise<unknown[]> {
    try {
      const configPath = this.resolveHookConfigPath();
      if (!configPath) return [];
      const registry = new HookConfigRegistry(configPath);
      await registry.load();
      return registry.list();
    } catch {
      return [];
    }
  }

  /** 启用/禁用 Hook */
  async toggleHook(
    id: string,
    enabled: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const configPath = this.resolveHookConfigPath();
      if (!configPath) return { success: false, error: 'hooks.configPath 越界：必须在项目目录内' };
      const registry = new HookConfigRegistry(configPath);
      await registry.load();
      const ok = registry.toggle(id, enabled);
      if (!ok) return { success: false, error: `未找到 Hook "${id}"` };
      await registry.save();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 创建新 Hook（模板模式 / 自定义模式）
   *
   * 替代已移除的 HookGenerator（LLM 生成模式），改为：
   *   - 模板模式：传入 templateId，从内置模板库复制创建
   *   - 自定义模式：传入 name + event + code（shell 命令），直接保存
   *
   * @param payload
   *   - 模板模式：{ templateId: string }
   *   - 自定义模式：{ name: string, event: HookEvent, code: string, description?, priority?, condition?, failBehavior? }
   *   - 兼容旧调用：传入 string 时视为描述，但缺少 code 无法创建（返回错误提示）
   *
   * @returns 创建结果，成功时返回 hookId
   */
  async createHook(
    payload: { templateId: string } | {
      name: string;
      event: string;
      code: string;
      description?: string;
      priority?: number;
      condition?: { toolName?: string; filePattern?: string };
      failBehavior?: 'warn' | 'block' | 'silent';
    },
  ): Promise<{ success: boolean; hookId?: string; error?: string }> {
    try {
      // C4 修复：hooks.configPath 路径越界校验（统一复用 resolveHookConfigPath）
      const configPath = this.resolveHookConfigPath();
      if (!configPath) {
        return { success: false, error: 'hooks.configPath 越界：必须在项目目录内' };
      }
      const registry = new HookConfigRegistry(configPath);
      await registry.load();

      let config: HookConfig;

      // 模板模式：从内置模板复制
      if (typeof payload === 'object' && payload !== null && 'templateId' in payload) {
        const template = getHookTemplateById(payload.templateId);
        if (!template) {
          return { success: false, error: `未找到模板 "${payload.templateId}"` };
        }
        // G-021 修复：模板命令也需经过 bash 安全扫描，防止内置模板被篡改后注入危险命令
        const templateBashResult = checkBashSecurity(template.code);
        if (!templateBashResult.allowed) {
          return { success: false, error: '模板命令被安全策略拒绝' };
        }
        // 生成唯一 ID：模板 id + 时间戳后缀，避免重复创建时 ID 冲突
        const hookId = `${template.id}-${Date.now()}`;
        config = {
          id: hookId,
          name: template.name,
          event: template.event,
          enabled: template.enabled,
          condition: template.condition,
          command: template.code,
          failBehavior: template.failBehavior,
          isTemplate: true,
        };
      } else if (
        typeof payload === 'object' &&
        payload !== null &&
        'name' in payload &&
        'event' in payload &&
        'code' in payload
      ) {
        // 自定义模式：C3 修复——创建前强制安全扫描，拒绝危险命令
        const p = payload as {
          name: string;
          event: string;
          code: string;
          description?: string;
          priority?: number;
          condition?: { toolName?: string; filePattern?: string };
          failBehavior?: 'warn' | 'block' | 'silent';
        };
        const bashResult = checkBashSecurity(p.code);
        if (!bashResult.allowed) {
          return { success: false, error: `Hook 命令被安全策略拒绝：${bashResult.reason}` };
        }
        const hookId = `custom-${Date.now()}`;
        config = {
          id: hookId,
          name: p.name,
          event: p.event as HookConfig['event'],
          enabled: true,
          condition: p.condition,
          command: p.code,
          failBehavior: p.failBehavior ?? 'warn',
          isTemplate: false,
        };
      } else {
        return {
          success: false,
          error: '参数错误：需提供 templateId 或 { name, event, code }',
        };
      }

      registry.add(config);
      await registry.save();
      return { success: true, hookId: config.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 列出所有内置 Hook 模板（供 UI 选择） */
  listHookTemplates(): HookTemplate[] {
    return getHookTemplates();
  }

  /** 删除自定义 Hook */
  async deleteHook(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const configPath = this.resolveHookConfigPath();
      if (!configPath) return { success: false, error: 'hooks.configPath 越界：必须在项目目录内' };
      const registry = new HookConfigRegistry(configPath);
      await registry.load();
      const ok = registry.remove(id);
      if (!ok) return { success: false, error: `未找到 Hook "${id}"` };
      await registry.save();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
