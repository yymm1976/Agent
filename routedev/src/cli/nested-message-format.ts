// src/cli/nested-message-format.ts
// P0-12：嵌套消息的 ⎿ 视觉语法 + Context 抑制
//
// 借鉴 Claude Code `src/components/MessageResponse.tsx`：
//   - 用 `  ⎿  ` 前缀缩进表达子结果（工具调用结果、子 Agent 输出、思考链）
//   - MessageResponseContext 默认 false 包裹子树：已在 MessageResponse 内部就不再渲染前缀
//     避免 `⎿ ⎿ ⎿` 多层堆叠
//   - `<NoSelect>` 让装饰字符不被选中（CLI 等价：用 ANSI 转义让 ⎿ 不被复制）
//
// RouteDev 适配（CLI 文本场景）：
//   - formatNestedBlock(content, depth) 在每行前加 `  ⎿  ` 缩进
//   - depth=0 时不加前缀（最外层 MessageResponse）
//   - 多行内容每行都加前缀，保持视觉对齐
//   - 提供 stripNestedPrefix 用于复制时清理装饰字符
//
// 使用场景：
//   - 渲染工具调用结果：调用 formatNestedBlock(output, 1)
//   - 渲染子 Agent 输出：调用 formatNestedBlock(spawnResult, 1)
//   - 渲染思考链：调用 formatNestedBlock(thinking, 1)

/** 嵌套层级 → 缩进空格数 */
const NESTED_INDENT_WIDTH = 2;
/** 嵌套前缀字符（U+23BF "RIGHT TACK TO BOTTOM" — ⎿） */
const NESTED_PREFIX_CHAR = '⎿';
/** 单层前缀（含两侧空格） */
const SINGLE_PREFIX = ' '.repeat(NESTED_INDENT_WIDTH) + NESTED_PREFIX_CHAR + '  ';

/**
 * 格式化嵌套消息块
 *
 * @param content 原始内容（可能多行）
 * @param depth 嵌套深度（0 = 顶层不加前缀；1 = 单层 ⎿；2 = 双层但仅最外层显示 ⎿）
 * @returns 格式化后的字符串（每行行首加 `  ⎿  ` 前缀，depth=0 时原样返回）
 *
 * @example
 * formatNestedBlock('hello\nworld', 1)
 * // → '  ⎿  hello\n  ⎿  world'
 *
 * formatNestedBlock('top-level', 0)
 * // → 'top-level'
 */
export function formatNestedBlock(content: string, depth: number = 1): string {
  if (depth <= 0 || !content) return content;
  // 多行分别加前缀，保持视觉对齐
  const lines = content.split('\n');
  return lines.map(line => SINGLE_PREFIX + line).join('\n');
}

/**
 * 多层嵌套时仅显示最外层 ⎿（避免 ⎿⎿⎿ 视觉混乱）
 *
 * 借鉴 Claude Code MessageResponseContext：
 *   - 父 MessageResponse 已在 context 中，子 MessageResponse 检测到 context=true
 *     就不再渲染前缀
 *   - CLI 等价：调用方已知 depth，depth >= 2 时不加前缀（仅最外层加）
 *
 * @param content 原始内容
 * @param depth 嵌套深度
 * @returns depth=1 加前缀；depth>=2 不加前缀（已被外层 ⎿ 包裹）
 */
export function formatNestedBlockWithSuppression(content: string, depth: number = 1): string {
  if (depth <= 0) return content;
  if (depth === 1) return formatNestedBlock(content, 1);
  // depth >= 2：抑制前缀（外层已加），仅做缩进对齐
  const lines = content.split('\n');
  const indent = ' '.repeat(SINGLE_PREFIX.length);
  return lines.map(line => indent + line).join('\n');
}

/**
 * 剥离嵌套前缀（用于复制时清理装饰字符）
 *
 * 借鉴 Claude Code `<NoSelect>` 组件：让 ⎿ 字符不被选中
 * CLI 等价：复制输出时调用此函数清理前缀
 *
 * @param formatted 已格式化的内容
 * @returns 清理后的内容（每行去掉 `  ⎿  ` 前缀）
 */
export function stripNestedPrefix(formatted: string): string {
  if (!formatted) return formatted;
  const lines = formatted.split('\n');
  return lines.map(line => {
    if (line.startsWith(SINGLE_PREFIX)) {
      return line.slice(SINGLE_PREFIX.length);
    }
    // 也处理纯缩进的情况（depth>=2 抑制前缀后的对齐空格）
    const indent = ' '.repeat(SINGLE_PREFIX.length);
    if (line.startsWith(indent)) {
      return line.slice(indent.length);
    }
    return line;
  }).join('\n');
}

/**
 * 构造嵌套消息上下文（用于跟踪当前是否已在外层 ⎿ 内）
 *
 * 借鉴 Claude Code MessageResponseContext 的 React Context
 * CLI 等价：用纯对象记录当前深度，传递给子格式化调用
 */
export interface NestedMessageContext {
  /** 当前嵌套深度（0 = 顶层） */
  depth: number;
  /** 父上下文（用于链式追溯） */
  parent: NestedMessageContext | null;
}

/** 根上下文（depth=0） */
export const ROOT_NESTED_CONTEXT: NestedMessageContext = { depth: 0, parent: null };

/**
 * 创建子上下文（深度 +1）
 */
export function createChildContext(parent: NestedMessageContext): NestedMessageContext {
  return { depth: parent.depth + 1, parent };
}

/**
 * 在给定上下文中格式化消息块
 *
 * 自动根据上下文深度决定是否加前缀：
 *   - depth=0：加前缀（首次进入嵌套）
 *   - depth>=1：抑制前缀（已被外层 ⎿ 包裹）
 */
export function formatInContext(
  content: string,
  ctx: NestedMessageContext,
): { result: string; childContext: NestedMessageContext } {
  const childCtx = createChildContext(ctx);
  // depth=0 时子上下文 depth=1，加前缀
  // depth>=1 时子上下文 depth>=2，抑制前缀
  const result = formatNestedBlockWithSuppression(content, childCtx.depth);
  return { result, childContext: childCtx };
}
