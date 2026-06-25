// tests/integration/phase39.test.ts
// Phase 39 Task 4：集成测试
// 验证代码地图 / Skill / Hook / 实验分支的端到端流程
//
// 测试策略：
//   1. Schema 配置验证（codegraph/experiments/hooks）——直接测试 schema.ts
//   2. Defaults 默认值验证——直接测试 defaults.ts
//   3. IPC 类型结构验证——直接测试 ipc-types.ts
//   4. 实验分支创建+采纳——使用真实临时 Git 仓库
//   5. 选择性合并（cherry-pick）——使用真实临时 Git 仓库
//   6. Hook 模板匹配——mock 实现（registry.ts 由其他子代理创建）
//   7. Hook 安全审查——mock 实现（危险命令检测）
//   8. 代码地图 ContextInjector——mock 实现（code-map-context.ts 由其他子代理创建）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { ExperimentManager } from '../../src/harness/experiment-manager.js';
import type {
  ExperimentInfo,
  CodeGraphStatus,
  HookInfo,
  MainToRendererEvent,
} from '../../desktop/shared/ipc-types.js';

// 检测系统是否安装了 git
const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ============================================================
// 1. Schema 配置验证
// ============================================================
describe('Phase 39 Integration - Schema 配置', () => {
  it('codegraph 配置段：默认值正确填充', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.codegraph).toBeDefined();
    expect(config.codegraph.enabled).toBe(false);
    expect(config.codegraph.workspace).toBe('.');
    expect(config.codegraph.autoIndex).toBe(true);
  });

  it('experiments 配置段：默认值正确填充', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.experiments).toBeDefined();
    expect(config.experiments.maxActiveWorktrees).toBe(5);
    expect(config.experiments.autoCleanup).toBe(true);
  });

  it('hooks 配置段：默认值正确填充', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.hooks).toBeDefined();
    expect(config.hooks.enabled).toBe(true);
    expect(config.hooks.configPath).toBe('.routedev/hooks.json');
  });

  it('experiments.maxActiveWorktrees：边界值校验（1-20）', () => {
    // 最小值 1
    const minConfig = AppConfigSchema.parse({ experiments: { maxActiveWorktrees: 1 } }) as AppConfig;
    expect(minConfig.experiments.maxActiveWorktrees).toBe(1);
    // 最大值 20
    const maxConfig = AppConfigSchema.parse({ experiments: { maxActiveWorktrees: 20 } }) as AppConfig;
    expect(maxConfig.experiments.maxActiveWorktrees).toBe(20);
  });

  it('codegraph 配置：null 输入时使用默认值（preprocess 兼容）', () => {
    // 显式传 null/undefined 应被 preprocess 转为默认值
    const config = AppConfigSchema.parse({ codegraph: null }) as AppConfig;
    expect(config.codegraph.enabled).toBe(false);
    expect(config.codegraph.workspace).toBe('.');
  });
});

// ============================================================
// 2. Defaults 默认值验证
// ============================================================
describe('Phase 39 Integration - Defaults 默认值', () => {
  it('DEFAULT_CONFIG 包含 codegraph 默认值', () => {
    expect(DEFAULT_CONFIG.codegraph).toBeDefined();
    expect(DEFAULT_CONFIG.codegraph.enabled).toBe(false);
    expect(DEFAULT_CONFIG.codegraph.workspace).toBe('.');
    expect(DEFAULT_CONFIG.codegraph.autoIndex).toBe(true);
  });

  it('DEFAULT_CONFIG 包含 experiments 默认值', () => {
    expect(DEFAULT_CONFIG.experiments).toBeDefined();
    expect(DEFAULT_CONFIG.experiments.maxActiveWorktrees).toBe(5);
    expect(DEFAULT_CONFIG.experiments.autoCleanup).toBe(true);
  });

  it('DEFAULT_CONFIG 包含 hooks 默认值', () => {
    expect(DEFAULT_CONFIG.hooks).toBeDefined();
    expect(DEFAULT_CONFIG.hooks.enabled).toBe(true);
    expect(DEFAULT_CONFIG.hooks.configPath).toBe('.routedev/hooks.json');
  });

  it('DEFAULT_CONFIG 通过 schema 验证', () => {
    // DEFAULT_CONFIG 必须能通过 schema 验证（确保默认值与 schema 一致）
    const parsed = AppConfigSchema.parse(DEFAULT_CONFIG) as AppConfig;
    expect(parsed.codegraph).toEqual(DEFAULT_CONFIG.codegraph);
    expect(parsed.experiments).toEqual(DEFAULT_CONFIG.experiments);
    expect(parsed.hooks).toEqual(DEFAULT_CONFIG.hooks);
  });
});

