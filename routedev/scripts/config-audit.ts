import ts from 'typescript';
import fs from 'node:fs';

const defaultsPath = 'src/config/defaults.ts';
const appInitPath = 'src/runtime/app-init.ts';

const defaultsSrc = fs.readFileSync(defaultsPath, 'utf-8');
const appInitSrc = fs.readFileSync(appInitPath, 'utf-8');

const defaultsSourceFile = ts.createSourceFile(
  defaultsPath,
  defaultsSrc,
  ts.ScriptTarget.Latest,
  true,
);
const appInitSourceFile = ts.createSourceFile(
  appInitPath,
  appInitSrc,
  ts.ScriptTarget.Latest,
  true,
);

// Extract leaf paths from DEFAULT_CONFIG object literal
function extractLeafPaths(node: ts.Node, prefix: string[] = []): string[] {
  if (ts.isObjectLiteralExpression(node)) {
    const paths: string[] = [];
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const key = prop.name.text;
        if (ts.isObjectLiteralExpression(prop.initializer) || ts.isArrayLiteralExpression(prop.initializer)) {
          paths.push(...extractLeafPaths(prop.initializer, [...prefix, key]));
        } else {
          paths.push([...prefix, key].join('.'));
        }
      }
    }
    return paths;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return [prefix.join('.')];
  }
  return [prefix.join('.')];
}

let defaultConfigNode: ts.ObjectLiteralExpression | undefined;
function findDefaultConfig(node: ts.Node): void {
  if (defaultConfigNode) return;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'DEFAULT_CONFIG' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    defaultConfigNode = node.initializer;
  }
  ts.forEachChild(node, findDefaultConfig);
}
findDefaultConfig(defaultsSourceFile);

const leafPaths: string[] = defaultConfigNode ? extractLeafPaths(defaultConfigNode) : [];

const configRefs = new Set<string>();

function walkForConfigRefs(node: ts.Node): void {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const chain: string[] = [];
    let current: ts.Expression = node;
    while (true) {
      if (ts.isPropertyAccessExpression(current)) {
        chain.unshift(current.name.text);
        current = current.expression;
      } else if (ts.isElementAccessExpression(current) && ts.isStringLiteral(current.argumentExpression)) {
        chain.unshift(current.argumentExpression.text);
        current = current.expression;
      } else if (ts.isIdentifier(current)) {
        chain.unshift(current.text);
        break;
      } else {
        break;
      }
    }
    if (chain[0] === 'config') {
      for (let i = 1; i <= chain.length; i++) {
        configRefs.add(chain.slice(0, i).join('.'));
      }
    }
  }
  ts.forEachChild(node, walkForConfigRefs);
}
walkForConfigRefs(appInitSourceFile);

const sortedRefs = Array.from(configRefs).sort();

console.log('=== app-init.ts config references (unique prefixes) ===');
for (const ref of sortedRefs) {
  console.log(ref);
}

console.log('\n=== defaults.ts leaf paths not referenced in app-init.ts ===');
const missing: string[] = [];
for (const p of leafPaths) {
  const full = 'config.' + p;
  const found = sortedRefs.some(ref => ref === full || ref.startsWith(full + '.') || full.startsWith(ref + '.'));
  if (!found) {
    missing.push(p);
  }
}
for (const m of missing) {
  console.log(m);
}

console.log('\n=== summary ===');
console.log(`Total defaults leaf paths: ${leafPaths.length}`);
console.log(`Missing references: ${missing.length}`);
