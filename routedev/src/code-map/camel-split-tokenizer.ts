// src/code-map/camel-split-tokenizer.ts
// camelCase / snake_case / kebab_case 感知分词器
//
// 背景：node:sqlite 的 DatabaseSync 不支持注册 JS 自定义分词器
// （测试验证：CREATE VIRTUAL TABLE ... tokenize='javascript camel_split' 报 "no such tokenizer: javascript"）
// 降级方案：在写入 FTS5 时预先用本模块分词，存为空格分隔字符串，
// 用 SQLite 内置 unicode61 tokenizer（按空格切分），效果等价且跨平台一致
//
// 借鉴 codebase-memory-mcp 的 cbm_camel_split 分词器逻辑

/**
 * 把符号名拆分为小写 token 数组
 *
 * 规则：
 * - camelCase: getFileStructure → ['get', 'file', 'structure']
 * - snake_case: get_file_structure → ['get', 'file', 'structure']
 * - kebab-case: get-file-structure → ['get', 'file', 'structure']
 * - 连续大写: XMLParser → ['xml', 'parser']，parseHTTPResponse → ['parse', 'http', 'response']
 * - 点号分隔: MyClass.Method → ['my', 'class', 'method']
 * - 数字边界: parse2JSON → ['parse', '2', 'json']（数字作为独立 token）
 *
 * @returns 小写 token 数组（空字符串已过滤）
 */
export function camelSplit(name: string): string[] {
  if (!name) return [];
  return name
    // 1. 把所有分隔符（_ - . 空格）统一为空格
    .replace(/[_\-.:\s]+/g, ' ')
    // 2. 数字与字母之间加空格：parse2JSON → parse 2 JSON
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    // 3. 小写→大写边界加空格：getFile → get File
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // 4. 连续大写 + 小写开头：HTTPResponse → HTTP Response
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(Boolean);
}

/**
 * 把符号名拆分后用空格连接，作为 FTS5 索引内容
 *
 * 例：getFileStructure → "get file structure"
 * 用户搜 "file structure" 也能命中（FTS5 默认空格分隔 token）
 */
export function camelSplitToFTS(name: string): string {
  return camelSplit(name).join(' ');
}

/**
 * 构造 FTS5 MATCH 查询字符串
 *
 * 把用户输入的查询（可能含空格、camelCase）拆分为 token，
 * 用空格连接（FTS5 默认 AND 语义会要求所有 token 都匹配）
 *
 * 例：用户输入 "fileStructure" → 拆分为 "file structure" → FTS5 匹配含 file 和 structure 的文档
 */
export function buildFtsMatchQuery(query: string): string {
  const tokens = camelSplit(query);
  if (tokens.length === 0) return '';
  // 用空格连接，FTS5 默认 AND 语义
  // 注：不做前缀匹配（前缀 * 会大幅降低 BM25 排序质量）
  return tokens.join(' ');
}
