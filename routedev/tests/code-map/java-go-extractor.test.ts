// tests/code-map/java-go-extractor.test.ts
// 短板 2：Java / Go 语言符号提取测试

import { describe, it, expect, beforeEach } from 'vitest';
import { initParser, parseFile } from '../../src/code-map/parser.js';
import { extractFromTree } from '../../src/code-map/extractor.js';

beforeEach(async () => {
  await initParser();
});

describe('Java extractor', () => {
  it('1. 提取 class + extends + implements', async () => {
    const code = `import java.util.List;
public class Foo extends Bar implements Baz {
  public void doSomething() {}
}`;
    const r = await parseFile('Test.java', code);
    expect(r).not.toBeNull();
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const classes = extracted.nodes.filter(n => n.kind === 'class');
    expect(classes.length).toBe(1);
    expect(classes[0].name).toBe('Foo');
    expect(classes[0].extends).toContain('Bar');
    expect(classes[0].implements).toContain('Baz');
    expect(classes[0].visibility).toBe('public');
  });

  it('2. 提取 interface', async () => {
    const code = `interface Iface {
  void run();
}`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const interfaces = extracted.nodes.filter(n => n.kind === 'interface');
    expect(interfaces.length).toBe(1);
    expect(interfaces[0].name).toBe('Iface');
  });

  it('3. 提取 method（带 visibility、static）', async () => {
    const code = `public class Foo {
  public void doSomething() {}
  static String helper() { return ""; }
}`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const methods = extracted.nodes.filter(n => n.kind === 'method');
    expect(methods.length).toBe(2);
    const doSomething = methods.find(m => m.name === 'doSomething');
    expect(doSomething).toBeDefined();
    expect(doSomething!.visibility).toBe('public');
    expect(doSomething!.className).toBe('Foo');

    const helper = methods.find(m => m.name === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.static).toBe(true);
    expect(helper!.className).toBe('Foo');
  });

  it('4. 仅提取 public field（私有字段不提取）', async () => {
    const code = `public class Foo {
  public int pubField;
  private String privField;
}`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const fields = extracted.nodes.filter(n => n.kind === 'variable');
    expect(fields.length).toBe(1);
    expect(fields[0].name).toBe('pubField');
    expect(fields[0].visibility).toBe('public');
  });

  it('5. 提取 import（source module + imported name）', async () => {
    const code = `import java.util.List;`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const imports = extracted.nodes.filter(n => n.kind === 'import');
    expect(imports.length).toBe(1);
    expect(imports[0].sourceModule).toBe('java.util.List');
    expect(imports[0].importedNames).toContain('List');
  });

  it('6. CONTAINS 边（file → symbol）', async () => {
    const code = `public class Foo {}`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const containsEdges = extracted.edges.filter(e => e.kind === 'CONTAINS');
    expect(containsEdges.length).toBeGreaterThan(0);
    // file:test.java → Foo 节点
    const fooContains = containsEdges.find(e => e.target.includes(':Foo'));
    expect(fooContains).toBeDefined();
    expect(fooContains!.source).toBe('file:Test.java');
  });

  it('7. EXTENDS / IMPLEMENTS 边', async () => {
    const code = `public class Dog extends Animal implements IBark {}`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const extendsEdges = extracted.edges.filter(e => e.kind === 'EXTENDS');
    expect(extendsEdges.length).toBe(1);
    expect(extendsEdges[0].target).toBe('Animal');

    const implEdges = extracted.edges.filter(e => e.kind === 'IMPLEMENTS');
    expect(implEdges.length).toBe(1);
    expect(implEdges[0].target).toBe('IBark');
  });

  it('8. method_invocation 生成 CALLS（同文件方法调用）', async () => {
    const code = `public class Foo {
  public void caller() { helper(); }
  public void helper() {}
}`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    // 同文件内 helper 已定义，应直接生成 CALLS 边（target 是节点 ID）
    expect(callsEdges.length).toBe(1);
    expect(callsEdges[0].target).toContain(':Foo.helper');
    expect(callsEdges[0].source).toContain(':Foo.caller');
  });

  it('9. 未解析的 method 调用进入 unresolvedRefs', async () => {
    const code = `public class Foo {
  public void caller() { externalLib(); }
}`;
    const r = await parseFile('Test.java', code);
    const extracted = extractFromTree(r!.tree, 'Test.java', 'java');
    r!.tree.delete();

    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(0);
    expect(extracted.unresolvedRefs?.length).toBe(1);
    expect(extracted.unresolvedRefs![0].calleeName).toBe('externalLib');
  });
});

