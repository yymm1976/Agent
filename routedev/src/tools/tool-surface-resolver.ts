// src/tools/tool-surface-resolver.ts
// B-01A：模型可见工具面解析器（纯函数，无副作用）
//
// 目标：区分"工具已注册"和"当前模型应看到"。
// 输入只包含：模式、任务类型、权限结果（deniedTools）、会话白名单（allowedTools）与扩展开关。
// 规则（按序）：
//   1. exposure === 'hidden' → 从不暴露
//   2. 权限拒绝（deniedTools）→ 不进入 schema
//   3. exposure === 'deferred' → 默认不暴露（B-01B 的 tool_search 候选）
//   4. exposure === 'mode' 且未声明 modes → 不暴露（内部工具未绑定模式）
//   5. 声明了 modes 且不含当前模式 → 不暴露（VFS/Plan 工具在默认回合消失）
//   6. 会话白名单非空 → 只保留白名单内（仍受上述约束）
//   7. qa 模式 → 只保留无需审批的工具（显式点名 MCP 时保留 MCP）
//   8. maxCoreTools → 对 core 工具按注册顺序截断（防御性上限）
//
// 未声明元数据的旧工具按 'core' 处理（兼容，不要求一次性改完所有工具）。
import type { ToolDefinition } from './types.js';

/** 当前回合的工具面模式 */
export type ToolSurfaceMode = 'coding' | 'qa' | string;

export interface ToolSurfaceContext {
  /** 当前模式：默认 'coding'；qa 回合传 'qa'；vfs/plan 等内部模式由调用方传 */
  mode: ToolSurfaceMode;
  /** 任务形状（预留：investigation/多步实现可在此扩展） */
  taskShape?: 'single-step' | 'multi-step-impl' | 'investigation' | 'qa';
  /** 权限拒绝的工具（来自权限结果；deny 工具不会出现在 schema） */
  deniedTools?: ReadonlySet<string>;
  /** 会话级白名单（远程 allowlist / 自动化 allowlist）；非空时只保留白名单内 */
  allowedTools?: ReadonlySet<string>;
  /** B-01B + P2（单一真相源）：tool_search 本回合提升的 deferred 工具（提升后可见） */
  boostedTools?: ReadonlySet<string>;
  /** qa 回合用户显式点名 MCP 时保留 MCP 工具（镜像旧行为） */
  mcpRequested?: boolean;
  /** core 工具数量上限（按注册顺序截断，默认不限） */
  maxCoreTools?: number;
}

export interface ToolSurfaceEntry {
  definition: Pick<
    ToolDefinition,
    'name' | 'category' | 'requiresApproval' | 'exposure' | 'modes' | 'readOnly'
  >;
}

/** 解析当前回合模型可见的工具（保留原顺序） */
export function resolveVisibleTools<T extends ToolSurfaceEntry>(
  tools: readonly T[],
  ctx: ToolSurfaceContext,
): T[] {
  const mode = ctx.mode ?? 'coding';
  let visible = tools.filter((tool) => {
    const def = tool.definition;
    if (def.exposure === 'hidden') return false;
    if (ctx.deniedTools?.has(def.name)) return false;
    // B-01B：deferred 工具被 tool_search 提升后本回合可见
    if (def.exposure === 'deferred' && !ctx.boostedTools?.has(def.name)) return false;
    if (def.exposure === 'mode' && (!def.modes || def.modes.length === 0)) return false;
    if (def.modes && def.modes.length > 0 && !def.modes.includes(mode)) return false;
    return true;
  });

  if (ctx.allowedTools && ctx.allowedTools.size > 0) {
    visible = visible.filter((tool) => ctx.allowedTools!.has(tool.definition.name));
  }

  if (mode === 'qa') {
    visible = visible.filter((tool) => {
      const def = tool.definition;
      return !def.requiresApproval || (ctx.mcpRequested === true && def.category === 'mcp');
    });
  }

  if (typeof ctx.maxCoreTools === 'number' && ctx.maxCoreTools > 0) {
    const isCore = (t: T): boolean => (t.definition.exposure ?? 'core') === 'core';
    const core = visible.filter(isCore);
    const rest = visible.filter((t) => !isCore(t));
    visible = [...core.slice(0, ctx.maxCoreTools), ...rest];
  }

  return visible;
}