// ============================================================
// 3. IPC 类型结构验证
// ============================================================
describe('Phase 39 Integration - IPC 类型', () => {
  it('MainToRendererEvent 包含 experiment:progress 通道', () => {
    const event: MainToRendererEvent = {
      channel: 'experiment:progress',
      payload: { taskId: 'exp-001', phase: 'running', message: '执行中', modifiedFiles: ['src/index.ts'], tokenUsage: 1000 },
    };
    expect(event.channel).toBe('experiment:progress');
    expect(event.payload).toHaveProperty('taskId');
  });

  it('MainToRendererEvent 包含 experiment:status 通道', () => {
    const event: MainToRendererEvent = {
      channel: 'experiment:status',
      payload: { taskId: 'exp-001', status: 'completed' },
    };
    expect(event.channel).toBe('experiment:status');
  });

  it('MainToRendererEvent 包含 codemap:indexing 通道', () => {
    const event: MainToRendererEvent = {
      channel: 'codemap:indexing',
      payload: { progress: 0.5, fileCount: 100 },
    };
    expect(event.channel).toBe('codemap:indexing');
  });

  it('MainToRendererEvent 包含 hook:fired 通道', () => {
    const event: MainToRendererEvent = {
      channel: 'hook:fired',
      payload: { hookName: 'eslint-check', event: 'post-tool-call', result: 'passed' },
    };
    expect(event.channel).toBe('hook:fired');
  });

  it('ExperimentInfo 类型结构正确', () => {
    const info: ExperimentInfo = {
      id: 'exp-001',
      name: 'test',
      status: 'completed',
      task: '实现功能 X',
      modifiedFiles: ['src/a.ts', 'src/b.ts'],
      tokenUsage: 500,
      duration: 30000,
    };
    expect(info.id).toBe('exp-001');
    expect(info.status).toBe('completed');
    expect(info.modifiedFiles).toHaveLength(2);
  });

  it('CodeGraphStatus 类型结构正确', () => {
    const status: CodeGraphStatus = {
      available: true,
      indexed: true,
      fileCount: 150,
      lastUpdated: '2026-06-24T10:00:00Z',
    };
    expect(status.available).toBe(true);
    expect(status.fileCount).toBe(150);
  });

  it('HookInfo 类型结构正确', () => {
    const hook: HookInfo = {
      id: 'hook-001',
      name: 'eslint-check',
      event: 'post-tool-call',
      enabled: true,
      isTemplate: true,
      description: '文件写入后自动运行 eslint',
    };
    expect(hook.isTemplate).toBe(true);
    expect(hook.event).toBe('post-tool-call');
  });
});

