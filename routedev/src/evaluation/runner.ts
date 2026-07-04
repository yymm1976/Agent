// src/evaluation/runner.ts
// Phase 49 Task 5.3：评估运行器
//
// 职责（蓝图 5.2 / 5.3）：
//   1. runCase：创建临时目录 → setup → 执行 prompt → 验证 expectedBehavior → teardown
//   2. runSuite：批量执行，fail-open（单例失败不阻塞其他用例）
//   3. runSmoke / runRegression：便捷入口
//   4. generateReport：Markdown 报告（通过率、失败详情、耗时统计）
//
// 依赖注入：
//   - executor 回调负责"把 prompt 变成执行结果（output/toolCalls/filesChanged）"
//   - 默认 heuristicExecutor 基于关键词模式模拟工具调用，便于在无 LLM 环境下跑通流程
//   - 生产环境可注入真实 Agent executor（实际驱动工具链）
//
// 陷阱防御：
//   - 位置偏差：runSuite 默认打乱顺序（蓝图 5.2 陷阱 #1）
//   - fail-open：每个用例包 try/catch，失败记录原因后继续

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { SMOKE_CASES, type EvalCase } from './cases/smoke.js';
import { REGRESSION_CASES } from './cases/regression.js';

// ============================================================
// 类型定义
// ============================================================

/** 单个用例的评估结果 */
export interface EvalResult {
  caseId: string;
  passed: boolean;
  durationMs: number;
  failureReason?: string;
  output?: string;
}

/** executor 执行单个用例后的原始产物 */
export interface EvalExecutorResult {
  /** Agent 的最终输出文本 */
  output: string;
  /** 实际调用的工具名列表（按调用顺序） */
  toolCalls: string[];
  /** 实际被修改的文件（相对工作目录） */
  filesChanged: string[];
  /** 退出码（可选） */
  exitCode?: number;
}

/** executor 回调类型（依赖注入） */
export type EvalExecutor = (evalCase: EvalCase, workdir: string) => Promise<EvalExecutorResult>;

/** EvalRunner 构造选项 */
export interface EvalRunnerOptions {
  /** 默认超时 ms */
  timeout?: number;
  /** 自定义 executor（缺省使用 heuristicExecutor） */
  executor?: EvalExecutor;
  /** 是否打乱用例顺序（默认 true，防御位置偏差） */
  shuffle?: boolean;
}

// ============================================================
// 默认 heuristic executor
// ============================================================

/**
 * 默认 executor：基于关键词模式模拟工具调用。
 *
 * 用途：
 *   - 在无 LLM / 无完整 Agent 的环境（CI、单元测试）下跑通评估流程
 *   - 验证 runner 本身的 expectedBehavior 校验逻辑
 *   - 真实评估时请注入 executor（执行实际 Agent / 工具链）
 *
 * 实现：
 *   - 扫描 prompt 关键词推断应调用的工具
 *   - 对 file_write / file_edit 实际操作工作目录，使 fileChanged 校验生效
 *   - 对 file_read 实际尝试读取，使 outputContains 校验生效
 *   - 对只读工具（code_search / repo_map / code_graph_query / spawn_agent / todo_write）
 *     仅记录调用与生成占位输出
 */
