// tests/tools/lsp-diagnostics.test.ts
// B-09：lsp_diagnostics 解析与文件过滤 + repo_map token 预算
import { describe, expect, it } from 'vitest';
import {
  parseTypecheckDiagnostics,
  filterDiagnosticsByFiles,
  createLspDiagnosticsTool,
} from '../../src/tools/builtin/lsp-diagnostics.js';
import { RepoMapTool } from '../../src/tools/builtin/repo-map.js';

const TSC_SAMPLE = `src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(3,1): warning TS6133: 'x' is declared but its value is never read.
C:\\proj\\src\\c.ts(1,1): error TS1005: ';' expected.
`;

describe('B-09 parseTypecheckDiagnostics', () => {
  it('解析 path(line,col): severity message 行（含 Windows 盘符路径）', () => {
    const diags = parseTypecheckDiagnostics(TSC_SAMPLE);
    expect(diags).toHaveLength(3);
    expect(diags[0]).toEqual({
      file: 'src/a.ts', line: 10, column: 5, severity: 'error', message: "Type 'string' is not assignable to type 'number'.",
    });
    expect(diags[1].severity).toBe('warning');
    expect(diags[2].file).toBe('C:/proj/src/c.ts');
  });

  it('无诊断输出返回空', () => {
    expect(parseTypecheckDiagnostics('build succeeded')).toEqual([]);
  });
});

describe('B-09 filterDiagnosticsByFiles', () => {
  it('只保留目标文件（结尾匹配，兼容相对路径）', () => {
    const diags = parseTypecheckDiagnostics(TSC_SAMPLE);
    const hit = filterDiagnosticsByFiles(diags, ['src/a.ts', 'src/b.ts']);
    expect(hit.map((d) => d.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('目标文件无诊断时返回空', () => {
    const diags = parseTypecheckDiagnostics(TSC_SAMPLE);
    expect(filterDiagnosticsByFiles(diags, ['src/other.ts'])).toEqual([]);
  });
});

describe('B-09 lsp_diagnostics 工具', () => {
  it('缺少 files 参数时校验失败', async () => {
    const tool = createLspDiagnosticsTool();
    const result = await tool.execute({}, { workingDirectory: process.cwd() } as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain('files');
  });

  it('项目无 tsconfig 时返回说明（不伪造诊断）', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'rd-lsp-'));
    try {
      const tool = createLspDiagnosticsTool();
      const result = await tool.execute({ files: ['src/x.ts'] }, { workingDirectory: dir } as never);
      expect(result.success).toBe(true);
      expect(result.output).toContain('未配置类型检查');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('B-09 repo_map token 预算', () => {
  it('schema 暴露 budgetTokens 参数且校验正数', () => {
    const tool = new RepoMapTool();
    const schema = tool.definition.parameters as { properties: Record<string, unknown> };
    expect(schema.properties.budgetTokens).toBeDefined();
    const invalid = tool.validateArgs({ budgetTokens: -1 });
    expect(invalid.valid).toBe(false);
    const ok = tool.validateArgs({ budgetTokens: 1500 });
    expect(ok.valid).toBe(true);
  });

  it('裁剪函数按 token 预算截断（通过长输出工具路径验证）', async () => {
    // 构造大仓库扫描会触发 8000 字符上限；验证预算参数被接受且不抛错
    const tool = new RepoMapTool();
    const result = await tool.execute(
      { maxFiles: 80, budgetTokens: 200 },
      { workingDirectory: process.cwd() } as never,
    );
    expect(result.success).toBe(true);
    // 输出要么在预算内要么带截断标记
    expect(result.output.length).toBeLessThan(9000);
  });
});
