// tests/tools/repo-map.test.ts
// Phase 34 Task 4：Repo Map 代码检索增强测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractSignatures, buildRepoMap, renderRepoMap } from '../../src/tools/repo-map.js';
import { RepoMapTool } from '../../src/tools/builtin/repo-map.js';

let tempDir: string;

async function writeFile(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(tempDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-map-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('extractSignatures', () => {
  it('提取 export function', () => {
    const src = `export function add(a: number, b: number): number { return a + b; }`;
    const { exports, signatures } = extractSignatures(src, 10, 80);
    expect(exports).toContain('add');
    expect(signatures[0]).toContain('export function add');
  });

  it('提取 export async function', () => {
    const src = `export async function fetchData(): Promise<string> { return ''; }`;
    const { exports } = extractSignatures(src, 10, 80);
    expect(exports).toContain('fetchData');
  });

  it('提取 export class / interface / type / enum', () => {
    const src = `
      export class User {}
      export interface Config {}
      export type ID = string;
      export enum Status { Active }
      export abstract class Base {}
    `;
    const { exports } = extractSignatures(src, 10, 80);
    expect(exports).toContain('User');
    expect(exports).toContain('Config');
    expect(exports).toContain('ID');
    expect(exports).toContain('Status');
    expect(exports).toContain('Base');
  });

  it('提取 export const / let / var', () => {
    const src = `
      export const PI = 3.14;
      export let counter = 0;
      export var name = 'route';
    `;
    const { exports } = extractSignatures(src, 10, 80);
    expect(exports).toContain('PI');
    expect(exports).toContain('counter');
    expect(exports).toContain('name');
  });

  it('提取 export { foo, bar } 命名导出', () => {
    const src = `export { foo, bar as baz };`;
    const { exports } = extractSignatures(src, 10, 80);
    expect(exports).toContain('foo');
    expect(exports).toContain('baz');
  });

  it('提取 export default', () => {
    const src = `export default function main() {}`;
    const { exports } = extractSignatures(src, 10, 80);
    expect(exports).toContain('main');
  });

  it('限制每个文件最大签名数', () => {
    const src = Array.from({ length: 5 }, (_, i) => `export function f${i}() {}`).join('\n');
    const { signatures } = extractSignatures(src, 2, 80);
    expect(signatures.length).toBe(2);
  });

  it('限制符号最大长度', () => {
    const longName = 'a'.repeat(100);
    const src = `export function ${longName}() {}`;
    const { exports } = extractSignatures(src, 10, 50);
    expect(exports[0].length).toBe(50);
  });

  it('跳过注释行', () => {
    const src = `// export function hidden() {}\nexport function visible() {}`;
    const { exports } = extractSignatures(src, 10, 80);
    expect(exports).not.toContain('hidden');
    expect(exports).toContain('visible');
  });
});

describe('buildRepoMap', () => {
  it('扫描目录并返回包含导出的文件条目', async () => {
    await writeFile('src/utils.ts', 'export function helper() {}');
    await writeFile('src/config.ts', 'export interface AppConfig {}');
    await writeFile('readme.md', '# ignore me');

    const entries = await buildRepoMap({ root: tempDir, maxFiles: 10 });
    expect(entries.length).toBe(2);
    expect(entries.map(e => e.path).sort()).toEqual(['src/config.ts', 'src/utils.ts']);
  });

  it('尊重 maxFiles 限制', async () => {
    await writeFile('a.ts', 'export function a() {}');
    await writeFile('b.ts', 'export function b() {}');
    await writeFile('c.ts', 'export function c() {}');

    const entries = await buildRepoMap({ root: tempDir, maxFiles: 2 });
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it('忽略 node_modules 目录', async () => {
    await writeFile('node_modules/lib/index.ts', 'export function hidden() {}');
    await writeFile('src/app.ts', 'export function app() {}');

    const entries = await buildRepoMap({ root: tempDir, maxFiles: 10 });
    expect(entries.map(e => e.path)).toContain('src/app.ts');
    expect(entries.map(e => e.path)).not.toContain(path.join('node_modules', 'lib', 'index.ts'));
  });

  it('按路径字母顺序排序', async () => {
    await writeFile('z.ts', 'export function z() {}');
    await writeFile('a.ts', 'export function a() {}');
    await writeFile('m.ts', 'export function m() {}');

    const entries = await buildRepoMap({ root: tempDir, maxFiles: 10 });
    const paths = entries.map(e => e.path);
    expect(paths).toEqual(paths.slice().sort());
  });

  it('自定义扩展名过滤', async () => {
    await writeFile('a.ts', 'export function a() {}');
    await writeFile('b.js', 'export function b() {}');

    const entries = await buildRepoMap({ root: tempDir, extensions: ['.ts'], maxFiles: 10 });
    expect(entries.map(e => e.path)).toEqual(['a.ts']);
  });
});

describe('renderRepoMap', () => {
  it('渲染条目数和签名', () => {
    const entries = [
      { path: 'a.ts', exports: ['foo'], signatures: ['export function foo() {}'] },
    ];
    const text = renderRepoMap(entries, 100);
    expect(text).toContain('代码地图');
    expect(text).toContain('a.ts');
    expect(text).toContain('export function foo() {}');
  });

  it('受 maxLines 限制截断', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      path: `${i}.ts`,
      exports: [`f${i}`],
      signatures: [`export function f${i}() {}`],
    }));
    const lines = renderRepoMap(entries, 10).split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
  });
});

describe('RepoMapTool', () => {
  it('正常执行返回代码地图', async () => {
    await writeFile('service.ts', 'export class UserService {}');
    const tool = new RepoMapTool();
    const result = await tool.execute(
      {},
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('UserService');
    expect(result.metadata?.fileCount).toBe(1);
  });

  it('扫描路径超出边界返回失败', async () => {
    const tool = new RepoMapTool();
    const result = await tool.execute(
      { path: '../outside' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('超出项目边界');
  });

  it('参数校验拒绝非数字 maxFiles', async () => {
    const tool = new RepoMapTool();
    const validation = tool.validateArgs({ maxFiles: 'ten' });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('maxFiles 必须是数字');
  });

  it('无匹配源文件时返回提示', async () => {
    await writeFile('readme.md', '# nothing');
    const tool = new RepoMapTool();
    const result = await tool.execute(
      {},
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('未找到可索引的源文件');
  });
});
