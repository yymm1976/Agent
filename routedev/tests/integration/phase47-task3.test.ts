// tests/integration/phase47-task3.test.ts
// Phase 47 Task 3 集成测试：routedev exec 非交互模式
//
// 测试策略：
//   1. parseExecArgs 正确解析 prompt 和各参数
//   2. parseExecArgs 无参数 / 非 exec 子命令时返回 null
//   3. --json 输出合法 JSON 结构（含 success/output 字段）
//   4. --allowedTools 限制后，其他工具被拒绝（验证白名单逻辑）
//   5. --timeout 超时后返回退出码 2（陷阱 #135）
//   6. 进度信息输出到 stderr，不污染 stdout
//   7. --output result.json 将结果写入文件
//   8. applyWorkMode 正确设置沙箱级和 headless 模式

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseExecArgs,
  type ExecArgs,
  type ExecWorkMode,
} from '../../src/cli/args.js';
import {
  runExec,
  applyWorkMode,
  applyToolWhitelist,
  EXEC_EXIT_CODE,
  type ExecuteFn,
  type ExecResult,
} from '../../src/cli/exec-runner.js';
import {
  createDefaultEngine,
  type PermissionEngine,
} from '../../src/tools/permission-engine.js';

// ============================================================
// 工具函数：捕获 stdout / stderr 输出
// ============================================================

