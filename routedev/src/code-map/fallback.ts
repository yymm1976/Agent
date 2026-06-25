// src/code-map/fallback.ts
// tree-sitter 加载失败时的回退方案
// 当 web-tree-sitter 不可用（WASM 缺失/版本不兼容）时，自动切换到正则引擎
// 保持代码地图功能可用，仅精度降低

export type CodeMapEngine = 'tree-sitter' | 'regex' | 'disabled';

/**
 * 代码地图回退管理器
 * 负责：
 *   1. 检测 tree-sitter 是否可用
 *   2. 根据可用性选择引擎（tree-sitter → regex → disabled）
 *   3. 生成用户可见的回退提示消息
 */
export class CodeMapFallback {
  /**
   * 检测 tree-sitter 是否可用
   * 尝试动态 import web-tree-sitter 并调用 init()
   * 失败原因可能是：模块未安装 / WASM 文件缺失 / 版本不兼容
   */
  static async checkTreeSitterAvailability(): Promise<{ available: boolean; reason?: string }> {
    try {
      // 动态 import 避免 tree-sitter 不可用时影响整个模块加载
      // 注：web-tree-sitter 的实际类型与最小声明不一致（init 在 Parser 静态方法上），
      //     先转 unknown 再转目标类型，避免 TypeScript 类型重叠检查失败
      const mod = await import('web-tree-sitter') as unknown as {
        default?: { init: (opts?: unknown) => Promise<void> };
        init?: (opts?: unknown) => Promise<void>;
      };
      const wts = mod.default ?? mod;
      await wts.init!();
      return { available: true };
    } catch (e) {
      return { available: false, reason: (e as Error).message };
    }
  }

  /**
   * 根据可用性选择引擎
   * - preferred=disabled：直接返回 disabled
   * - preferred=regex：直接返回 regex（用户显式选择不检测）
   * - preferred=tree-sitter：检测可用性，不可用时回退到 regex
   */
  static async resolveEngine(preferred: CodeMapEngine): Promise<CodeMapEngine> {
    if (preferred === 'disabled') return 'disabled';
    if (preferred === 'regex') return 'regex';
    const { available } = await this.checkTreeSitterAvailability();
    return available ? 'tree-sitter' : 'regex';
  }

  /**
   * 生成回退提示消息
   * 在控制台/日志中显示，告知用户精度降低
   */
  static getFallbackMessage(reason: string): string {
    return `⚠️ tree-sitter 引擎不可用（${reason}），已自动切换到正则引擎。代码地图精度将降低。`;
  }
}