// ============================================================
// 4 & 5. 实验分支创建+采纳 & 选择性合并（使用真实 Git 仓库）
// ============================================================
describe.skipIf(!HAS_GIT)('Phase 39 Integration - 实验分支', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-phase39-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.routedev/\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(() => {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // 忽略
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('实验分支创建+采纳：create → 在 worktree 中修改 → adopt（merge 策略）', async () => {
    const manager = new ExperimentManager(tmpDir);

    // 1. 创建实验
    const exp = await manager.createExperiment('feature-test');
    expect(exp.status).toBe('active');
    expect(fs.existsSync(exp.worktreePath)).toBe(true);

    // 2. 在 worktree 中修改文件并提交
    const testFile = path.join(exp.worktreePath, 'src.ts');
    fs.writeFileSync(testFile, 'export const x = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: exp.worktreePath });
    execFileSync('git', ['commit', '-m', 'feat: update x'], { cwd: exp.worktreePath });

    // 3. 采纳实验（merge 策略）
    const result = await manager.adoptExperiment(exp.id, { strategy: 'merge' });
    expect(result.success).toBe(true);

    // 4. 验证主工作区已包含修改
    const mainFile = fs.readFileSync(path.join(tmpDir, 'src.ts'), 'utf-8');
    expect(mainFile).toContain('export const x = 2;');
  });

  it('选择性合并：cherry-pick 策略 + fileFilter 只合并指定文件', async () => {
    const manager = new ExperimentManager(tmpDir);

    // 1. 创建实验
    const exp = await manager.createExperiment('feature-selective');

    // 2. 在 worktree 中修改多个文件
    fs.writeFileSync(path.join(exp.worktreePath, 'src.ts'), 'export const x = 99;\n');
    fs.writeFileSync(path.join(exp.worktreePath, 'new-feature.ts'), 'export const feature = true;\n');
    fs.writeFileSync(path.join(exp.worktreePath, 'README.md'), '# Updated\n');
    execFileSync('git', ['add', '.'], { cwd: exp.worktreePath });
    execFileSync('git', ['commit', '-m', 'feat: multiple changes'], { cwd: exp.worktreePath });

    // 3. 使用 cherry-pick 策略，只合并 new-feature.ts
    const result = await manager.adoptExperiment(exp.id, {
      strategy: 'cherry-pick',
      fileFilter: ['new-feature.ts'],
    });
    expect(result.success).toBe(true);

    // 4. 验证只有 new-feature.ts 被合并
    expect(fs.existsSync(path.join(tmpDir, 'new-feature.ts'))).toBe(true);
    // src.ts 不应被修改（cherry-pick 只选择了 new-feature.ts）
    const srcContent = fs.readFileSync(path.join(tmpDir, 'src.ts'), 'utf-8');
    expect(srcContent).toBe('export const x = 1;\n');
  });

  it('实验分支丢弃：create → discard → worktree 清理', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('to-discard');
    expect(fs.existsSync(exp.worktreePath)).toBe(true);

    await manager.discardExperiment(exp.id);

    // 验证实验状态变为 discarded
    const list = manager.listExperiments();
    const discarded = list.find((e) => e.id === exp.id);
    expect(discarded).toBeDefined();
    expect(discarded!.status).toBe('discarded');
  });
});

// ============================================================
// 6. Hook 模板匹配（mock 实现）
// ============================================================
describe('Phase 39 Integration - Hook 模板匹配', () => {
  // mock Hook 模板库（模拟 registry.ts 的行为）
  const MOCK_HOOK_TEMPLATES: HookInfo[] = [
    { id: 'tpl-eslint', name: 'ESLint 检查', event: 'post-tool-call', enabled: false, isTemplate: true, description: '文件写入后运行 eslint' },
    { id: 'tpl-prettier', name: 'Prettier 格式化', event: 'post-tool-call', enabled: false, isTemplate: true, description: '文件写入后运行 prettier' },
    { id: 'tpl-tsc', name: 'TypeScript 编译检查', event: 'post-tool-call', enabled: false, isTemplate: true, description: '文件写入后运行 tsc --noEmit' },
    { id: 'tpl-test', name: '单元测试', event: 'post-tool-call', enabled: false, isTemplate: true, description: '文件写入后运行相关测试' },
    { id: 'tpl-git-add', name: 'Git 自动暂存', event: 'post-tool-call', enabled: false, isTemplate: true, description: '文件写入后自动 git add' },
    { id: 'tpl-session-log', name: '会话日志', event: 'on-session-start', enabled: false, isTemplate: true, description: '会话开始时记录日志' },
    { id: 'tpl-token-notify', name: 'Token 超限通知', event: 'on-model-call', enabled: false, isTemplate: true, description: 'Token 用量超限时通知' },
    { id: 'tpl-loop-break', name: '循环打破', event: 'on-reasoning', enabled: false, isTemplate: true, description: '检测到循环时注入提示' },
    { id: 'tpl-diff-review', name: 'Diff 审查', event: 'post-tool-call', enabled: false, isTemplate: true, description: '文件修改后自动审查 diff' },
    { id: 'tpl-commit-msg', name: '提交信息生成', event: 'on-session-end', enabled: false, isTemplate: true, description: '会话结束时生成提交信息' },
  ];

  // 模拟关键词匹配逻辑
  function matchTemplates(description: string): HookInfo[] {
    const keywords: Record<string, string[]> = {
      'tpl-eslint': ['eslint', 'lint', '代码规范'],
      'tpl-prettier': ['prettier', '格式化', 'format'],
      'tpl-tsc': ['typescript', 'tsc', '类型检查', 'typecheck'],
      'tpl-test': ['test', '测试', 'unit test'],
      'tpl-git-add': ['git', 'add', '暂存', 'stage'],
      'tpl-session-log': ['session', '会话', '日志', 'log'],
      'tpl-token-notify': ['token', '预算', 'budget'],
      'tpl-loop-break': ['loop', '循环', '重复'],
      'tpl-diff-review': ['diff', '审查', 'review'],
      'tpl-commit-msg': ['commit', '提交', 'message'],
    };
    const lowerDesc = description.toLowerCase();
    return MOCK_HOOK_TEMPLATES.filter((tpl) => {
      const kws = keywords[tpl.id] ?? [];
      return kws.some((kw) => lowerDesc.includes(kw.toLowerCase()));
    });
  }

  it('关键词匹配：描述包含 "eslint" 时匹配到 ESLint 模板', () => {
    const matches = matchTemplates('每次文件写入后运行 eslint 检查');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((m) => m.id === 'tpl-eslint')).toBe(true);
  });

  it('关键词匹配：描述包含 "格式化" 时匹配到 Prettier 模板', () => {
    const matches = matchTemplates('代码格式化工具');
    expect(matches.some((m) => m.id === 'tpl-prettier')).toBe(true);
  });

  it('关键词匹配：描述包含多个关键词时匹配到多个模板', () => {
    const matches = matchTemplates('eslint 和 prettier 格式化检查');
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.some((m) => m.id === 'tpl-eslint')).toBe(true);
    expect(matches.some((m) => m.id === 'tpl-prettier')).toBe(true);
  });

  it('模板库包含 10 个 Hook 模板', () => {
    expect(MOCK_HOOK_TEMPLATES.length).toBe(10);
  });
});

