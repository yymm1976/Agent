// src/tools/command-parser.ts
// 命令解析器：将 shell 命令字符串解析为结构化表示，用于安全决策
// Phase 29 Task 3：替代正则/子串匹配，修复命令注入绕过漏洞（S1/S2/S3）
// I1 修复：支持命令链分割（&&、||、;、|），每个子命令独立解析
//
// 设计原则：
//   1. 不追求完整 shell parser——只提取安全决策所需的关键信息（命令名、参数、特殊字符）
//   2. 支持引号包裹（"..."、'...'）——防止引号绕过
//   3. 识别危险模式：管道 |、命令替换 $()、重定向 > >> <
//   4. I1 修复：识别命令链（&&、||、;），分割后逐个解析，防止安全检查被绕过
//
// 已知限制：
// - 不支持转义引号（如 "hello \"world\""）
// - 不支持嵌套引号（如 "it's a 'test'"）
// - 不支持反斜杠转义（如 echo a\ b）
// 安全决策依赖 parseCommand 的场景，应额外校验 rawCommand 中的引号数量是否平衡

/** 解析后的命令结构 */
export interface ParsedCommand {
  /** 命令名（首 token，已去除引号），如 "rm"、"git"、"python" */
  command: string;
  /** 参数列表（不含命令名，已去除引号） */
  args: string[];
  /** 是否包含管道 (|) */
  hasPipe: boolean;
  /** 是否包含命令替换 ($() 或 ``) */
  hasSubstitution: boolean;
  /** 是否包含重定向 (>, >>, <) */
  hasRedirect: boolean;
  /** 原始命令字符串 */
  raw: string;
  /**
   * I1 修复：命令链中的所有子命令（含本条）
   * 单条命令时长度为 1；命令链（&&、||、;）时长度 > 1
   * 安全检查应遍历所有子命令
   */
  subCommands?: ParsedCommand[];
}

/**
 * I1 修复：将命令字符串按命令链分隔符（&&、||、;、|）分割
 * 注意：仅在引号外分割，避免误分割引号内的分隔符
 * @returns 分割后的子命令字符串数组（已 trim）
 */
function splitCommandChain(command: string): string[] {
  // 移除引号包裹的内容后再检测分隔符，避免误分割
  // 简化实现：逐字符扫描，遇到引号时跳过
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === '\'' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    // 仅在引号外检测分隔符
    if (!inSingleQuote && !inDoubleQuote) {
      // && 分隔符
      if (ch === '&' && next === '&') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // || 分隔符
      if (ch === '|' && next === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // | 管道分隔符
      if (ch === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
      // ; 分隔符
      if (ch === ';') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [command.trim()];
}

/**
 * 将 shell 命令字符串解析为结构化表示
 *
 * 解析策略：
 * 1. I1 修复：先按命令链分隔符（&&、||、;）分割
 * 2. 对每个子命令独立解析
 * 3. 去除首尾空格
 * 4. 按空白字符拆分 tokens，支持引号包裹（"..."、'...'）
 * 5. 首 token 去除引号后作为 command，其余作为 args
 * 6. 检测特殊字符：|（管道）、$() / ``（命令替换）、> >> <（重定向）
 *
 * 注意：这不是完整的 shell parser，而是提取安全决策所需的关键信息。
 * I1 修复后，命令链中的每个子命令都会被独立解析，安全检查应遍历 subCommands。
 */
export function parseCommand(command: string): ParsedCommand {
  const raw = command;

  // 引号平衡校验：不平衡的引号可能导致安全决策被绕过
  const quoteCount = (raw.match(/["']/g) ?? []).length;
  if (quoteCount % 2 !== 0) {
    // 引号不平衡，返回原始命令作为单个 token，让安全检查走 rawCommand 路径
    return {
      command: raw,
      args: [],
      hasPipe: false,
      hasSubstitution: false,
      hasRedirect: false,
      raw,
    };
  }

  // I1 修复：先按命令链分隔符分割
  const chainParts = splitCommandChain(command);

  // 如果只有一条命令，直接解析（保持原有行为）
  if (chainParts.length === 1) {
    return parseSingleCommand(chainParts[0], raw);
  }

  // 命令链：解析每个子命令，并汇总标记
  const subCommands = chainParts.map(part => parseSingleCommand(part, part));
  const first = subCommands[0];

  return {
    command: first.command,
    args: first.args,
    hasPipe: subCommands.some(sc => sc.hasPipe) || chainParts.length > 1,
    hasSubstitution: subCommands.some(sc => sc.hasSubstitution),
    hasRedirect: subCommands.some(sc => sc.hasRedirect),
    raw,
    subCommands,
  };
}

/** 解析单条命令（不含命令链分隔符） */
function parseSingleCommand(command: string, raw: string): ParsedCommand {
  const trimmed = command.trim();

  // 检测特殊字符（在拆分前检测，避免引号内的 | 被误判）
  // 注：引号内的特殊字符不应触发标记，但为安全起见，仍检测裸露的特殊字符
  const hasPipe = /\|/.test(trimmed.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, ''));
  const hasSubstitution = /\$\([^)]*\)/.test(trimmed) || /`[^`]*`/.test(trimmed);
  const hasRedirect = />>?|</.test(trimmed.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, ''));

  // 按空白字符拆分 tokens，支持引号包裹
  // 正则解释：匹配 "..." 或 '...' 或非空白序列
  const tokenRegex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(trimmed)) !== null) {
    tokens.push(match[0]);
  }

  // 去除引号的辅助函数
  const stripQuotes = (token: string): string => {
    if ((token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  };

  const commandName = tokens.length > 0 ? stripQuotes(tokens[0]) : '';
  const args = tokens.slice(1).map(stripQuotes);

  return {
    command: commandName,
    args,
    hasPipe,
    hasSubstitution,
    hasRedirect,
    raw,
  };
}
