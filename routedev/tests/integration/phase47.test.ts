// tests/integration/phase47.test.ts
// Phase 47 端到端集成测试：验证 Task 1-9 各模块的协同工作
//
// 测试策略（≥5 个，覆盖全部 Task）：
//   1. AGENTS.md 瘦身后 ≤120 行，pitfalls-guide SKILL.md 存在且包含全部陷阱（Task 1）
//   2. 权限双旋钮 — read-only 沙箱下 file_write 被 deny，workspace-write 下需 confirm（Task 4）
//   3. exec 参数解析 — parseExecArgs 正确解析 prompt + --json + --workMode（Task 3）
//   4. 自定义命令加载 — loadCustomCommands 从目录加载 .md 文件（Task 7）
//   5. fallback 兼容 — loadProjectDoc 支持 AGENTS.md/CLAUDE.md fallback（Task 8）
//   6. description lint — lint-descriptions 脚本存在且可执行（Task 2）
//   7. /review 命令定义正确（Task 5）
//   8. Checkpoint 摘要生成逻辑存在（Task 6）
//   9. GitHub Action action.yml 存在且定义完整（Task 9）
//  10. config.example.yaml 包含 projectDoc 和 security.sandbox 配置段（Task 4 + Task 8）

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseExecArgs } from '../../src/cli/args.js';
import { createDefaultEngine } from '../../src/tools/permission-engine.js';
import { loadCustomCommands } from '../../src/cli/custom-commands.js';
import { loadProjectDoc, DEFAULT_PROJECT_DOC_CONFIG } from '../../src/memory/project-memory.js';
import { runLint } from '../../scripts/lint-descriptions.js';
import { reviewCommand } from '../../src/cli/commands/review.js';
import { CheckpointManager } from '../../src/harness/checkpoint-manager.js';

// ============================================================
// 路径常量
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_MD_PATH = path.join(PROJECT_ROOT, 'AGENTS.md');
const SKILL_MD_PATH = path.join(
  PROJECT_ROOT,
  '.routedev',
  'skills',
  'pitfalls-guide',
  'SKILL.md',
);
const ACTION_YML_PATH = path.join(PROJECT_ROOT, 'action.yml');
const CONFIG_EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config.example.yaml');
const LINT_SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'lint-descriptions.ts');
const REVIEW_CMD_PATH = path.join(PROJECT_ROOT, 'src', 'cli', 'commands', 'review.ts');
const CHECKPOINT_MANAGER_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'harness',
  'checkpoint-manager.ts',
);
const EXEC_RUNNER_PATH = path.join(PROJECT_ROOT, 'src', 'cli', 'exec-runner.ts');
const CUSTOM_COMMANDS_PATH = path.join(PROJECT_ROOT, 'src', 'cli', 'custom-commands.ts');
const ACTION_ENTRY_PATH = path.join(PROJECT_ROOT, 'scripts', 'action-entry.ts');

// ============================================================
// 工具函数
// ============================================================

/** 读取文件行数（按 \n 拆分，过滤末尾空行） */
async function countLines(filePath: string): Promise<number> {
  const content = await fsp.readFile(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length;
}

/** 读取文件内容 */
async function readFile(filePath: string): Promise<string> {
  return fsp.readFile(filePath, 'utf-8');
}

// ============================================================
// 1. AGENTS.md 瘦身后 ≤120 行，SKILL.md 包含全部陷阱（Task 1）
// ============================================================
describe('Phase 47 E2E - Task 1: AGENTS.md 瘦身 + pitfalls-guide SKILL.md', () => {
  it('AGENTS.md 行数 ≤ 120', async () => {
    const lines = await countLines(AGENTS_MD_PATH);
    expect(lines).toBeLessThanOrEqual(120);
  });

  it('pitfalls-guide SKILL.md 文件存在', async () => {
    const stat = await fsp.stat(SKILL_MD_PATH);
    expect(stat.isFile()).toBe(true);
  });

  it('SKILL.md 包含 Phase 47 陷阱章节（#133-142）', async () => {
    const content = await readFile(SKILL_MD_PATH);
    // Phase 47 新增章节应存在
    expect(content).toContain('Phase 47');
    expect(content).toContain('133.');
    expect(content).toContain('142.');
  });

  it('AGENTS.md 保留 Top 10 核心陷阱与完整陷阱索引', async () => {
    const content = await readFile(AGENTS_MD_PATH);
    expect(content).toContain('## Top 10 核心陷阱');
    expect(content).toContain('## 完整陷阱索引');
    // Top 10 编号必须存在
    for (const id of ['#11', '#14', '#16', '#18', '#23', '#27', '#45', '#54', '#60', '#62']) {
      expect(content).toContain(id);
    }
  });
});

// ============================================================
// 2. 权限双旋钮 — read-only 沙箱 deny，workspace-write confirm（Task 4）
// ============================================================
describe('Phase 47 E2E - Task 4: 权限双旋钮（SandboxLevel + ApprovalLevel）', () => {
  it('read-only 沙箱下 file_write 被 deny（write 类别不在允许列表）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('read-only');

    const result = engine.check(
      'file_write',
      { path: '/tmp/test.txt', content: 'x' },
      'auto',
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('沙箱级拒绝');
  });

  it('workspace-write 沙箱下 file_write 通过沙箱，需 confirm', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('workspace-write');

    const result = engine.check(
      'file_write',
      { path: '/tmp/test.txt', content: 'x' },
      'semi',
    );
    // workspace-write 允许 write 类别，file_write 无 auto 规则 → fallback confirm
    expect(result.decision).not.toBe('deny');
    expect(result.decision).toBe('confirm');
  });

  it('沙箱级判断在审批级之前（陷阱 #136）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('read-only');
    // 即使设置 write 审批为 never-ask，read-only 沙箱仍 deny
    engine.setApproval('write', 'never-ask');

    const result = engine.check(
      'file_write',
      { path: '/tmp/test.txt', content: 'x' },
      'semi',
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('沙箱级拒绝');
    expect(result.reason).not.toContain('never-ask');
  });

  it('headless 模式下 always-ask 工具自动 deny（陷阱 #135）', () => {
    const engine = createDefaultEngine();
    engine.setSandboxLevel('full-access');
    engine.setHeadlessMode(true);

    // shell 类别默认 always-ask，headless 下自动 deny
    const result = engine.check('shell_exec', { command: 'ls' }, 'auto');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('headless');
  });
});

