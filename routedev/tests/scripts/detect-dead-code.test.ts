// tests/scripts/detect-dead-code.test.ts
// Phase 71 Task F1：验证死代码检测脚本 detect-dead-code.ts 的正确性

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  collectTsFiles,
  isEntryFile,
  extractExports,
  findSymbolConsumption,
  detectDeadCode,
  type ExportKind,
  type ExportItem,
  type DeadExport,
  type DeadCodeReport,
} from '../../scripts/detect-dead-code.js';

// ============================================================
// 测试夹具：在临时目录构造最小项目结构
// ============================================================

let tmpRoot: string;

/** 创建临时项目根目录 */
function setupProject(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-dead-code-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
  return tmpRoot;
}

/** 在临时项目中写入文件（relPath 相对 tmpRoot） */
function writeFile(relPath: string, content: string): string {
  const full = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  tmpRoot = '';
});

// ============================================================
// 用例
// ============================================================

describe('detect-dead-code.ts', () => {
  describe('用例 1：extractExports 正确解析各类 export', () => {
    it('解析 function / const / class / interface / type / enum / default', () => {
      const content = [
        'export function foo() {}',
        'export const bar = 1;',
        'export class Baz {}',
        'export interface Qux {}',
        'export type Quux = number;',
        'export enum Corge { A, B }',
        'export default function defaultFn() {}',
      ].join('\n');
      const items = extractExports(content, '/tmp/x.ts');
      const map = new Map(items.map(i => [i.name, i.kind]));

      expect(map.get('foo')).toBe('function');
      expect(map.get('bar')).toBe('const');
      expect(map.get('Baz')).toBe('class');
      expect(map.get('Qux')).toBe('interface');
      expect(map.get('Quux')).toBe('type');
      expect(map.get('Corge')).toBe('enum');
      // 默认导出的命名函数
      expect(map.get('defaultFn')).toBe('default');
    });

    it('解析 export { foo, bar as baz } 形式（标 reexport）', () => {
      const content = 'function a() {}\nconst b = 1;\nexport { a, b };';
      const items = extractExports(content, '/tmp/x.ts');
      const names = items.map(i => i.name).sort();
      expect(names).toEqual(['a', 'b']);
      // 这些是 export {} 形式，未与具名 export 重叠时应标 reexport
      expect(items.every(i => i.kind === 'reexport')).toBe(true);
    });
  });

  describe('用例 2：findSymbolConsumption 正确解析 import', () => {
    it('src 中 import 算 src 消费', () => {
      const root = setupProject();
      const definer = writeFile('src/lib/util.ts', 'export function helper() {}');
      writeFile('src/lib/consumer.ts', "import { helper } from './util.js';\nhelper();");

      const srcFiles = collectTsFiles(path.join(root, 'src'));
      const testFiles = collectTsFiles(path.join(root, 'tests'));
      const result = findSymbolConsumption('helper', srcFiles, testFiles, definer);
      expect(result).toBe('src');
    });

    it('仅 tests 中 import 算 test 消费', () => {
      const root = setupProject();
      const definer = writeFile('src/lib/util.ts', 'export function helper() {}');
      writeFile('tests/lib/util.test.ts', "import { helper } from '../../src/lib/util.js';\nhelper();");

      const srcFiles = collectTsFiles(path.join(root, 'src'));
      const testFiles = collectTsFiles(path.join(root, 'tests'));
      const result = findSymbolConsumption('helper', srcFiles, testFiles, definer);
      expect(result).toBe('test');
    });

    it('无任何 import 算 none', () => {
      const root = setupProject();
      const definer = writeFile('src/lib/util.ts', 'export function helper() {}');
      writeFile('src/lib/other.ts', '// 完全不引用 helper\nexport function other() {}');

      const srcFiles = collectTsFiles(path.join(root, 'src'));
      const testFiles = collectTsFiles(path.join(root, 'tests'));
      const result = findSymbolConsumption('helper', srcFiles, testFiles, definer);
      expect(result).toBe('none');
    });
  });

  describe('用例 3：入口文件白名单生效', () => {
    it('isEntryFile 识别 index.ts / app-init.ts / main.tsx 等', () => {
      expect(isEntryFile('/proj/src/index.ts')).toBe(true);
      expect(isEntryFile('/proj/src/cli/app-init.ts')).toBe(true);
      expect(isEntryFile('/proj/src/main.tsx')).toBe(true);
      expect(isEntryFile('/proj/src/App.tsx')).toBe(true);
      expect(isEntryFile('/proj/src/cli/server.ts')).toBe(true);
    });

    it('detectDeadCode 跳过入口文件的 export（不计入 dead）', () => {
      const root = setupProject();
      // 入口文件 export，但无人 import —— 应被白名单跳过
      writeFile('src/index.ts', 'export function cliEntry() {}\nexport const VERSION = "1.0";');
      // 普通文件 export，无人 import —— 应被检出为 dead
      writeFile('src/lib/orphan.ts', 'export function orphanFn() {}');

      const report = detectDeadCode(root);

      // 入口文件应出现在 entryFiles
      expect(report.entryFiles).toContain('src/index.ts');

      // cliEntry / VERSION 不应出现在 deadExports
      const deadNames = report.deadExports.map(d => d.name);
      expect(deadNames).not.toContain('cliEntry');
      expect(deadNames).not.toContain('VERSION');

      // orphanFn 应被检出
      expect(deadNames).toContain('orphanFn');
    });
  });

  describe('用例 4：test-only 消费标记正确', () => {
    it('只在 tests 中被 import 的 export 计入 testOnlyExports，不计入 deadExports', () => {
      const root = setupProject();
      writeFile('src/lib/feature.ts', 'export function testOnlyFn() {}');
      writeFile('tests/lib/feature.test.ts', "import { testOnlyFn } from '../../src/lib/feature.js';\ntestOnlyFn();");

      const report = detectDeadCode(root);

      const testOnlyNames = report.testOnlyExports.map(d => d.name);
      const deadNames = report.deadExports.map(d => d.name);

      expect(testOnlyNames).toContain('testOnlyFn');
      expect(deadNames).not.toContain('testOnlyFn');
    });
  });

  describe('用例 5：真实死代码被检出', () => {
    it('src 与 tests 中均无 import 的 export 计入 deadExports', () => {
      const root = setupProject();
      writeFile('src/lib/zombie.ts', [
        'export function zombieFn() {}',
        'export const ZOMBIE_CONST = 42;',
        'export class ZombieClass {}',
        'export interface ZombieIface {}',
        'export type ZombieType = string;',
      ].join('\n'));
      // 不创建任何引用文件

      const report = detectDeadCode(root);

      const deadNames = report.deadExports.map(d => d.name);
      expect(deadNames).toContain('zombieFn');
      expect(deadNames).toContain('ZOMBIE_CONST');
      expect(deadNames).toContain('ZombieClass');
      expect(deadNames).toContain('ZombieIface');
      expect(deadNames).toContain('ZombieType');

      // type 字段正确
      const fnItem = report.deadExports.find(d => d.name === 'zombieFn');
      expect(fnItem?.type).toBe('function');
      const typeItem = report.deadExports.find(d => d.name === 'ZombieType');
      expect(typeItem?.type).toBe('type');

      // 文件路径是相对项目根的 POSIX 风格
      expect(fnItem?.file).toBe('src/lib/zombie.ts');
    });

    it('detectDeadCode 报告结构完整（totalExports / entryFiles 等）', () => {
      const root = setupProject();
      writeFile('src/index.ts', 'export function entry() {}');
      writeFile('src/lib/a.ts', 'export function a() {}');
      writeFile('src/lib/b.ts', "import { a } from './a.js';\nexport function b() { a(); }");

      const report: DeadCodeReport = detectDeadCode(root);

      expect(report).toHaveProperty('totalExports');
      expect(report).toHaveProperty('deadExports');
      expect(report).toHaveProperty('testOnlyExports');
      expect(report).toHaveProperty('entryFiles');
      expect(typeof report.totalExports).toBe('number');
      expect(Array.isArray(report.deadExports)).toBe(true);
      expect(Array.isArray(report.testOnlyExports)).toBe(true);
      expect(Array.isArray(report.entryFiles)).toBe(true);
      // 至少有 index.ts 入口
      expect(report.entryFiles.length).toBeGreaterThan(0);

      // 验证类型别名可访问（避免类型 export 成死代码）
      const kind: ExportKind = 'function';
      const item: ExportItem = { file: '/x', name: 'n', kind };
      const dead: DeadExport = { file: 'x', name: 'n', type: kind };
      expect(item.kind).toBe(kind);
      expect(dead.type).toBe(kind);
    });
  });

  describe('fail-open 行为', () => {
    it('rootPath 不存在时返回空报告，不抛错', () => {
      const report = detectDeadCode('/nonexistent/path/that/does/not/exist');
      expect(report.totalExports).toBe(0);
      expect(report.deadExports).toEqual([]);
      expect(report.testOnlyExports).toEqual([]);
      expect(report.entryFiles).toEqual([]);
    });
  });
});
