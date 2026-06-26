// tests/integration/phase50-cleanup.test.ts
// Phase 50 Task 8 集成测试：HIGH 级别死代码清理验证
//
// 验证内容（对应任务清单 5 个维度）：
//   1. 已删除的源文件 / barrel 文件 / 测试文件不再存在
//   2. claude-plugin-importer.ts 的 convertFromClaudeConfig bug 已修复
//   3. ModelDriftDetector 使用 ParsedSkillWithDrift 类型（Bug 2 已修复）
//   4. deterministic-rules.ts / preference-manager.ts 已清理无用函数
//   5. 受影响的模块可被正常导入（typecheck 运行时代理验证）
//
// 注：完整 typecheck 由 `npm run typecheck`（tsc --noEmit）覆盖，
//   本文件以动态 import 验证模块加载无异常作为运行时代理。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

// ============================================================
// 辅助：断言文件不存在
// ============================================================

/**
 * 断言指定相对路径的文件不存在
 * 使用 fsSync.existsSync（同步、轻量），存在则抛出断言失败
 */
function expectFileNotToExist(relativePath: string): void {
  const absPath = path.join(projectRoot, relativePath);
  if (fsSync.existsSync(absPath)) {
    throw new Error(`文件不应存在但已存在: ${relativePath}`);
  }
}

/** 读取项目内相对路径文件的文本内容 */
async function readSource(relativePath: string): Promise<string> {
  const absPath = path.join(projectRoot, relativePath);
  return fs.readFile(absPath, 'utf-8');
}

// ============================================================
// 1. 已删除的源文件 / barrel 文件 / 测试文件不再存在
// ============================================================

describe('Phase 50 Task 8 - 已删除文件不再存在', () => {
  // 11 个完全死掉的整文件（任务清单第 1 项）+ 部分其他源文件
  const deletedSourceFiles = [
    'src/agent/types.ts',
    'src/router/reasoning-mode.ts',
    'src/utils/stall-detector.ts',
    'src/utils/error-messages.ts',
    'src/config/codegraph-manager.ts',
    'src/harness/tracing-executor.ts',
    'src/harness/experiment-runner.ts',
    'src/hooks/market-manager.ts',
    'src/hooks/generator.ts',
    'src/plugins/sdk.ts',
    'src/cli/wizard.tsx',
  ];

  // 7 个无引用的 barrel 文件（任务清单第 2 项）
  const deletedBarrelFiles = [
    'src/cite/index.ts',
    'src/import/index.ts',
    'src/macros/index.ts',
    'src/mcp/index.ts',
    'src/skills/index.ts',
    'src/agent/patterns/index.ts',
    'src/evaluation/index.ts',
  ];

  // 8 个已删除的测试文件（任务清单第 5 项）
  const deletedTestFiles = [
    'tests/cli/wizard.test.ts',
    'tests/harness/tracing-executor.test.ts',
    'tests/harness/experiment-runner.test.ts',
    'tests/hooks/generator.test.ts',
    'tests/utils/stall-detector.test.ts',
    'tests/utils/error-messages.test.ts',
    'tests/plugins/sdk.test.ts',
    'tests/cli/notification-audit.test.ts',
  ];

  it('11 个完全死掉的整文件均已删除', () => {
    for (const relPath of deletedSourceFiles) {
      expectFileNotToExist(relPath);
    }
  });

  it('7 个无引用的 barrel 文件均已删除', () => {
    for (const relPath of deletedBarrelFiles) {
      expectFileNotToExist(relPath);
    }
  });

  it('8 个对应测试文件均已删除', () => {
    for (const relPath of deletedTestFiles) {
      expectFileNotToExist(relPath);
    }
  });
});

// ============================================================
// 2. Bug 1：claude-plugin-importer.ts 的 convertFromClaudeConfig 已修复
// ============================================================

