// src/tools/command-parser.ts
// 命令解析器：将 shell 命令字符串解析为结构化表示，用于安全决策
// Phase 29 Task 3：替代正则/子串匹配，修复命令注入绕过漏洞（S1/S2/S3）
//
// 设计原则：
//   1. 不追求完整 shell parser——只提取安全决策所需的关键信息（命令名、参数、特殊字符）
//   2. 支持引号包裹（"..."、'...'）——防止引号绕过
//   3. 识别危险模式：管道 |、命令替换 $()、重定向 > >> <
//
// 使用场景：
//   - SecurityChecker.checkCommand()：白名单/黑名单匹配首 token
//   - PermissionEngine deny 规则：argsPredicate 基于 tokenize 结果判断

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
}

/**
 * 将 shell 命令字符串解析为结构化表示
 *
 * 解析策略：
 * 1. 去除首尾空格
 * 2. 按空白字符拆分 tokens，支持引号包裹（"..."、'...'）
 * 3. 首 token 去除引号后作为 command，其余作为 args
 * 4. 检测特殊字符：|（管道）、$() / ``（命令替换）、> >> <（重定向）
 *
 * 注意：这不是完整的 shell parser，而是提取安全决策所需的关键信息。
 * 复杂的 shell 语法（如 &&、||、;）会被当作普通 token 处理，
 * 但 hasPipe/hasSubstitution/hasRedirect 会标记出危险模式。
 */
export function parseCommand(command: string): ParsedCommand {
  const raw = command;
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
