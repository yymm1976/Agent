// src/agent/memory/compressors/code-ast-summary.ts
// Phase 72 Task B2：代码 AST 摘要压缩器（headroom 借鉴）
//
// 设计动机：file_read 工具返回的源代码可能极长，但其中可执行信息密度高的是
//   函数签名 / 类结构 / import 列表，函数体往往可省略。本压缩器保留结构骨架。
//
// 实现策略（决策阶梯：复用现有 → stdlib → 已装依赖 → 最小实现）：
//   1. 优先复用 code-map/extractor.ts 的 tree-sitter AST 提取（同步 API、已加载 WASM）
//   2. WASM 不可用或语言不支持时回退到正则提取（覆盖 TS/JS/Python/Java/Go 主流语言）
//   3. 保留原始签名 verbatim（不 LLM 重写），避免幻觉摘要被反复引用
//
// 关键约束：保留 import 列表 + 函数/类/方法签名 verbatim，丢弃函数体
//   —— 避免幻觉摘要被反复引用的坑（Phase 72 Part B 避免点审查）

import { parseFile } from '../../../code-map/parser.js';
import { extractFromTree } from '../../../code-map/extractor.js';
import { getLanguageByPath } from '../../../code-map/parser.js';
import { logger } from '../../../utils/logger.js';

/** AST 摘要结果 */
export interface CodeAstSummaryResult {
  /** 压缩后的摘要字符串 */
  summary: string;
  /** 原始 token 估算 */
  originalTokens: number;
  /** 压缩后 token 估算 */
  summaryTokens: number;
  /** 使用的提取方法（'ast' = tree-sitter，'regex' = 正则回退，'none' = 未提取到结构） */
  method: 'ast' | 'regex' | 'none';
  /** 提取到的符号数量 */
  symbolCount: number;
}

/** 单个符号签名（用于统一抽象 AST 与正则路径的产出） */
interface SignatureEntry {
  kind: string;
  name: string;
  signature: string;
  line: number;
}

/**
 * 代码 AST 摘要压缩器
 *
 * @param content 源代码内容
 * @param filePath 文件路径（用于判定语言；可省略，省略则按内容启发式判定）
 * @returns 摘要结果（summary 字段可直接替换原内容）
 */
