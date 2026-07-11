// src/plugins/packs/code-map-pack.ts
// Phase 82 Task 3：Standard Pack —— 代码地图能力包
//
// 对应 docs/CAPABILITY_LAYERS.md 的 S-04 ~ S-07：
//   - code-graph-query（src/tools/builtin/code-graph-query.ts）
//   - repo-map（src/tools/builtin/repo-map.ts）
//   - CodeMapEngine + Watcher + Fallback（src/code-map/indexer.ts, watcher.ts, fallback.ts）
//   - CodeMapContextMiddleware（src/agent/middleware/code-map-context.ts）
//
// Pack 职责：
//   1. 记录 usage counter（pack:code-map:load）
//   2. 确认 code-map 相关工具/引擎可达
//   3. 不重复注册工具——Phase 81 门控已负责条件装配

import type { CapabilityPack, PackContext } from '../capability-pack.js';

/**
 * 代码地图能力包
 *
 * code-graph-query / repo-map 工具和 CodeMapEngine 在 full profile 下已由
 * app-init-tools / app-init-agent 注册，Pack 的 register 主要做 usage 标记和可达性确认。
 */
export const codeMapPack: CapabilityPack = {
  id: 'pack.code-map',
  configKey: 'codeMap',
  layer: 'standard',
  description: '代码地图：code-graph-query + repo-map + CodeMapEngine',
  costHint: '启用后代码结构查询可用，首次索引耗时 ~10s',
  defaultEnabled: false,

  /**
   * 注册 Pack 资源
   * 1. 记录 usage counter
   * 2. 确认 code-graph-query / repo-map 工具可达
   * 3. 不修改 Phase 81 门控逻辑
   */
  async register(ctx: PackContext): Promise<void> {
    // 记录 Pack 加载事件
    ctx.usage.increment({ kind: 'pack', name: 'code-map', action: 'load' });

    // 确认 code-map 相关工具可达（已由 app-init-tools 注册）
    const requiredTools = ['code_graph_query', 'repo_map'];
    for (const toolName of requiredTools) {
      if (!ctx.tools.has(toolName)) {
        ctx.logger.warn(
          `[pack.code-map] 工具 ${toolName} 未注册，code-map Pack 可能无法正常工作`,
          { toolName },
        );
      }
    }

    ctx.logger.debug('[pack.code-map] 注册完成', {
      toolsChecked: requiredTools,
    });
  },

  /**
   * 卸载 Pack：记录 unload 事件
   * 不注销工具——工具和引擎由 app-init-* 统一管理
   */
  async unregister(ctx: PackContext): Promise<void> {
    ctx.usage.increment({ kind: 'pack', name: 'code-map', action: 'skip' });
    ctx.logger.debug('[pack.code-map] 卸载完成');
  },
};
