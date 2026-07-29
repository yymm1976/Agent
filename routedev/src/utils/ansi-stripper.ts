// src/utils/ansi-stripper.ts
// ANSI 转义序列去除工具
//
// Phase 96 P1-5 修复：shell 命令输出（pnpm test / vitest / git diff --color 等）
// 几乎都带 ANSI 颜色码与光标控制序列，直接进入 LLM 上下文既浪费 token 又可能干扰
// 注入检测的正则匹配。本模块提供统一的 ANSI 去除能力。
//
// 覆盖范围（参考 strip-ansi / ansi-regex 业界实现）：
//   - CSI 序列：ESC [ ... m（SGR 颜色/样式） / ESC [ ... H（光标移动）等
//   - OSC 序列：ESC ] ... BEL / ESC ] ... ESC \（操作系统命令，如终端标题）
//   - 其他常见转义：ESC 7/8（保存/恢复光标）、ESC =（应用键盘模式）等

/**
 * 匹配 ANSI 转义序列的正则
 *
 * 三组分支：
 *   1. CSI：ESC [ + 私有标记? + 参数 + 中间字节 + 终止字节
 *   2. OSC：ESC ] + 内容 + (BEL 或 ST=ESC \)
 *   3. 单字节 ESC + 终止字节（如 ESC 7 / ESC 8 / ESC = / ESC >）
 */
const ANSI_REGEX = new RegExp(
  [
    // CSI 序列：ESC [ <? 0-9;? 字母/终终止字节
    '[\\u001B\\u009B][\\[<>?]?[0-9;]*[ -/]*[@-~]',
    // OSC 序列：ESC ] ... BEL 或 ESC ] ... ESC \
    '[\\u001B\\u009B]\\][^\\u0007\\u001B]*(?:\\u0007|[\\u001B]\\\\)',
    // 单字节 ESC + 终止字节（7/8/H/M = > 等）
    '[\\u001B\\u009B][=>78HMcDdAaBbeGgJjKkLlPpQqRrSsTtXxZz]',
    // ESC ( <字符>  / ESC ) <字符>（字符集选择）
    '[\\u001B\\u009B][()*+][A-Za-z0-9]',
  ].join('|'),
  'g',
);

/**
 * 去除字符串中的 ANSI 转义序列
 *
 * 与简单的颜色码正则相比，覆盖了 CSI/OSC/单字节 ESC/字符集选择四类序列，
 * 适用于绝大多数命令行工具输出（包括光标移动、终端标题变更等）
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/**
 * 净化二进制输出
 *
 * shell-exec 等工具可能捕获到二进制垃圾（如误用 cat 读 .png），
 * 直接 toString('utf-8') 会产出大量 U+FFFD 替换字符。本函数：
 *   1. 把不可打印控制字符（除 \t \n \r 外）替换为 \x00 表示
 *   2. 归一化换行符（\r\n → \n，单独 \r → \n）
 *   3. 折叠连续 3+ 个 U+FFFD 为单个 [binary data] 标记
 */
export function sanitizeBinaryOutput(text: string): string {
  // 1. 替换不可打印控制字符（保留 \t=0x09 \n=0x0A \r=0x0D）
  let result = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (ch) => {
    // 不可打印控制字符替换为可见的 \x00 占位（保留一行，避免 LLM 阅读困难）
    return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
  });
  // 2. 归一化换行：\r\n → \n，单独的 \r → \n
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 3. 折叠连续 U+FFFD 替换字符（3+ 个连续视为二进制垃圾区段）
  result = result.replace(/(\uFFFD){3,}/g, '[binary data]');
  return result;
}

/**
 * 截断结果元数据
 *
 * Phase 96 P1-5 新增：让下游调用方从结构化字段判断截断状态，
 * 而非解析 in-band 文本标记（如 `[输出已截断]`）
 */
export interface TruncationResult {
  /** 截断维度，null 表示未截断 */
  truncatedBy: 'lines' | 'bytes' | null;
  /** 原始总行数 */
  totalLines: number;
  /** 输出后保留的行数 */
  outputLines: number;
  /** 原始字节大小（用于字节级截断判断） */
  originalBytes: number;
  /** 输出后字节大小 */
  outputBytes: number;
  /** 首行是否超过单行上限（用于建议改用 bash 读取） */
  firstLineExceedsLimit: boolean;
}

/**
 * 单行最大字符数（超过则 firstLineExceedsLimit=true）
 */
const DEFAULT_MAX_LINE_CHARS = 2000;

/**
 * 计算截断元数据
 *
 * 不实际执行截断，只返回元数据供调用方决策
 */
export function computeTruncationMetadata(
  original: string,
  output: string,
  options?: { maxLineChars?: number },
): TruncationResult {
  const maxLine = options?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const originalLines = original.split('\n');
  const outputLines = output.split('\n');
  const firstLine = originalLines[0] ?? '';
  return {
    truncatedBy: original.length > output.length ? 'bytes' : null,
    totalLines: originalLines.length,
    outputLines: outputLines.length,
    originalBytes: Buffer.byteLength(original, 'utf-8'),
    outputBytes: Buffer.byteLength(output, 'utf-8'),
    firstLineExceedsLimit: firstLine.length > maxLine,
  };
}