export async function summarizeCode(content: string, filePath?: string): Promise<CodeAstSummaryResult> {
  const originalTokens = Math.ceil(content.length / 4);

  // 路径 1：优先用 tree-sitter AST 提取（精确）
  if (filePath) {
    try {
      const astResult = await extractByAst(content, filePath);
      if (astResult.signatures.length > 0) {
        const summary = formatSummary(filePath, astResult.imports, astResult.signatures);
        return {
          summary,
          originalTokens,
          summaryTokens: Math.ceil(summary.length / 4),
          method: 'ast',
          symbolCount: astResult.signatures.length,
        };
      }
    } catch (e) {
      // AST 提取失败（WASM 未加载 / 解析异常），降级到正则
      logger.warn('AST 提取失败，降级到正则', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 路径 2：正则回退（覆盖主流语言，无 WASM 依赖）
  const lang = filePath ? getLanguageByPath(filePath) : detectLanguageByContent(content);
  const regexResult = extractByRegex(content, lang);
  if (regexResult.signatures.length > 0) {
    const summary = formatSummary(filePath ?? '<unknown>', regexResult.imports, regexResult.signatures);
    return {
      summary,
      originalTokens,
      summaryTokens: Math.ceil(summary.length / 4),
      method: 'regex',
      symbolCount: regexResult.signatures.length,
    };
  }

  // 路径 3：未提取到结构，返回首尾各 500 字符
  const fallback = content.slice(0, 500) + `\n[...code summary unavailable, ${content.length} chars total...]\n` + content.slice(-500);
  return {
    summary: fallback,
    originalTokens,
    summaryTokens: Math.ceil(fallback.length / 4),
    method: 'none',
    symbolCount: 0,
  };
}

/** AST 提取结果 */
interface AstExtraction {
  imports: string[];
  signatures: SignatureEntry[];
}

/** 用 tree-sitter AST 提取签名（复用 code-map/extractor.ts） */
async function extractByAst(content: string, filePath: string): Promise<AstExtraction> {
  const parseResult = await parseFile(filePath, content);
  if (!parseResult) {
    throw new Error('parseFile returned null');
  }
  const extracted = extractFromTree(parseResult.tree, filePath, parseResult.language);
  // 释放 tree（避免 WASM 内存泄漏）
  parseResult.tree.delete();

  const imports: string[] = [];
  const signatures: SignatureEntry[] = [];
  for (const node of extracted.nodes) {
    if (node.kind === 'import') {
      const src = node.sourceModule ?? '?';
      const names = node.importedNames?.length ? `: ${node.importedNames.join(', ')}` : '';
      imports.push(`import ${src}${names}`);
    } else {
      // 保留原始签名 verbatim（不重写），无签名时用 name 占位
      signatures.push({
        kind: node.kind,
        name: node.name,
        signature: node.signature ?? node.name,
        line: node.startLine + 1,
      });
    }
  }
  return { imports, signatures };
}

/** 正则提取结果 */
interface RegexExtraction {
  imports: string[];
  signatures: SignatureEntry[];
}

/** 按语言用正则提取签名（无 WASM 依赖的回退路径） */
function extractByRegex(content: string, lang: string): RegexExtraction {
  const imports: string[] = [];
  const signatures: SignatureEntry[] = [];

  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    // TS/JS import
    const importRe = /^\s*import\s.+?from\s+['"][^'"]+['"];?/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      imports.push(m[0].trim());
    }
    // function declarations
    const funcRe = /^(export\s+)?(async\s+)?function\s+\w+\s*\([^)]*\)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      signatures.push({ kind: 'function', name: extractName(m[0], 'function'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
    // class declarations
    const classRe = /^(export\s+)?(abstract\s+)?class\s+\w+/gm;
    while ((m = classRe.exec(content)) !== null) {
      signatures.push({ kind: 'class', name: extractName(m[0], 'class'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
    // interface declarations
    const ifaceRe = /^(export\s+)?interface\s+\w+/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      signatures.push({ kind: 'interface', name: extractName(m[0], 'interface'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
    // arrow function exports: export const foo = (x) => ...
    const arrowRe = /^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>/gm;
    while ((m = arrowRe.exec(content)) !== null) {
      signatures.push({ kind: 'arrow_function', name: extractName(m[0], 'const'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
  } else if (lang === 'python') {
    const importRe = /^\s*(from\s+[\w.]+\s+import\s+\S+|import\s+\S+)/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      imports.push(m[0].trim());
    }
    const funcRe = /^\s*(async\s+)?def\s+\w+\s*\([^)]*\)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      signatures.push({ kind: 'function', name: extractName(m[0], 'def'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
    const classRe = /^\s*class\s+\w+/gm;
    while ((m = classRe.exec(content)) !== null) {
      signatures.push({ kind: 'class', name: extractName(m[0], 'class'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
  } else if (lang === 'java') {
    const importRe = /^\s*import\s+[\w.*]+;/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      imports.push(m[0].trim());
    }
    const methodRe = /^\s*(public|private|protected|static)\s+[\w<>\[\],\s]+\s+\w+\s*\([^)]*\)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      signatures.push({ kind: 'method', name: extractName(m[0], ''), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
    const classRe = /^\s*(public\s+)?(abstract\s+)?class\s+\w+/gm;
    while ((m = classRe.exec(content)) !== null) {
      signatures.push({ kind: 'class', name: extractName(m[0], 'class'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
  } else if (lang === 'go') {
    let m: RegExpExecArray | null;
    // 仅在 import 块内匹配（简化：取以 " 开头以 " 结尾的行）
    const importBlockRe = /import\s*\(([\s\S]*?)\)/gm;
    while ((m = importBlockRe.exec(content)) !== null) {
      const lines = m[1].split('\n').map(s => s.trim()).filter(s => s.startsWith('"'));
      imports.push(...lines);
    }
    const funcRe = /^func\s+(\([^)]+\)\s+)?\w+\s*\([^)]*\)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      signatures.push({ kind: 'function', name: extractName(m[0], 'func'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
    const typeRe = /^type\s+\w+\s+(struct|interface)/gm;
    while ((m = typeRe.exec(content)) !== null) {
      signatures.push({ kind: 'type', name: extractName(m[0], 'type'), signature: m[0].trim(), line: getLineNumber(content, m.index) });
    }
  }

  return { imports, signatures };
}

/** 从匹配文本中提取标识符名 */
function extractName(text: string, keyword: string): string {
  const trimmed = text.trim();
  if (keyword === 'function' || keyword === 'def' || keyword === 'class' || keyword === 'interface') {
    const re = new RegExp(`\\b${keyword}\\s+(\\w+)`);
    const m = re.exec(trimmed);
    return m ? m[1] : '?';
  }
  if (keyword === 'const') {
    const m = /\bconst\s+(\w+)/.exec(trimmed);
    return m ? m[1] : '?';
  }
  if (keyword === 'func') {
    const m = /\bfunc\s+(?:\([^)]+\)\s+)?(\w+)/.exec(trimmed);
    return m ? m[1] : '?';
  }
  if (keyword === 'type') {
    const m = /\btype\s+(\w+)/.exec(trimmed);
    return m ? m[1] : '?';
  }
  return '?';
}

/** 把字符 offset 转为行号（1-based） */
function getLineNumber(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** 按内容启发式判定语言（无 filePath 时使用） */
function detectLanguageByContent(content: string): string {
  if (/^\s*package\s+\w+/m.test(content) && /^\s*import\s+["\(]/m.test(content)) return 'go';
  if (/\bdef\s+\w+\s*\(/m.test(content) && /^\s*import\s/m.test(content)) return 'python';
  if (/\bpublic\s+(class|static)\s/m.test(content)) return 'java';
  if (/\b(function|const|interface)\s+\w+/m.test(content)) return 'typescript';
  return 'unknown';
}

/** 把 imports + signatures 格式化为摘要字符串 */
function formatSummary(filePath: string, imports: string[], signatures: SignatureEntry[]): string {
  const lines: string[] = [];
  lines.push(`# 代码摘要：${filePath}`);
  lines.push(`# 共 ${signatures.length} 个符号 + ${imports.length} 个 import（函数体已省略，签名 verbatim 保留）`);
  lines.push('');

  if (imports.length > 0) {
    lines.push('## Imports');
    for (const imp of imports) {
      lines.push(imp);
    }
    lines.push('');
  }

  if (signatures.length > 0) {
    lines.push('## Signatures');
    for (const sig of signatures) {
      lines.push(`L${sig.line} [${sig.kind}] ${sig.signature}`);
    }
  }

  return lines.join('\n');
}