describe('Phase 50 Task 8 - Bug 1: convertFromClaudeConfig 已修复', () => {
  it('源码使用 importFromClaudeConfig（类型定义 + 实际调用）', async () => {
    const source = await readSource('src/import/claude-plugin-importer.ts');

    // 类型定义中应包含 importFromClaudeConfig 签名
    expect(source).toMatch(/importFromClaudeConfig\?\s*:/);
    // 应包含对 bridge.importFromClaudeConfig 的实际调用
    expect(source).toMatch(/bridge\.importFromClaudeConfig\(/);
  });

  it('实际代码中不再调用 bridge.convertFromClaudeConfig', async () => {
    const source = await readSource('src/import/claude-plugin-importer.ts');

    // 过滤掉注释行（注释中允许保留 bug 历史说明）
    const codeLines = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*');
      });
    const codeOnly = codeLines.join('\n');

    // 实际代码中不应存在 bridge.convertFromClaudeConfig( 调用
    expect(codeOnly).not.toMatch(/bridge\.convertFromClaudeConfig\(/);
  });

  it('ClaudePluginImporter 类可被正常动态导入', async () => {
    const mod = await import('../../src/import/claude-plugin-importer.js');
    expect(mod.ClaudePluginImporter).toBeDefined();
    expect(typeof mod.ClaudePluginImporter).toBe('function');
  });
});

// ============================================================
// 3. Bug 2：ModelDriftDetector 使用 ParsedSkillWithDrift 类型
// ============================================================

