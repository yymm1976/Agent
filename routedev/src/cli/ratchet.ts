// src/cli/ratchet.ts
// P0-13：Ratchet 高度棘轮防布局抖动
//
// 借鉴 Claude Code `src/components/design-system/Ratchet.tsx`：
//   - 记录历史最大高度
//   - 元素一旦离开视口就 setMinHeight
//   - 后续内容只能更高不能更低
//   - lock='offscreen' 比 lock='always' 更友好——视口内允许自然伸缩，滚出去才锁定
//
// RouteDev 适配（CLI 文本场景）：
//   - CLI 没有 DOM，但流式输出时同样存在"先涨后缩"问题
//     （spinner 转完变静态行，输出长度先涨后缩）
//   - 用 RatchetTracker 记录历史最大行数
//   - render 时如果当前行数 < maxLines，用空行填充到 maxLines
//   - lock 模式：
//     * 'always'：每次 render 都锁定（保守，可能导致大量空行）
//     * 'offscreen'：仅在内容已离开视口时锁定（推荐）
//     * 'never'：不锁定（用于一次性输出）
//
// 使用场景：
//   - StepCard 流式输出（agent 思考、命令输出）
//   - ProgressBar 完成后变静态行
//   - 任何"先流式再定格"的组件

/** Ratchet 锁定模式 */
export type RatchetLockMode = 'always' | 'offscreen' | 'never';

/** Ratchet 状态 */
export interface RatchetState {
  /** 历史最大行数 */
  maxLines: number;
  /** 历史最大字符宽度（可选，用于横向锁定） */
  maxWidth: number;
  /** 是否已锁定（lock='offscreen' 时仅在离开视口后置 true） */
  locked: boolean;
  /** 累计 render 次数（用于调试） */
  renderCount: number;
}

/** 创建初始 Ratchet 状态 */
export function createRatchetState(): RatchetState {
  return {
    maxLines: 0,
    maxWidth: 0,
    locked: false,
    renderCount: 0,
  };
}

/**
 * 计算内容的行数和最大宽度
 */
function measureContent(content: string): { lines: number; maxWidth: number } {
  if (!content) return { lines: 0, maxWidth: 0 };
  const lineArray = content.split('\n');
  const lines = lineArray.length;
  const maxWidth = lineArray.reduce((max, line) => {
    // 去除 ANSI 转义后计算可见宽度
    const visible = stripAnsi(line);
    return Math.max(max, visible.length);
  }, 0);
  return { lines, maxWidth };
}

/** 剥离 ANSI 转义序列（用于宽度计算） */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * P0-13：用 Ratchet 锁定渲染内容
 *
 * 行为：
 *   1. 测量当前内容的行数和宽度
 *   2. 更新 state.maxLines / state.maxWidth（只增不减）
 *   3. 根据 lock 模式决定是否填充空行到 maxLines
 *   4. 返回填充后的内容
 *
 * @param content 当前要渲染的内容
 * @param state Ratchet 状态（会被原地更新）
 * @param lockMode 锁定模式（默认 'offscreen'）
 * @param isOffscreen 当前内容是否已离开视口（lock='offscreen' 时使用）
 * @returns 渲染内容（可能含填充空行）
 */
export function ratchetRender(
  content: string,
  state: RatchetState,
  lockMode: RatchetLockMode = 'offscreen',
  isOffscreen: boolean = false,
): string {
  state.renderCount++;

  const { lines, maxWidth } = measureContent(content);

  // 更新历史最大值（棘轮：只增不减）
  if (lines > state.maxLines) {
    state.maxLines = lines;
  }
  if (maxWidth > state.maxWidth) {
    state.maxWidth = maxWidth;
  }

  // 决定是否锁定
  if (lockMode === 'never') {
    return content;
  }

  if (lockMode === 'offscreen') {
    // 仅在内容已离开视口时锁定
    if (isOffscreen) {
      state.locked = true;
    }
    // 未锁定时不填充，允许视口内自然伸缩
    if (!state.locked) {
      return content;
    }
  }

  // lock='always' 或已锁定的 'offscreen'：填充空行到 maxLines
  if (lines < state.maxLines) {
    const padding = '\n'.repeat(state.maxLines - lines);
    return content + padding;
  }

  return content;
}

/**
 * P0-13：重置 Ratchet 状态（用于切换任务或清屏）
 *
 * 注意：重置后 maxLines 归零，下次 render 会重新开始累积
 */
export function resetRatchet(state: RatchetState): void {
  state.maxLines = 0;
  state.maxWidth = 0;
  state.locked = false;
  state.renderCount = 0;
}

/**
 * P0-13：获取 Ratchet 状态快照（用于调试/UI 显示）
 */
export function getRatchetStatus(state: RatchetState): {
  maxLines: number;
  maxWidth: number;
  locked: boolean;
  renderCount: number;
} {
  return {
    maxLines: state.maxLines,
    maxWidth: state.maxWidth,
    locked: state.locked,
    renderCount: state.renderCount,
  };
}

/**
 * P0-13：批量 Ratchet 管理器
 *
 * 用于多个流式组件共存时分别跟踪各自的高度
 * （如多个 StepCard 并行渲染，每个独立 Ratchet）
 */
export class RatchetManager {
  private states = new Map<string, RatchetState>();

  /** 获取或创建指定 key 的 Ratchet 状态 */
  get(key: string): RatchetState {
    let s = this.states.get(key);
    if (!s) {
      s = createRatchetState();
      this.states.set(key, s);
    }
    return s;
  }

  /** 渲染指定 key 的内容（带 Ratchet 锁定） */
  render(
    key: string,
    content: string,
    lockMode: RatchetLockMode = 'offscreen',
    isOffscreen: boolean = false,
  ): string {
    return ratchetRender(content, this.get(key), lockMode, isOffscreen);
  }

  /** 重置指定 key 的状态 */
  reset(key: string): void {
    const s = this.states.get(key);
    if (s) resetRatchet(s);
  }

  /** 重置所有 key 的状态 */
  resetAll(): void {
    for (const s of this.states.values()) {
      resetRatchet(s);
    }
  }

  /** 删除指定 key（用于组件卸载） */
  delete(key: string): void {
    this.states.delete(key);
  }

  /** 列出所有 key（用于调试） */
  keys(): string[] {
    return Array.from(this.states.keys());
  }
}
