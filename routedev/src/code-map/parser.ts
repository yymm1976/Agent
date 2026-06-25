// src/code-map/parser.ts
// web-tree-sitter 解析抽象层
// 注意：tree-sitter-wasms 0.1.13 的 WASM 文件使用旧版 "dylink" section，
// 与 web-tree-sitter 0.26.9 不兼容（需要 "dylink.0"）。
// 因此优先加载兼容的 0.22.x 版本（位于 .routedev-wts/），
// 若不存在则回退到项目安装的 0.26.9。

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  EXTENSION_LANGUAGE_MAP,
  LANGUAGE_WASM_MAP,
  type Language,
} from './schema.js';

// ---- web-tree-sitter 最小类型声明（兼容 0.22.x / 0.26.x 运行时） ----
export interface TSPoint {
  row: number;
  column: number;
}
export interface TSNode {
  type: string;
  isNamed: boolean;
  text: string;
  startPosition: TSPoint;
  endPosition: TSPoint;
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  children: TSNode[];
  namedChildren: TSNode[];
  childCount: number;
  namedChildCount: number;
  childForFieldName(name: string): TSNode | null;
  child(index: number): TSNode | null;
  namedChild(index: number): TSNode | null;
  firstChild: TSNode | null;
  lastChild: TSNode | null;
  nextSibling: TSNode | null;
  previousSibling: TSNode | null;
  toString(): string;
}
export interface TSTree {
  rootNode: TSNode;
  delete(): void;
}
export interface TSParser {
  parse(input: string, oldTree?: TSTree): TSTree;
  setLanguage(lang: unknown): void;
  delete(): void;
  setTimeoutMicros(t: number): void;
}
export interface TSLanguage {
  // opaque
}
interface WTSModule {
  init(opts?: unknown): Promise<void>;
  Language: { load(input: string | Uint8Array): Promise<TSLanguage> };
  new ():
    | TSParser
    | Promise<TSParser>;
}

// ---- 加载 web-tree-sitter ----
let wtsModule: WTSModule | null = null;
let wtsVersion: string = '0.26.9';
const loadedLanguages = new Map<Language, TSLanguage>();
let initDone = false;

function findWtsModulePath(): string | null {
  // 1) 优先：.routedev-wts/node_modules/web-tree-sitter（兼容 0.1.13 wasms）
  const here = path.resolve(__dirname, '../../.routedev-wts/node_modules/web-tree-sitter/tree-sitter.js');
  if (fs.existsSync(here)) {
    wtsVersion = '0.22.6';
    return here;
  }
  // 2) 回退：项目 node_modules/web-tree-sitter（0.26.9，可能不兼容）
  try {
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));
    return req.resolve('web-tree-sitter');
  } catch {
    return null;
  }
}

/** 初始化解析器（幂等） */
export async function initParser(): Promise<void> {
  if (initDone) return;
  const modulePath = findWtsModulePath();
  if (!modulePath) {
    throw new Error('web-tree-sitter not found');
  }
  const req = createRequire(modulePath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = req(modulePath) as WTSModule | { default: WTSModule };
  wtsModule = (mod as { default?: WTSModule }).default ?? (mod as WTSModule);
  await wtsModule.init();
  initDone = true;
}

/** 获取已加载的 web-tree-sitter 模块 */
function getWts(): WTSModule {
  if (!wtsModule) {
    throw new Error('Parser not initialized. Call initParser() first.');
  }
  return wtsModule;
}

/** 根据文件扩展名获取语言 */
export function getLanguageByPath(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'unknown';
}

/** 加载语言 WASM（带缓存） */
export async function loadLanguage(lang: Language): Promise<TSLanguage | null> {
  if (lang === 'unknown') return null;
  const cached = loadedLanguages.get(lang);
  if (cached) return cached;

  const wasmName = LANGUAGE_WASM_MAP[lang];
  if (!wasmName) return null;

  const req = createRequire(__filename);
  let wasmPath: string;
  try {
    wasmPath = req.resolve(`tree-sitter-wasms/out/${wasmName}`);
  } catch {
    return null;
  }
  if (!fs.existsSync(wasmPath)) return null;

  const buf = fs.readFileSync(wasmPath);
  const language = await getWts().Language.load(buf);
  loadedLanguages.set(lang, language);
  return language;
}

/** 创建新解析器 */
export function createParser(lang: TSLanguage): TSParser {
  const ParserCtor = getWts() as unknown as { new (): TSParser };
  const parser = new ParserCtor();
  parser.setLanguage(lang);
  return parser;
}

/** 解析结果 */
export interface ParseResult {
  tree: TSTree;
  language: Language;
}

/** 解析文件内容，返回 AST 树 */
export async function parseFile(filePath: string, content: string): Promise<ParseResult | null> {
  await initParser();
  const lang = getLanguageByPath(filePath);
  if (lang === 'unknown') return null;

  const language = await loadLanguage(lang);
  if (!language) return null;

  const parser = createParser(language);
  try {
    const tree = parser.parse(content);
    return { tree, language: lang };
  } catch {
    return null;
  } finally {
    parser.delete();
  }
}