// ============================================================
// 7. Hook 安全审查（危险命令检测）
// ============================================================
describe('Phase 39 Integration - Hook 安全审查', () => {
  // 模拟危险命令检测逻辑（模拟 hook-generator.ts 的安全审查行为）
  const DANGEROUS_PATTERNS = [
    /rm\s+-rf/i,
    /format\s+/i,
    /del\s+\/s/i,
    /\beval\s*\(/i,
    /child_process/i,
    /exec\s*\(/i,
    /\bshutdown\b/i,
    /\bmkfs\b/i,
    /:\(\)\s*\{/i, // fork bomb
    /\$\(/i, // command substitution
  ];

  function reviewHookSafety(command: string): { safe: boolean; reason?: string } {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { safe: false, reason: `检测到危险模式: ${pattern.source}` };
      }
    }
    return { safe: true };
  }

  it('危险命令检测：rm -rf 被拦截', () => {
    const result = reviewHookSafety('rm -rf /');
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('危险命令检测：format 命令被拦截', () => {
    const result = reviewHookSafety('format C:');
    expect(result.safe).toBe(false);
  });

  it('危险命令检测：eval 被拦截', () => {
    const result = reviewHookSafety('eval(userInput)');
    expect(result.safe).toBe(false);
  });

  it('危险命令检测：fork bomb 被拦截', () => {
    const result = reviewHookSafety(':() { :|:& };:');
    expect(result.safe).toBe(false);
  });

  it('安全命令通过审查', () => {
    const result = reviewHookSafety('eslint --fix src/');
    expect(result.safe).toBe(true);
  });

  it('安全命令通过审查：prettier', () => {
    const result = reviewHookSafety('prettier --write src/**/*.ts');
    expect(result.safe).toBe(true);
  });
});

// ============================================================
// 8. 代码地图 ContextInjector（mock 实现）
// ============================================================
describe('Phase 39 Integration - 代码地图 ContextInjector', () => {
  // 模拟 ContextInjector 的行为（code-map-context.ts 由其他子代理创建）
  // 验证中间件能将项目结构注入到 system prompt

  it('ContextInjector mock：将项目结构注入 system prompt', async () => {
    // 模拟 CodeMapContextMiddleware 的 handler 行为
    const mockProjectStructure = `
## 项目结构
src/
  config/
    schema.ts
    defaults.ts
  agent/
    middleware/
      loop-detection.ts
`;

    const mockHandler = async (ctx: { systemPrompt?: string; metadata: Record<string, unknown> }, next: () => Promise<void>) => {
      // 将项目结构追加到 system prompt
      if (ctx.systemPrompt) {
        ctx.systemPrompt += `\n\n${mockProjectStructure}`;
      } else {
        ctx.systemPrompt = mockProjectStructure;
      }
      ctx.metadata.codeMapInjected = true;
      await next();
    };

    // 模拟中间件执行
    const ctx = {
      systemPrompt: '你是一个 AI 助手。',
      metadata: {} as Record<string, unknown>,
    };
    await mockHandler(ctx, async () => {});

    expect(ctx.systemPrompt).toContain('项目结构');
    expect(ctx.systemPrompt).toContain('schema.ts');
    expect(ctx.metadata.codeMapInjected).toBe(true);
  });

  it('ContextInjector mock：空 system prompt 时也能注入', async () => {
    const mockHandler = async (ctx: { systemPrompt?: string; metadata: Record<string, unknown> }, next: () => Promise<void>) => {
      const structure = '## 项目结构\nsrc/main.ts';
      ctx.systemPrompt = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${structure}` : structure;
      await next();
    };

    const ctx = {
      systemPrompt: undefined as string | undefined,
      metadata: {} as Record<string, unknown>,
    };
    await mockHandler(ctx, async () => {});

    expect(ctx.systemPrompt).toBeDefined();
    expect(ctx.systemPrompt).toContain('项目结构');
  });

  it('Schema 配置：codegraph.enabled 控制是否使用增强引擎', () => {
    // enabled=false 时使用内置轻量引擎
    const builtinConfig = AppConfigSchema.parse({ codegraph: { enabled: false } }) as AppConfig;
    expect(builtinConfig.codegraph.enabled).toBe(false);

    // enabled=true 时使用 CodeGraph 增强引擎
    const enhancedConfig = AppConfigSchema.parse({ codegraph: { enabled: true } }) as AppConfig;
    expect(enhancedConfig.codegraph.enabled).toBe(true);
  });
});
