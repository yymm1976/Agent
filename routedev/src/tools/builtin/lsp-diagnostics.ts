// src/tools/builtin/lsp-diagnostics.ts
// B-09：lsp_diagnostics 轻量诊断工具
//
// 不做完整 LSP 服务器管理（计划：先用 B-00 证明收益再考虑 definition/references）。
// 实现：对指定文件列表运行项目 typecheck（tsc --noEmit），解析输出中的
// `path(line,col): error ...` 行，只返回命中目标文件的诊断（结构化、按文件分组）。
import { buildTool, type ITool } from '../types.js';
import { resolveDiagnosticCommands, runCommandAsync } from './diagnostics.js';

const TYPECHECK_TIMEOUT_MS = 60_000;

export interface FileDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
}

/** 解析 tsc 风格输出：`path(line,col): error TS1234: message` */
export function parseTypecheckDiagnostics(output: string): FileDiagnostic[] {
  const diagnostics: FileDiagnostic[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(?:TS\d+:\s*)?(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    diagnostics.push({
      file: match[1].replace(/\\/g, '/'),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as 'error' | 'warning',
      message: match[5],
    });
  }
  return diagnostics;
}

/** 过滤出目标文件（白名单按文件路径结尾匹配）的诊断 */
export function filterDiagnosticsByFiles(
  diagnostics: FileDiagnostic[],
  files: string[],
): FileDiagnostic[] {
  const normalized = files.map((f) => f.replace(/\\/g, '/'));
  return diagnostics.filter((d) =>
    normalized.some((f) => d.file === f || d.file.endsWith(`/${f}`)),
  );
}

export function createLspDiagnosticsTool(): ITool {
  return buildTool({
    name: 'lsp_diagnostics',
    description:
      '获取指定文件列表的类型诊断（轻量 LSP 替代：运行项目 tsc --noEmit 并只返回命中文件的 error/warning，按文件分组）。修改代码后用它确认没有引入新类型错误。项目无 tsconfig 时返回说明。',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '目标文件路径列表（相对项目根）',
        },
        path: {
          type: 'string',
          description: '项目目录（默认当前工作目录）',
        },
      },
      required: ['files'],
    },
    requiresApproval: true,
    category: 'code',
    readOnly: true,
    async execute(args, context) {
      const startedAt = Date.now();
      const files = Array.isArray(args.files)
        ? args.files.filter((f): f is string => typeof f === 'string' && f.length > 0)
        : [];
      if (files.length === 0) {
        return { success: false, output: '', error: '缺少必需参数: files', durationMs: 0 };
      }
      const cwd = typeof args.path === 'string' && args.path ? args.path : context.workingDirectory;
      const command = resolveDiagnosticCommands(cwd, 'typecheck');
      if (!command) {
        return {
          success: true,
          output: '[lsp_diagnostics] 项目未配置类型检查（缺少 tsconfig.json 或本地 tsc），无法生成诊断。',
          durationMs: Date.now() - startedAt,
        };
      }
      const result = await runCommandAsync(command.command, command.args, {
        cwd,
        timeout: TYPECHECK_TIMEOUT_MS,
        shell: process.platform === 'win32',
      });
      const all = parseTypecheckDiagnostics(`${result.stdout}\n${result.stderr}`);
      const hit = filterDiagnosticsByFiles(all, files);
      if (hit.length === 0) {
        return {
          success: true,
          output: `[lsp_diagnostics] ${files.length} 个目标文件无类型诊断（typecheck exit=${result.status}）。`,
          durationMs: Date.now() - startedAt,
        };
      }
      const byFile = new Map<string, FileDiagnostic[]>();
      for (const d of hit) {
        const list = byFile.get(d.file) ?? [];
        list.push(d);
        byFile.set(d.file, list);
      }
      const lines: string[] = [`[lsp_diagnostics] ${hit.length} 条诊断（exit=${result.status}）：`];
      for (const [file, diags] of byFile) {
        lines.push(`\n${file}:`);
        for (const d of diags) {
          lines.push(`  ${d.line}:${d.column} ${d.severity} ${d.message}`);
        }
      }
      return {
        success: result.status === 0,
        output: lines.join('\n'),
        durationMs: Date.now() - startedAt,
      };
    },
  });
}