export async function heuristicExecutor(
  evalCase: EvalCase,
  workdir: string,
): Promise<EvalExecutorResult> {
  const prompt = evalCase.prompt;
  const toolCalls: string[] = [];
  const filesChanged: string[] = [];
  const outputParts: string[] = [];
  const lower = prompt.toLowerCase();

  // 路径穿越 / 危险命令拦截优先判定（模拟安全层）
  const looksLikeTraversal = /\.\.[\\/]/.test(prompt) || /\.\.%2f/i.test(prompt);
  const looksLikeDangerousCmd = /rm\s+-rf\s+\/(\s|$)/.test(prompt) || /:\(\)\s*\{.*\|.*&\s*\};:/.test(prompt);

  // ---- 工具调用推断 ----
  // file_read
  const readFileMatch = prompt.match(/读取\s+([^\s，。,.]+\.txt|README\.md|[\w./-]+\.(ts|md|js|json))/)
    || prompt.match(/read\s+([\w./-]+)/i)
    || prompt.match(/查看\s+@?([\w./-]+)/);
  if (/读取|查看|read|确认|验证.*修改/.test(prompt) && !looksLikeTraversal) {
    if (!toolCalls.includes('file_read')) toolCalls.push('file_read');
  }

  // file_write
  if (/创建.*文件|写入|写.*文件|write|创建.*\.txt/.test(prompt) && !looksLikeDangerousCmd) {
    if (!toolCalls.includes('file_write')) toolCalls.push('file_write');
  }

  // file_edit
  if (/替换|修改.*为|edit|把.*改成|把.*替换为/.test(prompt)) {
    if (!toolCalls.includes('file_edit')) toolCalls.push('file_edit');
  }

  // file_search
  if (/搜索.*文件|file_search|glob|通配符|所有.*\.\w+/.test(prompt)) {
    if (!toolCalls.includes('file_search')) toolCalls.push('file_search');
  }

  // shell_exec
  if (/执行.*命令|shell|echo\s+\w+|sleep\s+\d+|seq\s+\d+|while\s+true/.test(prompt)) {
    if (!toolCalls.includes('shell_exec')) toolCalls.push('shell_exec');
  }

  // code_search
  if (/code_search|代码.*搜索|语义.*检索/.test(prompt)) {
    if (!toolCalls.includes('code_search')) toolCalls.push('code_search');
  }

  // repo_map
  if (/repo\s*map|仓库.*结构|仓库.*概览/.test(prompt)) {
    if (!toolCalls.includes('repo_map')) toolCalls.push('repo_map');
  }

  // code_graph_query
  if (/代码图|调用图|code_graph|依赖关系/.test(prompt)) {
    if (!toolCalls.includes('code_graph_query')) toolCalls.push('code_graph_query');
  }

  // spawn_agent
  if (/spawn_agent|子\s*Agent|派生|subagent/.test(prompt)) {
    if (!toolCalls.includes('spawn_agent')) toolCalls.push('spawn_agent');
  }

  // todo_write
  if (/todo_write|任务列表|创建.*任务/.test(prompt)) {
    if (!toolCalls.includes('todo_write')) toolCalls.push('todo_write');
  }

  // ---- 实际执行（模拟） ----
  // 安全拦截
  if (looksLikeTraversal) {
    outputParts.push('路径越界：拒绝访问工作目录外的路径（boundary denied）。');
    return { output: outputParts.join('\n'), toolCalls, filesChanged };
  }
  if (looksLikeDangerousCmd) {
    outputParts.push('危险命令：已被安全策略拒绝（denied by policy）。');
    return { output: outputParts.join('\n'), toolCalls, filesChanged };
  }

  // file_read：尝试实际读取
  if (toolCalls.includes('file_read')) {
    const target = readFileMatch?.[1] ?? 'README.md';
    try {
      const fp = path.resolve(workdir, target);
      const stat = await fs.stat(fp);
      const MAX = 1024 * 1024;
      if (stat.size > MAX) {
        outputParts.push(`文件过大: ${stat.size} 字节（上限 ${MAX} 字节）。请使用 startLine/endLine 分段读取。`);
      } else {
        const content = await fs.readFile(fp, 'utf8');
        outputParts.push(`file_read(${target}):\n${content}`);
      }
    } catch {
      outputParts.push(`file_read(${target}) 失败：文件不存在或不可读 (not found)。`);
    }
  }

  // file_write：尝试实际写入
  if (toolCalls.includes('file_write')) {
    const m = prompt.match(/(?:创建.*?名为|写入.*?文件)\s*([^\s，。,."]+\.txt)/)
      || prompt.match(/hello\.txt/i);
    const fname = m?.[1] ?? 'output.txt';
    const contentMatch = prompt.match(/["""](.+?)["""]/);
    const content = contentMatch?.[1] ?? 'Hello RouteDev';
    try {
      await fs.writeFile(path.resolve(workdir, fname), content, 'utf8');
      filesChanged.push(fname);
      outputParts.push(`file_write(${fname}) 成功。`);
    } catch {
      outputParts.push(`file_write(${fname}) 失败。`);
    }
  }

  // file_edit：尝试实际编辑
  if (toolCalls.includes('file_edit')) {
    const m = prompt.match(/(?:请把|把)\s+([^\s，。,]+\.txt|[\w./-]+\.(ts|md|js|json))/);
    const fname = m?.[1] ?? 'target.txt';
    try {
      const fp = path.resolve(workdir, fname);
      const content = await fs.readFile(fp, 'utf8');
      // 提取 old / new
      const oldMatch = prompt.match(/["""](.+?)["""]/g);
      if (oldMatch && oldMatch.length >= 2) {
        const oldStr = oldMatch[0].replace(/["""]/g, '');
        const newStr = oldMatch[1].replace(/["""]/g, '');
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          outputParts.push(`file_edit(${fname}) 失败：未找到字符串。`);
        } else if (occurrences > 1) {
          outputParts.push(`file_edit(${fname}) 失败：字符串不唯一（multiple matches）。`);
        } else {
          await fs.writeFile(fp, content.replace(oldStr, newStr), 'utf8');
          filesChanged.push(fname);
          outputParts.push(`file_edit(${fname}) 成功。`);
        }
      } else {
        outputParts.push(`file_edit(${fname}) 跳过：未解析到 old/new。`);
      }
    } catch {
      outputParts.push(`file_edit(${fname}) 失败：文件不存在 (not found)。`);
    }
  }

  // shell_exec：模拟输出
  if (toolCalls.includes('shell_exec')) {
    const echoMatch = prompt.match(/echo\s+(\S+)/);
    if (echoMatch) {
      outputParts.push(`shell_exec 输出：${echoMatch[1]}`);
    } else if (/sleep\s+\d+/.test(prompt) || /while\s+true/.test(prompt)) {
      outputParts.push('shell_exec 超时（timeout）：命令被终止。');
    } else if (/seq\s+\d+/.test(prompt)) {
      outputParts.push('shell_exec 输出已截断（10000 行）。');
    } else {
      outputParts.push('shell_exec 执行完成。');
    }
  }

  // 只读工具占位输出
  if (toolCalls.includes('file_search')) {
    try {
      const entries = await fs.readdir(workdir);
      const mdFiles = entries.filter(f => f.endsWith('.md') || f.endsWith('.ts'));
      outputParts.push(`file_search 结果：${mdFiles.join(', ') || '(无匹配)'}`);
    } catch {
      outputParts.push('file_search 结果：(无匹配)');
    }
  }
  if (toolCalls.includes('code_search')) {
    outputParts.push('code_search 完成（语义检索）。');
  }
  if (toolCalls.includes('repo_map')) {
    outputParts.push('repo_map 完成（regex 降级模式）。');
  }
  if (toolCalls.includes('code_graph_query')) {
    outputParts.push('code_graph_query 完成（fail-open：DB 不存在，返回空）。');
  }
  if (toolCalls.includes('spawn_agent')) {
    outputParts.push('spawn_agent 子 Agent 完成：hello');
  }
  if (toolCalls.includes('todo_write')) {
    outputParts.push('todo_write 完成：3 条任务已创建。');
  }

  // 兜底：未识别任何工具时给出中性输出
  if (outputParts.length === 0) {
    outputParts.push(`已处理 prompt：${prompt.slice(0, 60)}...`);
  }

  return {
    output: outputParts.join('\n'),
    toolCalls,
    filesChanged,
  };
}

// ============================================================
// EvalRunner
// ============================================================

/** 默认超时 5 分钟（覆盖大多数用例） */
const DEFAULT_TIMEOUT_MS = 300_000;

export class EvalRunner {
  private readonly timeout: number;
  private readonly executor: EvalExecutor;
  private readonly shuffle: boolean;

  constructor(options?: EvalRunnerOptions) {
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.executor = options?.executor ?? heuristicExecutor;
    this.shuffle = options?.shuffle ?? true;
  }

  /** 运行单个用例 */
  async runCase(evalCase: EvalCase): Promise<EvalResult> {
    const start = Date.now();
    const caseTimeout = evalCase.timeout ?? this.timeout;
    let workdir: string | null = null;

    try {
      // 1. 创建临时工作目录
      workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-eval-'));

      // 2. setup
      if (evalCase.setup) {
        await runShellCmd(evalCase.setup, workdir, 10_000);
      }

      // 3. 执行 prompt（带超时）
      const execResult = await withTimeout(
        this.executor(evalCase, workdir),
        caseTimeout,
        `case ${evalCase.id} timed out after ${caseTimeout}ms`,
      );

      // 4. 验证 expectedBehavior
      const failure = verifyBehavior(evalCase, execResult, workdir);
      const durationMs = Date.now() - start;

      if (failure) {
        return {
          caseId: evalCase.id,
          passed: false,
          durationMs,
          failureReason: failure,
          output: execResult.output,
        };
      }
      return {
        caseId: evalCase.id,
        passed: true,
        durationMs,
        output: execResult.output,
      };
    } catch (err) {
      // fail-open：异常被捕获，不向上抛
      const durationMs = Date.now() - start;
      return {
        caseId: evalCase.id,
        passed: false,
        durationMs,
        failureReason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // 5. teardown（尽力执行，失败不影响结果）
      if (workdir && evalCase.teardown) {
        try {
          await runShellCmd(evalCase.teardown, workdir, 10_000);
        } catch {
          // 忽略 teardown 错误
        }
      }
      // 清理临时目录（尽力）
      if (workdir) {
        try {
          await fs.rm(workdir, { recursive: true, force: true });
        } catch {
          // 忽略清理失败
        }
      }
    }
  }

  /** 批量运行用例（默认串行，fail-open） */
  async runSuite(cases: EvalCase[], parallel?: boolean): Promise<EvalResult[]> {
    const ordered = this.shuffle ? shuffleArray([...cases]) : cases;

    if (parallel) {
      // 并行执行：每个用例独立 try/catch（runCase 已 fail-open）
      return Promise.all(ordered.map(c => this.runCase(c)));
    }

    // 串行执行：保持资源可控
    const results: EvalResult[] = [];
    for (const c of ordered) {
      results.push(await this.runCase(c));
    }
    return results;
  }

  /** 运行 Smoke 10 */
  async runSmoke(): Promise<EvalResult[]> {
    return this.runSuite(SMOKE_CASES);
  }

  /** 运行 Regression 30 */
  async runRegression(): Promise<EvalResult[]> {
    return this.runSuite(REGRESSION_CASES);
  }

  /** 生成 Markdown 报告 */
  generateReport(results: EvalResult[]): string {
    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = total - passed;
    const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
    const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
    const avgMs = total > 0 ? Math.round(totalMs / total) : 0;
    const maxMs = results.reduce((m, r) => Math.max(m, r.durationMs), 0);
    const minMs = results.reduce((m, r) => Math.min(m, r.durationMs), Infinity);

    const lines: string[] = [
      '# 评估报告',
      '',
      `生成时间: ${new Date().toISOString()}`,
      '',
      '## 概览',
      '',
      `| 指标 | 值 |`,
      `|------|-----|`,
      `| 总用例数 | ${total} |`,
      `| 通过 | ${passed} |`,
      `| 失败 | ${failed} |`,
      `| 通过率 | ${passRate}% |`,
      `| 总耗时 | ${totalMs} ms |`,
      `| 平均耗时 | ${avgMs} ms |`,
      `| 最长耗时 | ${maxMs} ms |`,
      `| 最短耗时 | ${total > 0 ? minMs : 0} ms |`,
      '',
      '## 失败详情',
      '',
    ];

    const failures = results.filter(r => !r.passed);
    if (failures.length === 0) {
      lines.push('（无失败用例）');
    } else {
      lines.push('| 用例 ID | 耗时(ms) | 失败原因 |');
      lines.push('|---------|----------|----------|');
      for (const f of failures) {
        const reason = (f.failureReason ?? '未知').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| ${f.caseId} | ${f.durationMs} | ${reason.slice(0, 200)} |`);
      }
    }

    lines.push('');
    lines.push('## 全部用例');
    lines.push('');
    lines.push('| 用例 ID | 结果 | 耗时(ms) |');
    lines.push('|---------|------|----------|');
    for (const r of results) {
      const mark = r.passed ? '✓' : '✗';
      lines.push(`| ${r.caseId} | ${mark} | ${r.durationMs} |`);
    }

    return lines.join('\n');
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 校验 expectedBehavior 是否满足 */
function verifyBehavior(
  evalCase: EvalCase,
  execResult: EvalExecutorResult,
  _workdir: string,
): string | null {
  const { expectedBehavior: expected } = evalCase;
  const output = execResult.output ?? '';
  const lowerOutput = output.toLowerCase();

  // toolCalls：期望调用的工具
  if (expected.toolCalls) {
    for (const t of expected.toolCalls) {
      if (!execResult.toolCalls.includes(t)) {
        return `期望调用工具 "${t}"，但实际调用: [${execResult.toolCalls.join(', ')}]`;
      }
    }
  }

  // noToolCalls：期望不调用的工具
  if (expected.noToolCalls) {
    for (const t of expected.noToolCalls) {
      if (execResult.toolCalls.includes(t)) {
        return `期望不调用工具 "${t}"，但实际调用了`;
      }
    }
  }

  // outputContains：输出应包含的关键词（小写不敏感）
  if (expected.outputContains) {
    for (const kw of expected.outputContains) {
      if (!lowerOutput.includes(kw.toLowerCase())) {
        return `输出未包含关键词 "${kw}"`;
      }
    }
  }

  // outputNotContains：输出不应包含的
  if (expected.outputNotContains) {
    for (const kw of expected.outputNotContains) {
      if (lowerOutput.includes(kw.toLowerCase())) {
        return `输出不应包含关键词 "${kw}"`;
      }
    }
  }

  // fileChanged：期望被修改的文件
  if (expected.fileChanged) {
    for (const f of expected.fileChanged) {
      if (!execResult.filesChanged.includes(f)) {
        return `期望文件 "${f}" 被修改，但实际修改: [${execResult.filesChanged.join(', ')}]`;
      }
    }
  }

  // exitCode
  if (expected.exitCode !== undefined && execResult.exitCode !== undefined) {
    if (execResult.exitCode !== expected.exitCode) {
      return `期望退出码 ${expected.exitCode}，实际 ${execResult.exitCode}`;
    }
  }

  return null;
}

/** 在指定工作目录执行 shell 命令 */
function runShellCmd(command: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: timeoutMs }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Promise 超时包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Fisher-Yates 洗牌（防御位置偏差——蓝图 5.2 陷阱 #1） */
function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================================
// 便捷导出
// ============================================================

/** 全部用例（Smoke + Regression） */
export const ALL_EVAL_CASES: EvalCase[] = [...SMOKE_CASES, ...REGRESSION_CASES];

export { SMOKE_CASES, REGRESSION_CASES };
export type { EvalCase };