/** 临时替换 process.stdout.write / process.stderr.write，捕获输出内容 */
function captureOutput(): {
  stdout: string;
  stderr: string;
  restore: () => void;
} {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdoutContent = '';
  let stderrContent = '';

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdoutContent += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderrContent += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  return {
    get stdout() {
      return stdoutContent;
    },
    get stderr() {
      return stderrContent;
    },
    restore: () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

/** 创建一个临时文件路径（不创建文件） */
function makeTempFilePath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-exec47-'));
  return path.join(dir, `${prefix}.json`);
}

// ============================================================
// 1. parseExecArgs 正确解析 prompt 和各参数
// ============================================================
describe('Phase 47 Task 3 - parseExecArgs 参数解析', () => {
  it('正确解析 prompt 和全部参数', () => {
    const args = parseExecArgs([
      'exec',
      '重构 utils.ts',
      '--allowedTools',
      'file_read,file_search',
      '--json',
      '--timeout',
      '300000',
      '--workMode',
      'read-only',
      '--maxSteps',
      '50',
      '--output',
      'result.json',
    ]);

    expect(args).not.toBeNull();
    expect(args!.prompt).toBe('重构 utils.ts');
    expect(args!.allowedTools).toEqual(['file_read', 'file_search']);
    expect(args!.outputFormat).toBe('json');
    expect(args!.timeout).toBe(300000);
    expect(args!.workMode).toBe('read-only');
    expect(args!.maxSteps).toBe(50);
    expect(args!.outputFile).toBe('result.json');
  });

  it('使用默认值（仅提供 prompt）', () => {
    const args = parseExecArgs(['exec', '简单任务']);

    expect(args).not.toBeNull();
    expect(args!.prompt).toBe('简单任务');
    expect(args!.outputFormat).toBe('text');
    expect(args!.timeout).toBe(300000); // 默认 5 分钟
    expect(args!.workMode).toBe('workspace-write');
    expect(args!.maxSteps).toBe(50);
    expect(args!.allowedTools).toBeUndefined();
    expect(args!.outputFile).toBeUndefined();
  });

  it('allowedTools 支持逗号分隔的多个工具名（含空格）', () => {
    const args = parseExecArgs([
      'exec',
      'task',
      '--allowedTools',
      'file_read, file_search , code_search',
    ]);

    expect(args).not.toBeNull();
    expect(args!.allowedTools).toEqual(['file_read', 'file_search', 'code_search']);
  });
});

// ============================================================
// 2. parseExecArgs 无参数 / 非 exec 子命令时返回 null
// ============================================================
describe('Phase 47 Task 3 - parseExecArgs 返回 null 场景', () => {
  it('空参数返回 null', () => {
    expect(parseExecArgs([])).toBeNull();
  });

  it('非 exec 子命令返回 null', () => {
    expect(parseExecArgs(['serve'])).toBeNull();
    expect(parseExecArgs(['config', 'validate'])).toBeNull();
    expect(parseExecArgs(['--version'])).toBeNull();
    expect(parseExecArgs(['--help'])).toBeNull();
  });

  it('exec 子命令但缺少 prompt 返回 null', () => {
    expect(parseExecArgs(['exec'])).toBeNull();
    expect(parseExecArgs(['exec', '--json'])).toBeNull();
    expect(parseExecArgs(['exec', '--timeout', '1000'])).toBeNull();
  });
});

// ============================================================
// 3. --json 输出合法 JSON 结构（含 success/output 字段）
// ============================================================
describe('Phase 47 Task 3 - JSON 输出结构', () => {
  it('--json 模式输出含 success/output 字段的合法 JSON', async () => {
    // 注入 mock executeFn：返回已知结果
    const mockExecuteFn: ExecuteFn = async (_args, _progress) => ({
      success: true,
      output: '任务完成的结果内容',
      steps: 3,
    });

    const args: ExecArgs = {
      prompt: '测试任务',
      outputFormat: 'json',
      maxSteps: 10,
      timeout: 5000,
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      const exitCode = await runExec(args, mockExecuteFn);
      expect(exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);

      // stdout 应包含合法 JSON
      const jsonLine = cap.stdout.trim();
      const parsed = JSON.parse(jsonLine);
      expect(parsed).toHaveProperty('success', true);
      expect(parsed).toHaveProperty('output', '任务完成的结果内容');
      expect(parsed).toHaveProperty('steps', 3);
    } finally {
      cap.restore();
    }
  });

  it('失败时 JSON 输出含 error 字段', async () => {
    const mockExecuteFn: ExecuteFn = async (_args, _progress) => ({
      success: false,
      output: '',
      error: 'LLM 调用失败',
      steps: 0,
    });

    const args: ExecArgs = {
      prompt: '失败任务',
      outputFormat: 'json',
      maxSteps: 10,
      timeout: 5000,
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      const exitCode = await runExec(args, mockExecuteFn);
      expect(exitCode).toBe(EXEC_EXIT_CODE.FAILURE);

      const parsed = JSON.parse(cap.stdout.trim());
      expect(parsed).toHaveProperty('success', false);
      expect(parsed).toHaveProperty('error', 'LLM 调用失败');
    } finally {
      cap.restore();
    }
  });
});

// ============================================================
// 4. --allowedTools 限制后，其他工具被拒绝（白名单逻辑）
// ============================================================
describe('Phase 47 Task 3 - 工具白名单逻辑', () => {
  it('applyToolWhitelist 为不在白名单的工具添加 deny 规则', () => {
    const engine = createDefaultEngine();
    const allTools = ['file_read', 'file_write', 'shell_exec', 'web_search'];
    const allowedTools = ['file_read', 'file_search'];

    applyToolWhitelist(engine, allTools, allowedTools);

    // file_read 在白名单中 → 不被 deny（保持原有 auto 行为）
    const readResult = engine.check('file_read', { path: '/tmp/test.txt' }, 'auto');
    expect(readResult.decision).not.toBe('deny');

    // file_write 不在白名单 → deny
    const writeResult = engine.check('file_write', { path: '/tmp/test.txt', content: 'x' }, 'auto');
    expect(writeResult.decision).toBe('deny');
    expect(writeResult.reason).toContain('白名单限制');

    // shell_exec 不在白名单 → deny
    const shellResult = engine.check('shell_exec', { command: 'ls' }, 'auto');
    expect(shellResult.decision).toBe('deny');
    expect(shellResult.reason).toContain('白名单限制');

    // web_search 不在白名单 → deny
    const webResult = engine.check('web_search', { query: 'test' }, 'auto');
    expect(webResult.decision).toBe('deny');
    expect(webResult.reason).toContain('白名单限制');
  });

  it('白名单中的工具不受影响', () => {
    const engine = createDefaultEngine();
    const allTools = ['file_read', 'file_write'];
    const allowedTools = ['file_read'];

    applyToolWhitelist(engine, allTools, allowedTools);

    // file_read 在白名单 → 保持原有 auto 行为
    const readResult = engine.check('file_read', { path: '/tmp/test.txt' }, 'auto');
    expect(readResult.decision).toBe('auto');
    expect(readResult.matchedRuleId).toBe('auto-file-read');
  });

  it('空白名单不添加任何 deny 规则', () => {
    const engine = createDefaultEngine();
    const originalRuleCount = engine.getRules().length;

    applyToolWhitelist(engine, ['file_read', 'file_write'], []);

    // 空白名单 → 所有工具都被 deny
    expect(engine.getRules().length).toBe(originalRuleCount + 2);
    const readResult = engine.check('file_read', { path: '/tmp/test.txt' }, 'auto');
    expect(readResult.decision).toBe('deny');
  });
});

// ============================================================
// 5. --timeout 超时后返回退出码 2（陷阱 #135）
// ============================================================
describe('Phase 47 Task 3 - 总超时陷阱 #135', () => {
  it('超时后返回退出码 2', async () => {
    // mock executeFn：永不返回（模拟长时间执行）
    const hangingExecuteFn: ExecuteFn = async (_args, _progress) => {
      return new Promise<ExecResult>(() => {
        // 永不 resolve
      });
    };

    const args: ExecArgs = {
      prompt: '超时任务',
      outputFormat: 'json',
      maxSteps: 50,
      timeout: 100, // 100ms 超时
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      const exitCode = await runExec(args, hangingExecuteFn);
      expect(exitCode).toBe(EXEC_EXIT_CODE.TIMEOUT);

      // JSON 模式下超时应输出结构化错误
      const parsed = JSON.parse(cap.stdout.trim());
      expect(parsed).toHaveProperty('success', false);
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toContain('超时');
    } finally {
      cap.restore();
    }
  });

  it('超时前完成返回退出码 0', async () => {
    const quickExecuteFn: ExecuteFn = async (_args, _progress) => {
      return { success: true, output: '快速完成', steps: 1 };
    };

    const args: ExecArgs = {
      prompt: '快速任务',
      outputFormat: 'text',
      maxSteps: 10,
      timeout: 5000, // 5 秒超时，足够快
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      const exitCode = await runExec(args, quickExecuteFn);
      expect(exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);
      expect(cap.stdout.trim()).toBe('快速完成');
    } finally {
      cap.restore();
    }
  });
});

// ============================================================
// 6. 进度信息输出到 stderr，不污染 stdout
// ============================================================
describe('Phase 47 Task 3 - 进度走 stderr', () => {
  it('进度信息输出到 stderr，stdout 只有最终结果', async () => {
    const mockExecuteFn: ExecuteFn = async (_args, progress) => {
      progress('步骤 1/3: 加载配置');
      progress('步骤 2/3: 运行 LLM');
      progress('步骤 3/3: 完成');
      return { success: true, output: '最终结果', steps: 3 };
    };

    const args: ExecArgs = {
      prompt: '测试进度',
      outputFormat: 'text',
      maxSteps: 10,
      timeout: 5000,
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      await runExec(args, mockExecuteFn);

      // stdout 只有最终结果，不包含进度信息
      expect(cap.stdout.trim()).toBe('最终结果');
      expect(cap.stdout).not.toContain('[exec]');
      expect(cap.stdout).not.toContain('步骤');

      // stderr 包含进度信息
      expect(cap.stderr).toContain('[exec]');
      expect(cap.stderr).toContain('步骤 1/3');
      expect(cap.stderr).toContain('步骤 2/3');
      expect(cap.stderr).toContain('步骤 3/3');
    } finally {
      cap.restore();
    }
  });

  it('JSON 模式下 stdout 只有 JSON，进度在 stderr', async () => {
    const mockExecuteFn: ExecuteFn = async (_args, progress) => {
      progress('执行中...');
      return { success: true, output: '结果', steps: 1 };
    };

    const args: ExecArgs = {
      prompt: 'JSON 模式',
      outputFormat: 'json',
      maxSteps: 10,
      timeout: 5000,
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      await runExec(args, mockExecuteFn);

      // stdout 只有 JSON（可解析）
      const parsed = JSON.parse(cap.stdout.trim());
      expect(parsed.success).toBe(true);

      // stderr 包含进度
      expect(cap.stderr).toContain('[exec]');
      expect(cap.stderr).toContain('执行中');
    } finally {
      cap.restore();
    }
  });
});

// ============================================================
// 7. --output result.json 将结果写入文件
// ============================================================
describe('Phase 47 Task 3 - 输出到文件', () => {
  let tempFile: string;

  beforeEach(() => {
    tempFile = makeTempFilePath('result');
  });

  afterEach(() => {
    const dir = path.dirname(tempFile);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--output 将 JSON 结果写入文件，stdout 为空', async () => {
    const mockExecuteFn: ExecuteFn = async (_args, _progress) => ({
      success: true,
      output: '文件输出测试',
      steps: 2,
    });

    const args: ExecArgs = {
      prompt: '文件输出',
      outputFormat: 'json',
      outputFile: tempFile,
      maxSteps: 10,
      timeout: 5000,
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      const exitCode = await runExec(args, mockExecuteFn);
      expect(exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);

      // stdout 应为空（结果写入了文件）
      expect(cap.stdout).toBe('');

      // 文件应包含 JSON 结果
      expect(fs.existsSync(tempFile)).toBe(true);
      const fileContent = fs.readFileSync(tempFile, 'utf-8').trim();
      const parsed = JSON.parse(fileContent);
      expect(parsed).toHaveProperty('success', true);
      expect(parsed).toHaveProperty('output', '文件输出测试');
      expect(parsed).toHaveProperty('steps', 2);
    } finally {
      cap.restore();
    }
  });

  it('--output 将 text 结果写入文件', async () => {
    const mockExecuteFn: ExecuteFn = async (_args, _progress) => ({
      success: true,
      output: '纯文本结果',
      steps: 1,
    });

    const args: ExecArgs = {
      prompt: 'text 文件输出',
      outputFormat: 'text',
      outputFile: tempFile,
      maxSteps: 10,
      timeout: 5000,
      workMode: 'workspace-write',
    };

    const cap = captureOutput();
    try {
      const exitCode = await runExec(args, mockExecuteFn);
      expect(exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);

      // stdout 应为空
      expect(cap.stdout).toBe('');

      // 文件应包含纯文本结果
      expect(fs.existsSync(tempFile)).toBe(true);
      const fileContent = fs.readFileSync(tempFile, 'utf-8').trim();
      expect(fileContent).toBe('纯文本结果');
    } finally {
      cap.restore();
    }
  });
});

// ============================================================
// 8. applyWorkMode 正确设置沙箱级和 headless 模式
// ============================================================
describe('Phase 47 Task 3 - applyWorkMode 权限设置', () => {
  it('read-only 模式：setSandboxLevel + setHeadlessMode', () => {
    const engine = createDefaultEngine();
    applyWorkMode(engine, 'read-only');

    expect(engine.getSandboxLevel()).toBe('read-only');

    // read-only 沙箱下 file_write 被 deny（write 类别不在允许列表）
    const writeResult = engine.check('file_write', { path: '/tmp/test.txt', content: 'x' }, 'auto');
    expect(writeResult.decision).toBe('deny');

    // read-only 沙箱下 shell_exec 被 deny（shell 类别不在允许列表）
    // 陷阱 #136：沙箱级判断在审批级之前，所以原因是沙箱级拒绝而非 headless
    const shellResult = engine.check('shell_exec', { command: 'ls' }, 'auto');
    expect(shellResult.decision).toBe('deny');
    expect(shellResult.reason).toContain('沙箱级拒绝');

    // read-only 沙箱下 file_read 仍可用（read 类别在允许列表）
    const readResult = engine.check('file_read', { path: '/tmp/test.txt' }, 'auto');
    expect(readResult.decision).toBe('auto');
  });

  it('full-access 模式：headless 下 always-ask 工具自动 deny', () => {
    const engine = createDefaultEngine();
    applyWorkMode(engine, 'full-access');

    expect(engine.getSandboxLevel()).toBe('full-access');

    // full-access 沙箱允许 shell 类别，但 headless 下 always-ask 自动 deny
    const shellResult = engine.check('shell_exec', { command: 'ls' }, 'auto');
    expect(shellResult.decision).toBe('deny');
    expect(shellResult.reason).toContain('headless');

    // never-ask 工具不受 headless 影响
    const readResult = engine.check('file_read', { path: '/tmp/test.txt' }, 'auto');
    expect(readResult.decision).toBe('auto');
  });

  it('workspace-write 模式：network 类别被沙箱 deny', () => {
    const engine = createDefaultEngine();
    applyWorkMode(engine, 'workspace-write');

    expect(engine.getSandboxLevel()).toBe('workspace-write');

    // workspace-write 沙箱不允许 network 类别
    const webResult = engine.check('web_fetch', { url: 'https://example.com' }, 'auto');
    expect(webResult.decision).toBe('deny');
    expect(webResult.reason).toContain('沙箱级拒绝');
  });
});
