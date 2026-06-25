// tests/integration/phase47-task9.test.ts
// Phase 47 Task 9 集成测试：官方 GitHub Action 与 CI 集成模板
//
// 测试策略：
//   1. action.yml 的 inputs/outputs 定义完整（解析 YAML 验证）
//   2. 入口脚本能正确解析 inputs（mock 环境变量）
//   3. config Base64 解码正确（验证解码逻辑）
//   4. 示例 workflow 语法合法（基本结构验证）
//   5. CI_SECURITY.md 存在且包含关键安全规范
//   6. validateInputs 校验逻辑（必填项 + 工作模式枚举）
//   7. buildExecArgs 构造命令参数正确
//   8. mapWorkModeToSandbox 映射正确

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  readActionInputs,
  validateInputs,
  decodeConfigToTempFile,
  cleanupTempConfig,
  mapWorkModeToSandbox,
  buildExecArgs,
  buildExecEnv,
  writeGitHubOutput,
  type ActionInputs,
} from '../../scripts/action-entry.js';

// ============================================================
// 路径常量
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ACTION_YML_PATH = path.join(PROJECT_ROOT, 'action.yml');
const WORKFLOW_YML_PATH = path.join(PROJECT_ROOT, '.github', 'workflows', 'routedev-example.yml');
const CI_SECURITY_MD_PATH = path.join(PROJECT_ROOT, 'docs', 'CI_SECURITY.md');
const ENTRY_TS_PATH = path.join(PROJECT_ROOT, 'scripts', 'action-entry.ts');

// ============================================================
// 工具函数
// ============================================================

