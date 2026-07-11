// src/plugins/packs/browser-web-pack.ts
// Phase 82 Task 3：Standard Pack —— 浏览器/Web 能力包
//
// 对应 docs/CAPABILITY_LAYERS.md 的 S-01 ~ S-03, S-19：
//   - web-search（src/tools/builtin/web-search.ts）
//   - web-fetch（src/tools/builtin/web-fetch.ts）
//   - browser（src/tools/builtin/browser.ts）
//   - VisionAssistant（src/agent/vision.ts）
//
// Pack 职责：
//   1. 记录 usage counter（pack:browser-web:load）
//   2. 确认相关工具在 ToolRegistry 中可达（full profile 下已由 app-init-tools 注册）
//   3. 不重复注册工具——Phase 81 门控已负责条件装配，Pack 仅做标记和 usage 记录

import type { CapabilityPack, PackContext } from '../capability-pack.js';

/**
 * 浏览器/Web 能力包
 *
 * 在 full profile 下 web-search / web-fetch / browser 工具已由 app-init-tools 注册，
 * Pack 的 register 主要做 usage 标记和可达性确认，不重复注册工具。
 */
export const browserWebPack: CapabilityPack = {
  id: 'pack.browser-web',
  configKey: 'browserWeb',
  layer: 'standard',
  description: '浏览器/Web：web-search + web-fetch + browser',
  costHint: '启用后网络搜索和网页抓取可用',
  defaultEnabled: false,

  /**
   * 注册 Pack 资源
   * 1. 记录 usage counter
   * 2. 确认 web-search / web-fetch / browser 工具可达（已由 app-init-tools 注册）
   * 3. 不修改 Phase 81 门控逻辑
   */
  async register(ctx: PackContext): Promise<void> {
    // 记录 Pack 加载事件，用于本地使用遥测
    ctx.usage.increment({ kind: 'pack', name: 'browser-web', action: 'load' });

    // 确认相关工具可达（full profile 下已注册，这里仅做存在性检查）
    const requiredTools = ['web_search', 'web_fetch', 'browser'];
    for (const toolName of requiredTools) {
      if (!ctx.tools.has(toolName)) {
        ctx.logger.warn(
          `[pack.browser-web] 工具 ${toolName} 未注册，browser-web Pack 可能无法正常工作`,
          { toolName },
        );
      }
    }

    ctx.logger.debug('[pack.browser-web] 注册完成', {
      toolsChecked: requiredTools,
    });
  },

  /**
   * 卸载 Pack：记录 unload 事件
   * 不注销工具——工具由 app-init-tools 统一管理，Pack 不拥有工具生命周期
   */
  async unregister(ctx: PackContext): Promise<void> {
    ctx.usage.increment({ kind: 'pack', name: 'browser-web', action: 'skip' });
    ctx.logger.debug('[pack.browser-web] 卸载完成');
  },
};