// ============================================================
// 3. exec 参数解析 — parseExecArgs（Task 3）
// ============================================================
describe('Phase 47 E2E - Task 3: parseExecArgs 参数解析', () => {
  it('正确解析 prompt + --json + --workMode', () => {
    const args = parseExecArgs([
      'exec',
      '审查 PR 代码',
      '--json',
      '--workMode',
      'read-only',
    ]);

    expect(args).not.toBeNull();
    expect(args!.prompt).toBe('审查 PR 代码');
    expect(args!.outputFormat).toBe('json');
    expect(args!.workMode).toBe('read-only');
  });

  it('默认 workMode 为 workspace-write', () => {
    const args = parseExecArgs(['exec', '简单任务']);
    expect(args).not.toBeNull();
    expect(args!.workMode).toBe('workspace-write');
    expect(args!.outputFormat).toBe('text');
    expect(args!.timeout).toBe(300000); // 默认 5 分钟
  });

  it('非 exec 子命令返回 null', () => {
    expect(parseExecArgs(['serve'])).toBeNull();
    expect(parseExecArgs(['--version'])).toBeNull();
  });

  it('exec 缺少 prompt 返回 null', () => {
    expect(parseExecArgs(['exec', '--json'])).toBeNull();
  });

  it('exec-runner.ts 文件存在且导出 runExec', async () => {
    const stat = await fsp.stat(EXEC_RUNNER_PATH);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(EXEC_RUNNER_PATH);
    expect(content).toContain('export async function runExec');
    expect(content).toContain('EXEC_EXIT_CODE');
  });
});

// ============================================================
// 4. 自定义命令加载 — loadCustomCommands（Task 7）
// ============================================================
describe('Phase 47 E2E - Task 7: 自定义命令加载', () => {
  it('loadCustomCommands 函数已导出', () => {
    expect(typeof loadCustomCommands).toBe('function');
  });

  it('custom-commands.ts 文件存在且包含 loadCustomCommands', async () => {
    const stat = await fsp.stat(CUSTOM_COMMANDS_PATH);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(CUSTOM_COMMANDS_PATH);
    expect(content).toContain('export function loadCustomCommands');
    // 陷阱 #139：模板变量替换不递归
    expect(content).toContain('#139');
  });

  it('从 .routedev/commands/ 目录加载 .md 文件', async () => {
    const commandsDir = path.join(PROJECT_ROOT, '.routedev', 'commands');
    const dirExists = fs.existsSync(commandsDir);
    if (dirExists) {
      const commands = loadCustomCommands(commandsDir);
      expect(Array.isArray(commands)).toBe(true);
      // 目录下应有 .md 文件被加载（commit.md）
      const mdFiles = fs
        .readdirSync(commandsDir)
        .filter((f) => f.endsWith('.md'));
      expect(commands.length).toBe(mdFiles.length);
    }
  });

  it('目录不存在时返回空数组（fail-open）', () => {
    const commands = loadCustomCommands(path.join(PROJECT_ROOT, 'does-not-exist-xyz'));
    expect(commands).toEqual([]);
  });
});

