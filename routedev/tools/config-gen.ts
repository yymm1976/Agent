// Phase 75-B8：配置 schema 生成器（借鉴 tau tcc-gen）
// 输入：config-schema.yaml
// 输出：types.ts + defaults.ts + ui-fields.json
// 用法：node --experimental-strip-types tools/config-gen.ts [schema.yaml] [output-dir]
//
// 设计目标：
//   - 一份 YAML schema 是唯一真相源
//   - 生成三端产物：TS 类型 / 默认值常量 / UI 字段描述
//   - 不引入新依赖（使用项目已有的 `yaml` ^2.9.0 包）
//   - 试点阶段：只生成新文件，不替换现有 SettingsPage 或 config.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// --- 类型定义 ---

/** 支持的字段类型 */
type FieldType = 'string' | 'number' | 'boolean';

/** UI 控件类型 */
type WidgetType = 'text' | 'number' | 'boolean' | 'select';

/** 字段 UI 描述 */
interface FieldUi {
  label: string;
  widget: WidgetType;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  order: number;
}

/** 单个字段 schema */
interface SchemaField {
  name: string;
  type: FieldType;
  required: boolean;
  default: unknown;
  description: string;
  ui?: FieldUi;
}

/** 整个 schema 文档 */
interface ConfigSchema {
  module: string;
  description: string;
  fields: SchemaField[];
}

// --- 工具函数 ---

/**
 * 把模块名转为 PascalCase：model → Model
 * 用于生成 TypeScript 接口名（ModelConfig）
 */
function toPascalCase(name: string): string {
  // 处理 kebab-case / snake_case / 单词
  const parts = name.split(/[-_]/).filter(Boolean);
  if (parts.length === 1) {
    // 单词：首字母大写
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * 把模块名转为大写蛇形：model → MODEL
 * 用于生成默认值常量名 DEFAULT_MODEL_CONFIG
 */
function toScreamingSnake(name: string): string {
  return name.replace(/[-_]/g, '_').toUpperCase();
}

/** 把默认值序列化为 TS 字面量（处理字符串引号、数字、布尔） */
function literal(value: unknown): string {
  if (typeof value === 'string') {
    // 用 JSON.stringify 保证字符串引号和转义正确
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value) || typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

// --- 三端产物生成 ---

/**
 * 生成 TypeScript 类型定义文件内容
 * - required 字段：name: type
 * - optional 字段：name?: type
 */
function generateTypes(schema: ConfigSchema): string {
  const interfaceName = `${toPascalCase(schema.module)}Config`;
  const lines: string[] = [];
  lines.push(`// 由 tools/config-gen.ts 自动生成——请勿手动编辑`);
  lines.push(`// 源文件：tools/config-schema.yaml（module: ${schema.module}）`);
  lines.push(`// Phase 75-B8：配置 schema 单一真相源试点产物`);
  lines.push('');
  lines.push(`/** ${schema.description} */`);
  lines.push(`export interface ${interfaceName} {`);
  for (const field of schema.fields) {
    const optionalMark = field.required ? '' : '?';
    const comment = `  /** ${field.description} */`;
    lines.push(comment);
    lines.push(`  ${field.name}${optionalMark}: ${field.type};`);
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成默认值常量文件内容
 * 输出：export const DEFAULT_${MODULE}_CONFIG: ${Module}Config = { ... }
 */
function generateDefaults(schema: ConfigSchema): string {
  const interfaceName = `${toPascalCase(schema.module)}Config`;
  const constName = `DEFAULT_${toScreamingSnake(schema.module)}_CONFIG`;
  const lines: string[] = [];
  lines.push(`// 由 tools/config-gen.ts 自动生成——请勿手动编辑`);
  lines.push(`// 源文件：tools/config-schema.yaml（module: ${schema.module}）`);
  lines.push(`// Phase 75-B8：配置 schema 单一真相源试点产物`);
  lines.push('');
  lines.push(`import type { ${interfaceName} } from './${schema.module}.types.js';`);
  lines.push('');
  lines.push(`/** ${schema.description}（默认值） */`);
  lines.push(`export const ${constName}: ${interfaceName} = {`);
  for (const field of schema.fields) {
    lines.push(`  ${field.name}: ${literal(field.default)},`);
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成 UI 字段描述 JSON
 * 按 ui.order 升序排序，输出 [{name, label, widget, ...}, ...]
 */
function generateUiFields(schema: ConfigSchema): string {
  const items = schema.fields
    .filter((f) => f.ui)
    .map((f) => ({
      name: f.name,
      description: f.description,
      required: f.required,
      type: f.type,
      default: f.default,
      ...f.ui,
    }))
    .sort((a, b) => (a.order as number) - (b.order as number));
  // JSON.stringify 第四个参数为 2 → 2 空格缩进
  const json = JSON.stringify(items, null, 2);
  // 末尾换行保持文件规范
  return `${json}\n`;
}

// --- 主函数 ---

function main(): void {
  // 解析命令行参数：默认 schema 路径与输出目录
  const schemaPath = process.argv[2] ?? 'tools/config-schema.yaml';
  const outputDir = process.argv[3] ?? 'src/config/generated';

  const absSchemaPath = resolve(schemaPath);
  const absOutputDir = resolve(outputDir);

  // 读取并解析 YAML schema
  let raw: string;
  try {
    raw = readFileSync(absSchemaPath, 'utf-8');
  } catch (err) {
    console.error(`[config-gen] 无法读取 schema 文件：${absSchemaPath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let schema: ConfigSchema;
  try {
    schema = parseYaml(raw) as ConfigSchema;
  } catch (err) {
    console.error(`[config-gen] YAML 解析失败：${absSchemaPath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 基础校验
  if (!schema || !schema.module || !Array.isArray(schema.fields) || schema.fields.length === 0) {
    console.error(`[config-gen] schema 缺少必要字段（module / fields）`);
    process.exit(1);
  }

  // 创建输出目录
  mkdirSync(absOutputDir, { recursive: true });

  // 生成三端产物
  const typesContent = generateTypes(schema);
  const defaultsContent = generateDefaults(schema);
  const uiFieldsContent = generateUiFields(schema);

  const typesPath = join(absOutputDir, `${schema.module}.types.ts`);
  const defaultsPath = join(absOutputDir, `${schema.module}.defaults.ts`);
  const uiFieldsPath = join(absOutputDir, `${schema.module}.ui-fields.json`);

  writeFileSync(typesPath, typesContent, 'utf-8');
  writeFileSync(defaultsPath, defaultsContent, 'utf-8');
  writeFileSync(uiFieldsPath, uiFieldsContent, 'utf-8');

  console.log(`[config-gen] 生成完成（module=${schema.module}, fields=${schema.fields.length}）`);
  console.log(`  → ${typesPath}`);
  console.log(`  → ${defaultsPath}`);
  console.log(`  → ${uiFieldsPath}`);
}

// ESM 入口判定
const isMain = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}

export { generateTypes, generateDefaults, generateUiFields };
export type { ConfigSchema, SchemaField, FieldUi, FieldType, WidgetType };
