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
import { join, relative, resolve, dirname, sep, delimiter } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
  /** Eval Fix 2b：shell 输出尾部（管道吞退出码时 RED 判定靠输出特征） */
  outputTail?: string;
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
  // Eval Fix 2：depth 语义 = 当前深度（根目录 depth 0），递归层数限制从根起算。
  // 旧实现调用方从 depth=3 起步导致第一层目录直接 return（L3-09 导航 bug）。
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
  walkFiles(root, 0, files);
  for (const f of files) {
    try {
      const content = readFileSync(f, 'utf-8');
      if (content.includes(pattern)) hits.push(relative(root, f).replace(/\\/g, '/'));
    } catch { /* skip */ }
  }
  return hits;
}

/** Eval Fix 2：给 shell 子进程注入 PATH（node bin + routedev node_modules/.bin），fixture 无需 npm install。
 *  Observability Closure（P2-INFRA-04）：分隔符用 path.delimiter（Windows ';' / POSIX ':'）——
 *  硬编码 ';' 在 POSIX 上会拼成单条无效路径（CI ubuntu 靠 PATH 尾部原值侥幸通过）。 */
export function shellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [
      resolve(import.meta.dirname, '../../../node_modules/.bin'),
      resolve(import.meta.dirname, '../../../node_modules'),
      dirname(process.execPath),
      process.env.PATH ?? '',
    ].join(delimiter),
  };
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise<{ stdout: string; stderr: string; status: number | null }>((resolvePromise) => {
    // TASK 4（cross-platform）：detached 创建独立进程组——POSIX 侧按组 SIGKILL，
    // 确保 shell 与孙进程（sleep/node）一起终止；Windows 侧 taskkill /T /F。
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: shellEnv(), detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (status: number | null): void => {
      if (!settled) {
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolvePromise({ stdout, stderr, status });
      }
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) {
          try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }); } catch { /* noop */ }
        } else if (child.pid) {
          // POSIX：整组 SIGKILL（sh 收到 SIGTERM 可能不立即退出，sleep 子进程会拖住 close）
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* noop */ }
        }
        child.kill('SIGKILL');
      } catch { /* noop */ }
      // 兜底：kill 后 2s 内 close 未到也强制 settle（进程组杀失败时不挂起）
      forceTimer = setTimeout(() => finish(-1), 2000);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
    child.on('error', (err) => { clearTimeout(timer); stderr += String(err); finish(-1); });
  });
}

/** eval 专用工具执行器（harness 工具面，非被测对象）——导出供 conformance 测试 */
export interface EvalExecutorFaults {
  /**
   * Eval Fix 2（L2-05）：第一次匹配测试命令的 shell_exec 注入确定性 transient 失败，
   * 之后正常放行。fault 在 executor 层执行——对模型不可见、不可修改
   * （旧实现把 injector 放进被测 repo 让模型能修它）。
   */
  firstTestShellFailure?: boolean;
}

export class EvalToolExecutor implements ToolExecutorAdapter {
  private readonly activeTools: LLMToolDefinition[];
  private shellFaultConsumed = false;

  constructor(
    private readonly workdir: string,
    private readonly calls: EvalToolCall[],
    allowedTools?: string[],
    private readonly faults?: EvalExecutorFaults,
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
    // Eval Fix 2：`.eval` 是 harness 内部路径（trace/EventLog）——Agent 不可读写
    const normalized = rel.replace(/\\/g, '/');
    if (normalized === '.eval' || normalized.startsWith('.eval/')) {
      return { ok: false, reason: `路径为 harness 内部空间（.eval），不可访问: ${rel}` };
    }
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
    const record = (isError: boolean, output: string, tail?: string): { output: string; isError: boolean } => {
      this.calls.push({ toolName: name, toolCallId, args, denied: false, isError, outputPreview: output.slice(0, 200), outputTail: tail, timestamp: Date.now() });
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
        walkFiles(p, 0, files);
        return record(false, files.map((f) => relative(root, f).replace(/\\/g, '/')).join('\n'));
      }
      case 'shell_exec': {
        const command = String(args.command ?? '');
        // Integrity Closure：拒绝可越出工作区的命令——`..` 路径段、盘符绝对路径、
        // 指向 workdir 外的路径（防止读 hidden-tests / benchmark source）
        // Eval Fix 2b：MSYS 绝对路径（`/c/Users/...`、`/tmp/x`）不匹配盘符正则但越出
        // workdir（L2-05 实证模型 `ls /c/Users/.../node_modules` 读到 routedev 结构）；
        // `/dev/null` 白名单（`2>/dev/null` 是常见 shell 习惯，不越界）
        if (/[a-z]:[\\/]/i.test(command) || command.includes('../') || command.includes('..\\')
          || /(^|[^\w])\/[a-zA-Z][a-zA-Z0-9._-]*\/(?!null)/.test(command) || /\.eval[\\/]/.test(command)) {
          return record(true, '[被拒绝] 命令含越界路径（绝对路径或 ..）');
        }
        // Eval Fix 2（L2-05）：第一次测试命令注入确定性 transient 失败（executor 层，
        // 对模型不可见不可修改；注入失败不算 isError 计数外的特殊路径，重试即恢复）
        if (this.faults?.firstTestShellFailure && !this.shellFaultConsumed && /(vitest|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|npm\s+test)/i.test(command)) {
          this.shellFaultConsumed = true;
          return record(true, 'transient infrastructure error: test runner unavailable, retry');
        }
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60000;
        const r = await runShell(command, root, timeoutMs);
        const output = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(0, 4000);
        return record(r.status !== 0, output || `(exit ${r.status})`, output.slice(-300));
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
  /**
   * Eval Fix 2：RunEventLog/trace storage 目录——必须位于 Agent workspace 之外
   * （旧实现放 workdir/.eval/traces，模型能直接 file_read 自己的 events.jsonl——
   * L3-09 trajectory 实证 trace 泄漏）。缺省时仍放 workdir/.eval/traces（兼容旧调用）。
   */
  traceDir?: string;
  /** Eval Fix 2（L2-05）：executor 层 fault 注入（对模型不可见不可修改） */
  faults?: EvalExecutorFaults;
}

/**
 * 装配 eval agent（复用生产链路：loop → kernel.runReAct → RunEventLog 自动装配）。
 * @returns kernel + trace + 轨迹记录
 */
export function assembleEvalAgent(opts: AssembleOptions): EvalAgentHandle {
  const { workdir, autonomyMode, denyRules } = opts;
  const calls: EvalToolCall[] = [];

  // 工具面（allowedTools 驱动 surface；manifest 未实现工具启动即抛 configuration error）
  const executor = new EvalToolExecutor(workdir, calls, opts.allowedTools, opts.faults);

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
  const traceDir = opts.traceDir ?? join(workdir, '.eval', 'traces');
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
