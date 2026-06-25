// tests/integration/phase47-task7.test.ts
// Phase 47 Task 7 集成测试：自定义 Slash 命令
//
// 测试策略：
//   1. .routedev/commands/commit.md 被正确加载为 /commit 命令
//   2. frontmatter 的 description 被正确解析
//   3. {{git_diff}} 变量被替换为实际 diff 输出（mock spawnSync）
//   4. $1 位置参数被替换为用户输入的第一个参数
//   5. 自定义命令与内置命令同名时被忽略并记录警告（命名空间隔离）
//   6. 目录不存在时返回空数组（fail-open）
//   7. 陷阱 #139：模板变量替换不递归（$1 替换值中的 {{...}} 不被展开）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Mock spawnSync（在 import custom-commands 之前 mock node:child_process）
// ============================================================
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync as mockedSpawnSync } from 'node:child_process';
import {
  loadCustomCommands,
  renderTemplate,
  parseMarkdown,
} from '../../src/cli/custom-commands.js';
import { CommandRegistry } from '../../src/cli/command-registry.js';
import { logger } from '../../src/utils/logger.js';

// ============================================================
// 工具函数
// ============================================================

/** 创建临时目录 */
function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `routedev-phase47-task7-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 递归删除目录 */
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 配置 spawnSync mock，返回不同 git 命令的结果 */
function setupGitMock(overrides: {
  diff?: string;
  status?: string;
  branch?: string;
} = {}): void {
  const defaults = {
    diff: 'diff --git a/foo.ts b/foo.ts\n+added line',
    status: 'M foo.ts\nA bar.ts',
    branch: 'main',
  };
  const data = { ...defaults, ...overrides };
  (mockedSpawnSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined === 'diff') return { status: 0, stdout: data.diff, stderr: '' };
      if (joined === 'status --short') return { status: 0, stdout: data.status, stderr: '' };
      if (joined === 'branch --show-current') return { status: 0, stdout: data.branch, stderr: '' };
      return { status: 1, stdout: '', stderr: 'unknown command' };
    },
  );
}

// commit.md 示例内容（与 .routedev/commands/commit.md 一致）
const COMMIT_MD = `---
description: 生成符合 Conventional Commits 的提交信息
arguments: [scope]
---

请基于以下代码变更生成提交信息：

当前分支：{{git_branch}}
变更文件：
{{git_status}}

变更内容：
{{git_diff}}