describe('Phase 50 Task 8 - Bug 2: ParsedSkillWithDrift 类型已应用', () => {
  it('skill-metadata-extension.ts 导出 ParsedSkillWithDrift 接口', async () => {
    const source = await readSource('src/skills/skill-metadata-extension.ts');
    expect(source).toContain('export interface ParsedSkillWithDrift');
    expect(source).toContain('lastValidatedModel');
  });

  it('model-drift-detector.ts 导入 ParsedSkillWithDrift 并用作 detectDrift 入参', async () => {
    const source = await readSource('src/skills/model-drift-detector.ts');

    // 应从 skill-metadata-extension.js 导入 ParsedSkillWithDrift
    expect(source).toMatch(/import[^;]*ParsedSkillWithDrift[^;]*from[^;]*skill-metadata-extension\.js/);
    // detectDrift 入参应为 ParsedSkillWithDrift[]
    expect(source).toMatch(/detectDrift\([\s\S]*?ParsedSkillWithDrift\[\]/);
    // 不应包含 as SkillMetadataWithDrift 类型断言（Bug 2 的特征：去除 as 断言）
    expect(source).not.toMatch(/as\s+SkillMetadataWithDrift/);
  });

  it('detectDrift 能正确处理 ParsedSkillWithDrift 输入并返回漂移结果', async () => {
    const { ModelDriftDetector } = await import('../../src/skills/model-drift-detector.js');
    const detector = new ModelDriftDetector();

    // 构造 ParsedSkillWithDrift 输入：三个 Skill
    // - skill-a：同主版本漂移（4.0613 → 4.1106，severity=low）
    // - skill-b：版本匹配，不漂移
    // - skill-c：跨主版本漂移（3.5 → 4.0，severity=high）
    const skills = [
      {
        metadata: {
          name: 'skill-a',
          version: '1.0.0',
          description: 'test skill a',
          author: 'tester',
          tags: [],
          lastValidatedModel: '4.0613', // 同主版本 → low
        },
        content: '',
        format: 'skill-md' as const,
      },
      {
        metadata: {
          name: 'skill-b',
          version: '1.0.0',
          description: 'test skill b',
          author: 'tester',
          tags: [],
          lastValidatedModel: '4.1106', // 与 currentModelVersion 一致 → 不漂移
        },
        content: '',
        format: 'skill-md' as const,
      },
      {
        metadata: {
          name: 'skill-c',
          version: '1.0.0',
          description: 'test skill c',
          author: 'tester',
          tags: [],
          lastValidatedModel: '3.5', // 跨主版本 → high
        },
        content: '',
        format: 'skill-md' as const,
      },
    ];

    const drifts = detector.detectDrift(skills, '4.1106');

    // skill-b 版本匹配，不漂移；skill-a 和 skill-c 漂移
    expect(drifts).toHaveLength(2);
    expect(drifts[0]!.skillName).toBe('skill-a');
    expect(drifts[0]!.lastValidatedModel).toBe('4.0613');
    expect(drifts[0]!.currentModelVersion).toBe('4.1106');
    // 同主版本（4）→ low 严重度
    expect(drifts[0]!.severity).toBe('low');
    // skill-c 跨主版本（3 → 4）→ high 严重度
    expect(drifts[1]!.skillName).toBe('skill-c');
    expect(drifts[1]!.severity).toBe('high');
  });
});

// ============================================================
// 4. 已删除的函数不再被导出
// ============================================================

describe('Phase 50 Task 8 - deterministic-rules.ts 已清理无用函数', () => {
  it('源码不再包含 loadCustomRules / mergeRules / isValidRule 的定义', async () => {
    const source = await readSource('src/router/deterministic-rules.ts');

    // 不应包含这三个函数的定义（含 export 和非 export）
    expect(source).not.toMatch(/function\s+loadCustomRules/);
    expect(source).not.toMatch(/function\s+mergeRules/);
    expect(source).not.toMatch(/function\s+isValidRule/);
  });

  it('文件头注释不再提及"支持用户自定义规则"', async () => {
    const source = await readSource('src/router/deterministic-rules.ts');
    const header = source.split('\n').slice(0, 10).join('\n');
    expect(header).not.toContain('支持用户自定义规则');
  });

  it('仍保留 matchDeterministicRule 和 BUILTIN_DETERMINISTIC_RULES 导出', async () => {
    const mod = await import('../../src/router/deterministic-rules.js');
    expect(typeof mod.matchDeterministicRule).toBe('function');
    expect(Array.isArray(mod.BUILTIN_DETERMINISTIC_RULES)).toBe(true);
    expect(mod.BUILTIN_DETERMINISTIC_RULES.length).toBeGreaterThan(0);
  });
});

describe('Phase 50 Task 8 - preference-manager.ts 已清理 exportAll', () => {
  it('PreferenceManager 原型上不存在 exportAll 方法', async () => {
    const { PreferenceManager } = await import('../../src/agent/preference-manager.js');
    expect(PreferenceManager.prototype.exportAll).toBeUndefined();
  });

  it('源码不再包含 exportAll 方法定义', async () => {
    const source = await readSource('src/agent/preference-manager.ts');
    expect(source).not.toMatch(/exportAll\s*\(/);
  });

  it('仍保留核心方法（get / getAll / setExplicit / save / load）', async () => {
    const { PreferenceManager } = await import('../../src/agent/preference-manager.js');
    expect(typeof PreferenceManager.prototype.get).toBe('function');
    expect(typeof PreferenceManager.prototype.getAll).toBe('function');
    expect(typeof PreferenceManager.prototype.setExplicit).toBe('function');
    expect(typeof PreferenceManager.prototype.save).toBe('function');
    expect(typeof PreferenceManager.prototype.load).toBe('function');
  });
});

// ============================================================
// 5. 受影响模块可被正常导入（typecheck 运行时代理验证）
// ============================================================

describe('Phase 50 Task 8 - 受影响模块可被正常动态导入', () => {
  it('所有被修改/保留的模块均能无异常加载', async () => {
    // 批量动态导入本次清理涉及的所有模块
    // 若类型或导出存在根本性问题，import 将抛出错误
    const imports = [
      import('../../src/import/claude-plugin-importer.js'),
      import('../../src/skills/model-drift-detector.js'),
      import('../../src/skills/skill-metadata-extension.js'),
      import('../../src/router/deterministic-rules.js'),
      import('../../src/agent/preference-manager.js'),
    ];
    const mods = await Promise.all(imports);

    // 验证关键导出存在（非空断言：索引对应上方 imports 顺序）
    expect(mods[0]!.ClaudePluginImporter).toBeDefined();
    expect(mods[1]!.ModelDriftDetector).toBeDefined();
    expect(mods[3]!.matchDeterministicRule).toBeDefined();
    expect(mods[4]!.PreferenceManager).toBeDefined();
  });

  it('app-init.ts 已改用 listRecoverableAsync（同步版已移除）', async () => {
    const source = await readSource('src/cli/app-init.ts');
    // 应包含异步版调用
    expect(source).toContain('listRecoverableAsync');
    // 不应在非注释行中出现同步版 .listRecoverable() 调用
    // （注释中允许提及历史，如 "同步版 listRecoverable() 已移除"）
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    // listRecoverable 后不紧跟 Async 的调用模式不应出现在实际代码中
    expect(codeOnly).not.toMatch(/listRecoverable(?!Async)\s*\(/);
  });
});
