// tests/tools/repo-map-enhanced.test.ts
// Phase 39 Task 1：Repo Map 增强测试
// 覆盖：非导出函数 / 类成员方法 / import 依赖 / 装饰器 / 多语言（.py .java .go）/ analyzeImpact / 增量缓存

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractSignatures,
  incrementalScan,
  loadCache,
  saveCache,
  analyzeImpact,
  type RepoMapFileEntry,
} from '../../src/tools/repo-map.js';

let tempDir: string;

async function writeFile(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(tempDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-map-enhanced-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('extractSignatures - Phase 39 增强', () => {
  it('识别非导出函数 function foo() 和 const foo = () =>', () => {
    const src = `
      function helper() { return 1; }
      const arrow = () => 2;
      const asyncArrow = async () => 3;
      async function asyncHelper() { return 4; }
    `;
    const { signatures } = extractSignatures(src, 20, 80);
    // 非导出函数应出现在 signatures 中
    expect(signatures.some(s => s.includes('function helper'))).toBe(true);
    expect(signatures.some(s => s.includes('arrow'))).toBe(true);
    expect(signatures.some(s => s.includes('asyncArrow'))).toBe(true);
    expect(signatures.some(s => s.includes('async function asyncHelper'))).toBe(true);
  });

  it('识别类成员方法 class Foo { bar() {} }', () => {
    const src = `
      class Foo {
        bar() { return 1; }
        async baz() { return 2; }
        private qux() { return 3; }
      }
    `;
    const { signatures } = extractSignatures(src, 20, 80);
    expect(signatures.some(s => s.includes('bar'))).toBe(true);
    expect(signatures.some(s => s.includes('baz'))).toBe(true);
    expect(signatures.some(s => s.includes('qux'))).toBe(true);
  });

  it('提取 import 依赖为 FileDependency', () => {
    const src = `
      import { foo, bar } from './utils';
      import baz from './helper';
      import type { Type } from './types';
      import './side-effect';
      import * as ns from './namespace';
    `;
    const { dependencies } = extractSignatures(src, 20, 80);
    expect(dependencies.length).toBeGreaterThanOrEqual(4);
    const utilsDep = dependencies.find(d => d.target === './utils');
    expect(utilsDep).toBeDefined();
    expect(utilsDep!.symbols).toContain('foo');
    expect(utilsDep!.symbols).toContain('bar');
    const helperDep = dependencies.find(d => d.target === './helper');
    expect(helperDep).toBeDefined();
    expect(helperDep!.symbols).toContain('default');
    const sideEffectDep = dependencies.find(d => d.target === './side-effect');
    expect(sideEffectDep).toBeDefined();
    expect(sideEffectDep!.symbols).toHaveLength(0);
  });

  it('识别装饰器 @Component / @Injectable()', () => {
    const src = `
      @Component({ selector: 'app' })
      class AppComponent {}
      
      @Injectable()
      class AuthService {}
    `;
    const { signatures } = extractSignatures(src, 20, 80);
    expect(signatures.some(s => s.includes('@Component'))).toBe(true);
    expect(signatures.some(s => s.includes('@Injectable'))).toBe(true);
  });

  it('解析 .py 文件：def / class / import', () => {
    const src = `
import os
from typing import List, Dict

def calculate(x: int, y: int) -> int:
    return x + y

class Calculator:
    def add(self, a, b):
        return a + b
`;
    const { signatures, dependencies, language } = extractSignatures(src, 20, 80, 'python');
    expect(language).toBe('python');
    // def calculate 应被识别
    expect(signatures.some(s => s.includes('def calculate'))).toBe(true);
    // class Calculator 应被识别
    expect(signatures.some(s => s.includes('class Calculator'))).toBe(true);
    // import os 依赖
    expect(dependencies.some(d => d.target === 'os')).toBe(true);
    // from typing import List, Dict
    const typingDep = dependencies.find(d => d.target === 'typing');
    expect(typingDep).toBeDefined();
    expect(typingDep!.symbols).toContain('List');
    expect(typingDep!.symbols).toContain('Dict');
  });

  it('解析 .java 文件：class / method / import', () => {
    const src = `
package com.example;

import java.util.List;
import java.io.IOException;

public class UserService {
    public void addUser(String name) { }
    private int getCount() { return 0; }
    protected static String format(String s) { return s; }
}
`;
    const { exports, signatures, dependencies, language } = extractSignatures(src, 20, 80, 'java');
    expect(language).toBe('java');
    expect(exports).toContain('UserService');
    // 方法签名
    expect(signatures.some(s => s.includes('addUser'))).toBe(true);
    expect(signatures.some(s => s.includes('getCount'))).toBe(true);
    expect(signatures.some(s => s.includes('format'))).toBe(true);
    // import 依赖
    expect(dependencies.some(d => d.target === 'java.util.List')).toBe(true);
    expect(dependencies.some(d => d.target === 'java.io.IOException')).toBe(true);
  });

  it('解析 .go 文件：func / type / import', () => {
    const src = `
package main

import (
    "fmt"
    "strings"
)

func main() {
    fmt.Println("hello")
}

func Add(a int, b int) int {
    return a + b
}

type Calculator struct {
    result int
}

type Handler interface {
    Handle(msg string)
}
`;
    const { exports, signatures, dependencies, language } = extractSignatures(src, 20, 80, 'go');
    expect(language).toBe('go');
    // Add 是导出的（首字母大写）
    expect(exports).toContain('Add');
    // Calculator / Handler 是导出的
    expect(exports).toContain('Calculator');
    expect(exports).toContain('Handler');
    // main 是非导出的（首字母小写）
    expect(signatures.some(s => s.includes('func main'))).toBe(true);
    // import 依赖
    expect(dependencies.some(d => d.target === 'fmt')).toBe(true);
    expect(dependencies.some(d => d.target === 'strings')).toBe(true);
  });

  it('analyzeImpact 反向 BFS：收集所有间接依赖者', () => {
    // 构建依赖链：a.ts → b.ts → c.ts
    // c.ts 变更后，a.ts 和 b.ts 受影响
    const entries: RepoMapFileEntry[] = [
      {
        path: 'src/a.ts',
        exports: ['a'],
        signatures: ['export function a() {}'],
        dependencies: [{ target: './b', symbols: ['b'] }],
        language: 'typescript',
      },
      {
        path: 'src/b.ts',
        exports: ['b'],
        signatures: ['export function b() {}'],
        dependencies: [{ target: './c', symbols: ['c'] }],
        language: 'typescript',
      },
      {
        path: 'src/c.ts',
        exports: ['c'],
        signatures: ['export function c() {}'],
        dependencies: [],
        language: 'typescript',
      },
    ];

    const result = analyzeImpact(entries, 'src/c.ts', 3);
    expect(result.affectedFiles).toContain('src/b.ts');
    expect(result.affectedFiles).toContain('src/a.ts');
    expect(result.depth).toBeGreaterThanOrEqual(2);
  });

  it('analyzeImpact maxDepth 限制搜索深度', () => {
    // a → b → c → d
    const entries: RepoMapFileEntry[] = [
      {
        path: 'a.ts',
        exports: [],
        signatures: [],
        dependencies: [{ target: './b', symbols: [] }],
      },
      {
        path: 'b.ts',
        exports: [],
        signatures: [],
        dependencies: [{ target: './c', symbols: [] }],
      },
      {
        path: 'c.ts',
        exports: [],
        signatures: [],
        dependencies: [{ target: './d', symbols: [] }],
      },
      {
        path: 'd.ts',
        exports: [],
        signatures: [],
        dependencies: [],
      },
    ];

    // depth=1：只能找到直接依赖者 c.ts
    const d1 = analyzeImpact(entries, 'd.ts', 1);
    expect(d1.affectedFiles).toEqual(['c.ts']);
    expect(d1.depth).toBe(1);

    // depth=2：找到 c.ts 和 b.ts
    const d2 = analyzeImpact(entries, 'd.ts', 2);
    expect(d2.affectedFiles).toContain('c.ts');
    expect(d2.affectedFiles).toContain('b.ts');
    expect(d2.affectedFiles).not.toContain('a.ts');

    // depth=3：找到 c.ts, b.ts, a.ts
    const d3 = analyzeImpact(entries, 'd.ts', 3);
    expect(d3.affectedFiles).toContain('a.ts');
  });

  it('增量缓存：mtime 比对，未变更文件用缓存', async () => {
    await writeFile('a.ts', 'export function a() {}');
    await writeFile('b.ts', 'export function b() {}');

    // 首次扫描：全量解析
    const first = await incrementalScan(tempDir, { maxFiles: 10 });
    expect(first.length).toBe(2);

    // 缓存文件应存在
    const cachePath = path.join(tempDir, '.routedev', 'repo-map-cache.json');
    expect(fsSync.existsSync(cachePath)).toBe(true);

    // 加载缓存
    const cached = loadCache(cachePath);
    expect(cached).not.toBeNull();
    expect(cached!.length).toBe(2);

    // 第二次扫描：未变更，应使用缓存
    const second = await incrementalScan(tempDir, { maxFiles: 10 });
    expect(second.length).toBe(2);
    expect(second.map(e => e.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('增量缓存：文件变更后重新解析', async () => {
    await writeFile('a.ts', 'export function oldName() {}');

    // 首次扫描
    const first = await incrementalScan(tempDir, { maxFiles: 10 });
    expect(first[0].exports).toContain('oldName');

    // 等待一小段时间确保 mtime 变化
    await new Promise(resolve => setTimeout(resolve, 50));

    // 修改文件
    await writeFile('a.ts', 'export function newName() {}');

    // 第二次扫描：应检测到变更并重新解析
    const second = await incrementalScan(tempDir, { maxFiles: 10 });
    expect(second[0].exports).toContain('newName');
    expect(second[0].exports).not.toContain('oldName');
  });

  it('loadCache / saveCache 往返一致性', () => {
    const cachePath = path.join(tempDir, '.routedev', 'test-cache.json');
    const entries: RepoMapFileEntry[] = [
      {
        path: 'src/test.ts',
        exports: ['foo'],
        signatures: ['export function foo() {}'],
        dependencies: [{ target: './bar', symbols: ['bar'] }],
        language: 'typescript',
      },
    ];

    saveCache(cachePath, entries, { 'src/test.ts': 1234567890 });
    const loaded = loadCache(cachePath);
    expect(loaded).not.toBeNull();
    expect(loaded![0].path).toBe('src/test.ts');
    expect(loaded![0].exports).toContain('foo');
    expect(loaded![0].dependencies).toBeDefined();
    expect(loaded![0].dependencies![0].target).toBe('./bar');
  });

  it('loadCache 版本不匹配返回 null', () => {
    const cachePath = path.join(tempDir, '.routedev', 'bad-cache.json');
    const dir = path.dirname(cachePath);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    // 写入错误版本的缓存
    fsSync.writeFileSync(cachePath, JSON.stringify({
      version: 'wrong-version',
      entries: [],
      mtimes: {},
    }), 'utf-8');

    const loaded = loadCache(cachePath);
    expect(loaded).toBeNull();
  });
});