/** 读取文件内容 */
function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/** 创建临时目录 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-task9-'));
}

// ============================================================
// 1. action.yml 的 inputs/outputs 定义完整（解析 YAML 验证）
// ============================================================
describe('Phase 47 Task 9 - action.yml 定义完整', () => {
  it('action.yml 文件存在且可解析为 YAML', () => {
    expect(fs.existsSync(ACTION_YML_PATH)).toBe(true);
    const content = readFile(ACTION_YML_PATH);
    const action = parseYaml(content) as Record<string, unknown>;
    expect(action).toBeDefined();
    expect(typeof action).toBe('object');
  });

  it('action.yml 包含 name / description / inputs / outputs / runs 字段', () => {
    const action = parseYaml(readFile(ACTION_YML_PATH)) as Record<string, unknown>;
    expect(action.name).toBeDefined();
    expect(typeof action.name).toBe('string');
    expect(action.description).toBeDefined();
    expect(typeof action.description).toBe('string');
    expect(action.inputs).toBeDefined();
    expect(typeof action.inputs).toBe('object');
    expect(action.outputs).toBeDefined();
    expect(typeof action.outputs).toBe('object');
    expect(action.runs).toBeDefined();
    expect(typeof action.runs).toBe('object');
  });

  it('action.yml inputs 包含 prompt / work-mode / allowed-tools / config 四个字段', () => {
    const action = parseYaml(readFile(ACTION_YML_PATH)) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
    };
    const inputKeys = Object.keys(action.inputs);
    expect(inputKeys).toContain('prompt');
    expect(inputKeys).toContain('work-mode');
    expect(inputKeys).toContain('allowed-tools');
    expect(inputKeys).toContain('config');
  });

  it('action.yml prompt 为 required，其他 inputs 有默认值', () => {
    const action = parseYaml(readFile(ACTION_YML_PATH)) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
    };
    // prompt 必填
    expect(action.inputs.prompt.required).toBe(true);
    // work-mode 有默认值 workspace-write
    expect(action.inputs['work-mode'].required).not.toBe(true);
    expect(action.inputs['work-mode'].default).toBe('workspace-write');
    // allowed-tools 默认空
    expect(action.inputs['allowed-tools'].default).toBe('');
    // config 默认空
    expect(action.inputs.config.default).toBe('');
  });

  it('action.yml outputs 包含 result 字段', () => {
    const action = parseYaml(readFile(ACTION_YML_PATH)) as {
      outputs: Record<string, { description?: string; value?: string }>;
    };
    expect(action.outputs.result).toBeDefined();
    expect(action.outputs.result.description).toBeDefined();
    expect(action.outputs.result.value).toContain('result');
  });

  it('action.yml runs 使用 node20 + dist/index.js', () => {
    const action = parseYaml(readFile(ACTION_YML_PATH)) as {
      runs: { using: string; main: string };
    };
    expect(action.runs.using).toBe('node20');
    expect(action.runs.main).toBe('dist/index.js');
  });
});

// ============================================================
// 2. 入口脚本能正确解析 inputs（mock 环境变量）
// ============================================================
describe('Phase 47 Task 9 - 入口脚本解析 inputs', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // 恢复环境变量
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('INPUT_')) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('readActionInputs 从 INPUT_* 环境变量读取 inputs', () => {
    process.env.INPUT_PROMPT = '审查 PR 代码';
    process.env.INPUT_WORK_MODE = 'read-only';
    process.env.INPUT_ALLOWED_TOOLS = 'file_read,file_search';
    process.env.INPUT_CONFIG = 'dmVyc2lvbjogMQ==';

    const inputs = readActionInputs();
    expect(inputs.prompt).toBe('审查 PR 代码');
    expect(inputs.workMode).toBe('read-only');
    expect(inputs.allowedTools).toBe('file_read,file_search');
    expect(inputs.config).toBe('dmVyc2lvbjogMQ==');
  });

  it('readActionInputs 在无环境变量时使用默认值', () => {
    // 清除所有 INPUT_ 环境变量
    delete process.env.INPUT_PROMPT;
    delete process.env.INPUT_WORK_MODE;
    delete process.env.INPUT_ALLOWED_TOOLS;
    delete process.env.INPUT_CONFIG;

    const inputs = readActionInputs();
    expect(inputs.prompt).toBe('');
    expect(inputs.workMode).toBe('workspace-write');
    expect(inputs.allowedTools).toBe('');
    expect(inputs.config).toBe('');
  });

  it('readActionInputs 支持自定义 env 参数（不污染 process.env）', () => {
    const customEnv = {
      INPUT_PROMPT: '自定义任务',
      INPUT_WORK_MODE: 'full-access',
      INPUT_ALLOWED_TOOLS: '',
      INPUT_CONFIG: '',
    } as NodeJS.ProcessEnv;
    const inputs = readActionInputs(customEnv);
    expect(inputs.prompt).toBe('自定义任务');
    expect(inputs.workMode).toBe('full-access');
  });
});

// ============================================================
// 3. config Base64 解码正确（验证解码逻辑）
// ============================================================
describe('Phase 47 Task 9 - config Base64 解码', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    // 清理所有临时目录
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
    tempDirs = [];
  });

  it('decodeConfigToTempFile 正确解码 Base64 并写入临时文件', () => {
    // 原始 config 内容
    const originalConfig = 'version: 1\nproviders:\n  - id: test\n    apiKey: ${ROUTEDEV_API_KEY}\n';
    // Base64 编码
    const base64 = Buffer.from(originalConfig, 'utf-8').toString('base64');

    const configPath = decodeConfigToTempFile(base64);
    expect(configPath).not.toBeNull();
    tempDirs.push(path.resolve(configPath!, '..'));

    // 文件应存在
    expect(fs.existsSync(configPath!)).toBe(true);
    // 内容应与原始内容一致
    const content = fs.readFileSync(configPath!, 'utf-8');
    expect(content).toBe(originalConfig);
    // 应包含 ${ROUTEDEV_API_KEY}（API Key 走环境变量，不写入 config）
    expect(content).toContain('${ROUTEDEV_API_KEY}');
  });

  it('decodeConfigToTempFile 空字符串返回 null（不创建文件）', () => {
    const result = decodeConfigToTempFile('');
    expect(result).toBeNull();
  });

  it('decodeConfigToTempFile 解码中文内容正确', () => {
    const originalConfig = '# 中文注释\nversion: 1\n';
    const base64 = Buffer.from(originalConfig, 'utf-8').toString('base64');

    const configPath = decodeConfigToTempFile(base64);
    expect(configPath).not.toBeNull();
    tempDirs.push(path.resolve(configPath!, '..'));

    const content = fs.readFileSync(configPath!, 'utf-8');
    expect(content).toBe(originalConfig);
    expect(content).toContain('中文注释');
  });

  it('cleanupTempConfig 清理临时文件和目录', () => {
    const base64 = Buffer.from('version: 1', 'utf-8').toString('base64');
    const configPath = decodeConfigToTempFile(base64);
    expect(configPath).not.toBeNull();
    expect(fs.existsSync(configPath!)).toBe(true);

    cleanupTempConfig(configPath);
    // 文件应被删除
    expect(fs.existsSync(configPath!)).toBe(false);
  });

  it('cleanupTempConfig 传入 null 不报错', () => {
    expect(() => cleanupTempConfig(null)).not.toThrow();
  });

  it('陷阱 #141 验证：Base64 传输避免 YAML 转义问题', () => {
    // 包含特殊字符的 config（多行 YAML + 引号 + 冒号）
    const originalConfig = `version: 1
providers:
  - id: "test:provider"
    name: "Test's Provider"
    apiKey: \${ROUTEDEV_API_KEY}
security:
  commandBlacklist: ["rm -rf", "format", "del /s"]
`;
    const base64 = Buffer.from(originalConfig, 'utf-8').toString('base64');

    // Base64 编码后应为纯 ASCII
    expect(/^[A-Za-z0-9+/=]+$/.test(base64)).toBe(true);

    // 解码后内容应与原始一致
    const configPath = decodeConfigToTempFile(base64);
    expect(configPath).not.toBeNull();
    tempDirs.push(path.resolve(configPath!, '..'));

    const content = fs.readFileSync(configPath!, 'utf-8');
    expect(content).toBe(originalConfig);
    expect(content).toContain("Test's Provider");
    expect(content).toContain('"rm -rf"');
  });
});

// ============================================================
// 4. 示例 workflow 语法合法（基本结构验证）
// ============================================================
describe('Phase 47 Task 9 - 示例 workflow 语法合法', () => {
  it('workflow 文件存在且可解析为 YAML', () => {
    expect(fs.existsSync(WORKFLOW_YML_PATH)).toBe(true);
    const content = readFile(WORKFLOW_YML_PATH);
    const workflow = parseYaml(content) as Record<string, unknown>;
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe('object');
  });

  it('workflow 包含 name / on / jobs 字段', () => {
    const workflow = parseYaml(readFile(WORKFLOW_YML_PATH)) as Record<string, unknown>;
    expect(workflow.name).toBeDefined();
    expect(workflow.on).toBeDefined();
    expect(workflow.jobs).toBeDefined();
    expect(typeof workflow.jobs).toBe('object');
  });

  it('workflow trigger 为 pull_request', () => {
    const workflow = parseYaml(readFile(WORKFLOW_YML_PATH)) as {
      on: Record<string, unknown> | string;
    };
    // on 可以是对象或字符串
    if (typeof workflow.on === 'object' && workflow.on !== null) {
      expect(workflow.on).toHaveProperty('pull_request');
    } else {
      expect(workflow.on).toBe('pull_request');
    }
  });

  it('workflow 包含 permissions 字段且最小化（contents: read）', () => {
    const workflow = parseYaml(readFile(WORKFLOW_YML_PATH)) as {
      permissions: Record<string, string>;
    };
    expect(workflow.permissions).toBeDefined();
    expect(workflow.permissions.contents).toBe('read');
    // PR 审查需要 pull-requests: write（发评论）
    expect(workflow.permissions['pull-requests']).toBe('write');
  });

  it('workflow job 包含 checkout + RouteDev + 评论三个步骤', () => {
    const workflow = parseYaml(readFile(WORKFLOW_YML_PATH)) as {
      jobs: Record<string, {
        steps: Array<{ name?: string; uses?: string }>;
      }>;
    };
    const job = workflow.jobs.review;
    expect(job).toBeDefined();
    expect(job.steps.length).toBeGreaterThanOrEqual(3);

    const stepNames = job.steps.map((s) => s.name ?? s.uses ?? '');
    // 应包含 checkout 步骤
    expect(stepNames.some((n) => n.toLowerCase().includes('checkout'))).toBe(true);
    // 应包含 RouteDev 步骤
    expect(stepNames.some((n) => n.toLowerCase().includes('routedev'))).toBe(true);
    // 应包含评论步骤
    expect(stepNames.some((n) => n.toLowerCase().includes('comment') || n.toLowerCase().includes('评论'))).toBe(true);
  });

  it('workflow 使用 secrets.ROUTEDEV_API_KEY（不硬编码）', () => {
    const content = readFile(WORKFLOW_YML_PATH);
    expect(content).toContain('secrets.ROUTEDEV_API_KEY');
    // 不应包含明文 API Key
    expect(content).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
  });

  it('workflow RouteDev 步骤使用 read-only 工作模式', () => {
    const content = readFile(WORKFLOW_YML_PATH);
    // PR 审查场景应使用 read-only
    expect(content).toContain('read-only');
  });
});

// ============================================================
// 5. CI_SECURITY.md 存在且包含关键安全规范
// ============================================================
describe('Phase 47 Task 9 - CI_SECURITY.md 安全规范', () => {
  it('CI_SECURITY.md 文件存在', () => {
    expect(fs.existsSync(CI_SECURITY_MD_PATH)).toBe(true);
  });

  it('CI_SECURITY.md 包含密钥管理规范', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    expect(content).toContain('密钥管理');
    expect(content).toContain('Secrets');
    expect(content).toContain('ROUTEDEV_API_KEY');
  });

  it('CI_SECURITY.md 包含权限最小化规范', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    expect(content).toContain('权限最小化');
    expect(content).toContain('read-only');
    expect(content).toContain('workspace-write');
    expect(content).toContain('full-access');
  });

  it('CI_SECURITY.md 禁止 full-access 在 CI 中使用', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    // 应明确禁止 full-access 在 CI 中使用
    expect(content).toMatch(/full-access.*禁止|禁止.*full-access/s);
  });

  it('CI_SECURITY.md 包含 config Base64 传输规范（陷阱 #141）', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    expect(content).toContain('Base64');
    expect(content).toContain('#141');
  });

  it('CI_SECURITY.md 包含输出处理规范（脱敏）', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    expect(content).toContain('输出处理');
    expect(content).toMatch(/脱敏|sanitize|REDACTED/i);
  });

  it('CI_SECURITY.md 包含 API Key 不写入 config 的规则', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    // 应明确说明 API Key 不要写入 config
    expect(content).toMatch(/API Key.*不.*写入.*config|不.*写入.*config.*API Key/is);
  });

  it('CI_SECURITY.md 包含禁止事项清单', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    expect(content).toContain('禁止事项');
  });

  it('CI_SECURITY.md 包含检查清单', () => {
    const content = readFile(CI_SECURITY_MD_PATH);
    expect(content).toContain('检查清单');
  });
});

// ============================================================
// 6. validateInputs 校验逻辑
// ============================================================
describe('Phase 47 Task 9 - validateInputs 校验逻辑', () => {
  it('prompt 为空时返回错误', () => {
    const inputs: ActionInputs = {
      prompt: '',
      workMode: 'read-only',
      allowedTools: '',
      config: '',
    };
    const errors = validateInputs(inputs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('prompt'))).toBe(true);
  });

  it('work-mode 非法时返回错误', () => {
    const inputs: ActionInputs = {
      prompt: 'test',
      workMode: 'invalid-mode',
      allowedTools: '',
      config: '',
    };
    const errors = validateInputs(inputs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('work-mode'))).toBe(true);
  });

  it('合法 inputs 返回空错误数组', () => {
    const inputs: ActionInputs = {
      prompt: '审查代码',
      workMode: 'read-only',
      allowedTools: 'file_read',
      config: '',
    };
    const errors = validateInputs(inputs);
    expect(errors).toEqual([]);
  });

  it('三种合法工作模式均通过校验', () => {
    for (const mode of ['read-only', 'workspace-write', 'full-access']) {
      const inputs: ActionInputs = {
        prompt: 'test',
        workMode: mode,
        allowedTools: '',
        config: '',
      };
      const errors = validateInputs(inputs);
      expect(errors.filter((e) => e.includes('work-mode'))).toEqual([]);
    }
  });
});

// ============================================================
// 7. buildExecArgs 构造命令参数
// ============================================================
describe('Phase 47 Task 9 - buildExecArgs 构造命令参数', () => {
  it('构造的命令包含 exec + prompt + --json', () => {
    const inputs: ActionInputs = {
      prompt: '审查代码',
      workMode: 'read-only',
      allowedTools: '',
      config: '',
    };
    const args = buildExecArgs(inputs, null);
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('审查代码');
    expect(args).toContain('--json');
  });

  it('有 configPath 时包含 --config 参数', () => {
    const inputs: ActionInputs = {
      prompt: 'test',
      workMode: 'read-only',
      allowedTools: '',
      config: '',
    };
    const args = buildExecArgs(inputs, '/tmp/config.yaml');
    expect(args).toContain('--config');
    const configIdx = args.indexOf('--config');
    expect(args[configIdx + 1]).toBe('/tmp/config.yaml');
  });

  it('无 configPath 时不包含 --config 参数', () => {
    const inputs: ActionInputs = {
      prompt: 'test',
      workMode: 'read-only',
      allowedTools: '',
      config: '',
    };
    const args = buildExecArgs(inputs, null);
    expect(args).not.toContain('--config');
  });
});

// ============================================================
// 8. mapWorkModeToSandbox 映射 + buildExecEnv 环境变量
// ============================================================
describe('Phase 47 Task 9 - 工作模式映射与环境变量', () => {
  it('mapWorkModeToSandbox 正确映射三种模式', () => {
    expect(mapWorkModeToSandbox('read-only')).toBe('read-only');
    expect(mapWorkModeToSandbox('workspace-write')).toBe('workspace-write');
    expect(mapWorkModeToSandbox('full-access')).toBe('full-access');
  });

  it('mapWorkModeToSandbox 未知模式默认 workspace-write', () => {
    expect(mapWorkModeToSandbox('unknown')).toBe('workspace-write');
    expect(mapWorkModeToSandbox('')).toBe('workspace-write');
  });

  it('buildExecEnv 注入 ROUTEDEV_SANDBOX 环境变量', () => {
    const inputs: ActionInputs = {
      prompt: 'test',
      workMode: 'read-only',
      allowedTools: '',
      config: '',
    };
    const env = buildExecEnv(inputs, {});
    expect(env.ROUTEDEV_SANDBOX).toBe('read-only');
  });

  it('buildExecEnv 有 allowed-tools 时注入 ROUTEDEV_ALLOWED_TOOLS', () => {
    const inputs: ActionInputs = {
      prompt: 'test',
      workMode: 'workspace-write',
      allowedTools: 'file_read,file_search',
      config: '',
    };
    const env = buildExecEnv(inputs, {});
    expect(env.ROUTEDEV_ALLOWED_TOOLS).toBe('file_read,file_search');
  });

  it('buildExecEnv 无 allowed-tools 时不注入 ROUTEDEV_ALLOWED_TOOLS', () => {
    const inputs: ActionInputs = {
      prompt: 'test',
      workMode: 'workspace-write',
      allowedTools: '',
      config: '',
    };
    const env = buildExecEnv(inputs, {});
    expect(env.ROUTEDEV_ALLOWED_TOOLS).toBeUndefined();
  });
});

// ============================================================
// 9. writeGitHubOutput 输出写入
// ============================================================
describe('Phase 47 Task 9 - writeGitHubOutput 输出写入', () => {
  let tempFile: string;

  beforeEach(() => {
    tempFile = path.join(makeTempDir(), 'output.txt');
  });

  afterEach(() => {
    try {
      fs.rmSync(path.resolve(tempFile, '..'), { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  it('writeGitHubOutput 写入 result 字段（heredoc 格式）', () => {
    const result = {
      status: 'success' as const,
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      durationMs: 100,
    };
    writeGitHubOutput(result, tempFile);
    const content = fs.readFileSync(tempFile, 'utf-8');
    expect(content).toContain('result<<EOF');
    expect(content).toContain('"status":"success"');
    expect(content).toContain('EOF');
  });

  it('writeGitHubOutput 无文件路径时跳过（非 GitHub 环境）', () => {
    const original = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;
    expect(() => writeGitHubOutput({
      status: 'success',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
    })).not.toThrow();
    process.env.GITHUB_OUTPUT = original;
  });
});

// ============================================================
// 10. 入口脚本文件存在性验证
// ============================================================
describe('Phase 47 Task 9 - 入口脚本文件存在', () => {
  it('scripts/action-entry.ts 文件存在', () => {
    expect(fs.existsSync(ENTRY_TS_PATH)).toBe(true);
  });

  it('action-entry.ts 包含 main 函数和导出的工具函数', () => {
    const content = readFile(ENTRY_TS_PATH);
    expect(content).toContain('export async function main');
    expect(content).toContain('export function readActionInputs');
    expect(content).toContain('export function decodeConfigToTempFile');
    expect(content).toContain('export function buildExecArgs');
    expect(content).toContain('export function mapWorkModeToSandbox');
  });

  it('action-entry.ts 不引入 @actions/core 依赖（陷阱：零依赖）', () => {
    const content = readFile(ENTRY_TS_PATH);
    // 不应 import @actions/core（检查 import/require 语句，而非注释中的提及）
    expect(content).not.toMatch(/import\s+.*from\s+['"]@actions\/core['"]/);
    expect(content).not.toMatch(/require\(['"]@actions\/core['"]\)/);
    // 应直接读取 process.env.INPUT_
    expect(content).toContain('process.env.INPUT_');
  });

  it('action-entry.ts 包含 Base64 解码逻辑', () => {
    const content = readFile(ENTRY_TS_PATH);
    expect(content).toContain('base64');
    expect(content).toContain('Buffer.from');
  });
});
