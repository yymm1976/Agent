import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'dead-code-report.json');

const report = JSON.parse(fs.readFileSync(REPORT, 'utf-8'));
const deadExports: Array<{ file: string; name: string; type: string }> = report.deadExports || [];

const runtimeTypes = new Set(['function', 'const', 'class', 'let', 'var']);
const runtimeDead = deadExports.filter(e => runtimeTypes.has(e.type));

// Group runtime dead exports by file
const byFile = new Map<string, typeof deadExports>();
for (const e of runtimeDead) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file)!.push(e);
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'release-v*'].includes(ent.name)) continue;
      listTsFiles(full, out);
    } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const srcFiles = listTsFiles(path.join(ROOT, 'src'));
const desktopFiles = listTsFiles(path.join(ROOT, 'desktop'));
const testFiles = listTsFiles(path.join(ROOT, 'tests')).concat(listTsFiles(path.join(ROOT, 'test')));

const allProdFiles = srcFiles.concat(desktopFiles);
const prodContents = new Map<string, string>();
for (const f of allProdFiles) {
  prodContents.set(f, fs.readFileSync(f, 'utf-8'));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countRefs(pattern: string, excludeFile: string): { total: number; files: number } {
  const re = new RegExp(pattern, 'g');
  let total = 0;
  let files = 0;
  for (const [f, content] of prodContents) {
    if (f === excludeFile) continue;
    const m = content.match(re);
    if (m) {
      total += m.length;
      files++;
    }
  }
  return { total, files };
}

function getAllRuntimeExports(filePath: string): Array<{ name: string; type: string }> {
  const srcText = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, srcText, ts.ScriptTarget.Latest, true);
  const exports: Array<{ name: string; type: string }> = [];

  function visit(node: ts.Node) {
    if (ts.isExportDeclaration(node)) {
      // re-exports: export { foo }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          exports.push({ name: el.name.text, type: 'reexport' });
        }
      }
    } else if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node);
      const isExported = modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          exports.push({ name: node.name.text, type: 'function' });
        } else if (ts.isClassDeclaration(node) && node.name) {
          exports.push({ name: node.name.text, type: 'class' });
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              const kind = node.declarationList.flags & ts.NodeFlags.Const ? 'const' :
                           node.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
              exports.push({ name: decl.name.text, type: kind });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return exports;
}

const results: Array<{
  file: string;
  exports: Array<{ name: string; type: string }>;
  staticHits: number;
  dynamicHits: number;
  dirHits: number;
  nameHits: Record<string, number>;
  nameTotal: number;
  testRefs: number;
}> = [];

for (const [file, _] of byFile) {
  const absFile = path.join(ROOT, file);
  if (!fs.existsSync(absFile)) continue;

  const allExports = getAllRuntimeExports(absFile);
  const modName = file.replace(/^src\//, '').replace(/\.ts$/, '');
  const fileBase = path.basename(file, '.ts');
  const dirRef = path.dirname(file).replace(/\\/g, '/');

  const staticPattern = `from ['"][^'"]*${escapeRegex(modName)}(\\.js)?['"]`;
  const staticHits = countRefs(staticPattern, absFile);

  const dynamicPattern = `import\\([^)]*${escapeRegex(fileBase)}[^)]*\\)`;
  const dynamicHits = countRefs(dynamicPattern, absFile);

  const dirHits = countRefs(escapeRegex(dirRef), absFile);

  const nameHits: Record<string, number> = {};
  let nameTotal = 0;
  for (const e of allExports) {
    const hits = countRefs(`\\b${escapeRegex(e.name)}\\b`, absFile);
    nameHits[e.name] = hits.total;
    nameTotal += hits.total;
  }

  let testRefs = 0;
  for (const tf of testFiles) {
    if (tf === absFile) continue;
    const content = fs.readFileSync(tf, 'utf-8');
    for (const e of allExports) {
      const re = new RegExp(`\\b${escapeRegex(e.name)}\\b`, 'g');
      const m = content.match(re);
      if (m) testRefs += m.length;
    }
  }

  results.push({
    file,
    exports: allExports,
    staticHits: staticHits.total,
    dynamicHits: dynamicHits.total,
    dirHits: dirHits.total,
    nameHits,
    nameTotal,
    testRefs,
  });
}

results.sort((a, b) => a.nameTotal - b.nameTotal);

console.log('=== True-Dead candidate files (all runtime exports have 0 external prod references, no static/dynamic imports) ===');
for (const r of results) {
  if (r.nameTotal === 0 && r.staticHits === 0 && r.dynamicHits === 0) {
    console.log(`\n${r.file}`);
    console.log(`  exports: ${r.exports.map(e => `${e.name}(${e.type})`).join(', ')}`);
    console.log(`  static import hits: ${r.staticHits}, dynamic import hits: ${r.dynamicHits}, external name refs: ${r.nameTotal}, test refs: ${r.testRefs}`);
  }
}

console.log('\n=== Files with runtime dead exports and reference counts ===');
for (const r of results.slice(0, 120)) {
  const isCandidate = r.nameTotal === 0 && r.staticHits === 0 && r.dynamicHits === 0;
  console.log(`${isCandidate ? '[CANDIDATE]' : '           '} ${r.file} | static=${r.staticHits} dynamic=${r.dynamicHits} names=${r.nameTotal} tests=${r.testRefs}`);
  for (const [n, c] of Object.entries(r.nameHits)) {
    if (isCandidate || c < 3) console.log(`             - ${n}: ${c}`);
  }
}
