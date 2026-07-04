// tests/code-map/extractor-refs.test.ts
// CALLS 边解析测试：验证 pendingReferences 机制 + unresolvedRefs 收集

import { describe, it, expect, beforeEach } from 'vitest';
import { initParser, parseFile } from '../../src/code-map/parser.js';
import { extractFromTree } from '../../src/code-map/extractor.js';

beforeEach(async () => {
  await initParser();
});

describe('extractor-refs', () => {
  // 1. 同文件函数调用生成 CALLS 边（target 是节点 ID，不是裸名字）
  it('1. 同文件函数调用生成 CALLS 边（target 是节点 ID）', async () => {
    const code = `function foo() {}\nfunction bar() { foo(); }`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(1);
    // target 应为节点 ID（filePath:startLine:name），不是字符串 "foo"
    expect(callsEdges[0].target).toBe('test.ts:0:foo');
    expect(callsEdges[0].source).toBe('test.ts:1:bar');
    // 防御：target 不应是裸名字
    expect(callsEdges[0].target).not.toBe('foo');
  });

  // 2. exported 函数被调用生成 CALLS 边（跨文件 exported 匹配条件）
  it('2. exported 函数被调用生成 CALLS 边（target 是节点 ID）', async () => {
    const code = `export function foo() {}\nexport function bar() { foo(); }`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(1);
    expect(callsEdges[0].target).toBe('test.ts:0:foo');
    expect(callsEdges[0].source).toBe('test.ts:1:bar');
    // foo 是 exported，匹配条件 n.exported === true 应满足
    const fooNode = extracted.nodes.find(n => n.name === 'foo');
    expect(fooNode?.exported).toBe(true);
  });

  // 3. 未解析的调用（callee 在本文件无定义）进入 unresolvedRefs
  it('3. 未解析的调用进入 unresolvedRefs', async () => {
    const code = `function bar() { undefinedFunc(); }`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(0);
    expect(extracted.unresolvedRefs).toBeDefined();
    expect(extracted.unresolvedRefs!.length).toBe(1);
    expect(extracted.unresolvedRefs![0].calleeName).toBe('undefinedFunc');
    expect(extracted.unresolvedRefs![0].sourceId).toBe('test.ts:0:bar');
    expect(extracted.unresolvedRefs![0].filePath).toBe('test.ts');
    expect(extracted.unresolvedRefs![0].line).toBe(1); // 1-based
  });

  // 4. findEnclosingSymbol 范围判断正确（多行函数体内调用，source 指向该函数）
  it('4. findEnclosingSymbol 范围判断正确（多行函数体内调用）', async () => {
    const code = `function foo() {\n  const x = 1;\n  bar();\n  return x;\n}\nfunction bar() {}`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(1);
    // call bar() 在 line 2，应被 foo（startLine 0, endLine 4）包含，source 是 foo
    expect(callsEdges[0].source).toBe('test.ts:0:foo');
    expect(callsEdges[0].target).toBe('test.ts:5:bar');
  });

  // 5. 嵌套函数调用的 enclosing 指向最内层
  it('5. 嵌套函数调用的 enclosing 指向最内层', async () => {
    const code = `function outer() {\n  function inner() {\n    helper();\n  }\n}\nfunction helper() {}`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(1);
    // call helper() 在 line 2，enclosing 应是 inner（startLine 1）而非 outer（startLine 0）
    expect(callsEdges[0].source).toBe('test.ts:1:inner');
    expect(callsEdges[0].target).toBe('test.ts:5:helper');
    // 防御：source 不应是 outer
    expect(callsEdges[0].source).not.toBe('test.ts:0:outer');
  });

  // 6. 方法定义调用生成 CALLS 边（source 是 method 节点 ID：filePath:line:Class.method）
  it('6. 方法定义调用生成 CALLS 边', async () => {
    const code = `function helper() {}\nclass Foo {\n  bar() { helper(); }\n}`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(1);
    // method bar 的节点 ID 形式：test.ts:2:Foo.bar
    expect(callsEdges[0].source).toBe('test.ts:2:Foo.bar');
    expect(callsEdges[0].target).toBe('test.ts:0:helper');
  });

  // 7. 递归调用（自调用）正确处理：source 和 target 都是同一节点 ID
  it('7. 递归调用（自调用）正确处理', async () => {
    const code = `function foo() { foo(); }`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(1);
    expect(callsEdges[0].source).toBe('test.ts:0:foo');
    expect(callsEdges[0].target).toBe('test.ts:0:foo');
    expect(callsEdges[0].source).toBe(callsEdges[0].target);
    // 自调用不应进入 unresolvedRefs
    expect(extracted.unresolvedRefs?.length ?? 0).toBe(0);
  });

  // 8. 空 calleeName 跳过（无 call_expression 时 CALLS 边与 unresolvedRefs 都为空）
  it('8. 空 calleeName 跳过（无 call_expression 不产生引用）', async () => {
    const code = `function foo() { return 1; }`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(0);
    // unresolvedRefs 应为空数组（非 undefined），验证防御性初始化
    expect(extracted.unresolvedRefs).toEqual([]);
  });
});