// ============================================================
// 5. fallback 兼容 — loadProjectDoc（Task 8）
// ============================================================
describe('Phase 47 E2E - Task 8: loadProjectDoc fallback 兼容', () => {
  it('loadProjectDoc 函数已导出', () => {
    expect(typeof loadProjectDoc).toBe('function');
  });

  it('DEFAULT_PROJECT_DOC_CONFIG 包含 AGENTS.md 和 CLAUDE.md fallback', () => {
    expect(DEFAULT_PROJECT_DOC_CONFIG.filenames).toContain('AGENTS.md');
    expect(DEFAULT_PROJECT_DOC_CONFIG.filenames).toContain('AGENTS.local.md');
    expect(DEFAULT_PROJECT_DOC_CONFIG.filenames).toContain('AGENTS.override.md');
    expect(DEFAULT_PROJECT_DOC_CONFIG.fallbackFilenames).toContain('CLAUDE.md');
    expect(DEFAULT_PROJECT_DOC_CONFIG.fallbackFilenames).toContain('CLAUDE.local.md');
    expect(DEFAULT_PROJECT_DOC_CONFIG.maxBytes).toBe(32768);
  });

  it('AGENTS.md 不存在时 fallback 到 CLAUDE.md', async () => {
    const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'routedev-e2e-'));
    try {
      await fsp.writeFile(
        path.join(tmpDir, 'CLAUDE.md'),
        '# Claude\n\nCLAUDE_FALLBACK_CONTENT',
        'utf-8',
      );
      const doc = await loadProjectDoc(tmpDir);
      expect(doc).not.toBeNull();
      expect(doc).toContain('CLAUDE_FALLBACK_CONTENT');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('AGENTS.override.md 存在时跳过 AGENTS.md（陷阱 #140）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'routedev-e2e-'));
    try {
      await fsp.writeFile(
        path.join(tmpDir, 'AGENTS.md'),
        '# Base\n\nBASE_NOT_USED',
        'utf-8',
      );
      await fsp.writeFile(
        path.join(tmpDir, 'AGENTS.override.md'),
        '# Override\n\nOVERRIDE_CONTENT',
        'utf-8',
      );
      const doc = await loadProjectDoc(tmpDir);
      expect(doc).not.toBeNull();
      expect(doc).toContain('OVERRIDE_CONTENT');
      expect(doc).not.toContain('BASE_NOT_USED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 6. description lint — lint-descriptions 脚本（Task 2）
// ============================================================
describe('Phase 47 E2E - Task 2: description lint 脚本', () => {
  it('scripts/lint-descriptions.ts 文件存在', () => {
    expect(fs.existsSync(LINT_SCRIPT_PATH)).toBe(true);
  });

  it('lint-descriptions.ts 导出 runLint / checkDescription / extractToolDescription', async () => {
    const content = await readFile(LINT_SCRIPT_PATH);
    expect(content).toContain('export function runLint');
    expect(content).toContain('export function checkDescription');
    expect(content).toContain('export function extractToolDescription');
  });

  it('runLint() 可执行且返回合规报告（无 error）', () => {
    const report = runLint();
    expect(report).toHaveProperty('passed');
    expect(report).toHaveProperty('errors');
    expect(report).toHaveProperty('total');
    // 过渡期不阻断开发流程（陷阱 #134）
    expect(report.errors).toBe(0);
    expect(report.passed).toBe(true);
  });
});

// ============================================================
// 7. /review 命令定义正确（Task 5）
// ============================================================
describe('Phase 47 E2E - Task 5: /review 命令定义', () => {
  it('reviewCommand 已导出且字段完整', () => {
    expect(reviewCommand).toBeDefined();
    expect(reviewCommand.name).toBe('review');
    expect(typeof reviewCommand.handler).toBe('function');
    expect(reviewCommand.description).toContain('审查');
  });

  it('review.ts 文件存在且包含沙箱级兜底逻辑（陷阱 #137）', async () => {
    const stat = await fsp.stat(REVIEW_CMD_PATH);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(REVIEW_CMD_PATH);
    // 陷阱 #137：/review 子代理必须用 read-only 沙箱
    expect(content).toContain('read-only');
    expect(content).toContain('#137');
    // subagentType: 'reviewer' 白名单
    expect(content).toContain('reviewer');
  });
});

// ============================================================
// 8. Checkpoint 摘要生成逻辑存在（Task 6）
// ============================================================
describe('Phase 47 E2E - Task 6: Checkpoint 语义化摘要', () => {
  it('CheckpointManager 类已导出', () => {
    expect(typeof CheckpointManager).toBe('function');
  });

  it('checkpoint-manager.ts 包含 generateSummary 和 setLLMClient 方法', async () => {
    const stat = await fsp.stat(CHECKPOINT_MANAGER_PATH);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(CHECKPOINT_MANAGER_PATH);
    expect(content).toContain('async generateSummary');
    expect(content).toContain('setLLMClient');
    // 陷阱 #138：LLM 调用必须设超时与降级
    expect(content).toContain('#138');
    expect(content).toContain('timeout');
  });

  it('CheckpointTimeline.tsx 组件文件存在', async () => {
    const timelinePath = path.join(
      PROJECT_ROOT,
      'desktop',
      'renderer',
      'src',
      'components',
      'CheckpointTimeline.tsx',
    );
    const stat = await fsp.stat(timelinePath);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(timelinePath);
    expect(content).toContain('CheckpointTimeline');
  });
});

// ============================================================
// 9. GitHub Action action.yml 存在且定义完整（Task 9）
// ============================================================
describe('Phase 47 E2E - Task 9: GitHub Action 定义', () => {
  it('action.yml 文件存在且可解析为 YAML', () => {
    expect(fs.existsSync(ACTION_YML_PATH)).toBe(true);
    const content = fs.readFileSync(ACTION_YML_PATH, 'utf-8');
    const action = parseYaml(content) as Record<string, unknown>;
    expect(action).toBeDefined();
    expect(typeof action).toBe('object');
  });

  it('action.yml 包含 name / inputs / outputs / runs 字段', () => {
    const content = fs.readFileSync(ACTION_YML_PATH, 'utf-8');
    const action = parseYaml(content) as {
      name: string;
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      runs: { using: string; main: string };
    };
    expect(action.name).toBeDefined();
    expect(action.inputs).toBeDefined();
    expect(action.outputs).toBeDefined();
    expect(action.runs).toBeDefined();
    expect(action.runs.using).toBe('node20');
    expect(action.runs.main).toBe('dist/index.js');
  });

  it('action.yml inputs 包含 prompt / work-mode / allowed-tools / config', () => {
    const content = fs.readFileSync(ACTION_YML_PATH, 'utf-8');
    const action = parseYaml(content) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
    };
    const keys = Object.keys(action.inputs);
    expect(keys).toContain('prompt');
    expect(keys).toContain('work-mode');
    expect(keys).toContain('allowed-tools');
    expect(keys).toContain('config');
    // prompt 必填
    expect(action.inputs.prompt.required).toBe(true);
  });

  it('scripts/action-entry.ts 入口脚本存在且导出关键函数', async () => {
    const stat = await fsp.stat(ACTION_ENTRY_PATH);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(ACTION_ENTRY_PATH);
    expect(content).toContain('export async function main');
    expect(content).toContain('export function readActionInputs');
    expect(content).toContain('export function decodeConfigToTempFile');
    // 陷阱 #141：config 必须用 Base64 传输
    expect(content).toContain('base64');
    expect(content).toContain('#141');
  });
});

// ============================================================
// 10. config.example.yaml 包含 projectDoc 和 security.sandbox（Task 4 + Task 8）
// ============================================================
describe('Phase 47 E2E - config.example.yaml 配置段', () => {
  it('config.example.yaml 文件存在且可解析', () => {
    expect(fs.existsSync(CONFIG_EXAMPLE_PATH)).toBe(true);
    const content = fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });

  it('包含 security.sandbox 配置段（Task 4）', () => {
    const content = fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf-8');
    const config = parseYaml(content) as {
      security: { sandbox?: string; approval?: Record<string, string> };
    };
    expect(config.security).toBeDefined();
    expect(config.security.sandbox).toBeDefined();
    expect(config.security.sandbox).toBe('workspace-write');
  });

  it('包含 projectDoc 配置段（Task 8）', () => {
    const content = fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf-8');
    const config = parseYaml(content) as {
      projectDoc: {
        filenames: string[];
        fallbackFilenames: string[];
        maxBytes: number;
      };
    };
    expect(config.projectDoc).toBeDefined();
    expect(config.projectDoc.filenames).toContain('AGENTS.md');
    expect(config.projectDoc.filenames).toContain('AGENTS.local.md');
    expect(config.projectDoc.filenames).toContain('AGENTS.override.md');
    expect(config.projectDoc.fallbackFilenames).toContain('CLAUDE.md');
    expect(config.projectDoc.fallbackFilenames).toContain('CLAUDE.local.md');
    expect(config.projectDoc.maxBytes).toBe(32768);
  });

  it('config.example.yaml 注释包含陷阱 #140 / #141 引用', async () => {
    const content = await readFile(CONFIG_EXAMPLE_PATH);
    // 陷阱 #140：override 语义是「跳过」而非「合并」
    expect(content).toContain('#140');
    // Phase 47 Task 4 / Task 8 标记
    expect(content).toContain('Phase 47 Task 4');
    expect(content).toContain('Phase 47 Task 8');
  });
});
