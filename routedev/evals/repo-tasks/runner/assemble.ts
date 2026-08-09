// evals/repo-tasks/runner/assemble.ts
// GA Eval Phase A：eval agent 装配——复用生产组件（ReActAgentLoop/NativeAgentKernel/
// PermissionEngine/RunEventLog），工具面为 eval 专用最小实现（harness 本身，非被测对象）。
//
// 设计：
// - 工具面：file_read/file_write/file_edit/file_search/list_directory/shell_exec/todo_write
//   （eval runner 直接实现，简单可靠；权限语义由 PermissionEngine 中间件在 loop 层执行）
// - 权限：createDefaultEngine + 每 task 自定义规则（L2-06 deny tests/ 写入）
// - RunEventLog：kernel.runReAct 生产路径自动装配（storageDir = trace storageDir）
// - 轨迹记录：runner 自维护 toolCalls[]（name/args/denied/isError），供评分用

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { ReActAgentLoop } from '../../../src/agent/loop.js';
import { NativeAgentKernel } from '../../../src/agent/kernel-native.js';
import { PermissionEngine, createDefaultEngine, type PermissionRule } from '../../../src/tools/permission-engine.js';
import { PermissionMiddleware } from '../../../src/agent/middleware/permission-middleware.js';
import { AgentMiddlewarePipeline } from '../../../src/agent/middleware.js';
import { TraceCollector } from '../../../src/harness/trace-collector.js';
import { RunEventLog } from '../../../src/harness/run-event-log.js';
import type { LLMToolDefinition } from '../../../src/router/types.js';
import type { ToolExecutorAdapter } from '../../../src/agent/loop-config.js';

/** eval 轨迹记录（评分输入） */
export interface EvalToolCall {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  denied: boolean;
  isError: boolean;
  outputPreview: string;
  timestamp: number;
}

/** eval 运行汇总（来自 RunEventLog replay + 轨迹） */
export interface EvalRunSummary {
  runId: string;
  toolCalls: EvalToolCall[];
  llmRounds: number;
  retryCount: number;
  completed: boolean;
  interruptedReason?: string;
}

export interface EvalAgentHandle {
  kernel: NativeAgentKernel;
  trace: TraceCollector;
  workdir: string;
  calls: EvalToolCall[];
}

// ============================================================
// 最小 eval 工具面
// ============================================================

const TOOL_DEFS: LLMToolDefinition[] = [
  {
    name: 'file_read',
    description: 'Read a file and return its content',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'file_write',
    description: 'Write content to a file (creates parent dirs)',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'file_edit',
    description: 'Replace the first occurrence of oldString with newString in a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'file_search',
    description: 'Search files for a string pattern under the working directory',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'list_directory',
    description: 'List files in a directory (recursive, depth-limited)',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'shell_exec',
    description: 'Run a shell command in the working directory (cwd = fixture root)',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'] },
  },
  {
    name: 'todo_write',
    description: 'Record a todo item (no-op in eval harness)',
    parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  },
  {
    name: 'code_search',
    description: 'Search files for a string pattern (alias of file_search)',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'repo_map',
    description: 'List the repository file tree (alias of list_directory at root)',
    parameters: { type: 'object', properties: {} },
  },
];

function walkFiles(dir: string, depth: number, out: string[]): void {
  if (depth > 3 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.eval') continue;
    const p = join(dir, entry);
    try {
      if (statSync(p).isDirectory()) walkFiles(p, depth + 1, out);
      else out.push(p);
    } catch { /* skip */ }
  }
}

function grepFiles(root: string, pattern: string): string[] {
  const hits: string[] = [];
  const files: string[] = [];
  walkFiles(root, 3, files);
  for (const f of files) {
    try {
      const content = readFileSync(f, 'utf-8');
      if (content.includes(pattern)) hits.push(relative(root, f).replace(/\\/g, '/'));
    } catch { /* skip */ }
  }
  return hits;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise<{ stdout: string; stderr: string; status: number | null }>((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: number | null): void => {
      if (!settled) { settled = true; resolvePromise({ stdout, stderr, status }); }
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
    child.on('error', (err) => { clearTimeout(timer); stderr += String(err); finish(-1); });
  });
}