describe('Go extractor', () => {
  it('1. 提取 function', async () => {
    const code = `package main
func add(a, b int) int {
  return a + b
}`;
    const r = await parseFile('main.go', code);
    expect(r).not.toBeNull();
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const funcs = extracted.nodes.filter(n => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0].name).toBe('add');
  });

  it('2. 提取 method（带 receiver）', async () => {
    const code = `package main
type Dog struct {}
func (d Dog) Speak() string {
  return "woof"
}`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const methods = extracted.nodes.filter(n => n.kind === 'method');
    expect(methods.length).toBe(1);
    expect(methods[0].name).toBe('Speak');
    expect(methods[0].className).toBe('Dog');
    // 节点 ID 形式：main.go:N:Dog.Speak
    expect(methods[0].id).toContain('Dog.Speak');
  });

  it('3. 提取 struct（kind=class）', async () => {
    const code = `package main
type Animal struct {
  name string
}`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const classes = extracted.nodes.filter(n => n.kind === 'class');
    expect(classes.length).toBe(1);
    expect(classes[0].name).toBe('Animal');
  });

  it('4. 提取 interface', async () => {
    const code = `package main
type Speaker interface {
  Speak() string
}`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const interfaces = extracted.nodes.filter(n => n.kind === 'interface');
    expect(interfaces.length).toBe(1);
    expect(interfaces[0].name).toBe('Speaker');
  });

  it('5. 提取 import（source module）', async () => {
    const code = `package main
import "fmt"`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const imports = extracted.nodes.filter(n => n.kind === 'import');
    expect(imports.length).toBe(1);
    expect(imports[0].sourceModule).toBe('fmt');
    expect(imports[0].importedNames).toContain('fmt');
  });

  it('6. CONTAINS 边', async () => {
    const code = `package main
func main() {}`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const containsEdges = extracted.edges.filter(e => e.kind === 'CONTAINS');
    expect(containsEdges.length).toBeGreaterThan(0);
    const mainContains = containsEdges.find(e => e.target.includes(':main'));
    expect(mainContains).toBeDefined();
    expect(mainContains!.source).toBe('file:main.go');
  });

  it('7. struct 嵌入字段 → EXTENDS 边', async () => {
    const code = `package main
type Animal struct {}
type Dog struct {
  Animal
}`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const extendsEdges = extracted.edges.filter(e => e.kind === 'EXTENDS');
    // Dog 嵌入 Animal → EXTENDS 边
    expect(extendsEdges.length).toBe(1);
    expect(extendsEdges[0].target).toBe('Animal');
    expect(extendsEdges[0].source).toContain(':Dog');
  });

  it('8. call_expression 生成 CALLS（同文件函数调用）', async () => {
    const code = `package main
func helper() {}
func caller() { helper() }`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    // helper 在同文件定义，应直接生成 CALLS 边（target 是节点 ID）
    expect(callsEdges.length).toBe(1);
    expect(callsEdges[0].target).toContain(':helper');
    expect(callsEdges[0].source).toContain(':caller');
  });

  it('9. 未解析的 call 进入 unresolvedRefs', async () => {
    const code = `package main
func caller() { externalFunc() }`;
    const r = await parseFile('main.go', code);
    const extracted = extractFromTree(r!.tree, 'main.go', 'go');
    r!.tree.delete();

    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(0);
    expect(extracted.unresolvedRefs?.length).toBe(1);
    expect(extracted.unresolvedRefs![0].calleeName).toBe('externalFunc');
  });
});
