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
    // E11 移除：experiment-runner.ts 已重写为简化活代码（不再是死代码）
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

// Phase 50 Task 8 - Bug 2: ParsedSkillWithDrift 类型已应用
// E11 整体删除：skill-metadata-extension.ts、model-drift-detector.ts 已删除
//       （ParsedSkillWithDrift 接口、ModelDriftDetector 类均已不存在，断言无意义）


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
      // E11 移除：model-drift-detector.ts 已删除
      // E11 移除：skill-metadata-extension.ts 已删除
      import('../../src/router/deterministic-rules.js'),
      import('../../src/agent/preference-manager.js'),
    ];
    const mods = await Promise.all(imports);

    // 验证关键导出存在（非空断言：索引对应上方 imports 顺序）
    // E11 更新：imports 数组移除 model-drift-detector / skill-metadata-extension 后索引重排
    //   mods[0] = ClaudePluginImporter
    //   mods[1] = deterministic-rules
    //   mods[2] = preference-manager
    expect(mods[0]!.ClaudePluginImporter).toBeDefined();
    expect(mods[1]!.matchDeterministicRule).toBeDefined();
    expect(mods[2]!.PreferenceManager).toBeDefined();
  });

  // E11 整体删除：app-init.ts 已不再使用 listRecoverable / listRecoverableAsync
  // （durable-executor 抽象已被 GoalPersistence.listResumable 替代）

});