/** eval 专用工具执行器（harness 工具面，非被测对象）——导出供 conformance 测试 */
export class EvalToolExecutor implements ToolExecutorAdapter {
  private readonly activeTools: LLMToolDefinition[];

  constructor(
    private readonly workdir: string,
    private readonly calls: EvalToolCall[],
    allowedTools?: string[],
  ) {
    // Integrity Closure：allowedTools 真正决定 tool surface（manifest 驱动）
    this.activeTools = allowedTools
      ? TOOL_DEFS.filter((t) => allowedTools.includes(t.name))
      : TOOL_DEFS;
    if (allowedTools) {
      const missing = allowedTools.filter((n) => !TOOL_DEFS.some((t) => t.name === n));
      if (missing.length > 0) {
        // benchmark configuration error：manifest 声明了未实现的工具——启动即失败
        throw new Error(`benchmark configuration error: manifest allowedTools 未实现: ${missing.join(',')}`);
      }
    }
  }

  getToolDefinitions(): LLMToolDefinition[] {
    return this.activeTools;
  }

  hasTool(name: string): boolean {
    return this.activeTools.some((t) => t.name === name);
  }

  /**
   * Integrity Closure：canonical containment——任何文件访问必须落在 workdir 内。
   * 绝对路径、`..` 逃逸、符号链接外跳一律拒绝（hidden/benchmark source 不可触及）。
   */
  private contain(rel: string): { ok: true; path: string } | { ok: false; reason: string } {
    const root = this.workdir;
    // 显式拒绝 `..` 段（两种分隔符）——Linux 上反斜杠不是路径分隔符，
    // resolve 不会折叠 `..\x`，单靠 resolve 越界检查会漏（跨平台一致性）
    if (rel.includes('../') || rel.includes('..\\') || rel.startsWith('..')) {
      return { ok: false, reason: `路径越出工作区: ${rel}` };
    }
    const resolved = resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return { ok: false, reason: `路径越出工作区: ${rel}` };
    }
    return { ok: true, path: resolved };
  }

  async executeToolStructured(
    name: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }> {
    const record = (isError: boolean, output: string): { output: string; isError: boolean } => {
      this.calls.push({ toolName: name, toolCallId, args, denied: false, isError, outputPreview: output.slice(0, 200), timestamp: Date.now() });
      return { output, isError };
    };
    const root = this.workdir;
    switch (name) {
      case 'file_read': {
        const rel = String(args.path ?? '');
        const c = this.contain(rel);
        if (!c.ok) return record(true, `[${c.reason}]`);
        const p = c.path;
        if (!existsSync(p)) return record(true, `[文件不存在] ${rel}`);
        try {
          return record(false, readFileSync(p, 'utf-8'));
        } catch (err) {
          return record(true, `[读取失败] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case 'file_write': {
        const rel = String(args.path ?? '');
        const c = this.contain(rel);
        if (!c.ok) return record(true, `[${c.reason}]`);
        const p = c.path;
        try {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, String(args.content ?? ''), 'utf-8');
          return record(false, `written ${rel}`);
        } catch (err) {
          return record(true, `[写入失败] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case 'file_edit': {
        const rel = String(args.path ?? '');
        const c = this.contain(rel);
        if (!c.ok) return record(true, `[${c.reason}]`);
        const p = c.path;
        if (!existsSync(p)) return record(true, `[文件不存在] ${rel}`);
        try {
          const content = readFileSync(p, 'utf-8');
          const oldString = String(args.oldString ?? '');
          const idx = content.indexOf(oldString);
          if (idx < 0) return record(true, `[未找到 oldString] ${oldString.slice(0, 80)}`);
          const next = content.slice(0, idx) + String(args.newString ?? '') + content.slice(idx + oldString.length);
          writeFileSync(p, next, 'utf-8');
          return record(false, `edited ${rel}`);
        } catch (err) {
          return record(true, `[编辑失败] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case 'file_search': {
        const pattern = String(args.pattern ?? '');
        const hits = grepFiles(root, pattern);
        return record(false, hits.length > 0 ? hits.join('\n') : '(no matches)');
      }
      case 'list_directory': {
        const rel = String(args.path ?? '.');
        const c = this.contain(rel);
        if (!c.ok) return record(true, `[${c.reason}]`);
        const p = c.path;
        if (!existsSync(p)) return record(true, `[目录不存在] ${rel}`);
        const files: string[] = [];
        walkFiles(p, 3, files);
        return record(false, files.map((f) => relative(root, f).replace(/\\/g, '/')).join('\n'));
      }
      case 'shell_exec': {
        const command = String(args.command ?? '');
        // Integrity Closure：拒绝可越出工作区的命令——`..` 路径段、盘符绝对路径、
        // 指向 workdir 外的路径（防止读 hidden-tests / benchmark source）
        if (/[a-z]:[\\/]/i.test(command) || command.includes('../') || command.includes('..\\')) {
          return record(true, '[被拒绝] 命令含越界路径（绝对路径或 ..）');
        }
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60000;
        const r = await runShell(command, root, timeoutMs);
        const output = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(0, 4000);
        return record(r.status !== 0, output || `(exit ${r.status})`);
      }
      case 'todo_write':
        return record(false, 'ok');
      case 'code_search':
        return this.executeToolStructured('file_search', toolCallId, args);
      case 'repo_map':
        return this.executeToolStructured('list_directory', toolCallId, { path: '.' });
      default:
        return record(true, `[未知工具] ${name}`);
    }
  }

  async executeTool(name: string, toolCallId: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.executeToolStructured(name, toolCallId, args);
    return r.output;
  }
}

// ============================================================
// 装配
// ============================================================

export interface AssembleOptions {
  workdir: string;
  autonomyMode: 'manual' | 'semi' | 'auto';
  denyRules?: PermissionRule[];
  maxIterations?: number;
  /** Integrity Closure：manifest allowedTools 真正决定 tool surface */
  allowedTools?: string[];
}

/**
 * 装配 eval agent（复用生产链路：loop → kernel.runReAct → RunEventLog 自动装配）。
 * @returns kernel + trace + 轨迹记录
 */
export function assembleEvalAgent(opts: AssembleOptions): EvalAgentHandle {
  const { workdir, autonomyMode, denyRules } = opts;
  const calls: EvalToolCall[] = [];

  // 工具面（allowedTools 驱动 surface；manifest 未实现工具启动即抛 configuration error）
  const executor = new EvalToolExecutor(workdir, calls, opts.allowedTools);

  // 权限：默认引擎 + 自定义 deny（L2-06 等）
  const engine = createDefaultEngine();
  if (denyRules && denyRules.length > 0) engine.loadRules(denyRules);

  // 中间件管线（onActing 权限阶段，与生产一致；loop 内部 mwRunner 消费该 pipeline）
  const pipeline = new AgentMiddlewarePipeline();
  const permMw = new PermissionMiddleware(engine, autonomyMode);
  pipeline.register('onActing', permMw.getHandler());

  // loop（生产装配顺序与 app-init 一致）
  const loop = new ReActAgentLoop(executor, {
    toolsEnabled: true,
    maxIterations: opts.maxIterations ?? 30,
    parallelToolExecution: false,
  });
  loop.setMiddlewarePipeline(pipeline);

  // trace + kernel（RunEventLog 由 kernel.runReAct 生产路径自动装配）
  const traceDir = join(workdir, '.eval', 'traces');
  mkdirSync(traceDir, { recursive: true });
  const trace = new TraceCollector({ storageDir: traceDir });
  const kernel = new NativeAgentKernel(loop, { trace });

  return { kernel, trace, workdir, calls };
}

/** 从 RunEventLog replay 提取运行汇总（评分 eventAssertions 输入） */
export function summarizeRun(storageDir: string | undefined, runId: string): EvalRunSummary | null {
  const { projection } = RunEventLog.replay(storageDir, runId);
  if (!projection) return null;
  return {
    runId,
    toolCalls: [],
    llmRounds: projection.llmAttempts,
    retryCount: projection.retryCount,
    completed: projection.completed,
    interruptedReason: projection.interruptedReason,
  };
}
