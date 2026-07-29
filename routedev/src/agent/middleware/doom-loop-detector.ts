// src/agent/middleware/doom-loop-detector.ts
// Phase 96+ B1：文件级 Doom Loop 检测中间件
//
// 解决问题：现有 loop-detection.ts 只检测「相同的 (toolName, argsHash)」组合，
// 无法识别「同一文件路径、不同编辑内容」的循环——Agent 反复在同一文件上尝试不同写法，
// 每次工具调用 argsHash 都不同，但实际已陷入死循环。
//
// 机制：
//   1. 在 onActing 阶段拦截 file_edit / file_write 工具调用
//   2. 提取 args.path 作为文件指纹
//   3. 维护滑动窗口（默认 20 次写操作），统计同文件出现次数
//   4. 阈值触发：
//      - ≥ warnThreshold（默认 6 次）：注入警告提示，建议反思
//      - ≥ criticalThreshold（默认 12 次）：注入强提醒"当前思路走不通，建议换方法"
//   5. 不阻断工具执行（避免 fail-closed 卡死），仅通过 metadata 传递提示
//
// 与 loop-detection.ts 的差异：
//   - loop-detection：精确匹配 (tool, args)，识别完全相同的重复调用
//   - doom-loop-detector：按文件路径聚合，识别"同目标不同 args"的循环
//
// 字段复用：通过 ActingResult.explorationSuggestion 传递提示（loop.ts 已有完整注入逻辑）

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { logger } from '../../utils/logger.js';

/** 触发 Doom Loop 检测的写操作工具集合 */
const WRITE_TOOLS = new Set<string>([
  'file_edit',
  'file_write',
  'file_delete',
  'edit_file',
  'write_file',
]);

/** 窗口内单条记录 */
interface DoomWindowEntry {
  /** 文件路径（已规范化为绝对路径的小写形式，跨平台一致） */
  filePath: string;
  /** 工具名（用于日志定位） */
  toolName: string;
}

export interface DoomLoopOptions {
  /** 滑动窗口大小（默认 20 次写操作） */
  windowSize?: number;
  /** 警告阈值（默认 6 次） */
  warnThreshold?: number;
  /** 严重阈值（默认 12 次） */
  criticalThreshold?: number;
}

/**
 * 文件级 Doom Loop 检测中间件
 *
 * 注册到 onActing 阶段，追踪连续写操作的文件路径。
 * 同文件多次编辑时通过 metadata.explorationSuggestion 注入提示。
 */
export class DoomLoopDetectorMiddleware {
  private windowSize: number;
  private warnThreshold: number;
  private criticalThreshold: number;
  private window: DoomWindowEntry[] = [];

  constructor(options: DoomLoopOptions = {}) {
    this.windowSize = options.windowSize ?? 20;
    this.warnThreshold = options.warnThreshold ?? 6;
    this.criticalThreshold = options.criticalThreshold ?? 12;
  }

  /**
   * 从工具参数中提取文件路径
   * 兼容 path / filePath / file_path 三种命名
   * 返回规范化的绝对路径（小写），便于跨平台比较
   */
  private extractFilePath(args: Record<string, unknown> | undefined): string | null {
    if (!args) return null;
    const raw =
      (args.path as string | undefined) ??
      (args.filePath as string | undefined) ??
      (args.file_path as string | undefined);
    if (!raw || typeof raw !== 'string') return null;
    // 规范化：去引号、去前后空白、转小写（Windows 路径不区分大小写）
    return raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  }

  /** 返回符合 MiddlewareHandler 签名的处理器（注册到 onActing 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      if (ctx.phase !== 'onActing' || !ctx.toolName) {
        await next();
        return;
      }

      const toolName = ctx.toolName;

      // 非写操作工具 → 重置窗口（避免读操作穿插干扰计数）
      if (!WRITE_TOOLS.has(toolName)) {
        this.window = [];
        await next();
        return;
      }

      const filePath = this.extractFilePath(ctx.toolArgs);
      if (!filePath) {
        // 写操作但提取不到路径 → 跳过检测（不阻断）
        await next();
        return;
      }

      // 推入窗口
      const entry: DoomWindowEntry = { filePath, toolName };
      this.window.push(entry);

      // 维护滑动窗口
      if (this.window.length > this.windowSize) {
        this.window.shift();
      }

      // 统计窗口内同文件出现次数
      const sameFileCount = this.window.filter(
        (e) => e.filePath === filePath,
      ).length;

      // 阈值判定：严重 > 警告（互斥，仅触发最高级别）
      if (sameFileCount >= this.criticalThreshold) {
        const suggestion =
          `[严重 Doom Loop 警告] 你已对 ${filePath} 编辑 ${sameFileCount} 次，` +
          `当前思路明显走不通。建议立即停下来换方法：` +
          `1) 重新读完整文件确认上下文；2) 用 git_op(checkout/diff) 回滚到干净状态重来；` +
          `3) 拆分子任务用 spawn_agent 分发；4) 直接询问用户是否需要协助。`;
        ctx.metadata.explorationSuggestion = suggestion;
        ctx.metadata.doomLoopDetected = true;
        ctx.metadata.doomLoopSeverity = 'critical';
        ctx.metadata.doomLoopFile = filePath;
        ctx.metadata.doomLoopCount = sameFileCount;
        logger.error('Doom loop detected (critical)', {
          filePath,
          count: sameFileCount,
          threshold: this.criticalThreshold,
          toolName,
        });
        // 严重触发后清空窗口，避免下一轮重复触发
        this.window = [];
      } else if (sameFileCount >= this.warnThreshold) {
        const suggestion =
          `[Doom Loop 提示] 你已对 ${filePath} 编辑 ${sameFileCount} 次，` +
          `疑似陷入循环。请反思：当前修改方向是否正确？是否需要换思路？` +
          `建议：先 file_read 看完整文件，或用 git_op(diff) 看已改内容，再决定下一步。`;
        ctx.metadata.explorationSuggestion = suggestion;
        ctx.metadata.doomLoopDetected = true;
        ctx.metadata.doomLoopSeverity = 'warn';
        ctx.metadata.doomLoopFile = filePath;
        ctx.metadata.doomLoopCount = sameFileCount;
        logger.warn('Doom loop detected (warn)', {
          filePath,
          count: sameFileCount,
          threshold: this.warnThreshold,
          toolName,
        });
      }

      await next();
    };
  }

  /** 重置窗口（新会话或用户手动重置时调用） */
  reset(): void {
    this.window = [];
  }

  /** 暴露当前窗口状态（供测试与调试使用） */
  getSnapshot(): ReadonlyArray<DoomWindowEntry> {
    return [...this.window];
  }
}