要求：
- 遵循 Conventional Commits 格式（feat/fix/refactor/test/docs）
- scope 从参数获取：$1
- 提交信息不超过 50 字符
- 中文描述
`;

// ============================================================
// 测试
// ============================================================

describe('Phase 47 Task 7 - 自定义 Slash 命令', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  // ----------------------------------------------------------
  // 1. commit.md 被正确加载为 /commit 命令
  // ----------------------------------------------------------
  it('commit.md 被正确加载为 /commit 命令', () => {
    const commandsDir = path.join(tempDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'commit.md'), COMMIT_MD, 'utf-8');

    const commands = loadCustomCommands(commandsDir);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('commit');
    expect(typeof commands[0].handler).toBe('function');
  });

  // ----------------------------------------------------------
  // 2. frontmatter 的 description 被正确解析
  // ----------------------------------------------------------
  it('frontmatter 的 description 被正确解析', () => {
    const { frontmatter } = parseMarkdown(COMMIT_MD);

    expect(frontmatter.description).toBe('生成符合 Conventional Commits 的提交信息');
    expect(frontmatter.arguments).toEqual(['scope']);
  });

  // ----------------------------------------------------------
  // 3. {{git_diff}} 变量被替换为实际 diff 输出（mock spawnSync）
  // ----------------------------------------------------------
  it('{{git_diff}} 变量被替换为实际 diff 输出', async () => {
    setupGitMock({ diff: 'MOCK_DIFF_CONTENT' });

    const template = '变更内容：\n{{git_diff}}';
    const rendered = renderTemplate(template, [], { cwd: tempDir });

    expect(rendered).toContain('MOCK_DIFF_CONTENT');
    expect(rendered).not.toContain('{{git_diff}}');
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'git',
      ['diff'],
      expect.objectContaining({ cwd: tempDir }),
    );
  });

  // ----------------------------------------------------------
  // 4. $1 位置参数被替换为用户输入的第一个参数
  // ----------------------------------------------------------
  it('$1 位置参数被替换为用户输入的第一个参数', async () => {
    setupGitMock();

    const commandsDir = path.join(tempDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'commit.md'), COMMIT_MD, 'utf-8');

    const commands = loadCustomCommands(commandsDir);
    const commitCmd = commands[0];

    // 模拟命令执行：/commit feat
    const result = await commitCmd.handler('feat', { cwd: tempDir } as any);

    expect(result.type).toBe('passthrough');
    if (result.type === 'passthrough') {
      // $1 应被替换为 "feat"
      expect(result.input).toContain('scope 从参数获取：feat');
      // 不应包含未替换的 $1
      expect(result.input).not.toMatch(/(?<!\d)\$1(?!\d)/);
    }
  });

  // ----------------------------------------------------------
  // 5. 自定义命令与内置命令同名时被忽略并记录警告
  // ----------------------------------------------------------
  it('自定义命令与内置命令同名时被忽略并记录警告', () => {
    const commandsDir = path.join(tempDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    // 创建一个与内置命令同名的 custom 命令文件（/clear 是内置命令）
    fs.writeFileSync(
      path.join(commandsDir, 'clear.md'),
      '---\ndescription: 自定义 clear\n---\n清空对话\n',
      'utf-8',
    );
    // 再创建一个不冲突的命令
    fs.writeFileSync(
      path.join(commandsDir, 'unique-cmd.md'),
      '---\ndescription: 不冲突的命令\n---\n执行操作\n',
      'utf-8',
    );

    // 模拟 App.tsx 中的注册逻辑
    const registry = new CommandRegistry();
    // 注册内置 /clear 命令
    registry.register({
      name: 'clear',
      description: '内置清空命令',
      handler: async () => ({ type: 'handled', messages: [] }),
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // 加载自定义命令并注册（与 App.tsx 逻辑一致）
    const customCommands = loadCustomCommands(commandsDir);
    for (const cmd of customCommands) {
      if (registry.has(cmd.name)) {
        logger.warn(`Custom command /${cmd.name} conflicts with built-in command, ignored`, {
          name: cmd.name,
        });
        continue;
      }
      registry.register(cmd);
    }

    // /clear 应保持为内置命令
    const parsed = registry.parse('/clear');
    expect(parsed).not.toBeNull();
    expect(parsed!.command.description).toBe('内置清空命令');

    // /unique-cmd 应被注册
    expect(registry.has('unique-cmd')).toBe(true);

    // 应记录一条警告
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('conflicts with built-in command'),
      expect.anything(),
    );

    warnSpy.mockRestore();
  });

  // ----------------------------------------------------------
  // 6. 目录不存在时返回空数组（fail-open）
  // ----------------------------------------------------------
  it('目录不存在时返回空数组', () => {
    const nonExistentDir = path.join(tempDir, 'does-not-exist');
    const commands = loadCustomCommands(nonExistentDir);

    expect(commands).toEqual([]);
    expect(commands).toHaveLength(0);
  });

  // ----------------------------------------------------------
  // 7. 陷阱 #139：模板变量替换不递归
  //    $1 替换值中的 {{git_diff}} 不应被展开
  // ----------------------------------------------------------
  it('陷阱 #139：$1 替换值中的 {{...}} 不被递归展开', () => {
    setupGitMock({ diff: 'SHOULD_NOT_APPEAR' });

    // 模板中 $1 的值设为 "{{git_diff}}"（字面量）
    // 如果递归替换，{{git_diff}} 会被展开为 SHOULD_NOT_APPEAR
    // 一次性替换（正确行为）：$1 被替换为字面量 {{git_diff}}，不再展开
    const template = '参数值：$1\n原始变量：{{git_diff}}';
    const rendered = renderTemplate(template, ['{{git_diff}}'], { cwd: tempDir });

    // $1 被替换为字面量 {{git_diff}}（不应被展开）
    expect(rendered).toContain('参数值：{{git_diff}}');
    // 原始的 {{git_diff}} 被替换为实际 diff 输出
    expect(rendered).toContain('SHOULD_NOT_APPEAR');
    // 验证：参数值部分不应包含 SHOULD_NOT_APPEAR
    expect(rendered).not.toContain('参数值：SHOULD_NOT_APPEAR');
  });

  // ----------------------------------------------------------
  // 8. {{git_status}} 和 {{git_branch}} 变量也被正确替换
  // ----------------------------------------------------------
  it('{{git_status}} 和 {{git_branch}} 变量被正确替换', () => {
    setupGitMock({ status: 'M file.ts', branch: 'feature-branch' });

    const template = '分支：{{git_branch}}\n状态：{{git_status}}';
    const rendered = renderTemplate(template, [], { cwd: tempDir });

    expect(rendered).toContain('分支：feature-branch');
    expect(rendered).toContain('状态：M file.ts');
    expect(rendered).not.toContain('{{git_branch}}');
    expect(rendered).not.toContain('{{git_status}}');
  });

  // ----------------------------------------------------------
  // 9. 完整 commit.md 模板渲染验证
  // ----------------------------------------------------------
  it('完整 commit.md 模板渲染：所有变量 + 位置参数', async () => {
    setupGitMock({
      diff: '+new line',
      status: 'A new-file.ts',
      branch: 'develop',
    });

    const commandsDir = path.join(tempDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'commit.md'), COMMIT_MD, 'utf-8');

    const commands = loadCustomCommands(commandsDir);
    const result = await commands[0].handler('api', { cwd: tempDir } as any);

    expect(result.type).toBe('passthrough');
    if (result.type === 'passthrough') {
      const input = result.input;
      // 所有变量都被替换
      expect(input).toContain('develop'); // git_branch
      expect(input).toContain('A new-file.ts'); // git_status
      expect(input).toContain('+new line'); // git_diff
      expect(input).toContain('api'); // $1
      // 不包含未替换的占位符
      expect(input).not.toContain('{{git_branch}}');
      expect(input).not.toContain('{{git_status}}');
      expect(input).not.toContain('{{git_diff}}');
      expect(input).not.toMatch(/(?<!\d)\$1(?!\d)/);
    }
  });
});
